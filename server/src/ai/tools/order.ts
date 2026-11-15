import { z } from 'zod'
import { ORDER_STATUS_TEXT } from '../../constants'
import { formatDate } from '../../utils/serializers'
import { maskPhone } from '../../utils/helpers'
import { Order, OrderItem, OrderLogistics } from '../../models'
import { registerTool } from './registry'

/**
 * 订单类工具：只读，且强制按当前登录用户过滤。
 * 迁移自 aiChatService.executeTool()，行为保持不变，仅把入参校验与鉴权交给注册表。
 */

const ORDER_NO_PATTERN = /^[A-Za-z0-9-]{6,32}$/

const orderArgs = z.object({
  order_no: z
    .string()
    .trim()
    .max(32)
    .optional()
    .describe('订单号；省略时使用当前会话关联的订单'),
})

/** 只有登录用户可用；后台/系统身份不暴露订单工具 */
function requireUser(ctx: { role: string; userId?: number }): number {
  if (ctx.role !== 'user' || !ctx.userId) throw new Error('需要登录用户身份')
  return ctx.userId
}

function resolveOrderNo(args: { order_no?: string }, ctx: { orderNo?: string }): string | null {
  const requested = args.order_no?.trim() || ctx.orderNo?.trim() || ''
  return requested || null
}

registerTool({
  name: 'get_order_detail',
  description:
    '查询当前登录用户某笔订单的状态、实付金额、商品件数与关键时间。只能查本人订单；不传订单号时使用当前会话关联的订单。',
  parameters: {
    type: 'object',
    properties: {
      order_no: { type: 'string', description: '订单号；省略时使用当前会话关联的订单' },
    },
    required: [],
  },
  schema: orderArgs,
  authz: (ctx) => {
    requireUser(ctx)
  },
  label: (args, ctx) => `已查询订单 ${resolveOrderNo(args, ctx) ?? ''} 的状态`,
  async execute(args, ctx) {
    const userId = requireUser(ctx)
    const requested = resolveOrderNo(args, ctx)
    if (!requested) {
      return { error: '没有可查询的订单号，请先向用户确认订单号' }
    }
    if (!ORDER_NO_PATTERN.test(requested)) return { error: '订单号格式不正确' }

    const order = await Order.findOne({
      where: { orderNo: requested, userId, userDeleted: 0 },
      include: [{ model: OrderItem, as: 'items' }],
    })
    if (!order) return { error: '未找到该订单，或该订单不属于当前用户' }

    const items = (order.get('items') as OrderItem[] | null) ?? []
    const itemCount = items.reduce((sum, item) => sum + Number(item.quantity ?? 0), 0)

    return {
      orderNo: order.orderNo,
      statusText: ORDER_STATUS_TEXT[order.status] ?? '',
      payAmount: Number(order.payAmount ?? 0).toFixed(2),
      totalAmount: Number(order.totalAmount ?? 0).toFixed(2),
      itemCount,
      createdAt: order.createdAt ? formatDate(order.createdAt) : '',
      payTime: order.payTime ? formatDate(order.payTime) : '',
      shipTime: order.shipTime ? formatDate(order.shipTime) : '',
      receiver: order.receiverName ?? '',
      receiverPhone: maskPhone(order.receiverPhone),
      items: items.slice(0, 5).map((item) => ({
        name: item.productName,
        spec: item.skuSpecText ?? '',
        quantity: Number(item.quantity ?? 0),
      })),
    }
  },
})

registerTool({
  name: 'get_order_logistics',
  description:
    '查询当前登录用户某笔订单的物流公司、运单号与最新轨迹。只能查本人订单；不传订单号时使用当前会话关联的订单。',
  parameters: {
    type: 'object',
    properties: {
      order_no: { type: 'string', description: '订单号；省略时使用当前会话关联的订单' },
    },
    required: [],
  },
  schema: orderArgs,
  authz: (ctx) => {
    requireUser(ctx)
  },
  label: (args, ctx) => `已查询订单 ${resolveOrderNo(args, ctx) ?? ''} 的物流`,
  async execute(args, ctx) {
    const userId = requireUser(ctx)
    const requested = resolveOrderNo(args, ctx)
    if (!requested) {
      return { error: '没有可查询的订单号，请先向用户确认订单号' }
    }
    if (!ORDER_NO_PATTERN.test(requested)) return { error: '订单号格式不正确' }

    const order = await Order.findOne({
      where: { orderNo: requested, userId, userDeleted: 0 },
      include: [{ model: OrderLogistics, as: 'logistics' }],
    })
    if (!order) return { error: '未找到该订单，或该订单不属于当前用户' }

    const logistics = order.get('logistics') as OrderLogistics | null
    return {
      orderNo: order.orderNo,
      statusText: ORDER_STATUS_TEXT[order.status] ?? '',
      company: logistics?.company ?? '',
      trackingNo: logistics?.trackingNo ?? '',
      shipTime: order.shipTime ? formatDate(order.shipTime) : '',
      traces: (logistics?.traces ?? []).slice(0, 3),
      note: logistics ? '' : '商家尚未发货，暂无物流信息',
    }
  },
})
