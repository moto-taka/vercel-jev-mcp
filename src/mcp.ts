import { createMcpHandler } from 'mcp-handler';
import { askSchema, classifySchema, scoreSchema, checkSchema } from './schemas.js';
import { safeError, type JevService } from './jev.js';

export function makeMcpHandler(service: JevService) {
  const run = async (input: unknown) => {
    try {
      const result = await service.ask(input);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const result = { error: safeError(error) };
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
    }
  };
  // A tool does no browser/computer mutation, but makes a paid, external API request.
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  return createMcpHandler((server) => {
    server.registerTool('jev_ask', {
      description: 'Evaluate 1..64 independent typed questions against one shared state using Jev. Prefer one batched call. Returns native Gateway answers and probability distributions; no prose, automatic filtering, or decisions about executing actions. State is sent to Vercel AI Gateway and TypeSafe.',
      inputSchema: askSchema, annotations,
    }, (input) => run(input));
    server.registerTool('jev_classify', {
      description: 'Choose from the exact supplied criteria using Jev. No none option is added. The answer is under answers.result. Use jev_ask to batch questions.',
      inputSchema: classifySchema, annotations,
    }, ({ state, ...question }) => run({ state, questions: { result: { type: 'choice', ...question } } }));
    server.registerTool('jev_score', {
      description: 'Score against 2..10 ordered criteria, lowest to highest. Returns the interpolated score and probabilities under answers.result. No confidence threshold is applied.',
      inputSchema: scoreSchema, annotations,
    }, ({ state, ...question }) => run({ state, questions: { result: { type: 'score', ...question } } }));
    server.registerTool('jev_check', {
      description: 'Return the probability that a proposition holds. Gateway calls the Jev Noul primitive boolean. No yes/no cutoff is applied. The answer is under answers.result.',
      inputSchema: checkSchema, annotations,
    }, ({ state, ...question }) => run({ state, questions: { result: { type: 'boolean', ...question } } }));
  }, {
    serverInfo: { name: 'vercel-jev-mcp', version: '1.0.0' },
    instructions: 'Use jev_ask for independent questions about the same state. Question IDs are output keys, not instructions; put the complete question in instructions. Treat probabilities as model judgments, not proof. Do not send credentials in state. This server neither generates prose nor operates a browser.',
    verboseLogs: false,
    maxSubscriptions: 0,
  });
}
