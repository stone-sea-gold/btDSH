/**
 * 看板的宿主 HTTP 路由（`/quant/...`）。
 *
 * 为什么走宿主自己的 webServer 而不是另起端口：同源、复用宿主的鉴权
 * （`connection.requestRejection` 对粗体/非本机来源返回 401/403）、
 * 生命周期跟着插件走，停用即注销。
 *
 * 两条路由：
 *   GET /quant/api/runs?cwd=<绝对路径>   回测清单（工作区过滤 + 策略名/简介 + 是否有已入库报告）
 *   GET /quant/report/<backtestId>       单份报告 HTML（可直接在新标签/侧栏打开，即"可分享的深链"）
 */

import { renderDashboardHtml } from '../dashboard/render.mjs'
import { loadDashboardAssets } from '../dashboard/assets.mjs'
import { buildBacktestDashboard } from '../dashboard/model.mjs'

const REPORT_PREFIX = '/quant/report/'
const RUNS_PATH = '/quant/api/runs'
const ID_RE = /^[A-Za-z0-9_-]{1,120}$/

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

const sendText = (res, status, text) => send(res, status, 'text/plain; charset=utf-8', text)
const sendJson = (res, status, body) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(body))

/**
 * 造路由处理器（与 webServer 解耦，测试可以直接喂假的 req/res）。
 *
 * @param {{ runtime: { store: () => object } }} deps
 */
export function createRouteHandlers({ runtime }) {
  /** 回测清单：卡片与视图页的列表都读它 */
  function handleRuns(req, res) {
    const url = new URL(req.url ?? RUNS_PATH, 'http://quant.invalid')
    const cwd = url.searchParams.get('cwd') || null
    const store = runtime.store()
    const rows = store.listBacktests({ cwd, limit: 200 })
    const runs = rows.map((r) => {
      const strategy = r.strategy_id ? store.getStrategy(r.strategy_id) : null
      return {
        backtestId: r.backtest_id,
        strategyId: r.strategy_id,
        name: strategy?.name ?? r.strategy_id ?? '未命名策略',
        description: strategy?.description ?? null,
        cwd: r.cwd ?? null,
        createdAt: r.created_at ?? null,
        hasReport: Boolean(store.getReport(r.backtest_id)),
        href: `${REPORT_PREFIX}${encodeURIComponent(r.backtest_id)}`,
      }
    })
    return sendJson(res, 200, { ok: true, workspaces: store.listWorkspaces(), runs })
  }

  /** 单份报告页：优先读入库的模型，没有则用回测记录现场构建（兼容旧记录） */
  function handleReport(req, res) {
    const url = new URL(req.url ?? '/', 'http://quant.invalid')
    const id = decodeURIComponent(url.pathname.slice(REPORT_PREFIX.length))
    if (!ID_RE.test(id)) return sendText(res, 400, 'bad report id')
    const store = runtime.store()
    const stored = store.getReport(id)
    let model = stored?.model ?? null
    if (!model) {
      const record = store.getBacktest(id)
      if (!record) return sendText(res, 404, 'report not found')
      model = buildBacktestDashboard(record, { source: 'route' })
    }
    let assets
    try {
      assets = loadDashboardAssets()
    } catch (error) {
      return sendText(res, 500, `asset load failed: ${error.message}`)
    }
    return send(res, 200, 'text/html; charset=utf-8', renderDashboardHtml(model, assets))
  }

  return { handleRuns, handleReport }
}

/**
 * 注册两条路由；返回 disposer（webServer.register 自带 disposer，逐个归还）。
 *
 * @param {object} webCtx 拥有 `webServer` /（可选）`connection` 的上下文
 * @param {{ runtime: { store: () => object } }} deps
 */
export function registerQuantRoutes(webCtx, deps) {
  const webServer = webCtx.get('webServer')
  if (!webServer) return () => {}
  const connection = webCtx.get('connection')
  const handlers = createRouteHandlers(deps)

  // 宿主鉴权：非本机/未授权的请求直接拒；没有 connection 服务时退化为不校验（仍是 127.0.0.1 绑定）
  const guard = (handler) => (req, res) => {
    const rejection = connection?.requestRejection?.(req)
    if (rejection !== undefined && rejection !== null) {
      return sendText(res, rejection, rejection === 401 ? 'Unauthorized' : 'Forbidden')
    }
    return handler(req, res)
  }

  const disposers = [
    webServer.register({ kind: 'exact', path: RUNS_PATH, handler: guard(handlers.handleRuns) }),
    webServer.register({ kind: 'prefix', path: REPORT_PREFIX.slice(0, -1), handler: guard(handlers.handleReport) }),
  ]
  return () => { for (const dispose of disposers) dispose() }
}
