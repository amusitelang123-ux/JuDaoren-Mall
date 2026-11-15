import { config } from '../../config'
import { ERR } from '../../constants'
import { AppError } from '../../utils/errors'
import { aiMode } from '../../adapters/ai'
import { loadSettingMap } from '../../services/settingsService'
import { spentToday } from './audit'
import { SCENARIO_MODULE, MODULE_BUCKET, BUCKET_MODULES } from './types'
import type {
  AiBudgetBucket,
  AiGuardSubject,
  AiModule,
  AiScenario,
} from './types'

/**
 * 治理层：限流 / 预算 / 熔断 / 场景开关。
 *
 * 与旧实现的区别：
 * - 限流与预算从「全局一份」拆成「按 module 一份」，后台场景上线后不会抢用户端额度；
 * - 场景开关支持三级：.env（部署级）→ settings 表（运行期热更）→ 指定用户灰度；
 * - 增加熔断：上游连续失败时短路一段时间，避免每次请求都白等 25s 超时。
 */

const MINUTE = 60_000

/* ------------------------------- 限流 ---------------------------------- */

interface RateBucket {
  hits: number[]
}

const rateBuckets = new Map<string, RateBucket>()

function rateLimitOf(module: AiModule): number {
  if (module === 'chat') return config.ai.rateLimit.chat
  if (module === 'admin') return config.ai.rateLimit.admin
  return config.ai.rateLimit.other
}

/** 进程内滑动窗口限流；单实例部署足够，集群部署时应换成 Redis 计数 */
export function checkRateLimit(subject: AiGuardSubject): void {
  const limit = rateLimitOf(subject.module)
  if (limit <= 0) return

  const key = `${subject.module}:${subject.subjectId ?? 'anon'}`
  const now = Date.now()
  const bucket = rateBuckets.get(key) ?? { hits: [] }
  bucket.hits = bucket.hits.filter((at) => now - at < MINUTE)
  if (bucket.hits.length >= limit) {
    throw new AppError('提问太频繁了，请稍后再试', ERR.RATE_LIMIT, 429)
  }
  bucket.hits.push(now)
  rateBuckets.set(key, bucket)
  if (rateBuckets.size > 5000) rateBuckets.clear()
}

/** 仅供测试与后台观察：清空限流状态 */
export function resetRateLimit(): void {
  rateBuckets.clear()
}

/* ------------------------------- 预算 ---------------------------------- */

function budgetLimitOf(bucket: AiBudgetBucket): number {
  if (bucket === 'chat') return config.ai.budget.chat
  if (bucket === 'admin') return config.ai.budget.admin
  return config.ai.budget.other
}

const budgetCache = new Map<AiBudgetBucket, { spent: number; at: number }>()
const BUDGET_CACHE_TTL = 10_000

export async function budgetState(
  bucket: AiBudgetBucket,
): Promise<{ module: AiBudgetBucket; limit: number; spent: number; remaining: number }> {
  const cached = budgetCache.get(bucket)
  let spent: number
  if (cached && Date.now() - cached.at < BUDGET_CACHE_TTL) {
    spent = cached.spent
  } else {
    spent = await spentToday(BUCKET_MODULES[bucket])
    budgetCache.set(bucket, { spent, at: Date.now() })
  }
  const limit = budgetLimitOf(bucket)
  return { module: bucket, limit, spent, remaining: Math.max(0, limit - spent) }
}

export async function invalidateBudgetCache(): Promise<void> {
  budgetCache.clear()
}

/** 演示模式不产生费用，直接放行 */
export async function assertBudget(module: AiModule): Promise<void> {
  if (aiMode().mode !== 'deepseek') return
  const bucket = MODULE_BUCKET[module]
  const state = await budgetState(bucket)
  if (state.spent >= state.limit) {
    throw new AppError(
      bucket === 'chat'
        ? '今日 AI 客服额度已用完，请点「转人工」由客服跟进'
        : '今日 AI 额度已用完，该能力临时不可用',
      ERR.AI_BUDGET_EXCEEDED,
      429,
    )
  }
}

/* ------------------------------- 熔断 ---------------------------------- */

interface BreakerState {
  failures: number
  openedAt: number | null
}

const breakers = new Map<AiModule, BreakerState>()

export function assertBreaker(module: AiModule): void {
  const state = breakers.get(module)
  if (!state?.openedAt) return
  if (Date.now() - state.openedAt >= config.ai.breaker.cooldownMs) {
    // 冷却结束，半开：放一个请求过去试探
    state.openedAt = null
    state.failures = 0
    return
  }
  throw new AppError('AI 服务连续失败，已临时熔断，请稍后重试或转人工', ERR.AI_UNAVAILABLE, 503)
}

export function recordFailure(module: AiModule): void {
  const state = breakers.get(module) ?? { failures: 0, openedAt: null }
  state.failures += 1
  if (state.failures >= config.ai.breaker.threshold) state.openedAt = Date.now()
  breakers.set(module, state)
}

export function recordSuccess(module: AiModule): void {
  const state = breakers.get(module)
  if (!state) return
  state.failures = 0
  state.openedAt = null
}

export function breakerState(): Record<string, { failures: number; open: boolean }> {
  const out: Record<string, { failures: number; open: boolean }> = {}
  breakers.forEach((value, key) => {
    out[key] = { failures: value.failures, open: Boolean(value.openedAt) }
  })
  return out
}

/* ----------------------------- 场景开关 -------------------------------- */

const SETTING_PREFIX = 'ai.scenario.'

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false
  return !['0', 'false', 'off', 'no', ''].includes(value.trim().toLowerCase())
}

export interface ScenarioState {
  scenario: AiScenario
  module: AiModule
  /** 部署级（.env AI_SCENARIOS） */
  envEnabled: boolean
  /** 运行期覆盖（settings 表）；null 表示未覆盖 */
  settingEnabled: boolean | null
  /** 灰度白名单；为空表示不限制 */
  grayUserIds: number[]
  enabled: boolean
}

export async function scenarioState(scenario: AiScenario): Promise<ScenarioState> {
  const module = SCENARIO_MODULE[scenario]
  const envEnabled = config.ai.scenarios.includes(scenario)

  let settingRaw: string | undefined
  let grayRaw: string | undefined
  try {
    const map = await loadSettingMap()
    settingRaw = map[`${SETTING_PREFIX}${scenario}.enabled`]
    grayRaw = map[`${SETTING_PREFIX}${scenario}.grayUserIds`]
  } catch {
    // settings 表未就绪（迁移前 / 单测）时按未覆盖处理
  }

  const settingEnabled = settingRaw === undefined ? null : isTruthy(settingRaw)
  const grayUserIds = (grayRaw ?? '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((id) => Number.isInteger(id) && id > 0)

  const enabled = settingEnabled ?? envEnabled
  return { scenario, module, envEnabled, settingEnabled, grayUserIds, enabled }
}

/**
 * 场景总开关 + 灰度判断。
 * 灰度白名单命中时即使总开关关闭也放行——灰度本来就是「只给一部分人看」。
 */
export async function assertScenarioEnabled(subject: AiGuardSubject): Promise<ScenarioState> {
  const state = await scenarioState(subject.scenario)
  if (state.grayUserIds.length && subject.subjectId) {
    if (state.grayUserIds.includes(subject.subjectId)) return state
    if (!state.enabled) {
      throw new AppError('该 AI 能力暂未开放', ERR.AI_UNAVAILABLE, 503)
    }
    throw new AppError('该 AI 能力暂未对当前账号开放', ERR.AI_UNAVAILABLE, 503)
  }
  if (!state.enabled) {
    throw new AppError('该 AI 能力暂未开放', ERR.AI_UNAVAILABLE, 503)
  }
  return state
}

/** 场景是否启用（不抛错，供前端探测与离线任务判断） */
export async function isScenarioEnabled(scenario: AiScenario, subjectId?: number): Promise<boolean> {
  try {
    await assertScenarioEnabled({ module: SCENARIO_MODULE[scenario], scenario, subjectId })
    return true
  } catch {
    return false
  }
}

/* -------------------------------- 超时 --------------------------------- */

/** 给一次模型调用加硬超时；超时抛 fallbackReason=timeout 的错误 */
export async function withTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('ai timeout')), timeoutMs)

  const onAbort = () => controller.abort(outerSignal?.reason)
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort(outerSignal.reason)
    else outerSignal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    return await Promise.race([
      task(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => {
            // 区分「业务硬超时」与「客户端主动断开」：后者不该报超时错误
            if (outerSignal?.aborted) {
              const aborted = new Error('aborted')
              aborted.name = 'AbortError'
              reject(aborted)
              return
            }
            reject(new AppError('AI 响应超时', ERR.AI_UNAVAILABLE, 504))
          },
          { once: true },
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
    outerSignal?.removeEventListener('abort', onAbort)
  }
}
