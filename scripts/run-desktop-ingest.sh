#!/bin/bash
# 后台运行 desktop ingest，关窗口也不中断
# 日志输出到 data/desktop-ingest.log

cd "$(dirname "$0")/.."
LOG="data/desktop-ingest.log"

echo "$(date '+%Y-%m-%d %H:%M:%S') 开始导入 Desktop 对话..." > "$LOG"
bun run src/cli.ts ingest --source desktop >> "$LOG" 2>&1
echo "" >> "$LOG"
echo "$(date '+%Y-%m-%d %H:%M:%S') 导入完成" >> "$LOG"
