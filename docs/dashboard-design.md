# 回测看板设计规格（Phase 1）

> 目标版本：`1.1.0`。Phase 1 = 自包含 HTML 报告；Phase 2 = 同一份看板的活数据面板。
> 本文只定**内容、栏目、视觉、形态**，以及两者之间的迁移契约。

## 1. 定义与边界

**是什么**：一次回测的完整复盘页——让人一眼看出"赚了多少、怎么赚的、什么时候亏的、代价是什么"。

**不是什么**（明确不做，避免滑向"股票软件"）：

- 不做实时行情/K 线盯盘（那是另一条产品线）
- 不做下单、不做仓位管理界面
- 不做参数调优的交互式重跑（调参走 `quant_optimize_parameters`，看板只呈现结果）
- 不做"预测"性质的图形（无未来区间的推演、无信号箭头）

## 2. 形态与技术选型

| 项 | 决策 | 理由 |
|---|---|---|
| 形态 | **单个自包含 HTML 文件** | 双击即开、离线可用、可直接发给没有 DSH 的人 |
| 外部资源 | **零**（无 CDN、无外链字体、无远程 JSON） | 离线与内网环境必须能开；也避免"打开时白屏" |
| 图表（报告） | **ECharts 5.6.0 `common` 构建，vendored 内联** | 用户决策：报告用 ECharts。实测 `common`(649KB) 已覆盖 line/bar/legend/dataZoom/markArea/tooltip + SVG 渲染器；`simple`(459KB) 连 SSR 都起不来，`full`(1.0MB) 多的是用不上的地图/关系图 |
| 图表（会话卡片） | **保持手写内联 SVG** | 卡片嵌在 320px 聊天流里、且不能给 DSH bundle 增依赖；两套图表栈是明确取舍 |
| 样式 | 内联 `<style>`，自持配色 + CSS 变量 | 见 §6「为什么不用宿主主题令牌」 |
| 数据 | 内联 `<script type="application/json">` | 同一份模型将来可由 HTTP 返回，见 §3 |
| 依赖 | **vendor 进仓库**（`vendor/echarts/`），运行时零安装 | 内联需要产物字节；用 `scripts/vendor-echarts.mjs` 可复现拉取，SHA-256 钉死 |
| 交互 | hover 十字光标、dataZoom（滚轮 + 底滑条）、明暗切换、图表 PNG 导出 | ECharts 自带缩放，原计划的"不做缩放"限制自动消除 |

**文件命名**：`quant-exports/<策略id>-<回测id>.html`（沿用导出目录与命名净化规则）。

## 3. Phase 1 → Phase 2 迁移契约（最重要的一节）

```
                     ┌──────────────────────┐
   回测记录(DB)  ───▶ │ lib/dashboard/model  │ ──▶ 看板模型 JSON（唯一契约）
                     └──────────────────────┘
                                │
              ┌─────────────────┴──────────────────┐
     Phase 1    ▼                          Phase 2  ▼
   内联进 HTML                   GET /quant/dashboard/:id 返回同一份 JSON
              │                                    │
              └────────────┬───────────────────────┘
                           ▼
                 同一个渲染器（同一份 HTML/CSS/JS）
```

**三条硬约束**，保证 Phase 2 不推倒重建：

1. **渲染器只吃模型**，不读数据库、不调工具、不碰会话。
2. **`runs` 永远是数组**。Phase 1 放 1 条；Phase 2 的"多回测对比"直接放 N 条——渲染器从第一天就按多列指标 + 多条曲线写。
3. **模型不含样式信息**。只有 `format` / `tone` / `group` 这类语义标记，颜色与像素由渲染器决定。换渲染器（SVG→Canvas、HTML→React 面板）不动数据层。

Phase 2 的唯一改动：HTML 顶部那段 bootstrap 里，`readModel()` 从"读内联 JSON"换成"`fetch()` 同一份 schema"。
**其他一行不改** —— 届时同一份页面既能被 `openTab('browser')` 打开，也能嵌在自有右侧栏 tab 里。

## 4. 数据模型

实现在 `lib/dashboard/model.mjs`，schema 版本 `1`。顶层：

| 字段 | 说明 |
|---|---|
| `schemaVersion` | 契约版本，Phase 2 起不同版本要有迁移 |
| `kind` | `backtest`（单条）\| `compare`（对比） |
| `source` | `export`（快照）\| `live`（活数据）——**唯一区分两个 Phase 的字段** |
| `generatedAt` | 生成时刻（ms） |
| `meta` | 标题、策略 id、回测 id、版本、`badges[]` |
| `runs[]` | 每条回测的完整数据块（见下） |
| `footer` | 免责声明、生成器 |

每个 `run`：

| 字段 | 说明 |
|---|---|
| `key` / `label` | 回测 id / 图例用标签（对比时带 topK 便于区分） |
| `range` / `days` | 起止日 / 交易日数 |
| `config` | 因子、topK、调仓、权重、初始资金 |
| `kpis[]` | `{ id, label, value, format, tone, group, hint }`，四组：return/risk/trade/cost |
| `nav` | `[[date, nav], ...]` 紧凑数组（全量，导出不降采样） |
| `drawdown` | `[[date, dd], ...]`，与 `nav` 等长、同端点 |
| `yearly[]` | 分年度：收益、回撤、夏普、交易日 |
| `drawdowns[]` | 回撤段：起/谷/谷底/收复日/天数（`recoverDate: null` = 至今未收复） |
| `byFactor[]` | 分因子对比（多因子时渲染） |
| `costs` | 佣金/印花税/过户费/滑点/合计/占初始资金 |
| `rejected` | 不可交易被拒计数（涨停不买/跌停不卖/停牌），可能为 `null` |
| `caveats[]` | 口径声明 |

派生数字全部来自 `lib/backtest/analyze.mjs`——与 `quant_backtest_analyze` 工具**同一份实现**，保证"工具说的"与"看板画的"永不漂移。

## 5. 栏目（自上而下 8 块）

| # | 栏目 | 内容 | 数据来源 | 空态/降级 | Phase 2 变化 |
|---|---|---|---|---|---|
| 1 | **身份条** | 标题、回测 id、策略版本、区间、交易日数、调仓次数；徽章：`样本内` / `长区间 N 年` / `基准=等权代理` | `meta` + `run.config` | 无 | 对比模式：标题换成"对比 N 条" |
| 2 | **指标墙** | 四组 KPI：收益（总收益/年化/基准/超额）、风险（最大回撤/年化波动/夏普/Calmar）、交易（胜率/成交笔数/年化换手）、成本（费用合计/滑点/费用占比） | `run.kpis` | 基准缺失时该组只剩 2 项 | 对比模式：每个 KPI 变成 N 列 |
| 3 | **净值主图** | 净值曲线 + 面积 + 最大回撤区间标注 + hover 十字光标读数 | `run.nav` | 无（模型层已拒 <2 点） | 多条曲线同图；图例可点选隐藏 |
| 4 | **回撤副图** | 逐日回撤填充（与主图共享 x 轴、联动光标） | `run.drawdown` | 无 | 多曲线取包络或分线（详细面切换） |
| 5 | **分年度** | 年度收益柱 + 同表列出回撤/夏普/交易日 | `run.yearly` | 只有 1 个年度时退化为单行摘要 | 对比模式：并排柱 |
| 6 | **回撤段明细** | Top 3~5 段：起始→谷底（幅值）→收复（天数）；未收复标黄 | `run.drawdowns` | 无回撤时显示"区间内未出现回撤" | 表加 run 列 |
| 7 | **分因子** | 折叠展示；**折叠态给一行结论**：`3 个因子已对比 · 最优 momentum_1m 年化 12.3%`；展开是 因子 × {总收益, 年化, 夏普, 回撤, 成交} | `run.byFactor` | **单因子时整块隐藏** | 同 |
| 8 | **成本与可交易性** | 费用四项 + 合计 + 占初始资金；有 `rejected` 时追加"因不可交易被拒"计数 | `run.costs` / `run.rejected` | 无 `rejected` 时该行隐藏 | 同 |

**口径声明与免责**固定在最底部（不折叠）：`caveats[]` + 免责句。理由——它是这份图的"使用说明书"，藏进折叠面板等于没有。

**为什么把"分年度"放在主图之后而不是之前**：先看整体形状（净值怎么走），再看切片（哪一年贡献的）。反过来会让人先入为主。

## 6. 视觉规范

### 6.1 配色（自持，A 股口径）

| 语义 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `bg` | `#ffffff` | `#0f1115` | 页面底 |
| `bg-soft` | `#f7f8fa` | `#161920` | 卡片底 |
| `border` | `#e4e7ec` | `#262a33` | 0.5px 分隔 |
| `text` | `#17191d` | `#e9ecf1` | 主文本 |
| `text-2` | `#5b6270` | `#9aa3b2` | 次要文本/轴标签 |
| `text-3` | `#8b93a1` | `#6b7484` | 脚注 |
| `accent` | `#3a6df0` | `#6f95ff` | 净值线、主强调 |
| `up`（涨/正） | `#d94a3d` | `#f4665a` | **红涨** |
| `down`（跌/负） | `#2f9e6a` | `#48b783` | **绿跌** |
| `warn` | `#c9881c` | `#e0a33a` | 徽章/未收复 |

**为什么自持配色而不是用宿主 `--dsw-alias-*` 令牌**：Phase 1 的 HTML 会被放进右侧栏文档预览——那是**不透明源沙箱 iframe**，读不到父文档的 CSS 变量；同一份文件还要能在普通浏览器里单独打开。自持配色保证三处（侧栏预览 / 外部浏览器 / Phase 2 的面板 iframe）观感**完全一致**，也避免"宿主换主题后看板花掉"。

### 6.2 排版

- 基准字号 `13px`；标题 20px；KPI 数值 24px；轴标签 11px
- 数字一律 `font-variant-numeric: tabular-nums`（对齐，避免跳动）
- 字体栈走系统 UI 字体；代码/公式用 `ui-monospace`
- 行高 1.5；卡片圆角 10px、内边距 12–16px

### 6.3 图表规范

- 净值线 `2px`；面积填充 `8%` 透明度；回撤填充 `15%`
- 网格线：仅水平，1px 虚线，`border` 色；不画竖向网格
- 轴：无刻度线，标签 11px；日期轴按年份自动抽稀
- 十字光标：1px 竖线 + 顶部读数块（日期、净值、回撤）
- 空值：断线而不是画到 0（净值不会为 0，0 会有误导）

### 6.4 明暗与无障碍

- 默认 `prefers-color-scheme`；右上角提供手动切换（`localStorage` 记住）
- 对比度目标：正文 ≥ 4.5:1；KPI 红/绿在浅深两套色板里都 ≥ 4.5:1
- 不单靠颜色传达信息：涨跌同时用符号（+/−）；未收复回撤除颜色外带"未收复"文字

## 7. 布局

```
┌────────────────────────────────────────────────────────────┐
│ 回测报告：demo_momentum            [样本内][基准=等权代理]      │
│ bt_demo_001 · v3 · 2024-01-02 ~ 2025-06-30 · 372 交易日      │
├────────────────────────────────────────────────────────────┤
│ 收益                              风险                      │
│ 总收益  年化  基准  超额   │  最大回撤 波动 夏普 Calmar        │
├────────────────────────────────────────────────────────────┤
│ 净值（含最大回撤区间标注）                                     │
├────────────────────────────────────────────────────────────┤
│ 回撤（与上共享 x 轴）                                         │
├──────────────────────────┬─────────────────────────────────┤
│ 分年度（柱）              │ 回撤段（表）                      │
├──────────────────────────┴─────────────────────────────────┤
│ 分因子（仅多因子）                                            │
├────────────────────────────────────────────────────────────┤
│ 成本与可交易性                                                │
├────────────────────────────────────────────────────────────┤
│ 口径声明 · 免责                                                │
└────────────────────────────────────────────────────────────┘
```

- 内容最大宽 `1240px` 居中；`<768px` 时单列（上下堆叠，图表高度压缩）
- 第 5/6 块在宽屏并排、窄屏堆叠（CSS Grid `auto-fit`）

## 8. 出口

| 出口 | 路径 | 状态 |
|---|---|---|
| 外部浏览器 | 双击 HTML 文件 | Phase 1 |
| 右侧栏文档预览 | 文件卡"在侧边栏预览"（宿主原生 html 预览器） | Phase 1，零额外代码 |
| 右侧栏浏览器 tab | 需起服务，Phase 2 才用 | Phase 2 |
| 自有右侧栏 tab | 同 Phase 2 渲染器 | Phase 2 |

## 9. 验收标准

1. 一次真实回测导出后，**断网**双击可完整打开（无 404、无控制台报错）
2. 侧栏预览与外部浏览器打开的渲染结果**像素级一致**（同一份 HTML）
3. 浅色/深色切换后所有文本对比度 ≥ 4.5:1
4. 375px 宽下无横向滚动
5. 数字与 `quant_backtest_analyze` 的输出**逐项一致**（同源实现 + 单测守）
6. 文件体积：7 年日频回测 < 900KB（内联 ECharts 649KB 后的预算；实测 5 年 731KB）
7. 移除 `source` 字段外，Phase 1 与 Phase 2 的模型完全同构（单测守 `runs` 数组形态）

## 10. 未纳入项（附理由）

| 项 | 理由 |
|---|---|
| 成交明细表 | `trades` 未入库（`saveBacktest` 只存 metrics+nav）。要用需先扩持久化，属独立改动 |
| 可交易性明细（逐笔被拒） | 同上；v1 只给计数（已在 `metrics.skipped` 归档） |
| 基准曲线叠加 | v1 基准是区间等权代理，画成一条线会误导成"指数"；等接入真实指数行情再画 |
| 参数扫描结果对比 | `quant_optimize_parameters` 有独立结果形态，另开一个 `kind: 'optimize'` |

## 11. Vendored 依赖与合规（Apache-2.0）

看板需要的图表能力以 **vendor** 形式进入仓库，而不是声明成运行时依赖：

| 项 | 位置 | 说明 |
|---|---|---|
| 产物 | `vendor/echarts/echarts.common.min.js` | ECharts 5.6.0 `common` 构建，649KB，SHA-256 钉死 |
| 清单 | `vendor/echarts/MANIFEST.json` | 版本、来源、字节数、哈希、已实测组件清单 |
| 许可 | `vendor/echarts/LICENSE`、`NOTICE`、`licenses/LICENSE-d3` | Apache-2.0 要求随分发提供许可与归属；ECharts 打包了部分 d3 代码，其许可一并保留 |
| 复现 | `scripts/vendor-echarts.mjs` | `npm pack echarts@<version>` 取发布包 → 校验哈希 → 落地；**升级版本必须人工审阅后更新脚本内的 KNOWN 表** |
| 门禁 | `npm run check:vendor`、`tests/vendor.test.mjs` | 哈希/字节/许可/打包清单四项断言 + Node SSR 渲染五类图元 |

**为什么不用 CDN**：离线可用是硬要求，且外链会把"能不能看"绑在第三方可用性上。

**为什么不用 npm 依赖**：内联需要的是**产物字节**，不是模块；作为依赖会让每个用户的
`node_modules` 多一份 5MB 的包，却仍然要在导出时读 dist。vendor 一个文件更直接，
也让"运行时零依赖"这条承诺保持不变。

**供应链**：字节进入用户拿到的 HTML，因此任何替换都不可静默接受 —— 哈希不匹配时脚本**直接失败**。

## 12. Phase 2 落地契约（v1.2）

> 本节替代开工前的「Phase 2 接入清单」。原计划是 `/quant/dashboard` 单前缀路由 +
> `sidebarRight.openTab` / 自有右侧栏 tab；实际落地改了三处，原因见 §12.0。
> 下面三节是**已实现的契约**，改实现前先改这里。§3 末段仍保留开工前的
> `/quant/dashboard` + 侧栏 tab 表述，那部分以本节为准。

### 12.0 为什么改道

1. **外壳改成主区标签页。** 右侧栏的 `sidebar.right.pane.tab` 是官方包自用的槽位，第三方是否稳定未经验证；
   而 `conversation.view` 是官方**开放的 list slot**，注册即多一个标签页，且主区宽度更适合看图表。
2. **路由拆成两条。** 单前缀 `/quant/dashboard/:id` 无法同时表达"清单"和"单份报告"；
   拆成 `/quant/api/runs`（JSON 清单）与 `/quant/report/<id>`（HTML 资源）后，路径即资源类型，
   鉴权、缓存、错误码都能分别定。
3. **报告存模型而不是 HTML。** 单份 HTML 内联 ECharts 后 664 KB，几十条回测就是几十 MB，
   且模板一改旧文件全部过时；模型 JSON 只有几 KB～几十 KB，渲染推迟到打开时。

### 12.1 视图页契约

**注册面**（`lib/client.js` 的 `apply()`）：

| 项 | 值 |
|---|---|
| slot | `conversation.view`（kind list、scope session、owner `ConvViewOwnerProps`） |
| `id` | `quant-backtest` |
| `order` | `20`（对话 `0`、轨迹 `10` 之后） |
| `label` | `回测` |
| `inject(sessionId)` | `{ cwd }`，取 `ctx.sessions.binding(sessionId)?.session?.header?.cwd`；取不到给 `null` |

**取数**：唯一数据源是 `GET /quant/api/runs`。默认带当前会话的 `cwd`；用户切到「全部工作区」时不带参数。

**选中语义**（写死，不做"记住上次"）：

- 默认选中列表第一条 —— 服务端按 `created_at DESC` 返回，第一条即**最新**；
- 切换工作区、或当前选中项不在新列表里 → 回退第一条；
- 列表为空 → 空态，提示"先在对话里跑一次回测"。

**渲染**：`<iframe src="/quant/report/<backtestId>">`。页面里嵌的 iframe 与「新标签页打开」是**同一个 URL**，
这就是深链——发给别人也能直接看。

**三态与错误**：加载中 / 失败（显示 HTTP 状态与原因）/ 空。失败不自动重试，只给「重试」按钮。

**与工具卡的区别**：工具卡是工具结果的**纯函数**（无 hooks、无请求、不订阅）；
视图页是常驻页面，允许 hooks 与 `fetch`，但**只读**——不得写库、不得触发回测。

**样式**：注入 `#dsh-quant-view-style` 一份只属于本视图的样式表；颜色只用 `--dsw-alias-*` 设计变量，
明暗主题自动跟随。下拉用**原生 `<select>`**（点击/键盘/滚动都交给浏览器），
只在支持 Customizable Select 的浏览器（Chrome 135+）里用 `::picker(select)` 定制选项栏皮肤；
不支持的浏览器退回系统默认，不引入自绘下拉。

### 12.2 宿主路由契约

**注册**：`ctx.inject(['webServer'], ...)`。headless / CLI 会话没有 `webServer` 服务 → 整段跳过，
插件其余功能不受影响；disposer 挂在 `webCtx.effect()` 上，停用插件即注销。

**鉴权**：先问宿主 `connection.requestRejection(req)`，返回 `401`/`403` 直接拒；没有 `connection` 服务时
退化为不校验（宿主仍只绑 `127.0.0.1`）。

**`GET /quant/api/runs?cwd=<绝对路径>`**

- `200` JSON：`{ ok: true, workspaces: [{ path, title, last_used_at }], runs: [...] }`
- `runs[]` 字段：`backtestId`、`strategyId`、`name`（策略名，缺失退化 `strategyId`，再退化「未命名策略」）、
  `description`、`cwd`、`createdAt`、`hasReport`（该回测是否已入库报告）、`href`（`/quant/report/<id>`）
- 排序 `created_at DESC`，上限 200 条；不带 `cwd` = 全部工作区
- 只读：纯 SELECT

**`GET /quant/report/<backtestId>`**

| 状态 | 条件 |
|---|---|
| `200 text/html` | 正常，`cache-control: no-store` |
| `400 bad report id` | id 不匹配 `^[A-Za-z0-9_-]{1,120}$`（防路径穿越） |
| `404 report not found` | 既没有入库报告，也没有对应回测记录 |
| `500 asset load failed` | vendored ECharts 或运行时缺失（安装损坏） |

读取优先级：先 `store.getReport(id)` 用入库模型；没有则用回测记录 `buildBacktestDashboard(record, { source: 'route' })`
**现场构建**（兼容 v1.2 之前的历史回测）。现场构建的结果**不回填**——读请求不产生写。

### 12.3 报告入库契约

**表 `reports`**（schema v5，`WITHOUT ROWID`）：

```
backtest_id TEXT PRIMARY KEY, model TEXT NOT NULL,
schema_version INTEGER NOT NULL, render_version INTEGER NOT NULL,
cwd TEXT, created_at INTEGER
```

`saveReport` 用 `INSERT OR REPLACE`：同一 `backtestId` 重跑即覆盖。

**存什么**：`buildBacktestDashboard()` 产出的**模型 JSON**（与内联 HTML 里的是同一份），不是 HTML 成品。

**两个版本号**：

- `schema_version` = 模型契约版本（`DASHBOARD_SCHEMA_VERSION`，当前 `1`）；
- `render_version` = 渲染器版本（`DASHBOARD_RENDER_VERSION`，当前 `1`）。
  渲染行为变了就 `+1`；读取方可据此判断"这份报告是旧渲染器产的"，决定重渲染或提示。

**写入时机**：`quant_backtest_run` 成功后由 `storeBacktestReport()` 写；回测失败不写。
记录里同时保留 `cwd` 归属，视图页才能按工作区过滤。

**容量**：模型几 KB～几十 KB（净值曲线按 500 点抽稀），不随 HTML 模板膨胀。

**升级路径**：改渲染器不动数据；改模型 schema 需迁移或按 `schema_version` 分支渲染。
