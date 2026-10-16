/**
 * P0-G3 — 全市场规模落盘 SQLite 性能实测
 *
 * 回答：真实部署形态（磁盘库 + 索引 + WAL）下，
 *   G3a 全市场 5400 × 1600 日 写入 + 建索引 的耗时与体积
 *   G3b 单因子全市场物化（因子面板）耗时
 *   G3c 物化后一次 top_k 回测（含逐日截面排名）耗时
 *   G3d 不物化、每次实时算的对照耗时
 *   G3e 峰值 RSS（判断是否触发溢写）
 *
 * 用法: node spike/p0-sqlite-bench.mjs [股数] [天数] [输出目录]
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const N_STOCK = Number(process.argv[2] ?? 5400)
const N_DAY = Number(process.argv[3] ?? 1600)
const OUT_DIR = process.argv[4] ?? 'spike/out'
const DB_DIR = join(OUT_DIR, 'db')
const DB_PATH = join(DB_DIR, `bench_${N_STOCK}x${N_DAY}.db`)

const report = { params: { stocks: N_STOCK, days: N_DAY, dbPath: DB_PATH }, steps: {} }
const rss = () => Math.round(process.memoryUsage().rss / 1048576)
const mb = (bytes) => +(bytes / 1048576).toFixed(1)
const timed = (fn) => { const t = performance.now(); const v = fn(); return { ms: Math.round(performance.now() - t), value: v } }

await mkdir(DB_DIR, { recursive: true })
await rm(DB_PATH, { force: true })

const db = new DatabaseSync(DB_PATH)
// 显式设置：默认 cache_size=2MB 会导致大量溢写；temp_store 必须显式指定
for (const pragma of ['journal_mode=WAL', 'synchronous=NORMAL', 'cache_size=-262144', 'temp_store=memory', 'mmap_size=268435456']) {
  db.exec(`PRAGMA ${pragma}`)
}

db.exec(`
  CREATE TABLE codes(code TEXT PRIMARY KEY, name TEXT, board TEXT);
  CREATE TABLE bars(
    code TEXT NOT NULL, date INTEGER NOT NULL,
    open REAL, high REAL, low REAL, close REAL, volume REAL, amount REAL,
    PRIMARY KEY(code, date)
  ) WITHOUT ROWID;
  CREATE TABLE adj_factors(code TEXT NOT NULL, date INTEGER NOT NULL, factor REAL, PRIMARY KEY(code,date)) WITHOUT ROWID;
  CREATE TABLE factor_panel(factor_id TEXT NOT NULL, code TEXT NOT NULL, date INTEGER NOT NULL, value REAL, PRIMARY KEY(factor_id,code,date)) WITHOUT ROWID;
`)

// ── G3a 写入 ────────────────────────────────────────────────────────────────
let seed = 42
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const BASE_DATE = 20200101
const toDate = (i) => {
  // 简化日历：跳过周末（真实实现用交易日历）
  const d = new Date(Date.UTC(2020, 0, 1) + i * 86400000)
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
}
const dates = []
for (let i = 0; dates.length < N_DAY; i++) {
  const dt = new Date(Date.UTC(2020, 0, 1) + i * 86400000)
  const wd = dt.getUTCDay()
  if (wd !== 0 && wd !== 6) dates.push(toDate(i))
}

const insBar = db.prepare('INSERT INTO bars(code,date,open,high,low,close,volume,amount) VALUES(?,?,?,?,?,?,?,?)')
const insCode = db.prepare('INSERT INTO codes(code,name,board) VALUES(?,?,?)')

const write = timed(() => {
  db.exec('BEGIN')
  const px = new Float64Array(N_STOCK).fill(20)
  for (let s = 0; s < N_STOCK; s++) {
    const code = (s % 2 === 0 ? 'sh' : 'sz') + String(600000 + s).padStart(6, '0')
    insCode.run(code, `股票${s}`, s % 3 === 0 ? 'main' : 'gem')
    let p = px[s]
    for (let d = 0; d < N_DAY; d++) {
      p = Math.max(1, p * (1 + (rnd() - 0.5) * 0.04))
      const o = p * (1 + (rnd() - 0.5) * 0.01)
      insBar.run(code, dates[d], o, p * 1.02, p * 0.98, p, Math.floor(rnd() * 1e7), p * 1e6)
    }
  }
  db.exec('COMMIT')
  return N_STOCK * N_DAY
})
report.steps.writeBars = { rows: write.value, ms: write.ms, rowsPerSec: Math.round(write.value / (write.ms / 1000)), rssMb: rss() }

// 复权因子（合成：单调递增，模拟分红）
const insAdj = db.prepare('INSERT INTO adj_factors(code,date,factor) VALUES(?,?,?)')
const adj = timed(() => {
  db.exec('BEGIN')
  for (let s = 0; s < N_STOCK; s++) {
    const code = (s % 2 === 0 ? 'sh' : 'sz') + String(600000 + s).padStart(6, '0')
    for (let d = 0; d < N_DAY; d++) insAdj.run(code, dates[d], 1 + d * 0.0001)
  }
  db.exec('COMMIT')
  return N_STOCK * N_DAY
})
report.steps.writeAdjFactors = { rows: adj.value, ms: adj.ms, rssMb: rss() }

// ── 索引 ────────────────────────────────────────────────────────────────────
const idx = timed(() => { db.exec('CREATE INDEX idx_bars_date_code ON bars(date, code)'); return true })
report.steps.createIndex = { ms: idx.ms }

// ── G3b 因子面板物化（20 日动量） ───────────────────────────────────────────
const mat = timed(() => {
  db.exec(`
    INSERT INTO factor_panel(factor_id, code, date, value)
    SELECT 'momentum_20', code, date, close / lag_close - 1
    FROM (SELECT code, date, close, lag(close, 20) OVER (PARTITION BY code ORDER BY date) AS lag_close FROM bars)
    WHERE lag_close IS NOT NULL
  `)
  return db.prepare("SELECT count(*) c FROM factor_panel WHERE factor_id='momentum_20'").get().c
})
report.steps.materializeFactor = { rows: mat.value, formula: 'momentum_20', ms: mat.ms, rssMb: rss() }

const idxPanel = timed(() => { db.exec('CREATE INDEX idx_panel ON factor_panel(factor_id, date, value)'); return true })
report.steps.createPanelIndex = { ms: idxPanel.ms }

// ── G3c 物化后回测（Top50 等权，逐日截面排名） ──────────────────────────────
const btMaterialized = timed(() => {
  const r = db.prepare(`
    WITH top AS (
      SELECT code, date, value FROM factor_panel
      WHERE factor_id='momentum_20'
        AND date BETWEEN ? AND ?
      ORDER BY date, value DESC
      LIMIT 50 -- 占位，真实实现用逐日 rank()
    ) SELECT count(*) n FROM top
  `).get(dates[30], dates[N_DAY - 1])
  return r.n
})
report.steps.backtestMaterializedNaive = { note: '占位查询，见下逐日排名版', ms: btMaterialized.ms }

const btRank = timed(() => {
  const r = db.prepare(`
    WITH rk AS (
      SELECT code, date, value,
             rank() OVER (PARTITION BY date ORDER BY value DESC) AS rnk
      FROM factor_panel
      WHERE factor_id='momentum_20' AND date BETWEEN ? AND ?
    ), sel AS (
      SELECT code, date FROM rk WHERE rnk <= 50
    ), px AS (
      SELECT b.code, b.date, b.close FROM bars b JOIN sel s ON s.code=b.code AND s.date=b.date
    ), ret AS (
      SELECT code, date, lead(close) OVER (PARTITION BY code ORDER BY date)/close - 1 AS r1 FROM px
    )
    SELECT count(*) n, avg(r1) m FROM ret WHERE r1 IS NOT NULL
  `).get(dates[30], dates[N_DAY - 1])
  return r
})
report.steps.backtestMaterialized = { ms: btRank.ms, sample: btRank.value }

// ── G3d 不物化，每次实时算（对照） ──────────────────────────────────────────
const btLive = timed(() => {
  const r = db.prepare(`
    WITH f AS (
      SELECT code, date, close, lag(close,20) OVER (PARTITION BY code ORDER BY date) AS lag_close FROM bars
    ), s AS (
      SELECT code, date, close/lag_close - 1 AS value FROM f WHERE lag_close IS NOT NULL
    ), rk AS (
      SELECT code, date, value, rank() OVER (PARTITION BY date ORDER BY value DESC) AS rnk FROM s
    ), sel AS (
      SELECT code, date FROM rk WHERE rnk <= 50
    ), px AS (
      SELECT b.code, b.date, b.close FROM bars b JOIN sel s ON s.code=b.code AND s.date=b.date
    ), ret AS (
      SELECT code, date, lead(close) OVER (PARTITION BY code ORDER BY date)/close - 1 AS r1 FROM px
    )
    SELECT count(*) n, avg(r1) m FROM ret WHERE r1 IS NOT NULL
  `).get()
  return r
})
report.steps.backtestLive = { ms: btLive.ms, sample: btLive.value }

// ── G3e 体积与最终状态 ──────────────────────────────────────────────────────
db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
db.close()
const st = await stat(DB_PATH)
report.dbSizeMb = mb(st.size)
report.peakRssMb = rss()
report.datesRange = [dates[0], dates[N_DAY - 1]]

// ── 判定 ────────────────────────────────────────────────────────────────────
const gates = {
  G3a_write_ok: report.steps.writeBars.rowsPerSec > 100000,
  G3b_materialize_le_60s: report.steps.materializeFactor.ms <= 60000,
  G3c_backtest_le_2s: report.steps.backtestMaterialized.ms <= 2000,
  G3d_live_slower_than_materialized: report.steps.backtestLive.ms > report.steps.backtestMaterialized.ms * 3,
  G3e_size_le_1_5gb: report.dbSizeMb <= 1536,
  G3f_rss_le_1_5gb: report.peakRssMb <= 1536,
}
report.gates = gates
report.verdict = Object.values(gates).every(Boolean) ? 'PASS' : 'CHECK'

await mkdir(OUT_DIR, { recursive: true })
const outFile = join(OUT_DIR, `p0-sqlite-bench-${N_STOCK}x${N_DAY}.json`)
await writeFile(outFile, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
console.error(`[bench] written: ${outFile}`)
