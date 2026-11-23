/**
 * #2605 — the #1610 attribution suite (server.agentAttribution.test.ts), run again with `MCP_SERVING_MODE=sessionless`.
 *
 * Sessionless serving binds `X-Hadron-Session` and the `session` argument on every request (bindPresentedSession in
 * dispatchMcpSessionlessRequest). Its own suite (server.sessionless2605.test.ts) does not exercise a write attributed
 * that way, so a sessionless path that skipped the binding would pass there; this run catches it. The mode is read per
 * request, so setting it for this file's tests is enough; it is restored afterwards for the rest of the worker.
 */
import { afterAll, beforeAll, vi } from 'vitest';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const savedMode = process.env.MCP_SERVING_MODE;
beforeAll(() => { process.env.MCP_SERVING_MODE = 'sessionless'; });
afterAll(() => {
  if (savedMode === undefined) delete process.env.MCP_SERVING_MODE;
  else process.env.MCP_SERVING_MODE = savedMode;
});

await import('./server.agentAttribution.test.js');
