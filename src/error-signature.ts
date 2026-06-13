/**
 * A1 · Error-signature extractor — zero-LLM 结构化错误指纹（debug case 精确召回用）。
 *
 * 借鉴 MemOS local-plugin `core/capture/error-signature.ts`（repo-insight 审计 2026-06-13），
 * 针对 RecallNest 本地化适配（Codex read-only 验证指出的三处不适配）：
 *   - case 没有 toolCalls，错误指纹藏在 problem/context 自由文本里（MemOS 面向 tool output）
 *   - 补裸 `X not found` / `No such file or directory` / 中文错误模式（MemOS 原 6 正则抽不到
 *     裸的 `xmlsec1 not found`，也会被英文 alpha 检查滤掉中文）
 *   - normaliseFragment 放宽长度/字母检查以保留中文短片段
 *
 * **读写对称**：纯函数。写入端（persistCaseMemory）抽指纹存 metadata.error_signature；
 * 未来 P3-A 检索精确召回通道复用同一个 extractErrorSignatures，保证读写抽取规则一致。
 * 零 LLM、确定性——每次 case 写入都跑，必须便宜。
 */

/** 每条 case 最多保留的指纹数（控制 hot-path 边界）。 */
export const MAX_SIGNATURES = 4;
const MIN_FRAGMENT_LEN = 6;
const MAX_FRAGMENT_LEN = 160;

/**
 * verbatim 抽取模式——顺序即优先级，整段 match（m[0]）作为 fragment。
 */
const ERROR_PATTERNS: RegExp[] = [
  // <Name>Error: / <Name>Exception: body
  /\b([A-Z][A-Za-z0-9]*(?:Error|Exception)):\s*([^\n]{4,160})/g,
  // error: / fatal: / ERROR: body
  /\b(?:error|Error|fatal|FATAL|ERROR)\s*:\s*([^\n]{4,160})/g,
  // <cmd>: ... not found / no such file / permission denied（带冒号）
  /\b([A-Za-z0-9_\-./]+):\s*[^\n]{0,40}\b(not found|no such (?:file|directory)|permission denied|undefined reference|command not found)\b[^\n]*/g,
  // 裸 <thing> [command] not found（无冒号——MemOS 原版抽不到 "xmlsec1 not found"）
  /\b([A-Za-z0-9_.\-/]{2,60})\s+(?:command )?not found\b/gi,
  // No such file or directory（独立出现）
  /\bno such file or directory\b/gi,
  // <thing> is required / must be / cannot / could not / failed to
  /\b([A-Za-z0-9_]{3,40})\s+(is required|must be|cannot|could not|failed to)\s+[^\n]{3,120}/g,
  // exit code / status N
  /\bexit (?:code|status)\s*[:=]?\s*(\d{1,4})\b[^\n]{0,80}/g,
  // HTTP 4xx/5xx + 标准状态短语（收紧：避免 "500 ms" / "404 rows" 这类裸数字误抽）
  /\b(4\d\d|5\d\d)\s+(Bad Request|Unauthorized|Payment Required|Forbidden|Not Found|Method Not Allowed|Not Acceptable|Request Timeout|Conflict|Gone|Payload Too Large|Unprocessable Entity|Too Many Requests|Internal Server Error|Internal|Not Implemented|Bad Gateway|Service Unavailable|Gateway Timeout)\b/g,
  // 中文错误现象 + 后续短语
  /(找不到|没有找到|不存在|无法|没有权限|权限被拒|拒绝访问|命令不存在|没有那个文件|连接失败|连接超时|超时|崩溃|段错误|空指针|未定义|报错|异常|失败)[^\n]{0,24}/g,
  // 中文 退出码/状态码/错误码/返回码 N
  /(退出码|状态码|错误码|返回码)\s*[:=：]?\s*\d{1,4}/g,
];

const STOP_WORDS = new Set([
  "the", "for", "this", "that", "your", "from", "with", "have", "has",
  "not", "a", "an", "of", "to", "is", "in", "on", "by", "was", "were",
]);

/**
 * 过泛中文错误词——单独出现（裸词 + 语气助词、无具体锚点）会在检索端过度匹配。
 * 具体短语（找不到 / 权限被拒 / 连接失败 / 段错误 / 空指针）不在此列、照常保留。
 * 已有 cjk<3 长度门挡掉 2 字裸词；本表治的是 3+ 字「裸词+助词」（失败了 / 超时了）。
 */
const GENERIC_CN_ERROR = /^(?:报错|出错|错误|异常|失败|超时|崩溃|无法|未定义|不能)[了的过着吧呢啊啦哦呀嘛。，！？!?,\s]*$/;

/** 失败信号词——outcome/solutionSteps 仅在命中时才纳入语料（避免成功态反向噪声）。 */
const FAILURE_HINT = /(error|fail|failed|failure|exception|not found|cannot|denied|timeout|拒绝|失败|报错|错误|异常|不能|无法|超时|崩溃)/i;

export interface ExtractInput {
  /** 主信号：case 的 problem 字段（"What problem happened"）。 */
  problem: string;
  /** case 的 context（原始 stderr / 触发条件常在此）。 */
  context?: string;
  /** case 的 outcome（解决后状态——偏成功态，仅含失败词时参与）。 */
  outcome?: string;
  /** solution 步骤（修复命令噪声多，仅含失败词时参与）。 */
  solutionSteps?: string[];
}

/**
 * 抽取至多 MAX_SIGNATURES 条规范化错误指纹，按 specificity 降序。
 * problem + context 是主语料；outcome / solutionSteps 仅当包含失败词时纳入
 * （outcome 多为成功态，否则会抽到 "exit code 0 / 不再报错" 这类反向信号）。
 */
export function extractErrorSignatures(input: ExtractInput): string[] {
  const corpus: string[] = [input.problem];
  if (input.context) corpus.push(input.context);
  const tail = [input.outcome ?? "", ...(input.solutionSteps ?? [])].join("\n");
  if (tail.trim() && FAILURE_HINT.test(tail)) corpus.push(tail);

  // dedup by lowercased/collapsed key（重叠正则不产近似重复）；first-seen casing 胜出。
  const candidates = new Map<string, { frag: string; freq: number }>();
  for (const text of corpus) {
    for (const frag of extractFragments(text)) {
      const normalised = normaliseFragment(frag);
      if (!normalised) continue;
      const key = normalised.toLowerCase().replace(/\s+/g, " ");
      const existing = candidates.get(key);
      if (existing) existing.freq++;
      else candidates.set(key, { frag: normalised, freq: 1 });
    }
  }

  const scored = Array.from(candidates.values()).map(({ frag, freq }) => ({
    frag,
    score: specificityScore(frag, freq),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_SIGNATURES).map((s) => s.frag);
}

function extractFragments(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const pattern of ERROR_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text))) {
      out.push(m[0]);
      if (m.index === pattern.lastIndex) pattern.lastIndex++; // 防零宽匹配死循环
      if (out.length >= 32) break; // 每个 pattern 硬上限
    }
  }
  return out;
}

function normaliseFragment(frag: string): string | null {
  const collapsed = frag.replace(/\s+/g, " ").trim();
  const cjk = collapsed.replace(/[^一-鿿]/g, "");
  // 长度门：英文片段 ≥MIN_FRAGMENT_LEN，或中文 ≥3 字（中文短片段如"找不到文件"也保留）
  if (collapsed.length < MIN_FRAGMENT_LEN && cjk.length < 3) return null;
  const truncated = collapsed.length > MAX_FRAGMENT_LEN ? collapsed.slice(0, MAX_FRAGMENT_LEN) : collapsed;
  // 信息量门：英文字母 ≥4 或 中文 ≥2 字（MemOS 原版只看 alpha≥4，会滤掉纯中文）
  const alpha = truncated.replace(/[^A-Za-z]/g, "");
  if (alpha.length < 4 && cjk.length < 2) return null;
  // 纯英文停用词片段才拒；纯中文（words 为空）不走这条
  const words = truncated.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
  if (words.length > 0 && words.every((w) => STOP_WORDS.has(w))) return null;
  // P3-A 收紧：裸过泛中文词（报错/失败/超时…+语气助词）且无具体锚点（latin≥3 / 多位数字 / 路径）→ 拒，
  // 避免检索端 error-signature 精确通道被这类词过度匹配成噪声。
  const hasSpecificAnchor = /[A-Za-z]{3,}|\d{2,}|\//.test(truncated);
  if (!hasSpecificAnchor && GENERIC_CN_ERROR.test(truncated)) return null;
  return truncated;
}

/** specificity：不寻常 token（PascalCase Error / 路径 / 错误码 / 中文错误）得分更高。 */
function specificityScore(frag: string, freq: number): number {
  let score = 0;
  if (/\b[A-Z][a-zA-Z]*Error\b/.test(frag)) score += 3;
  if (/\b[A-Z][a-zA-Z]*Exception\b/.test(frag)) score += 3;
  if (/(\b|_)E[A-Z]{3,}\b/.test(frag)) score += 2; // ENOENT, EACCES
  if (/\/[a-zA-Z0-9._\-/]+/.test(frag)) score += 2; // path
  if (/\bcode\s*=\s*\d+/.test(frag)) score += 1;
  if (/\b\d{3}\b/.test(frag)) score += 1; // status
  if (/_/.test(frag)) score += 1; // snake_case id
  if (/[一-鿿]/.test(frag)) score += 1; // 中文错误片段值得保留
  score += Math.min(2, freq - 1); // 重复片段小幅加权
  if (frag.length > 120) score -= 1; // 过长片段降权
  return score;
}
