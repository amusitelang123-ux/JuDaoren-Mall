import type { Category } from '@/api/types'

/** 分类图标元数据：图标地址 + 首页圆形底底色 */
export interface CategoryIconMeta {
  src: string
  tint: string
}

type CategoryLike = Pick<Category, 'id' | 'name' | 'icon'>

type IconKey =
  | 'digital'
  | 'fashion'
  | 'home'
  | 'food'
  | 'beauty'
  | 'baby'
  | 'sports'
  | 'books'
  | 'all'

const ICONS: Record<IconKey, { file: string; tint: string }> = {
  digital: { file: 'digital.svg', tint: '#eef4ff' },
  fashion: { file: 'fashion.svg', tint: '#fff0f5' },
  home: { file: 'home.svg', tint: '#fff7e8' },
  food: { file: 'food.svg', tint: '#eff9f0' },
  beauty: { file: 'beauty.svg', tint: '#fff0f4' },
  baby: { file: 'baby.svg', tint: '#fff4ec' },
  sports: { file: 'sports.svg', tint: '#edf9fb' },
  books: { file: 'books.svg', tint: '#f5f1ff' },
  all: { file: 'all.svg', tint: '#f1f5f9' },
}

/** 后端种子分类 id；名称映射用于 id 变化或自行新增分类时的兜底 */
const BY_ID: Partial<Record<number, IconKey>> = {
  101: 'digital',
  102: 'fashion',
  103: 'home',
  104: 'food',
  105: 'beauty',
  106: 'baby',
  107: 'sports',
  108: 'books',
}

const BY_NAME: Record<string, IconKey> = {
  all: 'all',
  数码电子: 'digital',
  服饰鞋包: 'fashion',
  家居生活: 'home',
  食品生鲜: 'food',
  美妆个护: 'beauty',
  母婴玩具: 'baby',
  运动户外: 'sports',
  图书文娱: 'books',
  全部商品: 'all',
  全部分类: 'all',
}

function assetUrl(file: string): string {
  return `${import.meta.env.BASE_URL}category-icons/${file}`
}

function meta(key: IconKey): CategoryIconMeta {
  const icon = ICONS[key]
  return { src: assetUrl(icon.file), tint: icon.tint }
}

function isImageSource(icon: string): boolean {
  return /\.(svg|png|webp|jpe?g|gif|avif)(?:\?.*)?$/i.test(icon)
}

/**
 * 解析分类对应的本地 SVG 图标。
 * 未收录的分类返回 null，由调用方回退到后端下发的 emoji 或图片地址。
 */
export function getCategoryIcon(category?: CategoryLike | null): CategoryIconMeta | null {
  if (!category) return null

  const key = BY_ID[category.id] ?? BY_NAME[category.name?.trim() ?? '']
  if (key) return meta(key)

  const icon = category.icon?.trim() ?? ''
  if (!isImageSource(icon)) return null

  let src = icon
  if (!/^(?:https?:)?\/\//i.test(icon) && !icon.startsWith('data:') && !icon.startsWith('/')) {
    const file = icon.replace(/^\/?category-icons\//, '')
    src = assetUrl(file)
  }
  return { src, tint: '#f1f5f9' }
}

/** 解析非分类专用图标（如「全部商品」） */
export function getNamedCategoryIcon(name: string): CategoryIconMeta | null {
  const key = BY_NAME[name.trim()]
  return key ? meta(key) : null
}

/** 首页分类圆形底的底色；未知分类使用中性底色 */
export function getCategoryTint(category?: CategoryLike | null): string {
  return getCategoryIcon(category)?.tint ?? '#f0f2f2'
}
