import { Op } from 'sequelize'
import { AiConversation, AiFeedback, AiMessage } from '../models'
import { AppError } from '../utils/errors'

/**
 * 回答评价（👍/👎 + 纠错）。
 *
 * 为什么值得单独做：这是「评测集」的唯一真实数据来源。
 * 没有人工反馈，就无法判断知识边界扩得对不对，也做不出「兜底率下降而准确率不变」的结论。
 */

export interface RateInput {
  rating: 1 | -1
  reason?: string
  correctedAnswer?: string
}

export async function rateMessage(
  userId: number,
  messageId: number,
  input: RateInput,
): Promise<{ messageId: number; rating: number; saved: boolean }> {
  const message = await AiMessage.findByPk(messageId)
  if (!message) throw AppError.notFound('消息不存在')
  if (message.role !== 'assistant') throw new AppError('只能评价 AI 的回答')

  const conversation = await AiConversation.findOne({
    where: { id: message.conversationId, userId },
    attributes: ['id'],
  })
  if (!conversation) throw AppError.notFound('消息不存在')

  const existing = await AiFeedback.findOne({ where: { messageId, userId } })
  const payload = {
    messageId,
    conversationId: Number(message.conversationId),
    userId,
    module: 'chat',
    scenario: 'customer_service',
    rating: input.rating,
    reason: input.reason?.trim().slice(0, 100) || null,
    correctedAnswer: input.correctedAnswer?.trim().slice(0, 1000) || null,
  }

  if (existing) {
    await existing.update(payload)
    return { messageId, rating: input.rating, saved: true }
  }
  await AiFeedback.create(payload)
  return { messageId, rating: input.rating, saved: true }
}

/** 某条消息当前的评价（用于重开会话时回显按钮状态） */
export async function getRating(userId: number, messageId: number): Promise<number> {
  const row = await AiFeedback.findOne({ where: { messageId, userId }, attributes: ['rating'] })
  return row?.rating ?? 0
}

export interface QualityStats {
  rated: number
  up: number
  down: number
  upRate: number
  /** 有纠错文本的条数：可人工整理进 ai_eval_cases */
  corrected: number
}

export async function qualityStats(since: Date): Promise<QualityStats> {
  const [rated, up, corrected] = await Promise.all([
    AiFeedback.count({ where: { createdAt: { [Op.gte]: since } } }),
    AiFeedback.count({ where: { createdAt: { [Op.gte]: since }, rating: 1 } }),
    AiFeedback.count({
      where: { createdAt: { [Op.gte]: since }, correctedAnswer: { [Op.ne]: null } },
    }),
  ])
  return {
    rated,
    up,
    down: Math.max(0, rated - up),
    upRate: rated ? Math.round((up / rated) * 1000) / 10 : 0,
    corrected,
  }
}

/** 后台：最近的差评样本，含纠错文本，便于直接整理成评测用例 */
export async function recentBadFeedback(limit = 20) {
  const rows = await AiFeedback.findAll({
    where: { rating: -1 },
    order: [['id', 'DESC']],
    limit: Math.min(50, Math.max(1, limit)),
  })
  return rows.map((row) => ({
    id: Number(row.id),
    messageId: Number(row.messageId),
    conversationId: row.conversationId ? Number(row.conversationId) : null,
    reason: row.reason ?? '',
    correctedAnswer: row.correctedAnswer ?? '',
    createdAt: row.createdAt ? row.createdAt.toISOString() : '',
  }))
}
