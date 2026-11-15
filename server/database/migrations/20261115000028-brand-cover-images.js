'use strict'

/**
 * 品牌专区封面图：把演示品牌的占位 SVG 替换为本地 Unsplash 封面图。
 *
 * 只更新仍在使用 /uploads/demo/ 占位图的记录，后台已经上传过品牌图片的品牌不会被覆盖。
 * 新装数据由 seeder 直接写入同样的图片地址。
 */

const BRAND_COVERS = [
  { id: 1, name: '兔鲜优选', logo: '/brand-images/rabbit-fresh.jpg' },
  { id: 2, name: '极光科技', logo: '/brand-images/aurora-tech.jpg' },
  { id: 3, name: '云栖家居', logo: '/brand-images/cloud-home.jpg' },
  { id: 4, name: '拾光良品', logo: '/brand-images/time-good.jpg' },
  { id: 5, name: '山野农夫', logo: '/brand-images/wild-farmer.jpg' },
  { id: 6, name: '悦己主义', logo: '/brand-images/self-love.jpg' },
  { id: 7, name: '小兔宝贝', logo: '/brand-images/baby-rabbit.jpg' },
  { id: 8, name: '风行运动', logo: '/brand-images/wind-sports.jpg' },
  { id: 9, name: '墨韵书房', logo: '/brand-images/ink-study.jpg' },
  { id: 10, name: '臻选严选', logo: '/brand-images/select.jpg' },
]

module.exports = {
  async up(queryInterface) {
    for (const brand of BRAND_COVERS) {
      await queryInterface.sequelize.query(
        `UPDATE \`brands\`
            SET \`logo\` = :logo, \`updated_at\` = NOW()
          WHERE \`id\` = :id
            AND \`name\` = :name
            AND (\`logo\` IS NULL OR \`logo\` = '' OR \`logo\` LIKE '/uploads/demo/%')`,
        { replacements: brand },
      )
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      "UPDATE `brands` SET `logo` = NULL, `updated_at` = NOW() WHERE `logo` LIKE '/brand-images/%'",
    )
  },
}
