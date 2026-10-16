#!/usr/bin/env python3
"""离线因子表构建器（开发期，权威口径）。

为什么用 BaoStock：P1 实测发现**腾讯与东财的分红数据各自都不完整**
（300750 2024-04-30：东财只有 2.011、腾讯只有 3.017，交易所参考价反推真值 5.01）。
唯一可靠的做法是用交易所发布的**除权除息参考价**反推：

    每股现金 = 前收 − 参考价 × (1 + 送股 + 转增)

其中送股/转增来自分红表（这一部分两个源一致且可靠），现金由参考价确定。
参考价四舍五入到分带来的误差为 ±0.01×(1+送+转)，对收益率影响 < 0.01pp。

本脚本**不属于插件运行时**（插件保持零 Python 依赖）；它产出 `data/factor-events.json.gz`
随包分发，运行时只读该表。

用法: python3 spike/build-events-baostock.py [--out data] [--codes 600519,000001,...] [--from-year 2010]
"""

import argparse
import gzip
import json
import os
import sys
from collections import defaultdict

import baostock as bs

DEFAULT_CODES = [
    '600519', '000001', '300750', '603535', '600283', '600001',
    '601318', '000002', '002594', '688981', '300059', '600036',
    '601899', '000858', '002415',
]

SRC = {
    'reference-price': 5,      # 由交易所参考价反推（最权威）
    'dividend-table': 6,       # 参考价缺失时退化为分红表原值
}


def bs_code(code: str) -> str:
    return ('sh.' if code.startswith(('6', '9')) else 'sz.') + code


def fetch_daily(code: str, start: str, end: str):
    rs = bs.query_history_k_data_plus(
        bs_code(code), 'date,close,preclose',
        start_date=start, end_date=end, frequency='d', adjustflag='3')
    out = []
    while rs.error_code == '0' and rs.next():
        d, close, pre = rs.get_row_data()
        try:
            out.append((int(d.replace('-', '')), float(close), float(pre) if pre else None))
        except ValueError:
            continue
    return out


def fetch_dividends(code: str, from_year: int, to_year: int):
    rows = []
    for year in range(from_year, to_year + 1):
        for yt in ('operate', 'report'):
            rs = bs.query_dividend_data(code=bs_code(code), year=str(year), yearType=yt)
            while rs.error_code == '0' and rs.next():
                d = dict(zip(rs.fields, rs.get_row_data()))
                if not d.get('dividOperateDate'):
                    continue
                rows.append(d)
    # 去重（operate/report 两种查询会重复返回同一条）
    seen = {}
    for d in rows:
        key = (d['dividOperateDate'], d.get('dividCashPsBeforeTax'), d.get('dividStocksPs'), d.get('dividReserveToStockPs'))
        seen[key] = d
    return list(seen.values())


def build_for_code(code: str, from_year: int, to_year: int):
    daily = fetch_daily(code, f'{from_year}-01-01', '2026-12-31')
    if not daily:
        return [], {'code': code, 'reason': 'no-daily'}
    by_date = {d: (c, p) for d, c, p in daily}
    dates = [d for d, _, _ in daily]

    events = []
    issues = []
    for row in fetch_dividends(code, from_year, to_year):
        try:
            ex = int(str(row['dividOperateDate']).replace('-', ''))
            bonus = float(row.get('dividStocksPs') or 0)
            transfer = float(row.get('dividReserveToStockPs') or 0)
            table_cash = float(row.get('dividCashPsBeforeTax') or 0)
        except (TypeError, ValueError):
            continue
        if ex not in by_date:
            issues.append({'exDate': ex, 'reason': 'ex-date-not-trading-day'})
            continue
        close_ex, preclose = by_date[ex]
        # 除权日前一交易日收盘
        prev = None
        for d in dates:
            if d < ex:
                prev = by_date[d][0]
            else:
                break
        if prev is None or preclose is None:
            issues.append({'exDate': ex, 'reason': 'missing-prev-or-preclose'})
            continue
        denom = 1 + bonus + transfer
        derived_cash = prev - preclose * denom
        # 合理性检查：现金不能为负、不能超过前收；与分红表差异过大时记录
        if derived_cash < -0.05 or derived_cash > prev:
            issues.append({'exDate': ex, 'reason': 'implausible-cash', 'derived': round(derived_cash, 4), 'table': table_cash})
            cash, source = table_cash, 'dividend-table'
        else:
            cash, source = max(0.0, round(derived_cash, 4)), 'reference-price'
            if abs(cash - table_cash) > 0.02:
                issues.append({'exDate': ex, 'note': 'cash-differs-from-table', 'derived': round(cash, 4), 'table': table_cash})
        events.append({
            'code': code, 'exDate': ex,
            'cashPerShare': round(cash, 6),
            'bonusPerShare': round(bonus, 6),
            'transferPerShare': round(transfer, 6),
            'source': source,
            'tableCash': round(table_cash, 4),
            'prevClose': prev, 'preclose': preclose,
        })
    return events, {'code': code, 'events': len(events), 'issues': issues}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='data')
    ap.add_argument('--codes', default='')
    ap.add_argument('--from-year', type=int, default=2010)
    ap.add_argument('--to-year', type=int, default=2026)
    args = ap.parse_args()

    codes = [c.strip() for c in args.codes.split(',') if c.strip()] or DEFAULT_CODES

    lg = bs.login()
    if lg.error_code != '0':
        print('BaoStock 登录失败：', lg.error_msg)
        return 1

    all_events, reports = [], []
    for i, code in enumerate(codes, 1):
        evs, rep = build_for_code(code, args.from_year, args.to_year)
        all_events.extend(evs)
        reports.append(rep)
        print(f'  [{i}/{len(codes)}] {code}: {len(evs)} 事件'
              + (f'，{len(rep["issues"])} 处需注意' if rep.get('issues') else ''))
    bs.logout()

    all_events.sort(key=lambda e: (e['code'], e['exDate']))
    packed = [[e['code'], e['exDate'], e['cashPerShare'], e['bonusPerShare'], e['transferPerShare'],
               SRC.get(e['source'], 9)] for e in all_events]
    payload = {
        'version': 1,
        'generatedAt': __import__('datetime').datetime.utcnow().isoformat() + 'Z',
        'convention': 'cash/bonus/transfer 均为每股口径；运行时 factor = 前收 / round((前收-现金)/(1+送+转),2)',
        'sourceCodes': SRC,
        'provenance': {
            'builder': 'spike/build-events-baostock.py',
            'authority': 'BaoStock 交易所除权除息参考价（preclose）反推每股现金',
            'note': '参考价四舍五入到分，误差 ±0.01×(1+送+转)',
        },
        'events': packed,
    }
    os.makedirs(args.out, exist_ok=True)
    with gzip.open(os.path.join(args.out, 'factor-events.json.gz'), 'wt', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    meta = {
        'generatedAt': payload['generatedAt'],
        'counts': {
            'total': len(all_events),
            'stocks': len({e['code'] for e in all_events}),
            'bySource': {s: sum(1 for e in all_events if e['source'] == s) for s in {e['source'] for e in all_events}},
        },
        'codes': codes,
        'provenance': payload['provenance'],
        'issues': [r for r in reports if r.get('issues')],
    }
    with open(os.path.join(args.out, 'factor-events.meta.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print('\n=== 产出 ===')
    print(json.dumps(meta['counts'], ensure_ascii=False))
    size = os.path.getsize(os.path.join(args.out, 'factor-events.json.gz'))
    print(f'factor-events.json.gz: {size/1024:.1f} KB')
    diff = [i for r in reports for i in r.get('issues', []) if i.get('note') == 'cash-differs-from-table']
    if diff:
        print(f'与分红表不一致（说明分红表漏记，已按参考价修正）：{len(diff)} 处，示例：')
        for d in diff[:5]:
            print('   ', d)
    return 0


if __name__ == '__main__':
    sys.exit(main())
