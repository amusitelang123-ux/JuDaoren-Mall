import { AI_POLICIES } from '../../../services/aiPolicies'
import { registerSource } from './registry'

/** 平台规则：写在代码里的政策条款，无对应数据表，用固定序号作为 sourceId */
registerSource({
  type: 'policy',
  label: '平台规则',
  async load() {
    return AI_POLICIES.map((policy, index) => ({
      sourceId: index + 1,
      title: `平台规则：${policy.title}`,
      content: policy.content,
    }))
  },
})
