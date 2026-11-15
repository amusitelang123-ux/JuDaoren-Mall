import { createHash } from 'node:crypto'
import { config } from '../../config'

/**
 * 进程内结果缓存。
 *
 * FAQ 类、搜索解析类问题的重复率极高：同样的问法在演示中一天能出现几十次，
 * 按 `scenario + hash(入参)` 缓存 10 分钟即可显著降本（改进方向 §3.3 第 6 条）。
 * 单实例内存实现足够；多实例部署时应换成 Redis 并共享 TTL。
 */

interface CacheEntry {
  value: unknown
  at: number
  expiresAt: number
}

const store = new Map<string, CacheEntry>()
const MAX_ENTRIES = 500

export function cacheKey(scenario: string, parts: unknown[]): string {
  const raw = JSON.stringify(parts)
  return `${scenario}:${createHash('sha1').update(raw).digest('hex').slice(0, 24)}`
}

export function readCache<T>(key: string): T | null {
  const entry = store.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    store.delete(key)
    return null
  }
  return entry.value as T
}

export function writeCache(key: string, value: unknown, ttlMs = config.ai.cacheTtlMs): void {
  if (ttlMs <= 0) return
  if (store.size >= MAX_ENTRIES) {
    // 最简单的淘汰：删掉最早写入的 20%
    const keys = [...store.keys()].slice(0, Math.ceil(MAX_ENTRIES * 0.2))
    for (const key of keys) store.delete(key)
  }
  store.set(key, { value, at: Date.now(), expiresAt: Date.now() + ttlMs })
}

export function clearCache(): void {
  store.clear()
}

export function cacheStats(): { entries: number } {
  return { entries: store.size }
}
