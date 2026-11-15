import type { ZodTypeAny, z } from 'zod'
import type { AiToolDefinition } from '../../adapters/ai'
import type { AiActorContext } from '../core/types'

/**
 * 工具注册表（改进方向 §3.2 步骤 2 / §3.3 第 1 条）。
 *
 * 与旧实现的区别：
 * - 入参从「JSON.parse 一下就过」变成 zod 校验：模型幻觉出 `{}` 不再是静默成功；
 * - 鉴权从「函数内写死 userId」抽成注册项统一的 `authz(ctx)`，
 *   `availableTools(ctx)` 只把当前身份允许的工具交给模型，`executeTool` 再校验一次；
 * - 工具带 `module`/只读标记，便于后续做「动作提案类」工具时统一管控。
 */

export interface AiToolSpec<S extends ZodTypeAny = ZodTypeAny> {
  name: string
  description: string
  /** 给模型看的 JSON Schema；与 schema 必须一致 */
  parameters: Record<string, unknown>
  /** 服务端校验用的 zod schema，是唯一事实来源 */
  schema: S
  /** 权限不满足时抛错；抛错即视为「当前身份不可见」 */
  authz: (ctx: AiActorContext) => void
  /** 展示给用户的工具调用文案，如「已查询订单 XXX 的物流」 */
  label: (args: z.output<S>, ctx: AiActorContext) => string
  execute: (args: z.output<S>, ctx: AiActorContext) => Promise<unknown>
  /** L3 动作类工具：返回前端渲染确认卡片时使用的动作类型 */
  actionType?: string
}

const registry = new Map<string, AiToolSpec>()

export function registerTool<S extends ZodTypeAny>(spec: AiToolSpec<S>): void {
  registry.set(spec.name, spec as unknown as AiToolSpec)
}

export function clearTools(): void {
  registry.clear()
}

export function getTool(name: string): AiToolSpec | undefined {
  return registry.get(name)
}

export function listToolSpecs(): AiToolSpec[] {
  return [...registry.values()]
}

function allowed(spec: AiToolSpec, ctx: AiActorContext): boolean {
  try {
    spec.authz(ctx)
    return true
  } catch {
    return false
  }
}

/** 只把当前身份允许的工具交给模型 */
export function availableTools(ctx: AiActorContext): AiToolDefinition[] {
  return listToolSpecs()
    .filter((spec) => allowed(spec, ctx))
    .map((spec) => ({
      type: 'function' as const,
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
      },
    }))
}

export interface ToolOutcome {
  ok: boolean
  name: string
  label: string
  result: unknown
}

function parseArguments(raw: string): unknown {
  if (!raw || !raw.trim()) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

/**
 * 执行一次工具调用。任何失败都转成结构化结果回灌给模型（而不是抛给用户），
 * 让模型有机会纠正参数或换一种说法。
 */
export async function executeTool(
  name: string,
  rawArguments: string,
  ctx: AiActorContext,
): Promise<ToolOutcome> {
  const spec = registry.get(name)
  if (!spec) {
    return {
      ok: false,
      name,
      label: `未知工具 ${name}`,
      result: { error: `没有名为 ${name} 的工具，请不要调用它` },
    }
  }

  try {
    spec.authz(ctx)
  } catch {
    return {
      ok: false,
      name,
      label: '没有权限',
      result: { error: '当前用户没有权限访问该数据' },
    }
  }

  const parsedArgs = parseArguments(rawArguments)
  if (parsedArgs === undefined) {
    return { ok: false, name, label: '参数格式错误', result: { error: '参数不是合法的 JSON 对象' } }
  }

  const parsed = spec.schema.safeParse(parsedArgs)
  if (!parsed.success) {
    return {
      ok: false,
      name,
      label: '参数不合法',
      result: {
        error: '参数不合法，请按工具定义的字段重新调用',
        detail: parsed.error.issues
          .slice(0, 4)
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
      },
    }
  }

  try {
    const result = await spec.execute(parsed.data, ctx)
    return { ok: true, name, label: spec.label(parsed.data, ctx), result }
  } catch (error) {
    const message = error instanceof Error ? error.message : '工具执行失败'
    return { ok: false, name, label: '工具执行失败', result: { error: message } }
  }
}
