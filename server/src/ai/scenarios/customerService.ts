import { Op, type WhereOptions } from 'sequelize'
import { config } from '../../config'
import { ERR, ORDER_STATUS_TEXT } from '../../constants'
import { AppError } from '../../utils/errors'
import { formatDate } from '../../utils/serializers'
import { maskPhone } from '../../utils/helpers'
import { aiMode } from '../../adapters/ai'
import type { AiMessage as AiToolMessage, AiUsage } from '../../adapters/ai'
import {
  AiConversation,
  AiMessage as AiMessageRow,
  Order,
  OrderItem,
  User,
} from '../../models'
import { runAiTask } from '../core/run'
import { searchKnowledge, type KnowledgeHit } from '../rag/retriever'
import { availableTools } from '../tools'
import {
  AI_DISCLAIMER,
  AI_QUICK_QUESTIONS,
  AI_WELCOME,
  nowText,
  renderSystemPrompt,
  toCitations,
  type AiCitation,
  type OrderSnapshot,
} from '../prompts/base'
import * as feedbackService from '../../services/feedbackService'

/**
 * 场景：智能客服（原 aiChatService 的全部业务逻辑）。
 *
 * 重构点：会话/落库/转人工仍在这里，但「限流、预算、熔断、工具轮次、审计、降级」
 * 全部交给 runAiTask，所以加第二个场景不用复制一份治理代码。
 *
 * 关键约束（保持不变）：
 * - 金额/库存/订单状态只读，AI 不参与任何写操作
 * - 工具只能查当前用户自己的订单与在售商品
 * - 所有输出都落 ai_messages，调用成本落 ai_call_logs
 */

const MAX_MESSAGE_LENGTH = 500
const ORDER_SPECIFIC = /订单|物流|快递|单号|到哪|发货|到货|签收|催|退款进度|退到哪/

export type AiStreamEvent =
  | { type: 'meta'; conversationId: number }
  | { type: 'thinking'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; label: string }
  | {
      type: 'done'
      conversationId: number
      messageId: number
      content: string
      citations: AiCitation[]
      usage: AiUsage
      grounded: boolean
      mode: 'deepseek' | 'mock'
      /** 兜底原因：有值说明这次回答走了降级路径，前端可显示提示 */
      fallbackReason?: string
    }
  | { type: 'error'; message: string }

export type AiEventHandler = (event: AiStreamEvent) => void

export interface ChatInput {
  userId: number
  message: string
  conversationId?: number
  orderNo?: string
  signal?: AbortSignal
  emit: AiEventHandler
}

export interface ChatOutcome {
  conversationId: number
  messageId: number
  content: string
  citations: AiCitation[]
  usage: AiUsage
  mode: 'deepseek' | 'mock'
}

interface ToolTrace {
  name: string
  arguments: string
  result: unknown
}

function extractOrderNo(message: string): string | null {
  const match = message.match(/[A-Za-z]{0,3}\d{10,32}/)
  return match ? match[0] : null
}

function normalizeMessage(raw: string): string {
  const message = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()
  if (!message) throw new AppError('请输入要咨询的问题')
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new AppError(`单条消息不能超过 ${MAX_MESSAGE_LENGTH} 字`)
  }
  return message
}

async function resolveConversation(input: ChatInput, message: string): Promise<AiConversation> {
  if (input.conversationId) {
    const conversation = await AiConversation.findOne({
      where: { id: input.conversationId, userId: input.userId },
    })
    if (!conversation) {
      throw new AppError('会话不存在或已失效', ERR.AI_CONVERSATION_NOT_FOUND, 404)
    }
    if (input.orderNo && !conversation.orderNo) {
      conversation.orderNo = input.orderNo
      await conversation.save()
    }
    return conversation
  }

  return AiConversation.create({
    userId: input.userId,
    orderNo: input.orderNo ?? null,
    title: message.slice(0, 100),
    source: 'contact',
    status: 1,
    messageCount: 0,
    lastMessage: message.slice(0, 255),
    lastMessageAt: new Date(),
  })
}

async function loadHistory(conversationId: number): Promise<AiToolMessage[]> {
  const rows = await AiMessageRow.findAll({
    where: { conversationId, role: { [Op.in]: ['user', 'assistant'] } },
    order: [['id', 'DESC']],
    limit: config.ai.maxHistory,
  })
  return rows.reverse().map((row) => ({
    role: row.role === 'assistant' ? ('assistant' as const) : ('user' as const),
    content: row.content.slice(0, 600),
  }))
}

async function loadUserNickname(userId: number): Promise<string> {
  const user = await User.findByPk(userId, { attributes: ['nickname', 'username'] })
  return user?.nickname || user?.username || '菊友'
}

interface OrderContext {
  snapshot: OrderSnapshot
  orderNo: string
}

async function loadOrderContext(
  userId: number,
  orderNo: string | null,
): Promise<OrderContext | null> {
  if (!orderNo || !/^[A-Za-z0-9-]{6,32}$/.test(orderNo)) return null

  const order = await Order.findOne({
    where: { orderNo, userId, userDeleted: 0 },
    include: [{ model: OrderItem, as: 'items' }],
  })
  if (!order) return null

  const items = (order.get('items') as OrderItem[] | null) ?? []
  const itemCount = items.reduce((sum, item) => sum + Number(item.quantity ?? 0), 0)
  const receiver = order.receiverName
    ? `${order.receiverName}${order.receiverPhone ? ` ${maskPhone(order.receiverPhone)}` : ''}`
    : '未填写'

  return {
    orderNo: order.orderNo,
    snapshot: {
      orderNo: order.orderNo,
      statusText: ORDER_STATUS_TEXT[order.status] ?? '未知状态',
      payAmount: Number(order.payAmount ?? 0).toFixed(2),
      itemCount,
      createdAt: order.createdAt ? formatDate(order.createdAt) : '—',
      shipTime: order.shipTime ? formatDate(order.shipTime) : '',
      receiver,
    },
  }
}

function buildCustomerServicePrompt(context: {
  nickname: string
  order: OrderSnapshot | null
  knowledge: KnowledgeHit[]
}): string {
  const { nickname, order, knowledge } = context
  return renderSystemPrompt({
    persona: '你是「菊道人」自营商城的在线客服助手，服务对象是已登录的商城用户。',
    facts: [
      `当前时间：${nowText()}`,
      `用户昵称：${nickname || '菊友'}`,
      `关联订单：${
        order
          ? `${order.orderNo}（状态：${order.statusText}，实付 ¥${order.payAmount}，共 ${order.itemCount} 件，下单时间 ${order.createdAt}${order.shipTime ? `，发货时间 ${order.shipTime}` : ''}，收货人 ${order.receiver}）`
          : '无'
      }`,
    ],
    knowledge,
  })
}

export function publicConfig() {
  const mode = aiMode()
  return {
    enabled: config.ai.enabled,
    mode: mode.mode,
    model: mode.model,
    usingFallback: mode.usingFallback,
    welcome: AI_WELCOME,
    quickQuestions: AI_QUICK_QUESTIONS,
    disclaimer: AI_DISCLAIMER,
    /** 是否开放回答评价（👍/👎）；前端据此决定是否渲染反馈按钮 */
    feedbackEnabled: true,
  }
}

export async function chat(input: ChatInput): Promise<ChatOutcome> {
  if (!config.ai.enabled) {
    throw new AppError('AI 客服暂未开启，请使用在线留言', ERR.AI_UNAVAILABLE, 503)
  }

  const message = normalizeMessage(input.message)
  const conversation = await resolveConversation(input, message)
  input.emit({ type: 'meta', conversationId: Number(conversation.id) })

  // 先取历史（不含本轮），再落用户消息，避免历史里重复本轮提问
  const history = await loadHistory(conversation.id)

  await AiMessageRow.create({
    conversationId: conversation.id,
    role: 'user',
    content: message,
    citations: null,
    toolCalls: null,
    tokens: 0,
    model: null,
    latencyMs: null,
  })

  const startedAt = Date.now()
  const mode = aiMode().mode

  try {
    const [nickname, knowledge] = await Promise.all([
      loadUserNickname(input.userId),
      searchKnowledge(message),
    ])
    const citations = toCitations(knowledge)

    const orderNo = conversation.orderNo || input.orderNo || extractOrderNo(message)
    const orderContext = await loadOrderContext(input.userId, orderNo)
    const systemPrompt = buildCustomerServicePrompt({
      nickname,
      order: orderContext?.snapshot ?? null,
      knowledge,
    })

    const actor = {
      role: 'user' as const,
      userId: input.userId,
      orderNo: orderContext?.orderNo ?? orderNo ?? undefined,
    }
    const tools = availableTools(actor)
    const preferTools = Boolean(orderContext) && ORDER_SPECIFIC.test(message)
    if (preferTools) input.emit({ type: 'thinking', text: '正在查询你的订单信息…' })

    const result = await runAiTask({
      module: 'chat',
      scenario: 'customer_service',
      subjectId: input.userId,
      conversationId: Number(conversation.id),
      actor,
      system: systemPrompt,
      messages: [...history, { role: 'user', content: message }],
      mode: preferTools ? 'tools' : 'stream',
      tools: tools.length ? tools : undefined,
      maxToolRounds: 3,
      signal: input.signal,
      cache: undefined,
      onThinking: (text) => input.emit({ type: 'thinking', text }),
      onTool: (name, label) => input.emit({ type: 'tool', name, label }),
      onDelta: (text) => input.emit({ type: 'delta', text }),
      throwOnBlock: true,
    })

    let content = result.content.trim()
    if (!result.ok || !content) {
      // runAiTask 只在「结构化输出降级」时返回 ok=false；客服场景没有 schema，
      // 走到这里说明是空回答，按兜底话术处理即可。
      content =
        content || '抱歉，我这边暂时没能给出答案。你可以换个说法，或点「转人工」由客服跟进。'
    }

    // 工具路径是非流式的，拿到最终结果后一次性推给前端；普通路径已在 runAiTask 里增量推送
    if (preferTools) input.emit({ type: 'delta', text: content })

    const assistantRow = await AiMessageRow.create({
      conversationId: conversation.id,
      role: 'assistant',
      content,
      citations: citations.length ? citations : null,
      toolCalls: result.toolTrace.length ? result.toolTrace : null,
      tokens: result.usage.totalTokens,
      model: result.model,
      latencyMs: Date.now() - startedAt,
    })

    await conversation.update({
      messageCount: conversation.messageCount + 2,
      lastMessage: content.slice(0, 255),
      lastMessageAt: new Date(),
      orderNo: conversation.orderNo ?? orderContext?.orderNo ?? null,
    })

    input.emit({
      type: 'done',
      conversationId: Number(conversation.id),
      messageId: Number(assistantRow.id),
      content,
      citations,
      usage: result.usage,
      grounded: knowledge.length > 0 || result.toolTrace.length > 0,
      mode,
      fallbackReason: result.fallbackReason,
    })

    return {
      conversationId: Number(conversation.id),
      messageId: Number(assistantRow.id),
      content,
      citations,
      usage: result.usage,
      mode,
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'AI 客服暂时不可用'

    // 用户消息已落库；失败时补一条助手占位，避免会话历史断层。
    // 调用审计由 runAiTask 统一写入，这里不再重复落 ai_call_logs。
    await AiMessageRow.create({
      conversationId: conversation.id,
      role: 'assistant',
      content: `（系统提示）${messageText}`,
      citations: null,
      toolCalls: null,
      tokens: 0,
      model: null,
      latencyMs: Date.now() - startedAt,
    }).catch(() => undefined)

    input.emit({ type: 'error', message: messageText })
    throw error
  }
}

export interface ConversationDto {
  id: number
  orderNo: string
  title: string
  status: number
  messageCount: number
  lastMessage: string
  lastMessageAt: string | null
  createdAt: string
}

function toConversationDto(row: AiConversation): ConversationDto {
  return {
    id: Number(row.id),
    orderNo: row.orderNo ?? '',
    title: row.title ?? '',
    status: row.status,
    messageCount: row.messageCount,
    lastMessage: row.lastMessage ?? '',
    lastMessageAt: row.lastMessageAt ? formatDate(row.lastMessageAt) : null,
    createdAt: formatDate(row.createdAt),
  }
}

export async function listConversations(
  userId: number,
  orderNo?: string,
): Promise<ConversationDto[]> {
  // 未传订单号时只返回「通用会话」，避免帮助中心把某笔订单的会话混进来
  const where: WhereOptions = orderNo ? { userId, orderNo } : { userId, orderNo: null }
  const rows = await AiConversation.findAll({
    where,
    order: [['lastMessageAt', 'DESC']],
    limit: 20,
  })
  return rows.map(toConversationDto)
}

export interface MessageDto {
  id: number
  role: string
  content: string
  citations: AiCitation[]
  toolCalls: ToolTrace[]
  createdAt: string
}

export async function getMessages(userId: number, conversationId: number): Promise<MessageDto[]> {
  const conversation = await AiConversation.findOne({
    where: { id: conversationId, userId },
  })
  if (!conversation) throw new AppError('会话不存在', ERR.AI_CONVERSATION_NOT_FOUND, 404)

  const rows = await AiMessageRow.findAll({
    where: { conversationId, role: { [Op.in]: ['user', 'assistant'] } },
    order: [['id', 'ASC']],
    limit: 100,
  })
  return rows.map((row) => ({
    id: Number(row.id),
    role: row.role,
    content: row.content,
    citations: Array.isArray(row.citations) ? (row.citations as AiCitation[]) : [],
    toolCalls: Array.isArray(row.toolCalls) ? (row.toolCalls as ToolTrace[]) : [],
    createdAt: formatDate(row.createdAt),
  }))
}

export async function transferToHuman(
  userId: number,
  conversationId: number,
  note?: string,
): Promise<{ feedbackId: number; conversationId: number }> {
  const conversation = await AiConversation.findOne({
    where: { id: conversationId, userId },
  })
  if (!conversation) throw new AppError('会话不存在', ERR.AI_CONVERSATION_NOT_FOUND, 404)

  const rows = await AiMessageRow.findAll({
    where: { conversationId },
    order: [['id', 'DESC']],
    limit: 6,
  })
  const timeline = rows
    .reverse()
    .map((row) => `${row.role === 'user' ? '用户' : 'AI'}：${row.content.slice(0, 160)}`)
    .join('\n')
  const summary = note?.trim() || '用户在与 AI 客服沟通后请求转人工。'
  const content = `【AI 客服转人工】\n${summary}\n\n最近对话：\n${timeline}`.slice(0, 1900)

  const feedback = await feedbackService.createFeedback(userId, {
    type: 1,
    content,
    orderNo: conversation.orderNo ?? undefined,
  })

  conversation.status = 2
  await conversation.save()

  return { feedbackId: feedback.id, conversationId: Number(conversation.id) }
}
