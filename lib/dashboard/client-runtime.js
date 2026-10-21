/**
 * 看板页面的浏览器端逻辑（**作为文本内联进 HTML**，不经任何打包器）。
 *
 * 之所以单独成文件而不是塞进 render.mjs 的模板字符串：
 *   - 这里能用正常语法写，`node --check` 能直接校验语法
 *   - 不用为 `${` 与反引号做转义，避免"改一个字符整页白屏"
 * 运行时只依赖 `window.echarts`（由 HTML 内联的 vendored 产物提供）。
 *
 * ## Phase 2 适配点只有一处
 *
 * `loadModel()` 支持三种数据来源（面板注入 / 内联 JSON / fetch 远程）。
 * Phase 2 的活数据面板不需要改这个文件里的任何渲染代码。
 */
(function () {
  'use strict'

  var PALETTE = {
    light: { accent: '#3a6df0', up: '#d94a3d', down: '#2f9e6a', warn: '#c9881c', grid: '#e4e7ec', axis: '#8b93a1', bg: '#ffffff' },
    dark: { accent: '#6f95ff', up: '#f4665a', down: '#48b783', warn: '#e0a33a', grid: '#262a33', axis: '#6b7484', bg: '#0f1115' }
  }
  var RUN_COLORS = { light: ['#3a6df0', '#c9881c', '#8b5cf6', '#0e9488', '#d94a3d'], dark: ['#6f95ff', '#e0a33a', '#a78bfa', '#2dd4bf', '#f4665a'] }

  var state = { charts: [], theme: 'light' }

  // ── 数据来源（Phase 1 / Phase 2 的唯一分叉点）──────────────────────────────
  async function loadModel() {
    // ① Phase 2：自有右侧栏 tab 直接把模型挂在 window 上
    if (window.__DASHBOARD_MODEL__) return window.__DASHBOARD_MODEL__
    // ② Phase 1：导出时内联的 JSON
    var el = document.getElementById('dashboard-model')
    if (el) return JSON.parse(el.textContent)
    // ③ Phase 2：由宿主路由提供（同源，鉴权随宿主）
    var url = document.documentElement.getAttribute('data-model-src')
    if (url) {
      var res = await fetch(url, { credentials: 'same-origin' })
      if (!res.ok) throw new Error('模型加载失败 HTTP ' + res.status)
      return await res.json()
    }
    throw new Error('没有可用的看板数据源')
  }

  // ── 基础工具 ───────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }
  function fmt(value, format) {
    if (value === null || value === undefined || (typeof value === 'number' && !isFinite(value))) return '—'
    switch (format) {
      case 'pct': return (value * 100).toFixed(2) + '%'
      case 'pct1': return (value * 100).toFixed(1) + '%'
      case 'num': return Number(value).toFixed(4)
      case 'num2': return Number(value).toFixed(2)
      case 'money': return Math.round(value).toLocaleString('zh-CN')
      case 'int': return String(Math.round(value))
      default: return String(value)
    }
  }
  function ymd(d) {
    if (d === null || d === undefined) return '—'
    var s = String(d)
    return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : s
  }
  function isoDate(d) {
    var s = String(d)
    return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8)
  }
  function toneClass(tone) {
    return tone === 'up' ? 'up' : tone === 'down' ? 'down' : tone === 'warn' ? 'warn' : ''
  }

  // ── 区块渲染 ───────────────────────────────────────────────────────────────
  function renderHeader(model) {
    var primary = model.runs[0]
    var meta = model.meta
    var badges = (meta.badges || []).map(function (b) {
      return '<span class="badge ' + toneClass(b.tone) + '"' + (b.hint ? ' title="' + esc(b.hint) + '"' : '') + '>' + esc(b.text) + '</span>'
    }).join('')
    var sub = []
    if (meta.subtitle) sub.push(esc(meta.subtitle))
    if (meta.version !== null && meta.version !== undefined) sub.push('v' + esc(meta.version))
    sub.push(ymd(primary.range[0]) + ' ~ ' + ymd(primary.range[1]))
    sub.push(primary.days + ' 个交易日')
    var reb = primary.kpis.filter(function (k) { return k.id === 'rebalances' })[0]
    if (reb && reb.value !== null) sub.push('调仓 ' + reb.value + ' 次')
    return '<header class="head"><div class="head-row"><h1>' + esc(meta.title) + '</h1>' +
      '<button id="theme-toggle" class="btn" aria-label="切换明暗主题">深色</button></div>' +
      '<div class="badges">' + badges + '</div>' +
      '<p class="sub">' + sub.join(' · ') + '</p></header>'
  }

  function renderKpis(runs) {
    var groups = [['return', '收益'], ['risk', '风险'], ['trade', '交易'], ['cost', '成本']]
    if (runs.length === 1) {
      var run = runs[0]
      return '<section class="card kpis">' + groups.map(function (g) {
        var items = run.kpis.filter(function (k) { return k.group === g[0] })
        if (!items.length) return ''
        return '<div class="kpi-group"><div class="kpi-group-title">' + g[1] + '</div><div class="kpi-row">' +
          items.map(function (k) {
            return '<div class="kpi"' + (k.hint ? ' title="' + esc(k.hint) + '"' : '') + '>' +
              '<span class="kpi-label">' + esc(k.label) + '</span>' +
              '<span class="kpi-value ' + toneClass(k.tone) + '">' + esc(fmt(k.value, k.format)) + '</span></div>'
          }).join('') + '</div></div>'
      }).join('') + '</section>'
    }
    // 多 run：KPI 变成对比表（Phase 2 的对比视图直接走这一支）
    var ids = []
    runs[0].kpis.forEach(function (k) { if (ids.indexOf(k.id) < 0) ids.push(k.id) })
    var rows = ids.map(function (id) {
      var first = runs[0].kpis.filter(function (k) { return k.id === id })[0]
      if (!first) return ''
      return '<tr><th>' + esc(first.label) + '</th>' + runs.map(function (r) {
        var k = r.kpis.filter(function (x) { return x.id === id })[0]
        return '<td class="' + (k ? toneClass(k.tone) : '') + '">' + (k ? esc(fmt(k.value, k.format)) : '—') + '</td>'
      }).join('') + '</tr>'
    }).join('')
    return '<section class="card"><h2>指标对比</h2><div class="scroll"><table class="tbl"><thead><tr><th>指标</th>' +
      runs.map(function (r) { return '<th>' + esc(r.label) + '</th>' }).join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div></section>'
  }

  function renderChartBlock(id, title, caption) {
    return '<section class="card"><div class="card-head"><h2>' + esc(title) + '</h2>' +
      '<button class="btn" data-png="' + id + '" aria-label="导出图片">导出 PNG</button></div>' +
      '<div class="chart" id="' + id + '" role="img" aria-label="' + esc(title) + '"></div>' +
      (caption ? '<p class="caption">' + caption + '</p>' : '') + '</section>'
  }

  function renderYearly(run) {
    var rows = run.yearly.map(function (y) {
      return '<tr><td>' + y.year + '</td><td class="' + (y.return >= 0 ? 'up' : 'down') + '">' + esc(fmt(y.return, 'pct')) +
        '</td><td class="down">' + esc(fmt(y.maxDrawdown, 'pct')) + '</td><td>' + (y.sharpe === null ? '—' : esc(fmt(y.sharpe, 'num2'))) +
        '</td><td class="num">' + y.days + '</td></tr>'
    }).join('')
    return '<section class="card"><h2>分年度</h2><div class="chart chart-sm" id="chart-yearly" role="img" aria-label="分年度收益"></div>' +
      '<div class="scroll"><table class="tbl"><thead><tr><th>年度</th><th>收益</th><th>最大回撤</th><th>夏普</th><th>交易日</th></tr></thead><tbody>' +
      rows + '</tbody></table></div></section>'
  }

  function renderDrawdowns(run, showLabel) {
    if (!run.drawdowns || !run.drawdowns.length) {
      return '<section class="card"><h2>回撤区间' + (showLabel ? ' · ' + esc(run.label) : '') + '</h2><p class="caption">区间内未出现回撤。</p></section>'
    }
    var rows = run.drawdowns.slice(0, 5).map(function (d) {
      var open = d.recoverDate === null || d.recoverDate === undefined
      return '<tr><td>' + ymd(d.startDate) + '</td><td>' + ymd(d.troughDate) + '</td>' +
        '<td class="down">' + esc(fmt(d.trough, 'pct')) + '</td>' +
        '<td class="' + (open ? 'warn' : '') + '">' + (open ? '未收复' : ymd(d.recoverDate)) + '</td>' +
        '<td class="num">' + d.days + '</td></tr>'
    }).join('')
    return '<section class="card"><h2>回撤区间' + (showLabel ? ' · ' + esc(run.label) : '') + '</h2><div class="scroll"><table class="tbl">' +
      '<thead><tr><th>起始</th><th>谷底</th><th>幅度</th><th>收复</th><th>天数</th></tr></thead><tbody>' + rows + '</tbody></table></div></section>'
  }

  /**
   * 分因子的**一行结论**（折叠态也要能看出值不值得展开）。
   *
   * 纯函数，单独抽出来是为了能在 Node 里直接测（DOM 渲染没法在单测里跑）：
   * 排序依据依次退化为 年化 → 总收益 → 只报数量，
   * 避免"因子算不出年化时摘要变成 '最优 undefined' "。
   */
  function factorSummary(fs) {
    var summary = fs.length + ' 个因子已对比'
    var scored = fs.filter(function (f) { return f.cagr !== null && f.cagr !== undefined })
      .sort(function (a, b) { return b.cagr - a.cagr })
    if (scored.length) return summary + ' · 最优 ' + scored[0].factorId + ' 年化 ' + fmt(scored[0].cagr, 'pct')
    var byReturn = fs.filter(function (f) { return f.totalReturn !== null && f.totalReturn !== undefined })
      .sort(function (a, b) { return b.totalReturn - a.totalReturn })
    if (byReturn.length) return summary + ' · 最优 ' + byReturn[0].factorId + ' 总收益 ' + fmt(byReturn[0].totalReturn, 'pct')
    return summary
  }

  /** 分因子：折叠 + 一行结论 */
  function renderByFactor(run) {
    var fs = run.byFactor || []
    if (fs.length <= 1) return ''
    var summary = factorSummary(fs)
    var rows = fs.map(function (f) {
      return '<tr><td>' + esc(f.factorId) + '</td><td class="' + (f.totalReturn >= 0 ? 'up' : 'down') + '">' + esc(fmt(f.totalReturn, 'pct')) +
        '</td><td>' + esc(fmt(f.cagr, 'pct')) + '</td><td>' + esc(fmt(f.sharpe, 'num2')) +
        '</td><td class="down">' + esc(fmt(f.maxDrawdown, 'pct')) + '</td><td class="num">' + (f.trades === null ? '—' : f.trades) + '</td></tr>'
    }).join('')
    return '<section class="card"><details><summary class="sum"><span class="sum-title">分因子</span><span class="sum-note">' + esc(summary) + '</span></summary>' +
      '<div class="scroll"><table class="tbl"><thead><tr><th>因子</th><th>总收益</th><th>年化</th><th>夏普</th><th>最大回撤</th><th>成交</th></tr></thead><tbody>' +
      rows + '</tbody></table></div></details></section>'
  }

  function renderCosts(run) {
    var c = run.costs || {}
    var rows = [['佣金', c.commission], ['印花税', c.stampDuty], ['过户费', c.transferFee], ['滑点', c.slippage]]
      .map(function (r) { return '<tr><td>' + r[0] + '</td><td class="num">' + esc(fmt(r[1], 'money')) + '</td></tr>' }).join('')
    var rej = run.rejected
    var rejText = ''
    if (rej && typeof rej === 'object') {
      var parts = []
      Object.keys(rej).forEach(function (side) {
        var inner = rej[side] || {}
        Object.keys(inner).forEach(function (reason) { parts.push(reason + ' × ' + inner[reason]) })
      })
      if (parts.length) rejText = '<p class="caption">因不可交易被拒：' + esc(parts.join('　')) + '</p>'
    }
    return '<section class="card"><h2>成本与可交易性</h2><div class="scroll"><table class="tbl"><tbody>' + rows +
      '<tr class="total"><td>费用合计</td><td class="num">' + esc(fmt(c.fees, 'money')) + '</td></tr>' +
      '<tr><td>占初始资金</td><td class="num">' + esc(fmt(c.shareOfInitial, 'pct')) + '</td></tr>' +
      '</tbody></table></div><p class="caption">' + esc(c.note || '') + '</p>' + rejText + '</section>'
  }

  function renderFooter(model, run) {
    var caveats = (run && run.caveats) || []
    var caveatHtml = caveats.length
      ? '<h2>口径声明</h2><ul class="caveats">' + caveats.map(function (c) { return '<li>' + esc(c) + '</li>' }).join('') + '</ul>'
      : ''
    return '<footer class="foot">' + caveatHtml + '<p class="disclaimer">' + esc(model.footer.disclaimer) + '</p>' +
      '<p class="stamp">由 ' + esc(model.footer.generator) + ' 生成 · schema v' + esc(model.schemaVersion) + '</p></footer>'
  }

  // ── 图表 ───────────────────────────────────────────────────────────────────
  function navOption(runs, colors) {
    var marks = []
    var deepest = runs[0].drawdowns && runs[0].drawdowns[0]
    if (deepest) {
      var end = deepest.recoverDate === null || deepest.recoverDate === undefined ? runs[0].range[1] : deepest.recoverDate
      marks = [{ xAxis: isoDate(deepest.startDate), itemStyle: { color: colors[0], opacity: 0.06 } },
        { xAxis: isoDate(end) }]
    }
    return {
      animation: false,
      backgroundColor: 'transparent',
      // 多 run 必须给图例：叠了 3 条线却没有开关图例，等于没法读
      legend: runs.length > 1 ? {
        type: 'scroll', top: 0, right: 18, itemWidth: 14, itemHeight: 8,
        textStyle: { color: colors.axis, fontSize: 11 },
      } : undefined,
      grid: { left: 54, right: 18, top: runs.length > 1 ? 34 : 18, bottom: 52 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross', label: { show: false } }, valueFormatter: function (v) { return Number(v).toFixed(4) } },
      xAxis: {
        type: 'time', axisLine: { lineStyle: { color: colors.grid } }, axisTick: { show: false },
        axisLabel: { color: colors.axis, fontSize: 11, hideOverlap: true }, splitLine: { show: false }
      },
      yAxis: {
        type: 'value', scale: true,
        axisLabel: { color: colors.axis, fontSize: 11, formatter: function (v) { return Number(v).toFixed(2) } },
        splitLine: { lineStyle: { color: colors.grid, type: 'dashed' } }
      },
      dataZoom: [
        { type: 'inside' },
        { type: 'slider', height: 14, bottom: 24, borderColor: 'transparent', backgroundColor: 'transparent', fillerColor: colors.grid, handleStyle: { color: colors.grid }}
      ],
      series: runs.map(function (r, i) {
        return {
          name: r.label, type: 'line', showSymbol: false, sampling: 'lttb',
          data: r.nav.map(function (p) { return [isoDate(p[0]), p[1]] }),
          lineStyle: { width: 2, color: colors.series[i % colors.series.length] },
          itemStyle: { color: colors.series[i % colors.series.length] },
          areaStyle: runs.length === 1 ? { opacity: 0.10, color: colors.series[i % colors.series.length] } : undefined,
          markArea: i === 0 && marks.length ? { silent: true, data: [marks] } : undefined
        }
      })
    }
  }

  function ddOption(runs, colors, extra) {
    return {
      animation: false, backgroundColor: 'transparent',
      grid: { left: 54, right: 18, top: 12, bottom: 18 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'line' }, valueFormatter: function (v) { return (Number(v) * 100).toFixed(2) + '%' } },
      xAxis: { type: 'time', axisLine: { lineStyle: { color: colors.grid } }, axisTick: { show: false }, axisLabel: { color: colors.axis, fontSize: 11, hideOverlap: true } },
      yAxis: {
        type: 'value', max: 0,
        axisLabel: { color: colors.axis, fontSize: 11, formatter: function (v) { return (Number(v) * 100).toFixed(0) + '%' } },
        splitLine: { lineStyle: { color: colors.grid, type: 'dashed' } }
      },
      dataZoom: [{ type: 'inside' }],
      series: runs.map(function (r, i) {
        return {
          name: r.label, type: 'line', showSymbol: false, sampling: 'lttb',
          data: r.drawdown.map(function (p) { return [isoDate(p[0]), p[1]] }),
          lineStyle: { width: 1.5, color: extra.dd },
          itemStyle: { color: extra.dd },
          areaStyle: { opacity: 0.15, color: extra.dd }
        }
      })
    }
  }

  function yearlyOption(run, colors, extra) {
    return {
      animation: false, backgroundColor: 'transparent',
      grid: { left: 54, right: 18, top: 14, bottom: 26 },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: function (ps) {
          var i = ps[0].dataIndex, y = run.yearly[i]
          return y.year + '<br/>收益 ' + fmt(y.return, 'pct') + '<br/>回撤 ' + fmt(y.maxDrawdown, 'pct') +
            '<br/>夏普 ' + (y.sharpe === null ? '—' : fmt(y.sharpe, 'num2')) + '<br/>交易日 ' + y.days
        }
      },
      xAxis: { type: 'category', data: run.yearly.map(function (y) { return String(y.year) }), axisTick: { show: false }, axisLine: { lineStyle: { color: colors.grid } }, axisLabel: { color: colors.axis, fontSize: 11 } },
      yAxis: { type: 'value', axisLabel: { color: colors.axis, fontSize: 11, formatter: function (v) { return (Number(v) * 100).toFixed(0) + '%' } }, splitLine: { lineStyle: { color: colors.grid, type: 'dashed' } } },
      series: [{
        type: 'bar', barMaxWidth: 42,
        data: run.yearly.map(function (y) { return { value: y.return, itemStyle: { color: y.return >= 0 ? extra.up : extra.down } } })
      }]
    }
  }

  function initCharts(model) {
    var theme = state.theme
    var colors = PALETTE[theme]
    var extra = { up: colors.up, down: colors.down, dd: colors.down }
    var seriesColors = RUN_COLORS[theme]
    var palette = { grid: colors.grid, axis: colors.axis, series: seriesColors }
    var runs = model.runs

    var navEl = document.getElementById('chart-nav')
    if (navEl) {
      var nav = window.echarts.init(navEl, null, { renderer: 'canvas' })
      nav.setOption(navOption(runs, palette))
      state.charts.push(nav)
    }
    var ddEl = document.getElementById('chart-dd')
    if (ddEl) {
      var dd = window.echarts.init(ddEl, null, { renderer: 'canvas' })
      dd.setOption(ddOption(runs, palette, extra))
      state.charts.push(dd)
      if (state.charts.length > 1) window.echarts.connect(state.charts.slice(0, 2))
    }
    var yEl = document.getElementById('chart-yearly')
    if (yEl && runs.length === 1) {
      var yearly = window.echarts.init(yEl, null, { renderer: 'canvas' })
      yearly.setOption(yearlyOption(runs[0], palette, extra))
      state.charts.push(yearly)
    }
  }

  function disposeCharts() {
    state.charts.forEach(function (c) { try { c.dispose() } catch (e) { /* 已销毁 */ } })
    state.charts = []
  }

  // ── 组装 ───────────────────────────────────────────────────────────────────
  function build(model) {
    var runs = model.runs
    var parts = [renderHeader(model), renderKpis(runs)]
    parts.push(renderChartBlock('chart-nav', '净值曲线', runs.length === 1
      ? '阴影为最大回撤区间；滚轮或底部滑条可缩放，双击复位。'
      : '已叠加 ' + runs.length + ' 条曲线，可点击图例隐藏。'))
    parts.push(renderChartBlock('chart-dd', '回撤', '与净值同轴联动；数值为相对历史高点的回撤幅度。'))
    if (runs.length === 1) {
      parts.push('<div class="grid2">' + renderYearly(runs[0]) + renderDrawdowns(runs[0], false) + '</div>')
      parts.push(renderByFactor(runs[0]))
    } else {
      parts.push('<div class="grid2">' + runs.map(function (r) { return renderDrawdowns(r, true) }).join('') + '</div>')
    }
    if (runs.length === 1) parts.push(renderCosts(runs[0]))
    parts.push(renderFooter(model, runs[0]))
    return parts.join('')
  }

  function applyTheme(theme) {
    state.theme = theme
    document.documentElement.setAttribute('data-theme', theme)
    var btn = document.getElementById('theme-toggle')
    if (btn) btn.textContent = theme === 'dark' ? '浅色' : '深色'
    try { localStorage.setItem('dsh-dashboard-theme', theme) } catch (e) { /* 隐私模式 */ }
  }

  async function main() {
    var model = await loadModel()
    document.getElementById('app').innerHTML = build(model)
    var stored = null
    try { stored = localStorage.getItem('dsh-dashboard-theme') } catch (e) { stored = null }
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    applyTheme(stored || (prefersDark ? 'dark' : 'light'))
    initCharts(model)

    var toggle = document.getElementById('theme-toggle')
    if (toggle) {
      toggle.addEventListener('click', function () {
        disposeCharts()
        applyTheme(state.theme === 'dark' ? 'light' : 'dark')
        initCharts(model)
      })
    }
    document.querySelectorAll('[data-png]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-png')
        var idx = id === 'chart-nav' ? 0 : 1
        var chart = state.charts[idx]
        if (!chart) return
        var url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: PALETTE[state.theme].bg })
        var a = document.createElement('a')
        a.href = url
        a.download = id + '.png'
        a.click()
      })
    })
    var timer = null
    window.addEventListener('resize', function () {
      clearTimeout(timer)
      timer = setTimeout(function () { state.charts.forEach(function (c) { c.resize() }) }, 120)
    })
  }

  // 供单测直接调用纯逻辑；浏览器里仅作调试入口。
  window.__dashUtil = { fmt: fmt, ymd: ymd, factorSummary: factorSummary, renderByFactor: renderByFactor, build: build }

  // 单测把 __DASHBOARD_AUTOSTART__ 置 false 后加载本文件，只取纯函数、不启动渲染。
  if (window.__DASHBOARD_AUTOSTART__ !== false) {
    main().catch(function (err) {
      var app = document.getElementById('app')
      if (app) app.innerHTML = '<div class="card error"><h2>看板渲染失败</h2><p class="caption">' + esc(err && err.message) + '</p></div>'
      if (window.console) console.error(err)
    })
  }
})()
