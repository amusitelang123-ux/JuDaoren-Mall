import { Op, QueryTypes, col, fn, type WhereOptions } from 'sequelize'
import { sequelize } from '../config/database'
import { AiCallLog, AiConversation, AiEvalCase, AiFeedback, AiMessage, User } from '../models'
import { buildPage } from '../utils/response'
import { formatDate } from '../utils/serializers'
import { maskPhone } from '../utils/helpers'
import { aiMode } from '../adapters/ai'
import { MODULE_LABEL, type AiModule, type AiBudgetBucket } from '../ai/core/types'
import { budgetState } from '../ai/core/guard'
import { runEvalSuite, type EvalCase } from '../ai/eval/runner'
import { knowledgeStats } from '../ai'
import { qualityStats, recentBadFeedback } from '../ai/feedback'
import { syncKnowledgeBase } from '../ai/rag/sync'
import type { AiCitation } from '../ai/prompts/base'

/** 后台：AI 会话、消息、分模块用量、质量指标与知识库运维 */

export interface AdminAiConversationQuery {
  keyword?: string
  status?: number
  page?: number
  pageSize?: number
}

export async function listConversations(query: AdminAiConversationQuery = {}) {
  const page = Math.max(1, query.page ?? 1)
  const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 10))

  const conditions: WhereOptions[] = []
  if (query.status !== undefined) conditions.push({ status: query.status })
  if (query.keyword) {
    const kw = `%${query.keyword}%`
    conditions.push({
      [Op.or]: [
        { title: { [Op.like]: kw } },
        { lastMessage: { [Op.like]: kw } },
        { orderNo: { [Op.like]: kw } },
      ],
    } as WhereOptions)
  }
  const where: WhereOptions = conditions.length ? { [Op.and]: conditions } : {}

  const { rows, count } = await AiConversation.findAndCountAll({
    where,
    include: [{ model: User, as: 'user' }],
    order: [['lastMessageAt', 'DESC']],
    limit: pageSize,
    offset: (page - 1) * pageSize,
    distinct: true,
  })

  const list = rows.map((row) => {
    const user = row.get('user') as User | null
    return {
      id: Number(row.id),
      userId: row.userId ? Number(row.userId) : null,
      nickname: user?.nickname || user?.username || '匿名用户',
      phone: maskPhone(user?.phone),
      orderNo: row.orderNo ?? '',
      title: row.title ?? '',
      status: row.status,
      messageCount: row.messageCount,
      lastMessage: row.lastMessage ?? '',
      lastMessageAt: row.lastMessageAt ? formatDate(row.lastMessageAt) : null,
      createdAt: formatDate(row.createdAt),
    }
  })

  return buildPage(list, page, pageSize, count)
}

export async function getConversationMessages(conversationId: number) {
  const conversation = await AiConversation.findByPk(conversationId)
  if (!conversation) return null

  const rows = await AiMessage.findAll({
    where: { conversationId },
    order: [['id', 'ASC']],
    limit: 200,
  })

  // 把 👍/👎 一起带出来：后台看会话时能直接看到哪条答得不好
  const ratings = await AiFeedback.findAll({
    where: { messageId: { [Op.in]: rows.map((row) => Number(row.id)) } },
    attributes: ['messageId', 'rating', 'reason'],
  })
  const ratingMap = new Map(ratings.map((row) => [Number(row.messageId), row]))

  return rows.map((row) => {
    const rating = ratingMap.get(Number(row.id))
    return {
      id: Number(row.id),
      role: row.role,
      content: row.content,
      citations: Array.isArray(row.citations) ? (row.citations as AiCitation[]) : [],
      toolCalls: Array.isArray(row.toolCalls) ? (row.toolCalls as unknown[]) : [],
      tokens: row.tokens,
      model: row.model ?? '',
      latencyMs: row.latencyMs ?? 0,
      rating: rating?.rating ?? 0,
      ratingReason: rating?.reason ?? '',
      createdAt: formatDate(row.createdAt),
    }
  })
}

interface UsageAggregate {
  calls: number
  tokens: number
  cost: number
  avgLatency: number
  failures: number
}

async function aggregate(where: WhereOptions): Promise<UsageAggregate> {
  const row = (await AiCallLog.findOne({
    where,
    attributes: [
      [fn('COUNT', col('id')), 'calls'],
      [fn('SUM', col('total_tokens')), 'tokens'],
      [fn('SUM', col('cost')), 'cost'],
      [fn('AVG', col('latency_ms')), 'avgLatency'],
      [fn('SUM', col('status')), 'successCount'],
    ],
    raw: true,
  })) as unknown as {
    calls?: number | string
    tokens?: number | string | null
    cost?: number | string | null
    avgLatency?: number | string | null
    successCount?: number | string | null
  } | null

  const calls = Number(row?.calls ?? 0)
  const success = Number(row?.successCount ?? 0)
  return {
    calls,
    tokens: Number(row?.tokens ?? 0),
    cost: Number(row?.cost ?? 0),
    avgLatency: Math.round(Number(row?.avgLatency ?? 0)),
    failures: Math.max(0, calls - success),
  }
}

function startOfToday(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

interface ModuleUsage {
  module: string
  moduleLabel: string
  scenario: string
  calls: number
  tokens: number
  cost: number
  avgLatency: number
  failures: number
  fallbacks: number
  cacheHits: number
}

/** 分模块用量：后台 Copilot 与用户端不再共享一个额度，用量页也要能按模块下钻 */
async function usageByModule(since: Date): Promise<ModuleUsage[]> {
  const rows = (await sequelize.query(
    `SELECT module,
            COALESCE(scenario, '') AS scenario,
            COUNT(*) AS calls,
            COALESCE(SUM(total_tokens), 0) AS tokens,
            COALESCE(SUM(cost), 0) AS cost,
            ROUND(COALESCE(AVG(latency_ms), 0)) AS avg_latency,
            SUM(CASE WHEN status = 0 THEN 1 ELSE 0 END) AS failures,
            SUM(CASE WHEN fallback_reason IS NOT NULL AND fallback_reason <> '' THEN 1 ELSE 0 END) AS fallbacks,
            SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) AS cache_hits
       FROM ai_call_logs
      WHERE created_at >= :since
      GROUP BY module, COALESCE(scenario, '')
      ORDER BY calls DESC`,
    { replacements: { since }, type: QueryTypes.SELECT },
  )) as unknown as {
    module: string
    scenario: string
    calls: number | string
    tokens: number | string
    cost: number | string
    avg_latency: number | string
    failures: number | string
    fallbacks: number | string
    cache_hits: number | string
  }[]

  return rows.map((row) => ({
    module: row.module,
    moduleLabel: MODULE_LABEL[row.module as AiModule] ?? row.module,
    scenario: row.scenario,
    calls: Number(row.calls ?? 0),
    tokens: Number(row.tokens ?? 0),
    cost: Number(Number(row.cost ?? 0).toFixed(4)),
    avgLatency: Number(row.avg_latency ?? 0),
    failures: Number(row.failures ?? 0),
    fallbacks: Number(row.fallbacks ?? 0),
    cacheHits: Number(row.cache_hits ?? 0),
  }))
}

export async function usageStats() {
  const today = startOfToday()
  const week = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000)

  const [todayAgg, weekAgg, byModule, quality] = await Promise.all([
    aggregate({ createdAt: { [Op.gte]: today } }),
    aggregate({ createdAt: { [Op.gte]: week } }),
    usageByModule(week),
    qualityStats(week),
  ])
  const knowledge = await knowledgeStats()

  const daily = (await sequelize.query(
    `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS date,
            COUNT(*) AS calls,
            COALESCE(SUM(total_tokens), 0) AS tokens,
            COALESCE(SUM(cost), 0) AS cost
       FROM ai_call_logs
      WHERE created_at >= :since
      GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')
      ORDER BY date ASC`,
    { replacements: { since: week }, type: QueryTypes.SELECT },
  )) as unknown as { date: string; calls: number | string; tokens: number | string; cost: number | string }[]

  const [conversations, messages, transferred] = await Promise.all([
    AiConversation.count(),
    AiMessage.count(),
    AiConversation.count({ where: { status: 2 } }),
  ])

  // 兜底率 = 降级调用占比；转人工率单独给，两者合起来才是文档里说的「兜底率」
  const totalCalls = weekAgg.calls
  const fallbackCalls = byModule.reduce((sum, item) => sum + item.fallbacks, 0)
  const budgets = await Promise.all(
    (['chat', 'admin', 'other'] as AiBudgetBucket[]).map((bucket) => budgetState(bucket)),
  )

  const mode = aiMode()
  return {
    mode: mode.mode,
    model: mode.model,
    usingFallback: mode.usingFallback,
    today: todayAgg,
    week: weekAgg,
    totals: { conversations, messages, knowledgeChunks: knowledge.chunks, transferred },
    knowledgeIndexedAt: knowledge.indexedAt,
    budgets,
    byModule,
    quality: {
      ...quality,
      fallbackRate: totalCalls ? Math.round((fallbackCalls / totalCalls) * 1000) / 10 : 0,
      transferRate: conversations ? Math.round((transferred / conversations) * 1000) / 10 : 0,
      fallbackCalls,
    },
    daily: daily.map((item) => ({
      date: String(item.date).slice(0, 10),
      calls: Number(item.calls ?? 0),
      tokens: Number(item.tokens ?? 0),
      cost: Number(Number(item.cost ?? 0).toFixed(4)),
    })),
  }
}

/** 后台：最近差评样本（带纠错文本），可直接整理成评测用例 */
export async function badFeedback(limit = 20) {
  return recentBadFeedback(limit)
}

/** 后台：直接跑一遍评测集，用于「改完提示词立刻看效果」 */
export async function runEvaluation(scenario?: string) {
  const where: WhereOptions = scenario ? { status: 1, scenario } : { status: 1 }
  const rows = await AiEvalCase.findAll({ where, order: [['id', 'ASC']], limit: 100 })
  const cases: EvalCase[] = rows.map((row) => ({
    id: Number(row.id),
    module: row.module,
    scenario: row.scenario ?? '',
    input: row.input,
    expectJson: row.expectJson,
    tags: row.tags,
  }))
  if (!cases.length) return { summaries: [], total: 0 }
  const summaries = await runEvalSuite(cases)
  return { summaries, total: cases.length }
}

export async function rebuildKnowledge() {
  return syncKnowledgeBase()
}
