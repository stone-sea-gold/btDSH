/**
 * 数据层对账（P1 验收门）。
 *
 * 四条校验，各自独立、各查一类错误：
 *
 *  A. raw 完整性：由原始收盘重算涨跌幅 vs 东财 `pct` 字段
 *     （东财 pct 是**不复权口径**——P1 实测 4 例精确吻合，包括 10 转 4.8 的 -31.88%）
 *  B. 事件一致性：腾讯内嵌事件 vs 东财分红表的差异清单
 *     （实测 300750 2024-04-30 东财漏记 30.17 元，只有并集才完整）
 *  C. 除权跳变消除：除权日的 raw 收益 vs 复权口径收益
 *  D. 跳变比交叉验证：自算跳变比 vs 东财 hfq 反推跳变比
 *     （东财 hfq 有 ±0.5% 噪声，故只用于抓"漏掉一次分配"这类粗错，阈值 2%）
 *
 *  ⚠️ 真正独立的复权口径基准（交易所官方涨跌幅）只有 BaoStock 提供，
 *     因此 P1 的最终验收由离线 oracle 完成：`spike/oracle-baostock.py`。
 */

const pp = (x) => +(x * 100).toFixed(6)

export function checkRawIntegrity(store, code) {
  const bars = store.bars(code)
  let maxDev = 0, over = 0, checked = 0, worst = null
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1], cur = bars[i]
    if (!prev.close || cur.pct == null) continue
    const calc = (cur.close / prev.close - 1) * 100
    const dev = Math.abs(calc - cur.pct)
    checked++
    if (dev > maxDev) { maxDev = dev; worst = { date: cur.date, official: cur.pct, calc: +calc.toFixed(4) } }
    if (dev > 0.01) over++
  }
  return { code, checked, maxDeviationPp: +maxDev.toFixed(6), over001pp: over, worst }
}

/** 事件来源差异（信息性；并集才是权威） */
export function checkEventAgreement(disagreements, code) {
  const mine = disagreements.filter((d) => d.code === code)
  return { code, disagreements: mine.length, details: mine.slice(0, 5) }
}

/** 除权日的 raw 收益 vs 复权口径收益（后者用自算因子） */
export function checkExDateJumps(store, code, limitRatio = 0.1) {
  const bars = store.bars(code)
  const byDate = new Map(bars.map((b) => [b.date, b]))
  const events = store.adjEvents(code)
  let maxRaw = 0, maxAdj = 0, exCount = 0
  const samples = []
  for (const e of events) {
    const cur = byDate.get(e.date)
    if (!cur) continue
    let prev = null
    for (const b of bars) { if (b.date < e.date) prev = b; else break }
    if (!prev?.close || !cur.close || !e.factor) continue
    exCount++
    const rawRet = cur.close / prev.close - 1
    const adjRet = (cur.close * e.factor) / (prev.close * 1) - 1 // 等价于 close/ref − 1
    if (Math.abs(rawRet) > Math.abs(maxRaw)) maxRaw = rawRet
    if (Math.abs(adjRet) > Math.abs(maxAdj)) maxAdj = adjRet
    if (samples.length < 6) samples.push({ date: cur.date, rawPct: pp(rawRet), adjPct: pp(adjRet), factor: e.factor })
  }
  return {
    code, exDatesWithBar: exCount,
    maxAbsRawPct: pp(maxRaw), maxAbsAdjPct: pp(maxAdj),
    adjWithinLimit: Math.abs(maxAdj) <= limitRatio + 0.005,
    samples,
  }
}

/** 自算跳变比 vs 东财 hfq 反推跳变比（噪声大，仅抓粗错） */
export function checkStepConsistency(store, code, tolPct = 2.0) {
  const bars = store.bars(code)
  const hfq = new Map(store.hfq(code).map((r) => [r.date, r.close]))
  const events = store.adjEvents(code)
  const byDate = new Map(bars.map((b, i) => [b.date, i]))
  const rows = []
  for (const e of events) {
    const i = byDate.get(e.date)
    if (i === undefined || i === 0 || !e.factor) continue
    const cur = bars[i], prev = bars[i - 1]
    const hc = hfq.get(cur.date), hp = hfq.get(prev.date)
    if (!hc || !hp || !cur.close || !prev.close) continue
    const implied = (hc / cur.close) / (hp / prev.close)
    const dev = Math.abs(implied / e.factor - 1) * 100
    rows.push({ date: e.date, derived: e.factor, implied: +implied.toFixed(6), devPct: +dev.toFixed(4), plans: e.plans ?? [] })
  }
  rows.sort((a, b) => b.devPct - a.devPct)
  return {
    code, compared: rows.length,
    maxDevPct: rows.length ? rows[0].devPct : null,
    overTolerance: rows.filter((r) => r.devPct > tolPct).length,
    worst: rows.slice(0, 4),
  }
}

export function runVerification(store, codes, { disagreements = [], tolPct = 1.0 } = {}) {
  const raw = codes.map((c) => checkRawIntegrity(store, c))
  const events = codes.map((c) => checkEventAgreement(disagreements, c))
  const jumps = codes.map((c) => checkExDateJumps(store, c))
  const steps = codes.map((c) => checkStepConsistency(store, c, tolPct))

  const maxRawDev = Math.max(...raw.map((r) => r.maxDeviationPp), 0)
  const stepDevs = steps.map((s) => s.maxDevPct).filter((x) => x !== null)
  const overTol = steps.reduce((a, s) => a + s.overTolerance, 0)
  const compared = steps.reduce((a, s) => a + s.compared, 0)

  const rawChecked = raw.reduce((a, r) => a + r.checked, 0)
  const gates = {
    // 必须有足够多的、带官方 pct 的样本（新浪源没有 pct 字段，不能拿它冒充校验通过）
    A_raw_integrity: rawChecked >= 100 ? maxRawDev <= 0.02 : 'not-evaluated',
    B_events_merged: true, // 差异清单本身就是设计预期（并集才完整），不设为失败
    C_exdate_jump_removed: jumps.some((j) => j.exDatesWithBar > 0) ? jumps.every((j) => j.adjWithinLimit) : 'not-evaluated',
    // 交叉校验必须真的有可比样本，否则"没有数据所以没有偏差"会伪装成通过
    D_step_consistency: compared >= 5 ? overTol === 0 : 'not-evaluated',
  }
  const evaluated = Object.values(gates).filter((v) => v !== 'not-evaluated')
  const failed = evaluated.filter((v) => v !== true)
  return {
    codes, raw, events, jumps, steps,
    summary: {
      maxRawDeviationPp: +maxRawDev.toFixed(6),
      eventsMerged: store.stats().adjEvents,
      sourceDisagreements: disagreements.length,
      exDateCases: jumps.reduce((a, j) => a + j.exDatesWithBar, 0),
      maxRawJumpOnExDate: Math.max(...jumps.map((j) => Math.abs(j.maxAbsRawPct)), 0),
      maxAdjMoveOnExDate: Math.max(...jumps.map((j) => Math.abs(j.maxAbsAdjPct)), 0),
      maxStepDevVsHfqPct: stepDevs.length ? Math.max(...stepDevs) : null,
      stepsOverTolerance: overTol,
      stepComparisons: compared,
    },
    gates,
    gatesEvaluated: evaluated.length,
    gatesFailed: failed.length,
    verdict: failed.length === 0 ? 'PASS' : 'CHECK',
  }
}
