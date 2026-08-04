#!/usr/bin/env bash
# pivot-apply 表级快照 / 还原 / 校验
#
# 用法：
#   snapshot.sh snapshot <snapshot-dir>          在 <snapshot-dir> 下建一份快照
#   snapshot.sh restore  <snapshot-dir>          从快照整体还原（先备份当前态到 <snapshot-dir>.pre-restore-<ts>）
#   snapshot.sh verify   <snapshot-dir>          校验当前库与快照 manifest 一致（行数 + 文件清单）
#
# 快照范围（apply plan v2 Stage 0 定义的完整一致性边界）：
#   1. LanceDB 数据目录真身（~/Projects/recallnest/data/lancedb —— 19G，APFS clonefile 零拷贝）
#   2. 活跃 activity-stats.json（~/recallnest/data/activity-stats.json，dbPath symlink 所在目录）
#   3. conflict-candidates 目录（~/recallnest/data/conflict-candidates）
#
# 硬约束：
#   - 必须在停写维护窗口内执行（supervisor 包裹），脚本自带 torn-snapshot 防线：
#     快照前后各读一次 memories 行数与文件清单，不一致即 fail（证明拷贝期间有写入）
#   - 同卷 APFS 才能 clonefile；跨卷直接 fail（不静默退化成全量拷贝——磁盘只剩 ~13G）
#   - audit.jsonl 不入快照也不被还原（append-only 审计不可抹）
set -euo pipefail

# 默认指向生产；副本演练用环境变量覆盖三条路径（还原实测在副本上做，绝不拿生产练手）
LANCEDB_PHYS="${PIVOT_SNAPSHOT_LANCEDB:-$HOME/Projects/recallnest/data/lancedb}"
STATS_FILE="${PIVOT_SNAPSHOT_STATS:-$HOME/recallnest/data/activity-stats.json}"
CONFLICT_DIR="${PIVOT_SNAPSHOT_CONFLICTS:-$HOME/recallnest/data/conflict-candidates}"
RECALLNEST="$HOME/recallnest"

die() { echo "FATAL: $*" >&2; exit 1; }

count_memories() {
  (cd "$RECALLNEST" && LIVE_PATH="$LANCEDB_PHYS" bun -e '
import * as lancedb from "@lancedb/lancedb";
const db = await lancedb.connect(process.env.LIVE_PATH);
const t = await db.openTable("memories");
console.log(await t.countRows());
' 2>/dev/null) || die "cannot count memories rows"
}

count_snapshot_memories() {
  local snap_lance="$1"
  (cd "$RECALLNEST" && SNAP_PATH="$snap_lance" bun -e '
import * as lancedb from "@lancedb/lancedb";
const db = await lancedb.connect(process.env.SNAP_PATH);
const t = await db.openTable("memories");
console.log(await t.countRows());
' 2>/dev/null) || die "cannot count snapshot memories rows"
}

file_manifest() {
  # 相对路径 + 字节大小，稳定排序。lance 目录内容寻址，尺寸+清单足以判定漂移。
  (cd "$1" && find . -type f -print0 | xargs -0 stat -f '%N %z' | LC_ALL=C sort)
}

cmd="${1:-}"; snap_dir="${2:-}"
[ -n "$cmd" ] && [ -n "$snap_dir" ] || die "usage: $0 snapshot|restore|verify <snapshot-dir>"

case "$cmd" in
snapshot)
  [ -e "$snap_dir" ] && die "snapshot dir already exists: $snap_dir"
  [ -d "$LANCEDB_PHYS" ] || die "lancedb dir missing: $LANCEDB_PHYS"
  [ -f "$STATS_FILE" ] || die "activity-stats missing: $STATS_FILE"

  src_dev=$(stat -f '%d' "$LANCEDB_PHYS")
  mkdir -p "$(dirname "$snap_dir")"
  dst_dev=$(stat -f '%d' "$(dirname "$snap_dir")")
  [ "$src_dev" = "$dst_dev" ] || die "snapshot dir must be on the same APFS volume for clonefile (src dev $src_dev != dst dev $dst_dev)"

  rows_before=$(count_memories)
  manifest_before=$(file_manifest "$LANCEDB_PHYS")

  mkdir -p "$snap_dir"
  chmod 700 "$snap_dir"
  # -c = clonefile：同卷零拷贝，19G 秒级；克隆失败必须显式失败而不是退化全量
  cp -Rc "$LANCEDB_PHYS" "$snap_dir/lancedb" || die "clonefile copy failed"
  cp -c "$STATS_FILE" "$snap_dir/activity-stats.json" || die "stats copy failed"
  mkdir -p "$snap_dir/conflict-candidates"
  if [ -n "$(ls -A "$CONFLICT_DIR" 2>/dev/null)" ]; then
    cp -Rc "$CONFLICT_DIR/" "$snap_dir/conflict-candidates/" || die "conflict-candidates copy failed"
  fi

  rows_after=$(count_memories)
  manifest_after=$(file_manifest "$LANCEDB_PHYS")
  [ "$rows_before" = "$rows_after" ] || die "torn snapshot: memories rows changed during copy ($rows_before -> $rows_after). Run inside the supervisor stop-write window."
  [ "$manifest_before" = "$manifest_after" ] || die "torn snapshot: lancedb file manifest changed during copy. Run inside the supervisor stop-write window."

  snap_rows=$(count_snapshot_memories "$snap_dir/lancedb")
  [ "$snap_rows" = "$rows_before" ] || die "snapshot self-check failed: snapshot has $snap_rows rows, live had $rows_before"

  printf '%s\n' "$manifest_after" > "$snap_dir/lancedb-manifest.txt"
  cat > "$snap_dir/manifest.json" <<EOF
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "memoriesRows": $rows_before,
  "lancedbPath": "$LANCEDB_PHYS",
  "statsFile": "$STATS_FILE",
  "conflictDir": "$CONFLICT_DIR",
  "gitCommit": "$(git -C "$RECALLNEST" rev-parse --short HEAD 2>/dev/null || echo unknown)"
}
EOF
  echo "OK snapshot: $snap_dir (memories rows: $rows_before)"
  ;;

restore)
  [ -d "$snap_dir/lancedb" ] || die "not a snapshot dir (no lancedb/): $snap_dir"
  [ -f "$snap_dir/manifest.json" ] || die "manifest.json missing in $snap_dir"
  expected_rows=$(python3 -c "import json;print(json.load(open('$snap_dir/manifest.json'))['memoriesRows'])")

  # 还原前把当前态克隆走（失败可回到还原前）
  ts=$(date +%Y%m%d-%H%M%S)
  pre_dir="${snap_dir}.pre-restore-${ts}"
  cp -Rc "$LANCEDB_PHYS" "$pre_dir-lancedb" || die "pre-restore clone failed"
  cp -c "$STATS_FILE" "$pre_dir-activity-stats.json" || die "pre-restore stats clone failed"

  # 原子性尽力：先克隆到旁路目录，再瞬间换名（两次 mv，窗口毫秒级；供应商级原子无从谈起，
  # 但整个过程仍要求在停写窗口内跑，窗口里没有读者也没有写者）
  staging="${LANCEDB_PHYS}.restore-staging-${ts}"
  cp -Rc "$snap_dir/lancedb" "$staging" || die "restore clone failed"
  old="${LANCEDB_PHYS}.replaced-${ts}"
  mv "$LANCEDB_PHYS" "$old"
  mv "$staging" "$LANCEDB_PHYS"
  cp -c "$snap_dir/activity-stats.json" "$STATS_FILE.tmp" && mv "$STATS_FILE.tmp" "$STATS_FILE"
  # conflict-candidates：清空后从快照恢复（快照时为空则恢复为空）
  rm -rf "${CONFLICT_DIR:?}.restore-tmp" 2>/dev/null || true
  mkdir -p "$CONFLICT_DIR"
  find "$CONFLICT_DIR" -type f -name '*.json' -delete
  if [ -n "$(ls -A "$snap_dir/conflict-candidates" 2>/dev/null)" ]; then
    cp -Rc "$snap_dir/conflict-candidates/" "$CONFLICT_DIR/"
  fi

  actual_rows=$(count_memories)
  if [ "$actual_rows" != "$expected_rows" ]; then
    die "restore verification FAILED: rows $actual_rows != expected $expected_rows. Pre-restore state kept at $old and $pre_dir-*"
  fi
  manifest_now=$(file_manifest "$LANCEDB_PHYS")
  if ! diff -q <(printf '%s\n' "$manifest_now") "$snap_dir/lancedb-manifest.txt" >/dev/null 2>&1; then
    die "restore verification FAILED: file manifest differs from snapshot. Pre-restore state kept at $old and $pre_dir-*"
  fi
  # 校验全过才清理换下来的旧目录；pre-restore 克隆保留，由收官统一清
  rm -rf "$old"
  echo "OK restore: $snap_dir -> live (memories rows: $actual_rows). pre-restore clones kept at ${pre_dir}-*"
  ;;

verify)
  [ -f "$snap_dir/manifest.json" ] || die "manifest.json missing in $snap_dir"
  expected_rows=$(python3 -c "import json;print(json.load(open('$snap_dir/manifest.json'))['memoriesRows'])")
  actual_rows=$(count_memories)
  echo "live rows: $actual_rows | snapshot rows: $expected_rows"
  manifest_now=$(file_manifest "$LANCEDB_PHYS")
  if [ "$actual_rows" = "$expected_rows" ] && diff -q <(printf '%s\n' "$manifest_now") "$snap_dir/lancedb-manifest.txt" >/dev/null 2>&1; then
    echo "OK verify: live state matches snapshot"
  else
    echo "DIFFERS: live state does not match snapshot (expected when the batch has been written)"
    exit 2
  fi
  ;;

*)
  die "unknown command: $cmd"
  ;;
esac
