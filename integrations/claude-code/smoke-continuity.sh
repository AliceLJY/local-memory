#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
OUT_DIR="${RECALLNEST_CC_SMOKE_OUT_DIR:-/tmp/recallnest-claude-smoke-$(date +%Y%m%d-%H%M%S)}"
OBSERVATION_SCOPE="${RECALLNEST_CC_SMOKE_SCOPE:-project:recallnest}"
OBSERVATION_SOURCE="${RECALLNEST_CC_SMOKE_SOURCE:-smoke}"
RECORD_OBSERVATIONS="${RECALLNEST_RECORD_WORKFLOW_OBSERVATIONS:-1}"

CONTINUE_PROMPT="继续 RecallNest，不要让我重复前情。先按 continuity 规则恢复上下文，再用一句话说明你接下来会做什么。"
CHECKPOINT_PROMPT="继续 RecallNest，不要让我重复前情。先恢复上下文；但我现在要关窗口，请在结束前保存 checkpoint_session，并用两句话告诉我你保存了什么。"
REPO_TOOL_PATTERN='"name":"(Read|Bash|Grep|Glob)"'
REPO_STATE_PATTERN='git status|未提交|staged|uncommitted|已修改文件|modified files|untracked|新增文件|dirty repo|dirty worktree'

need_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

log_step() {
  local message="$1"
  printf '[smoke] %s\n' "$message" >&2
}

record_workflow_observation() {
  local workflow_id="$1"
  local outcome="$2"
  local summary="$3"
  local signal="${4:-}"
  local task="${5:-}"
  local tools="${6:-}"

  if [[ "$RECORD_OBSERVATIONS" == "0" ]]; then
    return 0
  fi

  local cmd=(
    bun run src/cli.ts workflow-observe
    "$workflow_id"
    "$summary"
    --outcome "$outcome"
    --scope "$OBSERVATION_SCOPE"
    --source "$OBSERVATION_SOURCE"
    --tags "continuity,claude-smoke"
  )

  if [[ -n "$signal" ]]; then
    cmd+=(--signal "$signal")
  fi
  if [[ -n "$task" ]]; then
    cmd+=(--task "$task")
  fi
  if [[ -n "$tools" ]]; then
    cmd+=(--tools "$tools")
  fi

  (
    cd "$ROOT_DIR"
    "${cmd[@]}"
  ) >/dev/null
}

record_and_fail() {
  local workflow_id="$1"
  local outcome="$2"
  local summary="$3"
  local signal="${4:-}"
  local task="${5:-}"
  local tools="${6:-}"

  record_workflow_observation "$workflow_id" "$outcome" "$summary" "$signal" "$task" "$tools"
  echo "FAIL: $summary" >&2
  exit 1
}

first_match_line() {
  local pattern="$1"
  local file="$2"
  rg -n --max-count 1 "$pattern" "$file" | cut -d: -f1 || true
}

run_case() {
  local name="$1"
  local allowed_tools="$2"
  local prompt="$3"
  local output_file="$OUT_DIR/$name.jsonl"

  "$CLAUDE_BIN" \
    -p \
    --verbose \
    --output-format stream-json \
    --permission-mode dontAsk \
    --allowedTools="$allowed_tools" \
    "$prompt" >"$output_file"

  echo "$output_file"
}

assert_no_permission_denials() {
  local file="$1"
  local workflow_id="$2"
  local task="$3"
  local tools="$4"
  if rg -q '"permission_denials":\[\{' "$file"; then
    record_and_fail \
      "$workflow_id" \
      "failure" \
      "Claude Code smoke ${task} hit a permission denial before completing the RecallNest flow." \
      "permission-denied" \
      "$task" \
      "$tools"
  fi
}

assert_resume_before_repo_tools() {
  local file="$1"
  local task="$2"
  local resume_line repo_tool_line

  resume_line="$(first_match_line '"name":"mcp__recallnest__resume_context"' "$file")"
  repo_tool_line="$(first_match_line "$REPO_TOOL_PATTERN" "$file")"

  if [[ -z "$resume_line" ]]; then
    record_and_fail \
      "resume_context" \
      "missed" \
      "Claude Code smoke ${task} never called resume_context." \
      "missing-resume-context" \
      "$task" \
      "resume_context"
  fi

  if [[ -n "$repo_tool_line" && "$repo_tool_line" -lt "$resume_line" ]]; then
    record_and_fail \
      "resume_context" \
      "missed" \
      "Claude Code smoke ${task} explored the repo before resume_context." \
      "resume-after-repo-tool" \
      "$task" \
      "resume_context"
  fi
}

describe_unverified_repo_state_sources() {
  local file="$1"
  local repo_tool_line recalled_line assistant_line checkpoint_request_line checkpoint_saved_line any_line
  local sources=()

  repo_tool_line="$(first_match_line "$REPO_TOOL_PATTERN" "$file")"
  if [[ -n "$repo_tool_line" ]]; then
    return 0
  fi

  recalled_line="$(first_match_line "Resume context.*($REPO_STATE_PATTERN)" "$file")"
  assistant_line="$(first_match_line "(\"type\":\"assistant\".*\"content\":\\[\\{\"type\":\"text\",\"text\":.*($REPO_STATE_PATTERN)|\"subtype\":\"success\".*($REPO_STATE_PATTERN))" "$file")"
  checkpoint_request_line="$(first_match_line "\"name\":\"mcp__recallnest__checkpoint_session\".*($REPO_STATE_PATTERN)" "$file")"
  checkpoint_saved_line="$(first_match_line "Checkpoint [0-9a-f]+.*($REPO_STATE_PATTERN)" "$file")"
  any_line="$(first_match_line "$REPO_STATE_PATTERN" "$file")"

  if [[ -n "$recalled_line" ]]; then
    sources+=("resume_context:$recalled_line")
  fi
  if [[ -n "$assistant_line" ]]; then
    sources+=("assistant:$assistant_line")
  fi
  if [[ -n "$checkpoint_request_line" ]]; then
    sources+=("checkpoint_request:$checkpoint_request_line")
  fi
  if [[ -n "$checkpoint_saved_line" ]]; then
    sources+=("checkpoint_saved:$checkpoint_saved_line")
  fi
  if [[ ${#sources[@]} -eq 0 && -n "$any_line" ]]; then
    sources+=("unknown:$any_line")
  fi

  if [[ ${#sources[@]} -gt 0 ]]; then
    printf '%s\n' "${sources[*]}"
  fi
}

warn_if_repo_state_claims_are_unverified() {
  local file="$1"
  local sources

  sources="$(describe_unverified_repo_state_sources "$file")"
  if [[ -n "$sources" ]]; then
    echo "WARN: unverified repo-state text without visible repo exploration in $file ($sources)" >&2
  fi
}

assert_checkpoint_repo_state_claims_are_verified() {
  local file="$1"
  local task="$2"
  local checkpoint_saved_line

  checkpoint_saved_line="$(first_match_line "Checkpoint [0-9a-f]+.*($REPO_STATE_PATTERN)" "$file")"
  if [[ -n "$checkpoint_saved_line" ]] && ! rg -q "$REPO_TOOL_PATTERN" "$file"; then
    record_and_fail \
      "checkpoint_session" \
      "failure" \
      "Claude Code smoke ${task} saved repo-state text into checkpoint_session without visible repo verification." \
      "repo-state-contamination" \
      "$task" \
      "resume_context,checkpoint_session"
  fi
}

extract_checkpoint_id() {
  local file="$1"
  rg -o --max-count 1 'Checkpoint [0-9a-f]{8,}' "$file" | awk '{print $2}' || true
}

summarize_case() {
  local label="$1"
  local file="$2"
  local resume_line checkpoint_line repo_tool_line checkpoint_id repo_state_sources

  resume_line="$(first_match_line '"name":"mcp__recallnest__resume_context"' "$file")"
  checkpoint_line="$(first_match_line '"name":"mcp__recallnest__checkpoint_session"' "$file")"
  repo_tool_line="$(first_match_line "$REPO_TOOL_PATTERN" "$file")"
  checkpoint_id="$(extract_checkpoint_id "$file")"
  repo_state_sources="$(describe_unverified_repo_state_sources "$file")"

  echo "$label"
  echo "  log: $file"
  echo "  resume_context line: ${resume_line:-missing}"
  if [[ -n "$repo_tool_line" ]]; then
    echo "  first repo tool line: $repo_tool_line"
  else
    echo "  first repo tool line: none"
  fi
  if [[ -n "$checkpoint_line" ]]; then
    echo "  checkpoint_session line: $checkpoint_line"
  fi
  if [[ -n "$checkpoint_id" ]]; then
    echo "  checkpoint id: $checkpoint_id"
  fi
  if [[ -n "$repo_state_sources" ]]; then
    echo "  unverified repo-state sources: $repo_state_sources"
  fi
}

need_cmd "$CLAUDE_BIN"
need_cmd rg
need_cmd bun

mkdir -p "$OUT_DIR"

continue_log="$(
  cd "$ROOT_DIR" && \
    log_step "Running continue case..."
    run_case \
      "continue" \
      "ToolSearch,mcp__recallnest__resume_context" \
      "$CONTINUE_PROMPT"
)"

assert_no_permission_denials "$continue_log" "resume_context" "claude-code smoke continue" "resume_context"
assert_resume_before_repo_tools "$continue_log" "claude-code smoke continue"
warn_if_repo_state_claims_are_unverified "$continue_log"
record_workflow_observation \
  "resume_context" \
  "success" \
  "Claude Code smoke continue case recovered continuity before any visible repo tools." \
  "startup-recovered" \
  "claude-code smoke continue" \
  "resume_context"

checkpoint_log="$(
  cd "$ROOT_DIR" && \
    log_step "Running checkpoint case..."
    run_case \
      "checkpoint" \
      "ToolSearch,mcp__recallnest__resume_context,mcp__recallnest__checkpoint_session" \
      "$CHECKPOINT_PROMPT"
)"

assert_no_permission_denials "$checkpoint_log" "resume_context" "claude-code smoke checkpoint" "resume_context,checkpoint_session"
assert_resume_before_repo_tools "$checkpoint_log" "claude-code smoke checkpoint"

resume_line="$(first_match_line '"name":"mcp__recallnest__resume_context"' "$checkpoint_log")"
checkpoint_line="$(first_match_line '"name":"mcp__recallnest__checkpoint_session"' "$checkpoint_log")"

if [[ -z "$checkpoint_line" ]]; then
  record_and_fail \
    "checkpoint_session" \
    "missed" \
    "Claude Code smoke checkpoint case never called checkpoint_session." \
    "missing-checkpoint-session" \
    "claude-code smoke checkpoint" \
    "resume_context,checkpoint_session"
fi

if [[ "$checkpoint_line" -lt "$resume_line" ]]; then
  record_and_fail \
    "checkpoint_session" \
    "failure" \
    "Claude Code smoke checkpoint case called checkpoint_session before resume_context." \
    "checkpoint-before-resume" \
    "claude-code smoke checkpoint" \
    "resume_context,checkpoint_session"
fi

assert_checkpoint_repo_state_claims_are_verified "$checkpoint_log" "claude-code smoke checkpoint"
warn_if_repo_state_claims_are_unverified "$checkpoint_log"
record_workflow_observation \
  "checkpoint_session" \
  "success" \
  "Claude Code smoke checkpoint case saved a clean checkpoint after continuity recovery." \
  "checkpoint-saved-cleanly" \
  "claude-code smoke checkpoint" \
  "resume_context,checkpoint_session"

echo "Claude Code continuity smoke passed."
echo "Artifacts saved under: $OUT_DIR"
if [[ "$RECORD_OBSERVATIONS" != "0" ]]; then
  echo "Workflow observations stored under scope: $OBSERVATION_SCOPE"
fi
summarize_case "Continue case:" "$continue_log"
summarize_case "Checkpoint case:" "$checkpoint_log"
