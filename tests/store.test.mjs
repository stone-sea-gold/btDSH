/**
 * 仓库 schema v5 单测：工作区归属列、workspaces 登记表、reports 报告入库。
 *
 * 重点在**存量库迁移**：`CREATE TABLE IF NOT EXISTS` 不会给已存在的表加列，
 * v4 的老库必须有显式 ALTER，否则升级后所有带 cwd 的写入都会静默丢列。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, SCHEMA_VERSION } from '../lib/data/store.mjs'

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'quant-store-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('新建库带 cwd 列，策略与回测都能按工作区过滤', () => {
  const { dir, cleanup } = tempDir()
  try {
    const store = openStore(join(dir, 'a.db'))
    assert.equal(SCHEMA_VERSION, 5)

    store.saveStrategy({ strategyId: 's1', config: { factors: [] }, cwd: '/ws/alpha' })
    store.saveStrategy({ strategyId: 's2', config: { factors: [] }, cwd: '/ws/beta' })
    assert.deepEqual(store.listStrategies({ cwd: '/ws/alpha' }).map((r) => r.strategy_id), ['s1'])
    assert.equal(store.listStrategies().length, 2)

    store.saveBacktest({ backtestId: 'b1', config: {}, metrics: {}, nav: [], cwd: '/ws/alpha' })
    store.saveBacktest({ backtestId: 'b2', config: {}, metrics: {}, nav: [], cwd: '/ws/beta' })
    assert.deepEqual(store.listBacktests({ cwd: '/ws/alpha' }).map((r) => r.backtest_id), ['b1'])
    // 旧调用 `listBacktests(20)` 仍然可用
    assert.equal(store.listBacktests(20).length, 2)
    assert.equal(store.getBacktest('b1').cwd, '/ws/alpha')
    store.raw.close()
  } finally { cleanup() }
})

test('v4 老库升级：补出 cwd 列，旧行保留且 cwd 为 null', () => {
  const { dir, cleanup } = tempDir()
  const path = join(dir, 'legacy.db')
  try {
    // 造一个 v4 结构的库：没有 cwd 列，schema_version=4
    const old = new DatabaseSync(path)
    old.exec(`
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
      INSERT INTO meta(key,value) VALUES('schema_version','4');
      CREATE TABLE strategies(strategy_id TEXT NOT NULL, version INTEGER NOT NULL,
        name TEXT, description TEXT, config TEXT NOT NULL,
        session_id TEXT, turn_seq INTEGER, created_at INTEGER,
        PRIMARY KEY(strategy_id, version)) WITHOUT ROWID;
      CREATE TABLE backtests(backtest_id TEXT PRIMARY KEY, strategy_id TEXT, version INTEGER,
        config TEXT NOT NULL, metrics TEXT, nav TEXT, session_id TEXT, created_at INTEGER) WITHOUT ROWID;
      INSERT INTO strategies(strategy_id,version,config,created_at) VALUES('old',1,'{}',1);
      INSERT INTO backtests(backtest_id,config,metrics,nav,created_at) VALUES('old-bt','{}','{}','[]',1);
    `)
    old.close()

    const store = openStore(path)
    const s = store.getStrategy('old')
    assert.equal(s.strategy_id, 'old')
    assert.equal(s.cwd, null, '旧行没有被改写')
    assert.equal(store.getBacktest('old-bt').cwd, null)
    // 升级后新写入带 cwd 正常落列
    store.saveStrategy({ strategyId: 'new', config: {}, cwd: '/ws/x' })
    assert.equal(store.listStrategies({ cwd: '/ws/x' }).length, 1)
    assert.equal(store.raw.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '5')
    store.raw.close()
  } finally { cleanup() }
})

test('工作区登记表：标题取目录名，重复使用只更新时间', () => {
  const { dir, cleanup } = tempDir()
  try {
    const store = openStore(join(dir, 'a.db'))
    const r1 = store.touchWorkspace('/home/me/projects/alpha')
    assert.deepEqual(r1, { path: '/home/me/projects/alpha', title: 'alpha' })
    store.touchWorkspace('/home/me/projects/beta')
    store.touchWorkspace('/home/me/projects/alpha')
    const all = store.listWorkspaces()
    assert.equal(all.length, 2, '同一路径不重复登记')
    assert.equal(all[0].path, '/home/me/projects/alpha', '最近使用的排前面')
    assert.equal(all[0].title, 'alpha')
    store.raw.close()
  } finally { cleanup() }
})

test('报告入库：存模型 JSON，按工作区可查，渲染版本随行', () => {
  const { dir, cleanup } = tempDir()
  try {
    const store = openStore(join(dir, 'a.db'))
    const model = { schemaVersion: 1, title: '动量 20 日', runs: [{ id: 'b1' }] }
    store.saveReport({ backtestId: 'b1', model, schemaVersion: 1, renderVersion: 5, cwd: '/ws/alpha' })
    const got = store.getReport('b1')
    assert.deepEqual(got.model, model)
    assert.equal(got.render_version, 5)
    assert.equal(got.cwd, '/ws/alpha')
    assert.equal(store.listReports({ cwd: '/ws/other' }).length, 0)
    assert.deepEqual(store.listReports({ cwd: '/ws/alpha' }).map((r) => r.backtest_id), ['b1'])
    // 同一回测重跑：报告覆盖而非追加
    store.saveReport({ backtestId: 'b1', model: { ...model, title: '新版' }, schemaVersion: 1, renderVersion: 5, cwd: '/ws/alpha' })
    assert.equal(store.getReport('b1').model.title, '新版')
    assert.equal(store.listReports().length, 1)
    store.raw.close()
  } finally { cleanup() }
})
