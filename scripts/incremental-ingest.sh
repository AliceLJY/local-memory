#!/bin/bash
# RecallNest 增量更新脚本 — LaunchAgent 调用
# 只处理新增/修改的文件，已处理的自动跳过
# 超时保护：最多运行 2 小时，超时自动 kill

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Load API key from .env (CLI also reads .env, this is for LaunchAgent)
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/ingest-$(date +%Y-%m-%d).log"

# 超时时间（秒）：2 小时 = 7200 秒
TIMEOUT=7200

echo "=== $(date '+%Y-%m-%d %H:%M:%S') 增量更新开始 ===" >> "$LOG_FILE"

cd "$SCRIPT_DIR" || exit 1

# 用 timeout 命令限制运行时间（macOS 需要 gtimeout 或用 perl 替代）
if command -v gtimeout &>/dev/null; then
  gtimeout "$TIMEOUT" bun run src/cli.ts ingest --source all >> "$LOG_FILE" 2>&1
  EXIT_CODE=$?
elif command -v timeout &>/dev/null; then
  timeout "$TIMEOUT" bun run src/cli.ts ingest --source all >> "$LOG_FILE" 2>&1
  EXIT_CODE=$?
else
  # macOS 没有 timeout，用后台进程 + kill 实现
  bun run src/cli.ts ingest --source all >> "$LOG_FILE" 2>&1 &
  INGEST_PID=$!

  # 监控进程
  ELAPSED=0
  while kill -0 "$INGEST_PID" 2>/dev/null; do
    sleep 60
    ELAPSED=$((ELAPSED + 60))
    if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
      echo "⚠️  $(date '+%H:%M:%S') 超时 ${TIMEOUT}s，强制终止进程 $INGEST_PID" >> "$LOG_FILE"
      kill "$INGEST_PID" 2>/dev/null
      sleep 5
      kill -9 "$INGEST_PID" 2>/dev/null
      EXIT_CODE=124
      break
    fi
  done

  if [ -z "$EXIT_CODE" ]; then
    wait "$INGEST_PID"
    EXIT_CODE=$?
  fi
fi

if [ "$EXIT_CODE" -eq 124 ]; then
  echo "⚠️  $(date '+%Y-%m-%d %H:%M:%S') 增量更新超时（${TIMEOUT}s），已自动终止" >> "$LOG_FILE"
elif [ "$EXIT_CODE" -ne 0 ]; then
  echo "❌  $(date '+%Y-%m-%d %H:%M:%S') 增量更新异常退出（exit code: $EXIT_CODE）" >> "$LOG_FILE"
else
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') 增量更新完成 ===" >> "$LOG_FILE"
fi

echo "" >> "$LOG_FILE"

# 只保留最近 7 天的日志
find "$LOG_DIR" -name "ingest-*.log" -mtime +7 -delete 2>/dev/null
