import { describe, expect, test } from "bun:test";

import {
  enforceLocalHttpRequestPolicy,
  LOCAL_JSON_BODY_LIMIT_BYTES,
} from "../http-request-policy.js";

function apiRequest({
  method = "GET",
  host = "localhost:4318",
  headers = {},
  body,
}: {
  method?: string;
  host?: string;
  headers?: Record<string, string>;
  body?: string;
} = {}): Request {
  return new Request("http://localhost:4318/v1/store", {
    method,
    headers: { host, ...headers },
    body,
  });
}

describe("RecallNest API local HTTP policy", () => {
  test("keeps local CLI JSON requests without Origin usable", async () => {
    const result = await enforceLocalHttpRequestPolicy(apiRequest({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "local CLI", scope: "test:local" }),
    }));

    expect(result).toEqual({ allowed: true });
  });

  test("allows loopback GET requests without browser headers", async () => {
    const result = await enforceLocalHttpRequestPolicy(apiRequest());

    expect(result).toEqual({ allowed: true });
  });

  test("rejects malformed or non-local Host headers", async () => {
    const malformed = await enforceLocalHttpRequestPolicy(apiRequest({ host: "localhost@attacker.example" }));
    const nonLocal = await enforceLocalHttpRequestPolicy(apiRequest({ host: "192.168.1.10:4318" }));

    expect(malformed).toEqual({ allowed: false, status: 403, message: "Host is not allowed." });
    expect(nonLocal).toEqual({ allowed: false, status: 403, message: "Host is not allowed." });
  });

  test("rejects opaque origins and same-site cross-origin requests", async () => {
    const opaqueOrigin = await enforceLocalHttpRequestPolicy(apiRequest({
      headers: { origin: "null" },
    }));
    const sameSite = await enforceLocalHttpRequestPolicy(apiRequest({
      headers: { "sec-fetch-site": "same-site" },
    }));

    expect(opaqueOrigin).toEqual({ allowed: false, status: 403, message: "Origin is not allowed." });
    expect(sameSite).toEqual({ allowed: false, status: 403, message: "Cross-site requests are not allowed." });
  });

  test("requires application/json for API POST requests", async () => {
    const missing = await enforceLocalHttpRequestPolicy(apiRequest({
      method: "POST",
      body: "{}",
    }));
    const form = await enforceLocalHttpRequestPolicy(apiRequest({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "text=example",
    }));

    expect(missing).toEqual({
      allowed: false,
      status: 415,
      message: "Content-Type must be application/json.",
    });
    expect(form).toEqual({
      allowed: false,
      status: 415,
      message: "Content-Type must be application/json.",
    });
  });

  test("rejects declared JSON bodies over the limit before route handling", async () => {
    const result = await enforceLocalHttpRequestPolicy(apiRequest({
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(LOCAL_JSON_BODY_LIMIT_BYTES + 1),
      },
      body: "{}",
    }));

    expect(result).toEqual({
      allowed: false,
      status: 413,
      message: `Request body exceeds ${LOCAL_JSON_BODY_LIMIT_BYTES} bytes.`,
    });
  });
});
