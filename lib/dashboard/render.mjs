/**
 * 看板 HTML 渲染器（**纯函数**：模型 + 资产 → HTML 字符串）。
 *
 * 这一层不允许读磁盘、不碰 store、不 import 工具层 —— 它是"渲染器只吃模型"
 * 这条契约的物理体现（`tests/dashboard.test.mjs` 里有 import 白名单断言）。
 * 资产（ECharts 产物、客户端脚本）由 `assets.mjs` 读好后注入，方便测试用桩替换。
 *
 * ## 两个必须做的转义
 *
 * 1. **模型 JSON**：把 `<` 全部转成 `\u003c`。比只替换 `</script` 更彻底——
 *    策略公式、因子 id 都来自用户输入，任何一处漏转义都会提前闭合 script 标签。
 * 2. **内联脚本**：`</script` → `<\/script`。vendored 产物与客户端脚本都会过一遍。
 */

/** 渲染契约版本：模型结构变了才递增；报告入库时随行保存，旧报告按旧版渲染 */
export const DASHBOARD_RENDER_VERSION = 1

/** 页面样式：自持色板 + CSS 变量（不依赖宿主主题令牌，见 docs/dashboard-design.md §6） */
const CSS = `
:root{
  --bg:#ffffff; --bg-soft:#f7f8fa; --border:#e4e7ec; --border-strong:#d3d8e0;
  --text:#17191d; --text-2:#5b6270; --text-3:#8b93a1;
  --accent:#3a6df0; --up:#d94a3d; --down:#2f9e6a; --warn:#c9881c;
}
[data-theme="dark"]{
  --bg:#0f1115; --bg-soft:#161920; --border:#262a33; --border-strong:#333845;
  --text:#e9ecf1; --text-2:#9aa3b2; --text-3:#6b7484;
  --accent:#6f95ff; --up:#f4665a; --down:#48b783; --warn:#e0a33a;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg);color:var(--text);
  font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}
#app{max-width:1240px;margin:0 auto;padding:22px 18px 40px;display:flex;flex-direction:column;gap:14px}
.up{color:var(--up)} .down{color:var(--down)} .warn{color:var(--warn)}
.num{font-variant-numeric:tabular-nums}

.head{padding:2px 2px 6px}
.head-row{display:flex;align-items:flex-start;gap:12px;justify-content:space-between}
h1{font-size:20px;line-height:1.3;margin:0;font-weight:600;min-width:0;overflow-wrap:anywhere}
h2{font-size:13px;margin:0 0 8px;font-weight:600;color:var(--text)}
.sub{margin:6px 0 0;color:var(--text-2);font-size:12px}
.badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.badge{font-size:11px;padding:1px 7px;border-radius:6px;border:0.5px solid var(--border-strong);color:var(--text-2);white-space:nowrap}
.badge.warn{color:var(--warn)} .badge.up{color:var(--up)} .badge.down{color:var(--down)}

.card{background:var(--bg-soft);border:0.5px solid var(--border);border-radius:10px;padding:14px 16px;min-width:0}
.card.error{border-color:var(--up)}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}
.card-head h2{margin:0}

.btn{
  font:inherit;font-size:12px;color:var(--text-2);background:var(--bg);
  border:0.5px solid var(--border-strong);border-radius:6px;padding:3px 10px;cursor:pointer;
}
.btn:hover{color:var(--text);border-color:var(--text-3)}

.kpis{display:flex;flex-direction:column;gap:12px}
.kpi-group-title{font-size:11px;color:var(--text-3);margin-bottom:5px}
.kpi-row{display:flex;flex-wrap:wrap;gap:10px}
.kpi{
  flex:1 1 132px;min-width:0;display:flex;flex-direction:column;gap:2px;
  background:var(--bg);border:0.5px solid var(--border);border-radius:8px;padding:8px 10px;
}
.kpi-label{font-size:11px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kpi-value{font-size:20px;font-variant-numeric:tabular-nums;font-weight:600;overflow-wrap:anywhere}

.chart{width:100%;height:340px}
.chart-sm{height:210px}
.caption{margin:8px 0 0;font-size:11px;color:var(--text-3);overflow-wrap:anywhere}

.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}

.scroll{overflow-x:auto}
.tbl{width:100%;border-collapse:collapse;font-size:12px}
.tbl th,.tbl td{text-align:left;padding:5px 8px;border-bottom:0.5px solid var(--border);white-space:nowrap}
.tbl th{color:var(--text-3);font-weight:500}
.tbl td.num,.tbl th.num{text-align:right;font-variant-numeric:tabular-nums}
.tbl tr.total td{font-weight:600;border-top:0.5px solid var(--border-strong)}
.tbl tbody tr:hover{background:var(--bg)}

details>summary{cursor:pointer;list-style:none;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
details>summary::-webkit-details-marker{display:none}
details>summary::before{content:"▸";color:var(--text-3);font-size:11px}
details[open]>summary::before{content:"▾"}
details[open]>summary{margin-bottom:8px}
.sum-title{font-weight:600;font-size:13px}
.sum-note{font-size:12px;color:var(--text-2)}

.foot{border-top:0.5px solid var(--border);padding-top:12px;color:var(--text-2);font-size:12px}
.caveats{margin:6px 0 0;padding-left:18px;color:var(--text-2)}
.caveats li{margin:2px 0}
.disclaimer{margin:10px 0 0;color:var(--text);font-weight:500}
.stamp{margin:6px 0 0;color:var(--text-3);font-size:11px}

@media (max-width:768px){
  #app{padding:16px 12px 32px}
  h1{font-size:17px}
  .chart{height:260px}
  .chart-sm{height:180px}
  .kpi{flex:1 1 108px}
  .kpi-value{font-size:17px}
}
`;

/** 内联脚本前统一处理：防止提前闭合 script 标签 */
const inlineScript = (js) => String(js).replace(/<\/script/gi, '<\\/script')

/**
 * 生成看板 HTML。
 *
 * @param {object} model `buildBacktestDashboard` / `buildCompareDashboard` 的产物
 * @param {object} assets `{ echartsJs, runtimeJs }`（见 assets.mjs）
 * @returns {string} 自包含 HTML
 */
export function renderDashboardHtml(model, { echartsJs, runtimeJs } = {}) {
  if (!echartsJs) {
    const e = new Error('缺少 ECharts 产物（vendor/echarts/echarts.common.min.js）')
    e.code = 'NO_VENDOR'
    throw e
  }
  if (!runtimeJs) {
    const e = new Error('缺少客户端渲染脚本（lib/dashboard/client-runtime.js）')
    e.code = 'NO_RUNTIME'
    throw e
  }

  // `<` 一律转义：策略公式与因子 id 都可能含尖括号，只转 `</script` 并不够
  const modelJson = JSON.stringify(model).replace(/</g, '\\u003c')
  const title = String(model?.meta?.title ?? '回测看板').replace(/[<>&]/g, ' ')

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
<main id="app"><div class="card"><p class="caption">正在渲染…</p></div></main>
<noscript><div class="card"><p class="caption">这个页面需要 JavaScript 才能绘图。</p></div></noscript>
<script type="application/json" id="dashboard-model">${modelJson}</script>
<script>${inlineScript(echartsJs)}</script>
<script>${inlineScript(runtimeJs)}</script>
</body>
</html>
`
}
