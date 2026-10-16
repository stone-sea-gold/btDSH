#!/usr/bin/env python3
"""P1 独立验收 oracle —— 用交易所官方涨跌幅校验我们自算的复权收益。

为什么必须用 BaoStock：
  交易所官方「涨跌幅」是**复权口径**（P1 实测：600519 2020-06-24 官方 +0.1736%，
  不复权 -0.9827%，与 AIFUND5 文档逐位一致）。而东财 `pct` 字段是**不复权口径**，
  厂商的 qfq/hfq 序列又有 ±0.5%~1.6% 噪声，都无法作为复权基准。
  BaoStock 的 `pctChg` 与 `preclose`（除权参考价）是唯一干净、独立的官方口径来源。

本脚本是**开发期验收工具**，不属于插件运行时（插件保持零 Python 依赖）。

用法: python3 spike/oracle-baostock.py [db路径] [输出目录]
"""

import json
import sqlite3
import sys
import os
from collections import defaultdict

import baostock as bs

DB = sys.argv[1] if len(sys.argv) > 1 else 'spike/out/p1-verify.db'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'spike/out'


def to_bs_code(code: str) -> str:
    return ('sh.' if code.startswith(('6', '9')) else 'sz.') + code


def load_db(path):
    con = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    con.row_factory = sqlite3.Row
    bars = defaultdict(dict)
    for r in con.execute('SELECT code, date, close, pct FROM bars ORDER BY code, date'):
        bars[r['code']][r['date']] = {'close': r['close'], 'pct': r['pct']}
    events = defaultdict(list)
    for r in con.execute('SELECT code, date, factor FROM adj_events WHERE factor IS NOT NULL ORDER BY code, date'):
        events[r['code']].append({'date': r['date'], 'factor': r['factor']})
    con.close()
    return bars, events


def adjusted_returns(bars_for_code, events_for_code):
    """adj(t) = raw(t) × Π(factor where exDate ≤ t)；返回 {date: adj_return_pct}"""
    evs = sorted(events_for_code, key=lambda e: e['date'])
    dates = sorted(bars_for_code)
    out = {}
    cum = 1.0
    ei = 0
    prev_adj = None
    for d in dates:
        while ei < len(evs) and evs[ei]['date'] <= d:
            cum *= evs[ei]['factor']
            ei += 1
        close = bars_for_code[d]['close']
        if close is None:
            prev_adj = None
            continue
        adj = close * cum
        if prev_adj is not None and prev_adj != 0:
            out[d] = (adj / prev_adj - 1) * 100
        prev_adj = adj
    return out


def main():
    bars, events = load_db(DB)
    codes = sorted(bars)
    print(f'仓库：{len(codes)} 只股票，{sum(len(v) for v in bars.values())} 根 bar，'
          f'{sum(len(v) for v in events.values())} 个复权事件')

    lg = bs.login()
    if lg.error_code != '0':
        print('BaoStock 登录失败：', lg.error_msg)
        return 1

    report = {'db': DB, 'stocks': [], 'thresholds': {'warn_pp': 0.05, 'fail_pp': 0.20}}
    global_max = 0.0
    global_over = 0
    global_checked = 0
    exdate_rows = []

    for code in codes:
        bs_code = to_bs_code(code)
        ours = adjusted_returns(bars[code], events[code])
        if not ours:
            continue
        start = str(min(ours)).replace('-', '')
        start = f'{start[:4]}-{start[4:6]}-{start[6:8]}'
        end = str(max(ours))
        end = f'{end[:4]}-{end[4:6]}-{end[6:8]}'
        rs = bs.query_history_k_data_plus(
            bs_code, 'date,close,pctChg,preclose',
            start_date=start, end_date=end, frequency='d', adjustflag='3')
        official = {}
        while rs.error_code == '0' and rs.next():
            row = rs.get_row_data()
            d = int(row[0].replace('-', ''))
            try:
                official[d] = float(row[2]) if row[2] else None
            except ValueError:
                official[d] = None

        exdates = {e['date'] for e in events[code]}
        devs = []
        over = 0
        for d, our_ret in ours.items():
            off = official.get(d)
            if off is None:
                continue
            dev = abs(our_ret - off)
            devs.append((dev, d, our_ret, off))
            if dev > report['thresholds']['fail_pp']:
                over += 1
            if d in exdates:
                exdate_rows.append({'code': code, 'date': d, 'ours': round(our_ret, 6),
                                    'official': off, 'dev': round(dev, 6)})
        devs.sort(reverse=True)
        mx = devs[0][0] if devs else None
        if mx is not None:
            global_max = max(global_max, mx)
        global_over += over
        global_checked += len(devs)
        report['stocks'].append({
            'code': code, 'checked': len(devs), 'exdates': len(exdates),
            'maxDevPp': round(mx, 6) if mx is not None else None,
            'overFail': over,
            'worst': [{'date': d, 'ours': round(o, 6), 'official': v, 'dev': round(dv, 6)}
                      for dv, d, o, v in devs[:3]],
        })
        print(f"  {code}: 检查 {len(devs)} 天（除权日 {len(exdates)}）, 最大偏差 "
              f"{mx:.4f}pp, 超 {report['thresholds']['fail_pp']}pp 的有 {over}" if mx is not None
              else f'  {code}: 无可比数据')

    bs.logout()
    report['summary'] = {
        'stocks': len(report['stocks']),
        'daysChecked': global_checked,
        'maxDeviationPp': round(global_max, 6),
        'daysOverFailThreshold': global_over,
        'exDateComparisons': len(exdate_rows),
    }
    report['exDateWorst'] = sorted(exdate_rows, key=lambda x: -x['dev'])[:10]
    report['verdict'] = ('PASS' if global_max <= report['thresholds']['fail_pp'] and global_over == 0
                         else 'CHECK')

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, 'p1-oracle.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print('\n=== oracle 汇总 ===')
    print(json.dumps(report['summary'], ensure_ascii=False))
    print('除权日最差 5 例:')
    for r in report['exDateWorst'][:5]:
        print(f"  {r['code']} {r['date']}: 我们 {r['ours']}% vs 官方 {r['official']}% (偏差 {r['dev']}pp)")
    print('verdict:', report['verdict'], '->', path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
