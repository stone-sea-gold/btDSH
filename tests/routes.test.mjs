/**
 * 宿主路由单测：`/quant/api/runs` 与 `/quant/report/<id>`。
 *
 * 处理器与 webServer 解耦（`createRouteHandlers`），所以这里直接喂假的 req/res，
 * 不需要真的起 HTTP 服务。守卫行为另外用假 webCtx 验一次。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../lib/data/store.mjs'
import { createRouteHandlers, registerQuantRoutes } from '../lib/host/routes.mjs'
import { storeBacktestReport } from '../lib/dashboard/reports.mjs'

function fakeRes() {
  return {
    statusCode: 0, headers: {}, body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers },
    end(body) { this.body = body ?? '' },
  }
}

function seededStore() {
  const store = openStore(':memory:')
  store.saveStrategy({ strategyId: 'mom20', name: '动量 20 日', description: '月度调仓，等权', config: { factors: [] }, cwd: '/ws/a' })
  const nav = [
    { date: 20240102, nav: 1 }, { date: 20240103, nav: 1.01 }, { date: 20240104, nav: 1.02 },
    { date: 20240105, nav: 1.01 }, { date: 20240108, nav: 1.03 }, { date: 20240109, nav: 1.04 },
  ]
  store.saveBacktest({
    backtestId: 'bt_a', strategyId: 'mom20', version: 1, cwd: '/ws/a',
    config: { start: 20240102, end: 20240109, factors: [] },
    metrics: { days: 6, totalReturn: 0.04, fees: { commission: 1, stampDuty: 1, transferFee: 0, slippage: 2 } },
    nav,
  })
  store.saveBacktest({
    backtestId: 'bt_b', strategyId: 'mom20', version: 1, cwd: '/ws/b',
    config: { start: 20240102, end: 20240109, factors: [] },
    metrics: { days: 6, totalReturn: 0.01, fees: {} }, nav,
  })
  storeBacktestReport(store, store.getBacktest('bt_a'), { cwd: '/ws/a' })
  store.touchWorkspace('/ws/a')
  store.touchWorkspace('/ws/b')
  return store
}

test('清单接口：带策略名/简介、工作区过滤、是否已入库', () => {
  const store = seededStore()
  try {
    const h = createRouteHandlers({ runtime: { store: () => store } })
    const res = fakeRes()
    h.handleRuns({ url: '/quant/api/runs?cwd=/ws/a' }, res)
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.runs.length, 1)
    const run = body.runs[0]
    assert.equal(run.backtestId, 'bt_a')
    assert.equal(run.name, '动量 20 日')
    assert.equal(run.description, '月度调仓，等权')
    assert.equal(run.hasReport, true)
    assert.equal(run.href, '/quant/report/bt_a')
    assert.deepEqual(body.workspaces.map((w) => w.path).sort(), ['/ws/a', '/ws/b'])

    const all = fakeRes()
    h.handleRuns({ url: '/quant/api/runs' }, all)
    assert.equal(JSON.parse(all.body).runs.length, 2, '不传 cwd = 看全部')
  } finally { store.raw.close() }
})

test('报告页：返回完整 HTML，未知 id 404，非法 id 400', () => {
  const store = seededStore()
  try {
    const h = createRouteHandlers({ runtime: { store: () => store } })
    const ok = fakeRes()
    h.handleReport({ url: '/quant/report/bt_a' }, ok)
    assert.equal(ok.statusCode, 200)
    assert.match(ok.headers['content-type'], /text\/html/)
    assert.match(ok.body, /bt_a/, '页面里应出现回测 id')
    assert.match(ok.body, /<html/i)

    const missing = fakeRes()
    h.handleReport({ url: '/quant/report/nope' }, missing)
    assert.equal(missing.statusCode, 404)

    const bad = fakeRes()
    h.handleReport({ url: '/quant/report/..%2Fetc' }, bad)
    assert.equal(bad.statusCode, 400, '路径穿越与非白名单字符一律拒')
  } finally { store.raw.close() }
})

test('守卫：宿主判定 401/403 时先拒，且两条路由都挂上了', () => {
  const store = seededStore()
  try {
    const registered = []
    const webCtx = {
      get: (name) => name === 'webServer'
        ? { register: (route) => { registered.push(route); return () => {} } }
        : name === 'connection' ? { requestRejection: () => 401 } : undefined,
    }
    const dispose = registerQuantRoutes(webCtx, { runtime: { store: () => store } })
    assert.equal(registered.length, 2)
    assert.deepEqual(registered.map((r) => `${r.kind}:${r.path}`).sort(), ['exact:/quant/api/runs', 'prefix:/quant/report'])

    const res = fakeRes()
    registered[0].handler({ url: '/quant/api/runs' }, res)
    assert.equal(res.statusCode, 401)
    assert.equal(res.body, 'Unauthorized')
    dispose()
  } finally { store.raw.close() }
})
