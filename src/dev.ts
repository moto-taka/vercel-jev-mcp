import { serve } from '@hono/node-server';
import app from './index.js';

// Development only. Vercel uses src/index.ts, not this listener.
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 3000 }, () => {
  console.info('Jev MCP development endpoint: http://127.0.0.1:3000/mcp');
});
