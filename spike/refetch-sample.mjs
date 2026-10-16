/**
 * 定向补拉验收样本（P6 验收标准 1 的修复步骤）。
 *
 * ## 为什么需要
 *
 * 第一次全市场同步期间东财被 IP 级限流，导致：
 *   - `bars.pct` 覆盖率只有 2.1%（官方涨跌幅拿不到）
 *   - **`adj_events` 大面积缺失**：8075 个事件 / 5481 只 ≈ 1.5 个/只（正常应约 10 个/只）
 *
 * 后果由 BaoStock oracle 直接暴露：**事件完整的正常股票与 P1 完全一致（0.00005pp）**，
 * 而事件缺失的股票偏差巨大 —— 例如 000540 在 2017-08~2019-01 长停牌期间有一次公司行为，
 * 我的事件表里是空的，于是复牌日算出 -40.4%，而官方是 -10.06%（隐含参考价 4.87，
 * 7.35/4.87 = 1.51 正好是那一次分配）。
 *
 * 所以这不是复权算法的问题，是**事件源在限流下没拉到**。修法就是：等东财恢复，把样本重拉一遍。
 *
 * 用法: node spike/refetch-sample.mjs [dataDir] [--no-wait]
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createRuntime } from '../lib/runtime.mjs'
import { syncBars, defaultRange } from '../lib/data/sync.mjs'
import { fetchJson, resetCircuits } from '../lib/data/http.mjs'

const DIR = process.argv[2] ?? 'spike/out/full-market'
const NO_WAIT = process.argv.includes('--no-wait')

const report = JSON.parse(readFileSync(join(DIR, 'acceptance-1.json'), 'utf8'))
const codes = [...new Set(report.emPct.perCode.map((p) => p.code))]
console.log(`样本 ${codes.length} 只（退市 / 高分红 / 长停牌）`)

const t0 = Date.now()
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s]`
const log = (m) => console.log(`${stamp()} ${m}`)

/** 分红走 datacenter-web（与 push2 家族不同主机，实测限流影响较小） */
async function probeDatacenter() {
  const r = await fetchJson(
    'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=ALL&pageSize=5&filter=(SECURITY_CODE%3D%22000540%22)',
    { tries: 1, timeoutMs: 10000 },
  )
  return r.ok && Array.isArray(r.json?.result?.data)
}
async function probePush2his() {
  const r = await fetchJson(
    'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=0.000540&fields1=f1,f2,f3&fields2=f51,f53&klt=101&fqt=0&beg=20190101&end=20190110',
    { tries: 1, timeoutMs: 8000 },
  )
  return r.ok && (r.json?.data?.klines?.length ?? 0) > 0
}

if (!NO_WAIT) {
  log('等东财（datacenter 供分红、push2his 供官方 pct）…')
  for (let i = 1; i <= 60; i++) {
    resetCircuits()
    const d = await probeDatacenter()
    const k = d ? await probePush2his() : false
    log(`探针 #${i}：datacenter ${d ? 'OK' : 'FAIL'}  push2his ${k ? 'OK' : 'FAIL'}`)
    if (d && k) break
    if (i === 60) { log('等待超时'); process.exit(2) }
    await new Promise((r) => setTimeout(r, 120_000))
  }
  log('东财已恢复')
}

const runtime = createRuntime({ dataDir: DIR })
const store = runtime.store()
const { to } = defaultRange()
const before = store.raw.prepare('SELECT count(*) c FROM adj_events').get().c
log(`补拉前：adj_events ${before} 个`)

// resume: false —— 强制重拉（否则 bars_last>=to 会被跳过，事件也就不会重建）
const r = await syncBars(store, {
  codes, from: 20160101, to, resume: false, batchSize: 10,
  withDividends: true, withFundamentals: false,
  onProgress: ({ done, total, code, status }) => {
    if (done % 10 === 0 || done === total) log(`${done}/${total} ${code} ${status}`)
  },
})

const after = store.raw.prepare('SELECT count(*) c FROM adj_events').get().c
const q = (s, ...a) => store.raw.prepare(s).get(...a)
log(`补拉后：adj_events ${after} 个（+${after - before}）`)
log(`样本内带官方 pct 的 bar：${q("SELECT count(*) c FROM bars WHERE pct IS NOT NULL AND code IN (" + codes.map(() => '?').join(',') + ")", ...codes).c}`)
log(`样本内复权事件：${q("SELECT count(*) c FROM adj_events WHERE code IN (" + codes.map(() => '?').join(',') + ")", ...codes).c}`)
log(`完成：${JSON.stringify({ done: r.done, failed: r.failed, bars: r.bars, events: r.events, ms: Date.now() - t0 })}`)
runtime.close()
