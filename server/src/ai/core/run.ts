import { config } from '../../config'
import { ERR } from '../../constants'
import { AppError } from '../../utils/errors'
import { getAiAdapter, aiMode } from '../../adapters/ai'
import type { AiMessage, AiToolDefinition, AiUsage } from '../../adapters/ai'
import { executeTool } from '../tools/registry'
import { writeCallLog } from './audit'
import { cacheKey, readCache, writeCache } from './cache'
import { REPAIR_PROMPT, validateStructured } from './output'
import {
  assertBreaker,
  assertBudget,
  assertScenarioEnabled,
  checkRateLimit,
  recordFailure,
  recordSuccess,
  withTimeout,
} from './guard'
import type {
  AiActorContext,
  AiModule,
  AiRunResult,
  AiScenario,
  SchemaLike,
} from './types'

/**
 * AI 任务编排器：场景层唯一需要调用的入口。
 *
 * 一次 runAiTask = 场景开关 → 限流 → 预算 → 熔断 →（缓存）→ 模型（含工具轮次）
 * → 结构化校验（失败重试 1 次）→ 降级 → 审计。
 *
 * 场景层只关心「提示词 + 输入 + 期望的输出结构」，
 * 治理、重试、降级、审计一概不重复实现（改进方向 §3.1 的核心诉求）。
 */

const ZERO_USAGE: AiUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

export type TaskMode = 'single' | 'stream' | 'tools'

export interface RunAiTaskInput<T> {
  module: AiModule
  scenario: AiScenario
  /** 限流主体：用户端 userId / 后台 adminId */
  subjectId?: number | null
  conversationId?: number | null
  actor?: AiActorContext
  system?: string
  messages: AiMessage[]
  /** 'single' 单轮非流式（结构化输出默认）；'stream' 单轮流式；'tools' 非流式工具轮次 */
  mode?: TaskMode
  tools?: AiToolDefinition[]
  maxToolRounds?: number
  /** 期望的结构化输出；给了 schema 就会做校验 + 重试 + 降级 */
  schema?: SchemaLike<T>
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  signal?: AbortSignal
  onDelta?: (text: string) => void
  onThinking?: (text: string) => void
  onTool?: (name: string, label: string) => void
  /** 结果缓存：给出入参即可按 scenario+hash 缓存 */
  cache?: { keyParts: unknown[]; ttlMs?: number }
  /** 规则版兜底：模型不可用 / 校验失败 / 被治理拦截时调用 */
  fallback?: (reason: string) => T | null | Promise<T | null>
  /** true 时治理失败直接抛错（客服对话需要让用户看到「太频繁」「额度用完」） */
  throwOnBlock?: boolean
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: string })?.name === 'AbortError'
}

function fallbackReasonOf(error: unknown): string {
  if (isAbortError(error)) return 'client_abort'
  if (error instanceof AppError) {
    if (error.code === ERR.AI_UNAVAILABLE && error.httpStatus === 504) return 'timeout'
    if (error.code === ERR.RATE_LIMIT) return 'rate_limit'
    if (error.code === ERR.AI_BUDGET_EXCEEDED) return 'budget'
  }
  return 'error'
}

export async function runAiTask<T = string>(input: RunAiTaskInput<T>): Promise<AiRunResult<T>> {
  const startedAt = Date.now()
  const mode = input.mode ?? 'single'
  const billable = aiMode().mode === 'deepseek'
  const actor: AiActorContext = input.actor ?? { role: 'system' }
  const subjectId = input.subjectId ?? actor.userId ?? actor.adminId ?? null
  const trace: AiRunResult['toolTrace'] = []
  let usage: AiUsage = { ...ZERO_USAGE }
  let model = aiMode().model

  const empty = async (fallbackReason: string): Promise<AiRunResult<T>> => {
    let data: T | null = null
    if (input.fallback) {
      try {
        data = await input.fallback(fallbackReason)
      } catch (error) {
        console.error('[ai] 降级实现本身失败', error)
      }
    }
    return {
      ok: false,
      content: '',
      data,
      usage,
      model,
      cacheHit: false,
      fallbackReason,
      latencyMs: Date.now() - startedAt,
      toolTrace: trace,
    }
  }

  /* ---------------------------- 1. 治理 ---------------------------- */
  try {
    checkRateLimit({ module: input.module, scenario: input.scenario, subjectId })
    await assertScenarioEnabled({ module: input.module, scenario: input.scenario, subjectId })
    await assertBudget(input.module)
    assertBreaker(input.module)
  } catch (error) {
    if (input.throwOnBlock) throw error
    return empty(fallbackReasonOf(error))
  }

  /* ---------------------------- 2. 缓存 ---------------------------- */
  const key = input.cache ? cacheKey(input.scenario, input.cache.keyParts) : null
  if (key) {
    const hit = readCache<{ content: string; data: T | null }>(key)
    if (hit) {
      return {
        ok: true,
        content: hit.content,
        data: hit.data,
        usage,
        model,
        cacheHit: true,
        latencyMs: Date.now() - startedAt,
        toolTrace: trace,
      }
    }
  }

  /* ---------------------------- 3. 调用模型 ---------------------------- */
  const adapter = getAiAdapter()
  const messages: AiMessage[] = []
  if (input.system) messages.push({ role: 'system', content: input.system })
  messages.push(...input.messages)

  const callOnce = async (payload: {
    messages: AiMessage[]
    stream: boolean
    tools?: AiToolDefinition[]
  }) =>
    withTimeout(
      (signal) =>
        adapter.chat({
          messages: payload.messages,
          tools: payload.tools,
          scenario: input.scenario,
          stream: payload.stream,
          temperature: input.temperature,
          maxTokens: input.maxTokens,
          signal,
          onDelta: payload.stream ? input.onDelta : undefined,
        }),
      input.timeoutMs ?? config.ai.timeoutMs,
      input.signal,
    )

  let content = ''

  try {
    if (mode === 'tools') {
      const rounds = Math.max(1, input.maxToolRounds ?? 3)
      let done = false
      for (let round = 0; round < rounds && !done; round += 1) {
        const result = await callOnce({ messages, stream: false, tools: input.tools })
        usage = addUsage(usage, result.usage)
        model = result.model

        if (!result.toolCalls.length) {
          content = result.content
          done = true
          break
        }

        messages.push({ role: 'assistant', content: result.content, toolCalls: result.toolCalls })
        for (const call of result.toolCalls) {
          const outcome = await executeTool(call.name, call.arguments, actor)
          trace.push({ name: call.name, arguments: call.arguments, result: outcome.result })
          input.onTool?.(call.name, outcome.label)
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify(outcome.result),
          })
        }
      }
      if (!done && !content) {
        content = '这个问题需要人工核实一下，建议点「转人工」由客服跟进。'
      }
    } else if (mode === 'stream') {
      input.onThinking?.('正在整理回答…')
      const result = await callOnce({ messages, stream: true, tools: input.tools })
      usage = addUsage(usage, result.usage)
      model = result.model
      content = result.content

      // 流式轮次里模型要求调用工具（少见）：执行后用结果再流式生成一次
      if (!result.content && result.toolCalls.length) {
        messages.push({ role: 'assistant', content: '', toolCalls: result.toolCalls })
        for (const call of result.toolCalls) {
          const outcome = await executeTool(call.name, call.arguments, actor)
          trace.push({ name: call.name, arguments: call.arguments, result: outcome.result })
          input.onTool?.(call.name, outcome.label)
          messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(outcome.result) })
        }
        const followUp = await callOnce({ messages, stream: true })
        usage = addUsage(usage, followUp.usage)
        model = followUp.model
        content = followUp.content
      }
    } else {
      const result = await callOnce({ messages, stream: false, tools: input.tools })
      usage = addUsage(usage, result.usage)
      model = result.model
      content = result.content
    }
  } catch (error) {
    const reason = fallbackReasonOf(error)
    recordFailure(input.module)
    await writeCallLog({
      module: input.module,
      scenario: input.scenario,
      userId: actor.userId ?? null,
      conversationId: input.conversationId ?? null,
      model,
      usage,
      latencyMs: Date.now() - startedAt,
      status: 0,
      error: error instanceof Error ? error.message : 'unknown',
      fallbackReason: reason,
      billable: false,
    })
    if (input.throwOnBlock) throw error
    return empty(reason)
  }

  recordSuccess(input.module)

  /* ------------------------ 4. 结构化输出收口 ------------------------ */
  let data: T | null = null
  let validationReason: string | null = null

  if (input.schema) {
    let outcome = validateStructured(input.schema, content)
    if (!outcome.ok) {
      // 只在「格式问题」时重试；超时/网络错误不重试，避免放大延迟
      try {
        const repair = await callOnce({
          messages: [
            ...messages,
            { role: 'assistant', content: content || '（空）' },
            {
              role: 'user',
              content: `${REPAIR_PROMPT}\n${outcome.detail ? `上一次的错误：${outcome.detail}` : ''}`,
            },
          ],
          stream: false,
        })
        usage = addUsage(usage, repair.usage)
        model = repair.model
        content = repair.content
        outcome = validateStructured(input.schema, content)
      } catch (error) {
        console.error('[ai] 结构化重试失败', error)
      }
    }
    if (outcome.ok) data = outcome.data
    else validationReason = outcome.reason ?? 'schema_mismatch'
  }

  const fallbackReason = validationReason ?? undefined

  await writeCallLog({
    module: input.module,
    scenario: input.scenario,
    userId: actor.userId ?? null,
    conversationId: input.conversationId ?? null,
    model,
    usage,
    latencyMs: Date.now() - startedAt,
    status: fallbackReason ? 0 : 1,
    error: fallbackReason ? `结构化输出降级：${fallbackReason}` : null,
    fallbackReason,
    billable,
  })

  if (fallbackReason) {
    let fallbackData: T | null = null
    if (input.fallback) {
      try {
        fallbackData = await input.fallback(fallbackReason)
      } catch (error) {
        console.error('[ai] 降级实现本身失败', error)
      }
    }
    return {
      ok: false,
      content,
      data: fallbackData,
      usage,
      model,
      cacheHit: false,
      fallbackReason,
      latencyMs: Date.now() - startedAt,
      toolTrace: trace,
    }
  }

  if (key) writeCache(key, { content, data }, input.cache?.ttlMs)

  return {
    ok: true,
    content,
    data,
    usage,
    model,
    cacheHit: false,
    latencyMs: Date.now() - startedAt,
    toolTrace: trace,
  }
}

function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  }
}
