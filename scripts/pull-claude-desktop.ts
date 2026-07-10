#!/usr/bin/env bun
/**
 * pull-claude-desktop.ts
 *
 * 从 claude.ai 拉取 Claude Desktop / 网页版对话历史，
 * 转成 CC transcript .jsonl 格式，供 `lm ingest --source desktop` 消费。
 *
 * 用法：
 *   CLAUDE_SESSION_KEY="sk-ant-..." bun scripts/pull-claude-desktop.ts
 *   CLAUDE_SESSION_KEY="sk-ant-..." bun scripts/pull-claude-desktop.ts --limit 10
 *   CLAUDE_SESSION_KEY="sk-ant-..." bun scripts/pull-claude-desktop.ts --since 2025-01-01
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

// ============================================================================
// Config
// ============================================================================

const BASE_URL = "https://claude.ai";
const PAGE_SIZE = 50;
const THROTTLE_MS = 200;
const MAX_RETRIES = 3;
const OUTPUT_DIR = join(import.meta.dir, "..", "data", "desktop-import");
const SYNC_STATE_PATH = join(OUTPUT_DIR, ".sync-state.json");

// ============================================================================
// Types
// ============================================================================

interface SyncState {
  lastSyncedAt: string;
  conversations: Record<
    string,
    {
      messageCount: number;
      updatedAt: string;
      pulledAt: string;
      name: string;
      /** Consecutive pull failures (Gemini #26522 lesson: failures must also
       *  leave a state mark, or the item stays a candidate forever) */
      failCount?: number;
      /** ISO timestamp of the last failure, drives exponential backoff */
      failedAt?: string;
    }
  >;
}

interface ConversationSummary {
  uuid: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface ChatMessage {
  uuid: string;
  text: string;
  sender: "human" | "assistant";
  index: number;
  created_at: string;
  parent_message_uuid: string;
  content: Array<{
    type: "text" | "thinking" | "tool_use" | "tool_result";
    text?: string;
    name?: string;
    input?: unknown;
  }>;
  attachments?: Array<{
    file_name: string;
    file_type?: string;
    file_size?: number;
  }>;
}

interface Conversation {
  uuid: string;
  name: string;
  created_at: string;
  updated_at: string;
  chat_messages: ChatMessage[];
}

// ============================================================================
// HTTP Client
// ============================================================================

class ClaudeApiClient {
  private sessionKey: string;
  private orgId: string | null = null;
  private throttleMs = THROTTLE_MS;

  constructor(sessionKey: string) {
    this.sessionKey = sessionKey;
  }

  private async request(path: string): Promise<any> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(`${BASE_URL}${path}`, {
          headers: {
            Cookie: `sessionKey=${this.sessionKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        });

        if (res.status === 401 || res.status === 403) {
          throw new Error(
            `认证失败 (${res.status})。sessionKey 可能已过期，请从浏览器重新获取。`,
          );
        }

        if (res.status === 429) {
          this.throttleMs = Math.min(this.throttleMs * 2, 5000);
          console.log(`  ⚠️  限流，等待 ${this.throttleMs}ms...`);
          await sleep(this.throttleMs);
          continue;
        }

        if (res.status >= 500) {
          const waitMs = Math.pow(2, attempt) * 1000;
          console.log(
            `  ⚠️  服务器错误 ${res.status}，${waitMs}ms 后重试...`,
          );
          await sleep(waitMs);
          continue;
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        }

        // Reset throttle on success
        this.throttleMs = THROTTLE_MS;
        return await res.json();
      } catch (err: any) {
        if (
          err.message?.includes("认证失败") ||
          err.message?.startsWith("HTTP ")
        ) {
          throw err;
        }
        lastError = err;
        const waitMs = Math.pow(2, attempt) * 1000;
        console.log(`  ⚠️  网络错误: ${err.message}，${waitMs}ms 后重试...`);
        await sleep(waitMs);
      }
    }

    throw lastError || new Error("请求失败，已重试 3 次");
  }

  async getOrgId(): Promise<string> {
    if (this.orgId) return this.orgId;
    const orgs = await this.request("/api/organizations");
    if (!Array.isArray(orgs) || orgs.length === 0) {
      throw new Error("获取 organization 失败。请确认 sessionKey 有效。");
    }
    this.orgId = orgs[0].uuid;
    return this.orgId!;
  }

  async listConversations(
    offset: number = 0,
  ): Promise<ConversationSummary[]> {
    const orgId = await this.getOrgId();
    return await this.request(
      `/api/organizations/${orgId}/chat_conversations?limit=${PAGE_SIZE}&offset=${offset}`,
    );
  }

  async getConversation(chatId: string): Promise<Conversation> {
    const orgId = await this.getOrgId();
    return await this.request(
      `/api/organizations/${orgId}/chat_conversations/${chatId}?tree=True&rendering_mode=messages&render_all_tools=true`,
    );
  }

  async throttle(): Promise<void> {
    await sleep(this.throttleMs);
  }
}

// ============================================================================
// Branch Extraction
// ============================================================================

function extractLatestBranch(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return [];

  const byUuid = new Map<string, ChatMessage>();
  for (const msg of messages) {
    byUuid.set(msg.uuid, msg);
  }

  // Find all parent UUIDs
  const parentUuids = new Set<string>();
  for (const msg of messages) {
    if (msg.parent_message_uuid) {
      parentUuids.add(msg.parent_message_uuid);
    }
  }

  // Leaves = messages that are not anyone's parent
  const leaves = messages.filter((m) => !parentUuids.has(m.uuid));
  if (leaves.length === 0) return messages;

  // Pick the leaf with the latest timestamp
  const latestLeaf = leaves.reduce((a, b) =>
    new Date(a.created_at).getTime() >= new Date(b.created_at).getTime()
      ? a
      : b,
  );

  // Walk backwards from leaf to root
  const branch: ChatMessage[] = [];
  let current: ChatMessage | undefined = latestLeaf;
  const visited = new Set<string>();

  while (current && !visited.has(current.uuid)) {
    visited.add(current.uuid);
    branch.push(current);
    current = current.parent_message_uuid
      ? byUuid.get(current.parent_message_uuid)
      : undefined;
  }

  branch.reverse();
  return branch;
}

// ============================================================================
// Format Conversion
// ============================================================================

function messageToText(msg: ChatMessage): string {
  const parts: string[] = [];

  if (Array.isArray(msg.content) && msg.content.length > 0) {
    for (const block of msg.content) {
      if (block.type === "text" && block.text) {
        parts.push(block.text);
      }
      // Skip thinking, tool_use, tool_result — noise for memory
    }
  } else if (msg.text) {
    // Fallback: use raw text field
    parts.push(msg.text);
  }

  // Mark attachments
  if (Array.isArray(msg.attachments)) {
    for (const att of msg.attachments) {
      parts.push(`[Attachment: ${att.file_name}]`);
    }
  }

  return parts.join("\n").trim();
}

function convertToCCTranscript(
  conversation: Conversation,
): string[] {
  const branch = extractLatestBranch(conversation.chat_messages || []);
  const lines: string[] = [];

  for (const msg of branch) {
    const text = messageToText(msg);
    if (!text || text.length < 5) continue;

    const type = msg.sender === "human" ? "user" : "assistant";
    const entry = {
      type,
      message: {
        role: type,
        content: text,
      },
      sessionId: conversation.uuid,
      timestamp: msg.created_at,
      uuid: msg.uuid,
      parentUuid: msg.parent_message_uuid || undefined,
    };

    lines.push(JSON.stringify(entry));
  }

  return lines;
}

// ============================================================================
// Sync State
// ============================================================================

function loadSyncState(): SyncState {
  if (existsSync(SYNC_STATE_PATH)) {
    try {
      return JSON.parse(readFileSync(SYNC_STATE_PATH, "utf-8"));
    } catch {
      // Corrupted, start fresh
    }
  }
  return { lastSyncedAt: "", conversations: {} };
}

function saveSyncState(state: SyncState): void {
  writeFileSync(SYNC_STATE_PATH, JSON.stringify(state, null, 2));
}

// Failure backoff: 4h base, doubling per consecutive failure; after
// FAIL_MAX_RETRIES the item is parked until its content actually changes again.
const FAIL_BACKOFF_BASE_MS = 4 * 3600_000;
const FAIL_MAX_RETRIES = 5;

function needsPull(
  state: SyncState,
  conv: ConversationSummary,
): boolean {
  const existing = state.conversations[conv.uuid];
  if (!existing) return true;
  // No content change since last successful pull → nothing to do
  if (conv.updated_at === existing.updatedAt) return false;

  const fails = existing.failCount ?? 0;
  if (fails > 0 && existing.failedAt) {
    const failedAtMs = new Date(existing.failedAt).getTime();
    if (fails >= FAIL_MAX_RETRIES) {
      // Parked: only retry if the conversation changed AFTER the last failure
      return new Date(conv.updated_at).getTime() > failedAtMs;
    }
    const backoffMs = FAIL_BACKOFF_BASE_MS * 2 ** (fails - 1);
    if (Date.now() - failedAtMs < backoffMs) return false;
  }
  return true;
}

// ============================================================================
// Main
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "session-key": { type: "string" },
      limit: { type: "string" },
      since: { type: "string" },
      verbose: { type: "boolean", default: false },
    },
    strict: false,
  });

  const sessionKey =
    values["session-key"] ||
    process.env.CLAUDE_SESSION_KEY ||
    process.env.CLAUDE_DESKTOP_SESSION_KEY;

  if (!sessionKey) {
    console.error(
      "❌ 需要 sessionKey。用法：\n" +
        "   CLAUDE_SESSION_KEY='...' bun scripts/pull-claude-desktop.ts\n\n" +
        "获取方式：浏览器登录 claude.ai → DevTools → Application → Cookies → sessionKey",
    );
    process.exit(1);
  }

  const limit = values.limit ? parseInt(values.limit, 10) : Infinity;
  const sinceDate = values.since ? new Date(values.since) : null;
  const verbose = values.verbose ?? false;

  // Ensure output directory
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const client = new ClaudeApiClient(sessionKey);
  const state = loadSyncState();

  // Step 1: Verify auth
  console.log("🔑 验证 sessionKey...");
  try {
    const orgId = await client.getOrgId();
    console.log(`  ✅ 认证成功 (org: ${orgId.slice(0, 8)}...)`);
  } catch (err: any) {
    console.error(`  ❌ ${err.message}`);
    process.exit(1);
  }

  // Step 2: List all conversations (paginated)
  console.log("\n📋 获取对话列表...");
  const allConversations: ConversationSummary[] = [];
  let offset = 0;
  let pageCount = 0;

  while (true) {
    const page = await client.listConversations(offset);
    if (!Array.isArray(page) || page.length === 0) break;

    // Filter by --since if specified
    for (const conv of page) {
      if (sinceDate && new Date(conv.updated_at) < sinceDate) {
        // API returns newest first; once we hit older, stop
        console.log(
          `  ⏭️  跳过 ${conv.updated_at} 之前的对话 (--since ${values.since})`,
        );
        break;
      }
      allConversations.push(conv);
    }

    pageCount++;
    process.stdout.write(
      `  已扫描 ${allConversations.length} 条对话 (第 ${pageCount} 页)...\r`,
    );

    // Stop if we hit the since boundary or got a short page
    if (sinceDate) {
      const lastOnPage = page[page.length - 1];
      if (new Date(lastOnPage.updated_at) < sinceDate) break;
    }
    if (page.length < PAGE_SIZE) break;

    offset += PAGE_SIZE;
    await client.throttle();
  }

  console.log(`  ✅ 共发现 ${allConversations.length} 条对话`);

  // Step 3: Filter — skip already-synced
  const toPull = allConversations.filter((c) => needsPull(state, c));
  const toSkip = allConversations.length - toPull.length;

  if (toSkip > 0) {
    console.log(`  ⏭️  ${toSkip} 条已同步，跳过`);
  }

  // Apply --limit
  const batch = toPull.slice(0, limit);
  if (batch.length === 0) {
    console.log("\n✅ 没有需要拉取的新对话。");
    return;
  }

  console.log(`\n🔄 开始拉取 ${batch.length} 条对话...\n`);

  // Step 4: Pull each conversation
  let pulled = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < batch.length; i++) {
    const conv = batch[i];
    const label = conv.name?.slice(0, 40) || conv.uuid.slice(0, 8);

    try {
      process.stdout.write(
        `  [${i + 1}/${batch.length}] ${label}...`,
      );

      const full = await client.getConversation(conv.uuid);
      const lines = convertToCCTranscript(full);

      if (lines.length === 0) {
        console.log(` ⏭️  空对话`);
        skipped++;
      } else {
        const outPath = join(OUTPUT_DIR, `${conv.uuid}.jsonl`);
        writeFileSync(outPath, lines.join("\n") + "\n");
        console.log(` ✅ ${lines.length} 条消息`);
        pulled++;
      }

      // Update sync state
      state.conversations[conv.uuid] = {
        messageCount: lines.length,
        updatedAt: conv.updated_at,
        pulledAt: new Date().toISOString(),
        name: conv.name || "",
      };

      // Save state periodically (every 10 conversations)
      if ((i + 1) % 10 === 0) {
        state.lastSyncedAt = new Date().toISOString();
        saveSyncState(state);
      }

      await client.throttle();
    } catch (err: any) {
      console.log(` ❌ ${err.message}`);
      errors.push(`${label}: ${err.message}`);
      failed++;

      // Record the failure in sync state so the item backs off instead of
      // resurfacing as a fresh candidate on every run. Keep the previous
      // updatedAt (NOT conv.updated_at — that would fake a successful pull).
      const prev = state.conversations[conv.uuid];
      state.conversations[conv.uuid] = {
        messageCount: prev?.messageCount ?? 0,
        updatedAt: prev?.updatedAt ?? "",
        pulledAt: prev?.pulledAt ?? "",
        name: conv.name || prev?.name || "",
        failCount: (prev?.failCount ?? 0) + 1,
        failedAt: new Date().toISOString(),
      };

      // Don't abort on single conversation failure
      await client.throttle();
    }
  }

  // Final save
  state.lastSyncedAt = new Date().toISOString();
  saveSyncState(state);

  // Step 5: Summary
  console.log("\n📊 拉取汇总:");
  console.log(`  总对话数: ${allConversations.length}`);
  console.log(`  已同步跳过: ${toSkip}`);
  console.log(`  本次拉取: ${pulled}`);
  console.log(`  空对话跳过: ${skipped}`);
  console.log(`  失败: ${failed}`);
  console.log(`  输出目录: ${OUTPUT_DIR}`);

  if (errors.length > 0) {
    console.log("\n⚠️  失败详情:");
    for (const e of errors.slice(0, 10)) {
      console.log(`  - ${e}`);
    }
  }

  if (pulled > 0) {
    console.log(
      "\n🎯 下一步：运行以下命令将对话导入 RecallNest：",
    );
    console.log("   bun run src/cli.ts ingest --source desktop");
  }
}

main().catch((err) => {
  console.error(`\n❌ 致命错误: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
