import { Notice } from '../../../models'
import { stripHtml } from '../../../utils/helpers'
import { registerSource } from './registry'

/** 平台公告：正文去标签后截断，避免单条公告撑爆切片 */
registerSource({
  type: 'notice',
  label: '平台公告',
  async load() {
    const rows = await Notice.findAll({ where: { status: 1 } })
    return rows.map((notice) => {
      const body = stripHtml(notice.content ?? '')
      return {
        sourceId: Number(notice.id),
        title: `公告：${notice.title}`,
        content: `${notice.title}\n${body}`.slice(0, 2000),
      }
    })
  },
})
