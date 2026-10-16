/**
 * P0-G3 v2 — 全市场规模性能实测（修正版）
 *
 * v1 结论与修正：
 *   1. 物化后回测仍 19.1s → 面板必须**连排名一起物化**（rank 列），回测阶段只做过滤
 *   2. 库体积 1706MB 超标 → 复权因子改为**事件表**（只在除权日一行），而非逐日一行
 *
 * v2 验证上述两处修正后能否达到门限：
 *   G3b 单因子全市场物化（含 rank）≤ 60s
 *   G3c 物化后单次回测 ≤ 2s
 *   G3e 库体积 ≤ 1536MB
 *   G3f 峰值 RSS ≤ 1536MB
 *
 * 用法: node spike/p0-sqlite-bench-v2.mjs [股数] [天数]
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const N_STOCK = Number(process.argv[2] ?? 5400)
const N_DAY = Number(process.argv[3] ?? 1600)
const OUT_DIR = 'spike/out'
const DB_DIR = join(OUT_DIR, 'db')
const DB_PATH = join(DB_DIR, `benchv3_${N_STOCK}x${N_DAY}.db`)

const report = { params: { stocks: N_STOCK, days: N_DAY, dbPath: DB_PATH }, steps: {} }
const rss = () => Math.round(process.memoryUsage().rss / 1048576)
const mb = (b) => +(b / 1048576).toFixed(1)
const timed = (fn) => { const t = performance.now(); const v = fn(); return { ms: Math.round(performance.now() - t), value: v } }

await mkdir(DB_DIR, { recursive: true })
await rm(DB_PATH, { force: true })

const db = new DatabaseSync(DB_PATH)
for (const p of ['journal_mode=WAL', 'synchronous=NORMAL', 'cache_size=-262144', 'temp_store=memory', 'mmap_size=268435456']) db.exec(`PRAGMA ${p}`)

db.exec(`
  CREATE TABLE codes(code TEXT PRIMARY KEY, name TEXT, board TEXT, list_date INTEGER, delist_date INTEGER) WITHOUT ROWID;
  CREATE TABLE bars(
    code TEXT NOT NULL, date INTEGER NOT NULL,
    open REAL, high REAL, low REAL, close REAL, volume REAL, amount REAL,
    PRIMARY KEY(code, date)
  ) WITHOUT ROWID;
  -- 事件表：只在复权因子发生变化的日期存一行（阶梯函数）
  CREATE TABLE adj_events(code TEXT NOT NULL, date INTEGER NOT NULL, factor REAL, PRIMARY KEY(code,date)) WITHOUT ROWID;
  -- 面板：value + rank 一起物化
  CREATE TABLE factor_panel(
    factor_id TEXT NOT NULL, date INTEGER NOT NULL, rank INTEGER NOT NULL,
    code TEXT NOT NULL, value REAL,
    PRIMARY KEY(factor_id, date, rank)
  ) WITHOUT ROWID;
`)

// ── 数据生成 ────────────────────────────────────────────────────────────────
let seed = 42
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const dates = []
for (let i = 0; dates.length < N_DAY; i++) {
  const dt = new Date(Date.UTC(2020, 0, 1) + i * 86400000)
  const wd = dt.getUTCDay()
  if (wd !== 0 && wd !== 6) dates.push(dt.getUTCFullYear() * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate())
}
const codeOf = (s) => (s % 2 === 0 ? 'sh' : 'sz') + String(600000 + s).padStart(6, '0')

const insBar = db.prepare('INSERT INTO bars(code,date,open,high,low,close,volume,amount) VALUES(?,?,?,?,?,?,?,?)')
const insCode = db.prepare('INSERT INTO codes(code,name,board,list_date,delist_date) VALUES(?,?,?,?,NULL)')

const write = timed(() => {
  db.exec('BEGIN')
  for (let s = 0; s < N_STOCK; s++) {
    insCode.run(codeOf(s), `股票${s}`, s % 3 === 0 ? 'main' : 'gem', dates[0])
    let p = 20
    for (let d = 0; d < N_DAY; d++) {
      p = Math.max(1, p * (1 + (rnd() - 0.5) * 0.04))
      insBar.run(codeOf(s), dates[d], p * 0.995, p * 1.02, p * 0.98, p, Math.floor(rnd() * 1e7), p * 1e6)
    }
  }
  db.exec('COMMIT')
  return N_STOCK * N_DAY
})
report.steps.writeBars = { rows: write.value, ms: write.ms, rowsPerSec: Math.round(write.value / (write.ms / 1000)), rssMb: rss() }

// 复权事件：每只每年 1–2 次
const insEv = db.prepare('INSERT INTO adj_events(code,date,factor) VALUES(?,?,?)')
const adj = timed(() => {
  db.exec('BEGIN')
  let rows = 0
  for (let s = 0; s < N_STOCK; s++) {
    const code = codeOf(s)
    let factor = 1
    for (let y = 0; y < Math.ceil(N_DAY / 250); y++) {
      const evPerYear = 1 + (s + y) % 2
      for (let e = 0; e < evPerYear; e++) {
        const d = dates[Math.min(N_DAY - 1, y * 250 + 60 + e * 120)]
        factor *= 1 + (rnd() * 0.03)
        insEv.run(code, d, +factor.toFixed(6)); rows++
      }
    }
  }
  db.exec('COMMIT')
  return rows
})
report.steps.writeAdjEvents = { rows: adj.value, ms: adj.ms, rssMb: rss() }

const idx = timed(() => { db.exec('CREATE INDEX idx_bars_date_code ON bars(date, code)'); return true })
report.steps.createBarsIndex = { ms: idx.ms }
const idx2 = timed(() => { db.exec('CREATE INDEX idx_adj_code_date ON adj_events(code, date)'); return true })
report.steps.createAdjIndex = { ms: idx2.ms }

// ── 物化：value + rank ──────────────────────────────────────────────────────
const mat = timed(() => {
  db.exec(`
    INSERT INTO factor_panel(factor_id, date, rank, code, value)
    SELECT 'momentum_20', date, rnk, code, value FROM (
      SELECT code, date, value,
             row_number() OVER (PARTITION BY date ORDER BY value DESC, code) AS rnk
      FROM (
        SELECT code, date, close / lag(close, 20) OVER (PARTITION BY code ORDER BY date) - 1 AS value
        FROM bars
      )
      WHERE value IS NOT NULL
    )
    WHERE rnk <= 500
  `)
  return db.prepare("SELECT count(*) c FROM factor_panel WHERE factor_id='momentum_20'").get().c
})
report.steps.materializeWithRank = { topN: 500, rows: mat.value, ms: mat.ms, rssMb: rss() }

// ── 回测①：面板命中（过滤即取 Top-K，无需窗口函数） ────────────────────────
function backtestPanel(topK, beg, end) {
  return db.prepare(`
    WITH sel AS (
      SELECT code, date FROM factor_panel
      WHERE factor_id='momentum_20' AND rank<=? AND date BETWEEN ? AND ?
    ), px AS (
      SELECT b.code, b.date, b.close FROM bars b JOIN sel s ON s.code=b.code AND s.date=b.date
    ), ret AS (
      SELECT code, date, lead(close) OVER (PARTITION BY code ORDER BY date)/close - 1 AS r1 FROM px
    )
    SELECT count(*) n, avg(r1) m FROM ret WHERE r1 IS NOT NULL
  `).get(topK, beg, end)
}

const bt = timed(() => backtestPanel(50, dates[30], dates[N_DAY - 1]))
report.steps.backtestPanelTop50 = { ms: bt.ms, sample: bt.value }

const bt200 = timed(() => backtestPanel(200, dates[30], dates[N_DAY - 1]))
report.steps.backtestPanelTop200 = { ms: bt200.ms, sample: bt200.value }

// ── 回测②：参数扫描（10 组 top_k） ─────────────────────────────────────────
const sweep = timed(() => {
  const out = []
  for (const k of [20, 30, 40, 50, 60, 70, 80, 90, 100, 150]) out.push(backtestPanel(k, dates[30], dates[N_DAY - 1]).m)
  return out.length
})
report.steps.sweep10TopK = { runs: sweep.value, ms: sweep.ms }

// ── 对照：不物化实时算 ──────────────────────────────────────────────────────
const live = timed(() => {
  return db.prepare(`
    WITH f AS (SELECT code, date, close, lag(close,20) OVER (PARTITION BY code ORDER BY date) AS lag_close FROM bars),
         s AS (SELECT code, date, close/lag_close - 1 AS value FROM f WHERE lag_close IS NOT NULL),
         rk AS (SELECT code, date, value, rank() OVER (PARTITION BY date ORDER BY value DESC) AS rnk FROM s),
         sel AS (SELECT code, date FROM rk WHERE rnk <= 50),
         px AS (SELECT b.code, b.date, b.close FROM bars b JOIN sel s ON s.code=b.code AND s.date=b.date),
         ret AS (SELECT code, date, lead(close) OVER (PARTITION BY code ORDER BY date)/close - 1 AS r1 FROM px)
    SELECT count(*) n, avg(r1) m FROM ret WHERE r1 IS NOT NULL
  `).get()
})
report.steps.backtestLive = { ms: live.ms, sample: live.value }

// ── 体积 ────────────────────────────────────────────────────────────────────
db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
const sizeRows = {
  bars: db.prepare('SELECT count(*) c FROM bars').get().c,
  adjEvents: db.prepare('SELECT count(*) c FROM adj_events').get().c,
  panel: db.prepare('SELECT count(*) c FROM factor_panel').get().c,
}
db.close()
const st = await stat(DB_PATH)
report.tableRows = sizeRows
report.dbSizeMb = mb(st.size)
report.peakRssMb = rss()

report.gates = {
  G3b_materialize_le_60s: report.steps.materializeWithRank.ms <= 60000,
  G3c_backtest_le_2s: report.steps.backtestPanelTop50.ms <= 2000,
  G3c2_sweep10_le_20s: report.steps.sweep10TopK.ms <= 20000,
  G3d_live_much_slower: report.steps.backtestLive.ms > report.steps.backtestPanelTop50.ms * 10,
  G3e_size_le_1_5gb: report.dbSizeMb <= 1536,
  G3f_rss_le_1_5gb: report.peakRssMb <= 1536,
}
report.verdict = Object.values(report.gates).every(Boolean) ? 'PASS' : 'CHECK'

await writeFile(join(OUT_DIR, `p0-sqlite-bench-v3-${N_STOCK}x${N_DAY}.json`), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
