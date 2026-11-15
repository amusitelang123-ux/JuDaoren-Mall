'use strict'

/**
 * AI 场景开关的 settings 默认值（改进方向 §3.3 第 7 条：三级开关）。
 *
 * .env 的 AI_SCENARIOS 是部署级开关；这里把同样的开关落一份到 settings 表，
 * 运营就能在「系统配置」里热更（30s 缓存），改完不用重启服务。
 * 规则：settings 里存在该 key 时以 settings 为准，不存在时回落到 .env。
 */

const ROWS = [
  {
    config_group: 'ai',
    config_key: 'ai.scenario.customer_service.enabled',
    config_value: '1',
    remark: '智能客服场景开关：1 开启 / 0 关闭（为空时回落到 .env 的 AI_SCENARIOS）',
  },
  {
    config_group: 'ai',
    config_key: 'ai.scenario.search_parse.enabled',
    config_value: '1',
    remark: '搜索查询理解开关：关闭后搜索只做关键词检索',
  },
  {
    config_group: 'ai',
    config_key: 'ai.scenario.marketing_copy.enabled',
    config_value: '1',
    remark: '营销文案生成开关',
  },
  {
    config_group: 'ai',
    config_key: 'ai.scenario.helpdesk_draft.enabled',
    config_value: '1',
    remark: '坐席辅助（工单归类 + 回复草稿）开关',
  },
  {
    config_group: 'ai',
    config_key: 'ai.scenario.search_parse.grayUserIds',
    config_value: '',
    remark: '灰度用户 id，逗号分隔；非空时只对这些用户开放该场景',
  },
]

module.exports = {
  async up(queryInterface) {
    const keys = ROWS.map((row) => row.config_key)
    const [existing] = await queryInterface.sequelize.query(
      `SELECT config_key FROM settings WHERE config_key IN (:keys)`,
      { replacements: { keys } },
    )
    const existingKeys = new Set(existing.map((row) => row.config_key))
    const pending = ROWS.filter((row) => !existingKeys.has(row.config_key))
    if (!pending.length) {
      console.log('[seed] AI 场景开关配置已存在，跳过')
      return
    }
    await queryInterface.bulkInsert('settings', pending)
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('settings', {
      config_key: ROWS.map((row) => row.config_key),
    })
  },
}
