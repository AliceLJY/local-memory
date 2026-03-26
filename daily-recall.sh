#!/bin/bash
# daily-recall.sh — 每日记忆回顾（v2: 纯 RecallNest，不依赖 claude -p）
# 用 lm distill 从历史对话中提取结构化洞察
# 每天轮换查询主题，输出存到 daily-reflections/YYYY-MM-DD.md

set -euo pipefail

# ── 路径配置 ──────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LM="$SCRIPT_DIR/lm"
REFLECTION_DIR="$SCRIPT_DIR/daily-reflections"
LOG_DIR="$SCRIPT_DIR/logs"
DATE=$(date '+%Y-%m-%d')
OUTPUT_FILE="$REFLECTION_DIR/$DATE.md"
LOG_FILE="$LOG_DIR/daily-recall.log"

# ── 环境变量 ──────────────────────────────────────────────────
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export HOME="${HOME:-$HOME}"

# 加载 .env（JINA_API_KEY 等）
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

# ── 准备目录 ──────────────────────────────────────────────────
mkdir -p "$REFLECTION_DIR"
mkdir -p "$LOG_DIR"

echo "=== $(date '+%Y-%m-%d %H:%M:%S') daily-recall 开始 ===" | tee -a "$LOG_FILE"

# ── 每日轮换查询（7 天一轮） ──────────────────────────────────
QUERIES=(
  "成长 经历 改变了什么"
  "洞察 反思 核心教训"
  "哲学 意识 自由意志"
  "写作 表达 风格探索"
  "技术 架构 解决方案"
  "感悟 人心 被看见"
  "踩坑 修复 经验总结"
)

DOW=$(date '+%u')  # 1=周一 ... 7=周日
IDX=$(( (DOW - 1) % ${#QUERIES[@]} ))
TODAY_QUERY="${QUERIES[$IDX]}"

echo "  今日主题 (#$((IDX+1))): $TODAY_QUERY" | tee -a "$LOG_FILE"

# ── 用 lm distill 提取结构化洞察 ──────────────────────────────
echo "  执行 distill..." | tee -a "$LOG_FILE"
DISTILL_OUTPUT=$("$LM" distill "$TODAY_QUERY" --profile writing --limit 8 --all-scopes 2>&1 || true)

if [ -z "$DISTILL_OUTPUT" ]; then
  echo "  [警告] distill 无输出，尝试 export..." | tee -a "$LOG_FILE"
  DISTILL_OUTPUT=$("$LM" export "$TODAY_QUERY" --profile writing --limit 5 --format md --all-scopes 2>&1 || true)
fi

if [ -z "$DISTILL_OUTPUT" ]; then
  echo "  [错误] distill 和 export 均无输出，终止" | tee -a "$LOG_FILE"
  exit 1
fi

echo "  distill 完成，$(echo "$DISTILL_OUTPUT" | wc -l | tr -d ' ') 行" | tee -a "$LOG_FILE"

# ── 写入输出文件 ──────────────────────────────────────────────
cat > "$OUTPUT_FILE" << EOF
# 每日回顾 · $DATE

> 主题：$TODAY_QUERY

$DISTILL_OUTPUT

---
*由 daily-recall.sh v2 自动生成 · $(date '+%Y-%m-%d %H:%M:%S')*
*引擎：RecallNest distill (profile: writing)*
EOF

echo "  [完成] 回顾已写入: $OUTPUT_FILE" | tee -a "$LOG_FILE"

# ── Checkpoint GC（2026-03-26 正式启用） ────────────
echo "  执行 checkpoint-gc..." | tee -a "$LOG_FILE"
GC_OUTPUT=$(bun run "$SCRIPT_DIR/src/cli.ts" checkpoint-gc 2>&1 || true)
echo "  checkpoint-gc: $GC_OUTPUT" | tee -a "$LOG_FILE"

echo "=== $(date '+%Y-%m-%d %H:%M:%S') daily-recall 结束 ===" | tee -a "$LOG_FILE"
