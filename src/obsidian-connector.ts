/**
 * Obsidian Vault Connector (GB-1)
 *
 * Scans an Obsidian vault directory and produces a ConnectorOutputV1 payload.
 * Recognizes:
 * - .obsidian/ directory (vault detection)
 * - YAML frontmatter (tags, aliases, arbitrary metadata)
 * - [[wikilinks]] (extracted as entity associations via link: tags)
 * - Directory structure (folder: tags for scope/topic mapping)
 * - Content hash (SHA-256 prefix) for incremental sync
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, basename, dirname } from "node:path";
import type { ConnectorOutputV1, ConnectorRecord } from "./connector-types.js";

// ============================================================================
// Vault Detection
// ============================================================================

/** Check if a directory is an Obsidian vault (contains .obsidian/ folder) */
export function isObsidianVault(dirPath: string): boolean {
  try {
    return existsSync(join(dirPath, ".obsidian"));
  } catch {
    return false;
  }
}

// ============================================================================
// YAML Frontmatter Parser
// ============================================================================

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)(?:\r?\n)?---/;

export interface ObsidianFrontmatter {
  tags?: string[];
  aliases?: string[];
  [key: string]: unknown;
}

/**
 * Parse YAML frontmatter from markdown content.
 * Lightweight parser — handles:
 * - key: value (strings)
 * - key: [inline, list]
 * - key:\n  - list\n  - items
 * Does NOT handle nested objects, multi-line strings, or anchors.
 * Returns null frontmatter on parse failure (never throws).
 */
export function parseFrontmatter(content: string): {
  frontmatter: ObsidianFrontmatter | null;
  body: string;
} {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: null, body: content };

  const yamlBlock = match[1];
  const body = content.slice(match[0].length).trimStart();

  try {
    const fm: ObsidianFrontmatter = {};
    let currentKey: string | null = null;
    let listAccum: string[] = [];

    function flushList(): void {
      if (currentKey && listAccum.length > 0) {
        fm[currentKey] = listAccum;
        listAccum = [];
      }
      currentKey = null;
    }

    for (const line of yamlBlock.split("\n")) {
      // List item: "  - value"
      const listItem = line.match(/^\s+-\s+(.+)/);
      if (listItem && currentKey) {
        listAccum.push(listItem[1].trim().replace(/^['"]|['"]$/g, ""));
        continue;
      }

      // Key-value: "key: value"
      const kv = line.match(/^([\w][\w-]*):\s*(.*)/);
      if (kv) {
        flushList();
        const [, key, rawVal] = kv;
        const val = rawVal.trim();

        if (val === "" || val === "[]") {
          // Empty value or empty inline list — start list accumulator
          currentKey = key;
          listAccum = [];
        } else if (val.startsWith("[") && val.endsWith("]")) {
          // Inline list: [a, b, c]
          fm[key] = val
            .slice(1, -1)
            .split(",")
            .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
            .filter(Boolean);
        } else {
          // Simple string value
          fm[key] = val.replace(/^['"]|['"]$/g, "");
        }
      }
    }
    flushList();

    return {
      frontmatter: Object.keys(fm).length > 0 ? fm : null,
      body,
    };
  } catch {
    // Parse failure — return body without frontmatter
    return { frontmatter: null, body };
  }
}

// ============================================================================
// Wikilink Extraction
// ============================================================================

const WIKILINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export interface WikiLink {
  /** Link target (file name without extension) */
  target: string;
  /** Optional display text (after |) */
  displayText?: string;
}

/**
 * Extract [[wikilinks]] from markdown text.
 * Handles [[target]] and [[target|display text]].
 * Does NOT handle embed syntax ![[embed]] (those are skipped).
 */
export function extractWikiLinks(text: string): WikiLink[] {
  const links: WikiLink[] = [];
  // Create a fresh regex to avoid stale lastIndex
  const re = new RegExp(WIKILINK_PATTERN.source, WIKILINK_PATTERN.flags);
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    // Skip embed syntax: character before [[ is !
    if (match.index > 0 && text[match.index - 1] === "!") continue;

    links.push({
      target: match[1].trim(),
      ...(match[2] ? { displayText: match[2].trim() } : {}),
    });
  }

  return links;
}

// ============================================================================
// Content Hash
// ============================================================================

/** SHA-256 first 16 hex chars — compact but collision-safe for incremental sync */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ============================================================================
// Vault Scanner
// ============================================================================

export interface ScanVaultOptions {
  /** Scope prefix, defaults to "vault:<vault-folder-name>" */
  scopePrefix?: string;
  /** Directories to exclude (defaults: .obsidian, .trash, .git, node_modules) */
  excludeDirs?: string[];
  /** Minimum file content length to include (default: 30 chars) */
  minContentLength?: number;
}

/**
 * Scan an Obsidian vault and produce a ConnectorOutputV1 payload.
 *
 * - Recursively walks .md files (skipping excluded directories)
 * - Parses YAML frontmatter -> tags
 * - Extracts [[wikilinks]] -> link:<target> tags
 * - Maps folder structure -> folder:<path> tags
 * - Computes SHA-256 content hash for incremental sync
 */
export function scanVault(
  vaultPath: string,
  options?: ScanVaultOptions,
): ConnectorOutputV1 {
  const vaultName = basename(vaultPath);
  const scopePrefix = options?.scopePrefix ?? `vault:${vaultName}`;
  const defaultExclude = [".obsidian", ".trash", ".git", "node_modules"];
  const excludeDirs = new Set(options?.excludeDirs ?? defaultExclude);
  const minLen = options?.minContentLength ?? 30;

  const records: ConnectorRecord[] = [];

  function walk(dir: string): void {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Permission denied or broken symlink — skip
    }

    for (const entry of entries) {
      if (excludeDirs.has(entry.name)) continue;

      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full);
        continue;
      }

      if (!entry.name.endsWith(".md")) continue;

      let raw: string;
      try {
        raw = readFileSync(full, "utf-8");
      } catch {
        continue; // Unreadable file — skip
      }

      if (raw.trim().length < minLen) continue;

      const { frontmatter, body } = parseFrontmatter(raw);
      const wikiLinks = extractWikiLinks(body);
      const relPath = relative(vaultPath, full);
      const folder = dirname(relPath);

      // --- Build tags ---
      const tags: string[] = [];

      // Frontmatter tags
      if (frontmatter?.tags) {
        const fmTags = Array.isArray(frontmatter.tags)
          ? frontmatter.tags
          : [String(frontmatter.tags)];
        for (const t of fmTags) {
          tags.push(String(t));
        }
      }

      // Wikilink entity associations
      for (const link of wikiLinks) {
        tags.push(`link:${link.target}`);
      }

      // Folder path
      if (folder !== ".") {
        tags.push(`folder:${folder}`);
      }

      records.push({
        id: `obsidian:${relPath}`,
        text: body,
        title: basename(entry.name, ".md"),
        tags,
        contentHash: contentHash(raw),
        timestamp: new Date(statSync(full).mtimeMs).toISOString(),
        sourceMetadata: {
          vaultPath,
          relativePath: relPath,
          ...(frontmatter ? { frontmatter } : {}),
          ...(wikiLinks.length > 0 ? { wikiLinks } : {}),
        },
      });
    }
  }

  walk(vaultPath);

  return {
    version: "connector-v1",
    source: "obsidian",
    scope: scopePrefix,
    producedAt: new Date().toISOString(),
    records,
  };
}
