import { randomBytes } from 'crypto'

/** 生成 32 位以内业务单号：前缀 + 时间戳 + 随机 */
export function generateNo(prefix: string): string {
  const ts = new Date()
    .toISOString()
    .replace(/[-T:.Z]/g, '')
    .slice(0, 14)
  const rand = randomBytes(3).toString('hex').toUpperCase().slice(0, 6)
  return `${prefix}${ts}${rand}`
}

export function maskPhone(phone: string | null | undefined): string {
  if (!phone || phone.length < 7) return phone ?? ''
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function toInt(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/** 去掉 HTML 标签与实体，供知识库切片 / 摘要场景复用 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
