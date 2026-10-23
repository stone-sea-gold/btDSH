# 项目进度日志

> **给 agent 的读法**：先读下面的「当前状态」一屏，再看时间线补上下文。改动前读最近 2–3 条，
> 免得重复已否决的方案。改完把「当前状态」与时间线一起更新（见文末维护约定）。
>
> **给人读的读法**：时间线按提交倒序，每条都能对上 git。想复验就按「验证」一栏的命令跑。

---

## 当前状态（2026-10-23）

- **版本**：`1.1.1`（`package.json`）；`main` = `11ddc7b`，tag `v1.1.1` 已推送
- **插件行名 / 预设 id**：`dsh-quant-assistant` / `quant-assistant`
- **正在做**：Phase 2 已完成并通过肉眼验收（工具条样式、下拉展开、对齐）；版本已到 **1.2.0**，改动待提交
- **测试**：`node --test tests/*.test.mjs` → 184 通过
- **数据落点**：单一全局库 `~/.dsh/quant/quant.db`（研究数据 + 行情同一个文件；工作区里只有用户主动导出的 `quant-exports/`）
- **权限模型**：插件不自带权限层，全部交给 DSH 权限预设（沙箱模式 + 审批策略）；工具内只剩 `confirm` 这类显式参数契约

### 已完成

| 模块 | 状态 | 入口 |
| --- | --- | --- |
| 31 个 `quant_*` 工具（数据/因子/策略/回测/选股/持仓） | 完成 | `lib/tools/` |
| 本地行情仓库 + 断点续传同步 + 盘后定时同步 | 完成 | `lib/data/` |
| 研究库 schema v5（`cwd` 归属列、`workspaces`、`reports`） | 完成，未提交 | `lib/data/store.mjs` |
| 单文件 HTML 回测看板（模型 JSON + 渲染 + ECharts） | 完成，v1.1.0 | `lib/dashboard/` |
| 报告入库（模型 JSON + 渲染版本号） | 完成，未提交 | `lib/dashboard/reports.mjs` |
| 宿主路由 `/quant/api/runs`、`/quant/report/<id>` | 完成，未提交 | `lib/host/routes.mjs` |
| 主区「回测」视图页（列表 + 工作区切换 + iframe 报告，工具条按 DSH 控件风格包装） | 完成，待验收 | `lib/client.js` |
| `quant_data_sync` 不传 from/to 时的 lossless JSON 故障 | 完成（默认区间在 `estimateSync` 内补齐） | `lib/data/sync.mjs:30` |
| 卡片式 toolview（6 种 SVG 卡片） | 完成 | `lib/client.js` |
| preset 投递 + 两个技能 | 完成 | `presets/`、`skills/` |

### 待办（按顺序）

1. 提交、打 tag `v1.2.0`、推送，并把本机 profile 换成正规安装（当前是手工拷贝的冒烟副本）
2. `docs/dashboard-design.md` 已补 §12 三节契约（视图页 / 路由 / 报告入库），与 README、ARCHITECTURE 一致

### 已知问题与坑

- **npm 上是 `1.0.1`，GitHub 渠道才是最新**；安装请用 `github:stone-sea-gold/btDSH#<tag>`
- **DSH 客户端没有 URL 路由器**：主区视图靠 `conversation.view` 选中态，`?view=backtest` 不存在；
  真正的可分享链接是 `/quant/report/<backtestId>`
- **行情与研究数据同库**：将来体积上 GB 的全是 `bars` 等表，要不要拆库是待议话题
- **插件写盘不过沙箱**（插件跑在宿主进程内）；这是 DSH 的既有边界，README 已如实披露
- 第三方 bundle 装好可能是**禁用态**（只显示设置卡片），要用户手动启用

### 关键路径

```
lib/index.js           插件入口：注册工具 → 物化预设 → 开库 → 定时同步 → 注册路由
lib/tools/*.mjs        工具面（kit.mjs 是共享脚手架与 output() 契约）
lib/data/store.mjs     SQLite 仓库（schema 迁移都在这里）
lib/dashboard/         看板：model(纯数据) → render(纯字符串) → client-runtime(浏览器)
lib/host/routes.mjs    宿主 HTTP 路由（/quant/*）
lib/client.js          客户端：toolview 卡片
presets/               预设与技能（patch.yml 由脚本生成，勿手改）
```

---

## 时间线（新 → 旧）

### 2026-10-23 · Phase 2 进行中（未提交，版本仍标 1.1.1）

**做了什么**

- 数据层升 schema v5：`strategies`/`backtests` 加 `cwd` 归属列（保存时从会话元数据快照）；
  新增 `workspaces(path, title, last_used)` 与 `reports(backtest_id, model, render_version, cwd, created_at)`；
  存量库自动补列建表，0 行数据原样保留。
- 报告入库：`lib/dashboard/reports.mjs` 在回测留档时生成看板模型入库，失败不影响回测；
  `DASHBOARD_RENDER_VERSION = 1` 作为渲染契约版本。
- 宿主路由：`lib/host/routes.mjs` 提供 `GET /quant/api/runs?cwd=…`（清单带策略名/简介、`hasReport`、`href`）
  与 `GET /quant/report/<id>`（报告 HTML，可分享的深链）；两条都过 `connection.requestRejection` 鉴权。
- 下拉**保留原生展开行为**（点击/键盘/滚动由浏览器负责），只用原生 `<select>`；
  选项栏皮肤走 Chrome 135+ 的 `appearance: base-select` + `::picker(select)`（圆角、投影、行 hover、
  选中业务色）；不支持的浏览器自动退回系统默认弹出层——外观不变，但也不破坏交互。
  曾试过自绘浮层，实测在宿主里渲染失败（点击无面板），已回退，并加测试护栏禁止自绘下拉。
- 回退时误删了 `OptionList` 辅助函数，导致整页白屏（组件引用未定义标识符）。已补回；
  新增**渲染级**回归测试（最小 hooks shim + 树断言），并用“临时删掉 OptionList”验证过它会报警。
- 工具条视觉：注入 `dsh-quant-view-style` 样式表（30px 高、9px 圆角、0.5px 描边、hover 用
  `--dsw-alias-interactive-bg-hover`、focus-visible 用业务色描边），颜色全部走宿主变量，深浅色主题自动跟随。
- 冒烟部署：直接复制构建到 `~/.dsh/profiles/web/node_modules/dsh-quant-assistant`（临时手段，正式发布仍走 git tag）。
- 修复：`estimateSync` 缺省 `from/to` 时先取 `defaultRange()` 再写入返回值——工具输出里出现 `undefined`
  会让宿主把整次调用判成 `value is not lossless JSON`（用户实测复现）。
- 注册方式：`lib/index.js` 第 5 步 `ctx.inject(['webServer'], …)`，headless 环境自动跳过。
- 主区视图页：`lib/client.js` 注册 `conversation.view`（id `quant-backtest`，order 20，标签「回测」），
  从会话头注入 `cwd` 作默认工作区；页面顶部是工作区/回测下拉与“在新标签页打开”，
  正文是 `/quant/report/<id>` 的 iframe（同一份报告既可内嵌也可直接打开）。
- 测试约定调整：工具卡仍必须纯函数；只有视图页允许 hooks（`tests/client.test.mjs` 按代码分段断言）。

**验证**

- 新增 `tests/routes.test.mjs` 3 条（清单/过滤、200-404-400、401 守卫）。
- `tests/client.test.mjs` 新增视图注册用例（标签/顺序/注入面/cwd 退化）。
- 全套 `node --test tests/*.test.mjs` → 182 通过。

- 新增项目进度日志 `PROGRESS.md`（当前状态 + 按提交倒序的时间线 + 维护约定），
  并在 `CLAUDE.md` 第 5 节规定：每次改动后同步刷新「当前状态」并在时间线顶部追加一条。

**未完成**：`docs/dashboard-design.md` 的 Phase 2 小节；提交与发布。

### 2026-10-22 · v1.1.1（`11ddc7b`）故障修复与权限归位

**做了什么**

- 修复整轮对话失败：`presets/quant-assistant/agent.cordis.yml` 的 persona `suffix` 里写了 `{{cwd}}`，
  而 DSH 提示词变量只注册 `provider`/`model`，未注册变量在生成提示词阶段直接抛错。
  该行多余（工作目录本就由宿主环境信息注入），删除。
- 删除插件自造权限层 `lib/approval.mjs` 与 `installGuards` 调用及 `guards` 配置键：
  会话权限完全交给 DSH 权限预设；工具内的 `APPROVAL_REQUIRED` 前置校验保留（显式参数契约）。
- 同步 README / ARCHITECTURE / 技能文案 / 冒烟脚本。

**验证**：172 测试通过；插件冒烟 33/33、25/25；本机 profile 升到 `#v1.1.1` 并 `pnpm install` 成功。

### 2026-10-21 · v1.1.0（`e03e57d`）回测看板

**做了什么**

- 单文件交互式回测看板：KPI（收益/风险/交易/成本）、净值曲线、回撤联动、分年度、成交与费用拆解、口径声明。
- 三层拆分：`model.mjs`（纯数据，schema v1）→ `render.mjs`（纯字符串，转义 `<` 与 `</script`）→
  `client-runtime.js`（加载三态、主题切换、PNG 导出）。
- ECharts 5.6.0 `echarts.common.min.js` 本地 vendored（664311B，sha256 钉版），`scripts/vendor-echarts.mjs` 可复现。
- 新增 `docs/dashboard-design.md`，README 补「回测看板」一节。

**验证**：172 测试通过（看板模型 14、渲染 17、vendor 7）；在 Node SSR 与浏览器内均验收过。

### 2026-10-17 · v1.0.11（`6583ce7`）工具输出被宿主拦成 INVALID_TOOL_OUTPUT

**做了什么**

- 根因：DSH 用 `output.schema` 校验工具返回值；失败信封 `{ok:false,error}` 不满足「业务字段必填」，
  以及部分字段声明为 `integer` 却返回 `null`。
- `lib/tools/kit.mjs` 的 `output()` 改为 `oneOf` 双分支（成功/失败按 `ok` 的 `const` 互斥），
  新增 `nullable()` 声明可空；5 处 `null` 落点改用 `nullable`。
- 补 `spike/repro-invalid-output.mjs`（用宿主同款校验器复现）与 3 条回归测试。

**验证**：150 测试通过；宿主真实校验器复现脚本从红转绿；插件冒烟 36/36、28/28。
**备注**：未发 npm，走 GitHub 渠道；README 补本地/ GitHub 两种安装方式与钉版说明。

### 2026-10-16 · v1.0.1 与预设修复

**做了什么**

- 修复「预设不可选」「安装后未启用」两个上手 bug。
- `tool-fs-search` 补必填 `sampleOverCapGlobResults`（DSH 刻意不留默认的部署开关）。
- README 补「安装 ≠ 启用」说明。

### 2026-10-16 · v1.0.0 首发（`a206507`）

**做了什么**

- P1–P6 全部落地：本地行情仓库与同步、109 个内置因子、策略版本链、可交易级回测（T+1、涨跌停、停牌、费用、滑点）、
  选股、持仓估值、盘后定时同步。
- 发布 `dsh-quant-assistant@1.0.0` 到 npm；`DATA-SOURCES.md` 记录数据来源与口径。

**验证**：e2e 四场景 24/24（隔离实例 + 真实凭证）；Docker 标准测试 20/20。

---

## 维护约定

1. **每次改动（一个提交或一批相关改动）完成后**：
   - 在时间线顶部追加一条：日期 · 版本/提交 · 做了什么 · 怎么验证 · 是否已发布。
   - 同步刷新「当前状态」：版本、在做、待办、已知问题、测试数。
2. **判定"完成"**：改动已在 `main` 上且测试通过；只改代码未验证的，状态写「未提交/未验证」。
3. **新踩的坑**必须进「已知问题与坑」，否则下一个 agent 会再踩一遍。
4. 时间线条目不删不改语义；纠正错误就再追加一条并注明「更正：」。
