#!/bin/bash
# pull-from-macbook.sh — 在 mini 上跑：反拉 MacBook 的 CC + Codex jsonl，然后触发本地 ingest
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
rsync -avz --partial --timeout=120 \
  --include='*/' --include='*.jsonl' --exclude='*' \
  -e "$SSH_OPTS" \
  mac:~/.claude/projects/ \
  ~/.claude/projects/ \
  >> "$ROTATING_LOG" 2>&1 || { EC=$?; log "❌ CC rsync 失败 exit=$EC"; }

# 3. rsync Codex sessions
log "→ rsync Codex sessions"
rsync -avz --partial --timeout=120 \
  --include='*/' --include='*.jsonl' --exclude='*' \
  -e "$SSH_OPTS" \
  mac:~/.codex/sessions/ \
  ~/.codex/sessions/ \
  >> "$ROTATING_LOG" 2>&1 || { EC=$?; log "❌ Codex rsync 失败 exit=$EC"; }

# 3b. rsync Codex archived_sessions（App 内归档会把文件移到此目录，不拉会漏）
log "→ rsync Codex archived_sessions"
rsync -avz --partial --timeout=120 \
  --include='*/' --include='*.jsonl' --exclude='*' \
  -e "$SSH_OPTS" \
  mac:~/.codex/archived_sessions/ \
  ~/.codex/archived_sessions/ \
  >> "$ROTATING_LOG" 2>&1 || { EC=$?; log "❌ Codex archived rsync 失败 exit=$EC"; }

# 4. rsync Codex session_index（用于 mini 端合并双机索引）
if ssh -o ConnectTimeout=5 mac 'test -f ~/.codex/session_index.jsonl' 2>/dev/null; then
  log "→ rsync Codex session_index"
  rsync -avz --partial --timeout=60 \
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

# 5. 触发 incremental-ingest（无论上面有没有 partial 失败，已拉到的部分也值得 ingest）
if [ $EC -eq 0 ]; then
  log "✅ rsync 完成，触发 ingest"
else
  log "⚠️ rsync 部分失败 exit=$EC，仍触发 ingest 处理已拉到的部分"
fi

bash ~/recallnest/scripts/incremental-ingest.sh
log "ingest 完成 exit=$?"

# 保留 14 天日志
find "$LOG_DIR" -name "pull-*.log" -mtime +14 -delete 2>/dev/null

log "=== pull 结束 ==="
exit $EC
