/**
 * #3113 — `hadron_find_nodes` takes `nodeTypes` and hands it to the same
 * resolver; its refusals use the shared validator and run before any scope
 * resolution or early return. (createTestableMcpServer bypasses zod, so the
 * malformed-element case is the validator's, not the schema's; the real
 * transport boundary is QA's.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let memUrn: string;
let mcp: ReturnType<typeof createTestableMcpServer>;

beforeEach(async () => {
  await cleanDb(db);
  const { graph } = await createDbOrgAndGraph(db, { orgName: 'nt-mcp-org', graphName: 'nt/mcp' });
  for (const [loc, nodeType] of [['m.info', 'info'], ['m.task', 'task'], ['m.widget', 'widget'], ['m.system', 'system']] as const) {
    await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc, name: `mcpmarker ${loc}`, content: `mcpmarker ${loc}`, nodeType } as any });
  }
  const mem = await db.memory.findUniqueOrThrow({ where: { id: graph.id } });
  memUrn = mem.urn.startsWith('hrn:') ? mem.urn : `hrn:mem:${mem.urn}`;
  const user = await db.user.create({ data: { githubId: 311303, githubUsername: 'nt-mcp-admin', handle: 'nt-mcp-admin', roles: [] } });
  mcp = createTestableMcpServer({ userId: user.id, roles: ['ADMIN'], clientId: `user:${user.id}` });
});

const find = (args: Record<string, unknown>) => mcp.callToolText('hadron_find_nodes', { memoryUrn: memUrn, ...args });

describe('hadron_find_nodes nodeTypes (#3113)', () => {
  it('narrows to the listed types in survey and keyword mode, and a system type lifts only the type default', async () => {
    const survey = await find({ query: '*', nodeTypes: ['task', 'widget'] });
    expect(survey).toContain('m.task');
    expect(survey).toContain('m.widget');
    expect(survey).not.toContain('m.info');
    const keyword = await find({ query: 'mcpmarker', nodeTypes: ['system', 'task'] });
    expect(keyword).toContain('m.system');
    expect(keyword).toContain('m.task');
    expect(keyword).not.toContain('m.widget');
    expect(await find({ query: 'mcpmarker', nodeTypes: ['nope'] })).not.toContain('m.');
  });

  it('refuses [], both fields, over 20 and comment, naming the field and echoing no value', async () => {
    for (const args of [
      { nodeTypes: [] },
      { nodeType: 'task', nodeTypes: ['task'] },
      { nodeType: '', nodeTypes: ['task'] },
      { nodeTypes: Array.from({ length: 21 }, () => 'task') },
      { nodeTypes: ['secret-type-xyz', 'comment'] },
      { nodeTypes: ['comment'], nodeKind: 'ALL' },
      { nodeTypes: [5 as unknown as string] },
    ]) {
      const out = await find({ query: 'mcpmarker', ...args });
      expect(out, JSON.stringify(args)).toContain('nodeTypes');
      expect(out).not.toContain('secret-type-xyz');
      expect(out).not.toContain('m.');
    }
  });

  it('refuses before the scope and early-return paths: unreadable memory, vector survey, chunk without vector', async () => {
    const unreadable = await find({ memoryUrn: 'hrn:mem:nope.example:missing', query: 'x', nodeTypes: [] });
    expect(unreadable).toContain('nodeTypes');
    const survey = await find({ query: '*', mode: 'vector', nodeTypes: [] });
    expect(survey).toContain('nodeTypes');
    const chunk = await find({ query: 'x', granularity: 'chunk', nodeTypes: [] });
    expect(chunk).toContain('nodeTypes');
  });

  it('the singular nodeType is unchanged', async () => {
    expect(await find({ query: '*', nodeType: 'task' })).toContain('m.task');
  });
});
