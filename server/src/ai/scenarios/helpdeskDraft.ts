import { Op } from 'sequelize'
import { z } from 'zod'
import { Feedback, Order, User } from '../../models'
import { AppError } from '../../utils/errors'
import { formatDate } from '../../utils/serializers'
import { runAiTask } from '../core/run'
import { searchKnowledge, tokenize, type KnowledgeHit } from '../rag/retriever'
import { toCitations, type AiCitation } from '../prompts/base'
import type { TicketCategory, TicketInsight, TicketUrgency } from './types'

/**
 * 场景：坐席辅助（改进方向 §6 C5）。
 *
 * 后台处理工单时，AI 自动做三件事：① 归类与优先级 ② 检索相似历史工单与知识条款
 * ③ 生成回复草稿。**草稿只返回、不写库**，人工确认后才走 replyFeedback。
 * 这是「AI 进入业务流程而不是新增一个入口」最省事的一步。
 */

const insightSchema = z.object({
  category: z.enum(['咨询', '投诉', '建议', '售后']),
  urgency: z.enum(['low', 'normal', 'high']),
  summary: z.string().trim().min(2).max(60),
  draft: z.string().trim().min(10).max(600),
})

const URGENT_HINT = /投诉|曝光|12315|差评|举报|维权|诈骗|报警|起诉|退款|急/
const TYPE_HINT: { pattern: RegExp; category: TicketCategory }[] = [
  { pattern: /投诉|差评|曝光|生气|态度|无人|骗/, category: '投诉' },
  { pattern: /建议|希望|能不能|增加|优化|建议增加/, category: '建议' },
  { pattern: /退款|退货|换货|售后|破损|质量|少发|错发/, category: '售后' },
]

function ruleClassify(content: string): { category: TicketCategory; urgency: TicketUrgency } {
  const category = TYPE_HINT.find((rule) => rule.pattern.test(content))?.category ?? '咨询'
  const urgency: TicketUrgency = URGENT_HINT.test(content) ? 'high' : category === '投诉' ? 'high' : 'normal'
  return { category, urgency }
}

function ruleDraft(knowledge: KnowledgeHit[], category: TicketCategory): string {
  const clause = knowledge[0]?.content?.split('\n').slice(0, 2).join(' ').slice(0, 120) ?? ''
  const head =
    category === '投诉'
      ? '非常抱歉给你带来了不好的体验，我们已经记录你反馈的问题。'
      : category === '售后'
        ? '收到你的售后申请，先帮你确认一下处理方式。'
        : '收到你的留言，我们按下面的方式帮你处理。'
  const body = clause ? `按照平台规则：${clause}` : '客服会在 24 小时内跟进处理。'
  return `${head}${body} 如果还需要补充信息，可以直接回复这条消息。`
}

function similarityScore(text: string, other: string): number {
  const tokens = new Set(tokenize(text))
  if (!tokens.size) return 0
  let hit = 0
  for (const token of tokenize(other)) if (tokens.has(token)) hit += 1
  return hit / Math.sqrt(tokens.size)
}

export interface SimilarTicket {
  id: number
  content: string
  replyContent: string
  createdAt: string
  score: number
}

export interface HelpdeskDraftResult {
  feedbackId: number
  category: TicketCategory
  urgency: TicketUrgency
  summary: string
  draft: string
  citations: AiCitation[]
  similarTickets: SimilarTicket[]
  aiGenerated: true
  degraded: boolean
  fallbackReason: string | null
  latencyMs: number
}

export async function draftFeedbackReply(
  feedbackId: number,
  adminId?: number,
): Promise<HelpdeskDraftResult> {
  const startedAt = Date.now()
  const feedback = await Feedback.findByPk(feedbackId)
  if (!feedback) throw AppError.notFound('工单不存在')

  const content = feedback.content ?? ''
  const [knowledge, user, order] = await Promise.all([
    searchKnowledge(content, 3),
    User.findByPk(feedback.userId, { attributes: ['nickname', 'username'] }),
    feedback.orderNo
      ? Order.findOne({ where: { orderNo: feedback.orderNo }, attributes: ['orderNo', 'status', 'payAmount'] })
      : Promise.resolve(null),
  ])

  // 相似历史工单：在最近 200 条已回复工单里做词法相似度，不额外建索引
  const recent = await Feedback.findAll({
    where: { status: 1, replyContent: { [Op.ne]: null }, id: { [Op.ne]: feedbackId } },
    order: [['id', 'DESC']],
    limit: 200,
    attributes: ['id', 'content', 'replyContent', 'createdAt'],
  })
  const similarTickets: SimilarTicket[] = recent
    .map((row) => ({
      id: Number(row.id),
      content: row.content.slice(0, 120),
      replyContent: (row.replyContent ?? '').slice(0, 200),
      createdAt: formatDate(row.createdAt),
      score: Math.round(similarityScore(content, `${row.content} ${row.replyContent ?? ''}`) * 100) / 100,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)

  const rule = ruleClassify(content)
  const fallbackInsight: TicketInsight = {
    category: rule.category,
    urgency: rule.urgency,
    summary: content.replace(/\s+/g, ' ').slice(0, 60),
    draft: ruleDraft(knowledge, rule.category),
  }

  const userText = user?.nickname || user?.username || '用户'
  const orderText = order ? `${order.orderNo}（实付 ¥${Number(order.payAmount ?? 0).toFixed(2)}）` : '无'
  const knowledgeText = knowledge.length
    ? knowledge.map((hit, index) => `[${index + 1}] ${hit.title}\n${hit.content.slice(0, 300)}`).join('\n\n')
    : '（未命中知识库）'
  const similarText = similarTickets.length
    ? similarTickets.map((item, index) => `${index + 1}. 用户：${item.content}\n   客服回复：${item.replyContent}`).join('\n')
    : '（无相似历史工单）'

  const result = await runAiTask({
    module: 'admin',
    scenario: 'helpdesk_draft',
    subjectId: adminId ?? null,
    actor: { role: 'admin', adminId },
    system: `你是小兔鲜商城的客服主管，正在辅助人工客服处理一条用户留言工单。

【工单信息】
- 用户：${userText}
- 关联订单：${orderText}
- 工单内容：${content.slice(0, 600)}

【命中的平台规则】
${knowledgeText}

【相似历史工单与当时的回复】
${similarText}

输出 JSON：{"category":"咨询|投诉|建议|售后","urgency":"low|normal|high","summary":"一句话摘要（30 字内）","draft":"建议回复草稿"}

要求：
1. draft 是准备发给用户的回复，中文、礼貌、口语化，不超过 200 字；先回应情绪或问题，再给处理方案与时限。
2. 涉及退款金额、赔偿、时效承诺时，只能复述上面的平台规则，并说明「以人工审核为准」。
3. 不要编造订单状态、物流节点或补偿方案；资料没有的就说需要进一步核实。
4. 不要输出 Markdown、列表符号或多余解释，只输出 JSON。`,
    messages: [{ role: 'user', content: '请给出归类与回复草稿。' }],
    schema: insightSchema,
    temperature: 0.3,
    maxTokens: 700,
    timeoutMs: 20_000,
    fallback: () => fallbackInsight,
  })

  const insight = result.data ?? fallbackInsight

  // 归类写回工单主表（AI 不可用时保持为空即可，不影响原有流程）
  try {
    await feedback.update({
      aiCategory: insight.category,
      aiSummary: insight.summary.slice(0, 255),
    })
  } catch (error) {
    console.error('[ai] 工单归类写回失败', error)
  }

  return {
    feedbackId: Number(feedback.id),
    category: insight.category,
    urgency: insight.urgency,
    summary: insight.summary,
    draft: insight.draft,
    citations: toCitations(knowledge),
    similarTickets,
    aiGenerated: true,
    degraded: !result.ok,
    fallbackReason: result.fallbackReason ?? null,
    latencyMs: Date.now() - startedAt,
  }
}

export { insightSchema }
