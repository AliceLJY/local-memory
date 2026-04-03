import { describe, it, expect } from "bun:test";
import {
  buildSupersedeMetadata,
  buildSupersedeMetadataForNew,
  parseEvolution,
  traceEvolution,
  patchEvolution,
  defaultEvolution,
} from "../memory-evolution.js";

describe("HP-1: Superseded chain enhancement", () => {
  describe("bidirectional linking", () => {
    it("buildSupersedeMetadata marks old → supersededBy", () => {
      const oldMeta = patchEvolution("{}", defaultEvolution());
      const result = buildSupersedeMetadata(oldMeta, "new-id");
      const evo = parseEvolution(result);
      expect(evo.status).toBe("superseded");
      expect(evo.supersededBy).toBe("new-id");
      expect(evo.validUntil).toBeGreaterThan(0);
    });

    it("buildSupersedeMetadataForNew marks new → supersedes + note", () => {
      const newMeta = patchEvolution("{}", defaultEvolution());
      const result = buildSupersedeMetadataForNew(newMeta, "old-id", "updated preference");
      const evo = parseEvolution(result);
      expect(evo.status).toBe("active"); // new memory stays active
      expect(evo.supersedes).toBe("old-id");
      expect(evo.evolutionNote).toBe("updated preference");
    });

    it("bidirectional: old.supersededBy == new.id AND new.supersedes == old.id", () => {
      const oldMeta = patchEvolution("{}", defaultEvolution());
      const newMeta = patchEvolution("{}", defaultEvolution());

      const updatedOld = buildSupersedeMetadata(oldMeta, "new-id");
      const updatedNew = buildSupersedeMetadataForNew(newMeta, "old-id");

      const oldEvo = parseEvolution(updatedOld);
      const newEvo = parseEvolution(updatedNew);

      expect(oldEvo.supersededBy).toBe("new-id");
      expect(newEvo.supersedes).toBe("old-id");
    });
  });

  describe("traceEvolution", () => {
    it("traces a 3-node chain", async () => {
      // v1 → v2 → v3
      const entries: Record<string, { metadata: string; timestamp: number }> = {
        v1: {
          metadata: patchEvolution("{}", {
            status: "superseded",
            supersededBy: "v2",
            validFrom: 1000,
            validUntil: 2000,
          }),
          timestamp: 1000,
        },
        v2: {
          metadata: patchEvolution("{}", {
            status: "superseded",
            supersedes: "v1",
            supersededBy: "v3",
            evolutionNote: "added detail",
            validFrom: 2000,
            validUntil: 3000,
          }),
          timestamp: 2000,
        },
        v3: {
          metadata: patchEvolution("{}", {
            status: "active",
            supersedes: "v2",
            evolutionNote: "corrected error",
            validFrom: 3000,
          }),
          timestamp: 3000,
        },
      };

      const getEntry = async (id: string) => entries[id] ?? null;

      // Trace from v2 (middle)
      const trace = await traceEvolution("v2", getEntry);
      expect(trace.length).toBe(3);
      expect(trace[0].id).toBe("v1");
      expect(trace[0].direction).toBe("predecessor");
      expect(trace[1].id).toBe("v2");
      expect(trace[1].direction).toBe("self");
      expect(trace[2].id).toBe("v3");
      expect(trace[2].direction).toBe("successor");
    });

    it("handles single node (no chain)", async () => {
      const getEntry = async (id: string) => {
        if (id === "solo") return { metadata: patchEvolution("{}", defaultEvolution()), timestamp: 1000 };
        return null;
      };

      const trace = await traceEvolution("solo", getEntry);
      expect(trace.length).toBe(1);
      expect(trace[0].direction).toBe("self");
    });

    it("respects maxDepth", async () => {
      // Create a long chain: v0 → v1 → v2 → ... → v20
      const entries: Record<string, { metadata: string; timestamp: number }> = {};
      for (let i = 0; i <= 20; i++) {
        entries[`v${i}`] = {
          metadata: patchEvolution("{}", {
            status: i < 20 ? "superseded" : "active",
            supersedes: i > 0 ? `v${i - 1}` : null,
            supersededBy: i < 20 ? `v${i + 1}` : null,
            validFrom: i * 1000,
          }),
          timestamp: i * 1000,
        };
      }

      const getEntry = async (id: string) => entries[id] ?? null;
      const trace = await traceEvolution("v10", getEntry, 3);
      // maxDepth=3: at most 3 predecessors + self + 3 successors = 7
      expect(trace.length).toBeLessThanOrEqual(7);
    });

    it("handles missing entries gracefully", async () => {
      const entries: Record<string, { metadata: string; timestamp: number }> = {
        v1: {
          metadata: patchEvolution("{}", {
            status: "active",
            supersedes: "missing",
            validFrom: 1000,
          }),
          timestamp: 1000,
        },
      };
      const getEntry = async (id: string) => entries[id] ?? null;
      const trace = await traceEvolution("v1", getEntry);
      expect(trace.length).toBe(1); // only self, missing predecessor stops chain
    });
  });

  describe("backward compatibility", () => {
    it("parseEvolution defaults new fields to null", () => {
      // Old metadata without supersedes/evolutionNote
      const oldMeta = JSON.stringify({
        evolution: { status: "active", version: 1, accessCount: 0 },
      });
      const evo = parseEvolution(oldMeta);
      expect(evo.supersedes).toBeNull();
      expect(evo.evolutionNote).toBeNull();
    });
  });
});
