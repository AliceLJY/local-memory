/**
 * Cross-runtime compatibility helpers
 *
 * Bridges Bun-specific APIs to work with Node.js as well.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Cross-runtime replacement for Bun's `import.meta.dir`.
 * - Bun: returns import.meta.dir (native, fast)
 * - Node.js: derives from import.meta.url
 *
 * Usage: replace `import.meta.dir` with `metaDir(import.meta)`
 */
export function metaDir(meta: ImportMeta): string {
  // Bun sets import.meta.dir natively
  const dir = (meta as Record<string, unknown>).dir;
  if (typeof dir === "string") return dir;
  // Node.js fallback
  return dirname(fileURLToPath(meta.url));
}
