import { QueryTypes } from 'sequelize'
import { z } from 'zod'
import { sequelize } from '../../config/database'
import { config } from '../../config'
import { Brand, Category, Product, SearchLog } from '../../models'
import { countProducts } from '../../services/productService'
import type { ProductListQuery } from '../../services/productService'
import { runAiTask } from '../core/run'
import { isScenarioEnabled } from '../core/guard'
import { aiMode } from '../../adapters/ai'
import { registerMockScenario } from '../../adapters/ai/mock'
import type { SearchSortBy } from './types'

/**
 * 场景：搜索查询理解（改进方向 §4 A1）。
 *
 * 边界（很重要）：
 * - 模型只负责「把一句话翻译成检索参数」，**不**决定价格过滤、上下架、库存；
 * - 类目 / 品牌一律按名称回查数据库换成 id，模型给的 id 一概不采信；
 * - 有硬超时预算，超时 / 校验失败 / 未开启场景都退回规则解析，搜索主链路不受影响；
 * - 解析出多个过滤条件却筛成零结果时，按「属性 → 品牌 → 类目 → 价格」逐级放宽，
 *   把「过度解析导致零结果」这个风险按工程手段消掉。
 */

const MAX_QUERY_LENGTH = 60
const ATTRIBUTE_LIMIT = 3

const SORT_VALUES = ['default', 'sales', 'priceAsc', 'priceDesc', 'new'] as const

/** 模型输出：字段尽量宽松，真正的合法性由 normalize 决定 */
const modelSchema = z.object({
  keyword: z.string().max(60).optional().default(''),
  category: z.string().max(30).optional().default(''),
  brand: z.string().max(30).optional().default(''),
  minPrice: z.number().min(0).max(1_000_000).nullable().optional(),
  maxPrice: z.number().min(0).max(1_000_000).nullable().optional(),
  attributes: z.array(z.string().max(30)).max(5).optional().default([]),
  sortBy: z.enum(SORT_VALUES).optional().default('default'),
})

type ModelParse = z.output<typeof modelSchema>

export interface ParsedSearch {
  keyword: string
  categoryId: number | null
  categoryName: string
  brandId: number | null
  brandName: string
  minPrice: number | null
  maxPrice: number | null
  attributes: string[]
  sortBy: SearchSortBy
}

export interface SearchChip {
  field: 'keyword' | 'category' | 'brand' | 'price' | 'attribute' | 'sort'
  label: string
  /** 点击 chips 上的 × 时前端用它决定去掉哪个条件 */
  value: string
}

export interface SearchParseResult {
  query: string
  parsed: ParsedSearch
  chips: SearchChip[]
  /** 是否走了规则降级（前端可显示「AI 暂不可用，已按关键词搜索」） */
  degraded: boolean
  fallbackReason: string | null
  /** 被放宽掉的过滤条件，便于前端提示「已放宽筛选」 */
  relaxed: string[]
  resultCount: number
  latencyMs: number
  timeoutMs: number
  mode: 'deepseek' | 'mock'
}

interface Hints {
  categories: { id: number; name: string; level: number }[]
  brands: { id: number; name: string }[]
}

let hintsCache: { data: Hints; at: number } | null = null
const HINTS_TTL = 60_000

async function loadHints(): Promise<Hints> {
  if (hintsCache && Date.now() - hintsCache.at < HINTS_TTL) return hintsCache.data
  const [categories, brands] = await Promise.all([
    Category.findAll({ where: { status: 1 }, attributes: ['id', 'name', 'level'], order: [['sort', 'ASC']] }),
    Brand.findAll({ where: { status: 1 }, attributes: ['id', 'name'], order: [['sort', 'ASC']] }),
  ])
  const data: Hints = {
    categories: categories.map((c) => ({ id: Number(c.id), name: c.name, level: Number(c.level) })),
    brands: brands.map((b) => ({ id: Number(b.id), name: b.name })),
  }
  hintsCache = { data, at: Date.now() }
  return data
}

/* --------------------------- 规则解析（降级基线） --------------------------- */

const PRICE_RANGE = /(\d+(?:\.\d+)?)\s*(?:元|块|rmb)?\s*[-~到至]\s*(\d+(?:\.\d+)?)/
const PRICE_MAX_PATTERNS = [
  /(\d+(?:\.\d+)?)\s*(?:元|块|rmb)?\s*(?:以内|以下|之内|内|左右)/,
  /(?:不超过|不高于|低于|少于|小于)\s*(\d+(?:\.\d+)?)/,
]
const PRICE_MIN_PATTERNS = [
  /(\d+(?:\.\d+)?)\s*(?:元|块|rmb)?\s*(?:以上|起|往上)/,
  /(?:超过|高于|大于|至少)\s*(\d+(?:\.\d+)?)/,
]

const SORT_RULES: { pattern: RegExp; sortBy: SearchSortBy }[] = [
  { pattern: /最便宜|便宜|低价|性价比|省钱/, sortBy: 'priceAsc' },
  { pattern: /最贵|高端|贵的/, sortBy: 'priceDesc' },
  { pattern: /销量|热卖|卖得好|爆款|热门/, sortBy: 'sales' },
  { pattern: /最新|新款|新品|刚上/, sortBy: 'new' },
]

/**
 * 口语里的噪音词：只影响「关键词干不干净」，不影响过滤条件。
 * 顺序有意义——长词放在短词前面（「块钱」先于「块」）。
 */
const NOISE = [
  '有没有',
  '帮我找',
  '帮我搜',
  '我想买',
  '想买个',
  '想买',
  '推荐一下',
  '推荐',
  '找一下',
  '找找',
  '搜一下',
  '想找',
  '看看',
  '预算',
  '求推荐',
  '多少钱',
  '什么价',
  '价格',
  '块钱',
  '块以内',
  '元以内',
  '以内',
  '以下',
  '以上',
  '左右',
  '大概',
  '差不多',
  '便宜点',
  '便宜',
  '最便宜',
  '最贵的',
  '最贵',
  '销量最高',
  '销量',
  '卖得最好',
  '卖得好',
  '热卖',
  '爆款',
  '热门',
  '最高',
  '最新',
  '新款',
  '新品',
  '性价比',
  '划算',
  '一点',
  '块',
  '元',
  '钱',
  '个',
  '的',
]

function normalizeText(raw: string): string {
  return (raw ?? '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_LENGTH)
}

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }

/** 中文数字转阿拉伯数字：三百 → 300、两百五十 → 250、十五 → 15 */
function cnToNumber(text: string): number | null {
  let section = 0
  let number = 0
  for (const ch of text) {
    if (ch in CN_DIGITS) {
      number = CN_DIGITS[ch]
      continue
    }
    const unit = CN_UNITS[ch]
    if (!unit) return null
    section += (number || 1) * unit
    number = 0
  }
  const total = section + number
  return total > 0 ? total : null
}

/**
 * 价格语境里的中文数字统一成阿拉伯数字。
 * 「预算三百以内的台灯」如果只靠正则找 \d+，规则解析会直接漏掉价格——
 * 这是用户最常见的说法之一，补 10 行代码比多打一次模型更划算。
 */
function normalizeChineseNumbers(text: string): string {
  return text.replace(
    /([零一二两三四五六七八九十百千万]+)(?=\s*(?:元|块|块钱|以内|以下|以上|左右|到|至))/g,
    (match) => {
      const value = cnToNumber(match)
      return value === null ? match : String(value)
    },
  )
}

function pickPrice(text: string): { minPrice: number | null; maxPrice: number | null; matched: string[] } {
  const matched: string[] = []
  let minPrice: number | null = null
  let maxPrice: number | null = null

  const range = text.match(PRICE_RANGE)
  if (range) {
    const low = Number(range[1])
    const high = Number(range[2])
    minPrice = Math.min(low, high)
    maxPrice = Math.max(low, high)
    matched.push(range[0])
  } else {
    for (const pattern of PRICE_MAX_PATTERNS) {
      const hit = text.match(pattern)
      if (hit) {
        maxPrice = Number(hit[1])
        matched.push(hit[0])
        break
      }
    }
    for (const pattern of PRICE_MIN_PATTERNS) {
      const hit = text.match(pattern)
      if (hit && maxPrice === null) {
        minPrice = Number(hit[1])
        matched.push(hit[0])
        break
      }
    }
  }
  return { minPrice, maxPrice, matched }
}

function pickName<T extends { name: string }>(text: string, items: T[]): T | null {
  let best: T | null = null
  for (const item of items) {
    if (!item.name || !text.includes(item.name)) continue
    if (!best || item.name.length > best.name.length) best = item
  }
  return best
}

/** 纯规则解析：不依赖模型，既是最低成本的兜底，也是 mock 模式下的「演示智能」 */
export function ruleParse(rawQuery: string, hints: Hints): ParsedSearch {
  const text = normalizeChineseNumbers(normalizeText(rawQuery))
  const { minPrice, maxPrice, matched } = pickPrice(text)

  const category = pickName(text, hints.categories)
  const brand = pickName(text, hints.brands)

  let sortBy: SearchSortBy = 'default'
  for (const rule of SORT_RULES) {
    if (rule.pattern.test(text)) {
      sortBy = rule.sortBy
      break
    }
  }

  let keyword = text
  for (const fragment of [...matched, category?.name ?? '', brand?.name ?? '', ...NOISE]) {
    if (fragment) keyword = keyword.split(fragment).join(' ')
  }
  // 去掉标点、单字残片与纯数字，得到「能拿去 LIKE 检索」的关键词
  keyword = keyword
    .replace(/[，。！？、,.!?~\-—]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !/^\d+(\.\d+)?$/.test(token))
    .join(' ')

  return {
    keyword: keyword.slice(0, 40),
    categoryId: category?.id ?? null,
    categoryName: category?.name ?? '',
    brandId: brand?.id ?? null,
    brandName: brand?.name ?? '',
    minPrice,
    maxPrice,
    attributes: [],
    sortBy,
  }
}

/* ------------------------------ 归一化与校验 ------------------------------ */

function clampPrice(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value) || value < 0) return null
  return Math.min(1_000_000, Math.round(value * 100) / 100)
}

function normalizeParse(
  model: ModelParse | null,
  rule: ParsedSearch,
  hints: Hints,
  query: string,
): ParsedSearch {
  if (!model) return { ...rule, keyword: rule.keyword || query }
  const source = model

  // 类目 / 品牌：只认「名称 → 数据库 id」，模型给的名字对不上就退回规则结果
  const categoryName = String(source.category ?? '').trim()
  const matchedCategory = categoryName
    ? hints.categories.find((c) => c.name === categoryName) ?? pickName(categoryName, hints.categories)
    : null
  const brandName = String(source.brand ?? '').trim()
  const matchedBrand = brandName
    ? hints.brands.find((b) => b.name === brandName) ?? pickName(brandName, hints.brands)
    : null

  let minPrice = clampPrice(source.minPrice)
  let maxPrice = clampPrice(source.maxPrice)
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
    ;[minPrice, maxPrice] = [maxPrice, minPrice]
  }

  const keyword = String(source.keyword ?? '').trim().slice(0, 40) || rule.keyword
  const sortBy = SORT_VALUES.includes(source.sortBy as SearchSortBy)
    ? (source.sortBy as SearchSortBy)
    : rule.sortBy

  const attributes = [...new Set((source.attributes ?? []).map((item) => String(item).trim()))]
    .filter(Boolean)
    .slice(0, ATTRIBUTE_LIMIT)

  return {
    keyword: keyword || query,
    categoryId: matchedCategory?.id ?? rule.categoryId,
    categoryName: matchedCategory?.name ?? rule.categoryName,
    brandId: matchedBrand?.id ?? rule.brandId,
    brandName: matchedBrand?.name ?? rule.brandName,
    minPrice: minPrice ?? rule.minPrice,
    maxPrice: maxPrice ?? rule.maxPrice,
    attributes: attributes.length ? attributes : rule.attributes,
    sortBy,
  }
}
function toQuery(parsed: ParsedSearch): ProductListQuery {
  return {
    keyword: parsed.keyword || undefined,
    categoryId: parsed.categoryId ?? undefined,
    brandId: parsed.brandId ?? undefined,
    minPrice: parsed.minPrice ?? undefined,
    maxPrice: parsed.maxPrice ?? undefined,
    attributes: parsed.attributes.length ? parsed.attributes : undefined,
    sortBy: parsed.sortBy,
  }
}

/**
 * 逐级放宽：保持「用户本意」的前提下，宁可少筛一点也不给零结果。
 * 顺序按「最可能是模型多想」的条件排：属性 → 品牌 → 类目 → 价格。
 */
function relaxationSteps(parsed: ParsedSearch): { drop: string; next: ParsedSearch }[] {
  const steps: { drop: string; next: ParsedSearch }[] = []
  let current = parsed
  if (current.attributes.length) {
    current = { ...current, attributes: [] }
    steps.push({ drop: 'attribute', next: current })
  }
  if (current.brandId) {
    current = { ...current, brandId: null, brandName: '' }
    steps.push({ drop: 'brand', next: current })
  }
  if (current.categoryId) {
    current = { ...current, categoryId: null, categoryName: '' }
    steps.push({ drop: 'category', next: current })
  }
  if (current.minPrice !== null || current.maxPrice !== null) {
    current = { ...current, minPrice: null, maxPrice: null }
    steps.push({ drop: 'price', next: current })
  }
  return steps
}

function buildChips(parsed: ParsedSearch): SearchChip[] {
  const chips: SearchChip[] = []
  if (parsed.keyword) chips.push({ field: 'keyword', label: `「${parsed.keyword}」`, value: parsed.keyword })
  if (parsed.categoryName) {
    chips.push({ field: 'category', label: parsed.categoryName, value: String(parsed.categoryId ?? '') })
  }
  if (parsed.brandName) {
    chips.push({ field: 'brand', label: parsed.brandName, value: String(parsed.brandId ?? '') })
  }
  if (parsed.minPrice !== null && parsed.maxPrice !== null) {
    chips.push({ field: 'price', label: `¥${parsed.minPrice}-${parsed.maxPrice}`, value: 'range' })
  } else if (parsed.maxPrice !== null) {
    chips.push({ field: 'price', label: `≤ ¥${parsed.maxPrice}`, value: 'max' })
  } else if (parsed.minPrice !== null) {
    chips.push({ field: 'price', label: `≥ ¥${parsed.minPrice}`, value: 'min' })
  }
  for (const attribute of parsed.attributes) {
    chips.push({ field: 'attribute', label: attribute, value: attribute })
  }
  if (parsed.sortBy !== 'default') {
    const label =
      { priceAsc: '价格从低到高', priceDesc: '价格从高到低', sales: '销量优先', new: '最新上架', default: '综合' }[
        parsed.sortBy
      ] ?? '综合'
    chips.push({ field: 'sort', label, value: parsed.sortBy })
  }
  return chips
}

/* -------------------------------- 埋点 ---------------------------------- */

async function recordSearchLog(
  query: string,
  parsed: ParsedSearch,
  resultCount: number,
  userId: number | null,
): Promise<void> {
  try {
    await SearchLog.create({
      keyword: query.slice(0, 80),
      parsedJson: parsed,
      resultCount,
      userId,
      scene: 'search',
    })
  } catch (error) {
    console.error('[ai] 搜索埋点写入失败', error)
  }
}

/** 热门搜索：近 7 天埋点聚合；无数据时回退到销量最高的商品名，避免首屏空白 */
export async function hotKeywords(limit = 8): Promise<{ keyword: string; count: number }[]> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const rows = (await sequelize.query(
    `SELECT keyword, COUNT(*) AS times
       FROM search_logs
      WHERE created_at >= :since AND CHAR_LENGTH(keyword) BETWEEN 2 AND 40
      GROUP BY keyword
      ORDER BY times DESC, MAX(created_at) DESC
      LIMIT :limit`,
    { replacements: { since, limit }, type: QueryTypes.SELECT },
  )) as unknown as { keyword: string; times: number | string }[]

  const items = rows.map((row) => ({ keyword: row.keyword, count: Number(row.times ?? 0) }))
  if (items.length) return items

  const products = await Product.findAll({
    where: { status: 1 },
    attributes: ['name'],
    order: [['salesCount', 'DESC']],
    limit,
  })
  return products.map((product) => ({ keyword: product.name, count: 0 }))
}

/* ------------------------------- 主流程 --------------------------------- */

export interface ParseSearchInput {
  query: string
  userId?: number | null
  /** 只解析不查库（评测脚本用，省一次 count 查询） */
  skipCount?: boolean
  /** 评测时关闭缓存，否则延迟与命中率都不真实 */
  noCache?: boolean
  signal?: AbortSignal
}

export async function parseSearchQuery(input: ParseSearchInput): Promise<SearchParseResult> {
  const startedAt = Date.now()
  const query = normalizeText(input.query)
  const hints = await loadHints()
  const rule = ruleParse(query, hints)
  const timeoutMs = config.ai.searchParseTimeoutMs

  let parsed = rule
  let degraded = true
  let fallbackReason: string | null = null
  let mode: 'deepseek' | 'mock' = 'mock'

  if (!query) {
    return {
      query,
      parsed,
      chips: [],
      degraded: true,
      fallbackReason: 'empty_query',
      relaxed: [],
      resultCount: 0,
      latencyMs: Date.now() - startedAt,
      timeoutMs,
      mode,
    }
  }

  const enabled = await isScenarioEnabled('search_parse', input.userId ?? undefined)
  if (!enabled) {
    fallbackReason = 'disabled'
  } else {
    const categoryNames = hints.categories.map((c) => c.name).join(' / ') || '（暂无类目）'
    const brandNames = hints.brands.map((b) => b.name).join(' / ') || '（暂无品牌）'
    const result = await runAiTask<ModelParse>({
      module: 'search',
      scenario: 'search_parse',
      subjectId: input.userId ?? null,
      actor: { role: 'user', userId: input.userId ?? undefined },
      system: `你是电商搜索的查询理解模块，把用户的搜索口语翻译成检索参数，只输出 JSON。
可选类目（必须与列表完全一致，选不到就填空字符串）：${categoryNames}
可选品牌（必须与列表完全一致，选不到就填空字符串）：${brandNames}
输出字段：{"keyword":"商品关键词","category":"类目名称或空字符串","brand":"品牌名称或空字符串","minPrice":数字或null,"maxPrice":数字或null,"attributes":["规格词"],"sortBy":"default|sales|priceAsc|priceDesc|new"}
规则：
1. keyword 用用户原话里的商品词，不要编造品牌或商品名；可以为空字符串。
2. 价格只填数字（元），用户没提就填 null；不要说「大约」。
3. attributes 只放用户明确提到的规格（颜色、尺码、材质等），最多 3 个。
4. 不确定的字段一律留空，不要猜。`,
      messages: [{ role: 'user', content: query }],
      schema: modelSchema,
      temperature: 0,
      maxTokens: 200,
      timeoutMs,
      signal: input.signal,
      cache: input.noCache ? undefined : { keyParts: [query] },
      fallback: () => null,
    })

    mode = aiMode().mode
    if (result.ok && result.data) {
      parsed = normalizeParse(result.data, rule, hints, query)
      degraded = false
    } else {
      parsed = rule
      fallbackReason = result.fallbackReason ?? 'unknown'
      degraded = true
    }
  }

  // 逐级放宽，直到有结果或没有可放宽的条件
  let relaxed: string[] = []
  let resultCount = 0
  if (!input.skipCount) {
    resultCount = await countProducts(toQuery(parsed))
    if (resultCount === 0) {
      const dropped: string[] = []
      for (const step of relaxationSteps(parsed)) {
        dropped.push(step.drop)
        const count = await countProducts(toQuery(step.next))
        if (count > 0) {
          parsed = step.next
          relaxed = dropped
          resultCount = count
          break
        }
      }
    }
    await recordSearchLog(query, parsed, resultCount, input.userId ?? null)
  }

  return {
    query,
    parsed,
    chips: buildChips(parsed),
    degraded,
    fallbackReason,
    relaxed,
    resultCount,
    latencyMs: Date.now() - startedAt,
    timeoutMs,
    mode,
  }
}

/* --------------------------- mock 场景话术 --------------------------- */

registerMockScenario('search_parse', ({ question }) => {
  const emptyHints: Hints = { categories: [], brands: [] }
  const parsed = ruleParse(question, emptyHints)
  return JSON.stringify({
    keyword: parsed.keyword,
    category: '',
    brand: '',
    minPrice: parsed.minPrice,
    maxPrice: parsed.maxPrice,
    attributes: [],
    sortBy: parsed.sortBy,
  })
})
