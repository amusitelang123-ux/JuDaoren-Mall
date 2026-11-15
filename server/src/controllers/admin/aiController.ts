import type { Request, Response } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../../middlewares/asyncHandler'
import { sendOk } from '../../utils/response'
import * as aiAdminService from '../../services/aiAdminService'
import { generateCopywriting } from '../../ai/scenarios/marketingCopy'
import { draftFeedbackReply } from '../../ai/scenarios/helpdeskDraft'
import { scenarioState, breakerState, isScenarioEnabled } from '../../ai/core/guard'
import { cacheStats } from '../../ai/core/cache'
import { writeAdminLog } from '../../services/adminService'

const listSchema = z.object({
  keyword: z.string().trim().max(64).optional(),
  status: z.coerce.number().int().min(0).max(3).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
})

const idSchema = z.object({ id: z.coerce.number().int().positive() })

/** 后台：AI 会话列表 */
export const conversations = asyncHandler(async (req: Request, res: Response) => {
  sendOk(res, await aiAdminService.listConversations(listSchema.parse(req.query)))
})

/** 后台：会话消息详情 */
export const messages = asyncHandler(async (req: Request, res: Response) => {
  const { id } = idSchema.parse(req.params)
  const data = await aiAdminService.getConversationMessages(id)
  sendOk(res, data ?? [])
})

/** 后台：分模块用量、预算、质量指标与知识库规模 */
export const usage = asyncHandler(async (_req: Request, res: Response) => {
  sendOk(res, await aiAdminService.usageStats())
})

/** 后台：场景开关总览（.env + settings 覆盖 + 灰度）+ 熔断状态 + 缓存规模 */
export const scenarios = asyncHandler(async (_req: Request, res: Response) => {
  const ids = ['customer_service', 'search_parse', 'marketing_copy', 'helpdesk_draft'] as const
  const list = await Promise.all(ids.map((scenario) => scenarioState(scenario)))
  sendOk(res, {
    scenarios: list.map((item) => ({
      scenario: item.scenario,
      module: item.module,
      enabled: item.enabled,
      envEnabled: item.envEnabled,
      settingEnabled: item.settingEnabled,
      grayUserIds: item.grayUserIds,
    })),
    breakers: breakerState(),
    cache: cacheStats(),
  })
})

/** 后台：重建知识库（FAQ / 公告 / 物流 / 运费 / 平台规则） */
export const rebuild = asyncHandler(async (_req: Request, res: Response) => {
  sendOk(res, await aiAdminService.rebuildKnowledge(), '知识库已重建')
})

/* ----------------------------- 文案生成（C3） ----------------------------- */

const copySchema = z.object({
  scene: z.enum(['product', 'coupon', 'notice', 'seckill']),
  brief: z.string().trim().min(2, '请填写运营要点').max(300),
  tone: z.string().trim().max(30).optional(),
  variantCount: z.number().int().min(1).max(3).optional(),
})

/** 一次给 3 个版本，直接回填表单、不自动保存；违禁词整条拦截 */
export const copywriting = asyncHandler(async (req: Request, res: Response) => {
  const body = copySchema.parse(req.body)
  const result = await generateCopywriting(body, req.auth!.uid)
  await writeAdminLog({
    adminId: req.auth!.uid,
    module: 'ai',
    action: 'ai:copywriting',
    content: `场景=${body.scene} 命中违禁词=${result.bannedWords.join('/') || '无'}`,
    ip: req.ip,
  })
  sendOk(res, result)
})

/* --------------------------- 坐席辅助（C5） ---------------------------- */

/** 归类 + 相似工单 + 回复草稿；草稿只返回不写库，人工确认后再回复 */
export const feedbackDraft = asyncHandler(async (req: Request, res: Response) => {
  const { id } = idSchema.parse(req.params)
  const result = await draftFeedbackReply(id, req.auth!.uid)
  sendOk(res, result)
})

/** 差评样本（带纠错文本），用于整理评测集 */
export const badFeedback = asyncHandler(async (req: Request, res: Response) => {
  const limit = Number(req.query.limit ?? 20)
  sendOk(res, await aiAdminService.badFeedback(Number.isFinite(limit) ? limit : 20))
})

/* ------------------------------ 评测集 ------------------------------- */

/** 跑一遍 ai_eval_cases，返回各场景准确率；给「改完提示词立刻看效果」用 */
export const evaluate = asyncHandler(async (req: Request, res: Response) => {
  const fromBody = req.body && typeof req.body.scenario === 'string' ? req.body.scenario : undefined
  const fromQuery = typeof req.query.scenario === 'string' ? req.query.scenario : undefined
  sendOk(res, await aiAdminService.runEvaluation(fromBody || fromQuery))
})

/** 场景可用性探测：前端据此决定是否渲染 AI 入口（不抛错） */
export const availability = asyncHandler(async (_req: Request, res: Response) => {
  sendOk(res, {
    customer_service: await isScenarioEnabled('customer_service'),
    search_parse: await isScenarioEnabled('search_parse'),
    marketing_copy: await isScenarioEnabled('marketing_copy'),
    helpdesk_draft: await isScenarioEnabled('helpdesk_draft'),
  })
})
