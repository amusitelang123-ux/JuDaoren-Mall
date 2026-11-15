import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize'
import { sequelize } from '../config/database'

/**
 * AI 平台相关表（原来只有客服 4 张，本轮按改进方向 §7 扩容）：
 *
 * ai_conversations    会话（按订单/用户维度）
 * ai_messages         消息（含引用与工具调用留痕）
 * ai_kb_chunks        知识库切片（FAQ / 公告 / 物流 / 运费 / 平台规则）
 * ai_call_logs        模型调用审计（token、耗时、成本、失败原因、缓存、兜底原因）
 * ai_feedback         回答评价（👍/👎 + 纠错），评测集的数据来源
 * ai_eval_cases       评测集用例（npm run ai:eval）
 * search_logs         搜索埋点（解析结果、命中数量、点击商品）
 */

export class AiConversation extends Model<
  InferAttributes<AiConversation>,
  InferCreationAttributes<AiConversation>
> {
  declare id: CreationOptional<number>
  declare userId: number | null
  declare orderNo: string | null
  declare title: string | null
  declare source: CreationOptional<string>
  /** 1 进行中 2 已转人工 3 已关闭 */
  declare status: CreationOptional<number>
  declare messageCount: CreationOptional<number>
  declare lastMessage: string | null
  declare lastMessageAt: Date | null
  declare createdAt: CreationOptional<Date>
  declare updatedAt: CreationOptional<Date>
}

AiConversation.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    orderNo: { type: DataTypes.STRING(32), allowNull: true },
    title: { type: DataTypes.STRING(100), allowNull: true },
    source: { type: DataTypes.STRING(20), defaultValue: 'contact' },
    status: { type: DataTypes.TINYINT, defaultValue: 1 },
    messageCount: { type: DataTypes.INTEGER, defaultValue: 0 },
    lastMessage: { type: DataTypes.STRING(255), allowNull: true },
    lastMessageAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'ai_conversations', timestamps: true },
)

export class AiMessage extends Model<InferAttributes<AiMessage>, InferCreationAttributes<AiMessage>> {
  declare id: CreationOptional<number>
  declare conversationId: number
  declare role: string
  declare content: string
  declare citations: unknown
  declare toolCalls: unknown
  declare tokens: CreationOptional<number>
  declare model: string | null
  declare latencyMs: number | null
  declare createdAt: CreationOptional<Date>
}

AiMessage.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    conversationId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    role: { type: DataTypes.STRING(16), allowNull: false },
    content: { type: DataTypes.TEXT, allowNull: false },
    citations: { type: DataTypes.JSON, allowNull: true },
    toolCalls: { type: DataTypes.JSON, allowNull: true },
    tokens: { type: DataTypes.INTEGER, defaultValue: 0 },
    model: { type: DataTypes.STRING(50), allowNull: true },
    latencyMs: { type: DataTypes.INTEGER, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'ai_messages', timestamps: true, updatedAt: false },
)

export class AiKbChunk extends Model<InferAttributes<AiKbChunk>, InferCreationAttributes<AiKbChunk>> {
  declare id: CreationOptional<number>
  /** faq / notice / logistics / freight / policy */
  declare sourceType: string
  declare sourceId: number | null
  declare title: string
  declare content: string
  declare keywords: string | null
  declare status: CreationOptional<number>
  declare createdAt: CreationOptional<Date>
  declare updatedAt: CreationOptional<Date>
}

AiKbChunk.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    sourceType: { type: DataTypes.STRING(20), allowNull: false },
    sourceId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    title: { type: DataTypes.STRING(255), allowNull: false },
    content: { type: DataTypes.TEXT, allowNull: false },
    keywords: { type: DataTypes.STRING(500), allowNull: true },
    status: { type: DataTypes.TINYINT, defaultValue: 1 },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'ai_kb_chunks', timestamps: true },
)

export class AiCallLog extends Model<InferAttributes<AiCallLog>, InferCreationAttributes<AiCallLog>> {
  declare id: CreationOptional<number>
  declare module: string
  declare scenario: string | null
  declare userId: number | null
  declare conversationId: number | null
  declare model: string | null
  declare promptTokens: CreationOptional<number>
  declare completionTokens: CreationOptional<number>
  declare totalTokens: CreationOptional<number>
  declare cost: CreationOptional<string>
  declare latencyMs: CreationOptional<number>
  /** 1 成功 0 失败（含结构化输出降级） */
  declare status: CreationOptional<number>
  declare error: string | null
  /** 1 命中结果缓存（未产生真实模型调用） */
  declare cacheHit: CreationOptional<number>
  /** 兜底原因：timeout / invalid_json / schema_mismatch / error ... */
  declare fallbackReason: string | null
  declare createdAt: CreationOptional<Date>
}

AiCallLog.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    module: { type: DataTypes.STRING(30), allowNull: false },
    scenario: { type: DataTypes.STRING(40), allowNull: true },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    conversationId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    model: { type: DataTypes.STRING(50), allowNull: true },
    promptTokens: { type: DataTypes.INTEGER, defaultValue: 0 },
    completionTokens: { type: DataTypes.INTEGER, defaultValue: 0 },
    totalTokens: { type: DataTypes.INTEGER, defaultValue: 0 },
    cost: { type: DataTypes.DECIMAL(10, 4), defaultValue: 0 },
    latencyMs: { type: DataTypes.INTEGER, defaultValue: 0 },
    status: { type: DataTypes.TINYINT, defaultValue: 1 },
    error: { type: DataTypes.STRING(255), allowNull: true },
    cacheHit: { type: DataTypes.TINYINT, defaultValue: 0 },
    fallbackReason: { type: DataTypes.STRING(60), allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'ai_call_logs', timestamps: true, updatedAt: false },
)

/**
 * 回答评价（👍/👎 + 纠错）。
 * 这是「评测集」的数据来源：没有人工反馈，就无法判断知识边界扩得对不对。
 */
export class AiFeedback extends Model<InferAttributes<AiFeedback>, InferCreationAttributes<AiFeedback>> {
  declare id: CreationOptional<number>
  declare messageId: number
  declare conversationId: number | null
  declare userId: number | null
  declare module: string
  declare scenario: string | null
  /** 1 有用 -1 没用 */
  declare rating: number
  declare reason: string | null
  declare correctedAnswer: string | null
  declare createdAt: CreationOptional<Date>
  declare updatedAt: CreationOptional<Date>
}

AiFeedback.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    messageId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    conversationId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    module: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'chat' },
    scenario: { type: DataTypes.STRING(40), allowNull: true },
    rating: { type: DataTypes.TINYINT, allowNull: false },
    reason: { type: DataTypes.STRING(100), allowNull: true },
    correctedAnswer: { type: DataTypes.TEXT, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'ai_feedback', timestamps: true },
)

/** 评测集用例：npm run ai:eval 的输入 */
export class AiEvalCase extends Model<InferAttributes<AiEvalCase>, InferCreationAttributes<AiEvalCase>> {
  declare id: CreationOptional<number>
  declare module: string
  declare scenario: string | null
  declare input: string
  declare expectJson: unknown
  declare tags: string | null
  declare status: CreationOptional<number>
  declare createdAt: CreationOptional<Date>
  declare updatedAt: CreationOptional<Date>
}

AiEvalCase.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    module: { type: DataTypes.STRING(30), allowNull: false },
    scenario: { type: DataTypes.STRING(40), allowNull: true },
    input: { type: DataTypes.TEXT, allowNull: false },
    expectJson: { type: DataTypes.JSON, allowNull: true, field: 'expect_json' },
    tags: { type: DataTypes.STRING(120), allowNull: true },
    status: { type: DataTypes.TINYINT, defaultValue: 1 },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'ai_eval_cases', timestamps: true },
)

/**
 * 搜索埋点：解析结果、命中数量与（预留的）点击商品。
 * 热门搜索由它聚合，取代前端硬编码的 app.hotKeywords。
 */
export class SearchLog extends Model<InferAttributes<SearchLog>, InferCreationAttributes<SearchLog>> {
  declare id: CreationOptional<number>
  declare keyword: string
  declare parsedJson: unknown
  declare resultCount: CreationOptional<number>
  declare clickedProductId: number | null
  declare userId: number | null
  declare scene: CreationOptional<string>
  declare createdAt: CreationOptional<Date>
}

SearchLog.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    keyword: { type: DataTypes.STRING(80), allowNull: false },
    parsedJson: { type: DataTypes.JSON, allowNull: true, field: 'parsed_json' },
    resultCount: { type: DataTypes.INTEGER, defaultValue: 0 },
    clickedProductId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    scene: { type: DataTypes.STRING(20), defaultValue: 'search' },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'search_logs', timestamps: true, updatedAt: false },
)
