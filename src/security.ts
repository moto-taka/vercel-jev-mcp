import { createHash, timingSafeEqual } from 'node:crypto';

export type Environment = Record<string, string | undefined>;
export const MAX_BODY_BYTES = 256 * 1024;

export class RequestFailure extends Error {
  constructor(readonly status: 400 | 401 | 403 | 413 | 415 | 503, message: string) {
    super(message);
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** No default password and no process-local sessions. Every HTTP request is checked. */
export function authorize(request: Request, env: Environment): void {
  const tokens = [env.MCP_BEARER_TOKEN, env.MCP_BEARER_TOKEN_PREVIOUS].filter(
    (value): value is string => value !== undefined && value !== '',
  );
  // Reject malformed configuration rather than silently weakening authentication.
  if (!env.MCP_BEARER_TOKEN || tokens.some((token) => !/^[A-Za-z0-9._~+/-]{32,256}={0,2}$/.test(token))) {
    throw new RequestFailure(503, 'MCP authentication is not configured correctly.');
  }
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9._~+/-]+={0,2})$/i.exec(header);
  const candidate = digest(match?.[1] ?? '');
  // Check all configured tokens even when the first one matches.
  let allowed = 0;
  for (const token of tokens) allowed |= Number(timingSafeEqual(candidate, digest(token)));
  if (!match || !allowed) throw new RequestFailure(401, 'A valid Bearer token is required.');

  // Native clients omit Origin. Browser requests must be explicitly allowlisted.
  const origin = request.headers.get('origin');
  if (origin !== null) {
    const origins = (env.MCP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (origin === 'null' || !origins.includes(origin)) {
      throw new RequestFailure(403, 'Origin is not allowed.');
    }
  }
}

/** Enforce actual bytes, including chunked bodies or a forged Content-Length. */
export async function boundedBody(request: Request): Promise<string> {
  const encoding = request.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') {
    throw new RequestFailure(415, 'Compressed request bodies are not supported.');
  }
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    throw new RequestFailure(415, 'Content-Type must be application/json.');
  }
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > MAX_BODY_BYTES) throw new RequestFailure(413, 'Request body is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new RequestFailure(400, 'A JSON body is required.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new RequestFailure(413, 'Request body is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks, length).toString('utf8');
  // Prevent adversarial nesting before JSON parsing / recursive schema validation.
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of body) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') {
      if (++depth > 40) throw new RequestFailure(400, 'JSON nesting exceeds the limit.');
    } else if (char === '}' || char === ']') depth--;
  }
  return body;
}
