#!/usr/bin/env bash

install_managed_markdown_block() {
  local snippet_path="$1"
  local target_path="$2"
  local marker_name="$3"

  if [[ ! -f "$snippet_path" ]]; then
    echo "ERROR: snippet not found: $snippet_path" >&2
    return 1
  fi

  mkdir -p "$(dirname "$target_path")"
  touch "$target_path"

  local start_marker="<!-- ${marker_name}:start -->"
  local end_marker="<!-- ${marker_name}:end -->"
  local tmp_file
  tmp_file="$(mktemp)"
  local tmp_body
  tmp_body="$(mktemp)"

  awk -v start="$start_marker" -v end="$end_marker" '
    BEGIN {
      in_block = 0
    }
    $0 == start {
      in_block = 1
      next
    }
    $0 == end {
      in_block = 0
      next
    }
    !in_block {
      print
    }
  ' "$target_path" > "$tmp_body"

  printf '%s\n' "$start_marker" > "$tmp_file"
  awk '1' "$snippet_path" >> "$tmp_file"
  printf '%s\n' "$end_marker" >> "$tmp_file"

  if [[ -s "$tmp_body" ]]; then
    printf '\n' >> "$tmp_file"
    cat "$tmp_body" >> "$tmp_file"
  fi

  mv "$tmp_file" "$target_path"
  rm -f "$tmp_body"
}
