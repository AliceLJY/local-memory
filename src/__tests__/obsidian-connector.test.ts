import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  isObsidianVault,
  parseFrontmatter,
  extractWikiLinks,
  contentHash,
  scanVault,
} from "../obsidian-connector.js";

// ---------------------------------------------------------------------------
// Temp vault fixture
// ---------------------------------------------------------------------------

const VAULT_ROOT = join(tmpdir(), `recallnest-obsidian-test-${Date.now()}`);

beforeAll(() => {
  // Create vault structure
  mkdirSync(join(VAULT_ROOT, ".obsidian"), { recursive: true });
  mkdirSync(join(VAULT_ROOT, "projects"), { recursive: true });
  mkdirSync(join(VAULT_ROOT, "daily"), { recursive: true });
  mkdirSync(join(VAULT_ROOT, ".trash"), { recursive: true });

  // Root-level note with frontmatter + wikilinks
  writeFileSync(
    join(VAULT_ROOT, "My Note.md"),
    `---
tags: [ai, memory]
aliases: [note-1]
status: active
---

# My Note

This is a note about [[RecallNest]] and [[LanceDB|vector database]].

Some more content here to make it long enough.
`,
  );

  // Nested note in projects/
  writeFileSync(
    join(VAULT_ROOT, "projects", "Project Alpha.md"),
    `---
tags:
  - project
  - alpha
priority: high
---

# Project Alpha

Working on [[Feature X]] for [[Project Alpha]].

Details about the project implementation and design decisions.
`,
  );

  // Daily note without frontmatter
  writeFileSync(
    join(VAULT_ROOT, "daily", "2026-04-13.md"),
    `# 2026-04-13

- Met with team about [[Q2 Goals]]
- Reviewed [[PR #123]]
- Need to follow up on [[Budget Review]]

Some additional notes about the day and what happened.
`,
  );

  // Short note (should be skipped)
  writeFileSync(join(VAULT_ROOT, "short.md"), "Hi");

  // Trash note (should be skipped)
  writeFileSync(
    join(VAULT_ROOT, ".trash", "deleted.md"),
    "This is deleted content that should not be ingested into the vault.\n",
  );
});

afterAll(() => {
  try {
    rmSync(VAULT_ROOT, { recursive: true, force: true });
  } catch {
    // cleanup best-effort
  }
});

// ---------------------------------------------------------------------------
// isObsidianVault
// ---------------------------------------------------------------------------

describe("isObsidianVault", () => {
  it("returns true for a directory with .obsidian/", () => {
    expect(isObsidianVault(VAULT_ROOT)).toBe(true);
  });

  it("returns false for a regular directory", () => {
    expect(isObsidianVault(join(VAULT_ROOT, "projects"))).toBe(false);
  });

  it("returns false for non-existent directory", () => {
    expect(isObsidianVault("/nonexistent/path")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe("parseFrontmatter", () => {
  it("parses inline list tags", () => {
    const content = `---
tags: [ai, memory]
status: active
---

Body content here.`;
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.tags).toEqual(["ai", "memory"]);
    expect(frontmatter!.status).toBe("active");
    expect(body).toBe("Body content here.");
  });

  it("parses YAML list tags", () => {
    const content = `---
tags:
  - project
  - alpha
priority: high
---

Body here.`;
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.tags).toEqual(["project", "alpha"]);
    expect(frontmatter!.priority).toBe("high");
    expect(body).toBe("Body here.");
  });

  it("returns null frontmatter when no --- block", () => {
    const content = "# Just a heading\n\nSome content.";
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).toBeNull();
    expect(body).toBe(content);
  });

  it("handles empty frontmatter", () => {
    const content = `---
---

Body.`;
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).toBeNull();
    expect(body).toBe("Body.");
  });

  it("handles quoted values", () => {
    const content = `---
title: 'My Title'
author: "Alice"
---

Content.`;
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.title).toBe("My Title");
    expect(frontmatter!.author).toBe("Alice");
  });

  it("handles empty inline list []", () => {
    const content = `---
tags: []
---

Content here is long enough.`;
    const { frontmatter } = parseFrontmatter(content);
    // Empty list should not produce tags
    expect(frontmatter).toBeNull();
  });

  it("handles Windows-style line endings", () => {
    const content = "---\r\ntags: [a, b]\r\n---\r\n\r\nBody.";
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.tags).toEqual(["a", "b"]);
    expect(body).toBe("Body.");
  });
});

// ---------------------------------------------------------------------------
// extractWikiLinks
// ---------------------------------------------------------------------------

describe("extractWikiLinks", () => {
  it("extracts simple wikilinks", () => {
    const links = extractWikiLinks("Link to [[RecallNest]] and [[LanceDB]].");
    expect(links).toHaveLength(2);
    expect(links[0].target).toBe("RecallNest");
    expect(links[1].target).toBe("LanceDB");
  });

  it("extracts wikilinks with display text", () => {
    const links = extractWikiLinks("See [[LanceDB|vector database]] for details.");
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("LanceDB");
    expect(links[0].displayText).toBe("vector database");
  });

  it("skips embed syntax ![[embed]]", () => {
    const links = extractWikiLinks("Normal [[link]] and embed ![[image.png]].");
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("link");
  });

  it("handles multiple links on same line", () => {
    const links = extractWikiLinks("[[A]] connects to [[B]] and [[C]]");
    expect(links).toHaveLength(3);
  });

  it("returns empty array for no links", () => {
    const links = extractWikiLinks("Just plain text.");
    expect(links).toHaveLength(0);
  });

  it("trims whitespace from targets", () => {
    const links = extractWikiLinks("[[ Spaced Target ]]");
    expect(links[0].target).toBe("Spaced Target");
  });
});

// ---------------------------------------------------------------------------
// contentHash
// ---------------------------------------------------------------------------

describe("contentHash", () => {
  it("returns a 16-char hex string", () => {
    const hash = contentHash("hello world");
    expect(hash).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(hash)).toBe(true);
  });

  it("is deterministic", () => {
    expect(contentHash("same input")).toBe(contentHash("same input"));
  });

  it("differs for different inputs", () => {
    expect(contentHash("input A")).not.toBe(contentHash("input B"));
  });
});

// ---------------------------------------------------------------------------
// scanVault
// ---------------------------------------------------------------------------

describe("scanVault", () => {
  it("produces valid connector-v1 output", () => {
    const output = scanVault(VAULT_ROOT);
    expect(output.version).toBe("connector-v1");
    expect(output.source).toBe("obsidian");
    expect(output.scope).toContain("vault:");
    expect(Array.isArray(output.records)).toBe(true);
  });

  it("finds all non-short, non-excluded .md files", () => {
    const output = scanVault(VAULT_ROOT);
    // Should find: My Note.md, projects/Project Alpha.md, daily/2026-04-13.md
    // Should NOT find: short.md (too short), .trash/deleted.md (excluded)
    expect(output.records).toHaveLength(3);
  });

  it("extracts frontmatter tags", () => {
    const output = scanVault(VAULT_ROOT);
    const myNote = output.records.find((r) => r.id === "obsidian:My Note.md");
    expect(myNote).toBeDefined();
    expect(myNote!.tags).toContain("ai");
    expect(myNote!.tags).toContain("memory");
  });

  it("extracts wikilinks as link: tags", () => {
    const output = scanVault(VAULT_ROOT);
    const myNote = output.records.find((r) => r.id === "obsidian:My Note.md");
    expect(myNote).toBeDefined();
    expect(myNote!.tags).toContain("link:RecallNest");
    expect(myNote!.tags).toContain("link:LanceDB");
  });

  it("maps folder structure to folder: tags", () => {
    const output = scanVault(VAULT_ROOT);
    const projectNote = output.records.find((r) => r.id?.includes("projects/"));
    expect(projectNote).toBeDefined();
    expect(projectNote!.tags).toContain("folder:projects");
  });

  it("does not add folder: tag for root-level files", () => {
    const output = scanVault(VAULT_ROOT);
    const myNote = output.records.find((r) => r.id === "obsidian:My Note.md");
    expect(myNote).toBeDefined();
    const folderTags = myNote!.tags!.filter((t) => t.startsWith("folder:"));
    expect(folderTags).toHaveLength(0);
  });

  it("skips .trash and .obsidian directories", () => {
    const output = scanVault(VAULT_ROOT);
    const trashNote = output.records.find((r) => r.id?.includes(".trash"));
    expect(trashNote).toBeUndefined();
  });

  it("computes contentHash for each record", () => {
    const output = scanVault(VAULT_ROOT);
    for (const record of output.records) {
      expect(record.contentHash).toBeDefined();
      expect(record.contentHash!).toHaveLength(16);
    }
  });

  it("includes sourceMetadata with vault info", () => {
    const output = scanVault(VAULT_ROOT);
    const myNote = output.records.find((r) => r.id === "obsidian:My Note.md");
    expect(myNote!.sourceMetadata).toBeDefined();
    expect(myNote!.sourceMetadata!.vaultPath).toBe(VAULT_ROOT);
    expect(myNote!.sourceMetadata!.relativePath).toBe("My Note.md");
    expect(myNote!.sourceMetadata!.frontmatter).toBeDefined();
    expect(myNote!.sourceMetadata!.wikiLinks).toBeDefined();
  });

  it("respects custom scopePrefix", () => {
    const output = scanVault(VAULT_ROOT, { scopePrefix: "custom:my-vault" });
    expect(output.scope).toBe("custom:my-vault");
  });

  it("respects custom excludeDirs", () => {
    // Exclude 'daily' directory
    const output = scanVault(VAULT_ROOT, {
      excludeDirs: [".obsidian", ".trash", ".git", "node_modules", "daily"],
    });
    const dailyNote = output.records.find((r) => r.id?.includes("daily/"));
    expect(dailyNote).toBeUndefined();
    // Should still find the other 2
    expect(output.records).toHaveLength(2);
  });

  it("strips frontmatter from body text", () => {
    const output = scanVault(VAULT_ROOT);
    const myNote = output.records.find((r) => r.id === "obsidian:My Note.md");
    expect(myNote!.text).not.toContain("---");
    expect(myNote!.text).toContain("# My Note");
  });

  it("handles note without frontmatter", () => {
    const output = scanVault(VAULT_ROOT);
    const dailyNote = output.records.find((r) => r.id?.includes("2026-04-13"));
    expect(dailyNote).toBeDefined();
    // Should still extract wikilinks
    expect(dailyNote!.tags).toContain("link:Q2 Goals");
    expect(dailyNote!.tags).toContain("link:PR #123");
  });
});
