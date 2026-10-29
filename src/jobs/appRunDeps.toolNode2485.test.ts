/**
 * #2485: the production tool loop hands each tool the flow node its hop executes. Tools that take
 * their reach from that node (github_issue_snapshot reads `data.github.repositories`) fail closed
 * without it, so a dropped hand-off would read as a broken tool rather than a wider one; this pins
 * the hand-off itself.
 */

import { describe, it, expect, vi } from 'vitest';
import type { AppRun } from '../generated/prisma/index.js';

const captured: Array<{ nodeUrn?: string }> = [];
vi.mock('../lib/llm/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/llm/index.js')>();
  return {
    ...real,
    generateWithTools: vi.fn(async (_resolved: unknown, _req: unknown, _tools: unknown, opts: { toolCtx: { nodeUrn?: string } }) => {
      captured.push({ nodeUrn: opts.toolCtx.nodeUrn });
      return { text: 'ok', tokensIn: 0, tokensOut: 0, provider: 'anthropic', model: 'test', toolCalls: [] };
    }),
  };
});

describe('makeProdRunDeps().llmTools (#2485)', () => {
  it('passes the hop\'s flow node into the tool context', async () => {
    const { db } = await import('../integrations/db/client.js');
    const { makeProdRunDeps } = await import('./appRunDeps.js');
    const deps = makeProdRunDeps(db);
    const run = { id: 'r1', organizationId: 'o1', appId: 'a1', userId: null } as unknown as AppRun;
    await deps.llmTools(run, {} as never, { prompt: 'x' }, ['hadron_log'], {
      onToolCall: async () => true,
      log: () => {},
      nodeUrn: 'org::flows::flow:report',
    });
    expect(captured).toEqual([{ nodeUrn: 'org::flows::flow:report' }]);
  });
});
