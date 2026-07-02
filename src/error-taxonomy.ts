/**
 * MCP 错误分类学 — 借鉴 RepoPrompt CE 的 error taxonomy。
 *
 * 问题：RecallNest 43 个 MCP 工具的错误现在三种风格混着（fail-open 空结果 /
 * 错误当正常 content / 局部 catch 返回文本），agent 拿到错误无法判断该重试、
 * 改参数还是上报用户。
 *
 * 方案：给每种失败标三元组 {reasonCode, retryable, responsibility}，在 registerTool
 * 外层统一兜底分类，返回带机器可读 block 的 isError result。
 *
 * 范围（第一阶段）：只兜底「抛到 handler 顶层、未被内部 catch」的错误。各 handler
 * 内部的 fail-open / 文本错误风格统一是后续第二阶段，不在此处改（避免破坏客户端兼容）。
 */

/** 责任方：host=运行环境/配置，app=RecallNest 自身逻辑，peer=调用方输入或上游 API，transport=网络层。 */
export type ErrorResponsibility = "host" | "app" | "peer" | "transport";

export interface ErrorClassification {
  /** 稳定错误码（机器可读，跨版本稳定，供 agent 分支判断）。 */
  reasonCode: string;
  /** 是否值得重试（transient vs permanent）。 */
  retryable: boolean;
  /** 责任方，决定 agent 是重试 / 改参数 / 上报用户。 */
  responsibility: ErrorResponsibility;
}

/**
 * 失败模式表：按 error message 模式分类。
 * 未匹配 → internal_error / app / non-retryable（保守：不误导 agent 去重试一个未知错误）。
 */
export function classifyError(err: unknown): ErrorClassification {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  // transport：网络/连接层，可重试
  if (/econnreset|etimedout|enotfound|econnrefused|socket|network|fetch failed|timed out|timeout/.test(msg)) {
    return { reasonCode: "transport_error", retryable: true, responsibility: "transport" };
  }
  // 上游 API 过载/限流，可重试（退避后）
  if (/rate.?limit|\b429\b|\b529\b|overloaded|too many requests|quota exceeded/.test(msg)) {
    return { reasonCode: "upstream_overloaded", retryable: true, responsibility: "peer" };
  }
  // 上游 API 鉴权/密钥，不可重试（需修 host 配置）
  if (/\b401\b|\b403\b|unauthorized|invalid api key|authentication failed|missing api key/.test(msg)) {
    return { reasonCode: "upstream_auth", retryable: false, responsibility: "host" };
  }
  // 运行环境/配置缺失（host）：缺 env var、未配置（Codex 复审 P2-3，关联 lazy-init 失败 P2-1）
  if (/environment variable .* not set|not configured|missing required (config|environment)/.test(msg)) {
    return { reasonCode: "config_missing", retryable: false, responsibility: "host" };
  }
  // 调用方未给 scope（resolveScopeSelection 抛出）
  if (/requires a scope|scope is required|pass scope/.test(msg)) {
    return { reasonCode: "scope_required", retryable: false, responsibility: "peer" };
  }
  // 调用方给的 memory 引用无效：ID 格式错 / 前缀歧义 / 不在可访问 scope（Codex 复审 P2-3）。
  // 指引 agent 给有效 ID / 更长前缀 / 正确 scope，而非误以为 RecallNest 内部故障。
  if (/invalid memory id|ambiguous prefix|invalid .* id format|outside accessible scope|not accessible/.test(msg)) {
    return { reasonCode: "invalid_memory_ref", retryable: false, responsibility: "peer" };
  }
  // 调用方输入非法（zod/validation）
  if (/validation|invalid input|expected .* received|must be a|is required|not a valid|failed to parse/.test(msg)) {
    return { reasonCode: "invalid_input", retryable: false, responsibility: "peer" };
  }
  // 存储层（LanceDB / 向量 / 索引）
  if (/lancedb|database|\btable\b|vector ?search|embedding failed|index/.test(msg)) {
    return { reasonCode: "store_error", retryable: false, responsibility: "app" };
  }
  // 默认：保守归为 app 内部错误，不可重试
  return { reasonCode: "internal_error", retryable: false, responsibility: "app" };
}

/** MCP tool error content item 类型（与 handler 成功路径的 content 同构）。 */
interface ErrorResult {
  content: { type: "text"; text: string }[];
  isError: true;
}

/**
 * 把任意错误转成带机器可读分类 block 的 MCP isError result。
 * agent 可解析 reason_code / retryable / responsibility 决定下一步。
 */
export function toErrorResult(toolName: string, err: unknown): ErrorResult {
  const cls = classifyError(err);
  const detail = err instanceof Error ? err.message : String(err);
  return {
    content: [{
      type: "text",
      text: [
        `❌ Tool "${toolName}" failed`,
        `reason_code: ${cls.reasonCode}`,
        `retryable: ${cls.retryable}`,
        `responsibility: ${cls.responsibility}`,
        `detail: ${detail}`,
      ].join("\n"),
    }],
    isError: true,
  };
}

/**
 * 安全执行 tool 逻辑：捕获任意抛错（含 lazy-init / handler 执行），分类 + 结构化
 * stderr 日志 + 返回 isError result。提取成独立函数以便单测锁定回归（Codex 复审建议）。
 * registerTool 的 lazyHandler 把「ensureComponents + handler 调用」整体交给它。
 */
export async function runToolSafely<T>(toolName: string, fn: () => Promise<T>): Promise<T | ErrorResult> {
  try {
    return await fn();
  } catch (err) {
    const cls = classifyError(err);
    console.error(
      `[recallnest] tool ${toolName} failed [${cls.reasonCode}/${cls.responsibility}/retryable=${cls.retryable}]:`,
      err instanceof Error ? err.stack || err.message : String(err),
    );
    return toErrorResult(toolName, err);
  }
}
