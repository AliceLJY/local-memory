import { describe, expect, it, afterEach, beforeEach } from "bun:test";

import * as envConfig from "../env-config.js";

// Every RECALLNEST_* key this suite mutates. Snapshot + restore so we never leak
// env state into sibling test files (the whole `bun test` run shares one process).
const KEYS = [
  "RECALLNEST_MULTI_VECTOR",
  "RECALLNEST_EMOTION_SCORING",
  "RECALLNEST_PREDICTIVE_MEMORY",
  "RECALLNEST_SYNTHESIZE",
  "RECALLNEST_LLM_CONSOLIDATION",
  "RECALLNEST_CONSTRUCTIVE_RETRIEVAL",
  "RECALLNEST_NARRATIVE_MODE",
  "RECALLNEST_KG_MODE",
  "RECALLNEST_CORE_SUMMARY",
  "RECALLNEST_ERROR_SIGNATURE_BOOST",
  "RECALLNEST_DATA_DIR",
  "RECALLNEST_MCP_TIER",
  "RECALLNEST_RECALL_MODE",
  "RECALLNEST_UI_PORT",
  "RECALLNEST_API_PORT",
];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('env-config boolean flags — strict === "true"', () => {
  const accessors: Array<[string, () => boolean, string]> = [
    ["multiVector", envConfig.multiVector, "RECALLNEST_MULTI_VECTOR"],
    ["emotionScoring", envConfig.emotionScoring, "RECALLNEST_EMOTION_SCORING"],
    ["predictiveMemory", envConfig.predictiveMemory, "RECALLNEST_PREDICTIVE_MEMORY"],
    ["synthesize", envConfig.synthesize, "RECALLNEST_SYNTHESIZE"],
    ["llmConsolidation", envConfig.llmConsolidation, "RECALLNEST_LLM_CONSOLIDATION"],
    ["constructiveRetrieval", envConfig.constructiveRetrieval, "RECALLNEST_CONSTRUCTIVE_RETRIEVAL"],
    ["narrativeMode", envConfig.narrativeMode, "RECALLNEST_NARRATIVE_MODE"],
    ["kgMode", envConfig.kgMode, "RECALLNEST_KG_MODE"],
    ["coreSummary", envConfig.coreSummary, "RECALLNEST_CORE_SUMMARY"],
    ["errorSignatureBoost", envConfig.errorSignatureBoost, "RECALLNEST_ERROR_SIGNATURE_BOOST"],
  ];

  for (const [name, accessor, key] of accessors) {
    it(`${name}: false unless the value is exactly "true"`, () => {
      delete process.env[key];
      expect(accessor()).toBe(false);

      process.env[key] = "true";
      expect(accessor()).toBe(true);

      // No trim, no case-folding, no truthy coercion — only the literal "true".
      for (const fuzzy of ["True", "TRUE", " true ", "1", "yes", "false", ""]) {
        process.env[key] = fuzzy;
        expect(accessor()).toBe(false);
      }
    });
  }
});

describe("env-config string settings — || default (empty string falls through)", () => {
  it('dataDir defaults to "data" when unset or empty', () => {
    delete process.env.RECALLNEST_DATA_DIR;
    expect(envConfig.dataDir()).toBe("data");

    process.env.RECALLNEST_DATA_DIR = ""; // || not ??
    expect(envConfig.dataDir()).toBe("data");

    process.env.RECALLNEST_DATA_DIR = "/tmp/custom-data";
    expect(envConfig.dataDir()).toBe("/tmp/custom-data");
  });

  it('mcpTier defaults to "advanced"; valid passes through; illegal value kept verbatim', () => {
    delete process.env.RECALLNEST_MCP_TIER;
    expect(envConfig.mcpTier()).toBe("advanced");

    process.env.RECALLNEST_MCP_TIER = ""; // || not ??
    expect(envConfig.mcpTier()).toBe("advanced");

    process.env.RECALLNEST_MCP_TIER = "core";
    expect(envConfig.mcpTier()).toBe("core");

    // No runtime validation — an unknown non-empty value is preserved as-is
    // (downstream shouldRegisterTool relies on this; do not coerce to default).
    process.env.RECALLNEST_MCP_TIER = "garbage";
    expect(envConfig.mcpTier()).toBe("garbage");
  });
});

describe("env-config raw passthrough — caller validates / clamps / falls back", () => {
  const rawAccessors: Array<[string, () => string | undefined, string]> = [
    ["recallModeRaw", envConfig.recallModeRaw, "RECALLNEST_RECALL_MODE"],
    ["uiPortRaw", envConfig.uiPortRaw, "RECALLNEST_UI_PORT"],
    ["apiPortRaw", envConfig.apiPortRaw, "RECALLNEST_API_PORT"],
  ];

  for (const [name, accessor, key] of rawAccessors) {
    it(`${name}: returns the raw env value, undefined when unset`, () => {
      delete process.env[key];
      expect(accessor()).toBeUndefined();

      process.env[key] = "verbatim-123";
      expect(accessor()).toBe("verbatim-123");

      // Raw passthrough: empty string is NOT defaulted here — the caller decides.
      process.env[key] = "";
      expect(accessor()).toBe("");
    });
  }
});

describe("env-config recallModeRaw — must not pre-default (preserves resolveRecallMode config fallback)", () => {
  it('returns the raw value or undefined, never a hardcoded mode like "summary"', () => {
    delete process.env.RECALLNEST_RECALL_MODE;
    // Must be undefined, NOT "summary" — resolveRecallMode owns the config fallback.
    expect(envConfig.recallModeRaw()).toBeUndefined();

    process.env.RECALLNEST_RECALL_MODE = "light";
    expect(envConfig.recallModeRaw()).toBe("light");

    // Invalid modes pass through verbatim — the whitelist check lives in resolveRecallMode.
    process.env.RECALLNEST_RECALL_MODE = "bogus";
    expect(envConfig.recallModeRaw()).toBe("bogus");
  });
});

describe("env-config accessors are lazy (read at call time, never frozen)", () => {
  it("reflect runtime mutation rather than a module-load snapshot", () => {
    delete process.env.RECALLNEST_EMOTION_SCORING;
    expect(envConfig.emotionScoring()).toBe(false);

    process.env.RECALLNEST_EMOTION_SCORING = "true";
    expect(envConfig.emotionScoring()).toBe(true); // would fail if cached at import

    delete process.env.RECALLNEST_EMOTION_SCORING;
    expect(envConfig.emotionScoring()).toBe(false);
  });
});
