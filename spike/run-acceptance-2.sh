#!/usr/bin/env bash
# P6 验收标准 2（行为对账）：与 AIFUND5/qlib 同参数对照的**复跑脚本**。
# 步骤来自 spike/GATE-FINDINGS.md 的"复现"一节，这里只是把它串起来并留日志。
set -uo pipefail
cd "$(dirname "$0")/.."
PY=/home/generalblack/code/works/AIFUND5/.venv/bin/python
OUT=spike/out
mkdir -p "$OUT"
fail=0
step() { echo; echo "──── $* ────"; }
run() { echo "\$ $*"; "$@" || { echo "  ❌ 上一步失败"; fail=1; }; }

step "Rung 0/1/3 前置：qlib 侧导出"
run "$PY" spike/gate-qlib.py dump --out "$OUT/gate-qlib-dump.json"
run "$PY" spike/gate-qlib.py factors --formulas-file "$OUT/gate-formulas.json" --out "$OUT/gate-qlib-factors.json"

step "我方回测 + 导出信号"
run node spike/gate-compare.mjs rung3 0 gate_mom20 3 3 daily

step "qlib executor 回测（对齐口径）"
run "$PY" spike/gate-qlib.py backtest --signal "$OUT/gate-signal.json" --topk 3 --n-drop 3 --preset aligned --out "$OUT/gate-rung3-aligned.json"

step "三层对账"
run node spike/gate-compare.mjs rung0
run node spike/gate-compare.mjs rung1
run node spike/gate-compare.mjs rung3cmp

echo
if [ $fail -eq 0 ]; then echo "✅ 验收标准 2 复跑完成（逐项结论见上面的输出与 GATE-FINDINGS.md）"; else echo "❌ 验收标准 2 复跑有步骤失败"; fi
exit $fail
