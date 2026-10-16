/**
 * P6 验收标准 1 的数据底座：全市场同步。
 *
 * 为什么单独写脚本而不是调 `quant_data_sync` 工具：
 *   - 工具是给**模型**用的，一次调用要跑完；这里是**可中断、可续跑、带心跳、能等源站**的批处理。
 *   - 工具路径的审批护栏是给"模型替用户做决定"设的；这里用户已明确同意全市场同步。
 *
 * ## 为什么要等 EM 恢复
 *
 * 验收标准 1 是"自算涨跌幅 vs **东财官方 `pct` 字段**"。`pct` 只有东财 `push2his` 带，
 * 新浪回退给的 `pct` 是 `null`（P1 刻意不用自算值冒充官方口径）。
 * 所以**全程走新浪回退的话，这次同步拿不到对账基准** —— 数据能用，但对不了账。
 *
 * 实测：东财 `push2*` 在密集请求后会按 IP 级拒绝（`UND_ERR_SOCKET`，非 429），过一段时间自己恢复。
 * 因此本脚本先**轮询等 EM 回来**再开始正式拉取，并在汇总里报告 pct 覆盖率。
 *
 * 用法:
 *   node spike/full-market-sync.mjs [dataDir] [from] [--codes-only|--bars-only] [--no-wait]
 *
 * 断点续传：`syncBars` 的 resume 会跳过 `bars_last >= to` 的股票，直接重跑即可。
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { createRuntime } from '../lib/runtime.mjs'
import { syncCodes, syncBars, defaultRange } from '../lib/data/sync.mjs'
import { circuitState, fetchJson, resetCircuits } from '../lib/data/http.mjs'
import { ALL_A_FS } from '../lib/data/sources.mjs'

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const pos = args.filter((a) => !a.startsWith('--'))
const DIR = pos[0] ?? 'spike/out/full-market'
const FROM = Number(pos[1] ?? 20160101)
const CODES_ONLY = flags.has('--codes-only')
const BARS_ONLY = flags.has('--bars-only')
const NO_WAIT = flags.has('--no-wait')

const t0 = Date.now()
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(0).padStart(6)}s]`
const log = (m) => console.log(`${stamp()} ${m}`)

/** push2his 探针：唯一能确认"官方 pct 拿得到"的办法 */
async function probeEmKline() {
  const r = await fetchJson(
    'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519&fields1=f1,f2,f3&fields2=f51,f53&klt=101&fqt=0&beg=20261001&end=20261015',
    { tries: 1, timeoutMs: 8000 },
  )
  return r.ok && (r.json?.data?.klines?.length ?? 0) > 0
}

/** clist 探针：代码表在 push2 主机上，与 push2his 是两个 host */
async function probeEmList() {
  const r = await fetchJson(
    `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=10&po=0&np=1&fltt=2&invt=2&fid=f12&fs=${encodeURIComponent(ALL_A_FS)}&fields=f12,f14`,
    { tries: 1, timeoutMs: 8000 },
  )
  return r.ok && Array.isArray(r.json?.data?.diff) && r.json.data.diff.length > 0
}

/** 等到 EM 指定 host 活过来。`need` ∈ list | kline | both */
async function waitForEm(need = 'both', { maxWaitMs = 8 * 3600_000, everyMs = 120_000 } = {}) {
  const start = Date.now()
  let n = 0
  while (Date.now() - start < maxWaitMs) {
    n++
    resetCircuits()   // 探测前清熔断，否则会被上一轮的熔断直接跳过（探针就永远"失败"）
    // **只等这一阶段真正需要的那个 host**。
    // 实测两个 host 会各自独立抖动（push2his 回来时 clist 还在封），
    // 要求"两个同时健康"会让等待几乎永远不满足。
    const needList = need === 'list' || need === 'both'
    const needKline = need === 'kline' || need === 'both'
    const l = needList ? await probeEmList() : null
    const k = needKline ? await probeEmKline() : null
    log(`EM 探针 #${n}（需要 ${need}）：clist ${l === null ? '-' : l ? 'OK' : 'FAIL'}  push2his ${k === null ? '-' : k ? 'OK' : 'FAIL'}`)
    if ((!needList || l) && (!needKline || k)) return true
    await new Promise((r) => setTimeout(r, everyMs))
  }
  return false
}

const runtime = createRuntime({ dataDir: DIR })
const store = runtime.store()
log(`仓库 ${DIR}`)

// ── 0) 等 EM 恢复 ───────────────────────────────────────────────────────────
if (!NO_WAIT && !BARS_ONLY) {
  log('等东财 clist 恢复（代码表只有这一个源，没有回退）…')
  if (!await waitForEm('list')) { log('等待超时，clist 仍未恢复'); process.exit(2) }
  log('clist 已恢复')
}

// ── 1) 代码表 ───────────────────────────────────────────────────────────────
const have = store.codesList().length
if (!BARS_ONLY) {
  if (have >= 1000) {
    log(`代码表已有 ${have} 只，跳过拉取（没必要为同一份数据再打一遍源站）`)
  } else {
    log(`同步代码表（现有 ${have} 只）…`)
    let cr = null
    for (let i = 1; i <= 6; i++) {
      resetCircuits()
      cr = await syncCodes(store)
      if (cr.ok) break
      log(`代码表第 ${i} 次失败：${cr.error?.message ?? '?'}；等 2 分钟后重试`)
      await new Promise((r) => setTimeout(r, 120_000))
    }
    if (!cr?.ok) { log('代码表始终失败'); process.exit(1) }
    log(`代码表 ${cr.codes} 只（total ${cr.total}）`)
  }
}
const codes = store.codesList()
log(`库内代码 ${codes.length} 只`)

if (CODES_ONLY) {
  const byBoard = {}
  for (const x of codes) byBoard[x.board] = (byBoard[x.board] ?? 0) + 1
  const delisted = codes.filter((x) => /退/.test(x.name ?? '')).length
  log(`板块分布 ${JSON.stringify(byBoard)}；名称含「退」${delisted} 只`)
  mkdirSync(DIR, { recursive: true })
  writeFileSync(join(DIR, 'codes-summary.json'), JSON.stringify({ total: codes.length, byBoard, delisted }, null, 2))
  runtime.close()
  process.exit(0)
}

// ── 2) 行情 + 复权事件 ──────────────────────────────────────────────────────
const { to } = defaultRange()
log(`区间 ${FROM} ~ ${to}；预计约 ${codes.length * 2 + Math.ceil(codes.length / 50)} 次请求`)

let lastLog = 0
const r = await syncBars(store, {
  codes: null, from: FROM, to, resume: true, batchSize: 200,
  withDividends: true, withFundamentals: false,
  onProgress: ({ done, total, code, status }) => {
    const now = Date.now()
    if (now - lastLog < 20000 && done !== total) return   // 20s 一次心跳
    lastLog = now
    const pct = ((done / total) * 100).toFixed(1)
    const rate = done / Math.max(1, (now - t0) / 1000)
    const eta = rate > 0 ? ((total - done) / rate / 60).toFixed(0) : '?'
    const open = Object.values(circuitState()).filter((c) => c.open).length
    log(`${done}/${total} (${pct}%) ${code} ${status} | ${rate.toFixed(1)} 只/s | ETA ${eta} 分钟 | 熔断 ${open} 个开`)
  },
})

// ── 3) 汇总（含**对账可用性**：多少 bar 带官方 pct）──────────────────────────
const q = (s) => store.raw.prepare(s).get()
const stats = store.stats()
const withPct = q('SELECT count(*) c FROM bars WHERE pct IS NOT NULL').c
const summary = {
  dir: DIR, from: FROM, to,
  codes: codes.length,
  synced: r.done, skipped: r.skipped, failed: r.failed,
  bars: r.bars, events: r.events,
  droppedNoPrevBar: r.droppedNoPrevBar ?? 0, fromTable: r.fromTable ?? 0,
  dbBars: stats.bars, dbCodes: stats.codes, dbAdjEvents: stats.adjEvents,
  barsWithOfficialPct: withPct,
  pctCoverage: stats.bars > 0 ? +(withPct / stats.bars).toFixed(4) : 0,
  range: stats.barsRange,
  ms: Date.now() - t0,
  errors: (r.errors ?? []).slice(0, 30),
}
log(`完成：${JSON.stringify({ ...summary, errors: summary.errors.length })}`)

mkdirSync(DIR, { recursive: true })
writeFileSync(join(DIR, 'sync-summary.json'), JSON.stringify(summary, null, 2))
runtime.close()
process.exit(r.failed > codes.length * 0.05 ? 1 : 0)
