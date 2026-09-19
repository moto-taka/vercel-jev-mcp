import { createGateway } from '@ai-sdk/gateway';
import { experimental_evaluate as evaluate } from 'ai';
import { askSchema } from './schemas.js';
import type { Environment } from './security.js';

// This service must not log provider warning payloads or submitted state.
(globalThis as typeof globalThis & { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

export const MODEL = 'typesafe-ai/jev';
export type FetchFunction = typeof globalThis.fetch;

export class JevFailure extends Error {
  constructor(
    readonly kind: string,
    readonly retryable: boolean,
    message: string,
    readonly status?: number,
  ) { super(message); }
}

/** Deliberately never forward provider errors, request bodies, headers, or stack traces. */
export function safeError(error: unknown) {
  if (error instanceof JevFailure) return {
    kind: error.kind, retryable: error.retryable, message: error.message,
    ...(error.status === undefined ? {} : { status: error.status }),
  };
  const e = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  const status = typeof e.statusCode === 'number' ? e.statusCode : undefined;
  const name = typeof e.name === 'string' ? e.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') return {
    kind: 'timeout', retryable: true, message: 'Evaluation was cancelled or exceeded the deadline.',
  };
  if (/Evaluation.*(Answer|Response|Result)|TypeValidation|JSONParse/.test(name)) return {
    kind: 'malformed_response', retryable: true, message: 'Gateway returned an invalid evaluation result.',
  };
  return {
    kind: status === 401 || status === 403 ? 'upstream_authentication'
      : status === 429 ? 'rate_limit' : status === 400 || status === 422 ? 'invalid_request' : 'upstream_error',
    retryable: status === 408 || status === 429 || status === undefined || status >= 500,
    message: status === 401 || status === 403
      ? 'Check the server-side AI Gateway and Jev credentials.' : 'AI Gateway evaluation failed.',
    ...(status === undefined ? {} : { status }),
  };
}

export function createJevService(env: Environment, options: { fetch?: FetchFunction; signal?: AbortSignal } = {}) {
  return {
    async ask(rawInput: unknown) {
      const parsed = askSchema.safeParse(rawInput);
      if (!parsed.success) throw new JevFailure('invalid_request', false, 'Invalid state or question schema.');
      const input = parsed.data;
      if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 240 * 1024) {
        throw new JevFailure('invalid_request', false, 'Evaluation input exceeds the 240 KiB limit.');
      }
      const apiKey = env.JEV_API_KEY?.trim();
      if (!apiKey) throw new JevFailure('configuration', false, 'Set JEV_API_KEY on the server.');
      const gatewayKey = env.AI_GATEWAY_API_KEY?.trim();
      if (!gatewayKey && !env.VERCEL) {
        throw new JevFailure('configuration', false, 'Set AI_GATEWAY_API_KEY, or use Vercel OIDC on Vercel.');
      }
      const timeout = env.JEV_TIMEOUT_MS === undefined || env.JEV_TIMEOUT_MS === ''
        ? 20_000 : Number(env.JEV_TIMEOUT_MS);
      if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 55_000) {
        throw new JevFailure('configuration', false, 'JEV_TIMEOUT_MS must be an integer from 1000 to 55000.');
      }
      const gateway = createGateway({
        ...(gatewayKey ? { apiKey: gatewayKey } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      const deadline = AbortSignal.timeout(timeout);
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      const started = performance.now();
      const result = await evaluate({
        model: gateway.evaluationModel(MODEL),
        state: input.state,
        questions: input.questions,
        maxRetries: 0,
        abortSignal: signal,
        providerOptions: {
          gateway: {
            only: ['typesafe-ai'],
            byok: { 'typesafe-ai': [{ apiKey }] },
          },
        },
      });
      // The SDK validates answers against submitted questions. Never return result.response:
      // errors/metadata/raw request bodies can contain user state or BYOK credentials.
      return {
        model: MODEL,
        answers: result.answers,
        usage: result.usage,
        ...(result.rounding ? { rounding: result.rounding } : {}),
        latency_ms: Math.round(performance.now() - started),
      };
    },
  };
}
export type JevService = ReturnType<typeof createJevService>;
