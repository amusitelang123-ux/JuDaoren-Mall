import { z } from 'zod'
import { registerTool } from './registry'
import {
  getProductAiProfile,
  searchProductBriefs,
  type ProductListQuery,
} from '../../services/productService'

/**
 * 商品类工具（改进方向 §4 A2「把货纳入 AI 的认知」）。
 *
 * 关键取舍：商品**不**全量同步进 ai_kb_chunks（§4 A3），
 * 而是走 SQL + 按需取结构化摘要进 prompt，避免几千 SKU 撑爆内存索引。
 */

const searchArgs = z.object({
  keyword: z.string().trim().max(40).optional().describe('商品关键词，如「保温杯」「纯棉 T 恤」'),
  category_id: z.number().int().positive().optional().describe('类目 id'),
  brand_id: z.number().int().positive().optional().describe('品牌 id'),
  min_price: z.number().min(0).max(1_000_000).optional().describe('最低价（元）'),
  max_price: z.number().min(0).max(1_000_000).optional().describe('最高价（元）'),
  sort_by: z
    .enum(['default', 'sales', 'priceAsc', 'priceDesc', 'new'])
    .optional()
    .describe('排序：default 综合、sales 销量、priceAsc 低价优先、priceDesc 高价优先、new 最新'),
  limit: z.number().int().min(1).max(8).optional().describe('返回条数，默认 5'),
})

const detailArgs = z.object({
  product_id: z.number().int().positive().describe('商品 id（来自 search_products 的返回）'),
})

/** 商品信息对登录用户开放；后台身份也能用（便于日后 Copilot 复用） */
function requireActor(ctx: { role: string; userId?: number; adminId?: number }): void {
  if (ctx.role === 'user' && !ctx.userId) throw new Error('需要登录用户身份')
  if (ctx.role === 'admin' && !ctx.adminId) throw new Error('需要管理员身份')
  if (ctx.role === 'system') throw new Error('匿名身份不可访问商品工具')
}

registerTool({
  name: 'search_products',
  description:
    '按关键词 / 类目 / 品牌 / 价格区间检索在售商品，返回商品 id、名称、价格、销量、评分与库存。用户问「有没有…」「推荐…」「多少钱」时调用。',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '商品关键词，如「保温杯」「纯棉 T 恤」' },
      category_id: { type: 'integer', description: '类目 id（可选）' },
      brand_id: { type: 'integer', description: '品牌 id（可选）' },
      min_price: { type: 'number', description: '最低价（元，可选）' },
      max_price: { type: 'number', description: '最高价（元，可选）' },
      sort_by: {
        type: 'string',
        enum: ['default', 'sales', 'priceAsc', 'priceDesc', 'new'],
        description: '排序方式（可选）',
      },
      limit: { type: 'integer', description: '返回条数，默认 5，最大 8' },
    },
    required: [],
  },
  schema: searchArgs,
  authz: (ctx) => {
    requireActor(ctx)
  },
  label: (args) => (args.keyword ? `已检索商品「${args.keyword}」` : '已检索商品'),
  async execute(args) {
    const query: ProductListQuery = {
      keyword: args.keyword,
      categoryId: args.category_id,
      brandId: args.brand_id,
      minPrice: args.min_price,
      maxPrice: args.max_price,
      sortBy: args.sort_by,
    }
    const { items, total } = await searchProductBriefs(query, args.limit ?? 5)
    if (!items.length) {
      return { total: 0, items: [], note: '没有符合条件的在售商品，请换个说法或放宽价格区间' }
    }
    return { total, items }
  },
})

registerTool({
  name: 'get_product_detail',
  description:
    '查询单个商品的参数、可售规格与价格库存，以及评论里的好评点/差评点摘要。用户问「这件适合我吗」「有什么规格」「评价怎么样」时调用。',
  parameters: {
    type: 'object',
    properties: {
      product_id: { type: 'integer', description: '商品 id（来自 search_products 的返回）' },
    },
    required: ['product_id'],
  },
  schema: detailArgs,
  authz: (ctx) => {
    requireActor(ctx)
  },
  label: (args) => `已查看商品 #${args.product_id} 的详情`,
  async execute(args) {
    const profile = await getProductAiProfile(args.product_id)
    if (!profile) return { error: '商品不存在或已下架' }
    return profile
  },
})
