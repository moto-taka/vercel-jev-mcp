import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/index.js';
import { createJevService, safeError, MODEL, type FetchFunction } from '../src/jev.js';
import { askSchema } from '../src/schemas.js';
import { authorize, MAX_BODY_BYTES, type Environment } from '../src/security.js';

// Test fixtures only. No real token or provider key is used by this suite.
const token = 'test-only-'.repeat(8);
const env: Environment = {
  MCP_BEARER_TOKEN: token,
  JEV_API_KEY: 'test-jev-not-a-real-key',
  AI_GATEWAY_API_KEY: 'test-gateway-not-a-real-key',
};
const example = {
  state: { message: 'The requested field is visible.' },
  questions: { visible: { type: 'boolean' as const, instructions: 'Is the requested field visible?' } },
};
type WireCall = { url: string; headers: Headers; body: Record<string, any> };
function standIn(response?: unknown, status = 200) {
  const calls: WireCall[] = [];
  const fetch: FetchFunction = async (input, init) => {
    const request = new Request(input, init);
    const body = await request.json() as Record<string, any>;
    calls.push({ url: request.url, headers: request.headers, body });
    const answers = Object.fromEntries(Object.entries(body.questions ?? {}).map(([id, raw]) => {
      const q = raw as Record<string, any>;
      if (q.type === 'boolean') return [id, { type: 'boolean', probability: 0.9 }];
      if (q.type === 'choice') {
        const keys = Object.keys(q.criteria);
        return [id, { type: 'choice', choice: keys[0], probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 1 : 0])) }];
      }
      const levels = q.criteria as unknown[];
      return [id, { type: 'score', score: 0, probabilities: Object.fromEntries(levels.map((_, i) => [String(i), i === 0 ? 1 : 0])) }];
    }));
    return Response.json(response ?? { answers, usage: { inputTokens: 40, outputTokens: 0 }, warnings: [] }, { status });
  };
  return { fetch, calls };
}
function httpRequest(body?: unknown, options: { path?: string; method?: string; headers?: Record<string, string>; authenticated?: boolean } = {}) {
  return new Request(`https://mcp.test${options.path ?? '/mcp'}`, {
    method: options.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...(options.authenticated === false ? {} : { authorization: `Bearer ${token}` }),
      ...options.headers,
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}
async function readRpc(response: Response): Promise<any> {
  const text = await response.text();
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean);
    assert.ok(data.length > 0, `No SSE message: ${text}`);
    return JSON.parse(data[data.length - 1]!);
  }
  return JSON.parse(text);
}
function rpc(method: string, params: unknown = {}) { return { jsonrpc: '2.0', id: 1, method, params }; }

for (const method of ['POST', 'GET', 'DELETE', 'OPTIONS']) {
  test(`missing Bearer rejects ${method} before any Gateway request`, async () => {
    const mock = standIn();
    const response = await createApp(env, mock).fetch(httpRequest(undefined, { method, authenticated: false }));
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate') ?? '', /Bearer/);
    assert.equal(mock.calls.length, 0);
  });
}
test('wrong Bearer, query token, and unsupported scheme are rejected', async () => {
  const app = createApp(env);
  for (const authorization of ['Bearer wrong', 'Basic xyz', `Bearer ${token} garbage`]) {
    assert.equal((await app.fetch(httpRequest(rpc('tools/list'), { headers: { authorization } }))).status, 401);
  }
  assert.equal((await app.fetch(httpRequest(undefined, { path: `/mcp?token=${token}`, authenticated: false }))).status, 401);
});
test('missing or weak configured token fails closed', async () => {
  for (const key of [undefined, '', 'weak', ' '.repeat(64)]) {
    assert.equal((await createApp({ ...env, MCP_BEARER_TOKEN: key }).fetch(httpRequest(rpc('tools/list')))).status, 503);
  }
});
test('token rotation accepts both tokens and rejects malformed previous token', () => {
  const old = 'old-test-token-'.repeat(5);
  authorize(httpRequest(undefined, { headers: { authorization: `bearer ${old}` } }), { ...env, MCP_BEARER_TOKEN_PREVIOUS: old });
  authorize(httpRequest(), { ...env, MCP_BEARER_TOKEN_PREVIOUS: old });
  assert.throws(() => authorize(httpRequest(), { ...env, MCP_BEARER_TOKEN_PREVIOUS: 'bad' }));
});
test('Origin is denied by default and must match an exact allowlist entry', async () => {
  const app = createApp({ ...env, MCP_ALLOWED_ORIGINS: 'https://trusted.test' });
  for (const origin of ['null', 'https://evil.test', 'https://trusted.test.evil.test']) {
    assert.equal((await app.fetch(httpRequest(rpc('tools/list'), { headers: { origin } }))).status, 403);
  }
  assert.equal((await app.fetch(httpRequest(rpc('tools/list'), { headers: { origin: 'https://trusted.test' } }))).status, 200);
});
test('body limit checks real bytes rather than trusting Content-Length', async () => {
  const mock = standIn();
  const response = await createApp(env, mock).fetch(httpRequest('x'.repeat(MAX_BODY_BYTES + 1), { headers: { 'content-length': '1' } }));
  assert.equal(response.status, 413);
  assert.equal(mock.calls.length, 0);
});
test('compressed bodies, wrong content type and excessive nesting are rejected', async () => {
  const app = createApp(env);
  assert.equal((await app.fetch(httpRequest('{}', { headers: { 'content-encoding': 'gzip' } }))).status, 415);
  assert.equal((await app.fetch(httpRequest('{}', { headers: { 'content-type': 'text/plain' } }))).status, 415);
  assert.equal((await app.fetch(httpRequest('['.repeat(41) + '0' + ']'.repeat(41)))).status, 400);
});
test('initialize and tools/list work without provider keys or paid calls', async () => {
  const mock = standIn();
  const app = createApp({ MCP_BEARER_TOKEN: token }, mock);
  const response = await app.fetch(httpRequest(rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0' },
  })));
  assert.equal(response.status, 200);
  const initialized = await readRpc(response);
  assert.equal(initialized.result.serverInfo.name, 'vercel-jev-mcp');
  assert.equal(response.headers.get('mcp-session-id'), null);
  const listed = await readRpc(await app.fetch(httpRequest(rpc('tools/list'))));
  assert.deepEqual(listed.result.tools.map((tool: any) => tool.name).sort(), ['jev_ask', 'jev_check', 'jev_classify', 'jev_score']);
  assert.equal(mock.calls.length, 0);
});
test('authenticated GET/DELETE have no persistent SSE or session', async () => {
  for (const method of ['GET', 'DELETE']) {
    const response = await createApp(env).fetch(httpRequest(undefined, { method }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  }
});
test('real SDK sends one batched Gateway evaluation call, with isolated BYOK', async () => {
  const mock = standIn();
  const input = {
    state: { task: 'Find the form', elements: ['form', 'footer'] },
    questions: {
      required: { type: 'boolean', instructions: 'Is the form visible?', criteria: { true: 'form present' } },
      selected: { type: 'choice', instructions: { goal: 'Choose form' }, criteria: { form: ['form'], footer: null } },
      relevance: { type: 'score', instructions: 'Rate relevance', criteria: ['unrelated', 'required'] },
    },
  };
  const response = await createApp(env, mock).fetch(httpRequest(rpc('tools/call', { name: 'jev_ask', arguments: input })));
  assert.equal(response.status, 200);
  const payload = await readRpc(response);
  assert.equal(payload.result.isError, undefined);
  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0]!;
  assert.match(call.url, /^https:\/\/ai-gateway\.vercel\.sh\/.*evaluation-model$/);
  assert.equal(call.headers.get('ai-model-id'), MODEL);
  assert.equal(call.headers.get('ai-evaluation-model-specification-version'), '4');
  assert.equal(call.headers.get('authorization'), `Bearer ${env.AI_GATEWAY_API_KEY}`);
  assert.deepEqual(call.body.state, input.state);
  assert.deepEqual(call.body.questions, input.questions);
  assert.deepEqual(call.body.providerOptions.gateway, {
    only: ['typesafe-ai'], byok: { 'typesafe-ai': [{ apiKey: env.JEV_API_KEY }] },
  });
  const output = payload.result.structuredContent;
  assert.equal(output.answers.required.probability, 0.9);
  assert.equal(output.answers.selected.choice, 'form');
  assert.deepEqual(output.answers.selected.probabilities, { form: 1, footer: 0 });
  assert.equal(output.usage.inputTokens, 40);
  assert.equal(output.model, MODEL);
  assert.ok(output.latency_ms >= 0);
  const serialized = JSON.stringify(payload);
  for (const secret of [token, env.JEV_API_KEY!, env.AI_GATEWAY_API_KEY!]) assert.ok(!serialized.includes(secret));
  assert.ok(!JSON.stringify(call.body).includes(token));
});
for (const [name, args, type] of [
  ['jev_check', { instructions: 'Is it visible?' }, 'boolean'],
  ['jev_classify', { instructions: 'Choose', criteria: { yes: 'visible', no: 'not visible' } }, 'choice'],
  ['jev_score', { instructions: 'Rate', criteria: ['low', 'high'] }, 'score'],
] as const) {
  test(`${name} is a transparent single-question wrapper`, async () => {
    const mock = standIn();
    const response = await createApp(env, mock).fetch(httpRequest(rpc('tools/call', {
      name, arguments: { state: 'Visible', ...args },
    })));
    const payload = await readRpc(response);
    assert.equal(payload.result.isError, undefined);
    assert.deepEqual(mock.calls[0]!.body.questions, { result: { type, ...args } });
    assert.equal(payload.result.structuredContent.answers.result.type, type);
  });
}
test('schema errors and oversized question sets never reach Gateway', async () => {
  const mock = standIn();
  const app = createApp(env, mock);
  const invalid = [
    { ...example, questions: {} },
    { ...example, questions: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q${i}`, example.questions.visible])) },
    { ...example, questions: { a: { type: 'noul', instructions: 'Question' } } },
    { ...example, apiKey: 'must-not-be-a-tool-argument' },
    { ...example, questions: { a: { type: 'choice', instructions: 'Q', criteria: {} } } },
    { ...example, questions: { a: { type: 'score', instructions: 'Q', criteria: ['single'] } } },
    { ...example, questions: JSON.parse('{"__proto__":{"type":"boolean","instructions":"Q"}}') },
  ];
  for (const input of invalid) {
    assert.equal(askSchema.safeParse(input).success, false);
    assert.equal((await app.fetch(httpRequest(input, { path: '/v1/evaluate' }))).status, 400);
  }
  assert.equal(mock.calls.length, 0);
});
test('SDK validation rejects an invented choice rather than returning it', async () => {
  const mock = standIn({ answers: { result: { type: 'choice', choice: 'invented', probabilities: { invented: 1 } } } });
  const response = await createApp(env, mock).fetch(httpRequest(rpc('tools/call', {
    name: 'jev_classify', arguments: { state: 'A', instructions: 'Choose', criteria: { a: 'A', b: 'B' } },
  })));
  const payload = await readRpc(response);
  assert.equal(payload.result.isError, true);
  assert.equal(payload.result.structuredContent.answers, undefined);
});
test('provider errors are sanitized, do not retry and do not leak secrets', async () => {
  const mock = standIn({ error: `rejected ${env.JEV_API_KEY} ${env.AI_GATEWAY_API_KEY} private state` }, 401);
  const response = await createApp(env, mock).fetch(httpRequest(rpc('tools/call', { name: 'jev_ask', arguments: example })));
  const payload = await readRpc(response);
  assert.equal(payload.result.isError, true);
  assert.equal(mock.calls.length, 1);
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes(env.JEV_API_KEY!));
  assert.ok(!serialized.includes(env.AI_GATEWAY_API_KEY!));
  assert.ok(!serialized.includes('private state'));
});
test('missing Jev key fails without Gateway I/O, never falls back to direct TypeSafe', async () => {
  const mock = standIn();
  const response = await createApp({ ...env, JEV_API_KEY: '' }, mock).fetch(httpRequest(rpc('tools/call', { name: 'jev_ask', arguments: example })));
  const payload = await readRpc(response);
  assert.equal(payload.result.isError, true);
  assert.equal(payload.result.structuredContent.error.kind, 'configuration');
  assert.equal(mock.calls.length, 0);
});
test('deadlines cancel the real SDK request', async () => {
  const fetch: FetchFunction = async (_url, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    assert.ok(signal);
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  // Keep the test event loop alive because AbortSignal.timeout uses an unref timer.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(createJevService({ ...env, JEV_TIMEOUT_MS: '1000' }, { fetch }).ask(example));
  } finally { clearInterval(keepAlive); }
});
test('REST uses the same protected pass-through service', async () => {
  const mock = standIn();
  const app = createApp(env, mock);
  assert.equal((await app.fetch(httpRequest(example, { path: '/v1/evaluate', authenticated: false }))).status, 401);
  const response = await app.fetch(httpRequest(example, { path: '/v1/evaluate' }));
  assert.equal(response.status, 200);
  assert.equal((await response.json() as any).answers.visible.probability, 0.9);
  assert.equal(mock.calls.length, 1);
});
test('simultaneous requests with identical RPC IDs do not share task state', async () => {
  const mock = standIn();
  const app = createApp(env, mock);
  const responses = await Promise.all(['task-A', 'task-B'].map((state) => app.fetch(httpRequest(rpc('tools/call', {
    name: 'jev_ask', arguments: { ...example, state },
  })))));
  for (const response of responses) assert.equal((await readRpc(response)).result.isError, undefined);
  assert.deepEqual(mock.calls.map((call) => call.body.state).sort(), ['task-A', 'task-B']);
});
test('liveness is public but reveals no configuration; responses are never cached', async () => {
  const app = createApp({});
  const response = await app.fetch(new Request('https://mcp.test/healthz'));
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await app.fetch(new Request('https://mcp.test/not-a-route'))).status, 404);
});
test('error sanitizer never trusts arbitrary error messages', () => {
  const result = safeError({ statusCode: 429, message: env.JEV_API_KEY, requestBodyValues: env });
  assert.equal(result.kind, 'rate_limit');
  assert.equal(result.retryable, true);
  assert.ok(!JSON.stringify(result).includes(env.JEV_API_KEY!));
});
