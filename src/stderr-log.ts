/**
 * Keep library- and MCP-path logs off stdout.
 * stdout is reserved for MCP protocol frames and CLI result output.
 */

export function logInfo(...args: unknown[]): void {
  console.error(...args);
}

export function logWarn(...args: unknown[]): void {
  console.warn(...args);
}

export function logError(...args: unknown[]): void {
  console.error(...args);
}
