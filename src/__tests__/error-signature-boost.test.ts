import { describe, expect, it, afterEach, beforeEach } from "bun:test";

import { applyErrorSignatureBoost } from "../retriever.js";
import type { RetrievalResult } from "../retriever.js";
import { extractErrorSignatures } from "../error-signature.js";

const FLAG = "RECALLNEST_ERROR_SIGNATURE_BOOST";

function makeResult(opts: { category: string; score: number; sigs?: string[] }): RetrievalResult {
  const metadata = opts.sigs ? JSON.stringify({ error_signature: opts.sigs }) : "{}";
  return {
    entry: {
      id: "m1",
      text: "x",
      scope: "test",
      category: opts.category,
      timestamp: "2026-06-13T00:00:00.000Z",
      metadata,
    },
    score: opts.score,
    sources: {},
  } as unknown as RetrievalResult;
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[FLAG];
  delete process.env[FLAG];
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

describe("applyErrorSignatureBoost — A1 检索端精确召回 boost", () => {
  const QUERY = "build broke: xmlsec1 not found";
  const matchingSig = () => extractErrorSignatures({ problem: QUERY })[0];

  it("flag off（默认）→ 原样返回同一引用、分数不变", () => {
    const input = [makeResult({ category: "cases", score: 0.4, sigs: [matchingSig()] })];
    const out = applyErrorSignatureBoost(input, QUERY);
    expect(out).toBe(input); // no-op，bit-identical
    expect(out[0].score).toBe(0.4);
  });

  it("flag on + 指纹命中 case → 乘法 boost (×1.5)", () => {
    process.env[FLAG] = "true";
    const input = [makeResult({ category: "cases", score: 0.4, sigs: [matchingSig()] })];
    const out = applyErrorSignatureBoost(input, QUERY);
    expect(out[0].score).toBeCloseTo(0.6, 6); // 0.4 * 1.5
  });

  it("flag on + 命中但高分 → clamp 到 1、不溢出", () => {
    process.env[FLAG] = "true";
    const input = [makeResult({ category: "cases", score: 0.8, sigs: [matchingSig()] })];
    const out = applyErrorSignatureBoost(input, QUERY);
    expect(out[0].score).toBe(1); // 0.8 * 1.5 = 1.2 → clamp 1
  });

  it("flag on + 非 case category（patterns）→ 不 boost", () => {
    process.env[FLAG] = "true";
    const input = [makeResult({ category: "patterns", score: 0.4, sigs: [matchingSig()] })];
    const out = applyErrorSignatureBoost(input, QUERY);
    expect(out[0].score).toBe(0.4);
  });

  it("flag on + case 但指纹不重叠 → 不 boost", () => {
    process.env[FLAG] = "true";
    const input = [makeResult({ category: "cases", score: 0.4, sigs: ["zzz_nonexistent_signature_xyz"] })];
    const out = applyErrorSignatureBoost(input, QUERY);
    expect(out[0].score).toBe(0.4);
  });

  it("flag on + case 无 error_signature metadata → 不 boost", () => {
    process.env[FLAG] = "true";
    const input = [makeResult({ category: "cases", score: 0.4 })];
    const out = applyErrorSignatureBoost(input, QUERY);
    expect(out[0].score).toBe(0.4);
  });

  it("flag on + query 抽不出错误指纹 → 原样返回同一引用", () => {
    process.env[FLAG] = "true";
    const input = [makeResult({ category: "cases", score: 0.4, sigs: [matchingSig()] })];
    const out = applyErrorSignatureBoost(input, "今天天气不错，喝杯咖啡");
    expect(out).toBe(input);
  });
});
