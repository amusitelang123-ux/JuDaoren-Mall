import type { ZodType, ZodTypeDef } from 'zod'

/**
 * AI 平台层的公共类型。
 *
 * 设计原则（对应 docs/AI深度集成-改进方向.md 第 3 节）：
 * - module   决定「限流 / 预算」桶：chat（用户端）、admin（后台）、other（离线任务）
 * - scenario 决定「提示词 / 工具 / 输出 schema / mock 话术」，是业务可插拔的最小单位
 * - 场景必须注册后再调用，未注册或未开启时统一降级，不抛未知错误
 */

/** 治理维度：同一个 module 共享限流与预算配额 */
export type AiModule = 'chat' | 'search' | 'admin' | 'other'

/** 业务场景：一个场景 = 一套提示词 + 一组工具 + 一个输出结构 */
export type AiScenario =
  | 'customer_service'
  | 'search_parse'
  | 'marketing_copy'
  | 'helpdesk_draft'
  | 'comment_insight'
  | 'cart_advice'
  | 'refund_advice'
  | 'copilot'

/** 场景与治理模块的归属关系；新增场景只改这张表 */
export const SCENARIO_MODULE: Record<AiScenario, AiModule> = {
  customer_service: 'chat',
  search_parse: 'search',
  marketing_copy: 'admin',
  helpdesk_draft: 'admin',
  comment_insight: 'other',
  cart_advice: 'chat',
  refund_advice: 'admin',
  copilot: 'admin',
}

export const MODULE_LABEL: Record<AiModule, string> = {
  chat: '用户端',
  search: '搜索',
  admin: '后台',
  other: '离线任务',
}

/**
 * 预算桶：审计按 4 个 module 记录，但额度只分 3 桶。
 * 搜索解析属于「用户端主链路之外」的开销，和离线任务共用 other 桶，
 * 否则 search 会成为没有上限的免费通道。
 */
export type AiBudgetBucket = 'chat' | 'admin' | 'other'

export const MODULE_BUCKET: Record<AiModule, AiBudgetBucket> = {
  chat: 'chat',
  admin: 'admin',
  search: 'other',
  other: 'other',
}

export const BUCKET_MODULES: Record<AiBudgetBucket, AiModule[]> = {
  chat: ['chat'],
  admin: ['admin'],
  other: ['search', 'other'],
}

export interface AiGuardSubject {
  module: AiModule
  scenario: AiScenario
  /** 限流主体：用户端为 userId，后台为 adminId；缺省时按匿名桶处理 */
  subjectId?: number | null
}

/** 工具/场景的鉴权上下文：AI 永远只拿到它被允许看到的那部分身份 */
export interface AiActorContext {
  role: 'user' | 'admin' | 'system'
  userId?: number
  adminId?: number
  /** 当前会话关联的订单号，可作为工具默认参数 */
  orderNo?: string
}

/** 结构化输出的统一结果：成功带 data，失败带降级原因 */
export interface StructuredResult<T> {
  ok: boolean
  data: T | null
  /** 兜底原因：timeout / invalid_json / schema_mismatch / disabled / budget / rate_limit / error */
  fallbackReason?: string
}

export interface AiTaskUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface AiRunResult<T = string> {
  /** 是否真正走通了模型链路（false 表示命中缓存之外的降级路径） */
  ok: boolean
  content: string
  data: T | null
  usage: AiTaskUsage
  model: string
  cacheHit: boolean
  fallbackReason?: string
  latencyMs: number
  toolTrace: { name: string; arguments: string; result: unknown }[]
}

export type SchemaLike<T> = ZodType<T, ZodTypeDef, unknown>
