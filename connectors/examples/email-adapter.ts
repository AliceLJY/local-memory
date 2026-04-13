#!/usr/bin/env bun
/**
 * Email Connector Adapter (skeleton)
 *
 * Demonstrates how to produce a ConnectorOutputV1 JSON file from an email
 * source (IMAP, Gmail API, local mbox, etc.) for RecallNest ingestion.
 *
 * Usage:
 *   bun run connectors/examples/email-adapter.ts > email-output.json
 *   lm ingest --connector email-output.json
 *
 * Customize:
 *   1. Replace the fetchEmails() stub with your IMAP/API client
 *   2. Adjust scope to match your project naming
 *   3. Set categoryHint based on email type (meeting invite → "events", etc.)
 */

import type { ConnectorOutputV1 } from "../../src/connector-types.js";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// TODO: Replace with real email fetching logic
// ---------------------------------------------------------------------------

interface RawEmail {
  messageId: string;
  subject: string;
  body: string;
  from: string;
  date: string; // ISO 8601
}

async function fetchEmails(_since: Date): Promise<RawEmail[]> {
  // Example: use imapflow, googleapis, or read from .mbox
  // const client = new ImapFlow({ host: 'imap.example.com', ... });
  // await client.connect();
  // const messages = await client.fetch(...);
  return []; // Replace with real implementation
}

// ---------------------------------------------------------------------------
// Transform → ConnectorOutputV1
// ---------------------------------------------------------------------------

async function main() {
  const since = new Date(Date.now() - 7 * 86_400_000); // last 7 days
  const emails = await fetchEmails(since);

  const output: ConnectorOutputV1 = {
    version: "connector-v1",
    source: "email",
    scope: "inbox:personal",           // Customize: "inbox:work", "project:xyz"
    producedAt: new Date().toISOString(),
    records: emails.map((email) => ({
      id: `email:${email.messageId}`,
      text: email.body,
      title: email.subject,
      categoryHint: "events",          // Customize per email type
      importanceHint: 0.6,             // Customize: 0.9 for flagged/starred
      tags: ["email", `from:${email.from}`],
      timestamp: email.date,
      contentHash: createHash("sha256").update(email.body).digest("hex"),
      sourceMetadata: {
        from: email.from,
        messageId: email.messageId,
      },
    })),
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(console.error);
