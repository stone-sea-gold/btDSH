/**
 * 复权事件合并与因子推导。
 *
 * P1 实测确立的规则（不要用"看起来更简单"的做法替换）：
 *
 *  1. **事件源必须是腾讯 K 线内嵌元数据 ∪ 东财分红表**。东财在同一天多次分配时会漏记
 *     （实测 300750 2024-04-30：东财只记 10派20.11元，腾讯记 10派30.17元，
 *      交易所参考价用的是两者之和 50.28）。腾讯的元数据搭在本来就要发的 K 线请求上。
 *  2. **同一天的事件必须按金额求和**（交易所参考价是合并计算的）：
 *        ref = round( (前收 − Σ每股现金) / (1 + Σ送股 + Σ转增), 2 )
 *     —— **参考价四舍五入到分**，这是与官方涨跌幅吻合的关键（实测 600519/000001 精确到 0.0002pp）。
 *  3. **不要用厂商的复权序列反推因子**：东财 qfq/hfq 在非除权日有 ±0.5% 抖动，
 *     腾讯 qfq/hfq 比值本应恒定却抖动 0.05%–1.6%。原始价 + 自算因子才是可靠路径。
 */

const round2 = (x) => Math.round(x * 100) / 100

/** 东财分红行 → 统一事件结构（每股口径） */
export function fromEmDividend(row) {
  return {
    code: row.code,
    exDate: row.exDate,
    recordDate: row.recordDate ?? null,
    noticeDate: row.noticeDate ?? null,
    cashPerShare: row.cashPerShare ?? 0,
    bonusPerShare: row.bonusPerShare ?? 0,
    transferPerShare: row.transferPerShare ?? 0,
    planText: row.plan ?? null,
    source: 'em-datacenter',
  }
}

/** 腾讯嵌入元数据 → 统一事件结构（输入为每 10 股口径） */
export function fromTencentEvent(ev) {
  return {
    code: ev.code,
    exDate: ev.exDate,
    recordDate: ev.recordDate ?? null,
    noticeDate: null,
    cashPerShare: (ev.cash10 ?? 0) / 10,
    bonusPerShare: (ev.bonus10 ?? 0) / 10,
    transferPerShare: (ev.transfer10 ?? 0) / 10,
    planText: ev.planText ?? null,
    source: 'tencent-embedded',
  }
}

/**
 * 合并事件。
 *
 * **关键规则（P1 用 BaoStock 参考价逐例验证得出）**：
 * 同一 (code, exDate) 上两个源的关系只有两种可能——
 *   ① 两源取值相同 → 是**同一笔**分配 → 只取其一（相加会把同一笔算两遍）；
 *   ② 两源取值不同 → 是**同一天的两笔**分配 → 相加（交易所参考价按合计计算）。
 *
 * 实证：
 *   两源相同（不能相加）：002594 2025-07-29 送8转12派3.974（ref 111.01 精确）、
 *     603535 2024-08-29 转4.8派0.1（ref 8.92 精确）、300750 2023-04-26 转8派2.52（ref 212.99 精确）；
 *   两源不同（必须相加）：300750 2024-04-30 东财 2.011 + 腾讯 3.017 = 5.028（真值 5.01）、
 *     601318 2018-06-07 东财 1.0 + 腾讯 0.2 = 1.2（真值 1.20，精确）。
 *
 * @returns {{ events: Array, disagreements: Array }}
 */
export function mergeDividendEvents({ tencentEvents = [], emEvents = [] } = {}) {
  const TOL = 1e-3 // 元/股；两源对同一金额的精度不同（腾讯 280.242 vs 东财 280.2423）
  const groups = new Map()
  const add = (e) => {
    const key = `${e.code}|${e.exDate}`
    const g = groups.get(key) ?? { code: e.code, exDate: e.exDate, sources: new Set(), plans: [], perSource: {} }
    g.sources.add(e.source)
    if (e.planText) g.plans.push(e.planText)
    const s = (g.perSource[e.source] ??= { cash: 0, bonus: 0, transfer: 0 })
    s.cash += e.cashPerShare ?? 0
    s.bonus += e.bonusPerShare ?? 0
    s.transfer += e.transferPerShare ?? 0
    groups.set(key, g)
  }
  for (const e of tencentEvents) add(fromTencentEvent(e))
  for (const e of emEvents) add(fromEmDividend(e))

  const events = []
  const disagreements = []
  for (const g of groups.values()) {
    const t = g.perSource['tencent-embedded']
    const m = g.perSource['em-datacenter']
    let cash, bonus, transfer, mode
    if (t && m) {
      const same = Math.abs(t.cash - m.cash) <= TOL && Math.abs(t.bonus - m.bonus) <= TOL && Math.abs(t.transfer - m.transfer) <= TOL
      if (same) {
        mode = 'same-distribution'
        cash = m.cash; bonus = m.bonus; transfer = m.transfer
      } else {
        mode = 'two-distributions-summed'
        cash = t.cash + m.cash; bonus = t.bonus + m.bonus; transfer = t.transfer + m.transfer
        disagreements.push({
          code: g.code, exDate: g.exDate, mode,
          tencent: { cash: +t.cash.toFixed(4), bonus: +t.bonus.toFixed(4), transfer: +t.transfer.toFixed(4) },
          em: { cash: +m.cash.toFixed(4), bonus: +m.bonus.toFixed(4), transfer: +m.transfer.toFixed(4) },
          summed: { cash: +cash.toFixed(4), bonus: +bonus.toFixed(4), transfer: +transfer.toFixed(4) },
          note: '两源取值不同，按两笔分配相加（交易所参考价口径）',
        })
      }
    } else if (t) { mode = 'tencent-only'; cash = t.cash; bonus = t.bonus; transfer = t.transfer }
    else { mode = 'em-only'; cash = m.cash; bonus = m.bonus; transfer = m.transfer }

    events.push({
      code: g.code, exDate: g.exDate,
      // 默认值（未仲裁时使用）：两源不同取和、相同取其一、单源取其值
      cashPerShare: +cash.toFixed(6),
      bonusPerShare: +bonus.toFixed(6),
      transferPerShare: +transfer.toFixed(6),
      mergeMode: mode,
      candidates: t && m ? [
        { mode: 'em', cashPerShare: +m.cash.toFixed(6), bonusPerShare: +m.bonus.toFixed(6), transferPerShare: +m.transfer.toFixed(6) },
        { mode: 'tx', cashPerShare: +t.cash.toFixed(6), bonusPerShare: +t.bonus.toFixed(6), transferPerShare: +t.transfer.toFixed(6) },
        { mode: 'sum', cashPerShare: +cash.toFixed(6), bonusPerShare: +bonus.toFixed(6), transferPerShare: +transfer.toFixed(6) },
      ] : null,
      sources: [...g.sources],
      plans: g.plans,
    })
  }
  events.sort((a, b) => (a.code === b.code ? a.exDate - b.exDate : a.code.localeCompare(b.code)))
  return { events, disagreements }
}

/**
 * 用原始日线 + 后复权序列推导每次除权事件的跳变比，并在候选组合中仲裁。
 *
 * 仲裁依据（P1 实测）：hfq 隐含跳变 = (hfq_t/raw_t)/(hfq_{t-1}/raw_{t-1})，
 * 它只依赖当日，不受复权序列日常噪声影响（实测噪声约 ±0.05%~0.5%，
 * 而候选之间的差异通常 >1%），因此足以在 {em, tx, sum} 中选出正确者。
 *
 * 三个已验证案例（选中者与交易所参考价一致）：
 *   300750 2024-04-30 → sum（差 0.027%）· 300750 2026-04-22 → em（差 0.033%）
 *   601318 2018-06-07 → sum（差 0.077%）
 *
 * @param {Array} events mergeDividendEvents 的输出
 * @param {Array} rawBars 原始日线（升序，含 date/close）
 * @param {Array} hfqRows 后复权收盘（升序，含 date/close）；缺失时退化为默认候选并标记 unresolved
 */
export function resolveEventFactors(events, rawBars, hfqRows = []) {
  const bars = [...rawBars].sort((a, b) => a.date - b.date)
  const hfq = new Map(hfqRows.map((r) => [r.date, r.close]))
  const prevBarOf = (date) => {
    for (let i = bars.length - 1; i >= 0; i--) if (bars[i].date < date && bars[i].close) return bars[i]
    return null
  }
  const barAt = (date) => bars.find((b) => b.date === date) ?? null

  const factorOf = (cand, prevClose) => {
    const denom = 1 + (cand.bonusPerShare ?? 0) + (cand.transferPerShare ?? 0)
    const refRaw = (prevClose - (cand.cashPerShare ?? 0)) / denom
    if (!(refRaw > 0)) return null
    const refPrice = round2(refRaw)
    return { refPrice, factor: prevClose / refPrice }
  }

  return events.map((e) => {
    const prev = prevBarOf(e.exDate)
    if (!prev) return { ...e, factor: null, refPrice: null, arbitration: { chosen: null, reason: 'no-prev-bar' } }

    const base = e.candidates ?? [{ mode: 'single', cashPerShare: e.cashPerShare, bonusPerShare: e.bonusPerShare, transferPerShare: e.transferPerShare }]
    const scored = base.map((c) => {
      const f = factorOf(c, prev.close)
      return f ? { ...c, ...f } : { ...c, refPrice: null, factor: null }
    }).filter((c) => c.factor)

    if (scored.length === 0) return { ...e, factor: null, refPrice: null, arbitration: { chosen: null, reason: 'no-valid-candidate' } }
    if (scored.length === 1) return { ...e, ...scored[0], arbitration: { chosen: scored[0].mode, reason: 'single-source' } }

    // 隐含跳变
    const cur = barAt(e.exDate)
    const hc = cur ? hfq.get(cur.date) : undefined
    const hp = hfq.get(prev.date)
    const implied = hc && hp && cur?.close ? (hc / cur.close) / (hp / prev.close) : null

    if (implied === null) {
      const fallback = scored.find((c) => c.mode === 'sum') ?? scored[0]
      return { ...e, ...fallback, arbitration: { chosen: fallback.mode, reason: 'hfq-unavailable-default-sum', candidates: scored.map((c) => ({ mode: c.mode, factor: +c.factor.toFixed(6) })) } }
    }

    const ranked = scored
      .map((c) => ({ ...c, devPct: Math.abs(c.factor / implied - 1) * 100 }))
      .sort((a, b) => a.devPct - b.devPct)
    const best = ranked[0]
    return {
      ...e, ...best,
      arbitration: {
        chosen: best.mode,
        reason: 'hfq-implied-step',
        implied: +implied.toFixed(6),
        candidates: ranked.map((c) => ({ mode: c.mode, factor: +c.factor.toFixed(6), devPct: +c.devPct.toFixed(4) })),
      },
    }
  })
}

/** 由事件链生成逐日累计因子（用于把原始价转成复权价，或反之） */
export function cumulativeFactors(events) {
  const sorted = [...events].filter((e) => e.factor).sort((a, b) => a.exDate - b.exDate)
  let cum = 1
  const points = []
  for (const e of sorted) {
    cum *= e.factor
    points.push({ date: e.exDate, cum: +cum.toFixed(8) })
  }
  return points
}

/** 给定日期取累计因子（分段常数） */
export function factorAt(points, date) {
  let f = 1
  for (const p of points) { if (p.date <= date) f = p.cum; else break }
  return f
}
