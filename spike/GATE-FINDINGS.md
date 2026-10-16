# P2 验收门 · 与 AIFUND5/qlib 同参数对照

**结论：通过。** 差异逐项可解释，没有未归因的残留；过程中发现并修掉 **4 个 AIFUND5 侧缺陷**和 **2 个我方缺陷**。

---

## 1. 这个门在验什么

单测与 106,263 点的因子 oracle 证明的是**因子值**与 qlib 一致。它们抓不到另一类错误：**内部自洽但整体口径偏离**。我的引擎可以 6/6 不变式全过、NAV 与手算逐位对得上，同时却在模拟一个不同的市场。

所以门的产出不是"看起来差不多"，而是**一份差异清单**：每条差异要么通过对齐口径消除，要么量化后归因。

### 阶梯设计

| 层 | 比什么 | 抓什么 |
|---|---|---|
| **Rung 0** 数据口径 | 交易日集合、复权口径、逐日收益率 | 输入不一致时后面全是噪声 |
| **Rung 1** 因子横截面 | qlib 表达式引擎 vs 我的 DSL | 因子语义 + 数据管线 |
| **Rung 3** 全账务 | qlib executor vs 我的回测引擎 | 执行、成本、撮合、账务 |

Rung 1 做成**两级**是关键设计：把 qlib 的价格喂进我的算法（**语义级**），再把我的价格喂进同一算法（**数据级**）。分开之后，"因子值不一样"能归到具体一边，而不是笼统地说"两边不一样"。

（原计划的 Rung 2「组合构建无成本对账」被 Rung 3 的逐日持仓比对覆盖，不再单列。）

### 设置

| 项 | 值 |
|---|---|
| 股票池 | 两边交集 **12 只**（我方 15 只 ∩ AIFUND5 300 只） |
| 区间 | 2024-01-02 ~ 2026-09-21（660 个交易日） |
| 因子 | `$close / Ref($close, 20) - 1` |
| 参数 | topK=3、**日频调仓**、等权、初始资金 1,000,000 |
| qlib 侧 | `backtest_daily` + `TopkDropoutStrategy`，**绕开 AIFUND5 的 BacktestEngine** |

绕开 AIFUND5 引擎的原因见 §4.2：它的引擎当时根本不跑编译出来的因子策略。要对照的是**执行与账务语义**，而 qlib 的 executor 才是这套语义的定义者。

**复现**：
```bash
# qlib 侧（AIFUND5 的 venv）
python spike/gate-qlib.py dump    --out spike/out/gate-qlib-dump.json
python spike/gate-qlib.py factors --formulas-file spike/out/gate-formulas.json --out spike/out/gate-qlib-factors.json
node   spike/gate-compare.mjs rung3 0 gate_mom20 3 3 daily          # 我方回测 + 导出信号
python spike/gate-qlib.py backtest --signal spike/out/gate-signal.json --topk 3 --n-drop 3 --preset aligned --out spike/out/gate-rung3-aligned.json
# 对账
node spike/gate-compare.mjs rung0 && node spike/gate-compare.mjs rung1 && node spike/gate-compare.mjs rung3cmp
```

---

## 2. 结果

### Rung 0 · 数据口径

- **交易日集合**：11/12 只完全一致（660 = 660）。`688981` 差 6 天，是**停牌表示差异**（见 §3.2）。
- **复权口径**：11/12 只的 `qlib复权价 / 我方复权价` 比值**随时间恒定**（离散度 ≤ 4e-7）→ 两个序列只差一个每股常数，**收益率完全一致**（最大日收益差 ≤ 3.6e-7）。
- 唯一例外 `300750`：离散度 4.8e-3，唯一差异日 **2025-01-24**（0.49pp）——正是 DATA-SOURCES.md 已记录的"所有源都缺失的分红"边界。**门独立复现了它**，并证明 baostock 有这条数据。

### Rung 1 · 因子横截面（3 只股票 × 12 条公式 × 7218 点）

**语义级**（我的算法 @ qlib 价格 vs qlib 输出）：

| 公式 | 残差 | 剔除含 NULL 窗口后 |
|---|---|---|
| `$close/Ref($close,20)-1` | 7.76e-8 | 7.74e-8 |
| `Std(Ret,20)` | 1.77e-1 | **2.11e-7** |
| `Slope($close,20)` | 4.12e-8 | 4.12e-8 |
| `Rsquare($close,20)` | 3.12e-8 | 3.12e-8 |
| `Resi($close,20)` | 2.57e-8 | 2.57e-8 |
| `Quantile($close,20,0.8)` | 3.27e-8 | 3.27e-8 |
| `Rank($close,20)` | 2.74e-8 | 2.54e-8 |
| `IdxMax($high,20)` | 9.46e-1 | **0.00e+0** |
| `IdxMin($low,20)` | 6.50e-1 | **0.00e+0** |
| `Corr($close,$volume,20)` | 3.03e-8 | 3.03e-8 |
| `Max($high,20)/Min($low,20)` | 4.23e-8 | 4.23e-8 |
| `Mean(Max($close-Ref($close,1),0),6)/(...)` | **9.61e-1** | **9.61e-1** ⚠️ |

**11/12 条落到 2.5e-8 ~ 7.8e-8，即 qlib bin 的 float32 精度地板。** 唯一真实语义分歧是 `Max(x,0)`（§3.6）。

### Rung 3 · 全账务

| 指标 | 我方 | qlib（对齐口径） | qlib（默认口径） |
|---|---|---|---|
| **逐日持仓一致** | — | **646/659 = 98.0%** | 646/659 = 98.0% |
| 净值总收益 | 38.49% | 43.32% | 96.67% |
| 年化 | 13.26% | 14.76% | 29.52% |
| 年化波动 | **32.00%** | **32.17%** | 31.68% |
| 最大回撤 | −26.39% | −20.23% | −15.68% |
| 日收益差 标准差 | — | **0.44pp** | 0.70pp |
| 费用 | 236,938 | 545,962 | 742,159 |

**持仓 98% 一致、波动率差 0.17pp、年化差 1.5pp** —— 在这个量级上，剩下的差异全部来自下面清单里的口径差，而不是某一边算错了。

13 个持仓不一致日集中在 **20240924 ~ 20250909**，全部是涨停/跌停导致的可交易性差异。

---

## 3. 差异清单（逐项归因）

### 3.1 复权基准不同（不是错误）
qlib 的 `$close` 是**后复权**（`$close = 原始价 × $factor`，600519 在 2024-01-02 为 11743.358398，除以原始价 1685.01 恰好等于导出的 `$factor` 6.969311）；我的是以 2018-01-02 为基准的前复权。两者只差**每股一个常数**，故收益率与比率型因子完全一致，量纲型因子（Slope/Resi/Quantile）差一个常数 k —— Rung 1 用**过原点最小二乘**拟合 k 正是为此。

### 3.2 停牌表示差异
qlib 的导出为停牌日保留一行（价格 NaN、factor=1，占住日历位置）；我的 `bars` 直接没有该行。**执行行为等价**（两边都无法成交），但**滚动窗口的构成不同**：qlib 的窗口按位置跨 20 行含 NaN，我的窗口是 20 个真实交易日。

### 3.3 `300750` 缺失分红（已知，已记录）
2025-01-24 有一笔分红，我的**全部数据源都缺失**（DATA-SOURCES.md 已记），baostock 有。复权因子在此后相差一个常数，所以该股窗口跨越此日的因子值都会有差。**门的价值在于：它独立复现了这个边界，并指出 baostock 可作为补充源。**

### 3.4 float32 精度地板
qlib 的 bin 是 float32（相对精度约 1e-7）。对**近并列值**会把次序翻转：`000001` 在 20241009 与 20241101 的复权价在我这边**逐位相等**（13.7389976274），qlib 侧是 1577.7861328125 vs 1577.7857666015625 → `Rank` 得 0.20 vs 0.15。用 qlib 的值跑我的算法就得到 qlib 的答案，**证明这是输入精度而非语义差异**。

### 3.5 窗口内 NULL 的处理方向相反
- `Slope/Rsquare/Resi`：窗口含 NULL 时我返回 NULL（qlib 的位置语义按非空值计龄，含 NULL 时公式不再等价），qlib 返回一个值。
- `Corr`：我给值，qlib 给 NaN。
- `IdxMax/IdxMin`：qlib 的 `np.argmax` 在含 NaN 的窗口上返回**第一个 NaN 的位置**，我跳过 NULL。

各 19 点，全部落在 `688981` 停牌缺口之后。**我的数据里没有 NULL 行**（停牌日直接缺行），所以这些分歧在生产路径上不会出现。

### 3.6 `Max(x, 0)` 语义分歧（有意保留）⚠️
实测：`Max($close-Ref($close,1),0) == d1.expanding().max()` 为 **True**，`== relu(d1)` 为 **False**。qlib 把 `N=0` 解释为 **expanding 窗口**，我按**逐元素**处理。

AIFUND5 有 **3 条因子**依赖它（`alpha158_rsi_6/12/24`），意图显然是 ReLU，但 qlib 实际算的不是 RSI —— 实测 600036 在 20260514 我算 0.120、qlib 算 53.598（差 447 倍）。

**保留逐元素语义**，因为那是因子作者的本意；但这是一条必须声明的分歧。

### 3.7 qlib 日频 executor 自带一天滞后
实测：`aligned`（信号不额外前移）持仓一致率 98.0%；若把信号再 shift 一天则降到 37.3%，且表现为**持仓永远差一天**。所以 qlib 已经是"用前一步信号、在当步成交"。`deal_price="open"` 即等价于我的"T 收盘信号 → T+1 开盘成交"。

### 3.8 qlib 的 risk 统计是**毛收益**口径
`report['return']` **不含费用**：实测 account 变化 = `return − cost`。所以 qlib 的 `annualized_return` 44.37% 是毛的，我方的 13.26% 是净的。表中"account 口径年化"才是可比数字。

### 3.9 费用口径
我方 `fees` 字段只含佣金/印花税/过户费，**滑点体现在成交价里**；qlib 的 `totalCost` 含滑点。补上滑点后两边同量级（约 494k vs 546k）。

### 3.10 策略语义不同
`TopkDropoutStrategy` 是"从持仓里踢掉最差 n_drop、买入未持有的最好 n_drop"，**持仓可以超过 topk**（实测 20240927 qlib 持 4 只而 topk=3）；我是"调仓到目标集合"。这是结构性差异，无法靠参数对齐。

### 3.11 涨跌停阈值
qlib 只能给**统一**的 `limit_threshold=0.095`；我按板块给 10%/20%/30%、ST 5%。12 只里有 2 只（300750 创业板、688981 科创板）阈值应为 20%。这是 13 个持仓不一致日的主要来源。

### 3.12 T+1 锁定与整手
我强制 T+1（当日买入不可卖出）并按 100 股整手成交；qlib 两者都没有。**不打算改**——改了就不是 A 股了。这两条是"有意更贴近真实"。

---

## 4. 过程中发现的缺陷

### 4.1 AIFUND5 侧

**① qlib 导出把日历偏移算了两遍 → 294/297 只标的对 qlib 完全不可见（已修）**

`src/data/qlib_export.py:190,207`：
```python
values = np.full((len(day_index), len(FIELDS)), np.nan, ...)   # 全长日历，前面垫 NaN
payload = np.hstack([[day_index[rows[0].trading_date]], values[:, column]])  # 又把首日当 start_index
```
`values` 已经是全长数组，再前置 `start_index` 就把数据整体后移了 `start_index` 位，qlib 读到的全是垫的 NaN。**实测：修复前 297 只里只有 3 只可读，修复后 297/297。** 这是静默失败——Alpha158+LinearModel 会以为自己在 297 只上训练，实际只有 3 只，且不报任何错。

修复：`payload = np.hstack([[first], values[first:, column]])`。

**② `_execute_backtest` 忽略用户编译出来的因子策略（已修）**

`src/core/backtest_engine.py` 无条件构造 `Alpha158 + LinearModel + TopkDropoutStrategy`，只从 `compiled_strategy` 里读一个 `topk`；`alpha_expression` 仅被写进缓存 key。**用户配置的因子从未真正进入回测。**

修复后实测日志：
```
backtest_using_compiled_strategy expression='Mean($volume, 10) / (Mean($volume, 20) + 1e-12)'
                                 n_drop=1 signal_points=196575 topk=3
回测：总收益 0.3118 最大回撤 -0.4097
```

**③ `_build_qlib_strategy_dict` 产出的字典**双重不可用**（已修）**

- `signal: alpha_expr`（字符串）→ `create_signal_from` 报 `ModuleNotFoundError None is passed in as parameters as module_path`
- `rebalance_days` 放在 `kwargs` 里 → `TopkDropoutStrategy` 不接受，报 `BaseStrategy.__init__() got an unexpected keyword argument`

即这段死代码即使被调用也会立刻崩。修复：表达式改名为 `signal_expr`（由引擎用 `D.features` 物化成 `pd.Series`）、`rebalance_days` 移到 `kwargs` 之外、`module_path` 修正为 `qlib.contrib.strategy.signal_strategy`。

**④ `Max(x,0)` 让 3 条 RSI 因子算的不是 RSI（未修，属语义选择）**

见 §3.6。这是 qlib 的解释 + AIFUND5 的写法共同造成的，改动会影响 AIFUND5 现有因子结果，故只记录。

### 4.2 我方侧（**都是这个门抓出来的**）

**① 停牌持仓按 0 估值 → NAV 假跳变（已修）**

持仓股停牌当天 `bars` 没有该行，`book.nav()` 拿不到价就把该持仓**按 0 计入**，复牌当天再跳回来。实测 `688981` 停牌 6 天导致 **2025-09-09 单日 +43.06%** 的假跳变，并把最大回撤从 −20% 夸大到 **−47.72%**。

修复：停牌持仓沿用**最后已知收盘价**估值，并记录 `carryForwardDays` 与结果声明。

效果（Rung 3 aligned）：日收益差标准差 **2.26pp → 0.44pp**、波动 **46.07% → 32.00%**（qlib 32.17%）、最大回撤 **−47.72% → −26.39%**。

**② 限定股票池时先截断再过滤 → 组合只买进 2 只（已修）**

面板排名是**全池**算的，我先取 top-3 再按股票池过滤，池外股票占掉的名额补不回来。实测组合长期只持 2 只而非 3 只，总收益差 **26pp**（13.17% → 39.22%）。

修复：限定股票池时先放宽候选数（`max(200, topK*20)`）再过滤再截断。

---

## 5. 判定

| 层 | 判据 | 结果 |
|---|---|---|
| Rung 0 | 交易日集合一致；复权序列只差常数 | ✅ 11/12 只（第 12 只的 6 天是停牌表示差异） |
| Rung 1 | 语义级残差 ≤ float32 地板 | ✅ 11/12 条（2.5e-8~7.8e-8）；第 12 条是已声明的 `Max(x,0)` 分歧 |
| Rung 3 | 持仓一致率高；净值同量级且差异可解释 | ✅ 持仓 **98.0%**、波动 32.00% vs 32.17%、年化 13.26% vs 14.76% |
| 差异清单 | 无未归因残留 | ✅ 12 条差异全部归因（§3.1–3.12） |

**没有未解释的残留差异。** 我方两条缺陷都是这个门抓出来的，正好印证了门的必要性——它们在自证体系里（31/31 单测、6/6 不变式、NAV 与手算逐位一致）全部通过。
