import type { ZodTypeAny } from 'zod'
import type { SchemaLike } from './types'

/**
 * 结构化输出统一收口（改进方向 §3.3 第 4 条）：
 * `safeParse` 校验 → 失败重试 1 次 → 仍失败则交给调用方降级到规则实现，
 * 绝不把裸文本写库。
 *
 * 模型经常在 JSON 外包一层 ```json 围栏或前后加解释，这里先做宽容剥离，
 * 再做严格 schema 校验——宽容只作用于「取出 JSON」，不作用于字段。
 */

/** 从模型输出里取出第一段 JSON 对象文本 */
export function extractJson(raw: string): string | null {
  const text = (raw ?? '').trim()
  if (!text) return null

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced ? fenced[1] : text).trim()

  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return candidate.slice(start, end + 1)
}

export interface ValidationOutcome<T> {
  ok: boolean
  data: T | null
  reason?: string
  /** 校验失败时的字段错误摘要，可用于让模型自我修正 */
  detail?: string
}

export function validateStructured<T>(schema: SchemaLike<T>, raw: string): ValidationOutcome<T> {
  const json = extractJson(raw)
  if (!json) return { ok: false, data: null, reason: 'invalid_json' }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, data: null, reason: 'invalid_json' }
  }

  const result = schema.safeParse(parsed)
  if (!result.success) {
    return {
      ok: false,
      data: null,
      reason: 'schema_mismatch',
      detail: result.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    }
  }
  return { ok: true, data: result.data }
}

/** 让模型自我修正时的追加指令（只用于重试那一轮） */
export const REPAIR_PROMPT =
  '你上一次的输出不是合法的 JSON，或者字段不符合要求。请只输出一个 JSON 对象，不要包含解释、Markdown 围栏或多余文字。'

/** 后台/调试用：把 zod schema 转成可读字段说明，便于评估与排查 */
export function describeSchema(schema: ZodTypeAny): string {
  const shape = (schema as unknown as { shape?: Record<string, ZodTypeAny> }).shape
  if (!shape) return schema.constructor?.name ?? 'schema'
  return Object.entries(shape)
    .map(([key, value]) => `${key}: ${value.constructor?.name ?? 'unknown'}`)
    .join(', ')
}
