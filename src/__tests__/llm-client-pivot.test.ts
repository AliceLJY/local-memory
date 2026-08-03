import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LLMClient } from "../llm-client.js";
import {
  buildPivotLlmConfig,
  buildPivotRequestProfile,
  buildStratifiedSample,
  loadFrozenBundle,
  main as pivotMain,
  PIPELINE_VERSION,
  PIVOT_MODEL,
  pivotRequestProfileHash,
  PROMPT_VERSION,
  selectionIdentityHash,
  writeFrozenBundle,
  type SessionMeta,
} from "../../scripts/pivot-distill.js";

interface CapturedRequest {
  method: string;
  url: string;
  body: unknown;
}

interface LoopbackStub {
  baseURL: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

interface PlannedResponse {
  body: Record<string, unknown>;
  statusCode?: number;
  headers?: Record<string, string>;
}

async function startLoopbackStub(
  responseBody: Record<string, unknown> | PlannedResponse[],
  statusCode = 200,
  responseHeaders: Record<string, string> = {},
): Promise<LoopbackStub> {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        body,
      });
      const planned = Array.isArray(responseBody)
        ? responseBody[Math.min(requests.length - 1, responseBody.length - 1)]
        : { body: responseBody, statusCode, headers: responseHeaders };
      response.writeHead(planned.statusCode ?? 200, {
        "content-type": "application/json",
        connection: "close",
        ...(planned.headers ?? {}),
      });
      response.end(JSON.stringify(planned.body));
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain", connection: "close" });
      response.end(error instanceof Error ? error.message : "loopback stub error");
    }
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Loopback stub did not receive a TCP address");
  }

  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}

function completionResponse(options: {
  content: string | null;
  finishReason: "stop" | "length";
  model: string;
  usage?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: "chatcmpl-loopback",
    object: "chat.completion",
    created: 0,
    model: options.model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: options.content },
      logprobs: null,
      finish_reason: options.finishReason,
    }],
    ...(options.usage ? { usage: options.usage } : {}),
  };
}

describe("LLMClient pivot detailed chat", () => {
  it("sends the exact Qwen-compatible request body and returns normalized metadata", async () => {
    const stub = await startLoopbackStub(completionResponse({
      content: "  {\"ok\":true}  ",
      finishReason: "stop",
      model: "qwen-response-snapshot",
      usage: {
        prompt_tokens: 120,
        completion_tokens: 18,
        total_tokens: 138,
        prompt_tokens_details: { cached_tokens: 12 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    }));
    try {
      const unsafeBaseURL = stub.baseURL.replace("http://", "http://user:password@") +
        "?token=secret#fragment";
      const profile = buildPivotRequestProfile(unsafeBaseURL);
      const client = new LLMClient(buildPivotLlmConfig({
        apiKey: "loopback-test-key",
        model: "qwen-request-snapshot",
        baseURL: unsafeBaseURL,
      }, profile, 1_000));

      const result = await client.chatLongDetailed("system prompt", "user prompt", {
        temperature: 0.05,
        enableThinking: false,
        responseFormat: { type: "json_object" },
        tokenLimit: { parameter: "max_tokens", value: 321 },
      });

      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]).toEqual({
        method: "POST",
        url: "/v1/chat/completions",
        body: {
          model: PIVOT_MODEL,
          messages: [
            { role: "system", content: "system prompt" },
            { role: "user", content: "user prompt" },
          ],
          temperature: 0.05,
          max_tokens: 321,
          response_format: { type: "json_object" },
          enable_thinking: false,
        },
      });
      expect(result).toEqual({
        content: "{\"ok\":true}",
        finishReason: "stop",
        responseModel: "qwen-response-snapshot",
        usage: {
          promptTokens: 120,
          completionTokens: 18,
          totalTokens: 138,
          cachedPromptTokens: 12,
          reasoningTokens: 3,
        },
      });
    } finally {
      await stub.close();
    }
  });

  it("disables hidden SDK retries so one outer attempt sends one HTTP request", async () => {
    const stub = await startLoopbackStub({
      error: { message: "temporary failure", type: "server_error" },
    }, 500, { "retry-after": "0" });
    try {
      const client = new LLMClient({
        apiKey: "loopback-test-key",
        model: "qwen-request-snapshot",
        baseURL: stub.baseURL,
        timeoutMs: 1_000,
        maxRetries: 0,
      });
      await expect(client.chatLongDetailed("system", "user")).rejects.toThrow();
      expect(stub.requests).toHaveLength(1);
    } finally {
      await stub.close();
    }
  });

  it("supports max_completion_tokens and exposes a length finish reason", async () => {
    const stub = await startLoopbackStub(completionResponse({
      content: "{\"partial\":true}",
      finishReason: "length",
      model: "qwen-response-snapshot",
    }));
    try {
      const client = new LLMClient({
        apiKey: "loopback-test-key",
        model: "qwen-request-snapshot",
        baseURL: stub.baseURL,
        timeoutMs: 1_000,
      });

      const result = await client.chatLongDetailed("system", "user", {
        tokenLimit: { parameter: "max_completion_tokens", value: 456 },
      });

      expect(stub.requests[0].body).toEqual({
        model: "qwen-request-snapshot",
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "user" },
        ],
        temperature: 0.1,
        max_completion_tokens: 456,
      });
      expect(result).toEqual({
        content: "{\"partial\":true}",
        finishReason: "length",
        responseModel: "qwen-response-snapshot",
        usage: null,
      });
    } finally {
      await stub.close();
    }
  });

  it("keeps chatLong as a string-or-null max_tokens wrapper", async () => {
    const stub = await startLoopbackStub(completionResponse({
      content: "  legacy content  ",
      finishReason: "stop",
      model: "legacy-response-model",
    }));
    try {
      const client = new LLMClient({
        apiKey: "loopback-test-key",
        model: "legacy-request-model",
        baseURL: stub.baseURL,
        timeoutMs: 1_000,
        temperature: 0.25,
      });

      const result: string | null = await client.chatLong("legacy system", "legacy user", 77);

      expect(result).toBe("legacy content");
      expect(stub.requests[0].body).toEqual({
        model: "legacy-request-model",
        messages: [
          { role: "system", content: "legacy system" },
          { role: "user", content: "legacy user" },
        ],
        temperature: 0.25,
        max_tokens: 77,
      });
    } finally {
      await stub.close();
    }
  });

  it("runs authorized transport only from the frozen bundle with bounded retries and complete audit identity", async () => {
    const invalidUsage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
    const successUsage = { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 };
    const success = completionResponse({
      content: JSON.stringify({ hasPivot: false, candidates: [] }),
      finishReason: "stop",
      model: PIVOT_MODEL,
      usage: successUsage,
    });
    const stub = await startLoopbackStub([
      {
        statusCode: 429,
        headers: { "retry-after": "0" },
        body: { error: { message: "rate limited", type: "rate_limit_error" } },
      },
      {
        body: completionResponse({
          content: "not-json",
          finishReason: "stop",
          model: PIVOT_MODEL,
          usage: invalidUsage,
        }),
      },
      { body: success },
    ]);
    const root = mkdtempSync(join(tmpdir(), "pivot-transport-loopback-"));
    const sourcePath = join(root, "source.jsonl");
    writeFileSync(sourcePath, "{}\n");
    const sourceStat = statSync(sourcePath, { bigint: true });
    const profile = buildPivotRequestProfile(stub.baseURL, 600);
    const descriptor = writeFrozenBundle(root, [{
      session: {
        key: "codex:loopback-session",
        sessionId: "loopback-session",
        rawHarness: "codex",
        harness: "codex",
        parserKind: "codex-rollout",
        project: "test",
        path: sourcePath,
        date: "2026-08-03",
        sizeBytes: Number(sourceStat.size),
        mtimeNs: sourceStat.mtimeNs.toString(),
        origin: "deja",
        fingerprint: "placeholder",
      } satisfies SessionMeta,
      sample: buildStratifiedSample([
        { role: "user", text: "请保留可以回查的出处" },
        { role: "assistant", text: "已经记录出处" },
      ], 600),
    }], profile, pivotRequestProfileHash(profile));
    const bundleDir = join(root, "input-bundle");
    const loaded = loadFrozenBundle(bundleDir, descriptor.bundleHash, descriptor.requestProfileHash);
    const entry = loaded.entries[0];
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({
      llm: { apiKey: "loopback-test-key", model: "qwen-turbo", baseURL: stub.baseURL },
    }));
    const outputDir = join(root, "transport-output");
    mkdirSync(outputDir, { mode: 0o755 });
    const dejaMarker = join(root, "deja-was-called");
    const fakeDeja = join(root, "must-not-run-deja.sh");
    writeFileSync(fakeDeja, `#!/bin/sh\ntouch "${dejaMarker}"\nexit 99\n`, { mode: 0o700 });
    chmodSync(fakeDeja, 0o700);
    const args = [
      "--mode", "transport",
      "--input-bundle", bundleDir,
      "--bundle-hash", descriptor.bundleHash,
      "--request-profile-hash", descriptor.requestProfileHash,
      "--session-key", entry.session.key,
      "--output-dir", outputDir,
      "--deja-bin", fakeDeja,
      "--allow-external-llm",
    ];
    const previousConfig = process.env.LOCAL_MEMORY_CONFIG;
    process.env.LOCAL_MEMORY_CONFIG = configPath;
    try {
      await pivotMain(args);
      expect(stub.requests).toHaveLength(3);
      expect(stub.requests.every((request) => request.url === "/v1/chat/completions")).toBe(true);
      expect(existsSync(dejaMarker)).toBe(false);
      const resultPath = join(outputDir, "results", `${entry.session.fingerprint}.json`);
      const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
        mode: string;
        selectionHash: string;
        outboundSampleSha256: string;
        status: string;
        attempts: number;
        responseModel: string;
        usage: { promptTokens: number; completionTokens: number; totalTokens: number };
        attemptErrors: string[];
      };
      expect(result).toMatchObject({
        mode: "transport",
        outboundSampleSha256: entry.sampleSha256,
        status: "ok",
        attempts: 3,
        responseModel: PIVOT_MODEL,
        usage: { promptTokens: 21, completionTokens: 5, totalTokens: 26 },
      });
      expect(result.selectionHash).toHaveLength(64);
      expect(result.attemptErrors).toHaveLength(2);
      const invalid = JSON.parse(
        readFileSync(join(outputDir, "invalid", `${entry.session.fingerprint}.json`), "utf8"),
      ) as { attempts: Array<{ usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> };
      expect(invalid.attempts).toHaveLength(2);
      expect(invalid.attempts[1].usage).toEqual({
        promptTokens: 10, completionTokens: 2, totalTokens: 12,
      });
      const summary = JSON.parse(readFileSync(join(outputDir, "summary.json"), "utf8")) as Record<string, unknown>;
      const reportState = JSON.parse(
        readFileSync(join(outputDir, "report-state.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(summary).toMatchObject({
        reportStatus: "complete",
        mode: "transport",
        selectionHash: result.selectionHash,
        manifestSessions: 1,
        resultSessions: 1,
        usage: { promptTokens: 21, completionTokens: 5, totalTokens: 26 },
        attemptAudit: {
          validLedgers: 1,
          invalidLedgers: 0,
          startedAttempts: 3,
          inFlightAttempts: 0,
          recordedUsage: { promptTokens: 21, completionTokens: 5, totalTokens: 26 },
        },
      });
      expect(reportState).toMatchObject({
        status: "complete", mode: "transport", selectionHash: result.selectionHash,
      });
      expect(statSync(outputDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(outputDir, "results")).mode & 0o777).toBe(0o700);
      expect(statSync(join(outputDir, "attempts")).mode & 0o777).toBe(0o700);
      expect(statSync(resultPath).mode & 0o777).toBe(0o600);
      expect(statSync(join(outputDir, "attempts", `${entry.session.fingerprint}.json`)).mode & 0o777)
        .toBe(0o600);
      expect(statSync(join(outputDir, "summary.json")).mode & 0o777).toBe(0o600);

      await pivotMain(args);
      expect(stub.requests).toHaveLength(3);
      result.responseModel = "tampered-model";
      writeFileSync(resultPath, `${JSON.stringify(result)}\n`);
      await expect(pivotMain(args)).rejects.toThrow("failed strict identity validation");
      expect(stub.requests).toHaveLength(3);
      expect(JSON.parse(readFileSync(join(outputDir, "report-state.json"), "utf8")))
        .toMatchObject({ status: "partial" });
      expect(JSON.parse(readFileSync(join(outputDir, "summary.json"), "utf8")))
        .toMatchObject({ reportStatus: "partial", resultSessions: 0 });
    } finally {
      if (previousConfig === undefined) delete process.env.LOCAL_MEMORY_CONFIG;
      else process.env.LOCAL_MEMORY_CONFIG = previousConfig;
      await stub.close();
    }
  }, 15_000);

  it("preserves empty-content usage and refuses to reset a failed run's three-attempt budget", async () => {
    const usage = [
      { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 },
    ];
    const stub = await startLoopbackStub(usage.map((attemptUsage, index) => ({
      body: completionResponse({
        content: index === 0 ? null : "not-json",
        finishReason: "stop",
        model: PIVOT_MODEL,
        usage: attemptUsage,
      }),
    })));
    const root = mkdtempSync(join(tmpdir(), "pivot-failed-resume-loopback-"));
    const sourcePath = join(root, "source.jsonl");
    writeFileSync(sourcePath, "{}\n");
    const sourceStat = statSync(sourcePath, { bigint: true });
    const profile = buildPivotRequestProfile(stub.baseURL, 600);
    const descriptor = writeFrozenBundle(root, [{
      session: {
        key: "codex:failed-resume-session",
        sessionId: "failed-resume-session",
        rawHarness: "codex",
        harness: "codex",
        parserKind: "codex-rollout",
        project: "test",
        path: sourcePath,
        date: "2026-08-03",
        sizeBytes: Number(sourceStat.size),
        mtimeNs: sourceStat.mtimeNs.toString(),
        origin: "deja",
        fingerprint: "placeholder",
      } satisfies SessionMeta,
      sample: buildStratifiedSample([
        { role: "user", text: "请保留可以回查的出处" },
        { role: "assistant", text: "已经记录出处" },
      ], 600),
    }], profile, pivotRequestProfileHash(profile));
    const bundleDir = join(root, "input-bundle");
    const entry = loadFrozenBundle(
      bundleDir, descriptor.bundleHash, descriptor.requestProfileHash,
    ).entries[0];
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({
      llm: { apiKey: "loopback-test-key", model: "qwen-turbo", baseURL: stub.baseURL },
    }));
    const outputDir = join(root, "transport-output");
    const args = [
      "--mode", "transport",
      "--input-bundle", bundleDir,
      "--bundle-hash", descriptor.bundleHash,
      "--request-profile-hash", descriptor.requestProfileHash,
      "--session-key", entry.session.key,
      "--output-dir", outputDir,
      "--allow-external-llm",
    ];
    const previousConfig = process.env.LOCAL_MEMORY_CONFIG;
    process.env.LOCAL_MEMORY_CONFIG = configPath;
    try {
      await expect(pivotMain(args)).rejects.toThrow("Stopped after 3 failed attempt(s)");
      expect(stub.requests).toHaveLength(3);
      const resultPath = join(outputDir, "results", `${entry.session.fingerprint}.json`);
      const resultBeforeResume = readFileSync(resultPath, "utf8");
      const result = JSON.parse(resultBeforeResume) as {
        status: string;
        attempts: number;
        usage: { promptTokens: number; completionTokens: number; totalTokens: number };
        attemptErrors: string[];
      };
      expect(result).toMatchObject({
        status: "invalid",
        attempts: 3,
        usage: { promptTokens: 15, completionTokens: 6, totalTokens: 21 },
      });
      expect(result.attemptErrors).toHaveLength(3);
      const invalid = JSON.parse(
        readFileSync(join(outputDir, "invalid", `${entry.session.fingerprint}.json`), "utf8"),
      ) as {
        recovered: boolean;
        attempts: Array<{
          responseModel?: string;
          finishReason?: string | null;
          usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
        }>;
      };
      expect(invalid.recovered).toBeFalse();
      expect(invalid.attempts).toHaveLength(3);
      expect(invalid.attempts[0]).toMatchObject({
        responseModel: PIVOT_MODEL,
        finishReason: "stop",
        usage: { promptTokens: 4, completionTokens: 1, totalTokens: 5 },
      });

      await expect(pivotMain(args)).rejects.toThrow("already records 3 attempt(s)");
      expect(stub.requests).toHaveLength(3);
      expect(readFileSync(resultPath, "utf8")).toBe(resultBeforeResume);
    } finally {
      if (previousConfig === undefined) delete process.env.LOCAL_MEMORY_CONFIG;
      else process.env.LOCAL_MEMORY_CONFIG = previousConfig;
      await stub.close();
    }
  }, 15_000);

  it("refuses a crash-marked in-flight attempt without sending another request", async () => {
    const stub = await startLoopbackStub(completionResponse({
      content: JSON.stringify({ hasPivot: false, candidates: [] }),
      finishReason: "stop",
      model: PIVOT_MODEL,
    }));
    const root = mkdtempSync(join(tmpdir(), "pivot-in-flight-loopback-"));
    const sourcePath = join(root, "source.jsonl");
    writeFileSync(sourcePath, "{}\n");
    const sourceStat = statSync(sourcePath, { bigint: true });
    const profile = buildPivotRequestProfile(stub.baseURL, 600);
    const descriptor = writeFrozenBundle(root, [{
      session: {
        key: "codex:in-flight-session",
        sessionId: "in-flight-session",
        rawHarness: "codex",
        harness: "codex",
        parserKind: "codex-rollout",
        project: "test",
        path: sourcePath,
        date: "2026-08-03",
        sizeBytes: Number(sourceStat.size),
        mtimeNs: sourceStat.mtimeNs.toString(),
        origin: "deja",
        fingerprint: "placeholder",
      } satisfies SessionMeta,
      sample: buildStratifiedSample([
        { role: "user", text: "崩溃后不要偷偷重发请求" },
        { role: "assistant", text: "会先保留请求预算记录" },
      ], 600),
    }], profile, pivotRequestProfileHash(profile));
    const bundleDir = join(root, "input-bundle");
    const entry = loadFrozenBundle(
      bundleDir, descriptor.bundleHash, descriptor.requestProfileHash,
    ).entries[0];
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({
      llm: { apiKey: "loopback-test-key", model: "qwen-turbo", baseURL: stub.baseURL },
    }));
    const outputDir = join(root, "transport-output");
    const attemptsDir = join(outputDir, "attempts");
    mkdirSync(attemptsDir, { recursive: true, mode: 0o700 });
    const selectionHash = selectionIdentityHash("transport", [entry]);
    writeFileSync(join(attemptsDir, `${entry.session.fingerprint}.json`), `${JSON.stringify({
      schemaVersion: 1,
      mode: "transport",
      selectionHash,
      outboundSampleSha256: entry.sampleSha256,
      promptVersion: PROMPT_VERSION,
      pipelineVersion: PIPELINE_VERSION,
      model: PIVOT_MODEL,
      requestProfileHash: descriptor.requestProfileHash,
      bundleHash: descriptor.bundleHash,
      session: entry.session,
      maxSessionAttempts: profile.retryPolicy.maxSessionAttempts,
      attempts: [{
        attempt: 1,
        state: "in-flight",
        startedAt: "2026-08-03T00:00:00.000Z",
      }],
      updatedAt: "2026-08-03T00:00:00.000Z",
    }, null, 2)}\n`, { mode: 0o600 });
    const args = [
      "--mode", "transport",
      "--input-bundle", bundleDir,
      "--bundle-hash", descriptor.bundleHash,
      "--request-profile-hash", descriptor.requestProfileHash,
      "--session-key", entry.session.key,
      "--output-dir", outputDir,
      "--allow-external-llm",
    ];
    const previousConfig = process.env.LOCAL_MEMORY_CONFIG;
    process.env.LOCAL_MEMORY_CONFIG = configPath;
    try {
      await expect(pivotMain(args)).rejects.toThrow("incomplete attempt ledger");
      expect(stub.requests).toHaveLength(0);
      expect(JSON.parse(readFileSync(join(outputDir, "report-state.json"), "utf8")))
        .toMatchObject({ status: "partial" });
      expect(JSON.parse(readFileSync(join(outputDir, "summary.json"), "utf8")))
        .toMatchObject({
          reportStatus: "partial",
          resultSessions: 0,
          attemptAudit: {
            validLedgers: 1,
            invalidLedgers: 0,
            startedAttempts: 1,
            inFlightAttempts: 1,
            recordedUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          },
        });
    } finally {
      if (previousConfig === undefined) delete process.env.LOCAL_MEMORY_CONFIG;
      else process.env.LOCAL_MEMORY_CONFIG = previousConfig;
      await stub.close();
    }
  }, 15_000);
});
