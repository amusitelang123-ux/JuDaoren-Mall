/**
 * AI 平台层统一出口。
 *
 * 分层（与 docs/AI深度集成-改进方向.md 第 3 节一致）：
 *   adapters/ai  —— 只负责「跟厂商说话」（OpenAI 协议、流式、重试）
 *   ai/core      —— 治理与编排：限流 / 预算 / 熔断 / 缓存 / 结构化输出 / 审计
 *   ai/rag       —— 知识源注册表 + 词法检索 + 同步
 *   ai/tools     —— 工具注册表（zod 入参校验 + 统一 authz）
 *   ai/scenarios —— 业务场景：客服、搜索解析、文案生成、坐席辅助
 *
 * 业务代码只需要 `import { ai } from '../ai'` 然后 ai.scenarios.xxx 调用，
 * 不需要知道治理细节，也不会绕过治理。
 */

export * from './core/types'
export { runAiTask, type RunAiTaskInput, type TaskMode } from './core/run'
export {
  assertScenarioEnabled,
  budgetState,
  breakerState,
  isScenarioEnabled,
  resetRateLimit,
  scenarioState,
  type ScenarioState,
} from './core/guard'
export { clearCache, cacheStats } from './core/cache'
export { evaluateCase, runEvalSuite, type EvalCase, type EvalCaseResult, type EvalSummary } from './eval/runner'

export { tokenize, searchKnowledge, searchSimilar, knowledgeStats, type KnowledgeHit } from './rag/retriever'
export { syncKnowledgeBase, type SyncResult } from './rag/sync'
export { listSources, type KnowledgeSource, type KnowledgeItem } from './rag/sources'

export { registerTool, availableTools, executeTool, listToolSpecs } from './tools'
export type { AiToolSpec, ToolOutcome } from './tools'

export * as customerService from './scenarios/customerService'
export * as searchParse from './scenarios/searchParse'
export * as marketingCopy from './scenarios/marketingCopy'
export * as helpdeskDraft from './scenarios/helpdeskDraft'

export * as feedback from './feedback'
