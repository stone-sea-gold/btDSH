/**
 * 本地仓库（node:sqlite）。
 *
 * 设计依据来自 P0 性能实测：
 *  - `bars` 存**不复权原始价**（执行真实性：涨跌停/停牌/价格）＋ 东财官方 `pct`（用于数据完整性对账）
 *  - `bars_hfq` 存**后复权收盘**（收益基准；新增分红只给整条历史乘常数，不改变历史收益率）
 *  - `adj_events` 是**事件表**（每股票每年 1–2 行），用于校验与兜底；864 万行逐日因子表被证明既慢又占空间
 *  - 显式 PRAGMA：默认 `cache_size=2MB` 会频繁溢写，`temp_store` 未设时在受限环境会直接失败
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export const SCHEMA_VERSION = 5

const PRAGMAS = [
  'journal_mode=WAL',
  'synchronous=NORMAL',
  'cache_size=-262144',
  'temp_store=memory',
  'mmap_size=268435456',
]

const DDL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS codes(
  code TEXT PRIMARY KEY, name TEXT, market INTEGER, board TEXT,
  is_st INTEGER DEFAULT 0, list_date INTEGER, delist_date INTEGER, updated_at INTEGER
) WITHOUT ROWID;

-- 不复权原始价 + 官方 pct（pct 为不复权口径，用于数据完整性对账）
CREATE TABLE IF NOT EXISTS bars(
  code TEXT NOT NULL, date INTEGER NOT NULL,
  open REAL, high REAL, low REAL, close REAL, volume REAL, amount REAL,
  pct REAL, turnover REAL,
  PRIMARY KEY(code, date)
) WITHOUT ROWID;

-- 后复权收盘（收益基准）
CREATE TABLE IF NOT EXISTS bars_hfq(
  code TEXT NOT NULL, date INTEGER NOT NULL, close REAL,
  PRIMARY KEY(code, date)
) WITHOUT ROWID;

-- 复权事件（分红送转），每股口径；factor 为推导出的当次跳变比（需前收，故可空）
CREATE TABLE IF NOT EXISTS adj_events(
  code TEXT NOT NULL, date INTEGER NOT NULL,
  cash_per_share REAL, bonus_per_share REAL, transfer_per_share REAL, factor REAL,
  PRIMARY KEY(code, date)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS fundamentals(
  code TEXT NOT NULL, report_date INTEGER NOT NULL, notice_date INTEGER,
  eps REAL, bps REAL, roe REAL, revenue_yoy REAL, profit_yoy REAL,
  gross_margin REAL, revenue REAL, net_profit REAL,
  PRIMARY KEY(code, report_date)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sync_state(
  code TEXT PRIMARY KEY,
  bars_last INTEGER, hfq_last INTEGER, adj_last INTEGER, fund_last INTEGER,
  status TEXT, error TEXT, attempts INTEGER DEFAULT 0, updated_at INTEGER
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_bars_date ON bars(date);
CREATE INDEX IF NOT EXISTS idx_fund_notice ON fundamentals(code, notice_date);

-- ── schema v2：因子面板（top-N + 预计算排名）────────────────────────────────
-- P0 实测：面板必须连 rank 一起物化且只物化 top-N（回测 19.1s → 0.47s，库 1706MB → 802MB）
CREATE TABLE IF NOT EXISTS factor_meta(
  factor_id TEXT PRIMARY KEY, formula TEXT, formula_hash TEXT, top_n INTEGER,
  first_date INTEGER, last_date INTEGER, rows INTEGER, updated_at INTEGER
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS factor_panel(
  factor_id TEXT NOT NULL, date INTEGER NOT NULL, rank INTEGER NOT NULL,
  code TEXT NOT NULL, value REAL,
  PRIMARY KEY(factor_id, date, rank)
) WITHOUT ROWID;

-- 复权视图：因子必须算在**复权价**上，否则动量类因子在除权日会带上分红跳空。
-- 累计因子用单次窗口扫描算出（exp(sum(ln(factor)))），避免 bars×events 的笛卡尔代价。
CREATE VIEW IF NOT EXISTS bars_adj AS
WITH ev AS (
  SELECT code, date, factor FROM adj_events WHERE factor IS NOT NULL
), j AS (
  SELECT b.code AS code, b.date AS date, b.open AS open, b.high AS high, b.low AS low,
         b.close AS close, b.volume AS volume, b.amount AS amount, b.turnover AS turnover_rate,
         exp(sum(ln(coalesce(e.factor, 1.0))) OVER (PARTITION BY b.code ORDER BY b.date)) AS cum
  FROM bars b LEFT JOIN ev e ON e.code = b.code AND e.date = b.date
)
SELECT code, date,
       open * cum AS open, high * cum AS high, low * cum AS low, close * cum AS close,
       volume, amount, turnover_rate
FROM j;

-- ── schema v3：策略 / 回测 / 持仓 ────────────────────────────────────────────
-- 版本链：(strategy_id, version) 为主键，保存即新增版本，永不覆盖旧版本。
-- session 溯源：记录产出该版本的 session 与轮次，支持"从策略跳回对话"。
CREATE TABLE IF NOT EXISTS strategies(
  strategy_id TEXT NOT NULL, version INTEGER NOT NULL,
  name TEXT, description TEXT, config TEXT NOT NULL,
  session_id TEXT, turn_seq INTEGER, created_at INTEGER,
  PRIMARY KEY(strategy_id, version)
) WITHOUT ROWID;

-- 回测结果留档：metrics/nav 以 JSON 存储（单次几十 KB，查询按 id 精确命中）
CREATE TABLE IF NOT EXISTS backtests(
  backtest_id TEXT PRIMARY KEY, strategy_id TEXT, version INTEGER,
  config TEXT NOT NULL, metrics TEXT, nav TEXT,
  session_id TEXT, created_at INTEGER
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS holdings(
  code TEXT PRIMARY KEY, shares REAL NOT NULL, cost REAL, updated_at INTEGER
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS position_rules(
  id TEXT PRIMARY KEY, rules TEXT NOT NULL, updated_at INTEGER
) WITHOUT ROWID;

-- ── schema v5：工作区归属 / 报告入库 ──────────────────────────────────────────
-- 工作区登记表：只记"这个目录用过"，标题取目录名；回测页的工作区切换读它。
CREATE TABLE IF NOT EXISTS workspaces(
  path TEXT PRIMARY KEY, title TEXT, last_used_at INTEGER
) WITHOUT ROWID;

-- 报告入库：存**模型 JSON**（几 KB）而不是 HTML 成品（内联 ECharts 后 664 KB/份）。
-- 渲染版本号让客户端知道这份数据该用哪版视图契约；口径升级后旧报告仍能按当时的版本渲染。
CREATE TABLE IF NOT EXISTS reports(
  backtest_id TEXT PRIMARY KEY, model TEXT NOT NULL,
  schema_version INTEGER NOT NULL, render_version INTEGER NOT NULL,
  cwd TEXT, created_at INTEGER
) WITHOUT ROWID;
`

/** 老库补列：`CREATE TABLE IF NOT EXISTS` 不会给已存在的表加列，迁移必须显式 ALTER。 */
function ensureColumn(db, table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
}

/**
 * 打开（必要时创建）本地仓库。
 *
 * @param {string} path 数据库路径，或 `:memory:`
 * @param {{tempStore?: 'memory'|'file'}} [opts]
 *   `tempStore` 控制 SQLite 窗口函数/排序用的临时 b-tree 放哪：
 *   - `memory`（默认）：最快，但全市场重因子（如 `Rsquare`，864 万行）峰值 RSS 约 **1.6GB**
 *   - `file`：峰值 RSS 约 **0.42GB**（实测 −74%），代价是耗时 +24%（104s → 129s）
 *   注意 `file` **必须有可写的临时目录**，否则 SQLite 直接报 `unable to open database file`；
 *   本函数会自动把 `SQLITE_TMPDIR` 指向仓库同级的 `.sqlite-tmp/`。可用环境变量
 *   `DSH_QUANT_TEMP_STORE=file` 全局切换（低内存机器/容器里推荐）。
 */
export function openStore(path, { tempStore = process.env.DSH_QUANT_TEMP_STORE || 'memory' } = {}) {
  const pragmas = [...PRAGMAS]
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  if (tempStore === 'file') {
    // 临时目录必须可写：受限环境里系统 /tmp 常常不可写，所以放在仓库旁边
    const tmpDir = path === ':memory:' ? null : join(dirname(path), '.sqlite-tmp')
    if (tmpDir) {
      try {
        mkdirSync(tmpDir, { recursive: true })
        if (!process.env.SQLITE_TMPDIR) process.env.SQLITE_TMPDIR = tmpDir
        pragmas[pragmas.indexOf('temp_store=memory')] = 'temp_store=file'
      } catch { /* 建不出临时目录则退回内存模式，宁可用内存也别打不开库 */ }
    }
  }
  const db = new DatabaseSync(path)
  for (const p of pragmas) {
    try { db.exec(`PRAGMA ${p}`) } catch { /* 某些环境不支持则忽略 */ }
  }
  db.exec(DDL)
  // v5：工作区归属列。存量库（v4 及以前）靠这两行升级，空库由 DDL 直接建好后再补一次（幂等）。
  ensureColumn(db, 'strategies', 'cwd', 'TEXT')
  ensureColumn(db, 'backtests', 'cwd', 'TEXT')

  const currentVersion = Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value ?? 0)
  if (currentVersion === 0) {
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION))
  } else if (currentVersion > SCHEMA_VERSION) {
    throw new Error(`仓库 schema 版本 ${currentVersion} 高于本插件支持的 ${SCHEMA_VERSION}，请升级插件`)
  } else if (currentVersion < SCHEMA_VERSION) {
    // 迁移：DDL 全部是 IF NOT EXISTS / CREATE VIEW IF NOT EXISTS，幂等；迁移后写入新版本号
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION))
  }
  // 迁移钩子：未来版本在此按 currentVersion 逐级升级

  const stmt = {
    upCode: db.prepare(`INSERT INTO codes(code,name,market,board,is_st,list_date,delist_date,updated_at)
                        VALUES(?,?,?,?,?,?,?,?)
                        ON CONFLICT(code) DO UPDATE SET name=excluded.name, market=excluded.market,
                        board=excluded.board, is_st=excluded.is_st, updated_at=excluded.updated_at,
                        list_date=COALESCE(excluded.list_date, codes.list_date),
                        delist_date=COALESCE(excluded.delist_date, codes.delist_date)`),
    upBar: db.prepare(`INSERT INTO bars(code,date,open,high,low,close,volume,amount,pct,turnover)
                       VALUES(?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(code,date) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,
                       close=excluded.close,volume=excluded.volume,amount=excluded.amount,pct=excluded.pct,turnover=excluded.turnover`),
    upHfq: db.prepare(`INSERT INTO bars_hfq(code,date,close) VALUES(?,?,?)
                       ON CONFLICT(code,date) DO UPDATE SET close=excluded.close`),
    upAdj: db.prepare(`INSERT INTO adj_events(code,date,cash_per_share,bonus_per_share,transfer_per_share,factor)
                       VALUES(?,?,?,?,?,?)
                       ON CONFLICT(code,date) DO UPDATE SET cash_per_share=excluded.cash_per_share,
                       bonus_per_share=excluded.bonus_per_share,transfer_per_share=excluded.transfer_per_share,
                       factor=COALESCE(excluded.factor, adj_events.factor)`),
    upFund: db.prepare(`INSERT INTO fundamentals(code,report_date,notice_date,eps,bps,roe,revenue_yoy,profit_yoy,gross_margin,revenue,net_profit)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?)
                        ON CONFLICT(code,report_date) DO UPDATE SET notice_date=excluded.notice_date,eps=excluded.eps,
                        bps=excluded.bps,roe=excluded.roe,revenue_yoy=excluded.revenue_yoy,profit_yoy=excluded.profit_yoy,
                        gross_margin=excluded.gross_margin,revenue=excluded.revenue,net_profit=excluded.net_profit`),
    getState: db.prepare('SELECT * FROM sync_state WHERE code=?'),
    setState: db.prepare(`INSERT INTO sync_state(code,bars_last,hfq_last,adj_last,fund_last,status,error,attempts,updated_at)
                          VALUES(?,?,?,?,?,?,?,?,?)
                          ON CONFLICT(code) DO UPDATE SET bars_last=COALESCE(excluded.bars_last,sync_state.bars_last),
                          hfq_last=COALESCE(excluded.hfq_last,sync_state.hfq_last),
                          adj_last=COALESCE(excluded.adj_last,sync_state.adj_last),
                          fund_last=COALESCE(excluded.fund_last,sync_state.fund_last),
                          status=excluded.status,error=excluded.error,updated_at=excluded.updated_at`),
  }

  const api = {
    // ── schema v3 API：策略版本链 / 回测留档 / 持仓 ──────────────────────────
    saveStrategy({ strategyId, name, description, config, sessionId = null, turnSeq = null, cwd = null }) {
      const row = db.prepare('SELECT max(version) v FROM strategies WHERE strategy_id=?').get(strategyId)
      const version = (row?.v ?? 0) + 1
      db.prepare(`INSERT INTO strategies(strategy_id,version,name,description,config,session_id,turn_seq,created_at,cwd)
                  VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(strategyId, version, name ?? null, description ?? null, JSON.stringify(config), sessionId, turnSeq, Date.now(), cwd)
      return { strategyId, version }
    },
    getStrategy: (strategyId, version = null) => {
      const sql = version === null
        ? 'SELECT * FROM strategies WHERE strategy_id=? ORDER BY version DESC LIMIT 1'
        : 'SELECT * FROM strategies WHERE strategy_id=? AND version=?'
      const r = version === null ? db.prepare(sql).get(strategyId) : db.prepare(sql).get(strategyId, version)
      return r ? { ...r, config: JSON.parse(r.config) } : null
    },
    listStrategies: ({ cwd = null } = {}) => {
      const sql = `
        SELECT s.* FROM strategies s
        JOIN (SELECT strategy_id, max(version) v FROM strategies GROUP BY strategy_id) m
          ON m.strategy_id = s.strategy_id AND m.v = s.version
        ${cwd === null ? '' : 'WHERE s.cwd = ?'}
        ORDER BY s.created_at DESC`
      const rows = cwd === null ? db.prepare(sql).all() : db.prepare(sql).all(cwd)
      return rows.map((r) => ({ ...r, config: JSON.parse(r.config) }))
    },
    strategyVersions: (strategyId) => db.prepare(
      'SELECT strategy_id,version,name,description,session_id,turn_seq,created_at FROM strategies WHERE strategy_id=? ORDER BY version').all(strategyId),
    saveBacktest({ backtestId, strategyId, version, config, metrics, nav, sessionId = null, cwd = null }) {
      db.prepare(`INSERT OR REPLACE INTO backtests(backtest_id,strategy_id,version,config,metrics,nav,session_id,created_at,cwd)
                  VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(backtestId, strategyId ?? null, version ?? null, JSON.stringify(config), JSON.stringify(metrics), JSON.stringify(nav), sessionId, Date.now(), cwd)
      return backtestId
    },
    getBacktest: (backtestId) => {
      const r = db.prepare('SELECT * FROM backtests WHERE backtest_id=?').get(backtestId)
      return r ? { ...r, config: JSON.parse(r.config), metrics: JSON.parse(r.metrics), nav: JSON.parse(r.nav) } : null
    },
    listBacktests: (opts = 50) => {
      // 兼容旧调用 `listBacktests(limit)`：参数既可以是数字，也可以是 `{ cwd, limit }`
      const { cwd = null, limit = 50 } = typeof opts === 'number' ? { limit: opts } : opts
      const sql = `SELECT backtest_id,strategy_id,version,cwd,created_at,session_id FROM backtests
        ${cwd === null ? '' : 'WHERE cwd = ?'} ORDER BY created_at DESC LIMIT ?`
      return cwd === null ? db.prepare(sql).all(limit) : db.prepare(sql).all(cwd, limit)
    },

    // ── 工作区登记：只记"用过"，标题取目录名；回测页的工作区切换靠它列选项 ──
    touchWorkspace(path, title = null) {
      const name = title ?? basename(path) ?? path
      db.prepare(`INSERT INTO workspaces(path,title,last_used_at) VALUES(?,?,?)
                  ON CONFLICT(path) DO UPDATE SET
                    title=excluded.title, last_used_at=excluded.last_used_at`)
        .run(path, name, Date.now())
      return { path, title: name }
    },
    listWorkspaces: () => db.prepare('SELECT * FROM workspaces ORDER BY last_used_at DESC').all(),

    // ── 报告入库：存模型 JSON，不存 HTML 成品 ──
    saveReport({ backtestId, model, schemaVersion, renderVersion, cwd = null }) {
      db.prepare(`INSERT OR REPLACE INTO reports(backtest_id,model,schema_version,render_version,cwd,created_at)
                  VALUES(?,?,?,?,?,?)`)
        .run(backtestId, JSON.stringify(model), schemaVersion, renderVersion, cwd, Date.now())
      return backtestId
    },
    getReport: (backtestId) => {
      const r = db.prepare('SELECT * FROM reports WHERE backtest_id=?').get(backtestId)
      return r ? { ...r, model: JSON.parse(r.model) } : null
    },
    listReports: ({ cwd = null, limit = 50 } = {}) => {
      const sql = `SELECT backtest_id,schema_version,render_version,cwd,created_at FROM reports
        ${cwd === null ? '' : 'WHERE cwd = ?'} ORDER BY created_at DESC LIMIT ?`
      return cwd === null ? db.prepare(sql).all(limit) : db.prepare(sql).all(cwd, limit)
    },
    saveHoldings(rows) {
      db.exec('BEGIN')
      try {
        db.exec('DELETE FROM holdings')
        const ins = db.prepare('INSERT OR REPLACE INTO holdings(code,shares,cost,updated_at) VALUES(?,?,?,?)')
        for (const r of rows) ins.run(r.code, r.shares, r.cost ?? null, Date.now())
      } finally { db.exec('COMMIT') }
      return rows.length
    },
    listHoldings: () => db.prepare('SELECT * FROM holdings ORDER BY code').all(),
    savePositionRules: (id, rules) => {
      db.prepare('INSERT OR REPLACE INTO position_rules(id,rules,updated_at) VALUES(?,?,?)').run(id, JSON.stringify(rules), Date.now())
      return id
    },
    getPositionRules: (id) => {
      const r = db.prepare('SELECT * FROM position_rules WHERE id=?').get(id)
      return r ? { ...r, rules: JSON.parse(r.rules) } : null
    },
    listPositionRules: () => db.prepare('SELECT * FROM position_rules ORDER BY updated_at DESC').all()
      .map((r) => ({ ...r, rules: JSON.parse(r.rules) })),

    raw: db,

    // ── schema v4：通用 KV（`meta` 表）──────────────────────────────────────
    // 为什么自动同步的状态放这里而不是新开一张表：它是**进程重启后唯一的记忆**，
    // 而 `meta` 已经是 schema 版本号的落点，语义一致（少量、点查、无需索引）。
    // 也正因为它在 `meta` 里，`quant_data_cleanup {scope:'all'}` 清行情时**不会**顺手
    // 抹掉"用户曾经同意每天自动同步"这件事——那是一次授权的撤销，不该由清理动作代劳。
    getMeta(key) {
      const r = db.prepare('SELECT value FROM meta WHERE key=?').get(key)
      if (!r) return null
      try { return JSON.parse(r.value) } catch { return null }   // 损坏的值当作不存在，而不是让插件起不来
    },
    setMeta(key, value) {
      db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
      return value
    },
    deleteMeta: (key) => db.prepare('DELETE FROM meta WHERE key=?').run(key).changes,
    metaKeys: () => db.prepare('SELECT key FROM meta ORDER BY key').all().map((r) => r.key),

    close: () => db.close(),
    upsertCodes(rows) {
      db.exec('BEGIN')
      try {
        for (const r of rows) {
          // 同时接受 camelCase 与 snake_case；**null 不覆盖已有值**（不同来源补不同字段）
          stmt.upCode.run(
            r.code, r.name ?? null, r.market ?? null, r.board ?? null, r.isSt ? 1 : 0,
            r.listDate ?? r.list_date ?? null, r.delistDate ?? r.delist_date ?? null, Date.now(),
          )
        }
      } finally { db.exec('COMMIT') }
      return rows.length
    },
    upsertBars(code, rows) {
      db.exec('BEGIN')
      try { for (const r of rows) stmt.upBar.run(code, r.date, r.open, r.high, r.low, r.close, r.volume, r.amount, r.pct, r.turnover) } finally { db.exec('COMMIT') }
      return rows.length
    },
    upsertHfq(code, rows) {
      db.exec('BEGIN')
      try { for (const r of rows) stmt.upHfq.run(code, r.date, r.close) } finally { db.exec('COMMIT') }
      return rows.length
    },
    upsertAdjEvents(code, rows) {
      db.exec('BEGIN')
      try { for (const r of rows) stmt.upAdj.run(code, r.exDate, r.cashPerShare, r.bonusPerShare, r.transferPerShare, r.factor ?? null) } finally { db.exec('COMMIT') }
      return rows.length
    },
    upsertFundamentals(rows) {
      db.exec('BEGIN')
      try { for (const r of rows) stmt.upFund.run(r.code, r.reportDate, r.noticeDate, r.eps, r.bps, r.roe, r.revenueYoy, r.profitYoy, r.grossMargin, r.revenue, r.netProfit) } finally { db.exec('COMMIT') }
      return rows.length
    },
    getSyncState: (code) => stmt.getState.get(code),    setSyncState(code, patch) {
      const prev = stmt.getState.get(code) ?? {}
      stmt.setState.run(
        code, patch.barsLast ?? null, patch.hfqLast ?? null, patch.adjLast ?? null, patch.fundLast ?? null,
        patch.status ?? prev.status ?? 'ok', patch.error ?? null, (prev.attempts ?? 0) + (patch.status === 'error' ? 1 : 0), Date.now(),
      )
    },
    bars: (code, from = 0, to = 99999999) =>
      db.prepare('SELECT * FROM bars WHERE code=? AND date BETWEEN ? AND ? ORDER BY date').all(code, from, to),
    hfq: (code, from = 0, to = 99999999) =>
      db.prepare('SELECT * FROM bars_hfq WHERE code=? AND date BETWEEN ? AND ? ORDER BY date').all(code, from, to),
    adjEvents: (code) => db.prepare('SELECT * FROM adj_events WHERE code=? ORDER BY date').all(code),
    allAdjEvents: () => db.prepare('SELECT * FROM adj_events WHERE factor IS NOT NULL ORDER BY code, date').all(),
    codesList: () => db.prepare('SELECT * FROM codes').all(),

    // ── 因子面板 ──────────────────────────────────────────────────────────
    panelMeta: (factorId) => db.prepare('SELECT * FROM factor_meta WHERE factor_id=?').get(factorId),
    setPanelMeta(meta) {
      db.prepare(`INSERT INTO factor_meta(factor_id,formula,formula_hash,top_n,first_date,last_date,rows,updated_at)
                  VALUES(?,?,?,?,?,?,?,?)
                  ON CONFLICT(factor_id) DO UPDATE SET formula=excluded.formula, formula_hash=excluded.formula_hash,
                  top_n=excluded.top_n, first_date=excluded.first_date, last_date=excluded.last_date,
                  rows=excluded.rows, updated_at=excluded.updated_at`)
        .run(meta.factorId, meta.formula ?? null, meta.formulaHash ?? null, meta.topN ?? null,
          meta.firstDate ?? null, meta.lastDate ?? null, meta.rows ?? null, Date.now())
    },
    deletePanel(factorId) {
      db.prepare('DELETE FROM factor_panel WHERE factor_id=?').run(factorId)
      db.prepare('DELETE FROM factor_meta WHERE factor_id=?').run(factorId)
    },
    listPanels: () => db.prepare('SELECT * FROM factor_meta ORDER BY updated_at DESC').all(),
    panelLatestDate: (factorId) => db.prepare('SELECT max(date) d FROM factor_panel WHERE factor_id=?').get(factorId)?.d ?? null,
    panelRows: (factorId, { from = 0, to = 99999999, maxRank = 1e9 } = {}) =>
      db.prepare('SELECT date, rank, code, value FROM factor_panel WHERE factor_id=? AND date BETWEEN ? AND ? AND rank<=? ORDER BY date, rank')
        .all(factorId, from, to, maxRank),
    panelRanksOn: (factorId, date, maxRank) =>
      db.prepare('SELECT rank, code, value FROM factor_panel WHERE factor_id=? AND date=? AND rank<=? ORDER BY rank')
        .all(factorId, date, maxRank),
    insertPanelBatch(factorId, rows) {
      const ins = db.prepare('INSERT OR REPLACE INTO factor_panel(factor_id,date,rank,code,value) VALUES(?,?,?,?,?)')
      db.exec('BEGIN')
      try { for (const r of rows) ins.run(factorId, r.date, r.rank, r.code, r.value) } finally { db.exec('COMMIT') }
      return rows.length
    },
    stats() {
      const one = (sql) => db.prepare(sql).get()?.c ?? 0
      return {
        codes: one('SELECT count(*) c FROM codes'),
        bars: one('SELECT count(*) c FROM bars'),
        hfqRows: one('SELECT count(*) c FROM bars_hfq'),
        adjEvents: one('SELECT count(*) c FROM adj_events'),
        fundamentals: one('SELECT count(*) c FROM fundamentals'),
        barsRange: db.prepare('SELECT min(date) a, max(date) b FROM bars').get() ?? { a: null, b: null },
        schemaVersion: Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value ?? 0),
      }
    },
  }
  return api
}
