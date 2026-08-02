#!/bin/bash
# pull-from-macbook.sh — 在 mini 上跑：反拉 MacBook 的四端会话原始数据，然后触发本地 ingest
# 设计：mini 常开，MacBook 不一定在线 → ssh 检测，离线安静退出（不报错），下个周期再试
#
# 装机方式：放到 ~/recallnest/scripts/pull-from-macbook.sh + launchctl 加载 com.recallnest.pull-from-macbook.plist

set -uo pipefail

LOG="/tmp/pull-from-macbook.log"
LOG_DIR="$HOME/recallnest/logs"
mkdir -p "$LOG_DIR"
ROTATING_LOG="$LOG_DIR/pull-$(date +%Y-%m-%d).log"

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$msg" | tee -a "$LOG" "$ROTATING_LOG"
}

register_codex_projectless_threads() {
  local registrar="$HOME/recallnest/scripts/codex-projectless-register.py"
  if [ ! -x "$registrar" ]; then
    log "⚠️ Codex projectless registrar 不存在，跳过"
    return 0
  fi
  log "→ register Codex vscode/user threads as projectless"
  "$registrar" --all-vscode-user >> "$ROTATING_LOG" 2>&1 \
    || log "⚠️ Codex projectless registrar 失败 exit=$?"
}

log "=== pull 开始 ==="

register_codex_projectless_threads

# 1. 检测 MacBook 是否在线（ssh 5 秒超时）
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes mac 'echo online' >/dev/null 2>&1; then
  log "MacBook 离线，本周期跳过（不算错）"
  exit 0
fi

log "MacBook 在线，开始 rsync"

EC=0
SSH_OPTS="ssh -o ProxyCommand=none -o ConnectTimeout=30 -o ServerAliveInterval=20"

# 2. rsync CC projects（含全部子目录）
log "→ rsync CC projects"
rsync -avz --partial --rsync-path=/opt/homebrew/bin/rsync --timeout=120 \
  --include='*/' --include='*.jsonl' --exclude='*' \
  -e "$SSH_OPTS" \
  mac:~/.claude/projects/ \
  ~/.claude/projects/ \
  >> "$ROTATING_LOG" 2>&1 || { EC=$?; log "❌ CC rsync 失败 exit=$EC"; }

# 3. rsync Codex sessions
log "→ rsync Codex sessions"
rsync -avz --partial --rsync-path=/opt/homebrew/bin/rsync --timeout=120 \
  --include='*/' --include='*.jsonl' --exclude='*' \
  -e "$SSH_OPTS" \
  mac:~/.codex/sessions/ \
  ~/.codex/sessions/ \
  >> "$ROTATING_LOG" 2>&1 || { EC=$?; log "❌ Codex rsync 失败 exit=$EC"; }

# 3b. rsync Codex archived_sessions（App 内归档会把文件移到此目录，不拉会漏）
log "→ rsync Codex archived_sessions"
rsync -avz --partial --rsync-path=/opt/homebrew/bin/rsync --timeout=120 \
  --include='*/' --include='*.jsonl' --exclude='*' \
  -e "$SSH_OPTS" \
  mac:~/.codex/archived_sessions/ \
  ~/.codex/archived_sessions/ \
  >> "$ROTATING_LOG" 2>&1 || { EC=$?; log "❌ Codex archived rsync 失败 exit=$EC"; }

# 4. rsync Codex session_index（用于 mini 端合并双机索引）
if ssh -o ConnectTimeout=5 mac 'test -f ~/.codex/session_index.jsonl' 2>/dev/null; then
  log "→ rsync Codex session_index"
  rsync -avz --partial --rsync-path=/opt/homebrew/bin/rsync --timeout=60 \
    -e "$SSH_OPTS" \
    mac:~/.codex/session_index.jsonl \
    ~/.codex/session_index.macbook.jsonl \
    >> "$ROTATING_LOG" 2>&1 || { EC=$?; log "⚠️ session_index rsync 失败 exit=$EC"; }

  # 合并双机 session_index（沿用 sync-jsonl-to-mini.sh 里的合并逻辑）
  python3 - <<'PY' >> "$ROTATING_LOG" 2>&1 || log "⚠️ session_index merge 失败"
import json, os, tempfile
home = os.path.expanduser("~")
target = os.path.join(home, ".codex", "session_index.jsonl")
macbook = os.path.join(home, ".codex", "session_index.macbook.jsonl")
entries = {}
order = []
def updated_at(e): return e.get("updated_at") or e.get("created_at") or ""
def load(p):
    if not os.path.exists(p): return
    with open(p, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line: continue
            try: entry = json.loads(line)
            except: continue
            sid = entry.get("id")
            if not isinstance(sid, str) or not sid: continue
            if sid not in entries:
                order.append(sid); entries[sid] = entry
            elif updated_at(entry) >= updated_at(entries[sid]):
                entries[sid] = entry
load(target); load(macbook)
os.makedirs(os.path.dirname(target), exist_ok=True)
fd, tmp = tempfile.mkstemp(prefix="session_index.", suffix=".jsonl", dir=os.path.dirname(target))
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    for sid in order: fh.write(json.dumps(entries[sid], ensure_ascii=False) + "\n")
os.replace(tmp, target)
print(f"merged Codex session_index entries={len(entries)}")
PY
fi

register_codex_projectless_threads

# 4b. rsync Kimi Code sessions（~/.kimi-code/sessions/**/wire.jsonl）+ session_index 合并
mkdir -p "$HOME/.kimi-code/sessions"
log "→ rsync Kimi Code sessions"
rsync -avz --partial --rsync-path=/opt/homebrew/bin/rsync --timeout=120 \
  --include='*/' --include='*.jsonl' --exclude='*' \
  -e "$SSH_OPTS" \
  mac:~/.kimi-code/sessions/ \
  ~/.kimi-code/sessions/ \
  >> "$ROTATING_LOG" 2>&1 || { EC=$?; log "⚠️ Kimi sessions rsync 失败 exit=$EC"; }

if ssh -o ConnectTimeout=5 mac 'test -f ~/.kimi-code/session_index.jsonl' 2>/dev/null; then
  log "→ rsync Kimi session_index"
  rsync -avz --partial --rsync-path=/opt/homebrew/bin/rsync --timeout=60 \
    -e "$SSH_OPTS" \
    mac:~/.kimi-code/session_index.jsonl \
    ~/.kimi-code/session_index.macbook.jsonl \
    >> "$ROTATING_LOG" 2>&1 || { EC=$?; log "⚠️ Kimi session_index rsync 失败 exit=$EC"; }

  # 合并双机 Kimi session_index（kimi 索引用 sessionId 字段、无时间戳，MacBook 版优先）
  python3 - <<'PY' >> "$ROTATING_LOG" 2>&1 || log "⚠️ Kimi session_index merge 失败"
import json, os, tempfile
home = os.path.expanduser("~")
target = os.path.join(home, ".kimi-code", "session_index.jsonl")
macbook = os.path.join(home, ".kimi-code", "session_index.macbook.jsonl")
entries = {}
order = []
def load(p, prefer):
    if not os.path.exists(p): return
    with open(p, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line: continue
            try: entry = json.loads(line)
            except: continue
            sid = entry.get("sessionId")
            if not isinstance(sid, str) or not sid: continue
            if sid not in entries:
                order.append(sid); entries[sid] = entry
            elif prefer:
                entries[sid] = entry
load(target, False); load(macbook, True)
os.makedirs(os.path.dirname(target), exist_ok=True)
fd, tmp = tempfile.mkstemp(prefix="session_index.", suffix=".jsonl", dir=os.path.dirname(target))
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    for sid in order: fh.write(json.dumps(entries[sid], ensure_ascii=False) + "\n")
os.replace(tmp, target)
print(f"merged Kimi session_index entries={len(entries)}")
PY
fi

# 4c. rsync Gemini CLI sessions（~/.gemini/tmp/**/chats/session-*.json）
#      AGY 对外是一个端，但底层历史既可能来自 Gemini CLI，也可能来自 Antigravity。
#      Gemini CLI 的会话格式由 RecallNest/Deja 直接支持；此前未进双机同步链，旧会话只留在 MacBook。
log "→ rsync MacBook Gemini CLI sessions"
mkdir -p "$HOME/.gemini/tmp"
rsync -az --partial --rsync-path=/opt/homebrew/bin/rsync --timeout=120 --prune-empty-dirs \
  --include='*/' --include='session-*.json' --exclude='*' \
  -e "$SSH_OPTS" \
  mac:~/.gemini/tmp/ \
  "$HOME/.gemini/tmp/" \
  >> "$ROTATING_LOG" 2>&1 || { EC=$?; log "⚠️ Gemini CLI sessions rsync 失败 exit=$EC"; }

# 4d. rsync Claude Desktop（local agent mode）本地对话 → data/desktop-import
#     desktop app 跑的 CC/local agent 对话在 ~/Library/Application Support/Claude/
#     local-agent-mode-sessions/<...>/.claude/projects/<...>/*.jsonl，标准 projects rsync 扫不到。
#     扁平化到 data/desktop-import/，复用现成 desktop 通道（config.sources.desktop / --source all）。
#     ⚠️ -s/--protect-args 处理远程路径空格(Application Support)，但它会阻止远程展开 ~，
#     所以远程必须用绝对路径($HOME 本地展开，双机 home 同为 $HOME)，不能用 ~。
log "→ rsync Claude Desktop local-agent 对话"
DESKTOP_IMPORT="$HOME/recallnest/data/desktop-import"
DESKTOP_STAGING="$HOME/.cache/desktop-agent-staging"
mkdir -p "$DESKTOP_IMPORT" "$DESKTOP_STAGING"
rsync -az --partial --rsync-path=/opt/homebrew/bin/rsync --timeout=180 -s --prune-empty-dirs \
  --include='*/' --exclude='audit.jsonl' --include='*.jsonl' --exclude='*' \
  -e "$SSH_OPTS -o BatchMode=yes" \
  "mac:$HOME/Library/Application Support/Claude/local-agent-mode-sessions/" \
  "$DESKTOP_STAGING/" \
  >> "$ROTATING_LOG" 2>&1 || { EC=$?; log "⚠️ Desktop rsync 失败 exit=${EC}（不阻塞，已拉部分仍 ingest）"; }
# 扁平化（cli.ts desktop 分支对该目录单层 readdirSync；uuid 文件名全局唯一，无碰撞）
DESKTOP_N=$(find "$DESKTOP_STAGING" -name '*.jsonl' ! -name 'audit.jsonl' 2>/dev/null | wc -l | tr -d ' ')
find "$DESKTOP_STAGING" -name '*.jsonl' ! -name 'audit.jsonl' -exec cp -p {} "$DESKTOP_IMPORT/" \; 2>/dev/null
log "Desktop 对话扁平化 ${DESKTOP_N} 个 jsonl → data/desktop-import"

# 4e. rsync MacBook 的 agy(Antigravity) 对话 → ~/machine-data/macbook-agy/
#     agy 双机都在用，但它的数据既不在 .claude/projects 也不在 .codex/.kimi-code 的 sessions 下，
#     2026-07-30 之前完全没进同步链 —— MacBook 上的 agy 对话永远汇不进 mini 全集。
#     拉到独立目录而非合并进本机 ~/.gemini/，避免污染 agy 自己的数据区（UUID 虽全局唯一不会碰撞，
#     但混进别机会话会让 agy 的历史列表出现本机从没跑过的 session）。
#     转换+导入由 agy-conversations-sync.sh 负责，它会同时扫本机和这一份。
log "→ rsync MacBook agy 对话"
AGY_MAC="$HOME/machine-data/macbook-agy"
mkdir -p "$AGY_MAC/brain" "$AGY_MAC/conversations"

# brain：只拉 transcript_full.jsonl。其余是 scratch / .user_uploaded 工作文件，
# 占了 64M 里的绝大部分且对入库无用。
rsync -az --partial --rsync-path=/opt/homebrew/bin/rsync --timeout=120 --prune-empty-dirs \
  --include='*/' --include='transcript_full.jsonl' --exclude='*' \
  -e "$SSH_OPTS" \
  mac:~/.gemini/antigravity-cli/brain/ \
  "$AGY_MAC/brain/" \
  >> "$ROTATING_LOG" 2>&1 || { EC=$?; log "⚠️ agy brain rsync 失败 exit=$EC"; }

# conversations：Antigravity IDE 的 .db。Alice 2026-07-30 明确「这些是转化的，你不要动他」——
# 这里只做只读拉取，转换走 antigravity-db-to-jsonl.py 读副本，绝不回写源文件。
# 2026-07-31 订正：源路径原写死 ~/.gemini/antigravity/conversations（桌面 app 的目录）。
# 实测 MacBook 只装/只用 CLI，该目录不存在，CLI 对话在 ~/.gemini/antigravity-cli/conversations。
# 两个都试，缺哪个跳哪个（rsync 对不存在的源返回 23，不当失败处理）。
for AGY_SRC in antigravity-cli/conversations antigravity/conversations; do
  rsync -az --partial --rsync-path=/opt/homebrew/bin/rsync --timeout=180 \
    --include='*.db' --exclude='*' \
    -e "$SSH_OPTS" \
    "mac:~/.gemini/$AGY_SRC/" \
    "$AGY_MAC/conversations/" \
    >> "$ROTATING_LOG" 2>&1
  RC=$?
  if [ $RC -eq 0 ]; then
    log "   agy conversations 已拉: $AGY_SRC"
  elif [ $RC -eq 23 ] || [ $RC -eq 24 ]; then
    log "   agy conversations 跳过(源不存在): $AGY_SRC"
  else
    EC=$RC; log "⚠️ agy conversations rsync 失败 exit=$RC ($AGY_SRC)"
  fi
done

# legacy-pb：2026-07-29 由 AGY 迁移成 45 个明文 SQLite 的旧 Antigravity IDE 原件。
# 明文内容已在 mini，但加密 .pb 原件此前仍只留在 MacBook Downloads；只读复制到隔离归档，
# 不放进 ~/.gemini，也不让任何自动任务回写源目录。
mkdir -p "$AGY_MAC/legacy-pb"
rsync -az --partial --rsync-path=/opt/homebrew/bin/rsync --timeout=180 \
  --include='*.pb' --exclude='*' \
  -e "$SSH_OPTS" \
  mac:~/Downloads/antigravity-rescue/conversations/ \
  "$AGY_MAC/legacy-pb/" \
  >> "$ROTATING_LOG" 2>&1
RC=$?
if [ $RC -ne 0 ] && [ $RC -ne 23 ] && [ $RC -ne 24 ]; then
  EC=$RC; log "⚠️ agy legacy .pb rsync 失败 exit=$RC"
fi

log "MacBook agy 已拉取：brain $(find "$AGY_MAC/brain" -name transcript_full.jsonl 2>/dev/null | wc -l | tr -d ' ') 个 transcript / conversations $(ls "$AGY_MAC/conversations"/*.db 2>/dev/null | wc -l | tr -d ' ') 个 db / legacy-pb $(find "$AGY_MAC/legacy-pb" -maxdepth 1 -name '*.pb' 2>/dev/null | wc -l | tr -d ' ') 个原件"

# 5. 触发 incremental-ingest（无论上面有没有 partial 失败，已拉到的部分也值得 ingest）
if [ $EC -eq 0 ]; then
  log "✅ rsync 完成，触发 ingest"
else
  log "⚠️ rsync 部分失败 exit=${EC}，仍触发 ingest 处理已拉到的部分"
fi

bash ~/recallnest/scripts/incremental-ingest.sh
log "ingest 完成 exit=$?"

# 保留 14 天日志
find "$LOG_DIR" -name "pull-*.log" -mtime +14 -delete 2>/dev/null

log "=== pull 结束 ==="
exit $EC
