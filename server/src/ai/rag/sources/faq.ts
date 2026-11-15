import { Faq } from '../../../models'
import { registerSource } from './registry'

/** 常见问题：帮助中心维护的问答对 */
registerSource({
  type: 'faq',
  label: '常见问题',
  async load() {
    const rows = await Faq.findAll({ where: { status: 1 } })
    return rows.map((faq) => ({
      sourceId: Number(faq.id),
      title: `常见问题 · ${faq.category}：${faq.question}`,
      content: `问：${faq.question}\n答：${faq.answer ?? '暂未填写答案'}`,
    }))
  },
})
