import { Hono } from 'hono';
import { authorize, boundedBody, RequestFailure, type Environment } from './security.js';
import { createJevService, safeError, type FetchFunction } from './jev.js';
import { makeMcpHandler } from './mcp.js';

/** Factory permits fully offline wire-level tests; production has no user-selectable upstream. */
export function createApp(env: Environment = process.env, dependencies: { fetch?: FetchFunction } = {}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    await next();
  });
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/', (c) => c.json({ name: 'vercel-jev-mcp', transport: 'streamable-http', endpoint: '/mcp' }));

  const guarded = async (request: Request, rest = false): Promise<Response> => {
    try {
      authorize(request, env);
      if (request.method !== 'POST') {
        return Response.json({ error: 'Use POST. This stateless server has no SSE or session endpoint.' }, {
          status: 405, headers: { Allow: 'POST' },
        });
      }
      const body = await boundedBody(request);
      const service = createJevService(env, { ...dependencies, signal: request.signal });
      if (rest) {
        let input: unknown;
        try { input = JSON.parse(body); }
        catch { throw new RequestFailure(400, 'Invalid JSON.'); }
        try { return Response.json(await service.ask(input)); }
        catch (error) {
          const safe = safeError(error);
          const status = safe.kind === 'invalid_request' ? 400 : safe.kind === 'configuration' ? 503
            : safe.kind === 'rate_limit' ? 429 : safe.kind === 'timeout' ? 504 : 502;
          return Response.json({ error: safe }, { status });
        }
      }
      // Authorization never reaches AI Gateway; only the SDK's own credentials do.
      const headers = new Headers(request.headers);
      headers.delete('authorization');
      headers.delete('content-length');
      return await makeMcpHandler(service)(new Request(request.url, {
        method: 'POST', headers, body, signal: request.signal,
      }));
    } catch (error) {
      if (error instanceof RequestFailure) return Response.json({ error: error.message }, {
        status: error.status,
        headers: error.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="jev-mcp"' } : {},
      });
      // Avoid Hono's default exception logger printing an SDK error with sensitive data.
      return Response.json({ error: 'Request failed.' }, { status: 500 });
    }
  };
  app.all('/mcp', (c) => guarded(c.req.raw));
  app.all('/v1/evaluate', (c) => guarded(c.req.raw, true));
  app.notFound((c) => c.json({ error: 'Not found.' }, 404));
  app.onError(() => Response.json({ error: 'Request failed.' }, { status: 500 }));
  return app;
}

// Vercel's Hono preset discovers this default export. No listener or stdio process.
export default createApp();
