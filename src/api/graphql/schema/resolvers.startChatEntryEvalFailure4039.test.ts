/**
 * #4039 (cor:cht:020:02 step 6, Q16; gate B3): a condition the evaluator cannot evaluate refuses the start with
 * `ENTRY_CONDITION_FAILED` and a `chat-start.error.*` messageId; the scan never skips it and continues. The evaluator's
 * own failure cannot be reached through fixtures once B1 has refused a locked memory, so it is injected here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/edge-conditions/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/edge-conditions/index.js')>()),
  evaluateEdgeCondition: vi.fn(async () => ({
    ok: false as const,
    error: { code: 'TYPE_MISMATCH' as const, message: 'x', detail: { field: 'memory.age', operator: '<', memoryUrn: 'secret:urn', edgeId: 'secret-edge' } },
  })),
}));

const M = resolvers.Mutation as any;
let agentId: string;
let admin: { id: string };
const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: admin.id }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'org-4039e', urn: 'org-4039e' } });
  admin = await db.user.create({ data: { githubId: 40399, githubUsername: 'u4039e', roles: ['ADMIN'] as never } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const created = await M.createAgent({}, { orgId: org.id, name: 'eval-agent', visibility: 'ORGANIZATION' }, ctx());
  agentId = created.id;
  const rows = [
    { loc: 'conversations', data: null },
    { loc: 'conversations:a', data: { stageOrder: ['s'], entryCondition: { '<': [{ var: 'memory.age' }, 5] } }, seq: 1 },
    { loc: 'conversations:a:s', data: {}, content: 'p' },
    { loc: 'conversations:b', data: { stageOrder: ['s'] }, seq: 2 },
    { loc: 'conversations:b:s', data: {}, content: 'p' },
  ];
  for (const r of rows) {
    await db.node.create({ data: { id: generateId(), memoryId: created.systemMemoryId!, loc: r.loc, name: r.loc.split(':').pop()!, nodeType: 'system', data: r.data as never, content: (r as any).content ?? null, seq: (r as any).seq ?? null } });
  }
  await serveEveryAgent(db);
});

describe('#4039 an evaluator failure refuses the start', () => {
  it('TYPE_MISMATCH: refused with the type_mismatch messageId; the scan does not skip to the next conversation; no value, URN or edge id in the detail', async () => {
    const before = { memories: await db.memory.count(), nodes: await db.node.count() };
    const err = await M.startChat({}, { agentId }, ctx()).then(() => null, (e: any) => e);
    expect(err?.extensions).toMatchObject({
      code: 'ENTRY_CONDITION_FAILED', reason: 'TYPE_MISMATCH', messageId: 'chat-start.error.type_mismatch',
      detail: { conversation: 'a', field: 'memory.age', operator: '<' },
    });
    expect(Object.keys(err.extensions.detail).sort()).toEqual(['conversation', 'field', 'operator']);
    expect({ memories: await db.memory.count(), nodes: await db.node.count() }).toEqual(before);
  });
});
