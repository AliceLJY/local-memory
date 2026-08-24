#!/bin/bash
# pull-from-macbook.sh — 在 mini 上跑：反拉 MacBook 的四端会话原始数据，然后触发本地 ingest
# 设计：mini 常开，MacBook 不一定在线 → routine 离线安静退出；显式 sync-only 离线返回失败
#
# 装机方式：放到 ~/recallnest/scripts/pull-from-macbook.sh + launchctl 加载 com.recallnest.pull-from-macbook.plist

set -uo pipefail

SYNC_ONLY=0
MAPPING_REPORT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --sync-only)
      SYNC_ONLY=1
      shift
      ;;
    --mapping-report)
      if [ "$#" -lt 2 ]; then
        echo "--mapping-report 需要路径" >&2
        exit 2
      fi
      MAPPING_REPORT="$2"
      shift 2
      ;;
    -h|--help)
      echo "用法: $0 [--sync-only [--mapping-report PATH]]"
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      exit 2
      ;;
  esac
done

if [ -n "$MAPPING_REPORT" ] && [ "$SYNC_ONLY" -ne 1 ]; then
  echo "--mapping-report 只能与 --sync-only 一起使用" >&2
  exit 2
fi

if [ "$SYNC_ONLY" -eq 1 ]; then
  umask 077
fi

PULL_HOME="${PULL_FROM_MACBOOK_HOME:-$HOME}"
RSYNC_BIN="${PULL_FROM_MACBOOK_RSYNC:-/opt/homebrew/bin/rsync}"
SSH_BIN="${PULL_FROM_MACBOOK_SSH:-/usr/bin/ssh}"
case "$PULL_HOME" in
  /*) ;;
  *)
    echo "PULL_FROM_MACBOOK_HOME 必须是绝对路径" >&2
    exit 2
    ;;
esac

LOG="${PULL_FROM_MACBOOK_LOG:-/tmp/pull-from-macbook.log}"
LOG_DIR="${PULL_FROM_MACBOOK_LOG_DIR:-$PULL_HOME/recallnest/logs}"
mkdir -p "$LOG_DIR"
ROTATING_LOG="$LOG_DIR/pull-$(date +%Y-%m-%d).log"
EC=0
MAPPING_TMP=""

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$msg" | tee -a "$LOG" "$ROTATING_LOG"
}

set_failure() {
  local code="$1"
  shift
  if [ "$EC" -eq 0 ]; then
    EC="$code"
  fi
  log "$*"
}

tsv_escape() {
  local value="$1"
  value="${value//$'\t'/\\t}"
  value="${value//$'\n'/\\n}"
  printf '%s' "$value"
}

record_mapping() {
  [ "$SYNC_ONLY" -eq 1 ] || return 0
  local source_kind="$1"
  local source_file="$2"
  local local_target="$3"
  local derived_target="$4"
  local status="$5"
  if ! printf '%s\t%s\t%s\t%s\t%s\n' \
    "$(tsv_escape "$source_kind")" \
    "$(tsv_escape "$source_file")" \
    "$(tsv_escape "$local_target")" \
    "$(tsv_escape "$derived_target")" \
    "$(tsv_escape "$status")" >> "$MAPPING_TMP"; then
    set_failure 1 "❌ sync-only 映射报告追加失败"
    return 1
  fi
}

init_mapping_report() {
  [ "$SYNC_ONLY" -eq 1 ] || return 0
  if [ -z "$MAPPING_REPORT" ]; then
    MAPPING_REPORT="$LOG_DIR/sync-only-map-$(date +%Y%m%d-%H%M%S)-$$.tsv"
  fi
  if [ -e "$MAPPING_REPORT" ] || [ -L "$MAPPING_REPORT" ]; then
    echo "拒绝覆盖已有 sync-only 映射报告: $MAPPING_REPORT" >&2
    return 1
  fi
  if ! mkdir -p "$(dirname "$MAPPING_REPORT")"; then
    echo "无法创建 sync-only 映射报告目录: $(dirname "$MAPPING_REPORT")" >&2
    return 1
  fi
  if ! MAPPING_TMP=$(mktemp "${MAPPING_REPORT}.tmp.XXXXXX"); then
    echo "无法创建 sync-only 映射报告临时文件" >&2
    return 1
  fi
  if ! printf 'source_kind\tsource_file\tlocal_target\tderived_target\tstatus\n' > "$MAPPING_TMP"; then
    echo "无法创建 sync-only 映射报告: $MAPPING_TMP" >&2
    return 1
  fi
  chmod 600 "$MAPPING_TMP" || return 1
}

finalize_mapping_report() {
  [ "$SYNC_ONLY" -eq 1 ] || return 0
  if [ -d "$MAPPING_REPORT" ]; then
    set_failure 1 "❌ sync-only 映射报告路径是目录: $MAPPING_REPORT"
    return 1
  fi
  MAPPING_INSTALL_RC=0
  python3 - "$MAPPING_TMP" "$MAPPING_REPORT" <<'PY' >> "$ROTATING_LOG" 2>&1 || MAPPING_INSTALL_RC=$?
import os
import sys

temporary, destination = sys.argv[1:3]
os.link(temporary, destination)
os.unlink(temporary)
PY
  if [ "$MAPPING_INSTALL_RC" -ne 0 ]; then
    set_failure 1 "❌ sync-only 映射报告写入失败: $MAPPING_REPORT"
    return 1
  fi
  chmod 600 "$MAPPING_REPORT" || set_failure 1 "❌ sync-only 映射报告权限设置失败"
  MAPPING_TMP=""
  log "sync-only 映射报告: $MAPPING_REPORT"
}

mapped_path() {
  local mode="$1"
  local root="$2"
  local relative="$3"
  if [ "$mode" = "file" ]; then
    printf '%s' "$root"
  else
    relative="${relative#./}"
    printf '%s/%s' "${root%/}" "$relative"
  fi
}

derived_path() {
  local mode="$1"
  local local_target="$2"
  local relative="$3"
  case "$mode" in
    same)
      printf '%s' "$local_target"
      ;;
    flat:*)
      printf '%s/%s' "${mode#flat:}" "$(basename "$relative")"
      ;;
    fixed:*)
      printf '%s' "${mode#fixed:}"
      ;;
    *)
      printf '%s' "$local_target"
      ;;
  esac
}

# 所有来源都从这一处调用 rsync。sync-only 在真实同步后先用 ignore-times
# 枚举源文件，再复用完全相同的 rsync_args 做最终 dry-run 复核。
sync_source() {
  local source_id="$1"
  local source_mode="$2"
  local source_root="$3"
  local target_mode="$4"
  local target_root="$5"
  local derived_mode="$6"
  shift 6
  local -a rsync_args=("$@")
  local rc verify_output mapping_output pending item relative source_file local_target final_target mapped=0
  local source_rc=0

  "$RSYNC_BIN" "${rsync_args[@]}" "$source_root" "$target_root" >> "$ROTATING_LOG" 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then
    set_failure "$rc" "❌ $source_id rsync 失败 exit=$rc"
    record_mapping "$source_id" "$source_root" "$target_root" "$target_root" "sync-failed:$rc"
    return "$rc"
  fi

  [ "$SYNC_ONLY" -eq 1 ] || return 0

  mapping_output=$("$RSYNC_BIN" "${rsync_args[@]}" --dry-run --ignore-times --itemize-changes \
    '--out-format=__RN_MAP__%i|%n' "$source_root" "$target_root" 2>> "$ROTATING_LOG")
  rc=$?
  if [ "$rc" -ne 0 ]; then
    set_failure "$rc" "❌ $source_id 文件映射枚举失败 exit=$rc"
    record_mapping "$source_id" "$source_root" "$target_root" "$target_root" "mapping-failed:$rc"
    return "$rc"
  fi

  verify_output=$("$RSYNC_BIN" "${rsync_args[@]}" --dry-run --itemize-changes \
    '--out-format=__RN_CHANGE__%i|%n' "$source_root" "$target_root" 2>> "$ROTATING_LOG")
  rc=$?
  if [ "$rc" -ne 0 ]; then
    set_failure "$rc" "❌ $source_id 最终 dry-run 复核失败 exit=$rc"
    record_mapping "$source_id" "$source_root" "$target_root" "$target_root" "verify-failed:$rc"
    return "$rc"
  fi
  pending=$(printf '%s\n' "$verify_output" | grep -c '^__RN_CHANGE__' || true)
  if [ "$pending" -ne 0 ]; then
    set_failure 1 "❌ $source_id dry-run pending=$pending"
    source_rc=1
  else
    log "   $source_id dry-run pending=0"
  fi

  while IFS='|' read -r item relative; do
    case "$item" in
      __RN_MAP__*f*)
        source_file=$(mapped_path "$source_mode" "$source_root" "$relative")
        local_target=$(mapped_path "$target_mode" "$target_root" "$relative")
        final_target=$(derived_path "$derived_mode" "$local_target" "$relative")
        if [ "$pending" -eq 0 ] && [ "$derived_mode" = "same" ]; then
          record_mapping "$source_id" "$source_file" "$local_target" "$final_target" "verified"
        elif [ "$pending" -eq 0 ]; then
          record_mapping "$source_id" "$source_file" "$local_target" "$final_target" "local-verified:derived-pending"
        else
          record_mapping "$source_id" "$source_file" "$local_target" "$final_target" "pending:$pending"
        fi
        mapped=$((mapped + 1))
        ;;
    esac
  done <<EOF
$mapping_output
EOF
  if [ "$mapped" -eq 0 ]; then
    record_mapping "$source_id" "$source_root" "$target_root" "$target_root" "empty-source"
  fi
  return "$source_rc"
}

register_codex_projectless_threads() {
  local registrar="$PULL_HOME/recallnest/scripts/codex-projectless-register.py"
  if [ ! -x "$registrar" ]; then
    log "⚠️ Codex projectless registrar 不存在，跳过"
    return 0
  fi
  log "→ register Codex vscode/user threads as projectless"
  "$registrar" --all-vscode-user >> "$ROTATING_LOG" 2>&1 \
    || log "⚠️ Codex projectless registrar 失败 exit=$?"
}

if ! init_mapping_report; then
  exit 1
fi
if [ "$SYNC_ONLY" -eq 1 ]; then
  log "=== pull 开始（sync-only） ==="
else
  log "=== pull 开始 ==="
fi

if [ "$SYNC_ONLY" -eq 0 ]; then
  register_codex_projectless_threads
fi

# 1. 检测 MacBook 是否在线（ssh 5 秒超时）
if [ ! -x "$SSH_BIN" ]; then
  set_failure 127 "❌ 本机 ssh 不可执行: $SSH_BIN"
  record_mapping "transport" "ssh" "$SSH_BIN" "$SSH_BIN" "tool-unavailable"
  finalize_mapping_report
  exit "$EC"
fi
if ! "$SSH_BIN" -o ConnectTimeout=5 -o BatchMode=yes mac 'echo online' >/dev/null 2>&1; then
  if [ "$SYNC_ONLY" -eq 1 ]; then
    record_mapping "transport" "mac" "-" "-" "offline"
    set_failure 1 "❌ MacBook 离线，sync-only 无法完成"
    finalize_mapping_report
    exit "$EC"
  fi
  log "MacBook 离线，本周期跳过（不算错）"
  exit 0
fi

if [ ! -x "$RSYNC_BIN" ]; then
  set_failure 127 "❌ 本机 rsync 不可执行: $RSYNC_BIN"
  record_mapping "transport" "rsync" "$RSYNC_BIN" "$RSYNC_BIN" "tool-unavailable"
  finalize_mapping_report
  exit "$EC"
fi

log "MacBook 在线，开始 rsync"

SSH_OPTS="$SSH_BIN -o ProxyCommand=none -o ConnectTimeout=30 -o ServerAliveInterval=20"

# 2. rsync CC projects（含全部子目录）
# --exclude='*session-digest*' 必须排在 --include='*/' 之前（rsync 规则首匹配生效）：
# session-digest.py 的摘要调用会话记录是检索污染源（2026-08-24 审计），MacBook 存量不再回流
log "→ rsync CC projects"
sync_source "claude-code" tree "mac:~/.claude/projects/" \
  tree "$PULL_HOME/.claude/projects/" same \
  -avz --partial --rsync-path=/opt/homebrew/bin/rsync --timeout=120 \
  --exclude='*session-digest*' --include='*/' --include='*.jsonl' --exclude='*' \
  -e "$SSH_OPTS"

# 3. rsync Codex sessions
log "→ rsync Codex sessions"
sync_source "codex-sessions" tree "mac:~/.codex/sessions/" \
  tree "$PULL_HOME/.codex/sessions/" same \
  -avz --partial --rsync-path=/opt/homebrew/bin/rsync --timeout=120 \
  --include='*/' --include='*.jsonl' --exclude='*' \
  -e "$SSH_OPTS"

# 3b. rsync Codex archived_sessions（App 内归档会把文件移到此目录，不拉会漏）
log "→ rsync Codex archived_sessions"
sync_source "codex-archived" tree "mac:~/.codex/archived_sessions/" \
  tree "$PULL_HOME/.codex/archived_sessions/" same \
  -avz --partial --rsync-path=/opt/homebrew/bin/rsync --timeout=120 \
  --include='*/' --include='*.jsonl' --exclude='*' \
  -e "$SSH_OPTS"

# 4. rsync Codex session_index（用于 mini 端合并双机索引）
"$SSH_BIN" -o ConnectTimeout=5 -o BatchMode=yes mac \
  'd="$HOME/.codex"; p="$d/session_index.jsonl"; if [ ! -e "$d" ]; then exit 2; elif [ ! -d "$d" ] || [ ! -x "$d" ]; then exit 3; elif [ -f "$p" ]; then exit 0; elif [ -e "$p" ]; then exit 3; else exit 2; fi' \
  2>/dev/null
CODEX_INDEX_PROBE_RC=$?
if [ "$CODEX_INDEX_PROBE_RC" -eq 0 ]; then
  log "→ rsync Codex session_index"
  CODEX_INDEX_SYNCED=0
  if sync_source "codex-session-index" file "mac:~/.codex/session_index.jsonl" \
    file "$PULL_HOME/.codex/session_index.macbook.jsonl" \
    "fixed:$PULL_HOME/.codex/session_index.jsonl" \
    -avz --partial --rsync-path=/opt/homebrew/bin/rsync --timeout=60 \
    -e "$SSH_OPTS"; then
    CODEX_INDEX_SYNCED=1
  fi

  # 合并双机 session_index（沿用 sync-jsonl-to-mini.sh 里的合并逻辑）
  if [ "$CODEX_INDEX_SYNCED" -eq 1 ]; then
    CODEX_MERGE_RC=0
    PULL_HOME="$PULL_HOME" python3 - <<'PY' >> "$ROTATING_LOG" 2>&1 || CODEX_MERGE_RC=$?
import json, os, tempfile
home = os.environ["PULL_HOME"]
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
    if [ "$CODEX_MERGE_RC" -eq 0 ]; then
      record_mapping "codex-index-merge" "$PULL_HOME/.codex/session_index.macbook.jsonl" \
        "$PULL_HOME/.codex/session_index.jsonl" "$PULL_HOME/.codex/session_index.jsonl" "merged"
    elif [ "$SYNC_ONLY" -eq 1 ]; then
      set_failure "$CODEX_MERGE_RC" "❌ Codex session_index merge 失败 exit=$CODEX_MERGE_RC"
      record_mapping "codex-index-merge" "$PULL_HOME/.codex/session_index.macbook.jsonl" \
        "$PULL_HOME/.codex/session_index.jsonl" "$PULL_HOME/.codex/session_index.jsonl" "merge-failed:$CODEX_MERGE_RC"
    else
      log "⚠️ session_index merge 失败 exit=$CODEX_MERGE_RC"
    fi
  else
    log "⚠️ Codex session_index 同步未完成，跳过 merge"
    record_mapping "codex-index-merge" "$PULL_HOME/.codex/session_index.macbook.jsonl" \
      "$PULL_HOME/.codex/session_index.jsonl" "$PULL_HOME/.codex/session_index.jsonl" "derived-skipped:source-sync-failed"
  fi
elif [ "$CODEX_INDEX_PROBE_RC" -eq 2 ]; then
  log "   Codex session_index 跳过（远端源不存在）"
  record_mapping "codex-session-index" "mac:~/.codex/session_index.jsonl" \
    "$PULL_HOME/.codex/session_index.macbook.jsonl" "$PULL_HOME/.codex/session_index.jsonl" "source-absent"
else
  set_failure "$CODEX_INDEX_PROBE_RC" "❌ Codex session_index 远端探测失败 exit=$CODEX_INDEX_PROBE_RC"
  record_mapping "codex-session-index" "mac:~/.codex/session_index.jsonl" \
    "$PULL_HOME/.codex/session_index.macbook.jsonl" "$PULL_HOME/.codex/session_index.jsonl" \
    "probe-failed:$CODEX_INDEX_PROBE_RC"
fi

if [ "$SYNC_ONLY" -eq 0 ]; then
  register_codex_projectless_threads
fi

# 4b. rsync Kimi Code sessions（~/.kimi-code/sessions/**/wire.jsonl）+ session_index 合并
mkdir -p "$PULL_HOME/.kimi-code/sessions"
log "→ rsync Kimi Code sessions"
sync_source "kimi-sessions" tree "mac:~/.kimi-code/sessions/" \
  tree "$PULL_HOME/.kimi-code/sessions/" same \
  -avz --partial --rsync-path=/opt/homebrew/bin/rsync --timeout=120 \
  --include='*/' --include='*.jsonl' --exclude='*' \
  -e "$SSH_OPTS"

"$SSH_BIN" -o ConnectTimeout=5 -o BatchMode=yes mac \
  'd="$HOME/.kimi-code"; p="$d/session_index.jsonl"; if [ ! -e "$d" ]; then exit 2; elif [ ! -d "$d" ] || [ ! -x "$d" ]; then exit 3; elif [ -f "$p" ]; then exit 0; elif [ -e "$p" ]; then exit 3; else exit 2; fi' \
  2>/dev/null
KIMI_INDEX_PROBE_RC=$?
if [ "$KIMI_INDEX_PROBE_RC" -eq 0 ]; then
  log "→ rsync Kimi session_index"
  KIMI_INDEX_SYNCED=0
  if sync_source "kimi-session-index" file "mac:~/.kimi-code/session_index.jsonl" \
    file "$PULL_HOME/.kimi-code/session_index.macbook.jsonl" \
    "fixed:$PULL_HOME/.kimi-code/session_index.jsonl" \
    -avz --partial --rsync-path=/opt/homebrew/bin/rsync --timeout=60 \
    -e "$SSH_OPTS"; then
    KIMI_INDEX_SYNCED=1
  fi

  # 合并双机 Kimi session_index（kimi 索引用 sessionId 字段、无时间戳，MacBook 版优先）
  if [ "$KIMI_INDEX_SYNCED" -eq 1 ]; then
    KIMI_MERGE_RC=0
    PULL_HOME="$PULL_HOME" python3 - <<'PY' >> "$ROTATING_LOG" 2>&1 || KIMI_MERGE_RC=$?
import json, os, tempfile
home = os.environ["PULL_HOME"]
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
    if [ "$KIMI_MERGE_RC" -eq 0 ]; then
      record_mapping "kimi-index-merge" "$PULL_HOME/.kimi-code/session_index.macbook.jsonl" \
        "$PULL_HOME/.kimi-code/session_index.jsonl" "$PULL_HOME/.kimi-code/session_index.jsonl" "merged"
    elif [ "$SYNC_ONLY" -eq 1 ]; then
      set_failure "$KIMI_MERGE_RC" "❌ Kimi session_index merge 失败 exit=$KIMI_MERGE_RC"
      record_mapping "kimi-index-merge" "$PULL_HOME/.kimi-code/session_index.macbook.jsonl" \
        "$PULL_HOME/.kimi-code/session_index.jsonl" "$PULL_HOME/.kimi-code/session_index.jsonl" "merge-failed:$KIMI_MERGE_RC"
    else
      log "⚠️ Kimi session_index merge 失败 exit=$KIMI_MERGE_RC"
    fi
  else
    log "⚠️ Kimi session_index 同步未完成，跳过 merge"
    record_mapping "kimi-index-merge" "$PULL_HOME/.kimi-code/session_index.macbook.jsonl" \
      "$PULL_HOME/.kimi-code/session_index.jsonl" "$PULL_HOME/.kimi-code/session_index.jsonl" "derived-skipped:source-sync-failed"
  fi
elif [ "$KIMI_INDEX_PROBE_RC" -eq 2 ]; then
  log "   Kimi session_index 跳过（远端源不存在）"
  record_mapping "kimi-session-index" "mac:~/.kimi-code/session_index.jsonl" \
    "$PULL_HOME/.kimi-code/session_index.macbook.jsonl" "$PULL_HOME/.kimi-code/session_index.jsonl" "source-absent"
else
  set_failure "$KIMI_INDEX_PROBE_RC" "❌ Kimi session_index 远端探测失败 exit=$KIMI_INDEX_PROBE_RC"
  record_mapping "kimi-session-index" "mac:~/.kimi-code/session_index.jsonl" \
    "$PULL_HOME/.kimi-code/session_index.macbook.jsonl" "$PULL_HOME/.kimi-code/session_index.jsonl" \
    "probe-failed:$KIMI_INDEX_PROBE_RC"
fi

# 4c. rsync Gemini CLI sessions（~/.gemini/tmp/**/chats/session-*.json）
#      AGY 对外是一个端，但底层历史既可能来自 Gemini CLI，也可能来自 Antigravity。
#      Gemini CLI 的会话格式由 RecallNest/Deja 直接支持；此前未进双机同步链，旧会话只留在 MacBook。
log "→ rsync MacBook Gemini CLI sessions"
mkdir -p "$PULL_HOME/.gemini/tmp"
sync_source "gemini-cli" tree "mac:~/.gemini/tmp/" \
  tree "$PULL_HOME/.gemini/tmp/" same \
  -az --partial --rsync-path=/opt/homebrew/bin/rsync --timeout=120 --prune-empty-dirs \
  --include='*/' --include='session-*.json' --exclude='*' \
  -e "$SSH_OPTS"

# 4d. rsync Claude Desktop（local agent mode）本地对话 → data/desktop-import
#     desktop app 跑的 CC/local agent 对话在 ~/Library/Application Support/Claude/
#     local-agent-mode-sessions/<...>/.claude/projects/<...>/*.jsonl，标准 projects rsync 扫不到。
#     扁平化到 data/desktop-import/，复用现成 desktop 通道（config.sources.desktop / --source all）。
#     -s/--protect-args 处理远程路径空格(Application Support)；远端源使用登录 home
#     下的相对路径，既不依赖本机 HOME，也不要求远端展开 ~。
log "→ rsync Claude Desktop local-agent 对话"
DESKTOP_IMPORT="$PULL_HOME/recallnest/data/desktop-import"
DESKTOP_STAGING="$PULL_HOME/.cache/desktop-agent-staging"
mkdir -p "$DESKTOP_IMPORT" "$DESKTOP_STAGING"
DESKTOP_SYNCED=0
if sync_source "claude-desktop" tree \
  "mac:Library/Application Support/Claude/local-agent-mode-sessions/" \
  tree "$DESKTOP_STAGING/" "flat:$DESKTOP_IMPORT" \
  -az --partial --rsync-path=/opt/homebrew/bin/rsync --timeout=180 -s --prune-empty-dirs \
  --include='*/' --exclude='audit.jsonl' --include='*.jsonl' --exclude='*' \
  -e "$SSH_OPTS -o BatchMode=yes"; then
  DESKTOP_SYNCED=1
fi

# cli.ts 的 desktop 通道只读取单层目录。先对 basename 做全量冲突预检，再逐文件
# 原子复制并校验内容；任何冲突或复制失败都会让 sync-only 返回非零。
if [ "$DESKTOP_SYNCED" -eq 1 ]; then
  DESKTOP_FLATTEN_RC=0
  DESKTOP_STAGING="$DESKTOP_STAGING" DESKTOP_IMPORT="$DESKTOP_IMPORT" \
    SYNC_ONLY="$SYNC_ONLY" MAPPING_TMP="$MAPPING_TMP" \
    python3 - <<'PY' >> "$ROTATING_LOG" 2>&1 || DESKTOP_FLATTEN_RC=$?
import hashlib
import os
import shutil
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

staging = Path(os.environ["DESKTOP_STAGING"])
target = Path(os.environ["DESKTOP_IMPORT"])
sync_only = os.environ.get("SYNC_ONLY") == "1"
mapping_path = os.environ.get("MAPPING_TMP", "")

def escaped(value: object) -> str:
    return str(value).replace("\t", "\\t").replace("\n", "\\n")

def record(source: Path, destination: Path, status: str) -> None:
    if not sync_only:
        return
    with open(mapping_path, "a", encoding="utf-8") as handle:
        fields = ("desktop-flat", source, destination, destination, status)
        handle.write("\t".join(escaped(field) for field in fields) + "\n")

def digest(path: Path) -> str:
    checksum = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()

candidates = sorted(
    path for path in staging.rglob("*.jsonl")
    if path.name != "audit.jsonl" and (path.is_file() or path.is_symlink())
)
symlinks = [path for path in candidates if path.is_symlink()]
if symlinks:
    for source in symlinks:
        record(source, target / source.name, "unsafe-symlink")
        print(f"unsafe symlink: {source} -> {target / source.name}", file=sys.stderr)
    raise SystemExit(5)

files = [path for path in candidates if not path.is_symlink()]
by_name = defaultdict(list)
for path in files:
    collision_key = unicodedata.normalize("NFC", path.name).casefold()
    by_name[collision_key].append(path)

collisions = {key: paths for key, paths in by_name.items() if len(paths) > 1}
if collisions:
    for key in sorted(collisions):
        for source in collisions[key]:
            record(source, target / source.name, "basename-collision")
            print(f"basename collision: {source} -> {target / source.name}", file=sys.stderr)
    raise SystemExit(3)

target.mkdir(parents=True, exist_ok=True)
failures = 0
copied = 0
for index, source in enumerate(files):
    destination = target / source.name
    temporary = target / f".{source.name}.sync-{os.getpid()}-{index}"
    if destination.is_symlink():
        failures += 1
        record(source, destination, "unsafe-destination-symlink")
        print(f"unsafe destination symlink: {source} -> {destination}", file=sys.stderr)
        continue
    try:
        if destination.is_dir():
            raise IsADirectoryError(destination)
        if destination.is_file() and digest(source) == digest(destination):
            record(source, destination, "unchanged")
            continue
        shutil.copy2(source, temporary)
        if digest(source) != digest(temporary):
            raise OSError("pre-rename hash mismatch")
        os.replace(temporary, destination)
        copied += 1
        record(source, destination, "copied")
    except Exception as error:
        failures += 1
        record(source, destination, f"copy-failed:{type(error).__name__}")
        print(f"copy failed: {source} -> {destination}: {error}", file=sys.stderr)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass

print(f"desktop flatten files={len(files)} copied={copied} failures={failures}")
raise SystemExit(4 if failures else 0)
PY
  DESKTOP_N=$(find "$DESKTOP_STAGING" -name '*.jsonl' ! -name 'audit.jsonl' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$DESKTOP_FLATTEN_RC" -ne 0 ]; then
    set_failure "$DESKTOP_FLATTEN_RC" "❌ Desktop 对话扁平化失败 exit=$DESKTOP_FLATTEN_RC"
  else
    log "Desktop 对话扁平化 ${DESKTOP_N} 个 jsonl → data/desktop-import"
  fi
else
  log "⚠️ Desktop 源同步未完成，跳过扁平化"
  record_mapping "desktop-flat" "$DESKTOP_STAGING" "$DESKTOP_IMPORT" "$DESKTOP_IMPORT" \
    "derived-skipped:source-sync-failed"
fi

# 4e. rsync MacBook 的 agy(Antigravity) brain → ~/machine-data/macbook-agy/
#     agy 双机都在用，但它的数据既不在 .claude/projects 也不在 .codex/.kimi-code 的 sessions 下，
#     2026-07-30 之前完全没进同步链 —— MacBook 上的 agy 对话永远汇不进 mini 全集。
#     拉到独立目录而非合并进本机 ~/.gemini/，避免污染 agy 自己的数据区（UUID 虽全局唯一不会碰撞，
#     但混进别机会话会让 agy 的历史列表出现本机从没跑过的 session）。
#     conversations DB 已退出这条同步路由；这里只同步 brain 与隔离归档的 legacy .pb。
log "→ rsync MacBook agy 对话"
AGY_MAC="$PULL_HOME/machine-data/macbook-agy"
mkdir -p "$AGY_MAC/brain" "$AGY_MAC/conversations"

# brain：只拉 transcript_full.jsonl。其余是 scratch / .user_uploaded 工作文件，
# 占了 64M 里的绝大部分且对入库无用。
sync_source "agy-brain" tree "mac:~/.gemini/antigravity-cli/brain/" \
  tree "$AGY_MAC/brain/" same \
  -az --partial --rsync-path=/opt/homebrew/bin/rsync --timeout=120 --prune-empty-dirs \
  --include='*/' --include='transcript_full.jsonl' --exclude='*' \
  -e "$SSH_OPTS"

# conversations 目录只保留 mini 上已经存在的 24 份副本；这里不再从 MacBook
# 的 Antigravity conversations DB 拉取、删除或转换任何文件。

# legacy-pb：2026-07-29 由 AGY 迁移成 45 个明文 SQLite 的旧 Antigravity IDE 原件。
# 明文内容已在 mini，但加密 .pb 原件此前仍只留在 MacBook Downloads；只读复制到隔离归档，
# 不放进 ~/.gemini，也不让任何自动任务回写源目录。
mkdir -p "$AGY_MAC/legacy-pb"
"$SSH_BIN" -o ConnectTimeout=5 -o BatchMode=yes mac \
  'd="$HOME/Downloads/antigravity-rescue"; p="$d/conversations"; if [ ! -e "$d" ]; then exit 2; elif [ ! -d "$d" ] || [ ! -x "$d" ]; then exit 3; elif [ -d "$p" ] && [ -x "$p" ]; then exit 0; elif [ -e "$p" ]; then exit 3; else exit 2; fi' \
  2>/dev/null
LEGACY_PB_PROBE_RC=$?
if [ "$LEGACY_PB_PROBE_RC" -eq 0 ]; then
  sync_source "agy-legacy-pb" tree \
    "mac:~/Downloads/antigravity-rescue/conversations/" \
    tree "$AGY_MAC/legacy-pb/" same \
    -az --partial --rsync-path=/opt/homebrew/bin/rsync --timeout=180 \
    --include='*.pb' --exclude='*' \
    -e "$SSH_OPTS"
elif [ "$LEGACY_PB_PROBE_RC" -eq 2 ]; then
  log "   agy legacy .pb 跳过（远端源不存在）"
  record_mapping "agy-legacy-pb" "mac:~/Downloads/antigravity-rescue/conversations/" \
    "$AGY_MAC/legacy-pb/" "$AGY_MAC/legacy-pb/" "source-absent"
else
  set_failure "$LEGACY_PB_PROBE_RC" "❌ agy legacy .pb 远端探测失败 exit=$LEGACY_PB_PROBE_RC"
  record_mapping "agy-legacy-pb" "mac:~/Downloads/antigravity-rescue/conversations/" \
    "$AGY_MAC/legacy-pb/" "$AGY_MAC/legacy-pb/" "probe-failed:$LEGACY_PB_PROBE_RC"
fi

log "MacBook agy 同步结果：brain $(find "$AGY_MAC/brain" -name transcript_full.jsonl 2>/dev/null | wc -l | tr -d ' ') 个 transcript / mini 保留 conversations $(ls "$AGY_MAC/conversations"/*.db 2>/dev/null | wc -l | tr -d ' ') 个 db / legacy-pb $(find "$AGY_MAC/legacy-pb" -maxdepth 1 -name '*.pb' 2>/dev/null | wc -l | tr -d ' ') 个原件"

if [ "$SYNC_ONLY" -eq 1 ]; then
  if [ "$EC" -eq 0 ]; then
    log "sync-only 同步与派生复核完成"
  else
    log "sync-only 部分失败 exit=$EC"
  fi
  finalize_mapping_report
  log "=== pull 结束（sync-only） ==="
  exit "$EC"
fi

# 5. 触发 incremental-ingest（无论上面有没有 partial 失败，已拉到的部分也值得 ingest）
if [ $EC -eq 0 ]; then
  log "✅ rsync 完成，触发 ingest"
else
  log "⚠️ rsync 部分失败 exit=${EC}，仍触发 ingest 处理已拉到的部分"
fi

bash "$PULL_HOME/recallnest/scripts/incremental-ingest.sh"
log "ingest 完成 exit=$?"

# 保留 14 天日志
find "$LOG_DIR" -name "pull-*.log" -mtime +14 -delete 2>/dev/null

log "=== pull 结束 ==="
exit $EC
