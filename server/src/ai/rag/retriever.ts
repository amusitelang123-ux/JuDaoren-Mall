import { AiKbChunk } from '../../models'
import { syncKnowledgeBase } from './sync'

/**
 * 词法检索（BM25）。
 *
 * 与旧 aiKnowledgeService.searchKnowledge 的实现等价，搬进 rag/ 之后：
 * - `tokenize()` 对外导出，商品重排、问大家相似问都能复用同一套中文切分；
 * - 索引只包含 `searchable !== false` 的知识源，商品不进来（改进方向 §4 A3 的取舍）。
 */

const CACHE_TTL_MS = 60_000
const K1 = 1.2
const B = 0.75
/** 低于该分数视为未命中，交给模型说明「没有查到」并建议转人工 */
const MIN_SCORE = 1.6

const STOPWORDS = new Set([
  '什么',
  '怎么',
  '可以',
  '我的',
  '请问',
  '一下',
  '这个',
  '那个',
  '是否',
  '如何',
  '多久',
  '哪里',
  '为什',
  '么样',
  '能不',
  '帮我',
  '你们',
  '咱们',
  '还有',
])

export interface KnowledgeHit {
  chunkId: number
  sourceType: string
  sourceId: number | null
  title: string
  content: string
  score: number
  snippet: string
}

interface KnowledgeDoc {
  chunkId: number
  sourceType: string
  sourceId: number | null
  title: string
  content: string
  tf: Map<string, number>
  length: number
}

interface KnowledgeIndex {
  docs: KnowledgeDoc[]
  idf: Map<string, number>
  avgdl: number
  at: number
}

let index: KnowledgeIndex | null = null

/** 中文二元组 + 英文/数字词；过滤无意义二元组 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const normalized = (text ?? '').toLowerCase()

  for (const match of normalized.matchAll(/[a-z][a-z0-9]{1,}/g)) tokens.push(match[0])
  for (const run of normalized.match(/[\u4e00-\u9fa5]+/g) ?? []) {
    if (run.length === 1) continue
    for (let i = 0; i < run.length - 1; i += 1) {
      const bigram = run.slice(i, i + 2)
      if (!STOPWORDS.has(bigram)) tokens.push(bigram)
    }
  }
  return tokens
}

export function topKeywords(text: string, limit = 8): string {
  const tf = new Map<string, number>()
  for (const token of tokenize(text)) tf.set(token, (tf.get(token) ?? 0) + 1)
  return [...tf.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([token]) => token)
    .join(' ')
    .slice(0, 500)
}

function buildDocs(rows: AiKbChunk[]): KnowledgeDoc[] {
  return rows.map((row) => {
    const titleTokens = tokenize(row.title)
    const contentTokens = tokenize(`${row.title} ${row.content}`)
    const tf = new Map<string, number>()
    // 标题命中权重加倍，避免正文里的长句淹没关键主题
    for (const token of titleTokens) tf.set(token, (tf.get(token) ?? 0) + 2)
    for (const token of contentTokens) tf.set(token, (tf.get(token) ?? 0) + 1)

    let length = 0
    tf.forEach((value) => {
      length += value
    })

    return {
      chunkId: Number(row.id),
      sourceType: row.sourceType,
      sourceId: row.sourceId === null || row.sourceId === undefined ? null : Number(row.sourceId),
      title: row.title,
      content: row.content,
      tf,
      length: Math.max(1, length),
    }
  })
}

function buildIndex(docs: KnowledgeDoc[]): KnowledgeIndex {
  const df = new Map<string, number>()
  let totalLength = 0
  for (const doc of docs) {
    totalLength += doc.length
    for (const token of doc.tf.keys()) df.set(token, (df.get(token) ?? 0) + 1)
  }

  const idf = new Map<string, number>()
  const total = docs.length
  df.forEach((count, token) => {
    idf.set(token, Math.log(1 + (total - count + 0.5) / (count + 0.5)))
  })

  return { docs, idf, avgdl: total ? totalLength / total : 1, at: Date.now() }
}

async function ensureIndex(): Promise<KnowledgeIndex> {
  if (index && Date.now() - index.at < CACHE_TTL_MS) return index

  let rows = await AiKbChunk.findAll({ where: { status: 1 } })
  if (!rows.length) {
    await syncKnowledgeBase()
    rows = await AiKbChunk.findAll({ where: { status: 1 } })
  }
  index = buildIndex(buildDocs(rows))
  return index
}

/** 知识库内容变化后调用，强制下次检索重建索引 */
export function invalidateIndex(): void {
  index = null
}

/** BM25 检索；无命中返回空数组，由调用方决定「转人工」话术 */
export async function searchKnowledge(question: string, limit = 4): Promise<KnowledgeHit[]> {
  const queryTokens = [...new Set(tokenize(question))]
  if (!queryTokens.length) return []

  const current = await ensureIndex()
  if (!current.docs.length) return []

  const scored = current.docs.map((doc) => {
    let score = 0
    for (const token of queryTokens) {
      const tf = doc.tf.get(token)
      if (!tf) continue
      const idf = current.idf.get(token) ?? 0
      const denom = tf + K1 * (1 - B + (B * doc.length) / current.avgdl)
      score += idf * ((tf * (K1 + 1)) / denom)
    }
    return { doc, score }
  })

  return scored
    .filter((item) => item.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ doc, score }) => ({
      chunkId: doc.chunkId,
      sourceType: doc.sourceType,
      sourceId: doc.sourceId,
      title: doc.title,
      content: doc.content,
      score: Math.round(score * 100) / 100,
      snippet: doc.content.slice(0, 160),
    }))
}

/** 相似文本检索（问大家 / 坐席辅助复用）：不设 MIN_SCORE 硬阈值，按分数返回 */
export async function searchSimilar(
  text: string,
  options: { limit?: number; sourceTypes?: string[] } = {},
): Promise<KnowledgeHit[]> {
  const limit = options.limit ?? 3
  const queryTokens = [...new Set(tokenize(text))]
  if (!queryTokens.length) return []

  const current = await ensureIndex()
  const docs = options.sourceTypes?.length
    ? current.docs.filter((doc) => options.sourceTypes!.includes(doc.sourceType))
    : current.docs
  if (!docs.length) return []

  return docs
    .map((doc) => {
      let score = 0
      for (const token of queryTokens) {
        const tf = doc.tf.get(token)
        if (!tf) continue
        const idf = current.idf.get(token) ?? 0
        const denom = tf + K1 * (1 - B + (B * doc.length) / current.avgdl)
        score += idf * ((tf * (K1 + 1)) / denom)
      }
      return { doc, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ doc, score }) => ({
      chunkId: doc.chunkId,
      sourceType: doc.sourceType,
      sourceId: doc.sourceId,
      title: doc.title,
      content: doc.content,
      score: Math.round(score * 100) / 100,
      snippet: doc.content.slice(0, 160),
    }))
}

/** 仅供测试/后台观察：当前索引规模 */
export async function knowledgeStats(): Promise<{ chunks: number; indexedAt: string | null }> {
  const chunks = await AiKbChunk.count({ where: { status: 1 } })
  return { chunks, indexedAt: index ? new Date(index.at).toISOString() : null }
}
