#!/usr/bin/env bun
/**
 * RSS Feed Connector Adapter (skeleton)
 *
 * Demonstrates how to produce a ConnectorOutputV1 JSON file from RSS/Atom
 * feeds for RecallNest ingestion. Useful for tracking industry news,
 * blog posts, and research updates.
 *
 * Usage:
 *   bun run connectors/examples/rss-adapter.ts > rss-output.json
 *   lm ingest --connector rss-output.json
 *
 * Customize:
 *   1. Replace fetchFeed() with your RSS parsing library (e.g. rss-parser)
 *   2. Adjust feed URLs and scope
 *   3. Set categoryHint / importanceHint based on feed type
 */

import type { ConnectorOutputV1 } from "../../src/connector-types.js";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// TODO: Replace with real RSS/Atom parsing
// ---------------------------------------------------------------------------

interface FeedItem {
  guid: string;
  title: string;
  content: string;        // HTML stripped to plain text
  link: string;
  pubDate: string;         // ISO 8601
  categories?: string[];
}

interface FeedConfig {
  url: string;
  scope: string;           // e.g. "feeds:ai-news"
  categoryHint?: string;
  importanceHint?: number;
}

const FEEDS: FeedConfig[] = [
  // Add your feeds here:
  // { url: "https://example.com/feed.xml", scope: "feeds:example" },
];

async function fetchFeed(_url: string): Promise<FeedItem[]> {
  // Example with rss-parser:
  // import Parser from "rss-parser";
  // const parser = new Parser();
  // const feed = await parser.parseURL(url);
  // return feed.items.map(item => ({ ... }));
  return []; // Replace with real implementation
}

// ---------------------------------------------------------------------------
// Transform → ConnectorOutputV1
// ---------------------------------------------------------------------------

async function main() {
  for (const feed of FEEDS) {
    const items = await fetchFeed(feed.url);

    const output: ConnectorOutputV1 = {
      version: "connector-v1",
      source: "rss",
      scope: feed.scope,
      producedAt: new Date().toISOString(),
      records: items.map((item) => ({
        id: `rss:${createHash("md5").update(item.guid || item.link).digest("hex")}`,
        text: item.content,
        title: item.title,
        categoryHint: feed.categoryHint ?? "knowledge",
        importanceHint: feed.importanceHint ?? 0.6,
        tags: [
          "rss",
          ...(item.categories ?? []),
          `link:${item.link}`,
        ],
        timestamp: item.pubDate,
        contentHash: createHash("sha256").update(item.content).digest("hex"),
        sourceMetadata: {
          feedUrl: feed.url,
          link: item.link,
          guid: item.guid,
        },
      })),
    };

    // Each feed outputs one JSON — pipe to separate files if needed
    console.log(JSON.stringify(output, null, 2));
  }
}

main().catch(console.error);
