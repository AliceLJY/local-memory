# RecallNest Operations

This file is the short operator memo for common actions.

## Release Checklist

After a version bump (or whenever tools/ROADMAP change), refresh the
self-capability digest so RN can answer "你有哪些工具/能力":

```bash
cd $HOME/recallnest
bun run scripts/seed-capability-digest.ts          # canonicalKey upsert,重跑即覆盖
bun run scripts/seed-capability-digest.ts --dry-run  # 只预览
```

Digests land in scope `recallnest:self` (4 entries: core/advanced/governance/overview).

## Open The UI

### Manual

```bash
cd $HOME/recallnest
bun run src/ui-server.ts
```

Then open:

```text
http://localhost:4317
```

### Ask Codex

Use either of these:

- `帮我启动 RecallNest UI`
- `帮我打开 RecallNest 记忆工作台`
- `帮我把 RecallNest 的本地界面跑起来`

Expected result:
- local UI server starts
- browser target is `http://localhost:4317`

## Quick Intent Phrases

### Search
- `帮我在 RecallNest 里搜 telegram bridge`
- `帮我查一下过去关于 OpenClaw memory 的记录`

### Distill
- `帮我把 OpenClaw 记忆系统蒸馏成 briefing`

### Brief
- `帮我把这个主题做成一个 brief asset`

### Assets
- `帮我打开 Assets 视图`
- `帮我看一下有哪些 memory assets`

### Cleanup
- `帮我检查有没有 dirty briefs`
- `帮我清理旧的脏 brief`

## Product Position

RecallNest should be operated primarily through:

1. MCP
2. UI

CLI is an implementation layer, not the main product surface.
