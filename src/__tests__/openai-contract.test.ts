/**
 * OpenAI-compatible HTTP contract tests.
 *
 * Why these exist (v3.0.0): the `openai` SDK moved from v4 to v7, which replaced the
 * bundled `node-fetch` transport with the platform's built-in `fetch`. Every existing
 * embedder/LLM test stubs `client.embeddings.create` or `client.chat.completions.create`
 * with a plain async function, so **none of them touch a socket** — a transport-level
 * regression (wrong URL, dropped field, mis-typed error) would pass all of them.
 *
 * These tests drive the real `Embedder` / `LLMClient` classes through the real SDK over
 * a real loopback HTTP server, and assert both directions of the contract:
 *
 *   request  — what recallnest actually puts on the wire for each provider profile
 *   response — how it parses success, and how it fails on error and timeout
 *
 * No network egress, no vendor credentials, no paid calls: every endpoint is a
 * `node:http` server bound to 127.0.0.1 on an ephemeral port, and every API key is a
 * literal test string.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import OpenAI from "openai";

import { Embedder } from "../embedder.js";
import { LLMClient } from "../llm-client.js";

// ---------------------------------------------------------------------------
// Mock endpoint
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
  hasAuthorization: boolean;
}

interface MockEndpoint {
  /** Base URL including the `/v1` suffix, matching how providers are configured. */
  baseURL: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

type Responder = (req: CapturedRequest, res: ServerResponse) => void;

/** Never answers — used to exercise timeout paths without a real slow vendor. */
const HANG: Responder = () => {};

async function startMockEndpoint(respond: Responder): Promise<MockEndpoint> {
  const requests: CapturedRequest[] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body: Record<string, unknown> | null = null;
      if (raw) {
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = null;
        }
      }
      const captured: CapturedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        body,
        hasAuthorization: Boolean(req.headers.authorization),
      };
      requests.push(captured);
      respond(captured, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    async close() {
      // Hanging requests keep sockets open; closeAllConnections lets close() settle.
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Deterministic vector of the exact width the embedder was configured for. */
function vec(dimensions: number, seed = 1): number[] {
  return Array.from({ length: dimensions }, (_, i) => Number(((seed + i) % 97) / 100));
}

function embeddingResponse(vectors: number[][]): string {
  return JSON.stringify({
    object: "list",
    data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
    model: "mock-embedding-model",
    usage: { prompt_tokens: 4, total_tokens: 4 },
  });
}

function chatResponse(content: string): string {
  return JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "mock-chat-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 2 },
    },
  });
}

const okJson = (payload: string): Responder => (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(payload);
};

const errorJson = (status: number, message: string): Responder => (_req, res) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message, type: "invalid_request_error" } }));
};

/** Endpoints opened by the running test, closed in afterEach even when it fails. */
let openEndpoints: MockEndpoint[] = [];

async function endpoint(respond: Responder): Promise<MockEndpoint> {
  const created = await startMockEndpoint(respond);
  openEndpoints.push(created);
  return created;
}

afterEach(async () => {
  const pending = openEndpoints;
  openEndpoints = [];
  await Promise.all(pending.map((e) => e.close()));
});

/**
 * Swap in a client built exactly like the production one, plus a short timeout and no
 * SDK-level retries. Embedder has no timeout knob of its own, so this is the only way to
 * exercise the timeout branch in bounded time; `maxRetries: 0` isolates recallnest's own
 * retry policy from the SDK's so the request count is unambiguous.
 */
function useBoundedClient(embedder: Embedder, baseURL: string, timeoutMs: number): void {
  (embedder as unknown as { client: OpenAI }).client = new OpenAI({
    apiKey: "test-key-not-a-real-credential",
    baseURL,
    timeout: timeoutMs,
    maxRetries: 0,
  });
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

describe("OpenAI-compatible embeddings contract", () => {
  it("sends the default OpenAI request shape and parses the vector back", async () => {
    const mock = await endpoint(okJson(embeddingResponse([[0.1, 0.2, 0.3]])));

    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key-not-a-real-credential",
      model: "text-embedding-3-small",
      baseURL: mock.baseURL,
      dimensions: 3,
    });

    await expect(embedder.embedPassage("hello world")).resolves.toEqual([0.1, 0.2, 0.3]);

    expect(mock.requests).toHaveLength(1);
    const [request] = mock.requests;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/v1/embeddings");
    expect(request.hasAuthorization).toBe(true);
    expect(request.body).toMatchObject({
      model: "text-embedding-3-small",
      input: "hello world",
      // Forced by buildPayload so the SDK does not take its base64 decode path.
      encoding_format: "float",
    });
    // A plain OpenAI endpoint must not receive provider-specific extensions.
    expect(request.body).not.toHaveProperty("task");
    expect(request.body).not.toHaveProperty("normalized");
  });

  it("sends Jina's task/normalized/dimensions extensions and distinguishes query from passage", async () => {
    const jinaVector = vec(1024, 4);
    const mock = await endpoint(okJson(embeddingResponse([jinaVector])));

    // Mirrors config.json.example's shipped Jina profile.
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key-not-a-real-credential",
      model: "jina-embeddings-v5-text-small",
      baseURL: mock.baseURL,
      dimensions: 1024,
      taskQuery: "retrieval.query",
      taskPassage: "retrieval.passage",
      normalized: true,
    });

    await expect(embedder.embedQuery("who is on call")).resolves.toEqual(jinaVector);
    await expect(embedder.embedPassage("the on-call rota lives in ops")).resolves.toEqual(jinaVector);

    expect(mock.requests).toHaveLength(2);
    const [queryRequest, passageRequest] = mock.requests;

    expect(queryRequest.url).toBe("/v1/embeddings");
    expect(queryRequest.body).toMatchObject({
      model: "jina-embeddings-v5-text-small",
      task: "retrieval.query",
      normalized: true,
      dimensions: 1024,
      encoding_format: "float",
    });

    // Asymmetric embedding is the whole point of the task fields — pin the difference.
    expect(passageRequest.body).toMatchObject({ task: "retrieval.passage", normalized: true });
    expect(queryRequest.body?.task).not.toBe(passageRequest.body?.task);
  });

  it("omits dimensions for a Qwen-compatible endpoint that was not given an override", async () => {
    const qwenVector = vec(1024, 7);
    const mock = await endpoint(okJson(embeddingResponse([qwenVector])));

    // Qwen3 embedding via a local OpenAI-compatible runner: known model, no override,
    // no task fields. Providers that reject unknown fields must not receive any.
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key-not-a-real-credential",
      model: "ai/qwen3-embedding",
      baseURL: mock.baseURL,
    });

    await expect(embedder.embedPassage("qwen passage")).resolves.toEqual(qwenVector);
    expect(embedder.dimensions).toBe(1024);

    const [request] = mock.requests;
    expect(request.body).toMatchObject({ model: "ai/qwen3-embedding", input: "qwen passage" });
    expect(request.body).not.toHaveProperty("dimensions");
    expect(request.body).not.toHaveProperty("task");
    expect(request.body).not.toHaveProperty("normalized");
  });

  it("batches several passages into one request and preserves input order", async () => {
    const mock = await endpoint(okJson(embeddingResponse([[1, 0, 0], [0, 1, 0], [0, 0, 1]])));

    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key-not-a-real-credential",
      model: "text-embedding-3-small",
      baseURL: mock.baseURL,
      dimensions: 3,
      chunking: false,
    });

    await expect(embedder.embedBatchPassage(["alpha", "beta", "gamma"])).resolves.toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);

    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.body?.input).toEqual(["alpha", "beta", "gamma"]);
  });

  it("surfaces a provider error instead of returning a silent empty vector", async () => {
    const mock = await endpoint(errorJson(400, "input exceeds maximum context length"));

    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key-not-a-real-credential",
      model: "text-embedding-3-small",
      baseURL: mock.baseURL,
      dimensions: 3,
    });
    // maxRetries: 0 — a 400 is not retryable, but pinning it makes the count meaningful.
    useBoundedClient(embedder, mock.baseURL, 5_000);

    await expect(embedder.embedPassage("too long")).rejects.toThrow(/context length/);

    // A non-transient error must not be retried by recallnest's own retry loop.
    expect(mock.requests).toHaveLength(1);
  });

  it("does not retry an authentication failure", async () => {
    const mock = await endpoint(errorJson(401, "invalid api key"));

    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key-not-a-real-credential",
      model: "text-embedding-3-small",
      baseURL: mock.baseURL,
      dimensions: 3,
    });
    useBoundedClient(embedder, mock.baseURL, 5_000);

    await expect(embedder.embedPassage("hello")).rejects.toThrow(/invalid api key/);
    expect(mock.requests).toHaveLength(1);
  });

  it("does not turn a rate-limit reply into a chunking storm", async () => {
    const mock = await endpoint(errorJson(429, "Rate limit exceeded, please retry later"));

    // Regression guard. The context-error branch is gated on
    // /context|too long|exceed|length/i, which also matches rate-limit wording, and the
    // chunker returns short text unchanged — so re-embedding "the chunk" reproduced the
    // same 429 and chunked again. Measured before the fix: >61,000 requests in 5s against
    // an endpoint that was asking us to slow down. Bounded failure is the contract.
    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key-not-a-real-credential",
      model: "text-embedding-3-small",
      baseURL: mock.baseURL,
      dimensions: 3,
    });
    useBoundedClient(embedder, mock.baseURL, 5_000);

    await expect(embedder.embedPassage("short text")).rejects.toThrow();
    expect(mock.requests.length).toBeLessThanOrEqual(3);
  }, 15_000);

  it("classifies a request timeout as transient and retries before giving up", async () => {
    const mock = await endpoint(HANG);

    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "test-key-not-a-real-credential",
      model: "text-embedding-3-small",
      baseURL: mock.baseURL,
      dimensions: 3,
    });
    useBoundedClient(embedder, mock.baseURL, 120);

    await expect(embedder.embedPassage("never answered")).rejects.toThrow();

    // EMBEDDING_RETRY_DELAYS_MS has two entries, so a transient failure is attempted
    // three times total. Seeing 3 requests is what proves the SDK's timeout error was
    // recognised as transient — a misclassification would show up here as 1.
    expect(mock.requests).toHaveLength(3);
  }, 15_000);

  it("raises the SDK's own timeout error type that the transient classifier keys on", async () => {
    const mock = await endpoint(HANG);

    // Guards the classifier's premise directly: embedder.ts tests for
    // OpenAI.APIConnectionTimeoutError by identity, so an SDK upgrade that renamed or
    // stopped exporting that class would silently turn timeouts into fatal errors.
    const client = new OpenAI({
      apiKey: "test-key-not-a-real-credential",
      baseURL: mock.baseURL,
      timeout: 120,
      maxRetries: 0,
    });

    let caught: unknown;
    try {
      await client.embeddings.create({ model: "text-embedding-3-small", input: "x" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenAI.APIConnectionTimeoutError);
    expect(caught).toBeInstanceOf(OpenAI.APIConnectionError);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Chat completions
// ---------------------------------------------------------------------------

describe("OpenAI-compatible chat completions contract", () => {
  function qwenClient(baseURL: string, timeoutMs = 5_000): LLMClient {
    // Mirrors DEFAULT_LLM_CONFIG (DashScope's OpenAI-compatible mode) with the base URL
    // pointed at the loopback mock.
    return new LLMClient({
      apiKey: "test-key-not-a-real-credential",
      model: "qwen-turbo",
      baseURL,
      timeoutMs,
      temperature: 0.1,
    });
  }

  it("sends the Qwen-compatible request shape and parses content plus usage details", async () => {
    const mock = await endpoint(okJson(chatResponse("  a reusable conclusion  ")));

    const result = await qwenClient(mock.baseURL).chatLongDetailed("system rules", "user text", {
      tokenLimit: { parameter: "max_tokens", value: 256 },
    });

    expect(result).not.toBeNull();
    expect(result?.content).toBe("a reusable conclusion");
    expect(result?.finishReason).toBe("stop");
    expect(result?.responseModel).toBe("mock-chat-model");
    expect(result?.usage).toEqual({
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
      cachedPromptTokens: 3,
      reasoningTokens: 2,
    });

    expect(mock.requests).toHaveLength(1);
    const [request] = mock.requests;
    expect(request.url).toBe("/v1/chat/completions");
    expect(request.hasAuthorization).toBe(true);
    expect(request.body).toMatchObject({
      model: "qwen-turbo",
      temperature: 0.1,
      max_tokens: 256,
      messages: [
        { role: "system", content: "system rules" },
        { role: "user", content: "user text" },
      ],
    });
  });

  it("passes JSON mode and max_completion_tokens through unchanged", async () => {
    const mock = await endpoint(okJson(chatResponse('{"has":true}')));

    await qwenClient(mock.baseURL).chatLongDetailed("system", "user", {
      tokenLimit: { parameter: "max_completion_tokens", value: 400 },
      responseFormat: { type: "json_object" },
      enableThinking: false,
    });

    const [request] = mock.requests;
    expect(request.body).toMatchObject({
      response_format: { type: "json_object" },
      max_completion_tokens: 400,
      enable_thinking: false,
    });
    // The two token-limit parameters are mutually exclusive on real endpoints.
    expect(request.body).not.toHaveProperty("max_tokens");
  });

  it("propagates a provider error and records it on the circuit breaker", async () => {
    const mock = await endpoint(errorJson(500, "upstream model overloaded"));

    // maxRetries: 0 keeps the SDK from retrying the 5xx, so the assertion below counts
    // recallnest's behaviour rather than the SDK's retry policy.
    const client = new LLMClient({
      apiKey: "test-key-not-a-real-credential",
      model: "qwen-turbo",
      baseURL: mock.baseURL,
      timeoutMs: 5_000,
      temperature: 0.1,
      maxRetries: 0,
    });

    await expect(client.chatLongDetailed("system", "user")).rejects.toThrow(/overloaded/);
    expect(mock.requests).toHaveLength(1);
    expect(client.breaker.canAttempt()).toBe(true); // one failure is below the trip threshold
  });

  it("aborts a hanging endpoint within its own timeout budget", async () => {
    const mock = await endpoint(HANG);

    // chatLongDetailed arms its AbortController at timeoutMs * 2.
    const client = new LLMClient({
      apiKey: "test-key-not-a-real-credential",
      model: "qwen-turbo",
      baseURL: mock.baseURL,
      timeoutMs: 100,
      temperature: 0.1,
      maxRetries: 0,
    });

    const startedAt = Date.now();
    await expect(client.chatLongDetailed("system", "user")).rejects.toThrow();
    const elapsed = Date.now() - startedAt;

    // Bounded failure is the contract: the request must not inherit the SDK's
    // ten-minute default timeout when recallnest asked for 100ms.
    expect(elapsed).toBeLessThan(10_000);
    expect(mock.requests).toHaveLength(1);
  }, 20_000);

  it("returns null instead of calling the endpoint once the breaker is open", async () => {
    const mock = await endpoint(okJson(chatResponse("should not be reached")));

    const client = new LLMClient(
      {
        apiKey: "test-key-not-a-real-credential",
        model: "qwen-turbo",
        baseURL: mock.baseURL,
        timeoutMs: 5_000,
        temperature: 0.1,
      },
      { failureThreshold: 1, resetTimeoutMs: 60_000 },
    );

    client.breaker.recordFailure();
    expect(client.breaker.canAttempt()).toBe(false);

    await expect(client.chatLongDetailed("system", "user")).resolves.toBeNull();
    expect(mock.requests).toHaveLength(0);
  });
});
