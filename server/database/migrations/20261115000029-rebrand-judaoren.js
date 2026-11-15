'use strict'

/**
 * 品牌更名：小兔鲜 → 菊道人。
 *
 * 只改「站点自身」的可见名称，不动物流/支付等基础设施标识（数据库名、xtx_* 存储键、订单号前缀等）。
 * 仅当库里仍是旧名称时才改写，重复执行安全；后台已经手工改过的站点名称不会被覆盖。
 */

const OLD_NAME = '小兔鲜'
const NEW_NAME = '菊道人'

module.exports = {
  async up(queryInterface) {
    // 站点配置：名称
    await queryInterface.sequelize.query(
      `UPDATE \`settings\`
          SET \`config_value\` = :newName, \`updated_at\` = NOW()
        WHERE \`config_key\` = 'site.name'
          AND \`config_value\` = :oldName`,
      { replacements: { oldName: OLD_NAME, newName: NEW_NAME } },
    )

    // 公告正文与标题里的旧品牌名（notices 表无 updated_at 字段）
    await queryInterface.sequelize.query(
      `UPDATE \`notices\`
          SET \`title\` = REPLACE(\`title\`, :oldName, :newName),
              \`content\` = REPLACE(\`content\`, :oldName, :newName)
        WHERE \`title\` LIKE CONCAT('%', :oldName, '%')
           OR \`content\` LIKE CONCAT('%', :oldName, '%')`,
      { replacements: { oldName: OLD_NAME, newName: NEW_NAME } },
    )
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE \`settings\`
          SET \`config_value\` = :oldName, \`updated_at\` = NOW()
        WHERE \`config_key\` = 'site.name'
          AND \`config_value\` = :newName`,
      { replacements: { oldName: OLD_NAME, newName: NEW_NAME } },
    )

    await queryInterface.sequelize.query(
      `UPDATE \`notices\`
          SET \`title\` = REPLACE(\`title\`, :newName, :oldName),
              \`content\` = REPLACE(\`content\`, :newName, :oldName)
        WHERE \`title\` LIKE CONCAT('%', :newName, '%')
           OR \`content\` LIKE CONCAT('%', :newName, '%')`,
      { replacements: { oldName: OLD_NAME, newName: NEW_NAME } },
    )
  },
}
