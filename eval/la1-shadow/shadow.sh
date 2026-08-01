#!/usr/bin/env bash
# LA-1 资格层准入 · 影子期数据采集
#
# 对同一组 query，分别在 off(基线) / on(min=2,3,4) 下跑检索，统计：
#   - evidence(会话碎片) 占 top-6 的比例
#   - 回退率（durable 太薄而放弃过滤的 query 占比）
#   - 每个 query 的 durable 命中数分布
#
# 注意：管线含 access-count / hotness / frequency 三个流行度信号，重复查询会
# 抬高被查条目的分数。故本脚本只比较「占比 / 回退 / 条数」，不跨配置比较分数绝对值。
#
# 用法: bash shadow.sh [输出目录]   默认 ~/Desktop/la1-shadow

set -uo pipefail
OUT="${1:-$HOME/Desktop/la1-shadow}"
RN="$HOME/recallnest"
mkdir -p "$OUT"

set -a; [ -f "$HOME/.config/recallnest/mcp.env" ] && . "$HOME/.config/recallnest/mcp.env"; set +a

# 20 条 query：刻意混合「老主题（沉淀多）」与「新主题（沉淀少）」，
# 因为已知缺口是分主题的 —— 只测老主题会高估过滤效果。
QUERIES=(
  "双机 契约 同步 漂移"
  "公众号 配图 排版"
  "deja 索引 会话检索"
  "记忆衰减 召回 命中率"
  "bot 挂了 容器 重启"
  "hippo wiki 装订 活页"
  "凭证 脱敏 泄露"
  "worktree 隔离 后台会话"
  "写文章 选题 真空"
  "codex 调用 headless"
  "kimi 封装 看门狗"
  "launchd 定时任务 失败"
  "小红书 搜索 socai"
  "生图 兜底 通道"
  "open-loops 闭环 验收"
  "skill 瘦身 触发面"
  "互审 冷读 隔离"
  "磁盘 空间 清理"
  "周报 视频 管线"
  "借鉴 审计 三写"
)

run_config() {
  local label="$1" mode="$2" min="${3:-3}"
  local dir="$OUT/$label"
  mkdir -p "$dir"
  echo "--- [$label] mode=$mode min=$min ---"
  local i=0
  for q in "${QUERIES[@]}"; do
    i=$((i+1))
    [ -f "$dir/q$i.json" ] && continue          # 断点续跑：已有结果跳过
    RECALLNEST_LAYER_ADMISSION="$mode" \
    RECALLNEST_LAYER_ADMISSION_MIN="$min" \
    bun "$RN/bin/recallnest.mjs" search "$q" --limit 6 --all-scopes --json \
      > "$dir/q$i.json" 2>"$dir/q$i.err" || echo "  q$i FAILED: $q"
    printf "  q%-2s %s\n" "$i" "$q"
  done
}

cd "$RN" || exit 1
run_config "off"   "off"
run_config "min2"  "on" 2
run_config "min3"  "on" 3
run_config "min4"  "on" 4

echo
echo "采集完成，输出在 $OUT"
