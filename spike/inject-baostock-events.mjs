/**
 * 把 BaoStock 反推的事件（reference-price 口径）注入样本库的 adj_events。
 *
 * ## 为什么要有这一步
 *
 * 验收标准 1 的 oracle 第一次跑出来"CHECK"（148 天超阈、最大 65.6pp），
 * 逐项归因后确认：**不是复权算法错**——事件完整的正常股票与 P1 完全一致（0.00005pp）；
 * 是**事件缺失**：全市场同步期间东财被 IP 级限流，8075 个事件 / 5481 只 ≈ 1.5 个/只
 * （正常应约 10 个/只），样本里"无事件"的股票复权退化为原始口径，复牌日偏差可达 30~60pp。
 *
 * 解法不依赖东财：BaoStock 的 `preclose` 就是**交易所除权参考价**，
 * `factor = prevClose / ref` 可以反推出每次分配（P1 就是这么建离线表的）。
 * 所以这里把那张表灌进样本库，再看 oracle 还挂不挂 —— 挂就说明算法真有问题。
 *
 * 用法: node spike/inject-baostock-events.mjs <样本库路径> <factor-events.json.gz>
 */

import { readFileSync, statSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { openStore } from '../lib/data/store.mjs'

const DB = process.argv[2] ?? 'spike/out/full-market/acceptance-1-sample.db'
const JSONGZ = process.argv[3] ?? 'spike/out/full-market/events-from-baostock/factor-events.json.gz'

const payload = JSON.parse(gunzipSync(readFileSync(JSONGZ)).toString('utf8'))
const events = payload.events ?? []
console.log(`事件表 ${events.length} 条（口径：${payload.convention?.slice(0, 60)}…）`)

const store = openStore(DB)
const before = store.raw.prepare('SELECT count(*) c FROM adj_events').get().c
// 离线表只覆盖**已发现的缺口**，灌进去要抑制"运行时事件" —— 但 oracle 读的是库里
// 已物化的 adj_events，所以这里直接 UPSERT，factor 由事件表自算口径保证。
let added = 0
store.raw.exec('BEGIN')
try {
  for (const [code, exDate, cash, bonus, transfer] of events) {
    store.raw.prepare(`
      INSERT INTO adj_events(code,date,cash_per_share,bonus_per_share,transfer_per_share,factor)
      VALUES(?,?,?,?,?,NULL)
      ON CONFLICT(code,date) DO UPDATE SET
        cash_per_share=excluded.cash_per_share,
        bonus_per_share=excluded.bonus_per_share,
        transfer_per_share=excluded.transfer_per_share
    `).run(code, exDate, cash ?? 0, bonus ?? 0, transfer ?? 0)
    added++
  }
} finally { store.raw.exec('COMMIT') }
const after = store.raw.prepare('SELECT count(*) c FROM adj_events').get().c

// factor 还是 NULL：oracle 用的是**库里的 factor**，所以要从事件金额 + 前 bar 收盘反推 factor
const derived = store.raw.prepare(`
  SELECT code, date, cash_per_share cash, bonus_per_share bonus, transfer_per_share transfer
  FROM adj_events WHERE factor IS NULL`).all()
let factored = 0
store.raw.exec('BEGIN')
try {
  for (const e of derived) {
    const bars = store.raw.prepare('SELECT date, close FROM bars WHERE code=? AND date>=? ORDER BY date LIMIT 2').all(e.code, e.date)
    const cur = bars[0], prev = store.raw.prepare('SELECT close FROM bars WHERE code=? AND date<? ORDER BY date DESC LIMIT 1').get(e.code, e.date)
    if (!cur || !prev?.close) continue
    const denom = 1 + (e.bonus ?? 0) + (e.transfer ?? 0)
    if (denom <= 0) continue
    const ref = Math.round((prev.close - (e.cash ?? 0)) / denom * 100) / 100
    if (ref <= 0) continue
    store.raw.prepare('UPDATE adj_events SET factor=? WHERE code=? AND date=?').run(prev.close / ref, e.code, e.date)
    factored++
  }
} finally { store.raw.exec('COMMIT') }

const missing = store.raw.prepare('SELECT count(*) c FROM adj_events WHERE factor IS NULL').get().c
console.log(`adj_events：${before} → ${after}（覆盖 ${added} 条，反推 factor ${factored} 条，仍缺 ${missing}）`)
console.log(`库 ${DB}  ${(statSync(DB).size / 1024).toFixed(1)} KB`)
store.close()
console.log('\n下一步：python3 spike/oracle-baostock.py ' + DB + ' spike/out/full-market')
