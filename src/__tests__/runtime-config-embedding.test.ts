/**
 * Config plumbing for the embedding client's timeout knob.
 *
 * The socket-level behavior (does a configured timeout actually abort a hanging
 * endpoint?) lives in `openai-contract.test.ts`, next to the loopback harness it needs.
 * What is asserted here is the other half: that a value written in config.json — or in
 * `RECALLNEST_EMBEDDING_TIMEOUT_MS` — survives the trip through `createComponents` and
 * lands on the real client, and that **writing nothing anywhere leaves the SDK default
 * untouched**. A knob that is wired up but unreachable from config is not a feature.
 *
 * `createComponents` is cheap enough to call directly (LanceDB connects lazily, so no
 * database is created — measured at ~2ms), which is why this can be a plain unit test
 * rather than a fixture-heavy integration one.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";

import { createComponents, type LocalMemoryConfig } from "../runtime-config.js";

const ENV_KEY = "RECALLNEST_EMBEDDING_TIMEOUT_MS";
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

/** Read live rather than hard-coding 600000, so this keeps meaning "the SDK's own default". */
function sdkDefaultTimeout(): number {
  return (new OpenAI({ apiKey: "test-key-not-a-real-credential" }) as unknown as { timeout: number })
    .timeout;
}

function configWith(timeoutMs?: number): LocalMemoryConfig {
  return {
    dbPath: join(mkdtempSync(join(tmpdir(), "rn-embed-timeout-")), "lancedb"),
    embedding: {
      provider: "openai-compatible",
      apiKey: "test-key-not-a-real-credential",
      model: "text-embedding-3-small",
      dimensions: 3,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    },
    sources: {},
  };
}

function timeoutOnClient(config: LocalMemoryConfig): number {
  const { embedder } = createComponents(config);
  return (embedder as unknown as { client: { timeout: number } }).client.timeout;
}

describe("createComponents — embedding.timeoutMs plumbing", () => {
  it("neither config.json nor env set → SDK default, i.e. the behavior every release through v3.0.0 had", () => {
    expect(timeoutOnClient(configWith())).toBe(sdkDefaultTimeout());
  });

  it("config.json value reaches the client", () => {
    expect(timeoutOnClient(configWith(45_000))).toBe(45_000);
  });

  it("env alone reaches the client when config.json says nothing", () => {
    process.env[ENV_KEY] = "30000";
    expect(timeoutOnClient(configWith())).toBe(30_000);
  });

  it("env wins over config.json — a single deployment can bound itself without editing the shared file", () => {
    process.env[ENV_KEY] = "5000";
    expect(timeoutOnClient(configWith(45_000))).toBe(5_000);
  });

  it("an unusable env value falls through to config.json rather than overriding it with junk", () => {
    // The failure this prevents: a typo in one deployment's env silently disabling a
    // timeout the shared config deliberately set.
    for (const bad of ["", "   ", "abc", "0", "-1"]) {
      process.env[ENV_KEY] = bad;
      expect(timeoutOnClient(configWith(45_000))).toBe(45_000);
    }
  });

  it("junk in both places degrades to the SDK default, never to a broken timeout", () => {
    process.env[ENV_KEY] = "not-a-number";
    expect(timeoutOnClient(configWith(0))).toBe(sdkDefaultTimeout());
    expect(timeoutOnClient(configWith(-5))).toBe(sdkDefaultTimeout());
  });
});
