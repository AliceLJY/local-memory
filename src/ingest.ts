/**
 * Ingest Pipeline — 把各种来源的对话/文件转成 MemoryEntry 喂进 LanceDB
 *
 * 支持的数据源：
 * 1. Claude Code transcript (.jsonl) — 提取 user/assistant 对话轮次
 * 2. Codex sessions (.jsonl) — 提取 response_item + event_msg
 * 3. Markdown 记忆文件 (.md) — 按标题分块
 * 4. Gemini conversations — 暂不支持（加密 protobuf，等官方开放导出）
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import type { MemoryStore, MemoryEntry } from "./store.js";
import type { Embedder } from "./embedder.js";
import { chunkDocument, type ChunkerConfig } from "./chunker.js";
import { isProcessed, markProcessed } from "./tracker.js";

// ============================================================================
// Types
// ============================================================================

export interface IngestSource {
  path: string;
  glob: string;
  description: string;
}

export interface IngestResult {
  source: string;
  filesProcessed: number;
  chunksIngested: number;
  chunksSkipped: number;
  errors: string[];
}

interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  sessionId: string;
}

// ============================================================================
// Helpers
// ============================================================================

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function matchGlob(filename: string, glob: string): boolean {
  // Simple glob: *.jsonl, *.md, *.{json,md,txt}
  const patterns = glob
    .replace(/\{([^}]+)\}/g, (_, group) => `(${group.split(",").join("|")})`)
    .replace(/\./g, "\\.")
    .replace(/\*/g, ".*");
  return new RegExp(`^${patterns}$`).test(filename);
}

// Chunker config for conversation text
const CONVERSATION_CHUNK_CONFIG: ChunkerConfig = {
  maxChunkSize: 2000,
  overlapSize: 100,
  minChunkSize: 100,
  semanticSplit: true,
  maxLinesPerChunk: 40,
};

// Chunker config for markdown files
const MARKDOWN_CHUNK_CONFIG: ChunkerConfig = {
  maxChunkSize: 1500,
  overlapSize: 100,
  minChunkSize: 80,
  semanticSplit: true,
  maxLinesPerChunk: 30,
};

// ============================================================================
// CC Transcript Parser
// ============================================================================

function parseCCTranscript(filePath: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  let sessionId = "";

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);

      if (!sessionId && obj.sessionId) {
        sessionId = obj.sessionId;
      }

      if (obj.type === "user" && obj.message) {
        const msg = obj.message;
        let text = "";
        if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          // Extract text blocks, skip tool_use/tool_result/images
          text = msg.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text || "")
            .join("\n");
        }

        if (text.trim().length > 10) {
          turns.push({
            role: "user",
            text: text.trim(),
            timestamp: obj.timestamp || "",
            sessionId,
          });
        }
      }

      if (obj.type === "assistant" && obj.message) {
        const msg = obj.message;
        let text = "";
        if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text || "")
            .join("\n");
        }

        if (text.trim().length > 20) {
          turns.push({
            role: "assistant",
            text: text.trim(),
            timestamp: obj.timestamp || "",
            sessionId,
          });
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return turns;
}

/**
 * Group conversation turns into meaningful chunks.
 * Strategy: merge adjacent user+assistant pairs into one chunk,
 * so search can find the full context of a Q&A exchange.
 */
function groupTurnsIntoChunks(turns: ConversationTurn[]): Array<{
  text: string;
  timestamp: string;
  sessionId: string;
}> {
  const chunks: Array<{ text: string; timestamp: string; sessionId: string }> = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];

    // If this is a user turn followed by an assistant turn, merge them
    if (turn.role === "user" && i + 1 < turns.length && turns[i + 1].role === "assistant") {
      const nextTurn = turns[i + 1];
      const merged = `[用户] ${turn.text}\n\n[助手] ${nextTurn.text}`;

      // If merged text is too long, chunk it
      if (merged.length > CONVERSATION_CHUNK_CONFIG.maxChunkSize) {
        const chunkResult = chunkDocument(merged, CONVERSATION_CHUNK_CONFIG);
        for (const chunk of chunkResult.chunks) {
          chunks.push({
            text: chunk,
            timestamp: turn.timestamp,
            sessionId: turn.sessionId,
          });
        }
      } else {
        chunks.push({
          text: merged,
          timestamp: turn.timestamp,
          sessionId: turn.sessionId,
        });
      }

      i++; // Skip the assistant turn we already consumed
    } else {
      // Standalone turn (user without response, or orphan assistant)
      const prefix = turn.role === "user" ? "[用户]" : "[助手]";
      const text = `${prefix} ${turn.text}`;

      if (text.length > CONVERSATION_CHUNK_CONFIG.maxChunkSize) {
        const chunkResult = chunkDocument(text, CONVERSATION_CHUNK_CONFIG);
        for (const chunk of chunkResult.chunks) {
          chunks.push({
            text: chunk,
            timestamp: turn.timestamp,
            sessionId: turn.sessionId,
          });
        }
      } else {
        chunks.push({
          text,
          timestamp: turn.timestamp,
          sessionId: turn.sessionId,
        });
      }
    }
  }

  return chunks;
}

// ============================================================================
// Codex Session Parser
// ============================================================================

function parseCodexSession(filePath: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  let sessionId = "";

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const payload = obj.payload;
      const timestamp = obj.timestamp || "";

      if (obj.type === "session_meta" && payload?.id) {
        sessionId = payload.id;
      }

      // response_item: contains user input and assistant output
      if (obj.type === "response_item" && payload) {
        const role = payload.role;
        const content = payload.content;

        if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type === "input_text" && c.text && c.text.length > 10) {
              // Skip system/developer prompts (usually very long instructions)
              if (role === "developer" || c.text.includes("<permissions instructions>")) {
                continue;
              }
              turns.push({
                role: "user",
                text: c.text.trim(),
                timestamp,
                sessionId,
              });
            }
            if (c.type === "output_text" && c.text && c.text.length > 20) {
              turns.push({
                role: "assistant",
                text: c.text.trim(),
                timestamp,
                sessionId,
              });
            }
          }
        }
      }

      // event_msg: user messages
      if (obj.type === "event_msg" && payload?.type === "user_message") {
        const msg = payload.message;
        if (msg && typeof msg === "string" && msg.length > 10) {
          // Avoid duplicates with response_item input_text
          const lastTurn = turns[turns.length - 1];
          if (!lastTurn || lastTurn.text !== msg.trim()) {
            turns.push({
              role: "user",
              text: msg.trim(),
              timestamp,
              sessionId,
            });
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return turns;
}

export async function ingestCodexSessions(
  store: MemoryStore,
  embedder: Embedder,
  options: { limit?: number; verbose?: boolean } = {},
): Promise<IngestResult> {
  const result: IngestResult = {
    source: "codex",
    filesProcessed: 0,
    chunksIngested: 0,
    chunksSkipped: 0,
    errors: [],
  };

  const baseDir = expandHome("~/.codex/sessions");
  if (!existsSync(baseDir)) {
    result.errors.push(`Codex sessions directory not found: ${baseDir}`);
    return result;
  }

  // Find all .jsonl files recursively
  const allFiles: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".jsonl")) {
        allFiles.push(full);
      }
    }
  }
  walk(baseDir);
  allFiles.sort();

  const filesToProcess = options.limit ? allFiles.slice(0, options.limit) : allFiles;
  const total = filesToProcess.length;

  for (let fi = 0; fi < filesToProcess.length; fi++) {
    const filePath = filesToProcess[fi];

    try {
      const stat = statSync(filePath);
      if (stat.size < 200) {
        result.chunksSkipped++;
        continue;
      }

      if (isProcessed(filePath, stat.size, stat.mtimeMs)) {
        result.chunksSkipped++;
        continue;
      }

      const turns = parseCodexSession(filePath);
      if (turns.length === 0) {
        result.chunksSkipped++;
        markProcessed(filePath, stat.size, 0, stat.mtimeMs);
        continue;
      }

      const chunks = groupTurnsIntoChunks(turns);
      const texts = chunks.map((c) => c.text);
      const batchSize = 32;
      let fileChunks = 0;

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const batchChunks = chunks.slice(i, i + batchSize);

        try {
          const vectors = await embedder.embedBatchPassage(batch);
          const toStore: Array<{text: string; vector: number[]; category: "fact"; scope: string; importance: number; metadata: string}> = [];

          for (let j = 0; j < batch.length; j++) {
            const vector = vectors[j];
            if (!vector || vector.length === 0) {
              result.chunksSkipped++;
              continue;
            }

            const chunk = batchChunks[j];
            toStore.push({
              text: chunk.text,
              vector,
              category: "fact",
              scope: `codex:${chunk.sessionId.slice(0, 8)}`,
              importance: 0.6,
              metadata: JSON.stringify({
                source: "codex",
                sessionId: chunk.sessionId,
                file: basename(filePath),
              }),
            });
          }

          if (toStore.length > 0) {
            await store.storeBatch(toStore);
            result.chunksIngested += toStore.length;
            fileChunks += toStore.length;
          }
        } catch (err: any) {
          result.errors.push(`Embedding batch error: ${err.message}`);
        }
      }

      markProcessed(filePath, stat.size, fileChunks, stat.mtimeMs);
      result.filesProcessed++;

      if ((fi + 1) % 10 === 0 || fi + 1 === total) {
        console.log(
          `  Codex: ${fi + 1}/${total} files, ${result.chunksIngested} chunks ingested`,
        );
      }
    } catch (err: any) {
      result.errors.push(`Error processing ${basename(filePath)}: ${err.message}`);
    }
  }

  return result;
}

// ============================================================================
// Gemini Session Parser
// ============================================================================

function parseGeminiSession(filePath: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];

  try {
    const content = readFileSync(filePath, "utf-8");
    const data = JSON.parse(content);
    const sessionId = data.sessionId || basename(filePath, ".json");
    const messages = data.messages || [];

    for (const msg of messages) {
      const type = msg.type; // "user" | "gemini" | "info"
      if (type === "info") continue; // Skip system info messages

      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((c: any) => c.text)
          .map((c: any) => c.text)
          .join("\n");
      }

      if (text.trim().length < 10) continue;

      turns.push({
        role: type === "user" ? "user" : "assistant",
        text: text.trim(),
        timestamp: data.startTime || "",
        sessionId,
      });
    }
  } catch {
    // Skip malformed files
  }

  return turns;
}

export async function ingestGeminiSessions(
  store: MemoryStore,
  embedder: Embedder,
  options: { limit?: number; verbose?: boolean } = {},
): Promise<IngestResult> {
  const result: IngestResult = {
    source: "gemini",
    filesProcessed: 0,
    chunksIngested: 0,
    chunksSkipped: 0,
    errors: [],
  };

  // Scan all project dirs under ~/.gemini/tmp/
  const baseDir = expandHome("~/.gemini/tmp");
  if (!existsSync(baseDir)) {
    result.errors.push(`Gemini tmp directory not found: ${baseDir}`);
    return result;
  }

  const allFiles: string[] = [];
  function walk(dir: string) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.startsWith("session-") && entry.name.endsWith(".json")) {
          allFiles.push(full);
        }
      }
    } catch { /* skip permission errors */ }
  }
  walk(baseDir);
  allFiles.sort();

  const filesToProcess = options.limit ? allFiles.slice(0, options.limit) : allFiles;
  const total = filesToProcess.length;

  for (let fi = 0; fi < filesToProcess.length; fi++) {
    const filePath = filesToProcess[fi];

    try {
      const stat = statSync(filePath);
      if (stat.size < 100) {
        result.chunksSkipped++;
        continue;
      }

      if (isProcessed(filePath, stat.size, stat.mtimeMs)) {
        result.chunksSkipped++;
        continue;
      }

      const turns = parseGeminiSession(filePath);
      if (turns.length === 0) {
        result.chunksSkipped++;
        markProcessed(filePath, stat.size, 0, stat.mtimeMs);
        continue;
      }

      const chunks = groupTurnsIntoChunks(turns);
      const texts = chunks.map((c) => c.text);
      const batchSize = 32;
      let fileChunks = 0;

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const batchChunks = chunks.slice(i, i + batchSize);

        try {
          const vectors = await embedder.embedBatchPassage(batch);
          const toStore: Array<{text: string; vector: number[]; category: "fact"; scope: string; importance: number; metadata: string}> = [];

          for (let j = 0; j < batch.length; j++) {
            const vector = vectors[j];
            if (!vector || vector.length === 0) {
              result.chunksSkipped++;
              continue;
            }

            const chunk = batchChunks[j];
            toStore.push({
              text: chunk.text,
              vector,
              category: "fact",
              scope: `gemini:${chunk.sessionId.slice(0, 8)}`,
              importance: 0.6,
              metadata: JSON.stringify({
                source: "gemini",
                sessionId: chunk.sessionId,
                file: basename(filePath),
              }),
            });
          }

          if (toStore.length > 0) {
            await store.storeBatch(toStore);
            result.chunksIngested += toStore.length;
            fileChunks += toStore.length;
          }
        } catch (err: any) {
          result.errors.push(`Embedding batch error: ${err.message}`);
        }
      }

      markProcessed(filePath, stat.size, fileChunks, stat.mtimeMs);
      result.filesProcessed++;

      if ((fi + 1) % 10 === 0 || fi + 1 === total) {
        console.log(
          `  Gemini: ${fi + 1}/${total} files, ${result.chunksIngested} chunks ingested`,
        );
      }
    } catch (err: any) {
      result.errors.push(`Error processing ${basename(filePath)}: ${err.message}`);
    }
  }

  return result;
}

// ============================================================================
// Markdown Parser
// ============================================================================

/**
 * Split a markdown file by headings (## or #) into chunks.
 * Each chunk includes the heading + content under it.
 */
function parseMarkdown(filePath: string): Array<{ text: string; heading: string }> {
  const content = readFileSync(filePath, "utf-8");
  const chunks: Array<{ text: string; heading: string }> = [];

  // Split by headings
  const sections = content.split(/^(#{1,3}\s+.+)$/m);

  let currentHeading = basename(filePath, ".md");
  let currentText = "";

  for (const section of sections) {
    if (/^#{1,3}\s+/.test(section)) {
      // This is a heading — save previous section
      if (currentText.trim().length > 30) {
        pushMarkdownChunks(chunks, currentHeading, currentText.trim());
      }
      currentHeading = section.replace(/^#+\s+/, "").trim();
      currentText = "";
    } else {
      currentText += section;
    }
  }

  // Don't forget the last section
  if (currentText.trim().length > 30) {
    pushMarkdownChunks(chunks, currentHeading, currentText.trim());
  }

  return chunks;
}

function pushMarkdownChunks(
  chunks: Array<{ text: string; heading: string }>,
  heading: string,
  text: string,
): void {
  const fullText = `[${heading}] ${text}`;
  if (fullText.length > MARKDOWN_CHUNK_CONFIG.maxChunkSize) {
    const result = chunkDocument(fullText, MARKDOWN_CHUNK_CONFIG);
    for (const chunk of result.chunks) {
      chunks.push({ text: chunk, heading });
    }
  } else {
    chunks.push({ text: fullText, heading });
  }
}

// ============================================================================
// Main Ingest Functions
// ============================================================================

export async function ingestCCTranscripts(
  store: MemoryStore,
  embedder: Embedder,
  sourcePath: string,
  options: { limit?: number; verbose?: boolean } = {},
): Promise<IngestResult> {
  const result: IngestResult = {
    source: "cc",
    filesProcessed: 0,
    chunksIngested: 0,
    chunksSkipped: 0,
    errors: [],
  };

  const dir = expandHome(sourcePath);
  if (!existsSync(dir)) {
    result.errors.push(`Directory not found: ${dir}`);
    return result;
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();

  const filesToProcess = options.limit ? files.slice(0, options.limit) : files;
  const total = filesToProcess.length;

  for (let fi = 0; fi < filesToProcess.length; fi++) {
    const file = filesToProcess[fi];
    const filePath = join(dir, file);

    try {
      // Skip very small files (likely empty sessions)
      const stat = statSync(filePath);
      if (stat.size < 500) {
        result.chunksSkipped++;
        continue;
      }

      // Skip already processed files (incremental mode)
      if (isProcessed(filePath, stat.size, stat.mtimeMs)) {
        result.chunksSkipped++;
        continue;
      }

      const turns = parseCCTranscript(filePath);
      if (turns.length === 0) {
        result.chunksSkipped++;
        markProcessed(filePath, stat.size, 0, stat.mtimeMs);
        continue;
      }

      const chunks = groupTurnsIntoChunks(turns);
      let fileChunks = 0;

      // Batch embed + batch store for efficiency
      const texts = chunks.map((c) => c.text);
      const batchSize = 32;

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const batchChunks = chunks.slice(i, i + batchSize);

        try {
          const vectors = await embedder.embedBatchPassage(batch);
          const toStore: Array<{text: string; vector: number[]; category: "fact"; scope: string; importance: number; metadata: string}> = [];

          for (let j = 0; j < batch.length; j++) {
            const vector = vectors[j];
            if (!vector || vector.length === 0) {
              result.chunksSkipped++;
              continue;
            }

            const chunk = batchChunks[j];
            toStore.push({
              text: chunk.text,
              vector,
              category: "fact",
              scope: `cc:${chunk.sessionId.slice(0, 8)}`,
              importance: 0.6,
              metadata: JSON.stringify({
                source: "cc",
                sessionId: chunk.sessionId,
                file: file,
              }),
            });
          }

          if (toStore.length > 0) {
            await store.storeBatch(toStore);
            result.chunksIngested += toStore.length;
            fileChunks += toStore.length;
          }
        } catch (err: any) {
          result.errors.push(`Embedding batch error in ${file}: ${err.message}`);
        }
      }

      markProcessed(filePath, stat.size, fileChunks, stat.mtimeMs);
      result.filesProcessed++;

      // Progress
      if ((fi + 1) % 10 === 0 || fi + 1 === total) {
        console.log(
          `  CC: ${fi + 1}/${total} files, ${result.chunksIngested} chunks ingested`,
        );
      }
    } catch (err: any) {
      result.errors.push(`Error processing ${file}: ${err.message}`);
    }
  }

  return result;
}

export async function ingestMarkdownFiles(
  store: MemoryStore,
  embedder: Embedder,
  sourcePath: string,
  scope: string,
  options: { verbose?: boolean } = {},
): Promise<IngestResult> {
  const result: IngestResult = {
    source: scope,
    filesProcessed: 0,
    chunksIngested: 0,
    chunksSkipped: 0,
    errors: [],
  };

  const dir = expandHome(sourcePath);
  if (!existsSync(dir)) {
    result.errors.push(`Directory not found: ${dir}`);
    return result;
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));

  for (const file of files) {
    const filePath = join(dir, file);

    try {
      const stat = statSync(filePath);
      if (isProcessed(filePath, stat.size, stat.mtimeMs)) {
        result.chunksSkipped++;
        continue;
      }

      const sections = parseMarkdown(filePath);
      if (sections.length === 0) {
        result.chunksSkipped++;
        markProcessed(filePath, stat.size, 0, stat.mtimeMs);
        continue;
      }

      const texts = sections.map((s) => s.text);
      const batchSize = 32;
      let fileChunks = 0;

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const batchSections = sections.slice(i, i + batchSize);

        try {
          const vectors = await embedder.embedBatchPassage(batch);
          const toStore: Array<{text: string; vector: number[]; category: "fact"; scope: string; importance: number; metadata: string}> = [];

          for (let j = 0; j < batch.length; j++) {
            const vector = vectors[j];
            if (!vector || vector.length === 0) {
              result.chunksSkipped++;
              continue;
            }

            toStore.push({
              text: batch[j],
              vector,
              category: "fact",
              scope,
              importance: 0.7,
              metadata: JSON.stringify({
                source: scope,
                file: file,
                heading: batchSections[j].heading,
              }),
            });
          }

          if (toStore.length > 0) {
            await store.storeBatch(toStore);
            result.chunksIngested += toStore.length;
            fileChunks += toStore.length;
          }
        } catch (err: any) {
          result.errors.push(`Embedding error in ${file}: ${err.message}`);
        }
      }

      markProcessed(filePath, stat.size, fileChunks, stat.mtimeMs);
      result.filesProcessed++;

      if (options.verbose) {
        console.log(`  ${scope}: ${file} → ${sections.length} chunks`);
      }
    } catch (err: any) {
      result.errors.push(`Error processing ${file}: ${err.message}`);
    }
  }

  return result;
}

export async function ingestGenericText(
  store: MemoryStore,
  embedder: Embedder,
  sourcePath: string,
  scope: string,
  globPattern: string,
  options: { verbose?: boolean } = {},
): Promise<IngestResult> {
  const result: IngestResult = {
    source: scope,
    filesProcessed: 0,
    chunksIngested: 0,
    chunksSkipped: 0,
    errors: [],
  };

  const dir = expandHome(sourcePath);
  if (!existsSync(dir)) {
    // Not an error — the directory might not exist yet (e.g. gemini/codex)
    if (options.verbose) {
      console.log(`  ${scope}: directory not found, skipping (${dir})`);
    }
    return result;
  }

  const files = readdirSync(dir).filter((f) => matchGlob(f, globPattern));

  for (const file of files) {
    const filePath = join(dir, file);

    try {
      const content = readFileSync(filePath, "utf-8");
      if (content.trim().length < 50) {
        result.chunksSkipped++;
        continue;
      }

      // For JSON files, try to extract conversation structure
      let textToChunk = content;
      if (file.endsWith(".json")) {
        try {
          const parsed = JSON.parse(content);
          // Handle common export formats
          if (Array.isArray(parsed)) {
            textToChunk = parsed
              .map((item: any) => {
                if (typeof item === "string") return item;
                if (item.content) return `[${item.role || "?"}] ${item.content}`;
                return JSON.stringify(item);
              })
              .join("\n\n");
          }
        } catch {
          // Not valid JSON, treat as plain text
        }
      }

      const chunkResult = chunkDocument(textToChunk, CONVERSATION_CHUNK_CONFIG);

      const texts = chunkResult.chunks;
      const batchSize = 32;

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);

        try {
          const vectors = await embedder.embedBatchPassage(batch);

          for (let j = 0; j < batch.length; j++) {
            const vector = vectors[j];
            if (!vector || vector.length === 0) {
              result.chunksSkipped++;
              continue;
            }

            await store.store({
              text: batch[j],
              vector,
              category: "fact",
              scope,
              importance: 0.6,
              metadata: JSON.stringify({
                source: scope,
                file: file,
              }),
            });

            result.chunksIngested++;
          }
        } catch (err: any) {
          result.errors.push(`Embedding error in ${file}: ${err.message}`);
        }
      }

      result.filesProcessed++;
    } catch (err: any) {
      result.errors.push(`Error processing ${file}: ${err.message}`);
    }
  }

  return result;
}
