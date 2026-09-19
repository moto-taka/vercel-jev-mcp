import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from '../src/index.js';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/smoke.mjs', import.meta.url));

for (const live of [false, true]) {
  test(`smoke script over a real HTTP socket (${live ? 'mocked evaluation' : 'no inference'})`, async () => {
    const token = 'socket-test-only-'.repeat(4);
    let calls = 0;
    const app = createApp({
      MCP_BEARER_TOKEN: token,
      JEV_API_KEY: 'test-jev-key', AI_GATEWAY_API_KEY: 'test-gateway-key',
    }, {
      fetch: async () => {
        calls++;
        return Response.json({ answers: { result: { type: 'boolean', probability: 0.99 } }, warnings: [] });
      },
    });
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
      const { stdout } = await exec(process.execPath, [script, ...(live ? ['--live'] : [])], {
        env: { ...process.env, JEV_MCP_URL: `http://127.0.0.1:${address.port}/mcp`, JEV_MCP_TOKEN: token },
        timeout: 20_000,
      });
      assert.match(stdout, /PASS: Bearer required/);
      assert.equal(calls, live ? 1 : 0);
      assert.ok(!stdout.includes(token));
      if (live) assert.match(stdout, /PASS: live Gateway evaluation/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}
