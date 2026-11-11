/** #3580 — pins on cor:api:190:03 "What It Returns": the whole subtree, in loc order, even at the same slot. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph, createDbNode } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;
let memory: { id: string; urn: string };
let userId: string;
const context = (): Context => ({ db, userId, roles: ['ADMIN'] });
const urn = (loc: string) => `hrn:node:${memory.urn.replace(/^hrn:mem:/, '')}:${loc}`;
beforeEach(async () => {
  await cleanDb(db);
  userId = (await db.user.create({ data: { githubId: 3580, githubUsername: 'plan3580', roles: ['ADMIN'] } })).id;
  memory = (await createDbOrgAndGraph(db, { orgName: 'plan3580', graphName: 'plan', visibility: 'PUBLIC' })).graph;
});

describe('planNodeMove subtree pins #3580', () => {
  it('same-slot plan lists the root and EVERY descendant, not only the root, and excludes siblings', async () => {
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a' });
    const c1 = await createDbNode(db, { memoryId: memory.id, loc: 'a:b' });
    const c2 = await createDbNode(db, { memoryId: memory.id, loc: 'a:b:c' });
    const c3 = await createDbNode(db, { memoryId: memory.id, loc: 'a:d' });
    await createDbNode(db, { memoryId: memory.id, loc: 'ab' }); // shares the prefix text, not the subtree
    const plan = await M.planNodeMove(null, { sourceRef: root.id, targetUrn: urn('a') }, context());
    expect(plan.nodes.map((n: any) => n.id)).toEqual([root.id, c1.id, c2.id, c3.id]);
    expect(plan.nodes.map((n: any) => [n.currentUrn, n.newUrn])).toEqual(
      ['a', 'a:b', 'a:b:c', 'a:d'].map(l => [urn(l), urn(l)]));
    expect(plan.totalCount).toBe(4);
    expect(plan.truncated).toBe(false);
  });

  it('same-slot truncation reports the full subtree count, not the root alone', async () => {
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a' });
    await createDbNode(db, { memoryId: memory.id, loc: 'a:b' });
    await createDbNode(db, { memoryId: memory.id, loc: 'a:c' });
    const plan = await M.planNodeMove(null, { sourceRef: root.id, targetUrn: urn('a'), limit: 2 }, context());
    expect(plan.nodes).toHaveLength(2);
    expect(plan.totalCount).toBe(3);
    expect(plan.truncated).toBe(true);
  });

  it.each([['same slot', 'a'], ['rebased', 'z']])('lists %s in loc order whatever the row creation order', async (_n, target) => {
    // Created out of loc order, so the storage order differs from the loc order.
    const c2 = await createDbNode(db, { memoryId: memory.id, loc: 'a:c' });
    const c3 = await createDbNode(db, { memoryId: memory.id, loc: 'a:b:z' });
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a' });
    const c1 = await createDbNode(db, { memoryId: memory.id, loc: 'a:b' });
    const plan = await M.planNodeMove(null, { sourceRef: root.id, targetUrn: urn(target) }, context());
    expect(plan.nodes.map((n: any) => n.id)).toEqual([root.id, c1.id, c3.id, c2.id]);
    expect(plan.nodes.map((n: any) => n.currentUrn)).toEqual(['a', 'a:b', 'a:b:z', 'a:c'].map(urn));
  });

  it('keeps loc order under truncation: the first nodes of the order are the ones returned', async () => {
    const c2 = await createDbNode(db, { memoryId: memory.id, loc: 'a:c' });
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a' });
    const c1 = await createDbNode(db, { memoryId: memory.id, loc: 'a:b' });
    const plan = await M.planNodeMove(null, { sourceRef: root.id, targetUrn: urn('z'), limit: 2 }, context());
    expect(plan.nodes.map((n: any) => n.id)).toEqual([root.id, c1.id]);
    expect(plan.nodes.map((n: any) => n.id)).not.toContain(c2.id);
    expect(plan.totalCount).toBe(3);
    expect(plan.truncated).toBe(true);
  });
});

describe('planNodeMove loc order is the code-unit order #3580', () => {
  it.each([['same slot', 'a'], ['rebased', 'z']])('%s: an upper-case atom sorts before a lower-case one', async (_n, target) => {
    const lower = await createDbNode(db, { memoryId: memory.id, loc: 'a:a' });
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a' });
    const upper = await createDbNode(db, { memoryId: memory.id, loc: 'a:B' });
    const plan = await M.planNodeMove(null, { sourceRef: root.id, targetUrn: urn(target) }, context());
    expect(plan.nodes.map((n: any) => n.id)).toEqual([root.id, upper.id, lower.id]);
  });
});
