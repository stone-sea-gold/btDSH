/**
 * 看板端到端冒烟：真回测 → 导出 HTML → 与 analyze 工具对账。
 *
 * 验的是单测覆盖不到的三件事：
 *   1. 真实回测记录（含全量 nav）走完整条链路不报错
 *   2. 产物体积在预算内（7 年日频 < 900KB）
 *   3. 看板模型里的数字与 `quant_backtest_analyze` **逐项一致**（同源 analyze 层）
 *
 * 用法: node spike/dashboard-smoke.mjs [--out <目录>]
 */

import { mkdtempSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createRuntime } from '../lib/runtime.mjs'
import { backtestTools } from '../lib/tools/backtest.mjs'
import { exportTools } from '../lib/tools/export.mjs'
import { buildBacktestDashboard } from '../lib/dashboard/model.mjs'

const outArg = process.argv.indexOf('--out')
const OUT_DIR = outArg > 0 ? resolve(process.argv[outArg + 1]) : resolve('quant-exports')

let pass = 0, fail = 0
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`✅ ${label}${detail ? `  ${detail}` : ''}`) }
  else { fail++; console.log(`❌ ${label}${detail ? `  ${detail}` : ''}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-quant-dashsmoke-'))
if (existsSync('spike/out/p1-verify.db')) copyFileSync('spike/out/p1-verify.db', join(dir, 'quant.db'))
const runtime = createRuntime({ dataDir: dir })

const btTools = backtestTools(runtime)
const run = btTools.find((t) => t.name === 'quant_backtest_run')
const analyze = btTools.find((t) => t.name === 'quant_backtest_analyze')
const exp = exportTools(runtime).find((t) => t.name === 'quant_export')

console.log('=== 看板端到端冒烟 ===\n')

const res = await run.execute({
  strategyId: 'dashboard_smoke',
  config: {
    name: '看板冒烟', factors: [{ id: 'momentum_1m', formula: '$close / Ref($close, 20) - 1' }],
    selection: { rule: 'top_k', k: 3 }, rebalance: 'monthly', weight: 'equal',
    start: 20200101, end: 20241231, initialCash: 1_000_000,
  },
  confirm: true,
}, {})
if (res.ok === false) {
  console.error(`❌ 回测失败：${JSON.stringify(res.error)}`)
  process.exit(1)
}
check('回测跑通', true, `${res.backtestId}  ${res.days} 个交易日  成交 ${res.metrics.trades} 笔`)
check('口径声明已归档', Array.isArray(res.caveats) && res.caveats.length > 0)

const record = runtime.store().getBacktest(res.backtestId)
check('归档记录含 caveats', Array.isArray(record.metrics?.caveats), `metrics.caveats=${(record.metrics?.caveats ?? []).length} 条`)

const model = buildBacktestDashboard(record, { source: 'export' })
const kpi = Object.fromEntries(model.runs[0].kpis.map((k) => [k.id, k.value]))
check('模型总收益与回测指标一致', kpi.totalReturn === record.metrics.totalReturn)
check('模型最大回撤与回测指标一致', kpi.maxDrawdown === record.metrics.maxDrawdown)

// 与 analyze 工具逐项对账：分年度 / 回撤段 / 费用
const ana = await analyze.execute({ backtestId: res.backtestId, topDrawdowns: 3 }, {})
check('analyze 工具可用', ana.ok === true)
const sameYearly = JSON.stringify(ana.yearly) === JSON.stringify(model.runs[0].yearly)
check('分年度与 analyze 一致', sameYearly, `${ana.yearly?.length} 个年度`)
const sameDD = JSON.stringify(ana.drawdowns) === JSON.stringify(model.runs[0].drawdowns.slice(0, 3))
check('回撤段与 analyze 一致', sameDD, `${model.runs[0].drawdowns.length} 段`)
check('费用合计一致', ana.costShare.fees === model.runs[0].costs.fees, `¥${ana.costShare.fees}`)

const out = await exp.execute(
  { kind: 'backtest', backtestId: res.backtestId, format: 'html', filename: `smoke-${res.backtestId}` },
  { agent: { session: { header: { cwd: OUT_DIR } } } },
)
if (out.ok === false) {
  console.error(`❌ 导出失败：${JSON.stringify(out.error)}`)
  process.exit(1)
}
const file = out.files[0]
const kb = statSync(file.path).size / 1024
check('导出 html 成功', file.format === 'html', `${file.filename}`)
check('体积在预算内', kb < 900, `${kb.toFixed(0)} KB`)
check('落点正确', file.path.includes('quant-exports') || file.path.includes(OUT_DIR))

console.log(`\n产物：${file.path}`)
console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===`)
rmSync(dir, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
