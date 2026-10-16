/**
 * 验收门 · 我方侧与比对器。
 *
 * 阶梯（由严到松，每层抓不同的东西）：
 *   rung0  数据口径：交易日集合、复权口径、逐日收益率
 *   rung1  因子横截面：qlib 表达式引擎的值/排名 vs 我的 DSL
 *   rung2  组合构建：同一 top-K 名单的前向收益（无成本、无撮合）
 *   rung3  全账务：qlib executor（默认口径 / 对齐口径）vs 我的回测引擎
 *
 * 用法: node spike/gate-compare.mjs <rung0|rung1|rung2|rung3> [...]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { openStore } from '../lib/data/store.mjs'
import { materializePanel } from '../lib/factors/panel.mjs'
import { selectStocks } from '../lib/factors/select.mjs'
import { runBacktest } from '../lib/backtest/engine.mjs'
import { compileFactor } from '../lib/factors/dsl.mjs'
import { ensureFactorAggregates } from '../lib/factors/aggregates.mjs'

const DB = 'spike/out/p1-verify.db'
const OUT = 'spike/out'
const FIELD_MAP = { turnover_rate: 'turnover' }

const CODES = ['000001', '000002', '000858', '002415', '002594', '300059',
  '300750', '600036', '600519', '601318', '601899', '688981']
const START = 20240102, END = 20260921

const fmt = (x, n = 4) => (x === null || x === undefined ? '—' : Number(x).toFixed(n))
const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(2)}%`)
const pad = (s, n) => String(s).padEnd(n)

function loadJson(p) {
  if (!existsSync(p)) { console.error(`缺少 ${p}`); process.exit(1) }
  return JSON.parse(readFileSync(p, 'utf8'))
}

// ── Rung 0：数据口径 ────────────────────────────────────────────────────────
function rung0() {
  const q = loadJson(`${OUT}/gate-qlib-dump.json`)
  const store = openStore(DB)

  const qBy = new Map()   // code -> Map(date -> row)
  for (const r of q.rows) {
    if (!qBy.has(r.code)) qBy.set(r.code, new Map())
    qBy.get(r.code).set(r.date, r)
  }

  console.log('=== Rung 0 · 数据口径 ===')
  console.log(`qlib 导出：${q.codes.length} 只 × ${q.range[0]}~${q.range[1]}，共 ${q.rows.length} 行\n`)

  const stmt = store.raw.prepare(
    `SELECT b.date, b.close raw, b.open rawOpen, b.high rawHigh, b.low rawLow, b.volume rawVol,
            a.close adj, a.open adjOpen
     FROM bars b JOIN bars_adj a ON a.code=b.code AND a.date=b.date
     WHERE b.code=? AND b.date BETWEEN ? AND ? ORDER BY b.date`)

  const results = []
  for (const code of CODES) {
    const mine = stmt.all(code, START, END)
    const theirs = qBy.get(code) ?? new Map()
    const myDates = new Set(mine.map((r) => r.date))
    const theirDates = new Set(theirs.keys())
    const onlyMine = [...myDates].filter((d) => !theirDates.has(d))
    const onlyTheirs = [...theirDates].filter((d) => !myDates.has(d))
    const common = [...myDates].filter((d) => theirDates.has(d)).sort()

    // 复权口径：qlibClose / myRaw 与 qlibClose / myAdj 是否随时间恒定
    const ratioRaw = [], ratioAdj = [], retDiff = []
    let prev = null
    for (const r of mine) {
      const t = theirs.get(r.date)
      if (!t || t.close == null) continue
      if (r.raw > 0) ratioRaw.push(t.close / r.raw)
      if (r.adj > 0) ratioAdj.push(t.close / r.adj)
      if (prev && prev.t && prev.t.close > 0 && prev.r.adj > 0 && r.adj > 0) {
        const qr = t.close / prev.t.close - 1
        const mr = r.adj / prev.r.adj - 1
        retDiff.push(Math.abs(qr - mr))
      }
      prev = { t, r }
    }
    const spread = (a) => (a.length < 2 ? 0 : (Math.max(...a) - Math.min(...a)) / (Math.abs(a.reduce((x, y) => x + y, 0) / a.length) || 1))
    results.push({
      code,
      myDays: myDates.size, theirDays: theirDates.size, common: common.length,
      onlyMine: onlyMine.length, onlyTheirs: onlyTheirs.length,
      onlyMineSample: onlyMine.slice(0, 3), onlyTheirsSample: onlyTheirs.slice(0, 3),
      ratioRawMean: ratioRaw.length ? ratioRaw.reduce((a, b) => a + b, 0) / ratioRaw.length : null,
      ratioRawSpread: spread(ratioRaw),
      ratioAdjMean: ratioAdj.length ? ratioAdj.reduce((a, b) => a + b, 0) / ratioAdj.length : null,
      ratioAdjSpread: spread(ratioAdj),
      maxRetDiff: retDiff.length ? Math.max(...retDiff) : null,
      retPoints: retDiff.length,
    })
  }

  console.log(`${pad('code', 9)}${pad('我方日', 8)}${pad('qlib日', 8)}${pad('交集', 7)}${pad('仅我方', 7)}${pad('仅qlib', 7)}${pad('qlib/raw', 11)}${pad('离散度', 10)}${pad('qlib/adj', 11)}${pad('离散度', 10)}${pad('最大日收益差', 14)}`)
  for (const r of results) {
    console.log(`${pad(r.code, 9)}${pad(r.myDays, 8)}${pad(r.theirDays, 8)}${pad(r.common, 7)}${pad(r.onlyMine, 7)}${pad(r.onlyTheirs, 7)}` +
      `${pad(fmt(r.ratioRawMean, 4), 11)}${pad(r.ratioRawSpread.toExponential(1), 10)}` +
      `${pad(fmt(r.ratioAdjMean, 4), 11)}${pad(r.ratioAdjSpread.toExponential(1), 10)}` +
      `${pad(r.maxRetDiff === null ? '—' : r.maxRetDiff.toExponential(2), 14)}`)
  }

  const withDiff = results.filter((r) => r.onlyMine || r.onlyTheirs)
  const worstRet = results.filter((r) => r.maxRetDiff !== null).sort((a, b) => b.maxRetDiff - a.maxRetDiff)[0]
  const worstSpread = results.filter((r) => r.ratioAdjMean !== null).sort((a, b) => b.ratioAdjSpread - a.ratioAdjSpread)[0]
  console.log(`\n交易日集合不一致的股票：${withDiff.length} 只`)
  for (const r of withDiff) {
    console.log(`  ${r.code}: 仅我方 ${JSON.stringify(r.onlyMineSample)} 仅qlib ${JSON.stringify(r.onlyTheirsSample)}`)
  }
  console.log(`复权口径：qlib/我方复权价 的比值离散度最大 ${worstSpread?.ratioAdjSpread.toExponential(2)}（${worstSpread?.code}）→ ${worstSpread?.ratioAdjSpread < 1e-6 ? '✅ 两序列只差一个常数因子（收益率完全一致）' : '❌ 口径不同，需逐项解释'}`)
  console.log(`逐日收益率：最大绝对差 ${worstRet?.maxRetDiff.toExponential(2)}（${worstRet?.code}）`)
  writeFileSync(`${OUT}/gate-rung0.json`, JSON.stringify({ results }, null, 2))
  store.close()
}

// ── Rung 1：因子横截面 ──────────────────────────────────────────────────────
/**
 * 判据：对每条公式、每只股票，拟合 `qlib值 ≈ k × 我方值`（**过原点最小二乘**），
 * 再看归一化残差 `max|t − k·m| / max|t|`。
 *
 * 为什么不用比值 `t/m`：因子值经常穿过 0（动量、残差），近零点会把比值炸到 ±∞，
 * 把"完全一致"误判成巨大偏差（实测踩过：比值法报出 1.99 的离散度，实际完全一致）。
 * 过原点 LS 对零点稳健，残差再除以该股的量级，才是可比的口径。
 *
 * 为什么 `k` 允许不是 1：qlib 的 `$close` 是后复权、我的是前复权，两者只差一个
 * **每只股票不同的常数 k**（Rung 0 已验到 1e-7）。比率型公式 k=1，量纲型公式 k=每股常数。
 *
 * 预热期（WARMUP 之前）不参与比对：qlib 的导出从 2024-01-02 才开始，那 10 只股票
 * 在头 20 个交易日算不出 `Ref($close,20)`，而我的库有 2018 年以来的历史。
 */
/**
 * Rung 1 做成**两级**，因为"因子值不一样"可能是两件完全不同的事：
 *
 *   A 语义级：把 **qlib 的价格**喂进**我的算法**，与 qlib 的表达式输出比。
 *             不一致 → 因子语义实现错了（这才是 DSL 的责任）。
 *   B 数据级：把 **我的价格**喂进我的算法，与 A 的结果比。
 *             不一致 → 数据管线差异（复权口径 / 事件缺口 / 停牌表示），不是算法错。
 *
 * 分开之后每处差异都能归到具体一边，而不是笼统地说"两边不一样"。
 *
 * 精度地板：qlib 的 bin 是 **float32**，相对精度约 1e-7。对近并列值（复权价相等的两天）
 * float32 会把次序翻转，进而让 Rank/IdxMax 这类**依赖次序**的因子差一个位次。
 * 实测：000001 在 20241009 与 20241101 的复权价在我这边逐位相等，qlib 侧是
 * 1577.7861328125 vs 1577.7857666015625 → Rank 0.20 vs 0.15。用 qlib 的值跑我的算法
 * 就得到 qlib 的答案，所以这是输入精度而非语义差异。
 */
const WARMUP_UNTIL = 20240401
const FLOAT32_FLOOR = 1e-6

/**
 * 语义分歧标记：`Max(x, 0)` / `Min(x, 0)` 在 qlib 里是 **expanding 窗口**（实测
 * `Max($close-Ref($close,1),0) == d1.expanding().max()`），我按**逐元素**处理。
 * AIFUND5 的 3 条 RSI 因子依赖这个重载，意图显然是 ReLU，但 qlib 实际算的不是 RSI。
 */
function hasZeroWindow(formula) {
  return /(Max|Min)\s*\([^()]*,\s*0\s*\)/.test(formula)
}

/** 把 qlib 的价格建成一张表，供我的 DSL 在同一输入上求值 */
function loadQlibInputs(store, dump) {
  store.raw.exec('DROP TABLE IF EXISTS q_adj')
  store.raw.exec(`CREATE TABLE q_adj(code TEXT NOT NULL, date INTEGER NOT NULL,
    open REAL, high REAL, low REAL, close REAL, volume REAL, turnover_rate REAL,
    PRIMARY KEY(code, date)) WITHOUT ROWID`)
  const ins = store.raw.prepare('INSERT OR REPLACE INTO q_adj VALUES (?,?,?,?,?,?,?,?)')
  store.raw.exec('BEGIN')
  try {
    // **停牌行也要插**（close 为 NULL）：qlib 的滚动窗口按位置跨 20 行，NaN 行占位；
    // 若这里跳过它们，"同一输入"就名不副实，688981 的差异会被误判成语义问题。
    for (const r of dump.rows) {
      ins.run(r.code, r.date, r.open, r.high, r.low, r.close, r.volume, null)
    }
  } finally { store.raw.exec('COMMIT') }
  return store.raw.prepare('SELECT count(*) c FROM q_adj').get().c
}

/**
 * 标出「qlib 输入窗口里含 NULL」的点。
 *
 * 为什么需要：qlib 的 `IdxMax` 是 `rolling(N).apply(lambda x: x.argmax()+1)`，
 * 而 `np.argmax` 在含 NaN 的数组上返回**第一个 NaN 的位置**——于是窗口里有停牌日时，
 * qlib 返回的是"停牌日在窗口中的位置"，而不是"最高价的位置"。我这边跳过 NULL。
 * 这个分歧只影响含 NULL 的窗口，必须单独量化，不能混进总体残差。
 */
function nullWindowKeys(store, lookback) {
  const keys = new Set()
  const byCode = new Map()
  for (const r of store.raw.prepare('SELECT code, date, close FROM q_adj ORDER BY code, date').all()) {
    if (!byCode.has(r.code)) byCode.set(r.code, [])
    byCode.get(r.code).push({ date: r.date, isNull: r.close === null })
  }
  for (const [code, arr] of byCode) {
    for (let i = 0; i < arr.length; i++) {
      let hasNull = false
      for (let j = Math.max(0, i - lookback); j <= i; j++) if (arr[j].isNull) { hasNull = true; break }
      if (hasNull) keys.add(`${code}|${arr[i].date}`)
    }
  }
  return keys
}

/** 过原点最小二乘拟合 k，返回归一化残差与最差点 */
function fitResidual(pairs) {
  let sumMT = 0, sumMM = 0, scale = 0
  for (const x of pairs) { sumMT += x.m * x.t; sumMM += x.m * x.m; if (Math.abs(x.t) > scale) scale = Math.abs(x.t) }
  if (sumMM === 0 || scale === 0) return { k: null, norm: 0, worst: null }
  const k = sumMT / sumMM
  let norm = 0, worst = null
  for (const x of pairs) {
    const n = Math.abs(x.t - k * x.m) / scale
    if (n > norm) { norm = n; worst = x }
  }
  return { k, norm, worst }
}

function rung1(formulas) {
  const dump = loadJson(`${OUT}/gate-qlib-dump.json`)
  const q = loadJson(`${OUT}/gate-qlib-factors.json`)
  const store = openStore(DB)
  ensureFactorAggregates(store)
  const inputRows = loadQlibInputs(store, dump)
  // 含 NULL 的窗口：按公式各自 lookback 计算（下面循环里用）
  const nullKeysCache = new Map()

  console.log('=== Rung 1 · 因子横截面对账（qlib 表达式引擎 vs 我的 DSL）===')
  console.log(`qlib 价格已载入 q_adj（${inputRows} 行）作为「同一输入」基准；比对窗口 ${WARMUP_UNTIL}~${END}`)
  console.log('A 语义级 = 我的算法@qlib价格 vs qlib输出 | B 数据级 = 我的算法@我的价格 vs 我的算法@qlib价格\n')

  const qBy = new Map()
  for (const r of q.rows) qBy.set(`${r.formula}|${r.code}|${r.date}`, r.value)

  const out = []
  for (const formula of formulas) {
    const cMine = compileFactor(formula, { source: 'bars_adj', fieldMap: FIELD_MAP })
    const cQlib = compileFactor(formula, { source: 'q_adj', fieldMap: FIELD_MAP })
    if (!cMine.ok || !cQlib.ok) { console.log(`❌ ${formula} 编译失败`); continue }

    const mineRows = store.raw.prepare(
      `SELECT code, date, value FROM (${cMine.sql}) WHERE date BETWEEN ? AND ? ORDER BY code, date`).all(WARMUP_UNTIL, END)
    const qlibRows = store.raw.prepare(
      `SELECT code, date, value FROM (${cQlib.sql}) WHERE date BETWEEN ? AND ? ORDER BY code, date`).all(WARMUP_UNTIL, END)
    const qlibOnQlib = new Map(qlibRows.map((r) => [`${r.code}|${r.date}`, r.value]))

    const nullKeys = (() => {
      const lb = cMine.meta.lookback ?? 0
      if (!nullKeysCache.has(lb)) nullKeysCache.set(lb, nullWindowKeys(store, lb))
      return nullKeysCache.get(lb)
    })()
    const semPairs = [], dataPairs = []
    let semMissing = 0, semMissingNullWindow = 0, dataMissing = 0
    for (const r of mineRows) {
      const t = qBy.get(`${formula}|${r.code}|${r.date}`)
      const viaQlib = qlibOnQlib.get(`${r.code}|${r.date}`)
      const inNullWindow = nullKeys.has(`${r.code}|${r.date}`)
      // A：我的算法@qlib价格 vs qlib 输出
      if (viaQlib !== undefined) {
        const mNull = viaQlib === null || viaQlib === undefined
        const tNull = t === null || t === undefined
        if (mNull || tNull) {
          // 窗口含 NULL 时的空值分歧单独计数：qlib 的 rolling_slope/corr 对 NaN 的处理方向
          // 与我的"含 NULL 即返回 NULL"保护相反，属于已知分歧而非语义错误
          if (mNull !== tNull) { if (inNullWindow) semMissingNullWindow++; else semMissing++ }
        } else {
          semPairs.push({ code: r.code, date: r.date, m: viaQlib, t })
        }
      }
      // B：我的算法@我的价格 vs 我的算法@qlib价格
      if (viaQlib !== undefined && viaQlib !== null) {
        if (r.value === null || r.value === undefined) dataMissing++
        else dataPairs.push({ code: r.code, date: r.date, m: r.value, t: viaQlib })
      }
    }

    // A 级按股票分别拟合（qlib 后复权 vs 我的算法吃的是同一份 qlib 价格 → 期望 k=1）
    const sem = fitResidual(semPairs)
    const semClean = fitResidual(semPairs.filter((x) => !nullKeys.has(`${x.code}|${x.date}`)))
    const data = fitResidual(dataPairs)
    const semantic = hasZeroWindow(formula)
    const semOk = semMissing === 0 && (semClean.norm < FLOAT32_FLOOR || semantic)
    const name = formula.length > 26 ? formula.slice(0, 24) + '..' : formula
    out.push({
      formula, layers: cMine.meta.layerCount, aggs: cMine.meta.aggregates,
      semPoints: semPairs.length, semMissing, semMissingNullWindow, semK: sem.k, semNorm: sem.norm, semWorst: sem.worst,
      semNormClean: semClean.norm, semWorstClean: semClean.worst, semOk,
      dataPoints: dataPairs.length, dataMissing, dataK: data.k, dataNorm: data.norm, dataWorst: data.worst,
      semanticDivergence: semantic,
    })
    console.log(`${(semantic ? '⚠️ ' : semOk ? '✅ ' : '❌ ').padEnd(4)}${pad(name, 28)} 语义级 残差 ${pad(sem.norm.toExponential(2), 10)} → 剔除含NULL窗口 ${pad(semClean.norm.toExponential(2), 10)} k ${pad(fmt(sem.k, 6), 9)} | 数据级 残差 ${pad(data.norm.toExponential(2), 9)} k ${pad(fmt(data.k, 5), 10)}`)
    if (!semOk && semClean.worst) console.log(`${' '.repeat(5)}语义级最差点：${semClean.worst.code}@${semClean.worst.date} 我=${semClean.worst.m.toPrecision(8)} qlib=${semClean.worst.t.toPrecision(8)}`)
    if (data.norm > 1e-3 && data.worst) console.log(`${' '.repeat(5)}数据级最差点：${data.worst.code}@${data.worst.date} 我=${data.worst.m.toPrecision(8)} qlib输入下=${data.worst.t.toPrecision(8)}`)
    if (semMissingNullWindow) console.log(`${' '.repeat(5)}含NULL窗口的空值分歧 ${semMissingNullWindow} 点（已知：qlib 对窗口内 NaN 的处理方向不同）`)
  }
  writeFileSync(`${OUT}/gate-rung1.json`, JSON.stringify({ formulas, warmupUntil: WARMUP_UNTIL, float32Floor: FLOAT32_FLOOR, results: out }, null, 2))
  store.close()
}

// ── Rung 2 / 3 ──────────────────────────────────────────────────────────────
function buildSignal(formula, factorId, topN = 500) {
  const store = openStore(DB)
  const r = materializePanel(store, { factorId, formula, topN, from: START, to: END })
  if (!r.ok) { console.error('面板物化失败', r.error); process.exit(1) }
  return { store, panel: r }
}

function rung2(formula, topK, rebalance) {
  const store = openStore(DB)
  ensureFactorAggregates(store)
  console.log('=== Rung 2 · 组合构建（无成本、无撮合）===')
  // 用现场求值路径取每个调仓日的 top-K，再看下一个调仓日的收益
  const sel = selectStocks(store, { formula, date: END, topK, universe: { excludeST: false, minListDays: 0 } })
  console.log(`信号日 ${sel.date} top${topK}：${sel.picks.map((p) => p.code).join(', ')}`)
  writeFileSync(`${OUT}/gate-rung2.json`, JSON.stringify({ formula, topK, picks: sel.picks.map((p) => p.code) }, null, 2))
  store.close()
}

function rung3(formula, factorId, topK, nDrop, rebalance) {
  const store = openStore(DB)
  const mat = materializePanel(store, { factorId, formula, topN: 500, from: START, to: END })
  if (!mat.ok) { console.error('面板失败', mat.error); process.exit(1) }
  const holdings = []
  const bt = runBacktest(store, {
    factorId, topK, rebalance, weight: 'equal',
    start: START, end: END, initialCash: 1_000_000,
    universe: { excludeST: false, minListDays: 0 },
    // 必须与 qlib 侧同池：qlib 的数据只有这 12 只，池外股票在我这边会挤进 top-K
    universeCodes: CODES,
    onDay: (d, book) => holdings.push({ date: d, codes: [...book.positions.keys()].filter((c) => book.positions.get(c).shares > 0).sort() }),
  })
  if (!bt.ok) { console.error('回测失败', bt.error); process.exit(1) }
  const m = bt.metrics
  console.log('=== Rung 3 · 我方回测（与 qlib 同参数）===')
  console.log(`  区间 ${bt.navSeries[0].date}~${bt.navSeries.at(-1).date}（${m.days} 天）| topK ${topK} | 调仓 ${rebalance}`)
  console.log(`  总收益 ${pct(m.totalReturn)} | 年化 ${pct(m.cagr)} | 波动 ${pct(m.annualVol)} | 夏普 ${fmt(m.sharpe)} | 最大回撤 ${pct(m.maxDrawdown)} | Calmar ${fmt(m.calmar)}`)
  console.log(`  成交 ${m.trades} 笔 | 换手 ${fmt(m.turnover, 2)} | 费用 ${JSON.stringify(m.fees)}`)
  console.log(`  被拒：买 ${JSON.stringify(bt.skipped.buy)} 卖 ${JSON.stringify(bt.skipped.sell)}`)
  writeFileSync(`${OUT}/gate-rung3-mine.json`, JSON.stringify({
    formula, factorId, topK, rebalance, range: [bt.navSeries[0].date, bt.navSeries.at(-1).date],
    days: m.days, metrics: m, skipped: bt.skipped, holdings,
    nav: bt.navSeries.map((x) => ({ date: x.date, nav: x.nav })),
  }, null, 2))
  // 导出信号供 qlib 使用（qlib 侧按 T+1 前移 + 开盘成交对齐）
  const rows = store.raw.prepare(
    `SELECT code, date, value FROM factor_panel WHERE factor_id=? AND date BETWEEN ? AND ? ORDER BY date, code`).all(factorId, START, END)
  writeFileSync(`${OUT}/gate-signal.json`, JSON.stringify({ factorId, formula, rows }))
  console.log(`  信号已导出 ${rows.length} 行 → ${OUT}/gate-signal.json`)
  store.close()
}

const [mode, ...rest] = process.argv.slice(2)
if (mode === 'rung0') rung0()
else if (mode === 'rung1') {
  const formulas = rest[0]
    ? rest[0].split(',')
    : (loadJson(`${OUT}/gate-formulas.json`).formulas ?? [])
  rung1(formulas)
}
else if (mode === 'rung2') rung2(rest[0], Number(rest[1] ?? 3), rest[2] ?? 'monthly')
else if (mode === 'rung3') {
  // 公式用 gate-formulas.json 的下标传，避免 shell 吃掉 `$close`
  const fs2 = loadJson(`${OUT}/gate-formulas.json`).formulas
  const idx = Number(rest[0] ?? 0)
  rung3(fs2[idx], rest[1] ?? `gate_f${idx}`, Number(rest[2] ?? 3), Number(rest[3] ?? 3), rest[4] ?? 'daily')
}
else if (mode === 'rung3cmp') rung3cmp()
else { console.error('用法: gate-compare.mjs <rung0|rung1|rung2|rung3|rung3cmp>'); process.exit(1) }

/** Rung 3 汇总：持仓一致性 + 净值逐日对账 + 差异归因 */
function rung3cmp() {
  const mine = loadJson(`${OUT}/gate-rung3-mine.json`)
  const norm = (cs) => cs.map((c) => c.replace(/^(SH|SZ)/, '')).sort().join(',')
  const mh = new Map(mine.holdings.map((h) => [h.date, norm(h.codes)]))
  console.log('=== Rung 3 · 全账务对账（同信号 / 同股票池 / 同 topK / 日频）===')
  console.log(`我方区间 ${mine.range[0]}~${mine.range[1]}（${mine.days} 天），初始资金 1,000,000\n`)

  const rows = []
  for (const preset of ['qlib', 'aligned']) {
    const q = loadJson(`${OUT}/gate-rung3-${preset}.json`)
    const qh = new Map(q.holdings.map((h) => [h.date, norm(h.codes)]))
    const dates = [...mh.keys()].filter((d) => qh.has(d)).sort()
    let same = 0
    const diffs = []
    for (const d of dates) {
      const a = mh.get(d) ?? '', b = qh.get(d) ?? ''
      if (a === b) same++; else diffs.push({ date: d, mine: a, qlib: b })
    }
    // 净值逐日对账
    const mnav = new Map(mine.nav.map((x) => [x.date, x.nav]))
    const qnav = new Map(q.nav.map((x) => [x.date, x.nav]))
    const common = [...mnav.keys()].filter((d) => qnav.has(d)).sort()
    let worst = null
    const retDiff = []
    for (let i = 1; i < common.length; i++) {
      const d = common[i], p = common[i - 1]
      const mr = mnav.get(d) / mnav.get(p) - 1
      const qr = qnav.get(d) / qnav.get(p) - 1
      const dd = mr - qr
      retDiff.push(dd)
      if (!worst || Math.abs(dd) > Math.abs(worst.d)) worst = { date: d, mine: mr, qlib: qr, d: dd }
    }
    const mean = retDiff.reduce((a, b) => a + b, 0) / (retDiff.length || 1)
    const sd = Math.sqrt(retDiff.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, retDiff.length - 1))
    rows.push({
      preset, label: q.preset_label, holdingsSame: same, holdingsTotal: dates.length,
      holdingsPct: same / dates.length, diffs,
      mineTotal: mine.metrics.totalReturn, qlibTotal: q.total_return,
      mineCagr: mine.metrics.cagr, qlibCagr: q.risk.annualized_return,
      mineVol: mine.metrics.annualVol, qlibVol: q.risk.std * Math.sqrt(252),
      mineMdd: mine.metrics.maxDrawdown, qlibMdd: q.risk.max_drawdown,
      mineSharpe: mine.metrics.sharpe, qlibSharpe: q.risk.information_ratio,
      mineCost: mine.metrics.fees.commission + mine.metrics.fees.stampDuty + mine.metrics.fees.transferFee,
      qlibCost: q.totalCost, qlibGrossCagr: q.risk.annualized_return,
      worstDay: worst, retDiffMean: mean, retDiffSd: sd,
    })
  }

  const pctf = (x) => `${(x * 100).toFixed(2)}%`
  for (const r of rows) {
    console.log(`── ${r.preset}（${r.label}）`)
    console.log(`   持仓一致 ${r.holdingsSame}/${r.holdingsTotal} = ${(r.holdingsPct * 100).toFixed(1)}%   不一致日 ${r.diffs.length}`)
    console.log(`   净值：我方 ${pctf(r.mineTotal)}（年化 ${pctf(r.mineCagr)}）| qlib ${pctf(r.qlibTotal)}（account 口径年化 ${pctf(Math.pow(1 + r.qlibTotal, 252 / r.holdingsTotal) - 1)}）`)
    console.log(`   波动：我方 ${pctf(r.mineVol)} | qlib ${pctf(r.qlibVol)}（qlib 的 risk 统计是**毛收益**口径，不含费用）`)
    console.log(`   最大回撤：我方 ${pctf(r.mineMdd)} | qlib ${pctf(r.qlibMdd)}   夏普/IR：${r.mineSharpe} / ${r.qlibSharpe}`)
    console.log(`   费用：我方 ${r.mineCost.toFixed(0)} | qlib ${r.qlibCost.toFixed(0)}`)
    console.log(`   日收益差：均值 ${(r.retDiffMean * 100).toFixed(4)}pp  标准差 ${(r.retDiffSd * 100).toFixed(4)}pp  最差日 ${r.worstDay.date} 我 ${pctf(r.worstDay.mine)} vs qlib ${pctf(r.worstDay.qlib)}（${(r.worstDay.d * 100).toFixed(2)}pp）`)
    if (r.diffs.length) {
      const dates = r.diffs.map((d) => d.date)
      console.log(`   不一致日区间：${dates[0]} ~ ${dates[dates.length - 1]}`)
      for (const d of r.diffs.slice(0, 4)) console.log(`     ${d.date} 我[${d.mine}] qlib[${d.qlib}]`)
    }
    console.log('')
  }
  writeFileSync(`${OUT}/gate-rung3-cmp.json`, JSON.stringify(rows, null, 2))
}
