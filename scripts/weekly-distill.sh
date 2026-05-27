#!/bin/bash
# RecallNest 周度散片蒸馏：自动从 transcript-ingest peripheral 散片提炼 reusable case
# 部署：~/Library/LaunchAgents/com.recallnest.weekly-distill.plist，每周日 03:15 触发
# 触发词 "提炼 case" 由 CC 加载 ~/.claude/projects/-Users-USER/memory/feedback_recallnest_case_distill.md 后按规则执行

set -uo pipefail

# launchd 后台进程无 ~/Desktop 写权限（macOS TCC，2026-05-19 教训：
# exec >> Desktop/...log → Operation not permitted）→ 落 launchd 有权限的 logs/
LOG_DIR="$HOME/recallnest/logs"
DATE_STR=$(date +%Y-%m-%d)
LOG_FILE="$LOG_DIR/recallnest-distill-$DATE_STR.log"

mkdir -p "$LOG_DIR"
exec >> "$LOG_FILE" 2>&1

echo ""
echo "================================================================"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 周蒸馏开始 (host=$(hostname -s))"
echo "================================================================"

cd "$HOME/recallnest" || { echo "❌ cd ~/recallnest 失败"; exit 1; }

PROMPT="提炼 case：对 RecallNest 散片做一次周度蒸馏 batch。范围最近 7 天 + category=cases + limit 30。按 feedback_recallnest_case_distill.md step 2 流程执行（search → distill → 价值判断 → store_case 或 promote_memory），新增 case 上限 10 条，质量门槛 importance >= 0.8。完成后报告：处理 X 条 evidence、新增 Y 条 case 的 ID + title、promote Z 条、skip W 条原因、估算剩余候选 + 推荐下一 batch 入口。【硬性要求】无论成功或失败，回复最后一行必须单独输出机器可读状态标记，二选一：管线正常走完（即使新增 0 条 case 也算正常）→ 输出一行 [[DISTILL_STATUS]] ok ；若 RecallNest MCP 未连上 / 管线任一步未跑起来 / 未能完成 batch → 输出一行 [[DISTILL_STATUS]] blocked 后跟一句原因。该行必须是回复正文最后一行，不要用代码块包裹。"

# script -q /dev/null 是 non-TTY 卡住的兜底（CLAUDE.md 教训）
# fail-closed 护栏：claude CLI 退出码不可信——对话成功但 MCP 没连也 exit 0
# （2026-05-17 首次 cron 静默空跑教训）。改为抓 CC 输出的 [[DISTILL_STATUS]]
# 正向标记：抓不到 ok 一律按失败处理 + 通知中心告警 + exit 1（fail-closed）。
# 2026-05-22：加重试。launchd 冷启动首发请求易 403（Failed to authenticate /
# Request not allowed），但重试即自愈（daily-study 同款重试已验证能跑通）。
# 最多 3 次；失败若检出 403 类鉴权错则退避 10s 再试，非鉴权失败（真 blocked）
# 不浪费重试、直接走下方半自动兜底。
DISTILL_OUT=$(mktemp /tmp/rn-distill.XXXXXX)
STATUS_LINE=""
CLAUDE_EXIT=1
for attempt in 1 2 3; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] distill 尝试 $attempt/3"
  : > "$DISTILL_OUT"
  script -q /dev/null ~/.local/bin/claude -p "$PROMPT" 2>&1 | tee "$DISTILL_OUT"
  CLAUDE_EXIT=${PIPESTATUS[0]}
  STATUS_LINE=$(grep -aoE '\[\[DISTILL_STATUS\]\] (ok|blocked)' "$DISTILL_OUT" 2>/dev/null | tail -1)
  [ "$STATUS_LINE" = "[[DISTILL_STATUS]] ok" ] && break
  if [ "$attempt" -lt 3 ] && grep -qaiE "403|Failed to authenticate|Request not allowed|Not logged in" "$DISTILL_OUT" 2>/dev/null; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 冷启动鉴权失败，退避 10s 后重试..."
    sleep 10
  else
    break
  fi
done
rm -f "$DISTILL_OUT"

echo ""
if [ "$STATUS_LINE" = "[[DISTILL_STATUS]] ok" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 周蒸馏结束 status=ok (claude exit=$CLAUDE_EXIT, 用了 $attempt 次)"
  exit 0
fi

REASON="${STATUS_LINE:-无 [[DISTILL_STATUS]] 标记（疑似 MCP 未连/管线未启动/CC 未跑完）}"
# 2026-05-22 更新：上面已加 3 次重试自愈冷启动 403（daily-study 同款已验证）。
# 走到这里 = 重试耗尽仍未 ok（多为 MCP 未连/真 blocked），保留半自动兜底：
# 发通知 + 提示人工在 mini 交互式 claude 跑（话术=下方 canonicalKey）。
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 周蒸馏 launchd 自动未完成 status=${REASON} (claude exit=$CLAUDE_EXIT)"
echo "[半自动] 请在 mini 交互式 claude 手动跑 distill；话术见 RecallNest workflow pattern:"
echo "[半自动]   canonicalKey = recallnest-weekly-distill-mcp-coldstart-cli-fallback"
osascript -e 'display notification "周蒸馏需手动跑：mini 交互 claude + pattern …coldstart-cli-fallback" with title "RecallNest 半自动" sound name "Basso"' 2>/dev/null || true
exit 1
