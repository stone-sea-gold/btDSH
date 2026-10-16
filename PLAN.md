# dsh-quant — 执行计划与验收（PLAN）

> 技术设计见 [ARCHITECTURE.md](./ARCHITECTURE.md)。
> 本文件定义阶段划分、每阶段的**验收门**（不过门不进入下一阶段）、最终验收标准与投入估算。

## 0. 目标（以终为始）

**终**：一个发布到 npm 的 DSH 插件包，用户执行 `dsh plugin --profile web add <包名>` 后，新建会话可选「量化助手」preset，用自然语言完成 **因子检索 → 策略构建 → 可交易级回测 → 结果解读 → 迭代保存 → 选股/仓位检查**，且：

1. **数值可信**：复权口径与东财官方涨跌幅对账通过；
2. **行为可比**：同参数与 AIFUND5（qlib）回测同量级且差异可逐项解释；
3. **装得上、卸得干净**：干净 profile 安装无残留、卸载无失效状态；
4. **零环境负担**：纯 Node ≥22，无 Python、无原生依赖、无外部服务。

## 1. 阶段与验收门

### P0 — 可行性 spike（1–2 天）· ✅ 已完成（结论见 [spike/P0-FINDINGS.md](./spike/P0-FINDINGS.md)）

| 门 | 结果 | 关键实测 |
|---|---|---|
| **G1 数据可得性** | ✅ 通过（含 3 处设计修正） | 日线主源 91.7%/次；腾讯/搜狐可回退；退市股 600001 取到 390 根；基本面 `NOTICE_DATE` 覆盖 100%；分红送转事件可推导因子链 |
| **G2 限速与稳定性** | ✅ 通过 | 失败是连接级 RST（**非 429**）；并发 4/8/16 → 10/20/22 req/s；策略：并发 4–8 + 3 次退避重试 + 跨厂商回退 |
| **G3 性能** | ✅ **PASS**（6/6） | 全市场 864 万根：物化 36.9s、回测 Top50 **0.47s**、10 组扫参 6.7s、库 802MB、RSS 770MB |
| **G4 安装/卸载** | ✅ 通过 | `dsh plugin add` 自动入栈 → 组成树出现独立段 → 卸载自动出栈、0 残留；preset 物化/幂等/清理/第三方保护全过 |

**P0 发现的三处设计修正**（已回写 ARCHITECTURE）：
1. patch 的 `- id:` 是**覆盖**语义、插入必须用 `- insert:` 块（反而天然保证第三方插件不碰共享行）；
2. 复权因子链**必须由分红送转事件推导**，禁止用厂商"前复权÷不复权"比值；
3. 因子面板必须**连 rank 一起物化且只物化 top-N**（回测 19.1s → 0.47s，库 1706MB → 802MB）。

**P0 遗留**：① 浏览器端渲染未验证（需隔离实例）；② 因子链公式实现与对账（并入 P1）；③ `top-N` 默认值待定（当前 500）。

### P1 — 数据层（3–5 天）· ✅ 核心完成（门在**东财完全封禁**下达成；详见 [spike/P1-FINDINGS.md](./spike/P1-FINDINGS.md) 与 [DATA-SOURCES.md](./DATA-SOURCES.md)）

**已实现**：`lib/data/{http,codes,sources,store,events,verify,eventTable}.mjs` + `spike/{verify-data.mjs,oracle-baostock.py,build-events-baostock.py,build-events.mjs}`

- 多源适配层：内容校验（不看状态码）→ 逐请求重试退避 → **熔断器**（连续 8 次失败冷却 120s）→ 跨厂商回退
- 原始价：东财 push2his（含官方 pct）→ **新浪 getKLineData**（不复权，与 BaoStock 逐位一致）
- 复权事件：腾讯 K 线内嵌元数据 ∪ 东财分红表 → 合并规则 → 参考价四舍五入到分 → hfq 隐含跳变仲裁
- **离线因子表**（决策 1a）：`spike/build-events-baostock.py` 用交易所参考价反推精确事件 →
  `data/factor-events.json.gz`（168 事件 / 13 只 / 1.6KB；全市场约 1.3MB）；运行时**表优先**、只读、零 Python 依赖
- 仓库：`node:sqlite` + 显式 PRAGMA + schema 版本；bars / bars_hfq / adj_events / fundamentals / sync_state
- 诚实性修复：空数据或无法评估的门不再伪装成 PASS（A/C/D 标注 `not-evaluated`，新增 E 门）

**门结果（东财 push2 与 datacenter 均 0% 成功的前提下）**：
- oracle（交易所官方涨跌幅逐日比对）：**13/15 只最大偏差 0.0001pp**；超 0.2pp 的仅 **4 / 29,542 天（0.014%）**
- 4 天全部可解释并已写入边界声明：2 天退市股事件缺失、1 天为所有源都漏记的分配（300750 2025-01-24）、
  2 天为原始价序列一日错位（601899 2018-06-25/26）
- **结论：离线因子表把"精度依赖源站健康度"这个问题解决了** —— 在源站全挂时仍能精确复权

**P1 剩余（并入 P2 并行）**：代码表全量同步、交易日历、增量同步编排与断点续传、全市场预估/审批/后台分批、`quant_data_status`、基本面接入 runner（代码已就绪）、日期集合一致性检查。

### P2 — 因子与引擎（5–8 天）· ✅ 已完成（含与 AIFUND5/qlib 的同参数验收门）

**已完成：因子 DSL（`lib/factors/dsl.mjs`）**
- 词法 → AST → 白名单校验 → **分层 SQL 编译**（SQLite 不允许窗口函数嵌套，故按需新增 CTE 层）
- **109 个内置因子全部可编译（100%）、0 报错、0 不支持**
- 7 个"难函数"全部落地：`Quantile`（内置 `percentile_cont` 窗口）、`Slope/Rsquare/Resi`（纯窗口求和 + 全局行号）、
  `IdxMax/IdxMin/Rank`（`node:sqlite` 自定义滑动聚合，`step`+`inverse` → O(log N)/O(1)）
- **跨实现真值对照**：`spike/oracle-factors.py` 用 qlib 自带 Cython 实现 + pandas 生成基准，
  `spike/verify-factors.mjs` 逐点比对 → **106,263 个点 0 不一致**（位置/名次/分位逐位相等，回归类最大归一化偏差 4.9e-9）
- 安全边界 6/6 拒绝（未知字段/函数/窗口越界/非字面量窗口/注入/参数个数）；`Quantile` 分位点额外校验 0..1
- 编译器额外产出 `lookback`（保守上界），供临时求值裁剪源数据

**已完成：因子面板（`lib/factors/panel.mjs`）**
- **top-N（默认 500）+ SQL 层 `row_number()` 排名**（不能用 `rank()`：并列会撞主键）
- 幂等（同 `formula_hash` 直接跳过）、公式变更自动失效重建、增量补算、LRU 淘汰、体检报告
- **关键正确性**：因子算在 `bars_adj` **复权视图**上（否则动量类因子在除权日带分红跳空）；累计因子用单次窗口扫描 `exp(sum(ln(factor)))` 算出，避免笛卡尔代价
- 实测（15 只 / 2.9 万 bar）：物化 150–200ms/因子、2.9 万行；幂等复跑 0ms

**已完成：可交易级回测引擎（`lib/backtest/{book,engine}.mjs`）**
- 三层结构：① 读面板（不在回测时算因子）② 调仓日展开目标权重（等权/因子加权 + 缓冲）③ `PortfolioBook` 逐日账务
- 口径：**T 收盘信号 → T+1 开盘成交**、涨停不买/跌停不卖/停牌不交易（**原始价判定**）、T+1 制度、整手成交（部分卖出整手、清仓可零股）、佣金（含最低 5 元）/印花税（仅卖出）/过户费/滑点
- 指标：总收益、年化、波动、夏普、最大回撤、Calmar、胜率、最长回撤、年化换手、费用拆分、基准超额/Beta/IR
- 基准：给定代码用该代码，否则用**区间内等权买入持有代理**（未接指数数据，已写入结果声明）
- 边界声明随结果输出：ST 用当前快照、上市天数用自然日近似、日频无法表达盘中路径
- **确定性单测 8/8 通过**（`tests/backtest.test.mjs`）：费用/整手/T+1 可手算复现、**T+1 成交后的 NAV 与手算一致**、涨停拒买、停牌不成交、指标解析值
- 端到端（15 只 / 2019–2026 / 月度 Top3）：1876 交易日、92 次调仓、451 笔成交，**不变式 6/6 通过**（NAV 恒等、无同日买卖、整手、无超卖、无 NaN、印花税仅卖出）

**已完成：选股（`lib/factors/select.mjs`）**
- 两条路径**同口径**：① 读已物化面板（O(候选数)）② 现场编译求值（按 `lookback` 裁剪源数据，只取信号日截面）
- 实测两条路径名单完全一致、因子值最大偏差 `0.00e+0`
- 股票池过滤与回测引擎同口径，并**逐条给出拒绝原因计数**（ST / 停牌 / 上市天数），"为什么这只没入选"可回答
- 支持反向选股（`ascending`）、topK、自定义股票池开关

**已完成：参数优化（`lib/backtest/optimize.mjs`）**
- 网格（笛卡尔积）+ 随机（mulberry32 **同种子可复现**，实测两次结果完全一致）
- **因子面板只物化一次，扫描只换策略参数**（topK / 调仓 / 权重 / 缓冲 / 执行价），不重算因子
- 6 个目标函数（sharpe/cagr/calmar/totalReturn/excessReturn/informationRatio）；目标无定义的组被**排除而非当作 0**
- 护栏：组合数上限（默认 500，超限拒绝并给出收窄建议）、topK 超面板深度拒绝、面板失败可归因到具体因子
- 随结果返回过拟合声明：样本内择优必须样本外复核

**顺带修掉的两个真实缺陷**
- `codes.list_date/delist_date` 在 schema 里存在但 `upsertCodes` **从未写入** → "上市不足 60 日"过滤永不生效；已补齐（并支持 camelCase/snake_case，null 不覆盖已有值）
- `date - list_date` 对 `YYYYMMDD` **整数相减不是天数**（`20240110−20231225 = 8885` 而实际 16 天）→ 过滤器几乎永不触发；新增 `dayOrdinal/calendarDaysBetween` 并接入引擎与选股

**全市场规模实测（`spike/p2-perf.mjs`，5400 只 × 1600 日 = 864 万行）**
- 7 个新函数的物化耗时是**基线的 0.88×–1.70×**（`Quantile` 0.88× / `IdxMax(60)` 1.23× / `Slope` 1.28× / `Resi` 1.32× / `Rank` 1.40× / `Rsquare` 1.70×）；基线 `Mean` 本轮自测 60.6s（P0 同数据曾 36.9s），**绝对门限是机器相关的，只有相对倍率可比**
- 一处实测优化：把 `x*x`、`__idx*x` 直接内联进 `sum(...) OVER (...)`、并用 `NULL − idx + cnt = NULL` 省掉 IdxMax 的一层 CTE（每层 CTE 都是一次全表物化）→ `IdxMax(60)` 113.3s → 74.8s（−34%），最大层数 3 → 2
- 内存：`temp_store=memory` 峰值 RSS 1622MB、`file` 560MB（−65%，耗时 +18%）。`file` 需要可写临时目录，否则 SQLite 报 `unable to open database file` → `openStore` 在 `file` 模式下自建仓库同级 `.sqlite-tmp/` 并设 `SQLITE_TMPDIR`，建不出来则安全退回；`DSH_QUANT_TEMP_STORE=file` 可全局切换

**已完成：P2 验收门（与 AIFUND5/qlib 同参数对照）· ✅ 通过**

完整报告见 `spike/GATE-FINDINGS.md`。三层阶梯，每层抓不同的东西：

| 层 | 比什么 | 结果 |
|---|---|---|
| Rung 0 数据口径 | 交易日集合 / 复权口径 / 逐日收益率 | ✅ 11/12 只只差一个常数（离散度 ≤4e-7）；第 12 只是停牌表示差异 |
| Rung 1 因子横截面 | qlib 表达式引擎 vs 我的 DSL | ✅ 11/12 条语义级残差 **2.5e-8~7.8e-8**（float32 地板）；第 12 条是已声明的 `Max(x,0)` 分歧 |
| Rung 3 全账务 | qlib executor vs 我的引擎 | ✅ 逐日持仓一致 **646/659 = 98.0%**；波动 32.00% vs 32.17%；年化 13.26% vs 14.76% |

- **设置**：12 只交集股票池、2024-01-02~2026-09-21（660 交易日）、`$close/Ref($close,20)-1`、topK=3、日频、等权
- **关键设计**：Rung 1 做成**两级**（qlib 价格 + 我的算法 = 语义级；我的价格 + 同一算法 = 数据级），
  这样"因子值不一样"能归到具体一边；用**过原点最小二乘**拟合每股常数 k 而非比值，避免近零点把比值炸掉
- **12 条差异全部归因**（复权基准 / 停牌表示 / 缺失分红 / float32 地板 / 窗口 NULL 方向 / `Max(x,0)` /
  qlib 自带一天滞后 / risk 是毛收益口径 / 滑点归属 / 策略语义 / 涨跌停阈值 / T+1 与整手），无未解释残留

**门顺带挖出 6 个缺陷（4 个 AIFUND5 侧 + 2 个我方侧）**
- AIFUND5：① qlib 导出把日历偏移算两遍 → **294/297 只标的对 qlib 完全不可见**（静默失败，已修，修后 297/297）
  ② `_execute_backtest` 忽略用户编译的因子策略（硬编码 Alpha158+LinearModel，已修）
  ③ `_build_qlib_strategy_dict` 产出的字典双重不可用（已修）④ `Max(x,0)` 让 3 条 RSI 因子算的不是 RSI（已记录）
- **我方（都是这个门抓出来的）**：① 停牌持仓按 0 估值 → NAV 假跳变（单日 +43%、最大回撤被从 −20% 夸大到 −47.72%，已修）
  ② 限定股票池时先截断再过滤 → 组合只买 2 只而非 3 只（总收益差 26pp，已修）

**门**：同参数（同因子/区间/调仓/股票池）与 AIFUND5(qlib) 回测结果同量级，差异逐项可解释 ✅；单次全市场回测 ≤ 2s（面板命中）；扫参 100 组 ≤ 5 分钟。

### P3 — 工具面 / 技能 / preset · ✅ 已完成

**已完成：29 个 `quant_*` 工具**（`lib/tools/`，按域分 5 个模块）

| 域 | 数量 | 工具 |
|---|---|---|
| 因子 | 4 | list / search / preview / create |
| 策略 | 6 | compose / save / load / list / search / versions |
| 回测 | 3 | run / analyze / get |
| 选股 | 1 | select_stocks |
| 优化 | 1 | optimize_parameters |
| 仓位 | 3 | save_holdings / portfolio_status / save_position_rules |
| 日历 | 2 | trading_calendar / resolve_date |
| 行情财务 | 6 | quote / kline_history / financial_summary / quarterly_financials / industry_stocks / index_constituents |
| 仓库 | 3 | data_status / data_sync / data_cleanup |

- **工具面基础设施**（`lib/tools/kit.mjs`）：统一信封（`ok:false` + `{code,message,hint}`）、
  标准渲染、schema 构造器。DSH 的 JSON Schema 只支持子集（`type/oneOf/properties/required/
  additionalProperties/items/enum/const` + 注解），有单测逐个校验 29 个工具的 schema 不越界
- **契约实测**：`ctx.tools.register()` 接受普通对象，第三方包**不需要 import DSH 内部模块**
- `quant_strategy_compose` 与 `save` **刻意分开**：compose 是纯函数（可反复试算不落库），
  因此"用户拒绝保存"是一条真实存在的分支，而不是靠模型自觉
- `quant_select_stocks` 两条路径同口径（面板 / 现场求值），股票池过滤**逐条可归因**
- **面板新鲜度与行情新鲜度是两件事**：同步新行情不会自动延伸已有面板。
  默认取"最新交易日"时若面板未覆盖，会退到面板最后一天并**明确告知**；
  但调用方**显式指定**日期时不猜——直接报错

**已完成：审批护栏**（`lib/approval.mjs`）
- 基于 `tools.guard()` 的**单调否决**：全市场同步 / 回测 >5 年 / 参数组合 >100 组 / 删库
- 拒绝理由必须包含"怎么继续"（`confirm=true` 或 `estimateOnly=true`），有单测强制
- **不记住上次批准**：每次按当次参数判断 —— 用户同意的是"这次全市场同步"，不是"以后任何一次"
- 护栏自身出错时**放行**（宁可少拦一次，也不能因为护栏 bug 让所有调用失败）

**已完成：preset 物化与生命周期**（`lib/index.js`）
- 包内 preset 投递到 `$DSH_HOME/.agent-presets/quant-assistant/`（含 `preset.yml`、
  `agent.cordis.yml`、三个技能）
- 幂等；版本变化触发重写；**第三方保护**：目录存在但元数据不是本包写的 → 绝不触碰
- 卸载清理只删元数据匹配的那一个目录；所有注册通过 `ctx.effect` 归还
- 冒烟 30/30 覆盖上述每条（含"别人的 preset 不被覆盖/删除"）

**已完成：版本链 + session 溯源**（store schema v3）
- `strategies(strategy_id, version)` 主键 → **保存即新增版本，永不覆盖**
- 每版记录 `session_id` / `turn_seq`，`quant_strategy_versions` 支持两版对比
- 回测结果留档（`backtests` 表），可用 `quant_backtest_get` 复取

**已完成：3 个技能**（随 preset 走，`customSkillDirs` 指向 preset 自己的 `skills/`）
- `quant-sources`：数据来源、七条覆盖边界、复权口径、`web_fetch` 兜底方式
- `quant-workflow`：标准流程 + 三条分支（数据过期 / 用户拒绝保存 / 护栏拦截）
- `quant-discipline`：合规底线与结果表述规范（区分毛/净收益、样本内外、话术陷阱表）

**已完成：数据同步编排**（`lib/data/sync.mjs`，P1 遗留）
- 代码表 / 行情 / 复权事件 / 基本面；**按股票粒度断点续传**（`sync_state`）
- 复权事件流水线顺序与 P1 验证路径一致：合并多源 → **离线表优先** → 后复权隐含跳变仲裁
- 规模估算（股票数 / 请求数 / 分钟数）与审批标记

**验证**：单测 39/39；工具冒烟 **47 次调用 47 通过**（含 12 条预期失败路径）；
插件级冒烟 **30/30**（含第三方 preset 保护与卸载清理）

**门**：端到端主路径跑通 —— 一句话 → 因子检索 → 策略确认 → 回测 → 报告，全程无人工干预；含「数据过期」提示与「用户拒绝保存」两分支。✅

### P4 — UI（3–5 天）· ✅ 已完成

**已完成：4 张工具卡 + 1 个设置页**（`lib/client.js`，手写 ModuleLoader 格式，无构建管线）

| 卡片 | 落点 | 内容 |
|---|---|---|
| 回测结果 | `tool.call.toolview` key=`quant_backtest_run` | 手写 SVG 净值曲线（viewBox 自适应）+ 8 项指标 + 基准对比 + 分因子 + **可折叠口径声明** |
| 数据状态 | key=`quant_data_status` | 股票数/行情根数/复权事件、区间、新鲜度、**面板落后提示**、可折叠面板列表 |
| 数据同步 | key=`quant_data_sync` | 完成态（耗时/根数/事件/跳过/失败明细）与**审批态**（规模与耗时） |
| 选股结果 | key=`quant_select_stocks` | 候选名单 + 拒绝原因计数（ST/停牌/次新）+ 免责声明 |
| 设置页 | `settings.section` | 数据路径、低内存选项、查看/清理指引、免责声明、已知限制 |

**关键发现：客户端没有通用 host RPC**（那是动态 Package 专有的）。所以结构化数据只能走
`output.presentationMeta` → `tool/result` 事件的 `meta` → `block.meta`。由此：
- 卡片是**工具结果的纯函数**（不订阅、不轮询、无 hooks，有单测禁止）
- 设置页**拿不到实时宿主状态**，因此只给静态信息与操作指引，**不编数据**

**踩到的真实缺陷**：`quant_data_status` 的 meta 含 `undefined` → DSH 抛
`output.presentationMeta returned non-lossless JSON` → **整次工具调用失败**。
修复放在工具工厂层（`jsonSafe`），而不是让 29 个工具各自记得剔除 undefined。

**验证**（真实 React 在 web bundle 里、不在 host 侧，故用最小 React shim 做树渲染）
- 客户端单测 **16/16**：ModuleLoader 契约、注册键与宿主工具名一致（键写错就永不渲染）、
  4 张卡片 × 正常/失败/meta 缺失、设置页、`navPath` 退化输入、**320px 不溢出**、SVG 自适应
- 端到端接线单测：`presentationMeta` 的 kind 与客户端分派的 kind 一一对应；
  净值曲线降采样到 ≤140 点且 meta < 20KB
- 全量：单测 **58/58**、工具冒烟 47/47、插件冒烟 30/30

**残余风险（已补验，见下）**：未在真实浏览器里跑过（本机 3080 是用户实时 GUI，不宜占用）。
单测覆盖了组件抛错/结构缺失/键名写错/宽度溢出，但**像素级视觉效果未验证**。

**门**：干净环境可视化可用；卡片在 320px 宽度下不溢出；无客户端渲染错误。

### P4 补验 — 真实浏览器（隔离实例）· ✅ 已完成

在**隔离实例**（独立 `DSH_HOME` + `--port 0`，不占用用户的 3080）里，用一个只用于验证的
客户端插件把六张卡片渲染到 `shell.overlay`，用**真 React + 真主题 CSS + 真布局引擎**断言。
现场与复现步骤见 `spike/out/browser/README.md`；结果 **25/25 通过**：

- **320 / 360 / 1280px 三个宽度、16 个用例全部无横向溢出**（量 `scrollWidth`，不是"看有没有写死宽度"）
- 10 个主题令牌全部解析成真实值（`--dsw-alias-label-primary: #0f1115` 等）
- A 股配色正确：正收益红 `#ec1313`、"新鲜"绿 `#22c55e`、警告琥珀 `#f59e0b`、失败红
- 回测卡的 SVG 净值曲线真的画出来了（`path.d` 1873 字符、描边色跟着盈亏走、有面积填充）
- `<details>` 折叠块**点得开也收得回**（`18px → 94px → 18px`）
- 无控制台 error、无页面异常、无失败请求

**这一轮抓到 2 个只有真浏览器才能发现的缺陷**（都是"既不抛错也不告警"的那类）：

1. **`chip('已开启', 'down')` 传的是字符串字面量而不是主题令牌** ——
   CSS 里 `color: down` 是非法值，**静默**回退成继承色，"已开启"看起来和普通文字一样。
   修复：加一层 `cssColor()` 解析，让令牌变量与语义名两种写法都正确；
   并加单测断言"已开启"必须带成功色令牌。
2. **同步卡把"规模估算"渲染成"同步中…"** —— `estimateOnly` 的调用**没有 `ms` 字段**，
   而卡片用 `ms === null` 当"运行中"。
   修复：宿主 `presentationMeta` 增加显式 `phase: 'estimate' | 'approval' | 'done'`，
   卡片按 phase 分派（不再猜），并加单测锁住四个阶段各不相同。

顺带纠正了验证脚本自己的一个误判：量 `<details>` 折叠**必须量 `<details>` 自身** ——
内容 `div` 折叠时仍保留布局盒，量它会得出"点开前后都是 70px"的错误结论。

**第二轮：真的看图之后又抓到 2 个**（详见 `spike/out/browser/README.md`）

第一次跑这个验证时 `read_image` 被拒绝，我据此在注释里写了"本模型读不了图片" —— **那是错的**。
真实原因是**当前模型路由在配置里没声明 `input: [text, image]`**（`dsh-llm-pi-ai` 的
`DEFAULT_INPUT = ["text"]` 兜底），而 DSH 自带目录里名字就叫 DeepSeek-V41-Flash 的那条
明确写着 `inputModalities: ['text','image']`，只是属于另一个 provider。补上声明后
`read_image` 立刻可用。**教训：不要把一次工具拒绝推断成自己的能力结论。**

能看图之后重看截图，抓到两个纯断言抓不到的问题：

1. **回测卡 4 个指标在 320px 下挤成 3+1**（第 4 个孤零零掉到下一行）—— 它**不溢出**，
   所以溢出断言全绿。修复：`metric()` 加换行阈值参数，4 指标用 `1 1 110px` → 整齐 2×2，
   3 指标仍用 72px；并加断言锁住 320/360px 每行 2 个、1280px 每组一行 4 个。
2. **截图文件名是错的** —— `verify-cards.mjs` 按数组下标取卡片截图，而 `CASES` 里插了
   一个新用例导致下标整体错位，`single-export.png` 存的其实是 AutoSync 卡。
   改成按 `data-case` 名字取。**这个 bug 只有看图才发现**：文件名和内容对不上，断言不会报错。

### P5 — DSH 原生强化（2–3 天）· ✅ 已完成

**已完成：盘后定时增量同步**（`lib/data/autosync.mjs` + `quant_autosync`，设计见 ARCHITECTURE §6.5）

- **增量而不是每天重拉全市场**：`syncBars` 新增 `incremental: {overlapDays}`，
  起点**按股票各自算**（`sync_state.bars_last − 10 天`）。不这么做，"每天跑一次"就等于每天全量重拉
- **重启后能补跑（P5 的门）**：`nextDueAt` 落库（`meta.autosync`），启动时读出，
  已是过去时刻就**立刻补跑**（延迟 0，不阻塞启动）。补跑不是特例分支，是同一个 `evaluateDue` 的结果
- **跑了 ≠ 成功了**：先探测 3 只（`bars_last` 最新的）判断"今天有没有新数据"，
  没有就 `noNewData` 且**一次请求都不铺开**（非交易日 5400 次 → 3 次）；
  铺开后校验库内最大日期**确实前进**，否则记 `staleSource`。两者都只重试一次，不无限重试
- **授权在配置时取得**（决策 A）：开启 = 长期授权，记录 `consentAt` / `consentBy`；
  护栏先拦一次 + 工具再兜一层；运行时仍有硬上限（`maxCodes` 默认 3000），超了**跳过并记录**
- **降级是明确的**：无 `timer` 服务（headless）→ 如实报 `timer-unavailable`，手动路径照常；
  仓库不存在 → 不建库不排程；部署层 `autoSync: false` → 强制关闭并清落库状态
- **清理不清授权**：`quant_data_cleanup {scope:'all'}` 删行情表但**不动 `meta`**

**已完成：数据新鲜度提示**

- **工作日口径**：新增 `weekdaysBetween` / `isWeekend` / `shiftYmd` / `ordinalToYmd`。
  自然日口径会让每个周一早上都报"过期 3 天"，那是噪声不是信号。
  `quant_data_status` 同时返回工作日与自然日，`stale` 用工作日判定
- `quant_data_status` 增加 `freshness` 与 `autoSync` 两块；数据过期且自动同步未开时，
  卡片与 render 都会**建议**开启（但不替用户开）
- preset 人格与 `quant-workflow` 技能新增「数据过期」分支的四步处理

**已完成：结果导出交付物**（`lib/export.mjs` + `quant_export`，设计见 ARCHITECTURE §6.6）

- 5 种导出：`backtest`（报告 + 净值 CSV）/ `select` / `holdings` / `panel` / `data_status`
- **默认落进会话工作目录**的 `quant-exports/`（`exec.agent.session.header.cwd`）——
  这是唯一既能被 `present` 呈现、用户又能自己找到的位置；没有会话目录时退回数据目录并**如实标注**
- **CSV 带 UTF-8 BOM**（否则 Excel 打开中文列名是乱码）；文件名净化挡住路径穿越
- 报告自带口径声明与免责声明；导出后**必须** `present`（render 里直接写明这一步）

**已完成：`goal` / `fork` / `compaction` 文档化**

- 新增第 4 个技能 `quant-session`：`goal` 的判据写法与完成纪律、
  `subagent_fork` 用于**样本外独立复核**（必须在看到样本内答案**之前**分叉）、
  压缩的代价（工具结果 8KB 处被裁剪）与"要引用的结论先落盘"
- preset 新增 `tool-subagent-fork` 行。**只挂 fork，不挂 spawn**：
  回测是本地计算密集，多开子会话不会更快，还会重复读同一份数据仓库；fork 的价值在**独立性**
- 人格新增"要交给用户的结论先落盘"与"不要凭记忆重述已经不在上下文里的数字"

**验证**

- 新增 `tests/autosync.test.mjs`（30 条）、`tests/export.test.mjs`（24 条）、`tests/plugin.test.mjs`（4 条）；
  全量单测 **122/122**
- 工具冒烟 **61 次调用 61 通过**（31 个工具，含 13 条预期失败路径）；
  插件级冒烟 **36/36**（含"apply 不建库""自动同步默认关闭""护栏能拦开启自动同步""四个技能已投递"）
- **新增 `spike/plugin-real-ctx-smoke.mjs`：在真实 Cordis `Context` + 真实 `TimerService` 里
  用 `ctx.plugin()` 装载一遍，28/28 通过**（不需要启动 DSH 进程，因此不占用用户的 GUI）。
  它验证了假 ctx 永远验不了的东西：`ctx.get('timer')` 真能拿到 `TimerService`、
  `inject: ['tools']` 的延迟激活、真实 `setTimeout` 触发的补跑、fiber 卸载时 effect 真的归还
- **新增 `spike/out/browser/verify-cards.mjs`：真实浏览器卡片验证，25/25 通过**
  （隔离实例 + puppeteer + 真 React + 真主题 CSS，见上面 P4 补验一节）
- **隔离实例端到端**：`dsh plugin add` 真实装包 → `--dump-config` 里出现 `quant-host` 行 →
  `dsh web` 起在随机端口 → index 的客户端模块清单里出现 `dsh-quant-assistant/client.js` →
  preset 与四个技能被物化到该实例的 `$DSH_HOME/.agent-presets/quant-assistant/`

**这个冒烟抓出一个"装不上"级别的缺陷**

> Cordis 把插件 `apply` 的**返回值当成 effect 解释**：函数=disposer / `null`=无 /
> 可迭代=一组 disposer / **其它对象 → 抛 `Invalid effect`**。

原来的 `apply` 返回诊断报告（普通对象）。手写假 ctx 直接调 `apply(ctx, config)` 时返回值没人管，
一切正常；但 DSH loader 走的是 `ctx.plugin()`，于是**整个插件装不上**。
已拆成 `apply`（返回 void）+ `setup`（返回报告），并加了两道回归守卫：
`tests/plugin.test.mjs`（返回值形状）+ 真实上下文冒烟（`ctx.plugin` 真能装载）。

**单测还抓出 3 个真实缺陷**：① `nextSlotAfter` 只判"推进一天后是不是周末"，
导致周六早上开启会排到周六 18:30 空跑；② `applyResult` 先累加重试次数再判额度，
使 `maxRetriesPerDay=1` 退化成"一次都不重试"；③ 定时回调不返回 promise，
让"跑完重新排程"的断言与异步赛跑（测试脚手架缺陷，但暴露了排程时机的真实竞态）。

**门**：定时任务在 DSH 重启后能正确恢复 ✅（`tests/autosync.test.mjs` 用"写入昨天的
`nextDueAt` → 换句柄重开同一个库 → 断言立刻排程且延迟 0"覆盖；真实上下文冒烟里用
**真实 `setTimeout`** 又验了一遍）；导出文件可被 `present` 呈现 ✅
（断言文件真实存在、路径在会话工作目录内、meta 带绝对路径）。

### P6 — 验收与发布（2–4 天）· 🚧 进行中

四条最终验收标准（见 §2）全绿 → 打 tag → 发 npm → 写 README（安装、数据来源、免责、卸载清理）。

**门**：干净机器（或全新 DSH_HOME）走完「安装 → 对话 → 卸载」全程。

#### 进度

| 验收标准 | 状态 |
|---|---|
| 1 口径对账 | ✅ **按改写后的判据达成**：正常股票 ≤ 0.0001pp（0.000054~0.0001pp）；声明过边界的样本逐项归因、无未解释残差。原"零不符"未达成，详见下面"验收标准 1 的如实结论" |
| 2 行为对账（vs AIFUND5/qlib） | ✅ **复跑全绿**：Rung 0 11/12 只只差常数；Rung 1 语义残差 ~1e-8；Rung 3 持仓一致 646/659 = 98.0%，对齐口径波动 32.00% vs 32.17%、年化 13.26% vs 14.76% |
| 3 端到端场景（对话） | ✅ **24/24 通过**（隔离实例 + 真实凭证拷贝；工具面等价，LLM 半边由真实浏览器技能卡验证） |
| 4 干净安装/卸载 | ✅ **Docker 双版本通过（20/20 与 14 通过/0 失败/3 跳过）**：0.2.0-rc.2 全绿；0.1.5-rc.1 宿主自身装不起来（npm 发布的 dsh-sandbox-local 无可解析版本），依赖启动的检查降级为跳过。并抓出 **DSH 发布事故** 与 **关闭即删 preset** 两个 bug；卸载语义按"plugin remove 不启动 DSH"的平台限制如实验收 |
| 5 公开分发 | ✅ **已发布到 npm**：[`dsh-quant-assistant@1.0.0`](https://www.npmjs.com/package/dsh-quant-assistant)，`latest` 指向 1.0.0，42 个文件 / 446 KB / shasum `acd559fa`（本地 `npm pack` 复现结果逐字节一致）。安装：`dsh plugin --profile web add dsh-quant-assistant`。源码：[stone-sea-gold/btDSH](https://github.com/stone-sea-gold/btDSH) tag `v1.0.0` |

> 分发过程记一笔（真实踩坑）：npm 2026 年的新策略下，`npm publish` 要求交互式 2FA 或带 bypass-2FA 的 granular token；而带 bypass 的 token 若选成新的 **"Read and write (stage only)"** 权限，则只能走 `npm stage publish` 暂存流程。新建包走暂存时会先公开占位版本 `0.0.0-stage`，正式版本进队列等维护者批准；本次 `npm stage approve`（CLI）对新建包暂存**恒返回 404**（原始端点即 `staged version not found`，而同一 id 在 `npm stage list/view` 里正常可见），最终按官方文档走 **npmjs.com → Staged Packages → Approve** 完成 2FA 批准。

#### 验收标准 1 的如实结论（不粉饰）

第一次结果是 **148 天超过 0.2pp、最大 65.6pp，verdict: CHECK**。我没有把它归为"边界"，而是逐项归因。三层结论：

1. **复权算法本身是对的。** 事件完备的正常股票与 BaoStock 独立官方口径逐位一致到 **0.00005~0.0001pp**
   （`000001` 0.000054、`000002` 0.000053、`000004` 0.000058、`601318` 0.0001）—— 与 P1 的 0.0001pp 结论一致。
2. **大偏差全是事件缺失。** 全市场同步期间东财被 IP 级限流，`adj_events` 只有 8075 个 / 5481 只 ≈ **1.5 个/只**（正常应约 10 个/只）。
   典型案例：`000540` 在 2017-08~2019-01 长停牌期间发生一次公司行为，我的事件表里是**空的**，
   于是复牌日算出 **-40.41%**，而官方是 **-10.06%**（隐含参考价 4.87，7.35/4.87 = 1.51 正是那次分配）。
   用 **BaoStock 的交易所参考价**（独立厂商，不依赖东财）重建样本事件后，超阈天数 **148 → 22**。
3. **剩余 22 天分两类，都已定位：**
   - **3 天是停牌期间除权仍未抓到**（`002323` 20220106 差 42pp、`600725` 20171201 差 52pp、`600733` 20180927 差 45pp）
     —— 样本里这几只建表器返回 **0 事件**（停牌期间的参考价 BaoStock 也不全）；
   - **19 天是 0.2~0.97pp 的跨源价格差**：例如 `600462` 20180904 我的 close 与官方参考价差约 1 个最小变动单位。
     量级不属于"算法错"，属于**两个官方来源在个别日子上的价格不一致** —— 这是 DATA-SOURCES.md 第 5 条
     （原始价序列跨源一致性）与第 1 条（退市股事件源不完整）**已经声明过的边界**。

   还有第二个口径：**东财 `pct` 字段**（标准原文指定的那个）在 7/75 只、16,422 天上**全部落在 0.005pp 舍入地板**、
   0 天超阈 —— 通过。但它是**不复权口径**且只 2 位小数，只能证明"没算错一个量级"，证明不了 0.005pp 以内的精度。

**结论**：对**正常股票**，口径精度达标且比门规定的更严；对**退市/高分红/长停牌**这三类**本来就是声明过的数据源边界**，
"零不符"在东财全程限流的条件下做不到。**没有达成，只能如实记录。**
达到它需要：东财恢复后重拉全市场（或把行情主源切换到 BaoStock/腾讯），再把事件表补全。
**判据已按用户决定改写为**：正常股票 ≤ 0.0001pp；声明过边界的样本逐项归因、无未解释残差 —— 这才是可重复且达得到的判据。改写后标准 1 记为**达成**，原"零不符"要求未达成的事实如实保留在本节。

数据基础：全市场 **5923 只 / 1088 万根 bar**（20160104~20261015），抽取样本 **74 只**；
 可用于复跑的产物有 `spike/out/full-market/{quant.db, acceptance-1-sample.db, p1-oracle.json, acceptance-1.json}`。

#### 已挖出的三个问题（都是 P6 才暴露的）

**① 分页 bug：`syncCodes` 从来没拿到过全市场。**

东财 `clist` 的 `pz` 上限是 **100**，而 `emList` 的默认 `pageSize` 曾是 200；
停止条件写的是"本页不足 pageSize 就是最后一页"——于是每页都"不足"，**永远只拿第一页**。

- 影响面比预期大：`quant_index_constituents` 的**沪深300 成分一直只返回 100 只**，`quant_industry_stocks` 同理
- 修复：`pz` 夹到上游上限；停止条件改为**以 `total` 为准**
- 修完实测：代码表 **100 → 5923 只**，其中**名称含「退」154 只**
- 回归测试 6 条（`tests/sources.test.mjs`），并**实测验证过它们能抓住旧实现**（旧逻辑下 3 条失败）

**② `includeDelisted` 是个会撒谎的参数。**

`syncCodes` 收下它、转手传给 `emList`，而 `emList` 根本没有这个参数——静默丢弃。
代码读起来像在控制什么，实际什么都没控制。已改成真实的 `includeOtc`，
并把覆盖范围写进 `DATA-SOURCES.md` 第 1 条与 `quant-sources` 技能（七条 → 八条）。

**③ DSH 版本断层：开发环境与 npm `latest` 差一个大版本。**

| | 版本 |
|---|---|
| 本机（开发与验证环境） | `0.1.5-rc.1` |
| npm `latest`（新用户拿到的） | **`0.2.0-rc.2`** |

已实测：

- 依赖版本全部上浮（`cordis` 4.0.2 → 4.0.4，`dsh-*` 0.1.5-rc.2 → 0.2.0-rc.2）
- **但契约没变**：`apply` 返回值仍是 effect 契约（仍会抛 `Invalid effect`）、
  `ToolDefinition.output/presentationMeta` 仍在、`__ModuleLoader__.load({id,factory})` 未变、
  `timer.timeout(cb,delay)→disposer` 未变、三个插槽名都在、preset 引用的 15 个包都在
- **实测装载**：把插件装进 **0.2.0-rc.2 的真实 Cordis 上下文，28/28 通过**
  （`DSH_PKGS=<0.2.0 树> node spike/plugin-real-ctx-smoke.mjs`）
- Docker 验收同时跑两个版本，覆盖 preset 与客户端半

#### 顺带修掉的验证脚本缺陷

- Docker 驱动脚本 `|| { ...; exit 1 }` 少了 `}` 前的 `;` → bash 把 `}` 当成 `exit` 的参数，
  报的是"第 N+1 行 unexpected end of file"，离真正的问题很远
- 容器内验收**把检查顺序写反了**：preset 是在插件 `apply`（**首次启动**）时物化的，
  不是 `dsh plugin add` 时。第一版"先查 preset 再启动"，把"还没启动"误报成"preset 没投递"

## 2. 最终验收标准（D）

| # | 标准 | 判定方式 |
|---|---|---|
| 1 | **口径对账** | 全市场抽样（退市股 / 高分红股 / 长停牌股）× 5–10 年，自算涨跌幅 vs 东财官方字段最大偏差 < 0.01pp、零不符 |
| 2 | **行为对账** | 同参数与 AIFUND5(qlib) 回测的收益/回撤/夏普同量级，且差异可逐项解释（口径差异清单） |
| 3 | **端到端场景** | ① 主路径（因子→确认→回测→报告）② 数据过期提醒分支 ③ 用户拒绝保存分支 ④ 全市场首次拉取预估+审批+中断恢复 |
| 4 | **干净安装/卸载** | 全新 profile：装后 preset 出现、全局开关生效；卸载后无失效 preset、无损坏配置、数据按策略保留/清理 |

## 3. 投入估算

**单人 4–6 周**（P0 1–2 天 · P1 3–5 天 · P2 5–8 天 · P3 3–4 天 · P4 3–5 天 · P5 2–3 天 · P6 2–4 天）。

关键路径：**数据层（P1）→ 因子/引擎（P2）**，两者决定其余工作能否开始。

## 4. 风险与对策

| 风险 | 触发信号 | 对策 |
|---|---|---|
| **东财边缘节点拒绝**（已实测） | 请求连接级 RST（`UND_ERR_SOCKET`），**非 429**，同一主机成功率随时段漂移；`push2` 对 kline 返回 200+空数据 | 内容校验 + 主机级重试 + 跨厂商回退（腾讯/搜狐）；并发压到 4–8；失败入 `sync_state` 下轮重试 |
| 限流/封 IP | 请求失败率上升 | 默认低并发 + 限速可配 + 退避重试 + 断点续传 |
| 全市场规模性能不达标 | G3 不过 | 因子面板分片 + 按日期分区 + 只物化被引用因子 + 减少扫描列 |
| 停牌/涨跌停/ST 历史不全 | G1 部分失败 | 显式降级并在回测结果中声明影响的区间与股票数 |
| 共享行 schema 漂移 | DSH 升级后 `--dump-config` 报错 | 保守 patch + 启动探测 + 版本兼容层 |
| 卸载残留 | 用户反馈 | 元数据 + 「卸载并清理」+ 文档 |
| 合规 | 社区质疑 | §9 合规边界写进人格与 README |

## 5. 现在开始做什么

1. **P0 四门**（本阶段）：G1 数据可得性 → G2 限速 → G3 性能 → G4 安装/卸载。
2. 门不过 → 回到 ARCHITECTURE 修订对应章节，再重跑。
3. 全过 → 进 P1，数据层先行。

## 6. 待你输入

1. **包名 / scope** 与 **preset 显示名**。
2. 默认值确认：股票池 = 全市场剔除 ST/停牌/上市不满 60 交易日；信号 T 日收盘、**T+1 开盘成交**；基准默认中证全指。
3. 是否需要我把 P0 的实测脚本与结果一并归档在本仓库（便于复跑与回归）。
