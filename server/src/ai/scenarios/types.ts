/** 场景层共享的小类型，避免各场景重复声明 */

export type SearchSortBy = 'default' | 'sales' | 'priceAsc' | 'priceDesc' | 'new'

/** 文案生成场景支持的类型 */
export type CopyScene = 'product' | 'coupon' | 'notice' | 'seckill'

export interface CopyVariant {
  title: string
  subtitle: string
  body: string
  tags: string[]
}

/** 坐席辅助：工单归类 */
export type TicketCategory = '咨询' | '投诉' | '建议' | '售后'

export type TicketUrgency = 'low' | 'normal' | 'high'

export interface TicketInsight {
  category: TicketCategory
  urgency: TicketUrgency
  summary: string
  /** 建议回复草稿；人工确认后才写 reply_content */
  draft: string
}
