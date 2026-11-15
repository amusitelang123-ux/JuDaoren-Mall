import type { EvalCase } from './runner'

/**
 * 评测集命令行：`npm run ai:eval [-- --mock] [--scenario=search_parse] [--threshold=85]`
 *
 * 输出：按场景的准确率、降级率、平均/P95 延迟，以及每条失败用例的原因。
 * 退出码：准确率低于阈值（默认 0）时返回 1，可以挂到 CI。
 *
 * 注意：`--mock` 必须在加载 config 之前写入 process.env，
 * 所以这里用 require 延迟加载业务模块（config 在模块初始化时就读取了环境变量）。
 */

interface Args {
  mock: boolean
  threshold: number
  scenario: string | null
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mock: argv.includes('--mock'),
    threshold: Number(process.env.AI_EVAL_MIN_ACCURACY ?? 0),
    scenario: null,
  }
  const scenarioArg = argv.find((item) => item.startsWith('--scenario='))
  if (scenarioArg) args.scenario = scenarioArg.split('=')[1] || null
  const thresholdArg = argv.find((item) => item.startsWith('--threshold='))
  if (thresholdArg) args.threshold = Number(thresholdArg.split('=')[1] || 0)
  return args
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width, ' ')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.mock) process.env.AI_ADAPTER = 'mock'

  // 延迟加载：保证 AI_ADAPTER 覆盖发生在 config 读取环境变量之前
  const { connectDatabase, sequelize } = require('../../config/database') as typeof import('../../config/database')
  const { AiEvalCase } = require('../../models') as typeof import('../../models')
  const { aiMode } = require('../../adapters/ai') as typeof import('../../adapters/ai')
  const { runEvalSuite } = require('./runner') as typeof import('./runner')

  await connectDatabase()
  const where = args.scenario ? { status: 1, scenario: args.scenario } : { status: 1 }
  const rows = await AiEvalCase.findAll({
    where,
    order: [['id', 'ASC']],
    logging: false,
  })

  if (!rows.length) {
    console.log('[ai:eval] ai_eval_cases 为空，请先执行 npm run db:seed（或导入评测用例）')
    await sequelize.close()
    return 0
  }

  const cases: EvalCase[] = rows.map((row) => ({
    id: Number(row.id),
    module: row.module,
    scenario: row.scenario ?? '',
    input: row.input,
    expectJson: row.expectJson,
    tags: row.tags,
  }))

  const mode = aiMode()
  console.log(
    `[ai:eval] 共 ${cases.length} 条用例，模式=${mode.mode}${mode.usingFallback ? '（未配置 Key，已降级）' : ''}`,
  )

  const summaries = await runEvalSuite(cases)
  let lowest = 100

  for (const summary of summaries) {
    lowest = Math.min(lowest, summary.accuracy)
    console.log('')
    console.log(`── 场景 ${summary.scenario} ─────────────────────────────`)
    console.log(
      `准确率 ${summary.accuracy}%  (${summary.passed}/${summary.total})  ` +
        `降级率 ${summary.degradedRate}%  平均 ${summary.avgLatency}ms  P95 ${summary.p95Latency}ms`,
    )
    console.log('')
    console.log(`${pad('#', 6)}${pad('结果', 8)}${pad('延迟', 9)}${pad('输入', 26)}失败原因`)
    for (const item of summary.cases) {
      console.log(
        `${pad(item.id, 6)}${pad(item.passed ? 'PASS' : 'FAIL', 8)}${pad(`${item.latencyMs}ms`, 9)}${pad(
          item.input.slice(0, 24),
          26,
        )}${item.failed.join(' | ')}`,
      )
    }
  }

  console.log('')
  console.log(`[ai:eval] 最低准确率 ${lowest}%，阈值 ${args.threshold}%`)
  await sequelize.close()

  if (lowest < args.threshold) {
    console.error('[ai:eval] 未达到阈值，退出码 1')
    return 1
  }
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('[ai:eval] 执行失败', error)
    process.exit(1)
  })
