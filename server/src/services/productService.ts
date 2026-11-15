import { Op, type Order as SequelizeOrder, type WhereOptions } from 'sequelize'
import {
  Banner,
  Brand,
  Category,
  Product,
  ProductAttribute,
  ProductComment,
  ProductImage,
  ProductSku,
  SeckillActivity,
  SeckillProduct,
  User,
} from '../models'
import {
  toBannerDto,
  toCommentDto,
  toProductDto,
  toSeckillDto,
  type ProductWithRelations,
} from '../utils/serializers'
import { getActiveFloorConfigs } from './homeFloorService'

const productInclude = [
  { model: ProductSku, as: 'skus' },
  { model: ProductImage, as: 'imageList' },
  { model: ProductAttribute, as: 'attributes' },
  {
    model: Category,
    as: 'category',
    include: [{ model: Category, as: 'parent' }],
  },
  { model: Brand, as: 'brand' },
]

export interface ProductListQuery {
  categoryId?: number
  keyword?: string
  brandId?: number
  minPrice?: number
  maxPrice?: number
  /** 属性关键词（如「白色」「L」），按 product_attributes 的 name/value 模糊匹配，多个之间取并集 */
  attributes?: string[]
  sortBy?: 'default' | 'sales' | 'priceAsc' | 'priceDesc' | 'new'
  page?: number
  pageSize?: number
}

export async function listCategories() {
  const rows = await Category.findAll({ where: { status: 1 }, order: [['sort', 'ASC']] })
  return rows.map((c) => ({
    id: c.id,
    parentId: c.parentId,
    name: c.name,
    level: c.level as 1 | 2,
    icon: c.icon ?? '',
    sort: c.sort,
  }))
}

export async function listBrands() {
  const rows = await Brand.findAll({ where: { status: 1 }, order: [['sort', 'ASC']] })
  return rows.map((b) => ({ id: b.id, name: b.name, logo: b.logo ?? '' }))
}

async function resolveCategoryIds(categoryId: number): Promise<number[]> {
  const category = await Category.findByPk(categoryId)
  if (!category) return [categoryId]
  if (category.level === 1) {
    const children = await Category.findAll({ where: { parentId: category.id }, attributes: ['id'] })
    return [category.id, ...children.map((c) => c.id)]
  }
  return [category.id]
}

function buildOrder(sortBy: ProductListQuery['sortBy']): SequelizeOrder {
  switch (sortBy) {
    case 'sales':
      return [['salesCount', 'DESC']]
    case 'priceAsc':
      return [['priceMin', 'ASC']]
    case 'priceDesc':
      return [['priceMin', 'DESC']]
    case 'new':
      return [['id', 'DESC']]
    default:
      return [
        ['sort', 'DESC'],
        ['salesCount', 'DESC'],
      ]
  }
}

/**
 * 关键词召回只负责「圈出候选」，排序在 Node 内做：
 *   0.6 × 文本相关（name 权重最高） + 0.3 × 属性命中 + 0.1 × 销量/评分
 *
 * 为什么不用 MATCH ... AGAINST：本项目 SKU 仅百级，
 * 加 FULLTEXT(ngram) 索引带来的收益抵不上一个新组件的认知成本；
 * 语料过千时再把 buildWhere 的 LIKE 换成 MATCH，其余打分逻辑不用动。
 */
const RERANK_CANDIDATE_LIMIT = 200

/**
 * 关键词拆词：按「中英文/数字边界」切分，再逐词做 LIKE 并集匹配。
 *
 * 必要性：查询理解经常产出「白色T恤」这种中英混排词，直接 `LIKE %白色T恤%`
 * 会因为商品名写的是「纯棉 T 恤」而漏召回。拆成「白色」「T恤」再取并集，
 * 相关度交给后面的内存重排，召回率明显好于整串匹配。
 */
function splitKeywordTerms(keyword: string): string[] {
  const terms = new Set<string>()
  for (const part of keyword.split(/\s+/)) {
    for (const run of part.match(/[A-Za-z0-9]+|[\u4e00-\u9fa5]+/g) ?? []) {
      if (run.length >= 2) terms.add(run)
    }
  }
  return [...terms].slice(0, 4)
}

function keywordScore(product: Product, terms: string[]): { text: number; attribute: number } {
  if (!terms.length) return { text: 0, attribute: 0 }
  const name = (product.name ?? '').toLowerCase()
  const subtitle = (product.subtitle ?? '').toLowerCase()
  const attributes = ((product.get('attributes') as ProductAttribute[] | null) ?? [])
    .map((attr) => `${attr.name} ${attr.value}`)
    .join(' ')
    .toLowerCase()
  const brand = ((product.get('brand') as Brand | null)?.name ?? '').toLowerCase()

  let text = 0
  let attribute = 0
  for (const term of terms) {
    const token = term.toLowerCase()
    if (name.includes(token)) text += 10
    if (subtitle.includes(token)) text += 4
    if (brand.includes(token)) text += 2
    if (attributes.includes(token)) attribute += 3
  }
  return { text, attribute }
}

function popularityScore(product: Product): number {
  const sales = Number(product.salesCount ?? 0)
  const score = Number(product.avgScore ?? 0)
  // 销量做对数压缩，避免头部商品吃掉全部权重
  return Math.min(1, Math.log10(1 + sales) / 4) * 0.7 + Math.min(1, score / 5) * 0.3
}

interface ProductQueryResult {
  rows: Product[]
  total: number
  page: number
  pageSize: number
}

async function queryProducts(query: ProductListQuery): Promise<ProductQueryResult> {
  const page = Math.max(1, query.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 12))

  const conditions: WhereOptions[] = [{ status: 1 }]
  if (query.categoryId) {
    const ids = await resolveCategoryIds(query.categoryId)
    conditions.push({ categoryId: { [Op.in]: ids } })
  }
  if (query.brandId) conditions.push({ brandId: query.brandId })
  if (query.minPrice !== undefined) conditions.push({ priceMin: { [Op.gte]: query.minPrice } })
  if (query.maxPrice !== undefined) conditions.push({ priceMin: { [Op.lte]: query.maxPrice } })

  // 属性过滤：先用一次轻量查询拿到候选商品 id，再回主表过滤。
  // 多个属性词之间取并集（而不是交集），避免「白色 + 纯棉」直接筛成零结果。
  if (query.attributes?.length) {
    const attrWhere = query.attributes.filter(Boolean).slice(0, 3).map((attr) => ({
      [Op.or]: [
        { name: { [Op.like]: `%${attr}%` } },
        { value: { [Op.like]: `%${attr}%` } },
      ],
    }))
    const attrRows = await ProductAttribute.findAll({
      where: { [Op.or]: attrWhere } as WhereOptions,
      attributes: ['productId'],
      limit: 500,
      raw: true,
    })
    const ids = [...new Set(attrRows.map((row) => Number(row.productId)))]
    conditions.push({ id: { [Op.in]: ids.length ? ids : [-1] } })
  }

  const keyword = query.keyword?.trim()
  if (keyword) {
    // 关键词可能被查询理解拆成多个词（如「露营用 帐篷」「白色T恤」）：
    // 多个词之间取并集，避免一个多余的条件把结果筛成 0；相关度交给后面的内存重排。
    const terms = splitKeywordTerms(keyword)
    const likes = (terms.length ? terms : [keyword]).slice(0, 4).map((term) => ({
      [Op.or]: [
        { name: { [Op.like]: `%${term}%` } },
        { subtitle: { [Op.like]: `%${term}%` } },
      ],
    }))
    conditions.push((likes.length > 1 ? { [Op.or]: likes } : likes[0]) as WhereOptions)
  }

  const where: WhereOptions = { [Op.and]: conditions }
  const order = buildOrder(query.sortBy)

  if (!keyword) {
    const { rows, count } = await Product.findAndCountAll({
      where,
      include: productInclude,
      order,
      limit: pageSize,
      offset: (page - 1) * pageSize,
      distinct: true,
    })
    return { rows, total: count, page, pageSize }
  }

  // 关键词检索：候选集在内存里打分排序，保证「相关度」优先于「上架时间」
  const candidates = await Product.findAll({
    where,
    include: productInclude,
    order,
    limit: RERANK_CANDIDATE_LIMIT,
  })
  const terms = splitKeywordTerms(keyword)
  const scored = candidates.map((product) => {
    const { text, attribute } = keywordScore(product, terms)
    const combined = 0.6 * text + 0.3 * attribute + 0.1 * popularityScore(product) * 10
    return { product, score: combined }
  })

  if (query.sortBy === 'priceAsc' || query.sortBy === 'priceDesc' || query.sortBy === 'new') {
    // 用户显式指定价格/上架排序时，尊重用户选择，只做关键词过滤
    scored.sort((a, b) => {
      if (query.sortBy === 'priceAsc') return Number(a.product.priceMin) - Number(b.product.priceMin)
      if (query.sortBy === 'priceDesc') return Number(b.product.priceMin) - Number(a.product.priceMin)
      return Number(b.product.id) - Number(a.product.id)
    })
  } else {
    scored.sort((a, b) => b.score - a.score || Number(b.product.salesCount) - Number(a.product.salesCount))
  }

  const start = (page - 1) * pageSize
  return {
    rows: scored.slice(start, start + pageSize).map((item) => item.product),
    total: scored.length,
    page,
    pageSize,
  }
}

export async function listProducts(query: ProductListQuery) {
  const { rows, total, page, pageSize } = await queryProducts(query)
  return {
    list: rows.map((p) => toProductDto(p as unknown as ProductWithRelations)),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  }
}

/** 只取命中数量：搜索解析用它记录「是否零结果」，不把整页数据搬出来 */
export async function countProducts(query: ProductListQuery): Promise<number> {
  const { total } = await queryProducts({ ...query, page: 1, pageSize: 1 })
  return total
}

export interface ProductBrief {
  id: number
  name: string
  subtitle: string
  price: string
  salesCount: number
  avgScore: number
  stock: number
  category: string
  brand: string
}

function toBrief(product: Product): ProductBrief {
  const category = product.get('category') as Category | null
  return {
    id: Number(product.id),
    name: product.name,
    subtitle: product.subtitle ?? '',
    price: `${Number(product.priceMin ?? 0).toFixed(2)}`,
    salesCount: Number(product.salesCount ?? 0),
    avgScore: Number(Number(product.avgScore ?? 0).toFixed(1)),
    stock: Number(product.totalStock ?? 0),
    category: category?.name ?? '',
    brand: (product.get('brand') as Brand | null)?.name ?? '',
  }
}

/** 供 AI 工具使用：按条件取少量商品摘要（不把 detail_html 搬进上下文） */
export async function searchProductBriefs(
  query: ProductListQuery,
  limit = 5,
): Promise<{ items: ProductBrief[]; total: number }> {
  const { rows, total } = await queryProducts({
    ...query,
    page: 1,
    pageSize: Math.min(10, Math.max(1, limit)),
  })
  return { items: rows.map(toBrief), total }
}

/** 供 AI 工具使用：单商品的参数/规格/评论摘要，全部为结构化短文本 */
export async function getProductAiProfile(productId: number) {
  const product = await Product.findOne({
    where: { id: productId, status: 1 },
    include: [
      { model: ProductAttribute, as: 'attributes' },
      { model: ProductSku, as: 'skus' },
      { model: Category, as: 'category' },
      { model: Brand, as: 'brand' },
    ],
  })
  if (!product) return null

  const attributes = ((product.get('attributes') as ProductAttribute[] | null) ?? [])
    .slice(0, 12)
    .map((attr) => `${attr.name}：${attr.value}`)
  const skus = ((product.get('skus') as ProductSku[] | null) ?? [])
    .filter((sku) => sku.status === 1)
    .slice(0, 12)
    .map((sku) => ({
      skuId: Number(sku.id),
      spec: sku.specText ?? '',
      price: Number(sku.price).toFixed(2),
      stock: Number(sku.stock ?? 0),
    }))

  const comments = await ProductComment.findAll({
    where: { productId, status: 1 },
    attributes: ['score', 'content'],
    order: [['id', 'DESC']],
    limit: 20,
  })
  const good = comments.filter((c) => Number(c.score) >= 4).slice(0, 3).map((c) => c.content.slice(0, 60))
  const bad = comments.filter((c) => Number(c.score) <= 3).slice(0, 3).map((c) => c.content.slice(0, 60))

  return {
    ...toBrief(product),
    attributes,
    skus,
    commentCount: Number(product.commentCount ?? 0),
    goodPoints: good,
    badPoints: bad,
  }
}

export async function getProduct(id: number) {
  const product = await Product.findOne({ where: { id, status: 1 }, include: productInclude })
  if (!product) return null
  return toProductDto(product as unknown as ProductWithRelations)
}

export async function getProductComments(productId: number) {
  const rows = await ProductComment.findAll({
    where: { productId, status: 1 },
    include: [{ model: User, as: 'user' }],
    order: [['id', 'DESC']],
    limit: 50,
  })
  return rows.map((c) => toCommentDto(c as unknown as Parameters<typeof toCommentDto>[0]))
}

export async function getRecommendProducts(excludeId: number, size = 4) {
  const rows = await Product.findAll({
    where: { status: 1, id: { [Op.ne]: excludeId } },
    include: productInclude,
    order: [['salesCount', 'DESC']],
    limit: size,
  })
  return rows.map((p) => toProductDto(p as unknown as ProductWithRelations))
}

export async function getHomeData() {
  const [banners, tops] = await Promise.all([
    Banner.findAll({ where: { status: 1, position: 'home_top' }, order: [['sort', 'ASC']] }),
    Category.findAll({ where: { status: 1, level: 1 }, order: [['sort', 'ASC']] }),
  ])

  const now = new Date()
  const activity = await SeckillActivity.findOne({
    where: { status: 1, startTime: { [Op.lte]: now }, endTime: { [Op.gte]: now } },
  })
  let seckills: ReturnType<typeof toSeckillDto>[] = []
  if (activity) {
    const rows = await SeckillProduct.findAll({
      where: { activityId: activity.id },
      include: [{ model: Product, as: 'product' }],
      order: [['sort', 'ASC']],
      limit: 8,
    })
    seckills = rows.map((r) => toSeckillDto(r as unknown as Parameters<typeof toSeckillDto>[0]))
  }

  const recommendRows = await Product.findAll({
    where: { status: 1, isRecommend: 1 },
    include: productInclude,
    order: [['sort', 'DESC']],
    limit: 10,
  })

  const floors: {
    title: string
    subtitle: string
    categoryId: number | null
    products: ReturnType<typeof toProductDto>[]
  }[] = []
  // A-44：优先使用后台人工编排的楼层；未配置时回退为「按一级分类自动生成」
  const configuredFloors = await getActiveFloorConfigs()
  if (configuredFloors.length) {
    const allIds = [...new Set(configuredFloors.flatMap((f) => f.productIds))]
    const rows = allIds.length
      ? await Product.findAll({
          where: { id: { [Op.in]: allIds }, status: 1 },
          include: productInclude,
        })
      : []
    const productMap = new Map(rows.map((p) => [Number(p.id), p]))
    for (const config of configuredFloors) {
      const products = config.productIds
        .map((id) => productMap.get(id))
        .filter((p): p is Product => Boolean(p))
        .map((p) => toProductDto(p as unknown as ProductWithRelations))
      if (!products.length) continue
      floors.push({
        title: config.title,
        subtitle: config.subtitle || '精选好物 品质保障',
        categoryId: config.categoryId,
        products,
      })
    }
  } else {
    for (const top of tops.slice(0, 4)) {
      const ids = await resolveCategoryIds(top.id)
      const products = await Product.findAll({
        where: { status: 1, categoryId: { [Op.in]: ids } },
        include: productInclude,
        order: [['salesCount', 'DESC']],
        limit: 8,
      })
      floors.push({
        title: top.name,
        subtitle: '精选好物 品质保障',
        categoryId: top.id,
        products: products.map((p) => toProductDto(p as unknown as ProductWithRelations)),
      })
    }
  }

  const categoryDto = tops.map((c) => ({
    id: c.id,
    parentId: c.parentId,
    name: c.name,
    level: c.level as 1 | 2,
    icon: c.icon ?? '',
    sort: c.sort,
  }))

  return {
    banners: banners.map(toBannerDto),
    seckills,
    categories: categoryDto,
    recommend: recommendRows.map((p) => toProductDto(p as unknown as ProductWithRelations)),
    floors,
  }
}
