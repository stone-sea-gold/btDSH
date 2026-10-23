/**
 * 报告入库：把一次回测的看板模型落进 `reports` 表。
 *
 * 为什么存模型 JSON 而不是 HTML 成品：HTML 内联 ECharts 后单份 664 KB，
 * 几十条回测就是几十 MB，而且模板一改旧文件就过时。模型只有几 KB 到几十 KB，
 * 渲染在打开时进行；渲染契约版本 `renderVersion` 随行保存，口径升级后旧报告
 * 仍能按当时的版本渲染。
 */

import { buildBacktestDashboard } from './model.mjs'
import { DASHBOARD_RENDER_VERSION } from './render.mjs'

/**
 * 生成并保存一份报告。
 *
 * @param {ReturnType<import('../data/store.mjs').openStore>} store
 * @param {object} record `store.getBacktest()` 返回的记录
 * @param {{ cwd?: string|null, source?: string, generatedAt?: number }} [opts]
 * @returns {{ backtestId: string, schemaVersion: number, renderVersion: number, bytes: number }}
 */
export function storeBacktestReport(store, record, { cwd = null, source = 'quant_backtest_run', generatedAt = Date.now() } = {}) {
  const model = buildBacktestDashboard(record, { source, generatedAt })
  const backtestId = record.backtest_id ?? record.backtestId
  const modelJson = JSON.stringify(model)
  store.saveReport({
    backtestId,
    model,
    schemaVersion: model.schemaVersion,
    renderVersion: DASHBOARD_RENDER_VERSION,
    cwd,
  })
  return { backtestId, schemaVersion: model.schemaVersion, renderVersion: DASHBOARD_RENDER_VERSION, bytes: modelJson.length }
}
