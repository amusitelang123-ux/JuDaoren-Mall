/**
 * 知识源注册表（改进方向 §3.2 步骤 3）。
 *
 * 旧实现把 FAQ / 公告 / 物流 / 运费 / 规则写死在 syncKnowledgeBase 的分组对象里，
 * 每加一类数据都要改一个 700 行的服务。现在每个来源是一个独立文件，
 * 只要 `registerSource()` 一次，同步与检索自动生效。
 */

export interface KnowledgeItem {
  /** 来源表主键；平台规则这类无表来源用固定序号 */
  sourceId: number
  title: string
  content: string
}

export interface KnowledgeSource {
  /** 写入 ai_kb_chunks.source_type 的值 */
  type: string
  /** 后台展示用的中文名 */
  label: string
  /** 是否默认进入检索语料；false 表示只同步不检索（如商品卖点） */
  searchable?: boolean
  load(): Promise<KnowledgeItem[]>
}

const sources = new Map<string, KnowledgeSource>()

export function registerSource(source: KnowledgeSource): void {
  sources.set(source.type, source)
}

export function listSources(): KnowledgeSource[] {
  return [...sources.values()]
}

export function getSource(type: string): KnowledgeSource | undefined {
  return sources.get(type)
}

export function clearSources(): void {
  sources.clear()
}
