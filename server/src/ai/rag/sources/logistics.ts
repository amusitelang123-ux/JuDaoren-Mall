import { LogisticsCompany } from '../../../models'
import { registerSource } from './registry'

/** 合作物流公司：承运商名称与客服电话 */
registerSource({
  type: 'logistics',
  label: '物流公司',
  async load() {
    const rows = await LogisticsCompany.findAll({ where: { status: 1 } })
    return rows.map((company) => ({
      sourceId: Number(company.id),
      title: `物流公司：${company.name}`,
      content: `编码：${company.code}；客服电话：${company.phone ?? '未提供'}`,
    }))
  },
})
