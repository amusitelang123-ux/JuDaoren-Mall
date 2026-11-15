'use strict'

/**
 * 评测集初始用例（改进方向 §9.1）。
 *
 * 两类场景各有用意：
 * - search_parse：结构化字段逐项比对，能直接量出「AI 解析 vs 规则基线」的差距；
 * - customer_service：只看知识召回是否命中，零成本，衡量「知识边界够不够」。
 *
 * 期望值刻意写得宽松（keyword 用包含判定、未提及的字段不写），
 * 因为评测的目的是防止回退，不是把某一次输出钉死。
 */

const CASES = [
  /* -------------------------- 搜索查询理解 -------------------------- */
  {
    module: 'search',
    scenario: 'search_parse',
    input: '200块以内的保暖被',
    expect_json: { keyword: '保暖被', maxPrice: 200 },
    tags: 'price,price-max',
  },
  {
    module: 'search',
    scenario: 'search_parse',
    input: '想买个100到200块的台灯',
    expect_json: { keyword: '台灯', minPrice: 100, maxPrice: 200 },
    tags: 'price,price-range',
  },
  {
    module: 'search',
    scenario: 'search_parse',
    input: '300元以上的文学套装',
    expect_json: { keyword: '文学套装', minPrice: 300 },
    tags: 'price,price-min',
  },
  {
    module: 'search',
    scenario: 'search_parse',
    input: '最便宜的帐篷',
    expect_json: { keyword: '帐篷', sortBy: 'priceAsc' },
    tags: 'sort',
  },
  {
    module: 'search',
    scenario: 'search_parse',
    input: '销量最高的跑步机',
    expect_json: { keyword: '跑步机', sortBy: 'sales' },
    tags: 'sort',
  },
  {
    module: 'search',
    scenario: 'search_parse',
    input: '露营用的帐篷，400元以内',
    expect_json: { keyword: '帐篷', maxPrice: 400 },
    tags: 'price,max,noise',
  },
  {
    module: 'search',
    scenario: 'search_parse',
    input: '数码电子的平板',
    expect_json: { keyword: '平板', categoryName: '数码电子' },
    tags: 'category',
  },
  {
    module: 'search',
    scenario: 'search_parse',
    input: '极光科技的平板',
    expect_json: { keyword: '平板', brandName: '极光科技' },
    tags: 'brand',
  },
  {
    module: 'search',
    scenario: 'search_parse',
    input: '有没有便宜点的洗发水，100元以下',
    expect_json: { keyword: '洗发水', maxPrice: 100 },
    tags: 'price,max,noise',
  },
  {
    module: 'search',
    scenario: 'search_parse',
    input: '给宝宝的纸尿裤',
    expect_json: { keyword: '纸尿裤' },
    tags: 'keyword,hard',
  },
  {
    module: 'search',
    scenario: 'search_parse',
    input: '预算三百以内的台灯',
    expect_json: { keyword: '台灯', maxPrice: 300 },
    tags: 'price,chinese-numeral',
  },
  {
    module: 'search',
    scenario: 'search_parse',
    input: '五百元以上的平板',
    expect_json: { keyword: '平板', minPrice: 500 },
    tags: 'price,chinese-numeral',
  },

  /* ------------------- 客服知识召回（不调模型） ------------------- */
  {
    module: 'chat',
    scenario: 'customer_service',
    input: '怎么开发票',
    expect_json: { chunkTitleContains: '发票' },
    tags: 'knowledge,faq',
  },
  {
    module: 'chat',
    scenario: 'customer_service',
    input: '运费怎么计算',
    expect_json: { chunkTitleContains: '运费' },
    tags: 'knowledge,freight',
  },
  {
    module: 'chat',
    scenario: 'customer_service',
    input: '退款多久到账',
    expect_json: { chunkTitleContains: '退款' },
    tags: 'knowledge,refund',
  },
  {
    module: 'chat',
    scenario: 'customer_service',
    input: '多久能收到货',
    expect_json: { chunkTitleContains: '常见问题' },
    tags: 'knowledge,delivery',
  },
]

module.exports = {
  async up(queryInterface) {
    const [existing] = await queryInterface.sequelize.query(
      'SELECT COUNT(*) AS total FROM ai_eval_cases',
    )
    if (Number(existing[0].total) > 0) {
      console.log('[seed] ai_eval_cases 已有数据，跳过')
      return
    }

    await queryInterface.bulkInsert(
      'ai_eval_cases',
      CASES.map((item) => ({
        module: item.module,
        scenario: item.scenario,
        input: item.input,
        expect_json: JSON.stringify(item.expect_json),
        tags: item.tags,
        status: 1,
      })),
    )
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('ai_eval_cases', null, {})
  },
}

module.exports.CASES = CASES
