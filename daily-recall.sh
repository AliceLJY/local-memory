#!/bin/bash
# daily-recall.sh — 每日历史对话反思生成器
# 用 lm search 搜索近期有深度的对话片段，喂给 Claude 生成 200 字反思
# 输出存到 ~/local-memory/daily-reflections/YYYY-MM-DD.md

set -euo pipefail

# ── 路径配置 ──────────────────────────────────────────────────
SCRIPT_DIR="$HOME/local-memory"
LM="$SCRIPT_DIR/lm"
REFLECTION_DIR="$SCRIPT_DIR/daily-reflections"
LOG_DIR="$SCRIPT_DIR/logs"
DATE=$(date '+%Y-%m-%d')
OUTPUT_FILE="$REFLECTION_DIR/$DATE.md"
LOG_FILE="$LOG_DIR/daily-recall.log"

# ── 环境变量 ──────────────────────────────────────────────────
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export HOME="$HOME"

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

# ── 多关键词搜索，合并去重 ────────────────────────────────────
KEYWORDS=(
  "成长"
  "塑造"
  "经历"
  "动人"
  "哲学"
  "感悟"
  "自由意志"
  "洞察"
  "反思"
  "意义"
)

RAW_RESULTS=""
for kw in "${KEYWORDS[@]}"; do
  echo "  搜索关键词: $kw" | tee -a "$LOG_FILE"
  RESULT=$("$LM" search "$kw" 2>/dev/null | head -60 || true)
  if [ -n "$RESULT" ]; then
    RAW_RESULTS="${RAW_RESULTS}

=== 关键词「${kw}」===
${RESULT}"
  fi
done

if [ -z "$RAW_RESULTS" ]; then
  echo "  [警告] 所有关键词均无搜索结果，跳过生成" | tee -a "$LOG_FILE"
  exit 0
fi

# 去重：按行排序去重（粗粒度），防止 prompt 过长
DEDUPED=$(echo "$RAW_RESULTS" | awk '!seen[$0]++')

# 截断至约 6000 字，避免超出 claude -p 单次输入限制
TRUNCATED=$(echo "$DEDUPED" | head -200)

echo "  搜索完成，合并结果约 $(echo "$TRUNCATED" | wc -l) 行" | tee -a "$LOG_FILE"

# ── 构造 prompt ───────────────────────────────────────────────
PROMPT="以下是用户和 AI 之间的一些历史对话片段，来自不同时间的搜索结果：

---
${TRUNCATED}
---

请仔细阅读上面的片段，从中找出最有价值、最值得回味的洞察、思考或情感共鸣。
然后写一段 200 字左右的中文反思，要求：
- 语气温暖、真诚，像一位老朋友在回望共同走过的路
- 不说教、不灌鸡汤，点到即止
- 可以引用原文中的某个具体细节或金句
- 结尾可以有一句简短的留白或启发，而非总结

直接输出反思正文，不需要标题，不需要前言，不需要解释你做了什么。"

# ── 调用 Claude 生成反思 ──────────────────────────────────────
echo "  调用 Claude 生成反思..." | tee -a "$LOG_FILE"

REFLECTION=$(unset CLAUDECODE && /opt/homebrew/bin/claude --dangerously-skip-permissions -p "$PROMPT" --model claude-sonnet-4-5 2>/dev/null || true)

if [ -z "$REFLECTION" ]; then
  echo "  [错误] Claude 返回空结果，尝试不指定模型重试..." | tee -a "$LOG_FILE"
  REFLECTION=$(unset CLAUDECODE && /opt/homebrew/bin/claude --dangerously-skip-permissions -p "$PROMPT" 2>/dev/null || true)
fi

if [ -z "$REFLECTION" ]; then
  echo "  [错误] Claude 无响应，终止" | tee -a "$LOG_FILE"
  exit 1
fi

# ── 写入输出文件 ──────────────────────────────────────────────
cat > "$OUTPUT_FILE" << EOF
# 每日反思 · $DATE

$REFLECTION

---
*由 daily-recall.sh 自动生成 · $(date '+%Y-%m-%d %H:%M:%S')*
*搜索关键词：${KEYWORDS[*]}*
EOF

echo "  [完成] 反思已写入: $OUTPUT_FILE" | tee -a "$LOG_FILE"
echo "=== $(date '+%Y-%m-%d %H:%M:%S') daily-recall 结束 ===" | tee -a "$LOG_FILE"

# 预览前几行
echo ""
echo "── 生成内容预览 ──────────────────────────"
head -20 "$OUTPUT_FILE"
echo "──────────────────────────────────────────"
