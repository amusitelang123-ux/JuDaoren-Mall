'use strict'

/**
 * 增量迁移：AI 平台化改造（对应 docs/AI深度集成-改进方向.md 第 7 节）。
 *
 * 1) ai_call_logs 补三个可观测维度：scenario / cache_hit / fallback_reason
 *    —— 没有它们就算不出「兜底率」，也做不了分场景成本下钻。
 * 2) ai_feedback      回答评价（👍/👎 + 纠错），评测集的数据来源
 * 3) ai_eval_cases    评测集用例（npm run ai:eval）
 * 4) search_logs      搜索埋点（解析结果 / 命中数量 / 点击商品），热门搜索由它聚合
 * 5) feedbacks        补 ai_category / ai_summary（坐席辅助归类，AI 不可用时为空）
 *
 * 说明：ai_kb_chunks 没有加 embedding 列。DeepSeek 无 embedding 接口，
 * 本轮 AI_EMBEDDING_ENABLED 恒为 false，加列只会留下一个永远为空的字段。
 * 等真正接入第三方向量模型时再随那次迁移一起加（改进方向 §4 A3 的取舍）。
 */

const CREATE_AI_FEEDBACK = `CREATE TABLE IF NOT EXISTS \`ai_feedback\` (
  \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`message_id\` BIGINT UNSIGNED NOT NULL COMMENT 'ai_messages.id',
  \`conversation_id\` BIGINT UNSIGNED NULL,
  \`user_id\` BIGINT UNSIGNED NULL,
  \`module\` VARCHAR(30) NOT NULL DEFAULT 'chat',
  \`scenario\` VARCHAR(40) NULL,
  \`rating\` TINYINT NOT NULL COMMENT '1 有用 -1 没用',
  \`reason\` VARCHAR(100) NULL COMMENT '用户选择的差评原因',
  \`corrected_answer\` TEXT NULL COMMENT '用户提交的纠正答案，可整理进评测集',
  \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_message_user\` (\`message_id\`, \`user_id\`),
  KEY \`idx_rating_time\` (\`rating\`, \`created_at\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='AI 回答评价表'`

const CREATE_AI_EVAL_CASES = `CREATE TABLE IF NOT EXISTS \`ai_eval_cases\` (
  \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`module\` VARCHAR(30) NOT NULL COMMENT '治理维度：chat / search / admin / other',
  \`scenario\` VARCHAR(40) NULL COMMENT 'customer_service / search_parse ...',
  \`input\` TEXT NOT NULL COMMENT '评测输入（用户原话）',
  \`expect_json\` JSON NULL COMMENT '期望结果，按字段比对',
  \`tags\` VARCHAR(120) NULL,
  \`status\` TINYINT NOT NULL DEFAULT 1,
  \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`idx_scenario_status\` (\`scenario\`, \`status\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='AI 评测集用例'`

const CREATE_SEARCH_LOGS = `CREATE TABLE IF NOT EXISTS \`search_logs\` (
  \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`keyword\` VARCHAR(80) NOT NULL COMMENT '用户原始搜索词',
  \`parsed_json\` JSON NULL COMMENT '查询理解结果（实际生效的检索参数）',
  \`result_count\` INT NOT NULL DEFAULT 0 COMMENT '命中商品数，用于统计零结果率',
  \`clicked_product_id\` BIGINT UNSIGNED NULL COMMENT '预留：结果页点击商品',
  \`user_id\` BIGINT UNSIGNED NULL,
  \`scene\` VARCHAR(20) NOT NULL DEFAULT 'search',
  \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`idx_keyword_time\` (\`keyword\`, \`created_at\`),
  KEY \`idx_time\` (\`created_at\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='搜索埋点表'`

async function describe(queryInterface, table) {
  try {
    return await queryInterface.describeTable(table)
  } catch {
    return null
  }
}

async function addColumnIfMissing(queryInterface, table, column, definition) {
  const description = await describe(queryInterface, table)
  if (!description) {
    console.warn(`[migration] 表 ${table} 不存在，跳过 ${column}`)
    return
  }
  if (description[column]) return
  await queryInterface.sequelize.query(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`)
}

async function dropColumnIfExists(queryInterface, table, column) {
  const description = await describe(queryInterface, table)
  if (!description || !description[column]) return
  await queryInterface.sequelize.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``)
}

module.exports = {
  async up(queryInterface) {
    // 1) 审计维度
    await addColumnIfMissing(
      queryInterface,
      'ai_call_logs',
      'scenario',
      "`scenario` VARCHAR(40) NULL COMMENT '业务场景' AFTER `module`",
    )
    await addColumnIfMissing(
      queryInterface,
      'ai_call_logs',
      'cache_hit',
      "`cache_hit` TINYINT NOT NULL DEFAULT 0 COMMENT '1 命中结果缓存' AFTER `error`",
    )
    await addColumnIfMissing(
      queryInterface,
      'ai_call_logs',
      'fallback_reason',
      "`fallback_reason` VARCHAR(60) NULL COMMENT '兜底原因' AFTER `cache_hit`",
    )

    // 2) 三张新表
    await queryInterface.sequelize.query(CREATE_AI_FEEDBACK)
    await queryInterface.sequelize.query(CREATE_AI_EVAL_CASES)
    await queryInterface.sequelize.query(CREATE_SEARCH_LOGS)

    // 3) 坐席辅助：工单归类字段（保持主表结构不变，AI 不可用时为空）
    await addColumnIfMissing(
      queryInterface,
      'feedbacks',
      'ai_category',
      "`ai_category` VARCHAR(20) NULL COMMENT 'AI 归类：咨询/投诉/建议/售后'",
    )
    await addColumnIfMissing(
      queryInterface,
      'feedbacks',
      'ai_summary',
      "`ai_summary` VARCHAR(255) NULL COMMENT 'AI 一句话摘要'",
    )
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS `search_logs`')
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS `ai_eval_cases`')
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS `ai_feedback`')

    await dropColumnIfExists(queryInterface, 'feedbacks', 'ai_summary')
    await dropColumnIfExists(queryInterface, 'feedbacks', 'ai_category')
    await dropColumnIfExists(queryInterface, 'ai_call_logs', 'fallback_reason')
    await dropColumnIfExists(queryInterface, 'ai_call_logs', 'cache_hit')
    await dropColumnIfExists(queryInterface, 'ai_call_logs', 'scenario')
  },
}
