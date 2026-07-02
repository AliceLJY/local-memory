#!/bin/bash
# RecallNest dream-consolidation scheduled task
# 2026-06-11: P3 dream-pipeline 调度化落地(设计骨架 2026-05-27,见 DREAM_SCHEDULING_PLAN.md)
# dream 是 auto-gc / usageStatus 快照 / consolidation 的唯一生产触发点。
# fail-closed 护栏 + 瞬态失败重试 + 失败告警 + dry-run/force 策略 + last run state

set -e
cd "$(dirname "$0")/.."

LOG_DIR="${HOME}/recallnest/logs"
mkdir -p "$LOG_DIR"

# Last run state (调度面调试 + 漏跑判断)
LAST_RUN_FILE="${HOME}/recallnest/data/.last-dream-run"
NOW=$(date '+%Y-%m-%d %H:%M:%S')

# dream --auto: 从 activity-counter 拉写计数达标(>= minWritesForDream)的所有 scope,逐个跑 dream
# (单 scope 失败不阻断其他)。per-scope 计数 = 每个活跃 scope 独立触发,不再全局单点。
# DREAM_SCOPE 保留仅供手动单 scope 调试(不走 --auto 时)。
DREAM_SCOPE="${DREAM_SCOPE:-cc}"

# Dry-run mode: DREAM_DRY_RUN=1 ./dream-consolidation.sh
if [ "${DREAM_DRY_RUN:-0}" = "1" ]; then
    echo "[$NOW] DRY RUN — would invoke dream pipeline (scope=$DREAM_SCOPE); skipping"
    exit 0
fi

# Force mode (skip min-writes gate): DREAM_FORCE=1
FORCE_FLAG=""
if [ "${DREAM_FORCE:-0}" = "1" ]; then
    FORCE_FLAG="--force"
    echo "[$NOW] FORCE mode — skipping min-writes gate"
fi

echo "[$NOW] Dream consolidation starting (auto: 所有写计数达标的 scope)"

DREAM_OUT=$(mktemp /tmp/rn-dream.XXXXXX)
trap "rm -f $DREAM_OUT" EXIT

DREAM_EXIT=1
STATUS_LINE=""
attempt=0
for attempt in 1 2 3; do
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] dream 尝试 $attempt/3"
    : > "$DREAM_OUT"

    "$HOME/.bun/bin/bun" run "$HOME/recallnest/src/cli.ts" dream --auto $FORCE_FLAG 2>&1 | tee "$DREAM_OUT"
    DREAM_EXIT=${PIPESTATUS[0]}

    STATUS_LINE=$(grep -aoE '\[\[DREAM_STATUS\]\] (ok|blocked|skip)' "$DREAM_OUT" 2>/dev/null | tail -1)

    if [ "$STATUS_LINE" = "[[DREAM_STATUS]] ok" ] || [ "$STATUS_LINE" = "[[DREAM_STATUS]] skip" ]; then
        break
    fi

    # 鉴权 / 网络瞬态错误重试 + 退避(同 weekly-distill 5-22 模式)
    if [ "$attempt" -lt 3 ] && grep -qaiE "403|ECONNRESET|timeout|Request not allowed" "$DREAM_OUT" 2>/dev/null; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] 瞬态失败,退避 30s 后重试..."
        sleep 30
    else
        break
    fi
done

echo "$NOW" > "$LAST_RUN_FILE"

echo ""
NOW_END=$(date '+%Y-%m-%d %H:%M:%S')
if [ "$STATUS_LINE" = "[[DREAM_STATUS]] ok" ]; then
    echo "[$NOW_END] Dream consolidation 完成 status=ok (用了 $attempt 次)"
    exit 0
elif [ "$STATUS_LINE" = "[[DREAM_STATUS]] skip" ]; then
    echo "[$NOW_END] Dream consolidation 跳过 status=skip(未达 min-writes 门槛)"
    exit 0
else
    # fail-closed 失败告警
    echo "[$NOW_END] ❌ Dream consolidation 失败 status='$STATUS_LINE' exit=$DREAM_EXIT"
    osascript -e "display notification \"RecallNest dream consolidation failed at $NOW_END (status='$STATUS_LINE', exit=$DREAM_EXIT). Check $LOG_DIR/dream-consolidation-launchd.log\" with title \"RecallNest Dream\" subtitle \"Cron failure\" sound name \"Basso\"" 2>/dev/null || true
    exit 1
fi
