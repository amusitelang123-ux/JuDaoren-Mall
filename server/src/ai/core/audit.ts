import { Op } from 'sequelize'
import { config } from '../../config'
import { AiCallLog } from '../../models'
import type { AiModule, AiScenario, AiTaskUsage } from './types'

/**
 * 调用审计的统一入口。
 *
 * 现状问题（改进方向 §1.2 证据 2）：审计只有 2 处 `AiCallLog.create`，`module` 恒为 'chat'，
 * 无法按场景看成本。这里把写入收敛成一个函数，并补上 `scenario / cache_hit / fallback_reason`
 * 三个可观测维度——「兜底率」这个关键指标才有数据来源。
 */

export interface CallLogInput {
  module: AiModule
  scenario: AiScenario
  userId?: number | null
  conversationId?: number | null
  model: string
  usage: AiTaskUsage
  latencyMs: number
  status: 1 | 0
  error?: string | null
  cacheHit?: boolean
  fallbackReason?: string | null
  /** 是否产生真实费用；演示（mock）模式传 false */
  billable?: boolean
}

/** 按配置单价估算成本（元）；演示模式不产生真实费用 */
export function estimateCost(usage: AiTaskUsage): string {
  const cost =
    (usage.promptTokens / 1_000_000) * config.ai.priceInPerM +
    (usage.completionTokens / 1_000_000) * config.ai.priceOutPerM
  return cost.toFixed(4)
}

export function costOf(usage: AiTaskUsage, realCall: boolean): string {
  return realCall ? estimateCost(usage) : '0.0000'
}

/** 写审计。任何异常都吞掉：审计失败不能影响业务主流程 */
export async function writeCallLog(input: CallLogInput): Promise<void> {
  try {
    await AiCallLog.create({
      module: input.module,
      scenario: input.scenario,
      userId: input.userId ?? null,
      conversationId: input.conversationId ?? null,
      model: input.model,
      promptTokens: input.usage.promptTokens,
      completionTokens: input.usage.completionTokens,
      totalTokens: input.usage.totalTokens,
      cost: costOf(input.usage, input.billable === true),
      latencyMs: input.latencyMs,
      status: input.status,
      error: input.error ? input.error.slice(0, 200) : null,
      cacheHit: input.cacheHit ? 1 : 0,
      fallbackReason: input.fallbackReason ? input.fallbackReason.slice(0, 60) : null,
    })
  } catch (error) {
    console.error('[ai] 写调用审计失败', error)
  }
}

/** 当日某批 module 已花的钱（失败调用不计费） */
export async function spentToday(modules: AiModule[]): Promise<number> {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const spent = await AiCallLog.sum('cost', {
    where: { module: { [Op.in]: modules }, createdAt: { [Op.gte]: start }, status: 1 },
  })
  return Number(spent) || 0
}
