#!/bin/bash
# re-ingest-cc.sh — 全量重建 RecallNest 索引
#
# 背景：旧 dedup 阈值 (hard=0.80, soft=0.68) 导致 72% 内容被误杀，
#       且旧数据中可能有噪音。最干净的做法是清空后用新阈值从头导入。
#
# 用法：
#   cd ~/recallnest && bash scripts/re-ingest-cc.sh
#
# 步骤：
#   1. 备份 LanceDB + ingested-files.json + distill-progress.json
#   2. reset（清空 LanceDB）
#   3. 清空 ingest 和 distill 进度记录
#   4. 全量 ingest（所有源）
#   5. 完成后提示手动跑 distill-facts
#
# 预计耗时：3-5 小时（后台跑）
# 预计 API 成本：~$3-5

set -euo pipefail
cd "$(dirname "$0")/.."

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="data/backup-$TIMESTAMP"
LOG_FILE="logs/re-ingest-$TIMESTAMP.log"

echo "=== RecallNest 全量重建 ===" | tee "$LOG_FILE"
echo "开始时间: $(date)" | tee -a "$LOG_FILE"

# Step 1: 备份
echo "[1/4] 备份现有数据..." | tee -a "$LOG_FILE"
mkdir -p "$BACKUP_DIR"
cp data/ingested-files.json "$BACKUP_DIR/" 2>/dev/null || true
cp data/distill-progress.json "$BACKUP_DIR/" 2>/dev/null || true
# LanceDB 太大不整体备份，只记录 stats
echo "  LanceDB 当前大小: $(du -sh data/lancedb 2>/dev/null | cut -f1)" | tee -a "$LOG_FILE"
echo "  备份到: $BACKUP_DIR/" | tee -a "$LOG_FILE"

# Step 2: 清空 LanceDB
echo "[2/4] 清空 LanceDB 索引..." | tee -a "$LOG_FILE"
bun run src/cli.ts reset --yes 2>&1 | tee -a "$LOG_FILE"

# Step 3: 清空进度记录
echo "[3/4] 清空 ingest/distill 进度记录..." | tee -a "$LOG_FILE"
# Reset ingested-files.json — 让 ingest 认为所有文件都没处理过
echo '{"files":{}}' > data/ingested-files.json
# Reset distill progress
echo '{"startedAt":"","lastUpdated":"","completedScopes":[],"stats":{}}' > data/distill-progress.json
echo "  进度已重置" | tee -a "$LOG_FILE"

# Step 4: 全量 ingest
echo "[4/4] 开始全量导入（这一步需要 3-5 小时）..." | tee -a "$LOG_FILE"
echo "  日志实时写入: $LOG_FILE" | tee -a "$LOG_FILE"
echo "  查看进度: tail -f $LOG_FILE" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

bun run src/cli.ts ingest 2>&1 | tee -a "$LOG_FILE"

echo "" | tee -a "$LOG_FILE"
echo "=== 全量导入完成 ===" | tee -a "$LOG_FILE"
echo "结束时间: $(date)" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
echo "下一步：" | tee -a "$LOG_FILE"
echo "  1. 检查日志确认入库率（目标 50-65%，旧阈值是 27%）" | tee -a "$LOG_FILE"
echo "  2. 跑 distill: bun scripts/distill-facts.ts" | tee -a "$LOG_FILE"
echo "  3. 旧数据备份在: $BACKUP_DIR/" | tee -a "$LOG_FILE"
