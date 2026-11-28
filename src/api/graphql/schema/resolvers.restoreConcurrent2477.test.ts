/** #2477 — concurrent atomic restores must not expose a raw unique violation on a missing loc. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { sessionMutations } from './resolvers.mutation.session.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const M = resolvers.Mutation;
afterEach(() => vi.restoreAllMocks());
let context: Context;
let agentId: string;
let memoryId: string;
let revisionLoc: string;
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Restore concurrency', urn: 'restore-2477.example' } });
  const user = await db.user.create({ data: { githubId: 2477001, githubUsername: 'restore-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  context = { db, userId: user.id, roles: ['ADMIN'] };
  const agent = await M.createAgent({}, { orgRef: org.id, name: 'Restore concurrency', visibility: 'PERSONAL' }, context);
  agentId = agent.id;
  memoryId = agent.systemMemoryId!;
  // #3833: createAgent now seeds skeleton parents. This fixture models a two-node graph (alpha, beta), and the seeded rows
  // would be row-locked by the first restore while it waits at the barrier, so start from an empty memory.
  await db.node.deleteMany({ where: { memoryId } });
  const source = await db.node.create({ data: { id: generateId(), memoryId, loc: 'alpha', name: 'Alpha', nodeType: 'system', content: 'snapshot alpha' } });
  const target = await db.node.create({ data: { id: generateId(), memoryId, loc: 'beta', name: 'Beta', nodeType: 'system', content: 'snapshot beta' } });
  await db.edge.create({ data: { id: generateId(), memoryId, loc: 'alpha:link:beta', name: 'link', sourceId: source.id, targetId: target.id } });
  const revision = await M.createRevision({}, { agentRef: agentId, description: 'two-node graph' }, context);
  revisionLoc = revision.revisionLoc;
  await db.edge.deleteMany({ where: { memoryId } });
  await db.node.deleteMany({ where: { memoryId, loc: { in: ['alpha', 'beta'] } } });
});

describe('#2477 missing-loc concurrent restore', () => {
  // #3587: the auto-save is written inside the restore's transaction, behind the memory key and the advisory set, so
  // the old out-of-transaction barrier no longer exists. The contract is unchanged: two concurrent restores over a
  // graph whose rows are missing both succeed, restore it once, and each leaves its own auto-save in a distinct slot.
  it('two concurrent restores of missing locs both succeed, with distinct auto-save slots', async () => {
    expect(await db.node.count({ where: { memoryId, loc: { in: ['alpha', 'beta'] } } })).toBe(0);
    const before = await db.node.count({ where: { memoryId, loc: { startsWith: 'revisions:rev-' } } });
    const results = await Promise.allSettled([0, 1].map(() => M.restoreRevision({}, { agentRef: agentId, revisionLoc }, context)).flat());
    expect(results.map((r) => r.status), JSON.stringify(results.map((r) => (r as any).reason?.message))).toEqual(['fulfilled', 'fulfilled']);
    expect(await db.node.findMany({ where: { memoryId, deletedAt: null, loc: { in: ['alpha', 'beta'] } }, select: { loc: true, content: true }, orderBy: { loc: 'asc' } }))
      .toEqual([{ loc: 'alpha', content: 'snapshot alpha' }, { loc: 'beta', content: 'snapshot beta' }]);
    const edges = await db.edge.findMany({ where: { memoryId, loc: 'alpha:link:beta', deletedAt: null }, include: { source: true, target: true } });
    expect(edges).toHaveLength(1);
    expect(edges[0].source.loc).toBe('alpha');
    expect(edges[0].target.loc).toBe('beta');
    const slots = await db.node.findMany({ where: { memoryId, loc: { startsWith: 'revisions:rev-' } }, select: { loc: true } });
    expect(slots).toHaveLength(before + 2);
    expect(new Set(slots.map((r) => r.loc)).size).toBe(before + 2);
  }, 20_000);
});
