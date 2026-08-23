/**
 * dream 合成契约 —— cluster insight 与 cross-memory pattern 的提示词、解析与写库前校验。
 *
 * 为什么单独一个模块（2026-08-23）：
 * 在此之前，「簇 → 一条派生记忆」这件事没有契约，只有两个各自为政的 LLM 调用：
 *   - cluster_insight 走 `generateL0` —— 那是**分块索引摘要器**，提示词写的是
 *     「给对话片段写一句话摘要，用于快速检索」，从不要求结论、因果、决策或行动，
 *     还明文要求「端口号/IP/URL/文件路径 → 原样保留」。名字叫 insight，干的是做目录。
 *   - cross_memory_pattern 走 `extractPattern` —— 目标概念写的是「反复出现的偏好、
 *     行为倾向、价值观」，那是**性格画像**框架，于是产出星座运势腔。
 *
 * 2026-08-22 的全量诊断量到了后果（同长度区间 40–160 字，确定性正则，无 LLM 判官）：
 *   手写 pivot 40.4% > 原料 transcript 25.1% > insight 14.4% > pattern 12.1%
 *   —— **产物的结论密度低于它自己的原料，合成这一步在做减法**；
 *   pattern 侧 56.1% 命中性向归因句式，对照原料 1.4%（40 倍富集）。
 * 同一批真实簇做三臂对照（n=40，种子 9001）：只把提示词换成结论导向 + 允许弃权，
 * 同模型下结论连接词 17.5% → 32.3%、性向归因 62.5% → 0%、弃权率 0% → 22.5%。
 * 结论一直在输入里，是合成把它变成了目录。
 *
 * 所以这里定的是三件事，缺一条都会退回老样子：
 *   1. **目标概念**：要的是「可复用结论」（规则/因果/决策/踩坑/判断转折），不是摘要，
 *      更不是性格描写。两个提示词都显式禁掉「注重/强调/倾向于」那一族措辞。
 *   2. **弃权路径**：炼不出来必须能说「没有」。老 `generateL0` 的 `if (!insight)` 只在
 *      LLM 调用失败时触发，**永远不会因为「这簇不值得留」而不写** —— 2,427 条按构造
 *      全是情节摘要，就是这么来的。
 *   3. **写库前校验**：LLM 说了什么不算数，能过校验才写。老路径只检查
 *      `response.length < 5`，后果是库里有 28 条记忆的正文**就是它自己的系统提示词原文**。
 *
 * 本模块是纯函数 + 常量，不碰网络也不碰库，故校验规则可以直接单测。
 */

/** 一条合格的合成产物。 */
export interface SynthesisOutput {
  /** 结论正文。不截断 —— 截断一句结论等于毁掉它。 */
  text: string;
  /** 支撑这条结论的源记录编号（1-based，已去重升序，且都在簇内）。 */
  evidence: number[];
}

/** 校验不通过的原因。逐项区分是为了让「LLM 不好好干活」有形状，而不是笼统一个 null。 */
export type SynthesisRejectReason =
  | "unparsable"          // 拿不到 JSON
  | "flag-not-boolean"    // has 字段不是 boolean
  | "empty-text"          // 说有结论却没给正文
  | "too-short"
  | "too-long"
  | "prompt-echo"         // 正文是提示词自身的回声（老路径进库 28 条的形态）
  | "evidence-missing"    // 没给 evidence 或不是数组
  | "evidence-too-few"    // 合法编号不够
  | "evidence-out-of-range"; // 编号不是簇内真实存在的下标

export type SynthesisVerdict =
  | { status: "ok"; output: SynthesisOutput }
  | { status: "abstained" }
  | { status: "rejected"; reason: SynthesisRejectReason };

/** 正文长度闸。下界防空壳，上界防 LLM 把整段推理倒进来。 */
export const SYNTHESIS_MIN_LEN = 12;
export const SYNTHESIS_MAX_LEN = 300;

/**
 * 提示词回声标记 —— 命中任意一条即判 `prompt-echo`。
 *
 * 挑选判据：必须是**只可能来自提示词本身**的长串。一条真实结论里不会出现
 * 「宁可不产出」或「记忆索引助手」，但完全可能出现「JSON」「evidence」这类词，
 * 所以后者不进表 —— 这张表宁可漏也不能误杀真结论。
 * 头两条是老 `generateL0` 提示词的原文，那 28 条泄漏就是照它进的库。
 */
export const PROMPT_ECHO_MARKERS: readonly string[] = [
  "保真规则",
  "端口号/IP/URL/文件路径",
  "记忆索引助手",
  "记忆模式发现助手",
  "宁可不产出",
  "那是性格描写不是结论",
  "不要加任何解释或代码围栏",
];

/** 送进模型的簇文本总预算（字符）。三臂实验用的就是这个量级，够 p90 簇全文进模型。 */
export const CLUSTER_INPUT_BUDGET = 12_000;

/**
 * 把总预算在簇成员之间**等额分配**，短成员用不完的份额让给长成员。
 *
 * 老路径是 `text.slice(0, 2000)` —— 整簇拼成一条长文本后从头切。实测 64.2% 的簇被截，
 * 中位只有 62.7% 的源文本进得了模型，p10 仅 13.8%：**排在后面的成员根本没被看见**，
 * 而簇最大有 168 个成员。等额分配保证每条源都有机会出现在模型眼前，这是「跨条目结论」
 * 能成立的物理前提 —— 看不到的东西无法被跨。
 *
 * 算法：按长度升序，每轮把「剩余预算 / 剩余条数」作为当条份额；短于份额的整条收下并
 * 把余量退回池子，长于份额的截到份额并加省略号。单趟 O(n log n)。
 */
export function allocateClusterBudget(texts: string[], totalBudget = CLUSTER_INPUT_BUDGET): string[] {
  if (texts.length === 0) return [];
  const out = new Array<string>(texts.length);
  const order = texts
    .map((t, i) => ({ i, len: t.length }))
    .sort((a, b) => a.len - b.len);

  let remainingBudget = Math.max(0, totalBudget);
  let remainingCount = order.length;

  for (const { i } of order) {
    const share = Math.floor(remainingBudget / remainingCount);
    const text = texts[i];
    if (text.length <= share) {
      out[i] = text;
      remainingBudget -= text.length;
    } else {
      // 至少留 1 个字符，避免 share=0 时产出空串（空串会让编号错位、evidence 无从指认）
      out[i] = share > 1 ? `${text.slice(0, share - 1)}…` : text.slice(0, 1);
      remainingBudget -= out[i].length;
    }
    remainingCount--;
  }
  return out;
}

/** 把簇文本编号拼成 user message。编号是 1-based，与 evidence 的语义一致。 */
export function numberClusterTexts(texts: string[]): string {
  return texts.map((t, i) => `[${i + 1}] ${t}`).join("\n");
}

/**
 * cluster insight 的提示词。
 *
 * 与三臂实验里跑出 32.3%（qwen-turbo）/ 45.2%（qwen-max）的那版同源，另加两条：
 * 「三要素齐全」的硬要求，以及 evidence 字段 —— 后者不只是为了可追溯，它同时是一道
 * 隐性质检：说不出这句话是从哪几条来的，通常意味着它是凭空润色出来的。
 */
export const CLUSTER_INSIGHT_PROMPT = `你在为一个长期记忆库提炼「可复用结论」。下面是同一次工作中若干条编号记录。

一条合格的结论必须**自带理由或后果**。只说"该做什么"而不说"为什么"或"否则会怎样"的，
不是结论，是待办事项——待办会过期，结论不会，而这个库只留不会过期的东西。

形状（两段都在才写）：
  ① 在什么条件下、对什么对象，该怎么做或会怎样
  ② 为什么 / 否则会怎样 / 根因是什么

合格示例：
  多 org 协作不能用 fine-grained token，必须换 classic PAT，因为一个 fine-grained token 只能绑定一个 resource owner。
  分派前必须先等 store 完成惰性初始化，否则读到的 hasFtsSupport 还是初始化前的 false，hybrid 检索会静默落回 vector 路径。
  批量删记忆要显式关掉 cascade，否则同 scope 内相似度高的条目会被连带降权，本意要保护的池子反而先受伤。

不合格示例（这几种一律返回 has:false，不要硬改成合格的样子）：
  配置扫描路径时应统一添加多个目录以兼容不同格式   ← 只有动作，没说不这么做会怎样
  完成了三版对齐与定稿，删除了旧草稿              ← 复述经过
  注重流程闭环与规范性，重视可追溯                ← 性格描写
  把端口改成 8080 后服务恢复正常                  ← 绑死在一次性对象上

其余硬性要求：
- 结论要在未来另一个不同场景里仍然成立。绑死在一次性对象上的（某个进程号、某次会议、某天的待办）不算。
- 不要写某人"注重什么""强调什么""倾向于什么"——那是性格描写不是结论。
- evidence 填支撑这条结论的记录编号，至少 1 个，且必须是上面真实出现过的编号。
- 这批记录里**大多数**确实提炼不出这样的结论，那就老实返回 has:false。宁可不产出，也不要把待办事项包装成结论。

只输出**一个** JSON 对象，不要加任何解释或代码围栏。即使你想到不止一条结论，也只输出最重要的那一条，
不要输出多个 JSON 对象——多输出的会被整条丢弃。
{"has": true, "conclusion": "一句话，不超过120字", "evidence": [编号, ...]}
或 {"has": false}`;

/**
 * cross-memory pattern 的提示词。
 *
 * 目标概念从「反复出现的偏好、行为倾向、价值观或循环主题」换成「跨条目才成立的
 * 规则/因果/决策/踩坑/判断转折」。旧措辞是这一侧 56.1% 性向归因的直接来源：
 * 它要的就是性格画像，模型只是忠实执行。
 *
 * evidence ≥2 在这里是**定义性**的，不是可选的严格度：单条支撑的东西按定义不是
 * 跨条目模式。旧提示词嘴上写了「至少 2 条记忆作为证据支撑」，实现却既不接收也不校验
 * 编号，于是这句话零成本。
 */
export const CLUSTER_PATTERN_PROMPT = `你在为一个长期记忆库提炼「跨条目才成立的结论」。下面是同一组相关记录，已编号。

和逐条摘要不同，你要找的是单独看任何一条都看不出来、必须放在一起才成立的东西。
而且它必须**自带理由或后果**：只说"该做什么"而不说"为什么"或"否则会怎样"的，
不是结论，是待办事项——待办会过期，结论不会，而这个库只留不会过期的东西。

形状（两段都在才写）：
  ① 这类情况反复出现时，固定该怎么做 / 会怎样
  ② 为什么 / 否则会怎样 / 根因是什么

合格示例：
  这套流程里凡是"改了真相源"的动作都必须连带扫引用点，因为漏扫不会报错，只会让两份文档各说各话，直到几天后被别人撞见。
  同一个 bug 连修三次不成必须停下来质疑架构，而不是第四次重试，因为前三次失败说明诊断本身是错的，重试只是在错误位置上继续投入。

不合格示例（这几种一律返回 has:false，不要硬改成合格的样子）：
  注重规则有效性验证和成本效益评估，倾向于通过增量改造提升效果   ← 性格画像，这一类是本任务最常见的错误产出
  多次进行配置调整与验证，持续关注同步状态                      ← 复述经过
  统一使用绝对路径调用脚本                                      ← 只有动作，没说不这么做会怎样

其余硬性要求：
- 必须由**至少 2 条**记录共同支撑，把这些编号填进 evidence。只有 1 条支撑的不算跨条目。
- 绑死在一次性对象上的（某个进程号、某次会议、某天的待办）不算。
- 这批记录里**大多数**确实凑不出这样的跨条目结论，那就老实返回 has:false。宁可不产出，也不要把"他们都在做类似的事"写成模式。

只输出**一个** JSON 对象，不要加任何解释或代码围栏。即使你想到不止一条模式，也只输出最重要的那一条，
不要输出多个 JSON 对象——多输出的会被整条丢弃。
{"has": true, "pattern": "一句话，不超过150字", "evidence": [编号, ...]}
或 {"has": false}`;

/**
 * 从可能带围栏 / 带前言的原始回复里抠出 JSON 对象。与 `chatJson` 同款兜底。
 *
 * **刻意保持严格**：模型偶尔会一口气输出多个 JSON 对象（一条结论一个），
 * 此时「第一个 { 到最后一个 }」跨越了所有对象、解析失败，整条判 unparsable。
 * 不去挑其中一个来救 —— 挑哪一条是任意的，而任意选择会让「模型没照契约干活」
 * 这件事从计数里消失。根因在提示词侧治（两个提示词都写死「只输出一个 JSON 对象」）；
 * 2026-08-23 实测该形态占 3.3%（60 次调用 2 次），且 finish_reason 全为 stop、
 * 与 token 截断无关——所以不要试图靠加大 max_tokens 来修它。
 */
export function parseSynthesisJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  const fence = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const candidates = [fence ? fence[1].trim() : raw.trim()];
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 试下一个候选
    }
  }
  return null;
}

/**
 * 写库前的唯一一道闸。**不做任何补救性纠正** —— 不截断、不补 evidence、不猜 has 的意图。
 * 补救会让「模型没照契约干活」这件事消失在日志之外，而那正是要看见的东西。
 */
export function validateSynthesis(params: {
  parsed: Record<string, unknown> | null;
  /** 正文字段名：insight 侧是 conclusion，pattern 侧是 pattern。 */
  textField: string;
  /** 簇成员数，用来判 evidence 编号是否真实存在。 */
  memberCount: number;
  /** 合法 evidence 编号的下限。insight = 1，pattern = 2（定义性要求）。 */
  minEvidence: number;
}): SynthesisVerdict {
  const { parsed, textField, memberCount, minEvidence } = params;
  if (!parsed) return { status: "rejected", reason: "unparsable" };

  const has = parsed.has;
  if (typeof has !== "boolean") return { status: "rejected", reason: "flag-not-boolean" };
  if (!has) return { status: "abstained" };

  const rawText = parsed[textField];
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    return { status: "rejected", reason: "empty-text" };
  }
  const text = rawText.trim();
  if (text.length < SYNTHESIS_MIN_LEN) return { status: "rejected", reason: "too-short" };
  if (text.length > SYNTHESIS_MAX_LEN) return { status: "rejected", reason: "too-long" };
  if (PROMPT_ECHO_MARKERS.some(m => text.includes(m))) {
    return { status: "rejected", reason: "prompt-echo" };
  }

  const rawEvidence = parsed.evidence;
  if (!Array.isArray(rawEvidence)) return { status: "rejected", reason: "evidence-missing" };

  const seen = new Set<number>();
  let sawOutOfRange = false;
  for (const item of rawEvidence) {
    const n = typeof item === "number" ? item : Number(item);
    if (!Number.isInteger(n)) { sawOutOfRange = true; continue; }
    if (n < 1 || n > memberCount) { sawOutOfRange = true; continue; }
    seen.add(n);
  }
  const evidence = [...seen].sort((a, b) => a - b);

  if (evidence.length < minEvidence) {
    // 一个都没对上（且确实给了越界编号）说明模型在编号；对上了但不够数是证据不足。
    return {
      status: "rejected",
      reason: evidence.length === 0 && sawOutOfRange ? "evidence-out-of-range" : "evidence-too-few",
    };
  }

  return { status: "ok", output: { text, evidence } };
}
