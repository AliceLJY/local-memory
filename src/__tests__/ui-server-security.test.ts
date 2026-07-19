import { describe, expect, test } from "bun:test";

import {
  enforceLocalHttpRequestPolicy,
  LOCAL_HTTP_HOSTNAME,
  LOCAL_JSON_BODY_LIMIT_BYTES,
} from "../http-request-policy.js";

function uiRequest({
  method = "GET",
  host = "127.0.0.1:4317",
  headers = {},
  body,
}: {
  method?: string;
  host?: string;
  headers?: Record<string, string>;
  body?: string;
} = {}): Request {
  return new Request("http://127.0.0.1:4317/api/search", {
    method,
    headers: { host, ...headers },
    body,
  });
}

describe("RecallNest UI local HTTP policy", () => {
  test("binds the UI to the IPv4 loopback interface", () => {
    expect(LOCAL_HTTP_HOSTNAME).toBe("127.0.0.1");
  });

  test("allows same-origin browser requests", async () => {
    const result = await enforceLocalHttpRequestPolicy(uiRequest({
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        origin: "http://127.0.0.1:4317",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ query: "local" }),
    }));

    expect(result).toEqual({ allowed: true });
  });

  test("rejects a non-local Host header", async () => {
    const result = await enforceLocalHttpRequestPolicy(uiRequest({
      host: "attacker.example",
    }));

    expect(result).toEqual({ allowed: false, status: 403, message: "Host is not allowed." });
  });

  test("rejects cross-origin and cross-site browser requests", async () => {
    const wrongOrigin = await enforceLocalHttpRequestPolicy(uiRequest({
      headers: { origin: "https://attacker.example" },
    }));
    const crossSite = await enforceLocalHttpRequestPolicy(uiRequest({
      headers: { "sec-fetch-site": "cross-site" },
    }));

    expect(wrongOrigin).toEqual({ allowed: false, status: 403, message: "Origin is not allowed." });
    expect(crossSite).toEqual({ allowed: false, status: 403, message: "Cross-site requests are not allowed." });
  });

  test("rejects non-JSON POST bodies", async () => {
    const result = await enforceLocalHttpRequestPolicy(uiRequest({
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ query: "local" }),
    }));

    expect(result).toEqual({
      allowed: false,
      status: 415,
      message: "Content-Type must be application/json.",
    });
  });

  test("rejects streamed JSON bodies over the limit", async () => {
    const result = await enforceLocalHttpRequestPolicy(uiRequest({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "x".repeat(LOCAL_JSON_BODY_LIMIT_BYTES) }),
    }));

    expect(result).toEqual({
      allowed: false,
      status: 413,
      message: `Request body exceeds ${LOCAL_JSON_BODY_LIMIT_BYTES} bytes.`,
    });
  });
});
