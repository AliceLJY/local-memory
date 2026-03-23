import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveRecallMode, type LocalMemoryConfig } from "../runtime-config.js";

const baseConfig: LocalMemoryConfig = {
  dbPath: "./data/lancedb",
  embedding: {
    provider: "jina",
    apiKey: "test",
    model: "test-model",
  },
  sources: {},
};

describe("resolveRecallMode", () => {
  const originalEnv = process.env.RECALLNEST_RECALL_MODE;

  beforeEach(() => {
    delete process.env.RECALLNEST_RECALL_MODE;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.RECALLNEST_RECALL_MODE;
    } else {
      process.env.RECALLNEST_RECALL_MODE = originalEnv;
    }
  });

  it("defaults to 'summary' when no config, no env, no override", () => {
    delete process.env.RECALLNEST_RECALL_MODE;
    expect(resolveRecallMode(baseConfig)).toBe("summary");
  });

  it("reads from config.recallMode", () => {
    delete process.env.RECALLNEST_RECALL_MODE;
    expect(resolveRecallMode({ ...baseConfig, recallMode: "full" })).toBe("full");
    expect(resolveRecallMode({ ...baseConfig, recallMode: "off" })).toBe("off");
  });

  it("env var overrides config", () => {
    process.env.RECALLNEST_RECALL_MODE = "off";
    expect(resolveRecallMode({ ...baseConfig, recallMode: "full" })).toBe("off");
  });

  it("per-call override takes highest priority", () => {
    process.env.RECALLNEST_RECALL_MODE = "off";
    expect(resolveRecallMode({ ...baseConfig, recallMode: "full" }, "summary")).toBe("summary");
  });

  it("ignores invalid per-call override, falls back to env", () => {
    process.env.RECALLNEST_RECALL_MODE = "full";
    expect(resolveRecallMode(baseConfig, "invalid")).toBe("full");
  });

  it("ignores invalid env var, falls back to config", () => {
    process.env.RECALLNEST_RECALL_MODE = "garbage";
    expect(resolveRecallMode({ ...baseConfig, recallMode: "off" })).toBe("off");
  });

  it("ignores invalid env var and no config, falls back to default", () => {
    process.env.RECALLNEST_RECALL_MODE = "garbage";
    expect(resolveRecallMode(baseConfig)).toBe("summary");
  });
});
