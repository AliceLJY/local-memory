import { describe, test, expect } from "bun:test";
import { extractErrorSignatures, MAX_SIGNATURES } from "../error-signature.js";

describe("extractErrorSignatures — English patterns", () => {
  test("bare 'X not found' (no colon) is extracted — MemOS 原 6 正则会漏", () => {
    const sigs = extractErrorSignatures({ problem: "Build broke: xmlsec1 not found" });
    expect(sigs.some(s => s.includes("xmlsec1 not found"))).toBe(true);
  });

  test("'exit code N' is extracted", () => {
    const sigs = extractErrorSignatures({ problem: "Deploy failed with exit code 1" });
    expect(sigs.some(s => s.includes("exit code 1"))).toBe(true);
  });

  test("'<Name>Error: body' extracted and ranks top by specificity", () => {
    const sigs = extractErrorSignatures({ problem: "NameError: name foo is not defined" });
    expect(sigs.some(s => s.includes("NameError"))).toBe(true);
    expect(sigs[0]).toContain("NameError");
  });

  test("'No such file or directory' standalone is extracted (case-insensitive)", () => {
    const sigs = extractErrorSignatures({ problem: "open config: No such file or directory" });
    expect(sigs.some(s => /No such file or directory/i.test(s))).toBe(true);
  });

  test("bare 3-digit numbers in benign text do NOT false-match as HTTP error", () => {
    const sigs = extractErrorSignatures({ problem: "deployed 500 records and processed 404 rows in the weekly batch" });
    expect(sigs.some(s => s.includes("500 records") || s.includes("404 rows"))).toBe(false);
  });

  test("real HTTP status phrase is still extracted after tightening", () => {
    const sigs = extractErrorSignatures({ problem: "API call returned 500 Internal Server Error on submit" });
    expect(sigs.some(s => s.includes("500 Internal"))).toBe(true);
  });
});

describe("extractErrorSignatures — Chinese (MemOS 原版会被 alpha 检查滤掉)", () => {
  test("中文错误现象被抽取", () => {
    const sigs = extractErrorSignatures({ problem: "部署时权限被拒绝，找不到文件" });
    expect(sigs.some(s => s.includes("找不到") || s.includes("权限被拒"))).toBe(true);
  });

  test("中文短片段（<6 字符但 ≥3 中文字）保留", () => {
    const sigs = extractErrorSignatures({ problem: "找不到模块" });
    expect(sigs.length).toBeGreaterThan(0);
  });
});

describe("extractErrorSignatures — input gating", () => {
  test("outcome 成功态（无失败词）不被纳入，不抽反向信号", () => {
    const sigs = extractErrorSignatures({
      problem: "ImportError: no module named requests",
      outcome: "exit code 0 部署成功",
    });
    expect(sigs.some(s => s.includes("ImportError"))).toBe(true);
    expect(sigs.some(s => s.includes("exit code 0"))).toBe(false);
  });

  test("context 参与抽取（原始 stderr 常在 context）", () => {
    const sigs = extractErrorSignatures({
      problem: "服务起不来",
      context: "stderr: pg_config: command not found",
    });
    expect(sigs.some(s => s.includes("pg_config") || s.includes("command not found"))).toBe(true);
  });

  test("结果不超过 MAX_SIGNATURES 条", () => {
    const sigs = extractErrorSignatures({
      problem: "NameError: a. TypeError: b. ValueError: c. KeyError: d. exit code 1. 404 Not Found. 权限被拒绝.",
    });
    expect(sigs.length).toBeLessThanOrEqual(MAX_SIGNATURES);
  });
});

describe("extractErrorSignatures — 过泛中文词收紧（P3-A 检索端噪声治理）", () => {
  const BARE_GENERIC = /^(?:报错|出错|错误|异常|失败|超时|崩溃|无法|未定义|不能)[了的过着吧呢啊啦哦呀嘛。，！？!?,\s]*$/;

  test("裸过泛词 + 语气助词不被抽成指纹（失败了 / 超时了 / 崩溃了 / 报错了）", () => {
    for (const bare of ["部署失败了", "请求超时了", "程序崩溃了", "系统报错了"]) {
      const sigs = extractErrorSignatures({ problem: bare });
      expect(sigs.some(s => BARE_GENERIC.test(s.trim()))).toBe(false);
    }
  });

  test("过泛词带具体锚点（英文 / 路径 / 多位数字）时保留", () => {
    const sigs = extractErrorSignatures({ problem: "操作失败：xmlsec1 not found" });
    expect(sigs.some(s => s.includes("xmlsec1"))).toBe(true);
  });

  test("具体中文短语不受收紧影响（找不到 / 权限被拒 / 连接失败）", () => {
    expect(extractErrorSignatures({ problem: "找不到模块" }).length).toBeGreaterThan(0);
    expect(extractErrorSignatures({ problem: "权限被拒绝" }).some(s => s.includes("权限被拒"))).toBe(true);
    expect(extractErrorSignatures({ problem: "数据库连接失败" }).some(s => s.includes("连接失败"))).toBe(true);
  });
});
