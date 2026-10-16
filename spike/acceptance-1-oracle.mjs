/**
 * P6 验收标准 1：**口径对账**。
 *
 * 标准原文：全市场抽样（退市股 / 高分红股 / 长停牌股）× 5–10 年，
 *           自算涨跌幅 vs 东财官方字段最大偏差 < 0.01pp、零不符。
 *
 * ## 两个基准，各查一类错误
 *
 *   ① **东财官方 `pct` 字段**（`checkRawIntegrity`）—— 标准原文要的那个。
 *      注意它是**不复权口径**，所以只在没有除权事件的相邻日之间才可直接比。
 *      实测：东财 `pct` 是"用当日收盘/前日收盘"，而除权日交易所会改前收盘，
 *      因此**除权日的偏差是预期内的**，必须单独归类，不能算"不符"。
 *   ② **BaoStock `pctChg`**（`spike/oracle-baostock.py`）—— **独立厂商**的官方口径。
 *      与①同源比对只能证明"我复现了东财自己的算术"；跨厂商才证明得了"我没算错"。
 *      这就是 P1 的最终验收用它的原因。
 *
 * ## 抽样怎么选（三类各取有代表性的）
 *
 *   - 退市股：名称含「退」，且库内有足够 bar（否则没有可比区间）
 *   - 高分红股：`adj_events` 条数最多的一批（除权日最多 → 最考验复权口径）
 *   - 长停牌股：日期间隔最大的一批（停牌日没有 bar，最容易出序列错位）
 *
 * 用法: node spike/acceptance-1-oracle.mjs [dataDir] [每类样本数]
 */

import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { openStore } from '../lib/data/store.mjs'
import { checkRawIntegrity } from '../lib/data/verify.mjs'

const DIR = process.argv[2] ?? 'spike/out/full-market'
const PER = Number(process.argv[3] ?? 25)

const store = openStore(join(DIR, 'quant.db'))
const raw = store.raw
const all = (s, ...a) => raw.prepare(s).all(...a)
const one = (s, ...a) => raw.prepare(s).get(...a)

console.log(`=== P6 验收标准 1 · 口径对账（${DIR}）===\n`)
const total = one('SELECT count(*) c FROM bars').c
const withPct = one('SELECT count(*) c FROM bars WHERE pct IS NOT NULL').c
console.log(`库内 ${one('SELECT count(*) c FROM codes').c} 只 / ${total} 根 bar`)
console.log(`其中带东财官方 pct 的 ${withPct} 根（${(withPct / total * 100).toFixed(1)}%）`)
console.log(`区间 ${JSON.stringify(one('SELECT min(date) a, max(date) b FROM bars'))}\n`)

// ── 抽样 ────────────────────────────────────────────────────────────────────
const enough = 'HAVING count(*) >= 800'   // 至少约 3 年交易日，才谈得上"5–10 年"的抽样

const delisted = all(`
  SELECT c.code, c.name, count(b.date) n FROM codes c JOIN bars b ON b.code=c.code
  WHERE c.name LIKE '%退%' GROUP BY c.code ${enough} ORDER BY n DESC LIMIT ?`, PER)

const highDiv = all(`
  SELECT c.code, c.name, count(DISTINCT e.date) ev, count(b.date) n
  FROM codes c JOIN adj_events e ON e.code=c.code JOIN bars b ON b.code=c.code
  GROUP BY c.code HAVING ev >= 3 ORDER BY ev DESC, n DESC LIMIT ?`, PER)

// 长停牌：相邻两个 bar 的最大日期间隔（用 SQL 的窗口函数算）
const longHalt = all(`
  WITH g AS (
    SELECT b.code, b.date, lag(b.date) OVER (PARTITION BY b.code ORDER BY b.date) prev
    FROM bars b
  ), m AS (
    -- 注意：date - prev 是 YYYYMMDD 整数相减，不是天数（20240110-20231225 = 8885 而实际 16 天）。
    -- 这里用 julianday 转成真实天数差。
    SELECT code,
           max(CAST(julianday(substr(date,1,4)||'-'||substr(date,5,2)||'-'||substr(date,7,2))
                 - julianday(substr(prev,1,4)||'-'||substr(prev,5,2)||'-'||substr(prev,7,2)) AS INTEGER)) gap,
           count(*) n
    FROM g WHERE prev IS NOT NULL GROUP BY code ${enough}
  )
  SELECT m.code, c.name, m.gap, m.n FROM m JOIN codes c ON c.code=m.code
  ORDER BY m.gap DESC LIMIT ?`, PER)

const pick = (rows, kind) => rows.map((r) => ({ ...r, kind }))
const sample = [
  ...pick(delisted, 'delisted'),
  ...pick(highDiv, 'high-dividend'),
  ...pick(highDiv.length ? [] : [], 'x'),   // 占位：保持结构清晰
  ...pick(longHalt, 'long-halt'),
].filter((x) => x.kind !== 'x')

console.log('── 抽样 ──')
console.log(`  退市股 ${delisted.length} 只（如 ${delisted.slice(0, 3).map((r) => r.code + ' ' + r.name).join('、')}）`)
console.log(`  高分红 ${highDiv.length} 只（事件数最多 ${highDiv[0]?.ev ?? 0}）`)
console.log(`  长停牌 ${longHalt.length} 只（最大间隔 ${longHalt[0]?.gap ?? 0} 个自然日）`)
console.log(`  合计 ${sample.length} 只\n`)

// ── ① vs 东财官方 pct ───────────────────────────────────────────────────────
// **关键更正**：东财 kline 的 `pct` 是**不复权口径**，也就是朴素的 `今收/昨收−1` ——
// 它在除权日**不会**改用交易所参考价。所以正确的做法是**所有交易日一起比**。
// 第一版按"除权日要剔除"来写，把本来吻合的日子当成异常，又用参考价去"还原"，
// 反而把吻合的算成了差 4pp（见脚本历史）。
console.log('── ① vs 东财官方 pct 字段（不复权口径 = 朴素今收/昨收）──')
let worstAll = null
let totChecked = 0, totOver = 0, totExcluded = 0
const perCode = []
for (const s of sample) {
  const bars = store.bars(s.code)
  const exDates = new Set(store.adjEvents(s.code).map((e) => e.date))
  let maxDev = 0, over = 0, checked = 0, worst = null, onExDates = 0
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1], cur = bars[i]
    if (!prev.close || cur.pct == null) continue
    const calc = (cur.close / prev.close - 1) * 100
    const dev = Math.abs(calc - cur.pct)
    checked++
    if (exDates.has(cur.date)) onExDates++
    if (dev > maxDev) { maxDev = dev; worst = { date: cur.date, official: cur.pct, calc: +calc.toFixed(4) } }
    if (dev > 0.01) over++
  }
  totChecked += checked; totOver += over; totExcluded += onExDates
  if (!worstAll || maxDev > worstAll.maxDeviationPp) worstAll = { code: s.code, name: s.name, maxDeviationPp: +maxDev.toFixed(6), worst }
  perCode.push({ ...s, checked, maxDeviationPp: +maxDev.toFixed(6), over001pp: over, exDatesIncluded: onExDates, worst })
}

const withData = perCode.filter((p) => p.checked > 0)
console.log(`  有官方 pct 可比对的样本 ${withData.length}/${sample.length} 只，共 ${totChecked} 天`)
console.log(`  其中除权日 ${totExcluded} 天（**已包含在比对里** —— 东财 pct 本来就是不复权口径）`)
console.log(`  超过 0.01pp 的天数：${totOver}`)
console.log(`  最大偏差：${worstAll?.maxDeviationPp ?? 'n/a'} pp（${worstAll?.code} ${worstAll?.name} ${worstAll?.worst?.date ?? ''}）`)
console.log(`  最差 5 只：`)
for (const p of [...withData].sort((a, b) => b.maxDeviationPp - a.maxDeviationPp).slice(0, 5)) {
  console.log(`    ${p.code} ${String(p.name).trim()} [${p.kind}] 偏差 ${p.maxDeviationPp}pp / 超阈 ${p.over001pp} 天 / 可比 ${p.checked} 天`)
}
const pass1 = totOver === 0 && (worstAll?.maxDeviationPp ?? 1) < 0.01 && withData.length > 0
console.log(`  → ${pass1 ? '✅ 通过' : '❌ 未通过'}（判据：最大偏差 < 0.01pp 且超阈天数 = 0）\n`)

// ── ② 这个基准的**分辨率上限**（说清它能证明什么、不能证明什么）────────────
// 东财 `pct` 只有 2 位小数，所以任何算法与它的偏差都 ≤ 0.005pp ——
// 也就是说这个比对**分辨不了 0.005pp 以内的错误**。它能抓的是"算错一个数量级"这类粗错
// （例如拿复权价去算涨跌幅、或日期错位一天）。
// 真正细粒度的复权口径校验要靠**独立厂商**（BaoStock 的 `pctChg`/`preclose`）。
console.log('── ② 东财 pct 的分辨率上限（这个基准的边界）──')
const devs = perCode.filter((p) => p.checked > 0).map((p) => p.maxDeviationPp)
const maxQ = devs.length ? Math.max(...devs) : null
console.log(`  东财 pct 是 2 位小数 → 偏差的理论地板就是 0.005pp`)
console.log(`  实测最大偏差 ${maxQ} pp${maxQ !== null && maxQ <= 0.0050001 ? '，正好落在舍入地板上（说明算法与它逐位一致）' : ''}`)
console.log(`  → 这个基准只能证明"没有算错一个数量级"，证明不了 0.005pp 以内的精度；`)
console.log(`     细粒度复权口径校验见 ③（BaoStock，独立厂商）与 spike/GATE-FINDINGS.md。\n`)

// ── 结果落盘 ────────────────────────────────────────────────────────────────
const result = {
  dir: DIR, at: new Date().toISOString(),
  db: { codes: one('SELECT count(*) c FROM codes').c, bars: total, withOfficialPct: withPct, pctCoverage: +(withPct / total).toFixed(4) },
  sample: { delisted: delisted.length, highDividend: highDiv.length, longHalt: longHalt.length, total: sample.length },
  emPct: {
    comparableCodes: withData.length, checkedDays: totChecked, excludedExDates: totExcluded,
    over001pp: totOver, maxDeviationPp: worstAll?.maxDeviationPp ?? null, worst: worstAll,
    pass: pass1, perCode,
  },
  emPctResolution: { quantumPp: 0.005, observedMaxPp: maxQ, note: '东财 pct 只有 2 位小数，0.005pp 是舍入地板，不是精度证明' },
}
mkdirSync(DIR, { recursive: true })
writeFileSync(join(DIR, 'acceptance-1.json'), JSON.stringify(result, null, 2))
console.log(`结果已写入 ${DIR}/acceptance-1.json`)

// ── ③ 产出一个**只含抽样**的库，交给 BaoStock oracle 做独立校验 ──────────────
// 为什么必须单独一个库：`spike/oracle-baostock.py` 会遍历库里**每一只**股票，
// 而 BaoStock 是每只一次查询 —— 直接跑 5923 只既慢又对源站不礼貌。
// 抽样库同时也是一份可归档的验收证据。
const SAMPLE_DB = join(DIR, 'acceptance-1-sample.db')
try {
  rmSync(SAMPLE_DB, { force: true })
  const out = new DatabaseSync(SAMPLE_DB)
  out.exec(`ATTACH DATABASE '${join(DIR, 'quant.db')}' AS src`)
  for (const t of ['codes', 'bars', 'bars_hfq', 'adj_events']) {
    // 从**主连接**读 DDL（`src.sqlite_master` 在 node:sqlite 的预编译语句里解析不了）
    const ddl = one(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, t)
    if (ddl?.sql) out.exec(ddl.sql)
  }
  const codes = [...new Set(sample.map((s) => s.code))]
  const ph = codes.map(() => '?').join(',')
  out.exec('BEGIN')
  for (const t of ['codes', 'bars', 'bars_hfq', 'adj_events']) {
    out.prepare(`INSERT INTO ${t} SELECT * FROM src.${t} WHERE code IN (${ph})`).run(...codes)
  }
  out.exec('COMMIT')
  out.exec('DETACH DATABASE src')
  const n = (t) => out.prepare(`SELECT count(*) c FROM ${t}`).get().c
  console.log(`\n抽样库已生成 ${SAMPLE_DB}`)
  console.log(`  ${n('codes')} 只 / ${n('bars')} 根 bar / ${n('adj_events')} 个复权事件`)
  console.log(`  下一步：python3 spike/oracle-baostock.py ${SAMPLE_DB} spike/out`)
  out.close()
} catch (e) {
  console.log(`\n⚠️ 抽样库生成失败：${e.message}`)
}

store.close()
process.exit(pass1 ? 0 : 1)
