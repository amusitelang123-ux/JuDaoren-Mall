import { FreightTemplate } from '../../../models'
import { registerSource } from './registry'

/** 运费模板：包邮门槛与基础运费 */
registerSource({
  type: 'freight',
  label: '运费模板',
  async load() {
    const rows = await FreightTemplate.findAll({ where: { status: 1 } })
    return rows.map((template) => ({
      sourceId: Number(template.id),
      title: `运费模板：${template.name}${template.isDefault ? '（默认）' : ''}`,
      content: `满 ${Number(template.freeAmount)} 元包邮；未达门槛收取 ${Number(template.baseFreight)} 元运费。`,
    }))
  },
})
