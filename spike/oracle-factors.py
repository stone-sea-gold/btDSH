#!/usr/bin/env python3
"""
因子函数的**独立基准（oracle）**：用 qlib 自带的 Cython 实现 + pandas 语义算出真值。

为什么可信：AIFUND5 的因子就是 qlib 表达式，qlib 的 `Slope/Rsquare/Resi` 由
`qlib/data/_libs/rolling.pyx` 编译而来。这里直接调用同一份编译产物，
不是"照着我自己的 SQL 再写一遍"，因此能真正独立地校验 SQL 侧公式。

用法: oracle-factors.py <db> <out.json> [code ...]
"""
import json
import sqlite3
import sys

import numpy as np
import pandas as pd
from qlib.data._libs.rolling import rolling_slope, rolling_rsquare, rolling_resi

DB = sys.argv[1] if len(sys.argv) > 1 else "spike/out/p1-verify.db"
OUT = sys.argv[2] if len(sys.argv) > 2 else "spike/out/factor-oracle.json"
CODES = sys.argv[3:] or ["600519", "000001", "300750"]


def series_for(con, code, col):
    rows = con.execute(
        f"SELECT date, {col} FROM bars_adj WHERE code=? ORDER BY date", (code,)
    ).fetchall()
    dates = [r[0] for r in rows]
    vals = np.array([np.nan if r[1] is None else float(r[1]) for r in rows])
    return dates, vals


def slope(v, n):
    return rolling_slope(v, n)


def rsquare(v, n):
    # qlib: rolling_rsquare 后把 rolling.std() 近 0 的位置置 NaN
    out = np.asarray(rolling_rsquare(v, n), dtype=float)
    zero = np.asarray(np.isclose(pd.Series(v).rolling(n, min_periods=1).std(), 0, atol=2e-05))
    out[zero] = np.nan
    return out


def resi(v, n):
    return rolling_resi(v, n)


def idxmax(v, n):
    return pd.Series(v).rolling(n, min_periods=1).apply(lambda x: np.argmax(x) + 1, raw=True).values


def idxmin(v, n):
    return pd.Series(v).rolling(n, min_periods=1).apply(lambda x: np.argmin(x) + 1, raw=True).values


def quantile(v, n, q):
    return pd.Series(v).rolling(n, min_periods=1).quantile(q).values


def rank(v, n):
    return pd.Series(v).rolling(n, min_periods=1).rank(pct=True).values


def clean(a):
    return [None if (x is None or (isinstance(x, float) and (np.isnan(x) or np.isinf(x)))) else float(x) for x in a]


def main():
    con = sqlite3.connect(DB)
    out = {"source": DB, "codes": {}}
    for code in CODES:
        dates, close = series_for(con, code, "close")
        _, high = series_for(con, code, "high")
        _, low = series_for(con, code, "low")
        out["codes"][code] = {
            "dates": dates,
            "close": clean(close),
            "high": clean(high),
            "low": clean(low),
            "expect": {
                "Slope($close,5)": clean(slope(close, 5)),
                "Slope($close,20)": clean(slope(close, 20)),
                "Slope($close,60)": clean(slope(close, 60)),
                "Rsquare($close,5)": clean(rsquare(close, 5)),
                "Rsquare($close,20)": clean(rsquare(close, 20)),
                "Resi($close,5)": clean(resi(close, 5)),
                "Resi($close,20)": clean(resi(close, 20)),
                "IdxMax($high,5)": clean(idxmax(high, 5)),
                "IdxMax($high,20)": clean(idxmax(high, 20)),
                "IdxMax($high,60)": clean(idxmax(high, 60)),
                "IdxMin($low,5)": clean(idxmin(low, 5)),
                "IdxMin($low,20)": clean(idxmin(low, 20)),
                "IdxMin($low,60)": clean(idxmin(low, 60)),
                "Quantile($close,5,0.8)": clean(quantile(close, 5, 0.8)),
                "Quantile($close,20,0.2)": clean(quantile(close, 20, 0.2)),
                "Rank($close,5)": clean(rank(close, 5)),
                "Rank($close,20)": clean(rank(close, 20)),
            },
        }
        print(f"  {code}: {len(dates)} 行")
    with open(OUT, "w") as f:
        json.dump(out, f)
    print(f"→ {OUT}")


if __name__ == "__main__":
    main()
