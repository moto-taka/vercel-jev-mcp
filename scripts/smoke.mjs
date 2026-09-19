// No dependencies. Default checks connectivity only; --live makes ONE billable evaluation.
const endpoint = process.env.JEV_MCP_URL;
const token = process.env.JEV_MCP_TOKEN;
if (!endpoint || !token) throw new Error('Set JEV_MCP_URL (ending in /mcp) and JEV_MCP_TOKEN.');
const url = new URL(endpoint);
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
  throw new Error('Use HTTPS except for a local development server.');
}
if (url.username || url.password || url.search || url.hash) throw new Error('Use a clean MCP endpoint URL.');
async function rpc(method, params, authenticated = true) {
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!authenticated) {
    if (response.status !== 401) throw new Error(`Expected 401 without a token; got HTTP ${response.status}.`);
    await response.body?.cancel();
    return;
  }
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}. Check URL, deployment protection, and Bearer token.`);
  const text = await response.text();
  let data;
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const messages = text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean);
    data = JSON.parse(messages.at(-1) ?? '{}');
  } else data = JSON.parse(text);
  if (data.error || data.result?.isError) throw new Error('MCP returned an error. Inspect server configuration; no secrets were printed.');
  if (!data.result) throw new Error('MCP response is missing result.');
  return data.result;
}
await rpc('tools/list', {}, false);
const initialized = await rpc('initialize', {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jev-smoke', version: '1.0.0' },
});
const listed = await rpc('tools/list', {});
const names = listed.tools.map((tool) => tool.name);
for (const name of ['jev_ask', 'jev_classify', 'jev_score', 'jev_check']) {
  if (!names.includes(name)) throw new Error(`Missing tool: ${name}`);
}
console.log(`PASS: Bearer required; connected to ${initialized.serverInfo.name}; all four tools are available.`);
if (process.argv.includes('--live')) {
  const result = await rpc('tools/call', { name: 'jev_check', arguments: {
    state: 'The button labelled Save is visible.', instructions: 'Is the Save button visible?',
  } });
  const output = result.structuredContent ?? JSON.parse(result.content.find((item) => item.type === 'text').text);
  const answer = output.answers?.result;
  if (answer?.type !== 'boolean' || typeof answer.probability !== 'number') throw new Error('Unexpected evaluation shape.');
  console.log('PASS: live Gateway evaluation.', JSON.stringify(output));
} else console.log('No Jev evaluation was made. Pass --live to validate provider credentials with one paid request.');
