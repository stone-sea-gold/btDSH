#!/usr/bin/env python3
"""
验收门 · qlib 侧。

三个模式对应阶梯的三层：

  dump       Rung 0：导出原始价 / qlib 复权价 / 复权因子，用于判定两边的复权口径
  factors    Rung 1：用 qlib 自己的表达式引擎算因子，导出 (code, date, value)
  backtest   Rung 3：用 qlib 的 executor 跑**单因子信号**的 TopkDropoutStrategy

为什么 backtest 绕开 AIFUND5 的 BacktestEngine：
  `src/core/backtest_engine.py::_execute_backtest` 硬编码了 Alpha158 + LinearModel，
  只从 compiled_strategy 里读一个 `topk`，用户编译出来的 `alpha_expression` 根本没进回测。
  本门要对照的是**执行与账务语义**，而 qlib 的 executor 才是这套语义的定义者，
  所以直接用 `backtest_daily` + `TopkDropoutStrategy(signal=<单因子>)`。
  （AIFUND5 侧那个缺陷单独记录，不在本脚本里修。）

用法:
  gate-qlib.py dump     --out X.json
  gate-qlib.py factors  --formulas 'A,B' --out X.json
  gate-qlib.py backtest --signal S.json --topk 3 --preset qlib|aligned --out X.json
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
AIFUND = Path("/home/generalblack/code/works/AIFUND5")
QLIB_URI = AIFUND / "data" / "market" / "qlib"

# 两边股票池的交集（我方 spike/out/p1-verify.db 15 只 ∩ AIFUND5 导出 300 只）
CODES = ["000001", "000002", "000858", "002415", "002594", "300059",
         "300750", "600036", "600519", "601318", "601899", "688981"]
START, END = "2024-01-02", "2026-09-21"


def to_qlib(code: str) -> str:
    return ("SH" if code[0] in "69" else "SZ") + code


def init():
    import qlib
    qlib.init(provider_uri=str(QLIB_URI), region="cn")
    from qlib.data import D
    return D


# ── Rung 0 ──────────────────────────────────────────────────────────────────
def cmd_dump(args):
    D = init()
    insts = [to_qlib(c) for c in CODES]
    df = D.features(insts, ["$close", "$factor", "$open", "$high", "$low", "$volume"],
                    start_time=args.start, end_time=args.end)
    df = df.reset_index()
    # `$close` 不是合法标识符，itertuples 取不到 → 先改成安全列名
    df.columns = [c.replace("$", "") for c in df.columns]
    df["code"] = df["instrument"].str[2:]
    df["date"] = df["datetime"].dt.strftime("%Y%m%d").astype(int)
    out = {
        "source": "qlib",
        "provider_uri": str(QLIB_URI),
        "codes": CODES,
        "range": [int(args.start.replace("-", "")), int(args.end.replace("-", ""))],
        "rows": [
            {"code": r.code, "date": int(r.date),
             "close": None if pd.isna(r.close) else float(r.close),
             "factor": None if pd.isna(r.factor) else float(r.factor),
             "open": None if pd.isna(r.open) else float(r.open),
             "high": None if pd.isna(r.high) else float(r.high),
             "low": None if pd.isna(r.low) else float(r.low),
             "volume": None if pd.isna(r.volume) else float(r.volume)}
            for r in df.itertuples()
        ],
    }
    Path(args.out).write_text(json.dumps(out))
    print(f"dump: {len(out['rows'])} 行 → {args.out}")


# ── Rung 1 ──────────────────────────────────────────────────────────────────
def cmd_factors(args):
    D = init()
    # 从文件读公式：shell 会把 `$close` 当变量展开掉，命令行传参不可靠
    src = Path(args.formulas_file) if args.formulas_file else None
    if src:
        raw = json.loads(src.read_text())
        formulas = raw["formulas"] if isinstance(raw, dict) else raw
    else:
        formulas = [f.strip() for f in args.formulas.split(",") if f.strip()]
    insts = [to_qlib(c) for c in CODES]
    df = D.features(insts, formulas, start_time=args.start, end_time=args.end)
    df = df.reset_index()
    # 不按列名取：qlib 返回的列名就是公式原文，做任何替换都可能撞车 → 按位置取
    codes = df["instrument"].str[2:].tolist()
    dates = df["datetime"].dt.strftime("%Y%m%d").astype(int).tolist()
    rows = []
    for i, f in enumerate(formulas):
        vals = df.iloc[:, 2 + i].tolist()
        for code, date, v in zip(codes, dates, vals):
            rows.append({"code": code, "date": int(date), "formula": f,
                         "value": None if v is None or (isinstance(v, float) and (np.isnan(v) or np.isinf(v))) else float(v)})
    Path(args.out).write_text(json.dumps({"source": "qlib", "formulas": formulas, "rows": rows}))
    print(f"factors: {len(formulas)} 条 × {len(rows)//max(1,len(formulas))} 点 → {args.out}")


# ── Rung 3 ──────────────────────────────────────────────────────────────────
# 3a：qlib 自然配置（决策日收盘成交、统一 9.5% 涨跌停、qlib 默认费用）
PRESET_QLIB = {
    "exchange_kwargs": {"deal_price": "close", "limit_threshold": 0.095,
                        "open_cost": 0.0015, "close_cost": 0.0025, "min_cost": 5.0},
    "shift_signal": False,
    "label": "qlib 默认口径",
}
# 3b：把我方的口径搬进 qlib 的 executor，看能收敛到什么程度
#   买入 = 佣金 0.00025 + 过户费 0.00001 + 滑点 0.001
#   卖出 = 佣金 0.00025 + 印花税 0.001 + 过户费 0.00001 + 滑点 0.001
#   信号前移一天 + 开盘成交 = 我方的"T 收盘信号 → T+1 开盘成交"
PRESET_ALIGNED = {
    "exchange_kwargs": {"deal_price": "open", "limit_threshold": 0.095,
                        "open_cost": 0.00126, "close_cost": 0.00226, "min_cost": 5.0},
    # **不 shift**：qlib 的日频 executor 本身就有"用前一步信号、在当步成交"的滞后，
    # 再 shift 一次会变成双重滞后（实测持仓永远差一天）。deal_price="open" 即
    # "T 收盘信号 → T+1 开盘成交"，与我方口径一致。
    "shift_signal": False,
    "label": "对齐我方费用与成交时点（信号不额外前移）",
}
# 诊断用：故意多移一天，用来证明 qlib 自带滞后
PRESET_DOUBLE_SHIFT = {
    "exchange_kwargs": {"deal_price": "open", "limit_threshold": 0.095,
                        "open_cost": 0.00126, "close_cost": 0.00226, "min_cost": 5.0},
    "shift_signal": True,
    "label": "诊断：信号额外前移一天（应表现为持仓差一天）",
}


def _extract_holdings(positions):
    """逐日持仓（只保留有股数的标的）。

    `Position.position` 是 dict：除 'cash' / 'now_account_value' 外的键才是标的，
    值形如 {'amount': 股数, 'price': ..., 'weight': ..., 'count_day': ...}。
    """
    if not positions:
        return []
    out = []
    for d, pos in positions.items():
        codes = []
        for key, val in (getattr(pos, "position", None) or {}).items():
            if key in ("cash", "now_account_value"):
                continue
            amount = val.get("amount") if isinstance(val, dict) else None
            if amount and float(amount) > 0:
                codes.append(key)
        out.append({"date": int(str(d)[:10].replace("-", "")), "codes": sorted(codes)})
    return out


def cmd_backtest(args):
    from qlib.contrib.evaluate import backtest_daily, risk_analysis
    from qlib.contrib.strategy.signal_strategy import TopkDropoutStrategy
    init()

    preset = {"aligned": PRESET_ALIGNED, "double": PRESET_DOUBLE_SHIFT}.get(args.preset, PRESET_QLIB)
    sig = json.loads(Path(args.signal).read_text())
    # 两个必须踩对的点，踩错都是"静默不交易"（实测总收益恒 0.00%、无任何报错）：
    #   1) 日期必须转成真正的 Timestamp：`pd.Timestamp(20240102)` 会把整数当**纳秒**，
    #      得到 1970-01-01，策略按 2024 年取信号时取到 None
    #   2) 信号必须裁到**两边的交集股票池**：我的面板里有 AIFUND5 池外的股票
    #      （600001/600283/603535），策略会优先选它们却永远成交不了
    universe = set(CODES)
    s = pd.Series(
        {(pd.Timestamp(str(r["date"])), to_qlib(r["code"])): r["value"]
         for r in sig["rows"] if r["code"] in universe},
        dtype=float,
    )
    s.index.names = ["datetime", "instrument"]
    s = s.sort_index()
    if preset["shift_signal"]:
        # 每个标的按时间前移一位：T 日的信号在 T+1 被执行
        s = s.groupby(level="instrument", group_keys=False).shift(1).dropna()

    strategy = {
        "class": "TopkDropoutStrategy",
        "module_path": "qlib.contrib.strategy.signal_strategy",
        "kwargs": {"signal": s, "topk": args.topk, "n_drop": args.n_drop,
                   "hold_thresh": args.hold_thresh},
    }
    # qlib 的循环会解析 end+1，导出恰好结束在最后一个交易日时 IndexError。
    # AIFUND5 的 BacktestEngine 也踩过同一个坑并退一个交易日，这里照做。
    from qlib.data import D as _D
    bt_end = args.end
    cal_tail = _D.calendar(start_time=args.start, end_time=args.end)
    if len(cal_tail) >= 2 and str(cal_tail[-1])[:10] == args.end:
        bt_end = str(cal_tail[-2])[:10]

    report, positions = backtest_daily(
        start_time=args.start, end_time=bt_end, strategy=strategy,
        account=args.cash, benchmark="SH000300", exchange_kwargs=preset["exchange_kwargs"],
    )
    # 必须只传 'return' 这一列：传整个 DataFrame 会得到 MultiIndex 的按列分析，
    # 取值时会静默拿到 Series 而不是标量（实测 annualized_return 变成 2.38e8）
    risk = risk_analysis(report["return"])
    nav = report["account"] if "account" in report.columns else report.iloc[:, 0]
    ret = report["return"] if "return" in report.columns else None
    out = {
        "source": "qlib", "preset": args.preset, "preset_label": preset["label"],
        "topk": args.topk, "n_drop": args.n_drop, "cash": args.cash,
        "exchange_kwargs": preset["exchange_kwargs"], "shift_signal": preset["shift_signal"],
        "range": [str(report.index[0])[:10], str(report.index[-1])[:10]],
        "days": int(len(report)),
        "nav": [{"date": int(str(d)[:10].replace("-", "")), "nav": float(v)} for d, v in nav.items()],
        "cost": None if "cost" not in report.columns else float(report["cost"].sum()),
        "totalCost": None if "total_cost" not in report.columns else float(report["total_cost"].iloc[-1]),
        "turnover": None if "turnover" not in report.columns else float(report["turnover"].sum()),
        "totalTurnover": None if "total_turnover" not in report.columns else float(report["total_turnover"].iloc[-1]),
        "benchTotalReturn": None if "bench" not in report.columns else float(report["bench"].iloc[-1]),
        "risk": {k: (None if v is None or (isinstance(v, float) and np.isnan(v)) else float(v))
                 for k, v in risk["risk"].items()},
        "total_return": float(nav.iloc[-1] / nav.iloc[0] - 1),
        "holdings": _extract_holdings(positions),
    }
    Path(args.out).write_text(json.dumps(out))
    print(f"backtest[{args.preset}]: {out['days']} 天, 总收益 {out['total_return']*100:.2f}%, "
          f"年化 {out['risk'].get('annualized_return', 0)*100:.2f}% → {args.out}")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="mode", required=True)

    d = sub.add_parser("dump"); d.add_argument("--out", required=True)
    d.add_argument("--start", default=START); d.add_argument("--end", default=END)
    d.set_defaults(fn=cmd_dump)

    f = sub.add_parser("factors"); f.add_argument("--formulas", default="")
    f.add_argument("--formulas-file", dest="formulas_file", default=None)
    f.add_argument("--out", required=True)
    f.add_argument("--start", default=START); f.add_argument("--end", default=END)
    f.set_defaults(fn=cmd_factors)

    b = sub.add_parser("backtest"); b.add_argument("--signal", required=True)
    b.add_argument("--topk", type=int, default=3); b.add_argument("--n-drop", type=int, default=3)
    b.add_argument("--hold-thresh", type=int, default=1)
    b.add_argument("--preset", choices=["qlib", "aligned", "double"], default="qlib")
    b.add_argument("--cash", type=float, default=1_000_000)
    b.add_argument("--out", required=True)
    b.add_argument("--start", default=START); b.add_argument("--end", default=END)
    b.set_defaults(fn=cmd_backtest)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
