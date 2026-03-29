/**
 * Tests for Tier 3.4: Prospective Memory (Conditional Trigger Reminders)
 *
 * Validates:
 * 1. setReminder creates a properly structured memory entry
 * 2. checkTriggers finds matching pending reminders
 * 3. checkTriggers ignores fired/expired reminders
 * 4. fireReminder marks the reminder as fired
 * 5. formatReminders produces readable output
 * 6. Trigger matching uses keyword logic
 * 7. Expiration is handled correctly
 */
import { describe, expect, it } from "bun:test";
import {
  setReminder,
  checkTriggers,
  fireReminder,
  formatReminders,
} from "../prospective-memory.js";
import type { MemoryEntry, MemorySearchResult } from "../store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStore() {
  const data = new Map<string, MemoryEntry>();
  let idCounter = 0;

  return {
    data,
    async store(entry: Omit<MemoryEntry, "id" | "timestamp">) {
      const id = `reminder-${++idCounter}`;
      const full: MemoryEntry = {
        ...entry,
        id,
        timestamp: Date.now(),
      } as MemoryEntry;
      data.set(id, full);
      return full;
    },
    async vectorSearch(
      _vector: number[],
      _limit: number,
      _minScore: number,
      _scopeFilter?: string[],
    ): Promise<MemorySearchResult[]> {
      return [...data.values()].map(e => ({ entry: e, score: 0.8 }));
    },
    async getById(id: string) {
      return data.get(id) ?? null;
    },
    async update(id: string, upd: { metadata?: string; text?: string }, _scope?: string[]) {
      const entry = data.get(id);
      if (!entry) return null;
      if (upd.metadata) entry.metadata = upd.metadata;
      if (upd.text) entry.text = upd.text;
      return entry;
    },
  };
}

function createMockEmbedder() {
  return {
    async embedPassage(_text: string) {
      return [0.1, 0.2, 0.3];
    },
    async embedBatchPassage(texts: string[]) {
      return texts.map(() => [0.1, 0.2, 0.3]);
    },
  };
}

// ---------------------------------------------------------------------------
// setReminder
// ---------------------------------------------------------------------------

describe("setReminder", () => {
  it("creates a reminder with prospective metadata", async () => {
    const store = createMockStore();
    const embedder = createMockEmbedder();

    const entry = await setReminder(store as any, embedder as any, {
      trigger: "deployment",
      action: "Check the monitoring dashboard after deploy",
      scope: "project:test",
    });

    expect(entry.id).toBeTruthy();
    expect(entry.category).toBe("patterns");
    expect(entry.text).toContain("Reminder");
    expect(entry.text).toContain("deployment");

    const meta = JSON.parse(entry.metadata);
    expect(meta.prospective.trigger).toBe("deployment");
    expect(meta.prospective.action).toBe("Check the monitoring dashboard after deploy");
    expect(meta.prospective.status).toBe("pending");
  });

  it("creates a reminder with expiration", async () => {
    const store = createMockStore();
    const embedder = createMockEmbedder();

    const entry = await setReminder(store as any, embedder as any, {
      trigger: "release",
      action: "Update changelog",
      scope: "project:test",
      expiresInDays: 7,
    });

    const meta = JSON.parse(entry.metadata);
    expect(meta.prospective.expiresAt).toBeTruthy();
    // Should expire roughly 7 days from now
    const expiresAt = new Date(meta.prospective.expiresAt).getTime();
    const now = Date.now();
    const sevenDays = 7 * 86_400_000;
    expect(expiresAt - now).toBeGreaterThan(sevenDays - 60_000);
    expect(expiresAt - now).toBeLessThan(sevenDays + 60_000);
  });
});

// ---------------------------------------------------------------------------
// checkTriggers
// ---------------------------------------------------------------------------

describe("checkTriggers", () => {
  it("finds matching pending reminders", async () => {
    const store = createMockStore();
    const embedder = createMockEmbedder();

    await setReminder(store as any, embedder as any, {
      trigger: "deployment",
      action: "Check monitoring",
      scope: "project:test",
    });

    const reminders = await checkTriggers(
      store as any,
      embedder as any,
      "We need to do a deployment today",
    );

    expect(reminders.length).toBe(1);
    expect(reminders[0].action).toBe("Check monitoring");
  });

  it("ignores non-matching queries", async () => {
    const store = createMockStore();
    const embedder = createMockEmbedder();

    await setReminder(store as any, embedder as any, {
      trigger: "deployment",
      action: "Check monitoring",
      scope: "project:test",
    });

    const reminders = await checkTriggers(
      store as any,
      embedder as any,
      "Let me review the code changes",
    );

    expect(reminders.length).toBe(0);
  });

  it("ignores fired reminders", async () => {
    const store = createMockStore();
    const embedder = createMockEmbedder();

    const entry = await setReminder(store as any, embedder as any, {
      trigger: "deployment",
      action: "Check monitoring",
      scope: "project:test",
    });

    // Fire the reminder
    await fireReminder(store as any, entry.id);

    const reminders = await checkTriggers(
      store as any,
      embedder as any,
      "deployment is happening",
    );

    expect(reminders.length).toBe(0);
  });

  it("handles expired reminders", async () => {
    const store = createMockStore();
    const embedder = createMockEmbedder();

    // Create a reminder that's already expired
    const entry = await setReminder(store as any, embedder as any, {
      trigger: "something",
      action: "do something",
      scope: "project:test",
    });

    // Manually set expiresAt to past
    const meta = JSON.parse(entry.metadata);
    meta.prospective.expiresAt = "2020-01-01T00:00:00Z";
    entry.metadata = JSON.stringify(meta);

    const reminders = await checkTriggers(
      store as any,
      embedder as any,
      "something came up",
    );

    expect(reminders.length).toBe(0);
    // Should be marked as expired
    const updated = JSON.parse(entry.metadata);
    expect(updated.prospective.status).toBe("expired");
  });
});

// ---------------------------------------------------------------------------
// fireReminder
// ---------------------------------------------------------------------------

describe("fireReminder", () => {
  it("marks reminder as fired and returns action", async () => {
    const store = createMockStore();
    const embedder = createMockEmbedder();

    const entry = await setReminder(store as any, embedder as any, {
      trigger: "test",
      action: "do the thing",
      scope: "project:test",
    });

    const action = await fireReminder(store as any, entry.id);

    expect(action).toBe("do the thing");
    const meta = JSON.parse(store.data.get(entry.id)!.metadata);
    expect(meta.prospective.status).toBe("fired");
    expect(meta.prospective.firedAt).toBeTruthy();
  });

  it("returns null for non-existent entry", async () => {
    const store = createMockStore();
    const action = await fireReminder(store as any, "nonexistent");
    expect(action).toBeNull();
  });

  it("returns null for already-fired reminder", async () => {
    const store = createMockStore();
    const embedder = createMockEmbedder();

    const entry = await setReminder(store as any, embedder as any, {
      trigger: "test",
      action: "do it",
      scope: "project:test",
    });

    await fireReminder(store as any, entry.id);
    const secondFire = await fireReminder(store as any, entry.id);

    expect(secondFire).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatReminders
// ---------------------------------------------------------------------------

describe("formatReminders", () => {
  it("formats reminders for context injection", () => {
    const formatted = formatReminders([
      { entryId: "r1", trigger: "deploy", action: "Check monitoring after deploy" },
      { entryId: "r2", trigger: "meeting", action: "Bring up the budget issue" },
    ]);

    expect(formatted.length).toBe(2);
    expect(formatted[0]).toContain("deploy");
    expect(formatted[0]).toContain("Check monitoring after deploy");
    expect(formatted[1]).toContain("meeting");
  });

  it("handles empty array", () => {
    expect(formatReminders([])).toEqual([]);
  });
});
