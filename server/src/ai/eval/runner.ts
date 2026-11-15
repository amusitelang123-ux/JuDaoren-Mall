import { searchKnowledge } from '../rag/retriever'
import { parseSearchQuery } from '../scenarios/searchParse'
import type { ParsedSearch } from '../scenarios/searchParse'

/**
 * 评测集执行器（改进方向 §9.1）。
 *
 * 目标不是「跑个数字好看」，而是让每次改提示词/换模型都能和上一版对比：
 * 准确率、引用命中率、兜底率、平均/P95 延迟。基线永远是「规则版」或上一版 prompt。
 *
 * 目前覆盖两个场景：
 * - search_parse：结构化字段逐项比对（模型可用时比对模型结果，关闭时比对规则结果）
 * - customer_service：只看知识召回是否命中（不调模型，零成本，衡量「AI 懂不懂业务」）
 */

export interface EvalCase {
  id: number
  module: string
  scenario: string
  input: string
  expectJson: unknown
  tags?: string | null
}

export interface EvalCaseResult {
  id: number
  input: string
  passed: boolean
  /** 未通过的字段/原因 */
  failed: string[]
  expected: unknown
  actual: unknown
  latencyMs: number
  degraded: boolean
  fallbackReason: string | null
}

export interface EvalSummary {
  scenario: string
  total: number
  passed: number
  accuracy: number
  /** 平均延迟与 P95 延迟（毫秒） */
  avgLatency: number
  p95Latency: number
  /** 走降级路径的比例 */
  degradedRate: number
  /** 搜索特有：零结果比例 */
  zeroResultRate?: number
  cases: EvalCaseResult[]
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))
  return Math.round(sorted[index])
}

function compareFields(expected: Record<string, unknown>, actual: ParsedSearch): string[] {
  const failed: string[] = []
  const mapping: Record<string, keyof ParsedSearch> = {
    keyword: 'keyword',
    categoryName: 'categoryName',
    brandName: 'brandName',
    minPrice: 'minPrice',
    maxPrice: 'maxPrice',
    sortBy: 'sortBy',
  }

  for (const [key, field] of Object.entries(mapping)) {
    if (!(key in expected)) continue
    const want = expected[key]
    const got = actual[field]

    if (key === 'keyword') {
      const wantText = String(want ?? '').trim()
      const gotText = String(got ?? '').trim()
      // 关键词允许「包含」判定：解析出更完整的词（如「T恤」vs「短袖T恤」）不算错
      if (wantText && !gotText.includes(wantText) && !wantText.includes(gotText)) {
        failed.push(`keyword: 期望含「${wantText}」实际「${gotText}」`)
      }
      continue
    }

    if (key === 'categoryName' || key === 'brandName' || key === 'sortBy') {
      if (String(want ?? '') !== String(got ?? '')) {
        failed.push(`${key}: 期望「${String(want)}」实际「${String(got)}」`)
      }
      continue
    }

    const wantNumber = want === null || want === undefined ? null : Number(want)
    const gotNumber = got === null || got === undefined ? null : Number(got)
    if (wantNumber !== gotNumber) {
      failed.push(`${key}: 期望 ${wantNumber} 实际 ${gotNumber}`)
    }
  }

  if (expected.attributes && Array.isArray(expected.attributes)) {
    for (const attribute of expected.attributes as string[]) {
      if (!actual.attributes.some((item) => item.includes(attribute))) {
        failed.push(`attributes: 缺少「${attribute}」`)
      }
    }
  }

  return failed
}

export async function evaluateCase(testCase: EvalCase): Promise<EvalCaseResult> {
  const startedAt = Date.now()
  const expected = (testCase.expectJson ?? {}) as Record<string, unknown>

  if (testCase.scenario === 'search_parse') {
    const result = await parseSearchQuery({
      query: testCase.input,
      skipCount: true,
      noCache: true,
    })
    const failed = compareFields(expected, result.parsed)
    return {
      id: testCase.id,
      input: testCase.input,
      passed: failed.length === 0,
      failed,
      expected,
      actual: result.parsed,
      latencyMs: Date.now() - startedAt,
      degraded: result.degraded,
      fallbackReason: result.fallbackReason,
    }
  }

  if (testCase.scenario === 'customer_service') {
    // 知识召回评测：不发散给模型，只看「该命中的条款有没有被召回」
    const hits = await searchKnowledge(testCase.input, 4)
    const wantTitle = String(expected.chunkTitleContains ?? '')
    const passed = wantTitle
      ? hits.some((hit) => hit.title.includes(wantTitle))
      : hits.length > 0
    return {
      id: testCase.id,
      input: testCase.input,
      passed,
      failed: passed ? [] : [`未召回标题含「${wantTitle}」的知识切片`],
      expected,
      actual: hits.map((hit) => hit.title),
      latencyMs: Date.now() - startedAt,
      degraded: false,
      fallbackReason: null,
    }
  }

  return {
    id: testCase.id,
    input: testCase.input,
    passed: false,
    failed: [`暂不支持的评测场景：${testCase.scenario}`],
    expected,
    actual: null,
    latencyMs: Date.now() - startedAt,
    degraded: false,
    fallbackReason: 'unsupported',
  }
}

export async function runEvalSuite(cases: EvalCase[]): Promise<EvalSummary[]> {
  const byScenario = new Map<string, EvalCaseResult[]>()
  for (const testCase of cases) {
    const result = await evaluateCase(testCase)
    const bucket = byScenario.get(testCase.scenario) ?? []
    bucket.push(result)
    byScenario.set(testCase.scenario, bucket)
  }

  return [...byScenario.entries()].map(([scenario, results]) => {
    const latencies = results.map((item) => item.latencyMs)
    const passed = results.filter((item) => item.passed).length
    const degraded = results.filter((item) => item.degraded).length
    return {
      scenario,
      total: results.length,
      passed,
      accuracy: results.length ? Math.round((passed / results.length) * 1000) / 10 : 0,
      avgLatency: latencies.length
        ? Math.round(latencies.reduce((sum, item) => sum + item, 0) / latencies.length)
        : 0,
      p95Latency: percentile(latencies, 0.95),
      degradedRate: results.length ? Math.round((degraded / results.length) * 1000) / 10 : 0,
      cases: results,
    }
  })
}
