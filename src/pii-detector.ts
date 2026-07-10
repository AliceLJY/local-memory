/**
 * F-3: Lightweight PII detection.
 * Scans text for common sensitive patterns (passwords, tokens, IDs).
 * Returns warnings, does not block writes.
 *
 * F-3b (2026-07-10): Deterministic secret redaction on the same rule set.
 * `redactSecrets` scrubs redactable matches BEFORE text reaches any external
 * surface (LLM prompts, embedding API, stderr logs, audit trail). Detection
 * and redaction share one rule table so the two can never drift apart.
 * Deliberately NOT redacted: phone / email (legitimate memory content, warn
 * only) and bare long-hex (would false-positive on git commit hashes, which
 * are high-value memory content; prefixed forms like `secret=<hex>` are
 * caught by the assignment rules).
 */

export type PIISeverity = "high" | "medium" | "low";

export interface PIIDetection {
  type: string; // "api_key" | "password" | "id_number" | "email" | "phone" | "credit_card" | ...
  severity: PIISeverity;
  match: string; // the matched text (partially masked)
  position: number; // char offset
}

export interface PIIScanResult {
  hasPII: boolean;
  detections: PIIDetection[];
  summary: string; // human-readable summary
}

export interface RedactResult {
  text: string; // scrubbed text
  redacted: number; // number of replacements made
}

interface PIIRule {
  type: string;
  severity: PIISeverity;
  pattern: RegExp;
  /** Scrub matches via redactSecrets (detection-only rules leave text intact) */
  redact: boolean;
  /** For key=value style rules: keep the key name, scrub only the value */
  keepPrefix?: RegExp;
}

const PII_RULES: PIIRule[] = [
  // --- Vendor-prefixed token literals (high confidence, full scrub) ---
  {
    type: "anthropic_key",
    severity: "high",
    pattern: /sk-ant-[A-Za-z0-9_\-]{10,}/g,
    redact: true,
  },
  {
    type: "github_token",
    severity: "high",
    pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g,
    redact: true,
  },
  {
    type: "slack_token",
    severity: "high",
    pattern: /xox[baprs]-[A-Za-z0-9\-]{10,}/g,
    redact: true,
  },
  {
    type: "aws_access_key",
    severity: "high",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    redact: true,
  },
  {
    type: "google_api_key",
    severity: "high",
    pattern: /\bAIza[A-Za-z0-9_\-]{35}\b/g,
    redact: true,
  },
  {
    type: "jwt",
    severity: "high",
    pattern: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g,
    redact: true,
  },
  {
    type: "bearer_token",
    severity: "high",
    pattern: /\bBearer\s+[A-Za-z0-9._~+\/\-]{16,}=*/g,
    redact: true,
  },
  {
    type: "pem_private_key",
    severity: "high",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    redact: true,
  },
  // --- Generic assignment / key styles (keep key name, scrub value) ---
  {
    type: "api_key",
    severity: "high",
    pattern: /(?:sk-[A-Za-z0-9_\-]{20,}|(?:api[_-]?key|token|secret)[=:\s]["']?[A-Za-z0-9_\-]{20,})/gi,
    redact: true,
    keepPrefix: /^(?:api[_-]?key|token|secret)[=:\s]["']?/i,
  },
  {
    type: "password",
    severity: "high",
    pattern: /(?:password|passwd|pwd)[=:\s]["']?[^\s"']{8,}/gi,
    redact: true,
    keepPrefix: /^(?:password|passwd|pwd)[=:\s]["']?/i,
  },
  // --- High-risk personal identifiers (scrub) ---
  {
    type: "id_number",
    severity: "high",
    pattern: /\d{17}[\dXx]/g,
    redact: true,
  },
  {
    type: "credit_card",
    severity: "high",
    pattern: /\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}/g,
    redact: true,
  },
  // --- Detection-only: legitimate memory content, warn but keep ---
  {
    type: "phone",
    severity: "medium",
    pattern: /1[3-9]\d{9}/g,
    redact: false,
  },
  {
    type: "email",
    severity: "low",
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    redact: false,
  },
];

function maskSensitive(value: string): string {
  if (value.length <= 8) return value.slice(0, 2) + "***" + value.slice(-2);
  return value.slice(0, 4) + "***" + value.slice(-4);
}

/** Scan text for potential PII. Pure regex, no LLM call. */
export function scanForPII(text: string): PIIScanResult {
  const detections: PIIDetection[] = [];

  for (const rule of PII_RULES) {
    // Reset lastIndex for global regexes
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(text)) !== null) {
      detections.push({
        type: rule.type,
        severity: rule.severity,
        match: maskSensitive(m[0]),
        position: m.index,
      });
    }
  }

  const high = detections.filter((d) => d.severity === "high").length;
  const medium = detections.filter((d) => d.severity === "medium").length;
  const low = detections.filter((d) => d.severity === "low").length;

  const summary =
    detections.length === 0
      ? "No PII detected"
      : `Found ${detections.length} potential PII item${detections.length > 1 ? "s" : ""} (${high} high, ${medium} medium, ${low} low)`;

  return {
    hasPII: detections.length > 0,
    detections,
    summary,
  };
}

/**
 * Deterministically scrub redactable secrets. Pure regex, no LLM call.
 * Replacement is `[REDACTED:<type>]`; assignment-style rules keep the key
 * name (`password=[REDACTED:password]`) so the memory stays readable.
 */
export function redactSecrets(text: string): RedactResult {
  let out = text;
  let redacted = 0;

  for (const rule of PII_RULES) {
    if (!rule.redact) continue;
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, (match) => {
      redacted++;
      if (rule.keepPrefix) {
        const prefixMatch = match.match(rule.keepPrefix);
        if (prefixMatch) {
          return `${prefixMatch[0]}[REDACTED:${rule.type}]`;
        }
      }
      return `[REDACTED:${rule.type}]`;
    });
  }

  return { text: out, redacted };
}

/**
 * Redact + truncate for log lines. Truncation happens AFTER redaction so a
 * secret can never straddle the cut and leak its prefix.
 */
export function redactForLog(text: string, max = 60): string {
  return redactSecrets(text).text.slice(0, max);
}
