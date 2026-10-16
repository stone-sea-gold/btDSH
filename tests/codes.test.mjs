/**
 * 代码/日期工具单测。
 *
 * 重点是 `dayOrdinal` / `calendarDaysBetween`：仓库里的日期是 YYYYMMDD 十进制写法，
 * 整数相减不是天数（20240110 − 20231225 = 8885，实际 16 天）。这个缺陷曾让
 * "上市不足 N 日"的股票池过滤在真实数据上几乎永不触发。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dayOrdinal, calendarDaysBetween, limitRatioOf, boardOf, secidOf, normalizeCode } from '../lib/data/codes.mjs'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../lib/data/store.mjs'
import { tradability, loadMarket } from '../lib/backtest/engine.mjs'

test('dayOrdinal：同一月内、跨月、跨年、闰年都给出正确的天序号', () => {
  assert.equal(calendarDaysBetween(20240110, 20240105), 5, '同月')
  assert.equal(calendarDaysBetween(20240110, 20231225), 16, '跨年（整数差 8885 是错的）')
  assert.equal(calendarDaysBetween(20240301, 20240228), 2, '闰年 2 月有 29 天')
  assert.equal(calendarDaysBetween(20230301, 20230228), 1, '平年 2 月只有 28 天')
  assert.equal(calendarDaysBetween(20250101, 20240101), 366, '2024 是闰年')
  assert.equal(calendarDaysBetween(20260101, 20250101), 365)
  assert.equal(dayOrdinal(20240101) + 1, dayOrdinal(20240102), '相邻日序号差 1')
  assert.equal(dayOrdinal(99999999), null, '非法日期返回 null')
})

test('代码记法：板块与涨跌停幅度', () => {
  assert.equal(boardOf('600519'), 'sh_main')
  assert.equal(boardOf('688981'), 'star')
  assert.equal(boardOf('300750'), 'chinext')
  assert.equal(boardOf('000001'), 'sz_main')
  assert.equal(limitRatioOf('300750'), 0.2)
  assert.equal(limitRatioOf('600519'), 0.1)
  assert.equal(limitRatioOf('600519', true), 0.05, 'ST 覆盖为 5%')
  assert.equal(secidOf('600519'), '1.600519')
  assert.equal(normalizeCode('sh600519'), '600519')
})

test('回测可交易性：上市天数按真实自然日判定（而非 YYYYMMDD 整数差）', () => {
  const store = openStore(':memory:')
  store.upsertCodes([
    { code: '600000', name: '老股', market: 1, board: 'sh_main', isSt: false, listDate: 20100101 },
    { code: '600003', name: '次新', market: 1, board: 'sh_main', isSt: false, listDate: 20231225 },
  ])
  for (const code of ['600000', '600003']) {
    store.upsertBars(code, [{ date: 20240110, open: 10, high: 10.2, low: 9.8, close: 10, volume: 1e6, amount: 1e7, pct: 0, turnover: 1 }])
  }
  const market = loadMarket(store, { start: 20240101, end: 20240131 })
  assert.equal(tradability(market, '600000', 20240110, 'buy').ok, true, '老股可交易')
  const t = tradability(market, '600003', 20240110, 'buy')
  assert.equal(t.ok, false)
  assert.equal(t.reason, 'new-listing', '上市 16 自然日 < 60 → 拒绝')
  assert.equal(tradability(market, '600003', 20240110, 'buy', { minListDays: 10 }).ok, true, '放宽到 10 日则可交易')
  store.close()
})

test('仓库：temp_store 选项（file 模式必须自己找到可写的临时目录）', () => {
  const mem = openStore(':memory:', { tempStore: 'memory' })
  // PRAGMA temp_store 取值：0=DEFAULT 1=FILE 2=MEMORY
  assert.equal(mem.raw.prepare('PRAGMA temp_store').get().temp_store, 2)
  mem.close()

  // :memory: 路径没有同级目录可放临时文件 → 必须安全退回，而不是抛 "unable to open database file"
  const mem2 = openStore(':memory:', { tempStore: 'file' })
  assert.ok(mem2.raw.prepare('PRAGMA temp_store').get(), 'file 模式在无目录时应退回而非抛错')
  mem2.close()

  // 真实文件路径：应在仓库同级建出 .sqlite-tmp 并把 SQLITE_TMPDIR 指过去
  const dir = mkdtempSync(join(tmpdir(), 'dsh-quant-store-'))
  const prevTmp = process.env.SQLITE_TMPDIR
  delete process.env.SQLITE_TMPDIR
  const file = openStore(join(dir, 'x.db'), { tempStore: 'file' })
  assert.equal(file.raw.prepare('PRAGMA temp_store').get().temp_store, 1, '1 = FILE')
  assert.equal(process.env.SQLITE_TMPDIR, join(dir, '.sqlite-tmp'), '临时目录指向仓库同级')
  assert.ok(existsSync(join(dir, '.sqlite-tmp')), '临时目录已创建')
  file.close()
  if (prevTmp === undefined) delete process.env.SQLITE_TMPDIR; else process.env.SQLITE_TMPDIR = prevTmp
  rmSync(dir, { recursive: true, force: true })
})
