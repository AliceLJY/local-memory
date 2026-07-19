export const LOCAL_HTTP_HOSTNAME = "127.0.0.1";
export const LOCAL_JSON_BODY_LIMIT_BYTES = 1024 * 1024;

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const DEFAULT_JSON_METHODS = ["POST"] as const;

export interface LocalHttpRequestPolicyOptions {
  jsonMethods?: readonly string[];
  maxJsonBodyBytes?: number;
}

export type LocalHttpRequestPolicyResult =
  | { allowed: true }
  | { allowed: false; status: 400 | 403 | 413 | 415; message: string };

function reject(
  status: 400 | 403 | 413 | 415,
  message: string,
): LocalHttpRequestPolicyResult {
  return { allowed: false, status, message };
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function hostnameFromHostHeader(hostHeader: string): string | null {
  const authority = hostHeader.trim();
  if (!authority || /[\s/@?#\\]/.test(authority)) return null;

  try {
    return normalizeHostname(new URL(`http://${authority}`).hostname);
  } catch {
    return null;
  }
}

function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(normalizeHostname(hostname));
}

function readContentLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return Number.NaN;
  return Number(trimmed);
}

async function bodyExceedsLimit(request: Request, maxBytes: number): Promise<boolean> {
  if (!request.body) return false;

  const reader = request.clone().body?.getReader();
  if (!reader) return false;

  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return false;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel("request body too large").catch(() => {});
        return true;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function enforceLocalHttpRequestPolicy(
  request: Request,
  options: LocalHttpRequestPolicyOptions = {},
): Promise<LocalHttpRequestPolicyResult> {
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return reject(400, "Invalid request URL.");
  }

  if (!isLocalHostname(requestUrl.hostname)) {
    return reject(403, "Host is not allowed.");
  }

  const hostHeader = request.headers.get("host");
  if (hostHeader != null) {
    const hostname = hostnameFromHostHeader(hostHeader);
    if (!hostname || !isLocalHostname(hostname)) {
      return reject(403, "Host is not allowed.");
    }
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return reject(403, "Cross-site requests are not allowed.");
  }

  const origin = request.headers.get("origin");
  if (origin != null) {
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      return reject(403, "Origin is not allowed.");
    }
    if (originUrl.origin !== requestUrl.origin) {
      return reject(403, "Origin is not allowed.");
    }
  }

  const jsonMethods = options.jsonMethods ?? DEFAULT_JSON_METHODS;
  if (!jsonMethods.some((method) => method.toUpperCase() === request.method.toUpperCase())) {
    return { allowed: true };
  }

  const mediaType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return reject(415, "Content-Type must be application/json.");
  }

  const maxJsonBodyBytes = options.maxJsonBodyBytes ?? LOCAL_JSON_BODY_LIMIT_BYTES;
  const contentLength = readContentLength(request);
  if (contentLength != null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
    return reject(400, "Invalid Content-Length header.");
  }
  if (contentLength != null && contentLength > maxJsonBodyBytes) {
    return reject(413, `Request body exceeds ${maxJsonBodyBytes} bytes.`);
  }

  try {
    if (await bodyExceedsLimit(request, maxJsonBodyBytes)) {
      return reject(413, `Request body exceeds ${maxJsonBodyBytes} bytes.`);
    }
  } catch {
    return reject(400, "Unable to read request body.");
  }

  return { allowed: true };
}
