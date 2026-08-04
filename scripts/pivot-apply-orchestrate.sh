#!/usr/bin/env bash
# pivot-apply 物理批循环编排（Stage 3+4）
#
# 对每个物理批依次执行：freeze query manifest → 表级快照 → runner 写批 → 检索闸。
# 任一步失败：gate 失败自动 restore 快照后停；其他失败保留现场停。
# 必须在 supervisor 停写窗口内运行（runner 自带停写断言兜底）。
#
# 用法：bash scripts/pivot-apply-orchestrate.sh <allowlist-base> <batch-id-base> <p1> [p2 ...]
# 例：  bash scripts/pivot-apply-orchestrate.sh \
#         ~/pivot-distill-runs/20260803/apply/reviewed-allowlist-pref-r1 pref-r1 p1 p2 p3 p4
set -euo pipefail

BASE="$1"; BID_BASE="$2"; shift 2
APPLY_DIR="$HOME/pivot-distill-runs/20260803/apply"
SNAP_ROOT="$APPLY_DIR/snapshots"
LEDGER="$APPLY_DIR/ledger.jsonl"
S="$HOME/recallnest/scripts/pivot-apply-snapshot.sh"
cd "$HOME/recallnest"

# Jina key：写入要生成 embedding
set -a; source "$HOME/.config/recallnest/mcp.env"; set +a

mkdir -p "$SNAP_ROOT"
for P in "$@"; do
  BID="$BID_BASE-$P"
  ALLOW="$BASE-$P.jsonl"
  TS=$(date +%Y%m%d-%H%M%S)
  SNAP="$SNAP_ROOT/$BID-$TS"
  MANIFEST="$APPLY_DIR/query-manifest-$BID.json"
  [ -f "$ALLOW" ] || { echo "FATAL: allowlist missing: $ALLOW"; exit 1; }

  echo "=============================================="
  echo "== batch $BID ($(wc -l < "$ALLOW" | tr -d ' ') rows) =="
  echo "=============================================="

  echo "-- [1/4] freeze query manifest（写前基线）--"
  bun scripts/pivot-apply-query-gate.ts freeze "$ALLOW" "$BID" "$MANIFEST"

  echo "-- [2/4] snapshot --"
  bash "$S" snapshot "$SNAP"

  echo "-- [3/4] runner 写批 --"
  if ! bun scripts/pivot-apply-runner.ts "$ALLOW" "$BID" --ledger "$LEDGER"; then
    echo "RUNNER HALTED — restoring snapshot $SNAP"
    bash "$S" restore "$SNAP"
    echo "restored. Diagnose before retrying batch $BID. Stopping."
    exit 2
  fi

  echo "-- [4/4] query gate check --"
  if ! bun scripts/pivot-apply-query-gate.ts check "$MANIFEST" "$LEDGER" "$BID"; then
    echo "QUERY GATE FAILED — restoring snapshot $SNAP"
    bash "$S" restore "$SNAP"
    echo "restored. Diagnose before retrying batch $BID. Stopping."
    exit 3
  fi

  echo "== batch $BID COMMITTED (snapshot kept at $SNAP for the run duration) =="
done

echo "ALL BATCHES DONE"
