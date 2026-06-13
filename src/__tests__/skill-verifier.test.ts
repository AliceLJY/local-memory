import { describe, test, expect } from "bun:test";
import { verifyDraft, tokensOf, type VerifyDraft, type VerifyEvidence } from "../skill-verifier.js";

describe("verifyDraft — tool coverage", () => {
  test("passes when draft tools ⊆ evidence tools and narrative resonates", () => {
    const draft: VerifyDraft = {
      tools: ["git", "bun test"],
      summary: "Fix the failing deploy by resetting the database migration",
      steps: ["reset migration", "rerun deploy"],
    };
    const evidence: VerifyEvidence[] = [
      { text: "deploy failed, reset migration then rerun deploy worked", tools: ["git", "bun test"] },
      { text: "another deploy reset migration fix", tools: ["git"] },
    ];
    const r = verifyDraft(draft, evidence);
    expect(r.ok).toBe(true);
    expect(r.coverage).toBe(1);
    expect(r.unmappedTools).toEqual([]);
  });

  test("fails coverage when draft claims a tool no evidence used (hallucinated command)", () => {
    const draft: VerifyDraft = {
      tools: ["fictional_cmd", "another_fake"],
      summary: "deploy reset migration rerun",
      steps: [],
    };
    const evidence: VerifyEvidence[] = [
      { text: "deploy reset migration rerun worked", tools: ["git"] },
    ];
    const r = verifyDraft(draft, evidence);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("coverage");
    expect(r.unmappedTools).toContain("fictional_cmd");
  });

  test("empty draft tools → coverage 1 (nothing to hallucinate), judged on resonance only", () => {
    const draft: VerifyDraft = { tools: [], summary: "deploy reset migration", steps: [] };
    const evidence: VerifyEvidence[] = [
      { text: "deploy reset migration done", tools: [] },
      { text: "deploy reset migration again", tools: [] },
    ];
    const r = verifyDraft(draft, evidence);
    expect(r.coverage).toBe(1);
    expect(r.ok).toBe(true);
  });

  test("coverage exactly 0.5 (1 of 2 tools mapped) passes the strict < 0.5 threshold", () => {
    const r = verifyDraft(
      { tools: ["git", "fake_cmd"], summary: "deploy reset migration rerun", steps: [] },
      [{ text: "deploy reset migration rerun", tools: ["git"] }],
    );
    expect(r.coverage).toBe(0.5);
    expect(r.reason ?? "").not.toContain("coverage");
    expect(r.unmappedTools).toContain("fake_cmd");
  });
});

describe("verifyDraft — evidence resonance", () => {
  test("fails resonance when narrative shares no tokens with evidence", () => {
    const draft: VerifyDraft = {
      tools: [],
      summary: "quantum entanglement teleportation protocol alpha",
      steps: ["calibrate flux capacitor"],
    };
    const evidence: VerifyEvidence[] = [
      { text: "deploy database migration reset rerun", tools: [] },
      { text: "another unrelated commit push branch", tools: [] },
    ];
    const r = verifyDraft(draft, evidence);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("resonance");
  });

  test("CJK: passes resonance on Chinese pattern + cases sharing ≥2 bigrams", () => {
    const draft: VerifyDraft = {
      tools: [],
      summary: "重启服务前先检查代理端口配置",
      steps: ["确认代理端口", "重启服务"],
    };
    const evidence: VerifyEvidence[] = [
      { text: "重启服务后代理端口失效，检查配置解决", tools: [] },
      { text: "代理端口配置错误导致重启失败", tools: [] },
    ];
    const r = verifyDraft(draft, evidence);
    expect(r.ok).toBe(true);
    expect(r.resonance).toBeGreaterThanOrEqual(0.5);
  });
});

describe("verifyDraft — boundaries", () => {
  test("empty evidence → no-evidence verdict", () => {
    const r = verifyDraft({ tools: ["git"], summary: "x", steps: [] }, []);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no-evidence");
  });

  test("verdict always carries coverage + resonance numbers", () => {
    const r = verifyDraft(
      { tools: ["git"], summary: "deploy reset migration rerun", steps: [] },
      [{ text: "deploy reset migration rerun", tools: ["git"] }],
    );
    expect(typeof r.coverage).toBe("number");
    expect(typeof r.resonance).toBe("number");
  });
});

describe("tokensOf", () => {
  test("extracts ASCII identifiers ≥4 chars, drops stopwords", () => {
    const toks = tokensOf("deploy the database migration");
    expect(toks.has("deploy")).toBe(true);
    expect(toks.has("database")).toBe(true);
    expect(toks.has("migration")).toBe(true);
    expect(toks.has("the")).toBe(false);
  });

  test("extracts CJK 2-gram bigrams", () => {
    const toks = tokensOf("重启服务");
    expect(toks.has("重启")).toBe(true);
    expect(toks.has("启服")).toBe(true);
    expect(toks.has("服务")).toBe(true);
  });
});
