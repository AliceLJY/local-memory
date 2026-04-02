/**
 * F-3: Lightweight PII detection.
 * Scans text for common sensitive patterns (passwords, tokens, IDs).
 * Returns warnings, does not block writes.
 */

export type PIISeverity = "high" | "medium" | "low";

export interface PIIDetection {
  type: string; // "api_key" | "password" | "id_number" | "email" | "phone" | "credit_card"
  severity: PIISeverity;
  match: string; // the matched text (partially masked)
  position: number; // char offset
}

export interface PIIScanResult {
  hasPII: boolean;
  detections: PIIDetection[];
  summary: string; // human-readable summary
}

interface PIIRule {
  type: string;
  severity: PIISeverity;
  pattern: RegExp;
}

const PII_RULES: PIIRule[] = [
  {
    type: "api_key",
    severity: "high",
    pattern: /(?:sk-[A-Za-z0-9_\-]{20,}|(?:api[_-]?key|token|secret)[=:\s]["']?[A-Za-z0-9_\-]{20,})/gi,
  },
  {
    type: "password",
    severity: "high",
    pattern: /(?:password|passwd|pwd)[=:\s]["']?[^\s"']{8,}/gi,
  },
  {
    type: "id_number",
    severity: "high",
    pattern: /\d{17}[\dXx]/g,
  },
  {
    type: "credit_card",
    severity: "high",
    pattern: /\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}/g,
  },
  {
    type: "phone",
    severity: "medium",
    pattern: /1[3-9]\d{9}/g,
  },
  {
    type: "email",
    severity: "low",
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
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
