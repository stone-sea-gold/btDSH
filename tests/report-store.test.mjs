/**
 * 报告入库（`reports` 表）单测。
 *
 * 契约：回测跑完即入库一份**模型 JSON**，随行带渲染契约版本与工作区归属；
 * 同一回测重跑覆盖而不追加。HTML 成品不在这里生成（那是导出时的事）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../lib/data/store.mjs'
import { storeBacktestReport } from '../lib/dashboard/reports.mjs'
import { DASHBOARD_SCHEMA_VERSION } from '../lib/dashboard/model.mjs'
import { DASHBOARD_RENDER_VERSION } from '../lib/dashboard/render.mjs'

function makeNav(n = 60) {
  const nav = []
  let v = 1
  for (let i = 0; i < n; i++) {
    v *= 1 + (i < n / 2 ? 0.003 : -0.002)
    nav.push({ date: 20240102 + i, nav: +v.toFixed(6) })
  }
  return nav
}

function makeRecord(id = 'bt_1') {
  const nav = makeNav()
  return {
    backtest_id: id,
    strategy_id: 'demo',
    version: 1,
    config: { start: nav[0].date, end: nav.at(-1).date, initialCash: 1_000_000, factors: [], selection: { k: 10 }, rebalance: 'monthly', weight: 'equal' },
    metrics: {
      days: nav.length, totalReturn: 0.1, cagr: 0.2, annualVol: 0.2, sharpe: 0.9, maxDrawdown: -0.1,
      calmar: 2, winRate: 0.5, trades: 12, turnover: 1.2,
      fees: { commission: 10, stampDuty: 5, transferFee: 1, slippage: 20 },
    },
    nav,
  }
}

test('回测跑完入库：模型 JSON + 渲染版本 + 工作区', () => {
  const store = openStore(':memory:')
  try {
    const rec = makeRecord()
    store.saveBacktest({ backtestId: rec.backtest_id, config: rec.config, metrics: rec.metrics, nav: rec.nav, cwd: '/ws/alpha' })
    const info = storeBacktestReport(store, store.getBacktest(rec.backtest_id), { cwd: '/ws/alpha' })
    assert.deepEqual(info.backtestId, 'bt_1')
    assert.equal(info.schemaVersion, DASHBOARD_SCHEMA_VERSION)
    assert.equal(info.renderVersion, DASHBOARD_RENDER_VERSION)
    assert.ok(info.bytes > 0, '模型序列化后应有实际体积')

    const row = store.getReport('bt_1')
    assert.equal(row.cwd, '/ws/alpha')
    assert.equal(row.schema_version, DASHBOARD_SCHEMA_VERSION)
    assert.equal(row.render_version, DASHBOARD_RENDER_VERSION)
    assert.equal(row.model.kind, 'backtest')
    assert.equal(row.model.runs.length, 1)
    assert.equal(row.model.meta.backtestId, 'bt_1')
    assert.equal(store.listReports({ cwd: '/ws/other' }).length, 0)
    assert.equal(store.listReports({ cwd: '/ws/alpha' }).length, 1)
  } finally { store.raw.close() }
})

test('同一回测重跑：报告覆盖，不追加', () => {
  const store = openStore(':memory:')
  try {
    const rec = makeRecord('bt_dup')
    store.saveBacktest({ backtestId: rec.backtest_id, config: rec.config, metrics: rec.metrics, nav: rec.nav })
    storeBacktestReport(store, store.getBacktest('bt_dup'), { source: 'first' })
    storeBacktestReport(store, store.getBacktest('bt_dup'), { source: 'second' })
    assert.equal(store.listReports().length, 1)
    assert.equal(store.getReport('bt_dup').model.source, 'second')
  } finally { store.raw.close() }
})
