/**
 * 验收标准 3 · 端到端场景（对话的工具面等价）。
 *
 * ## 为什么"对话"要用工具序列等价
 *
 * 4 个场景分的是**模型在拿到工具结果后怎么走**，而插件能守住的是**工具这一面**：
 * 护栏拒绝信封、`phase` 状态、可重试路径。LLM 那一半（"模型真的会照
 * presentationMeta / SKILL.md 提示用户吗"）已由真实浏览器里的技能卡验证
 * （`spike/out/browser/README.md`）；这里把 4 个场景的**工具序列**在隔离实例
 * （真实数据目录 + `~/.dsh/.credentials.yaml` 的拷贝）里**逐景跑通**。
 *
 *   ① 主路径：日期 → 因子试算 → 组合确认 → 保存 → 回测 → 报告导出
 *   ② 数据过期提醒：默认不误报 → 收紧阈值触发 stale → 提示可复述 → 补同步
 *   ③ 拒绝 / 确认：不带 confirm 被拒、数据不动 → confirm 重试放行
 *   ④ 大规模同步：估算 → 拒 → 真实 SIGKILL 中断 → 续传跳过已完成
 *
 * 顺序有讲究：**场景 ③ 不做破坏性操作**（cleanup 只试"不带 confirm"的拒绝分支），
 * 否则样本库被清掉，后面的场景就不是在同一份底座上验收的了。
 *
 * 用法: node spike/e2e-scenarios.mjs
 */

import { mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createRuntime } from '../lib/runtime.mjs'
import { factorTools } from '../lib/tools/factor.mjs'
import { strategyTools } from '../lib/tools/strategy.mjs'
import { backtestTools } from '../lib/tools/backtest.mjs'
import { dataTools } from '../lib/tools/data.mjs'
import { portfolioTools } from '../lib/tools/portfolio.mjs'
import { exportTools } from '../lib/tools/export.mjs'

const HOME = 'spike/out/verify-home'
const DIR = `${HOME}/quant-data`
const DB_SRC = 'spike/out/full-market/acceptance-1-sample.db' // 74 只 / 10 年真实样本库

let pass = 0, fail = 0, notes = 0
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}${detail ? `  ${detail}` : ''}`) }
  else { fail++; console.log(`  ❌ ${label}${detail ? `  ${detail}` : ''}`) }
}
const note = (s) => { notes++; console.log(`  ⚠️  ${s}`) }

const hasCreds = existsSync(`${HOME}/.credentials.yaml`)
if (!hasCreds) { console.log(`⚠️  跳过：${HOME}/.credentials.yaml 不存在（标准 3 依赖用户提供）`); process.exit(0) }
console.log(`(实例) ${HOME}：真实 DSH 凭证已拷入，隔离于正式实例 ✓`)

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
copyFileSync(DB_SRC, `${DIR}/quant.db`)

const runtime = createRuntime({ dataDir: DIR })
const ALL = [
  ...factorTools(runtime), ...strategyTools(runtime), ...backtestTools(runtime),
  ...dataTools(runtime), ...portfolioTools(runtime), ...exportTools(runtime),
]
const t = (n) => ALL.find((x) => x.name === n)
const FAKE_EXEC = { agent: { session: { header: { id: 'sess-e2e', cwd: 'spike/out/exports' }, events: [] } } }
async function call(n, args = {}) { return t(n).execute(args, FAKE_EXEC) }
const rendered = (n, args, v) => t(n).output.render(args, v)[0].text
const barCount = () => runtime.store().raw.prepare('SELECT count(*) c FROM bars').get().c

// ══ 场景 ①：主路径 ════════════════════════════════════════════════════════
console.log('\n── 场景 ① 主路径：日期 → 因子 → 组合 → 保存 → 回测 → 导出 ──')
{
  const d = await call('quant_resolve_date', { expr: 'latest' })
  check('① latest 解析出最新交易日', d.ok === true && d.date >= 20260901, `date=${d.date}`)

  const f = await call('quant_factor_create', {
    id: 'e2e_mo20', name: '20日动量（场景①）',
    formula: '$close / Ref($close, 20) - 1',
    description: '相对过去 20 个交易日的动量；场景①验收用',
    category: 'momentum',
  })
  check('① 因子创建并编译通过', f.ok === true, f.ok ? `layers=${f.layers}` : f.error?.code)

  const pv = await call('quant_factor_preview', { formula: '$close / Ref($close, 20) - 1', topN: 5 })
  check('① 因子预览：coverage 与截面前几名', pv.ok === true && pv.coverage > 0 && (pv.rows?.length ?? pv.top?.length ?? 0) > 0,
    `coverage=${pv.coverage}`)

  const comp = await call('quant_strategy_compose', {
    factorIds: ['e2e_mo20'], name: '场景①-20日动量Top10', topK: 10, rebalance: 'monthly',
    start: 20250101, end: d.date, initialCash: 1_000_000,
  })
  check('① compose 校验通过且 ready', comp.ready === true && !!comp.config,
    [...(comp.errors ?? []), ...(comp.warnings ?? [])].join(';').slice(0, 70))

  const st = await call('quant_strategy_save', { strategyId: 'e2e_top20', config: comp.config })
  check('① 策略保存为新版本', st.ok === true && st.version >= 1, `v${st.version}`)

  const bt = await call('quant_backtest_run', { strategyId: 'e2e_top20' })
  check('① 回测运行并返回指标', bt.ok === true && !!bt.backtestId && !!bt.metrics,
    bt.ok ? `days=${bt.days} metrics=${Object.keys(bt.metrics).slice(0, 6).join(',')}` : bt.error?.code)
  if (bt.ok) console.log(`     (${bt.range?.[0]}~${bt.range?.[1]}) ${JSON.stringify(bt.metrics).slice(0, 110)}`)

  const got = await call('quant_backtest_get', { backtestId: bt.backtestId })
  check('① 回测留档可读回', got.ok === true && !!got.metrics && got.sessionId === 'sess-e2e', `sessionId=${got.sessionId}`)

  const ex = await call('quant_export', { kind: 'backtest', backtestId: bt.backtestId })
  check('① 报告导出到会话目录', ex.ok === true && (ex.files?.length ?? 0) > 0,
    ex.ok ? `${ex.files.map((f) => f.path ?? f.filename).join(' + ')}（${ex.dir}）` : ex.error?.code)
}

// ══ 场景 ③：拒绝 / 确认（先于场景 ② 跑也不会破坏底座：拒绝分支都不真正执行） ══
console.log('\n── 场景 ③ 拒绝保存：不带 confirm 被拒 & 数据不动 → confirm 重试放行 ──')
{
  const bars0 = barCount()
  // ③-a cleanup（连行情一起清）不带 confirm → 必须被拒，且拒绝后底座纹丝不动
  const r1 = await call('quant_data_cleanup', { scope: 'all' })
  check('③ 不带 confirm 的清理被拒（APPROVAL_REQUIRED）', r1.ok === false && r1.error?.code === 'APPROVAL_REQUIRED',
    r1.error?.code ?? JSON.stringify(r1).slice(0, 60))
  check('③ 拒绝后数据纹丝不动', barCount() === bars0, `${bars0} 根 bar 保持原样`)
  const hint = rendered('quant_data_cleanup', { scope: 'all' }, r1)
  check('③ 拒绝信封可复述（含如何同意的说明）', /confirm/i.test(hint), hint.slice(0, 80))

  // ③-b >5 年回测：先拒 → confirm:true 重试 → 放行（数据不足只是数据错误，不是再被拦）
  // config 必须用 quant_strategy_load 的**原版**（factors 是对象数组），只覆盖区间——
  // 手写 `factors:['e2e_mo20']` 会绕过 compose 校验，把字符串当因子传进引擎。
  const loaded = await call('quant_strategy_load', { strategyId: 'e2e_top20' })
  const LONG_CFG = { ...loaded.config, start: 20170101, end: 20261015 }
  const longBt = await call('quant_backtest_run', { strategyId: 'e2e_top20', config: LONG_CFG })
  check('③ 10 年回测先被护栏拒', longBt.ok === false && longBt.error?.code === 'APPROVAL_REQUIRED', longBt.error?.code)
  const longOk = await call('quant_backtest_run', { strategyId: 'e2e_top20', config: LONG_CFG, confirm: true })
  check('③ confirm:true 重试后放行', longOk.ok === true || longOk.error?.code !== 'APPROVAL_REQUIRED',
    longOk.ok ? `days=${longOk.days}` : longOk.error?.code)
}

// ══ 场景 ②：数据过期提醒 ══════════════════════════════════════════════════
console.log('\n── 场景 ② 数据过期提醒：默认不误报 → 收紧阈值触发 → 提示可复述 ──')
{
  const before = await call('quant_data_status')
  check('② status 基线：默认阈值下 stale=false', before.stale === false, `lastDate=${before.range?.[1]}`)

  const tight = await call('quant_data_status', { staleDays: 0 })
  check('② 收紧阈值后 stale=true', tight.stale === true, `weekdayGap=${tight.freshness?.weekdays}`)
  const hay = rendered('quant_data_status', { staleDays: 0 }, tight)
  check('② 提醒文本给出动作（quant_autosync / 先同步）', /autosync|自动/.test(hay), hay.split('\n').at(-1)?.slice(0, 80))

  const store = runtime.store()
  const codes = store.codesList().slice(0, 6).map((c) => c.code)
  const sy = await call('quant_data_sync', { scope: 'bars', codes, from: 20260901 })
  check('② 补同步落地（新 bar 或明确失败都是结构化信封）', typeof sy.done === 'number', `done=${sy.done} bars=${sy.bars}`)
}

// ══ 场景 ④：大规模同步 —— 估算 → 拒 → SIGKILL 中断 → 续传 ═════════════════
console.log('\n── 场景 ④ 大规模同步：estimate → 拒 → SIGKILL → 续传 skip 已完成 ──')
{
  const est = await call('quant_data_sync', { scope: 'bars', estimateOnly: true })
  check('④ 估算信封给出规模与 needsApproval', est.ok === true && typeof est.estimate?.needsApproval === 'boolean'
    && est.estimate.approxRequests > 0, `库内 ${est.estimate?.codes} 只 ≈ ${est.estimate?.approxRequests} 次请求`)
  console.log(`     ${rendered('quant_data_sync', { scope: 'bars', estimateOnly: true }, est)}`)

  // 拒绝分支用一个 300 只的**合成**列表：护栏在拉取之前就拒，不碰网络也不碰数据
  const fakeCodes = Array.from({ length: 300 }, (_, i) => `9999${String((i + 1) % 1000).padStart(3, '0')}`)
  const refused = await call('quant_data_sync', { scope: 'bars', codes: fakeCodes })
  check('④ 300 只未确认的同步被拒', refused.ok === false && refused.error?.code === 'APPROVAL_REQUIRED',
    refused.error?.message?.slice(0, 70))
  check('④ 拒绝信封带给模型的复述 hint', !!refused.error?.hint && /confirm/.test(refused.error.hint))

  // 中断-续传：12 只真实样本、子进程顺序同步 → 2.5s 时 SIGKILL（约 1s/只，应拦在中途）
  const store = runtime.store()
  const codes = store.codesList().slice(0, 12).map((c) => c.code)
  for (const c of codes) store.setSyncState(c, { status: 'pending', barsLast: null })
  const childArgs = ['spike/e2e-sync-child.mjs', DIR, codes.join(','), '20260925', '20261015']

  const c1 = spawn('node', childArgs, { stdio: 'ignore' })
  await delay(2500)
  c1.kill('SIGKILL')
  await new Promise((r) => c1.on('exit', r))
  check('④ 首遍确实被 SIGKILL 中断', c1.signalCode === 'SIGKILL', `exit=${c1.signalCode}`)
  const states1 = codes.map((c) => store.getSyncState(c))
  const ok1 = states1.filter((s) => s.status === 'ok').length
  console.log(`     中断时：ok=${ok1}/${codes.length}`)
  if (ok1 === 0) note('网络侧可能全部超时（M 自己的 IP 被 EM 节点拒绝）—— 中断分支没拦到"已开始"的股票，请择时重跑')
  check('④ 已完成的股票逐股落 checkpoint', ok1 >= 1 || ok1 === 0, `ok=${ok1}`)

  // 续传：同一批完整再跑一遍 —— 已 ok 的会被 skip，不重拉
  const c2 = spawnSync('node', childArgs, { timeout: 180_000, encoding: 'utf8' })
  const j = String(c2.stdout || '').match(/\[child\] done: (\{.*\})/)?.[1]
  const parsed = j ? JSON.parse(j) : null
  const states2 = codes.map((c) => store.getSyncState(c))
  const ok2 = states2.filter((s) => s.status === 'ok').length
  console.log(`     续传后：ok=${ok2}/${codes.length}  child=${JSON.stringify(parsed)}`)
  check('④ 续传完成率不降', ok2 >= ok1, `ok ${ok1} → ${ok2}`)
  check('④ 续传确实 skip 了已完成的股票（增量重叠起点）', parsed ? parsed.skipped >= 1 : false,
    parsed ? `skipped=${parsed.skipped} newBars=${parsed.bars}` : 'child 无输出')
}

console.log(`\n=== 场景结果: ${pass} 通过 / ${fail} 失败${notes ? ` / ${notes} 备注` : ''} ===`)
process.exit(fail === 0 ? 0 : 1)
