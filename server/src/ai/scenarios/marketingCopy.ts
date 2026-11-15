import { z } from 'zod'
import { runAiTask } from '../core/run'
import type { CopyScene, CopyVariant } from './types'

/**
 * 场景：营销文案生成（改进方向 §6 C3，最快见效的一个）。
 *
 * 三道约束：
 * 1. 一次给 3 个版本，结构化输出，**直接回填表单、不自动保存**；
 * 2. 广告法违禁词前置过滤，命中即整条丢弃，绝不下发；
 * 3. 产物打「AI 生成」标记，必须人工确认（接口不写库，只返回文本）。
 */

const variantSchema = z.object({
  title: z.string().trim().min(2).max(40),
  subtitle: z.string().trim().max(60).optional().default(''),
  body: z.string().trim().min(2).max(400),
  tags: z.array(z.string().trim().max(12)).max(6).optional().default([]),
})

const copySchema = z.object({
  variants: z.array(variantSchema).min(1).max(3),
})

/** 广告法/平台禁用的绝对化用语。命中任一词的整条文案直接丢弃 */
const BANNED_WORDS = [
  '最佳',
  '最好',
  '最优',
  '最低',
  '最高',
  '最便宜',
  '最先进',
  '第一',
  '国家级',
  '顶级',
  '极致',
  '绝对',
  '唯一',
  '独家',
  '100%',
  '百分百',
  '全网最低',
  '史无前例',
  '万能',
  '永久',
  '免单',
  '稳赚',
]

export function findBannedWords(text: string): string[] {
  return BANNED_WORDS.filter((word) => text.includes(word))
}

const SCENE_LABEL: Record<CopyScene, string> = {
  product: '商品标题与卖点',
  coupon: '优惠券文案',
  notice: '店铺公告',
  seckill: '秒杀活动文案',
}

const SCENE_RULES: Record<CopyScene, string> = {
  product:
    '商品文案：标题 20 字内讲清品类与核心卖点；body 用 2-3 句写适用场景与用户收益；不要编造材质、认证、参数。',
  coupon:
    '优惠券文案：写清面额、使用门槛、有效期与适用范围；不要承诺「全店通用」除非 brief 明确说明。',
  notice:
    '公告文案：先讲结论与影响范围，再讲用户需要做什么；语气克制，不使用营销夸张词。',
  seckill:
    '秒杀文案：突出价格与数量，但必须提示「库存有限、售完即止」；不得使用绝对化用语。',
}

function buildSystemPrompt(scene: CopyScene): string {
  return `你是菊道人商城的运营文案助手。根据运营提供的要点，为「${SCENE_LABEL[scene]}」写 3 个风格不同的版本。

${SCENE_RULES[scene]}

硬性要求：
1. 只输出 JSON：{"variants":[{"title":"","subtitle":"","body":"","tags":[""]}]}，3 个版本。
2. 严禁使用广告法禁用的绝对化用语：${BANNED_WORDS.slice(0, 12).join('、')} 等。
3. 不得编造 brief 中没有的价格、参数、资质、销量或承诺。
4. 中文表达，简洁；body 不超过 120 字；tags 是可检索的关键词，最多 4 个。`
}

export interface CopywritingInput {
  scene: CopyScene
  brief: string
  tone?: string
  variantCount?: number
}

export interface CopywritingResult {
  scene: CopyScene
  sceneLabel: string
  variants: CopyVariant[]
  /** 被违禁词过滤掉的条数，前端可提示「有 1 条因违禁词被拦截」 */
  filtered: number
  /** 命中的违禁词，便于运营理解为什么被拦 */
  bannedWords: string[]
  degraded: boolean
  fallbackReason: string | null
  latencyMs: number
  aiGenerated: true
}

/** 规则版模板：模型不可用时也必须能给出可用文案（运营不至于卡住） */
function fallbackVariants(scene: CopyScene, brief: string, count: number): CopyVariant[] {
  const short = brief.trim().slice(0, 24) || '本期上新'
  const templates: Record<CopyScene, CopyVariant[]> = {
    product: [
      {
        title: short,
        subtitle: '当季精选 · 品质保障',
        body: `${short}，精选材质与做工，适合日常使用。支持 7 天无理由退换，质量问题由平台承担运费。`,
        tags: ['精选', '新品'],
      },
      {
        title: `${short} 商城在售`,
        subtitle: '现货速发',
        body: `${short}，现货下单 48 小时内发出，售后由平台客服全程跟进。`,
        tags: ['现货', '速发'],
      },
    ],
    coupon: [
      {
        title: `领取优惠券：${short}`,
        subtitle: '下单立减',
        body: `${short}，领取后在结算页选择使用，具体可用范围与有效期以券面说明为准。`,
        tags: ['优惠券', '立减'],
      },
    ],
    notice: [
      {
        title: `公告：${short}`,
        subtitle: '请留意服务时间调整',
        body: `${short}。给你带来不便请谅解，如有疑问可在帮助中心联系在线客服。`,
        tags: ['公告'],
      },
    ],
    seckill: [
      {
        title: `限时秒杀：${short}`,
        subtitle: '库存有限，售完即止',
        body: `${short}，活动期间限量放价，售完即止；秒杀商品不与其他满减叠加，最终以结算页金额为准。`,
        tags: ['秒杀', '限量'],
      },
    ],
  }
  return templates[scene].slice(0, Math.max(1, count))
}

function sanitize(variants: CopyVariant[]): { kept: CopyVariant[]; filtered: number; bannedWords: string[] } {
  const banned = new Set<string>()
  const kept: CopyVariant[] = []
  let filtered = 0
  for (const variant of variants) {
    const text = `${variant.title} ${variant.subtitle} ${variant.body} ${variant.tags.join(' ')}`
    const hits = findBannedWords(text)
    if (hits.length) {
      filtered += 1
      hits.forEach((word) => banned.add(word))
      continue
    }
    kept.push({
      title: variant.title.slice(0, 40),
      subtitle: variant.subtitle.slice(0, 60),
      body: variant.body.slice(0, 400),
      tags: variant.tags.slice(0, 6),
    })
  }
  return { kept, filtered, bannedWords: [...banned] }
}

export async function generateCopywriting(
  input: CopywritingInput,
  adminId?: number,
): Promise<CopywritingResult> {
  const startedAt = Date.now()
  const scene = input.scene
  const count = Math.min(3, Math.max(1, input.variantCount ?? 3))

  const result = await runAiTask({
    module: 'admin',
    scenario: 'marketing_copy',
    subjectId: adminId ?? null,
    actor: { role: 'admin', adminId },
    system: buildSystemPrompt(scene),
    messages: [
      {
        role: 'user',
        content: `运营要点：${input.brief.trim()}\n语气偏好：${input.tone?.trim() || '自然、克制、不说大话'}\n请输出 ${count} 个版本。`,
      },
    ],
    schema: copySchema,
    temperature: 0.7,
    maxTokens: 700,
    timeoutMs: 20_000,
    fallback: () => null,
  })

  const raw = result.data?.variants ?? []
  const { kept, filtered, bannedWords } = sanitize(raw)
  const variants = kept.length ? kept : fallbackVariants(scene, input.brief, count)

  return {
    scene,
    sceneLabel: SCENE_LABEL[scene],
    variants,
    filtered,
    bannedWords,
    degraded: !result.ok,
    fallbackReason: result.fallbackReason ?? null,
    latencyMs: Date.now() - startedAt,
    aiGenerated: true,
  }
}

export { copySchema, variantSchema, SCENE_LABEL, BANNED_WORDS }
