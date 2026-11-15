import { Op } from 'sequelize'
import { AiKbChunk } from '../../models'
import { listSources } from './sources'
import { invalidateIndex, topKeywords } from './retriever'

/**
 * 知识库同步：遍历注册表里的知识源，把内容写成切片（幂等）。
 * 与旧实现的区别只是「分组对象」换成了「注册表」，行为保持一致：
 * upsert → 删除来源已下线的切片 → 清空检索索引。
 */

let syncing: Promise<SyncResult> | null = null

export interface SyncResult {
  total: number
  byType: Record<string, number>
  syncedAt: string
}

export async function syncKnowledgeBase(): Promise<SyncResult> {
  if (syncing) return syncing

  syncing = (async () => {
    const byType: Record<string, number> = {}

    for (const source of listSources()) {
      const items = await source.load()
      byType[source.type] = items.length

      if (!items.length) {
        await AiKbChunk.destroy({ where: { sourceType: source.type } })
        continue
      }

      const rows = items.map((item) => ({
        sourceType: source.type,
        sourceId: item.sourceId,
        title: item.title.slice(0, 255),
        content: item.content,
        keywords: topKeywords(`${item.title} ${item.content}`),
        status: 1,
      }))

      await AiKbChunk.bulkCreate(rows, {
        updateOnDuplicate: ['title', 'content', 'keywords', 'status'],
      })
      await AiKbChunk.destroy({
        where: {
          sourceType: source.type,
          sourceId: { [Op.notIn]: items.map((item) => item.sourceId) },
        },
      })
    }

    const total = await AiKbChunk.count({ where: { status: 1 } })
    invalidateIndex()
    return { total, byType, syncedAt: new Date().toISOString() }
  })()

  try {
    return await syncing
  } finally {
    syncing = null
  }
}
