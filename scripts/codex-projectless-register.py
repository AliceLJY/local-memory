#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time


def is_generated_codex_cwd(home, cwd):
    if not cwd:
        return False
    generated_root = os.path.join(home, "Documents", "Codex")
    try:
        return os.path.commonpath([os.path.abspath(cwd), generated_root]) == generated_root
    except ValueError:
        return False


def atomic_write(path, text):
    directory = os.path.dirname(path)
    fd, tmp_path = tempfile.mkstemp(prefix=".codex-global-state.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def load_thread(db_path, thread_id):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        return con.execute(
            """
            select id, title, cwd, source, thread_source, archived
            from threads
            where id = ?
            """,
            (thread_id,),
        ).fetchone()
    finally:
        con.close()


def main():
    parser = argparse.ArgumentParser(
        description="Register existing Codex threads as projectless conversations in the Codex App global state."
    )
    parser.add_argument("thread_ids", nargs="*")
    parser.add_argument(
        "--all-vscode-user",
        action="store_true",
        help="Register non-archived vscode/user threads whose cwd is outside ~/Documents/Codex.",
    )
    parser.add_argument(
        "--include-generated-codex-cwds",
        action="store_true",
        help="With --all-vscode-user, also register ordinary projectless conversation cwd paths under ~/Documents/Codex.",
    )
    parser.add_argument("--home", default=os.path.expanduser("~"))
    parser.add_argument("--root", default=None, help="Workspace root hint to write for projectless sidebar grouping.")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    home = os.path.abspath(os.path.expanduser(args.home))
    state_path = os.path.join(home, ".codex", ".codex-global-state.json")
    db_path = os.path.join(home, ".codex", "state_5.sqlite")
    root_hint = os.path.abspath(os.path.expanduser(args.root or os.path.join(home, "Documents", "Codex")))

    with open(state_path, "r", encoding="utf-8") as f:
        state = json.load(f)

    atom = state.setdefault("electron-persisted-atom-state", {})
    projectless_ids = atom.setdefault("projectless-thread-ids", [])
    hints = atom.setdefault("thread-workspace-root-hints", {})

    if not isinstance(projectless_ids, list):
        raise SystemExit("projectless-thread-ids is not a list; refusing to modify global state")
    if not isinstance(hints, dict):
        raise SystemExit("thread-workspace-root-hints is not an object; refusing to modify global state")

    thread_ids = list(args.thread_ids)
    if args.all_vscode_user:
        con = sqlite3.connect(db_path)
        try:
            rows = con.execute(
                """
                select id, cwd
                from threads
                where archived = 0
                  and source = 'vscode'
                  and thread_source = 'user'
                order by created_at asc
                """
            ).fetchall()
        finally:
            con.close()
        for thread_id, cwd in rows:
            if not args.include_generated_codex_cwds and is_generated_codex_cwd(home, cwd):
                continue
            if thread_id not in thread_ids:
                thread_ids.append(thread_id)

    if not thread_ids:
        raise SystemExit("provide at least one thread id or pass --all-vscode-user")

    changed = False
    results = []
    for thread_id in thread_ids:
        row = load_thread(db_path, thread_id)
        if row is None:
            results.append({"id": thread_id, "status": "missing_from_state_db"})
            continue
        if row["archived"]:
            results.append({"id": thread_id, "status": "archived_skipped", "title": row["title"]})
            continue

        was_projectless = thread_id in projectless_ids
        if not was_projectless:
            projectless_ids.append(thread_id)
            changed = True

        old_hint = hints.get(thread_id)
        if old_hint != root_hint:
            hints[thread_id] = root_hint
            changed = True

        results.append(
            {
                "id": thread_id,
                "status": "registered" if not was_projectless or old_hint != root_hint else "already_registered",
                "title": row["title"],
                "cwd": row["cwd"],
                "source": row["source"],
                "thread_source": row["thread_source"],
                "root_hint": root_hint,
            }
        )

    if changed and not args.dry_run:
        backup_path = f"{state_path}.codex-projectless-register.{int(time.time())}.bak"
        shutil.copy2(state_path, backup_path)
        atomic_write(state_path, json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    else:
        backup_path = None

    print(json.dumps({"changed": changed, "dry_run": args.dry_run, "backup": backup_path, "results": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
