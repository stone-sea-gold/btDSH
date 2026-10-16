/**
 * P2 因子 DSL 冒烟测试。
 *
 * 1) 把 AIFUND5 的 109 个内置因子逐条编译，统计成功 / 不支持 / 报错
 * 2) 在真实仓库（spike/out/p1-verify.db，新浪原始价）上执行若干因子，并与手算对照
 *
 * 用法: node spike/dsl-smoke.mjs [AIFUND5因子文件] [db路径]
 */

import { readFileSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { compileFactor, parse, validate, FUNCTIONS } from '../lib/factors/dsl.mjs'

const FACTORS = process.argv[2] ?? '/home/generalblack/code/works/AIFUND5/factors/builtin/factors.json'
const DB = process.argv[3] ?? 'spike/out/p1-verify.db'
const FIELD_MAP = { turnover_rate: 'turnover' }

// ── 1) 全量编译 ─────────────────────────────────────────────────────────────
const factors = existsSync(FACTORS) ? JSON.parse(readFileSync(FACTORS, 'utf8')) : []
const ok = [], unsupported = [], failed = []
const byFunc = {}
for (const f of factors) {
  const r = compileFactor(f.formula ?? '', { fieldMap: FIELD_MAP })
  for (const fn of r.meta?.functions ?? []) byFunc[fn] = (byFunc[fn] ?? 0) + 1
  if (r.ok) ok.push({ id: f.id, layers: r.meta.layerCount, maxWindow: r.meta.maxWindow })
  else if (r.error.code === 'UNSUPPORTED_FUNCTION') unsupported.push({ id: f.id, why: r.error.message, formula: f.formula })
  else failed.push({ id: f.id, why: r.error.message, formula: f.formula })
}

console.log(`=== 因子 DSL 编译（${factors.length} 个内置因子）===`)
console.log(`  ✅ 可编译 ${ok.length}   ⏳ 暂不支持 ${unsupported.length}   ❌ 报错 ${failed.length}`)
const unsupportedFuncs = [...new Set(unsupported.flatMap((u) => (u.why.match(/：(.+?)（/) ?? [])[1]?.split(', ') ?? []))]
console.log(`  未实现函数：${unsupportedFuncs.join(', ') || '无'}`)
console.log(`  分层数分布：`, ok.reduce((a, o) => { a[o.layers] = (a[o.layers] ?? 0) + 1; return a }, {}))
console.log(`  最大窗口：`, Math.max(...ok.map((o) => o.maxWindow ?? 0), 0))
if (failed.length) { console.log('  报错样例：'); for (const f of failed.slice(0, 5)) console.log(`    ${f.id}: ${f.why}`) }

// ── 2) 安全边界用例 ─────────────────────────────────────────────────────────
console.log('\n=== 安全边界 ===')
const BAD = [
  ['未知字段', '$foo / $close'],
  ['未知函数', 'Evil($close, 5)'],
  ['窗口越界', 'Mean($close, 9999)'],
  ['窗口非字面量', 'Mean($close, $volume)'],
  ['子查询注入', '$close; DROP TABLE bars'],
  ['参数个数', 'Corr($close, 5)'],
]
for (const [name, src] of BAD) {
  const r = compileFactor(src, { fieldMap: FIELD_MAP })
  console.log(`  ${name.padEnd(12)} → ${r.ok ? '❌ 竟然通过' : '✅ 拒绝: ' + r.error.code}`)
}

// ── 3) 真实数据执行对照 ─────────────────────────────────────────────────────
if (!existsSync(DB)) { console.log('\n（跳过执行对照：找不到仓库）'); process.exit(0) }
const db = new DatabaseSync(DB)
const CODE = '600519'
const rows = db.prepare('SELECT date, close FROM bars WHERE code=? ORDER BY date').all(CODE)
console.log(`\n=== 执行对照（${CODE}，${rows.length} 根 bar）===`)

function runFactor(formula, limit = 5) {
  const c = compileFactor(formula, { fieldMap: FIELD_MAP })
  if (!c.ok) return { error: c.error }
  // 编译产物以 `FROM <finalFrom>` 结尾，直接把过滤与排序挂上去
  const sql = `${c.sql} WHERE code = '${CODE}' ORDER BY date DESC LIMIT ${limit}`
  return { rows: db.prepare(sql).all(), layers: c.meta.layerCount }
}

const CASES = [
  { name: 'momentum_1m', formula: '$close / Ref($close, 20) - 1', manual: (i) => rows[i].close / rows[i - 20].close - 1 },
  { name: 'turnover_20d', formula: 'Mean($close, 20)', manual: (i) => rows.slice(i - 19, i + 1).reduce((a, r) => a + r.close, 0) / 20 },
  { name: 'std_ret_20', formula: 'Std($close / Ref($close, 1) - 1, 20)', manual: null },
  { name: 'rsi_like_6', formula: 'Mean(Max($close - Ref($close, 1), 0), 6) / (Mean(Abs($close - Ref($close, 1)), 6) + 1e-12)', manual: null },
  { name: 'hl_ratio_5', formula: 'Max($high, 5) / Min($low, 5)', manual: null, note: '需 high/low 列（当前仓库来自新浪，无 high/low）' },
]

for (const c of CASES) {
  const r = runFactor(c.formula)
  if (r.error) { console.log(`  ${c.name.padEnd(14)} → 编译失败 ${r.error.code}`); continue }
  const i = rows.length - 1
  const last = r.rows[0]
  if (c.manual) {
    const expect = c.manual(i)
    const dev = last && expect ? Math.abs(last.value - expect) : null
    console.log(`  ${c.name.padEnd(14)} → 最新 ${last?.date} = ${last?.value?.toFixed(8)} | 手算 ${expect.toFixed(8)} | 偏差 ${dev?.toExponential(2)} | 层数 ${r.layers}`)
  } else {
    console.log(`  ${c.name.padEnd(14)} → 最新 ${last?.date} = ${last?.value?.toFixed(8)} | 层数 ${r.layers}${c.note ? '  (' + c.note + ')' : ''}`)
  }
}

// 手算一次完整对照（标准差的样本口径）
const rets = []
for (let i = rows.length - 20; i < rows.length; i++) rets.push(rows[i].close / rows[i - 1].close - 1)
const mean = rets.reduce((a, b) => a + b, 0) / rets.length
const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1))
const r20 = runFactor('Std($close / Ref($close, 1) - 1, 20)')
console.log(`  标准差手算（ddof=1）= ${sd.toFixed(8)} | DSL = ${r20.rows?.[0]?.value?.toFixed(8)}`)
db.close()
