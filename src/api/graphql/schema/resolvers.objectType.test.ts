/**
 * #725 — Node.objectType (the collection discriminator): the write path persists
 * it, findNodes filters by it (browse + keyword), and clearing it (null) works.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const admin = (): Context => ({ db, roles: ['ADMIN'], userId: 'admin-ot' } as Context);
const createNode = (input: Record<string, unknown>) => (resolvers.Mutation as any).createNode(null, { input }, admin());
const updateNode = (input: Record<string, unknown>) => (resolvers.Mutation as any).updateNode(null, { input }, admin());
const findNodes = (args: Record<string, unknown>) => (resolvers.Query as any).findNodes(null, args, admin());
const locs = (res: any): string[] => res.hits.map((h: any) => h.node.loc).sort();

let memId: string;
beforeEach(async () => {
  await cleanDb(db);
  await db.user.create({ data: { id: 'admin-ot', roles: ['ADMIN'] } });
  const made = await createDbOrgAndGraph(db, { orgName: 'ot-org', graphName: 'ot/graph' });
  memId = made.graph.id;
});

describe('Node.objectType — collection discriminator', () => {
  it('createNode persists objectType (orthogonal to nodeType) and reads it back', async () => {
    const n = await createNode({ memoryId: memId, loc: 'c.letta', name: 'Letta', nodeType: 'record', objectType: 'competitor' });
    expect(n.objectType).toBe('competitor');
    expect(n.nodeType).toBe('record');
  });

  it('findNodes filters by objectType (browse)', async () => {
    await createNode({ memoryId: memId, loc: 'c.letta', name: 'Letta', objectType: 'competitor' });
    await createNode({ memoryId: memId, loc: 'c.mem0', name: 'Mem0', objectType: 'competitor' });
    await createNode({ memoryId: memId, loc: 'i.trend', name: 'Trend', objectType: 'insight' });
    await createNode({ memoryId: memId, loc: 'plain', name: 'Plain' }); // no objectType
    const res = await findNodes({ filter: { memoryIds: [memId], objectType: 'competitor' } });
    expect(locs(res)).toEqual(['c.letta', 'c.mem0']);
  });

  it('objectType composes with a keyword query (filter-then-rank)', async () => {
    await createNode({ memoryId: memId, loc: 'c.letta', name: 'Letta memory', objectType: 'competitor' });
    await createNode({ memoryId: memId, loc: 'i.memtrend', name: 'memory trend', objectType: 'insight' });
    const res = await findNodes({ query: 'memory', mode: 'keyword', filter: { memoryIds: [memId], objectType: 'competitor' } });
    expect(locs(res)).toEqual(['c.letta']);
  });

  it('updateNode objectType:null clears it', async () => {
    await createNode({ memoryId: memId, loc: 'c.x', name: 'X', objectType: 'competitor' });
    const upd = await updateNode({ memoryId: memId, loc: 'c.x', objectType: null });
    expect(upd.objectType).toBeNull();
    expect(locs(await findNodes({ filter: { memoryIds: [memId], objectType: 'competitor' } }))).toEqual([]);
  });

  it('updateNode preserves objectType when omitted', async () => {
    await createNode({ memoryId: memId, loc: 'c.y', name: 'Y', objectType: 'competitor' });
    await updateNode({ memoryId: memId, loc: 'c.y', description: 'touched' });
    const res = await findNodes({ filter: { memoryIds: [memId], objectType: 'competitor' } });
    expect(locs(res)).toEqual(['c.y']);
  });

  it('a node revision versions objectType, and restore recovers it', async () => {
    const n = await createNode({ memoryId: memId, loc: 'c.z', name: 'Z', objectType: 'competitor' });
    // Retype the collection — the pre-edit state is snapshotted.
    await updateNode({ memoryId: memId, loc: 'c.z', objectType: 'insight' });
    const rev = await db.nodeRevision.findFirst({ where: { nodeId: n.id }, orderBy: { revNo: 'desc' } });
    expect(rev?.objectType).toBe('competitor'); // captured, not lost
    await (resolvers.Mutation as any).restoreNodeRevision(null, { revisionId: rev!.id }, admin());
    // Back to the competitor collection.
    expect(locs(await findNodes({ filter: { memoryIds: [memId], objectType: 'competitor' } }))).toEqual(['c.z']);
  });
});
