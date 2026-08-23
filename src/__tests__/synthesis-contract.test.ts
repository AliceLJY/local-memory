import { describe, expect, it } from "bun:test";

import {
  CLUSTER_INSIGHT_PROMPT,
  CLUSTER_PATTERN_PROMPT,
  PROMPT_ECHO_MARKERS,
  SYNTHESIS_MAX_LEN,
  allocateClusterBudget,
  numberClusterTexts,
  parseSynthesisJson,
  validateSynthesis,
} from "../synthesis-contract.js";

// ---------------------------------------------------------------------------
// 输入预算分配（R3：老路径 slice(0,2000) 让 64.2% 的簇被截，p10 只有 13.8% 的源进得了模型）
// ---------------------------------------------------------------------------

describe("allocateClusterBudget", () => {
  it("总量不超预算", () => {
    const texts = Array.from({ length: 20 }, () => "x".repeat(5000));
    const out = allocateClusterBudget(texts, 1000);
    expect(out.reduce((s, t) => s + t.length, 0)).toBeLessThanOrEqual(1000);
  });

  it("短成员整条保留，长成员才被截", () => {
    const out = allocateClusterBudget(["短", "y".repeat(999)], 100);
    expect(out[0]).toBe("短");
    expect(out[1].length).toBeLessThan(999);
  });

  it("短成员用不完的份额让给长成员，而不是浪费掉", () => {
    // 均分是 50/50；第一条只用 1 个字符，第二条应拿到远超 50 的份额。
    const out = allocateClusterBudget(["短", "y".repeat(999)], 100);
    expect(out[1].length).toBeGreaterThan(50);
  });

  it("靠后的成员不会被整条丢掉——这正是老 slice(0,2000) 的失效形态", () => {
    // 老路径把 168 条拼成一条长文本再从头切，排在后面的成员一个字都进不了模型。
    const texts = Array.from({ length: 50 }, (_, i) => `第${i}条`.repeat(200));
    const out = allocateClusterBudget(texts, 2000);
    expect(out.length).toBe(50);
    expect(out.every(t => t.length > 0)).toBe(true);
    // 最后一条必须真的携带自己的内容，而不是空壳
    expect(out[49]).toContain("第49条");
  });

  it("空簇返回空数组", () => {
    expect(allocateClusterBudget([], 100)).toEqual([]);
  });
});

describe("numberClusterTexts", () => {
  it("编号从 1 开始，与 evidence 的语义一致", () => {
    expect(numberClusterTexts(["a", "b"])).toBe("[1] a\n[2] b");
  });
});

// ---------------------------------------------------------------------------
// JSON 解析
// ---------------------------------------------------------------------------

describe("parseSynthesisJson", () => {
  it("裸 JSON", () => {
    expect(parseSynthesisJson('{"has":false}')).toEqual({ has: false });
  });

  it("markdown 围栏", () => {
    expect(parseSynthesisJson('```json\n{"has":false}\n```')).toEqual({ has: false });
  });

  it("带前言的回复也能抠出对象", () => {
    expect(parseSynthesisJson('好的，结果如下：\n{"has":false}\n以上。')).toEqual({ has: false });
  });

  it("拿不到 JSON 时返回 null 而不是抛异常", () => {
    expect(parseSynthesisJson("完全不是 JSON")).toBeNull();
    expect(parseSynthesisJson(null)).toBeNull();
  });

  it("顶层是数组不算合法（契约要的是对象）", () => {
    expect(parseSynthesisJson("[1,2,3]")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 写库前校验 —— 每条 reject 分支都要有一条测试撑着，
// 因为这一层的全部意义就是「LLM 说了什么不算数」。
// ---------------------------------------------------------------------------

const base = { textField: "conclusion", memberCount: 5, minEvidence: 1 };

describe("validateSynthesis", () => {
  it("合格输出：去重 + 升序", () => {
    const v = validateSynthesis({
      ...base,
      parsed: { has: true, conclusion: "必须先初始化再分派，否则读到的是初始化前的值", evidence: [3, 1, 3] },
    });
    expect(v.status).toBe("ok");
    if (v.status === "ok") {
      expect(v.output.evidence).toEqual([1, 3]);
      expect(v.output.text).toContain("必须先初始化");
    }
  });

  it("has:false 是弃权，不是失败——这条路径老 generateL0 根本没有", () => {
    expect(validateSynthesis({ ...base, parsed: { has: false } }).status).toBe("abstained");
  });

  it("解析不出 JSON → unparsable", () => {
    const v = validateSynthesis({ ...base, parsed: null });
    expect(v).toEqual({ status: "rejected", reason: "unparsable" });
  });

  it("has 不是 boolean → 拒绝（不猜它的意图）", () => {
    for (const has of ["true", 1, null, undefined]) {
      const v = validateSynthesis({ ...base, parsed: { has, conclusion: "随便什么", evidence: [1] } });
      expect(v).toEqual({ status: "rejected", reason: "flag-not-boolean" });
    }
  });

  it("说有结论却没给正文 → empty-text", () => {
    expect(validateSynthesis({ ...base, parsed: { has: true, evidence: [1] } }))
      .toEqual({ status: "rejected", reason: "empty-text" });
    expect(validateSynthesis({ ...base, parsed: { has: true, conclusion: "   ", evidence: [1] } }))
      .toEqual({ status: "rejected", reason: "empty-text" });
  });

  it("长度越界两侧都拒", () => {
    expect(validateSynthesis({ ...base, parsed: { has: true, conclusion: "太短", evidence: [1] } }))
      .toEqual({ status: "rejected", reason: "too-short" });
    expect(validateSynthesis({
      ...base,
      parsed: { has: true, conclusion: "长".repeat(SYNTHESIS_MAX_LEN + 1), evidence: [1] },
    })).toEqual({ status: "rejected", reason: "too-long" });
  });

  it("evidence 缺失或不是数组 → evidence-missing", () => {
    expect(validateSynthesis({ ...base, parsed: { has: true, conclusion: "一条长度足够越过下限的结论文本" } }))
      .toEqual({ status: "rejected", reason: "evidence-missing" });
    expect(validateSynthesis({ ...base, parsed: { has: true, conclusion: "一条长度足够越过下限的结论文本", evidence: "1,2" } }))
      .toEqual({ status: "rejected", reason: "evidence-missing" });
  });

  it("编号全部越界 → evidence-out-of-range（模型在编号，不是证据不够）", () => {
    const v = validateSynthesis({
      ...base,
      parsed: { has: true, conclusion: "一条长度足够越过下限的结论文本", evidence: [99, 0, -1] },
    });
    expect(v).toEqual({ status: "rejected", reason: "evidence-out-of-range" });
  });

  it("pattern 侧只给 1 个合法编号 → evidence-too-few（跨条目按定义要 2 条）", () => {
    const v = validateSynthesis({
      parsed: { has: true, pattern: "一条长度足够越过下限的跨条目结论文本", evidence: [2] },
      textField: "pattern",
      memberCount: 5,
      minEvidence: 2,
    });
    expect(v).toEqual({ status: "rejected", reason: "evidence-too-few" });
  });

  it("重复编号不算两条证据（[2,2] 去重后只剩 1 个）", () => {
    const v = validateSynthesis({
      parsed: { has: true, pattern: "一条长度足够越过下限的跨条目结论文本", evidence: [2, 2] },
      textField: "pattern",
      memberCount: 5,
      minEvidence: 2,
    });
    expect(v).toEqual({ status: "rejected", reason: "evidence-too-few" });
  });

  it("数字字符串编号可接受（模型常把编号写成字符串）", () => {
    const v = validateSynthesis({
      ...base,
      parsed: { has: true, conclusion: "一条长度足够越过下限的结论文本", evidence: ["2", 3] },
    });
    expect(v.status).toBe("ok");
    if (v.status === "ok") expect(v.output.evidence).toEqual([2, 3]);
  });

  it("非整数编号不算合法", () => {
    const v = validateSynthesis({
      ...base,
      parsed: { has: true, conclusion: "一条长度足够越过下限的结论文本", evidence: [1.5, "abc"] },
    });
    expect(v).toEqual({ status: "rejected", reason: "evidence-out-of-range" });
  });
});

// ---------------------------------------------------------------------------
// 提示词回声 —— R4 的直接回归：库里曾有 28 条记忆的正文就是系统提示词原文
// ---------------------------------------------------------------------------

describe("提示词回声拦截（R4 回归）", () => {
  it("拦下那 28 条真实泄漏的原文形态", () => {
    const leaked = "保真规则：端口号/IP/URL/文件路径/API名称 → 原样保留；函数名/事件名/配置项 → 逐项保留不概括。";
    const v = validateSynthesis({ ...base, parsed: { has: true, conclusion: leaked, evidence: [1, 2] } });
    expect(v).toEqual({ status: "rejected", reason: "prompt-echo" });
  });

  it("新提示词自己的句子被回声也拦得住", () => {
    const v = validateSynthesis({
      ...base,
      parsed: { has: true, conclusion: "提炼不出来就说没有。宁可不产出，也不要硬凑。", evidence: [1] },
    });
    expect(v).toEqual({ status: "rejected", reason: "prompt-echo" });
  });

  it("正常结论不被误杀（标记表宁可漏也不误杀真结论）", () => {
    const normal = "批量删记忆要显式关掉 cascade，否则同 scope 内相似度高的条目会被连带降权。";
    expect(validateSynthesis({ ...base, parsed: { has: true, conclusion: normal, evidence: [1] } }).status).toBe("ok");
  });

  it("标记全部真的出现在提示词里——否则这道闸是摆设", () => {
    // 反向断言：防有人改提示词时把某条标记的原文改掉，闸门静默失效而测试照绿。
    const corpus = CLUSTER_INSIGHT_PROMPT + "\n" + CLUSTER_PATTERN_PROMPT;
    const legacyOnly = new Set(["保真规则", "端口号/IP/URL/文件路径", "记忆索引助手", "记忆模式发现助手"]);
    for (const marker of PROMPT_ECHO_MARKERS) {
      if (legacyOnly.has(marker)) continue; // 老提示词的标记，本仓已无原文，保留是为了拦历史形态
      expect(corpus).toContain(marker);
    }
  });
});

// ---------------------------------------------------------------------------
// 提示词本身的契约：三件必须写死的事
// ---------------------------------------------------------------------------

describe("提示词契约", () => {
  it("两个提示词都必须给出弃权出口", () => {
    for (const p of [CLUSTER_INSIGHT_PROMPT, CLUSTER_PATTERN_PROMPT]) {
      expect(p).toContain('has": false');
    }
  });

  it("两个提示词都必须显式禁掉性向归因措辞（56.1% 的直接来源）", () => {
    for (const p of [CLUSTER_INSIGHT_PROMPT, CLUSTER_PATTERN_PROMPT]) {
      expect(p).toContain("倾向于");
      expect(p).toContain("性格");
    }
  });

  it("两个提示词都必须要求 evidence 编号", () => {
    for (const p of [CLUSTER_INSIGHT_PROMPT, CLUSTER_PATTERN_PROMPT]) {
      expect(p).toContain("evidence");
    }
  });

  it("pattern 侧必须写死 ≥2 条支撑（旧提示词写了但实现不校验，等于没写）", () => {
    expect(CLUSTER_PATTERN_PROMPT).toContain("至少 2 条");
  });
});
