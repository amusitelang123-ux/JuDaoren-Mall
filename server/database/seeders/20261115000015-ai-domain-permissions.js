'use strict'

/**
 * 第八批权限点：AI 按域拆分（改进方向 §8.2）。
 *
 * 旧的做法只有 ai:view / ai:manage 两个码，所有 AI 后台能力共用一把钥匙。
 * 场景铺开之后必须按域拆分，否则「关掉搜索理解」这种操作要连带关掉整个 AI 菜单。
 *
 * 33 ai:search    搜索查询理解（查看解析结果/热词）
 * 34 ai:marketing 营销文案生成
 * 35 ai:helpdesk  坐席辅助（归类 + 回复草稿）
 */

const PERMISSIONS = [
  {
    id: 33,
    parent_id: 31,
    name: '搜索查询理解',
    code: 'ai:search',
    type: 3,
    path: null,
    component: null,
    icon: null,
    sort: 2,
  },
  {
    id: 34,
    parent_id: 31,
    name: '营销文案生成',
    code: 'ai:marketing',
    type: 3,
    path: null,
    component: null,
    icon: null,
    sort: 3,
  },
  {
    id: 35,
    parent_id: 31,
    name: '坐席辅助',
    code: 'ai:helpdesk',
    type: 3,
    path: null,
    component: null,
    icon: null,
    sort: 4,
  },
]

const ROLE_PERMISSIONS = [
  { role_id: 3, permission_id: 33 },
  { role_id: 3, permission_id: 34 },
  { role_id: 3, permission_id: 35 },
]

module.exports = {
  async up(queryInterface) {
    const [existing] = await queryInterface.sequelize.query(
      `SELECT COUNT(*) AS total FROM permissions WHERE code IN ('ai:search','ai:marketing','ai:helpdesk')`,
    )
    if (Number(existing[0].total) > 0) {
      console.log('[seed] AI 域权限已存在，跳过')
      return
    }
    await queryInterface.bulkInsert('permissions', PERMISSIONS)
    await queryInterface.bulkInsert('role_permissions', ROLE_PERMISSIONS)
    await queryInterface.sequelize.query('ALTER TABLE `permissions` AUTO_INCREMENT = 36')
    await queryInterface.sequelize.query('ALTER TABLE `role_permissions` AUTO_INCREMENT = 33')
  },

  async down(queryInterface) {
    const ids = PERMISSIONS.map((p) => p.id)
    await queryInterface.bulkDelete('role_permissions', { permission_id: ids }, {})
    await queryInterface.bulkDelete('permissions', { id: ids }, {})
  },
}
