/** cor:api:190:03 — a plan uses the move's checks without performing its writes. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph, createDbNode } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;
let memory: { id: string; urn: string };
const context = (): Context => ({ db, roles: ['ADMIN'] });
beforeEach(async () => {
  await cleanDb(db);
  memory = (await createDbOrgAndGraph(db, { orgName: 'plan3424', graphName: 'plan', visibility: 'PUBLIC' })).graph;
});
describe('planNodeMove #3424', () => {
  it('lists stable IDs and rebased URNs in loc order without changing rows or revisions', async () => {
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a' });
    const child = await createDbNode(db, { memoryId: memory.id, loc: 'a:b' });
    const before = await db.node.findMany({ where: { memoryId: memory.id }, orderBy: { id: 'asc' } });
    const revisions = await db.nodeRevision.count();
    const plan = await M.planNodeMove(null, { sourceRef: root.id, targetUrn: `hrn:node:${memory.urn.replace(/^hrn:mem:/, '')}:z` }, context());
    expect(plan.nodes).toEqual([
      { id: root.id, currentUrn: `hrn:node:${memory.urn.replace(/^hrn:mem:/, '')}:a`, newUrn: `hrn:node:${memory.urn.replace(/^hrn:mem:/, '')}:z` },
      { id: child.id, currentUrn: `hrn:node:${memory.urn.replace(/^hrn:mem:/, '')}:a:b`, newUrn: `hrn:node:${memory.urn.replace(/^hrn:mem:/, '')}:z:b` },
    ]);
    expect(plan.totalCount).toBe(2);
    expect(plan.truncated).toBe(false);
    expect(plan.pointInTime).toBe(true);
    expect(await db.node.findMany({ where: { memoryId: memory.id }, orderBy: { id: 'asc' } })).toEqual(before);
    expect(await db.nodeRevision.count()).toBe(revisions);
    await M.moveNode(null, { sourceRef: root.id, targetUrn: plan.nodes[0].newUrn }, context());
    expect((await db.node.findUniqueOrThrow({ where: { id: child.id } })).loc).toBe('z:b');
  });
  it('discloses a bounded result with the full count', async () => {
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a' });
    await createDbNode(db, { memoryId: memory.id, loc: 'a:b' });
    const plan = await M.planNodeMove(null, { sourceRef: root.id, targetUrn: `hrn:node:${memory.urn.replace(/^hrn:mem:/, '')}:z`, limit: 1 }, context());
    expect(plan.nodes).toHaveLength(1);
    expect(plan.totalCount).toBe(2);
    expect(plan.truncated).toBe(true);
  });
  it.each(['a:b', 'taken'])('raises the real move refusal for %s without revisions', async target => {
    const root = await createDbNode(db, { memoryId: memory.id, loc: 'a' });
    await createDbNode(db, { memoryId: memory.id, loc: 'taken' });
    const args = { sourceRef: root.id, targetUrn: `hrn:node:${memory.urn.replace(/^hrn:mem:/, '')}:${target}` };
    const revisions = await db.nodeRevision.count();
    const moveError = await M.moveNode(null, args, context()).catch((e: unknown) => e);
    await expect(M.planNodeMove(null, args, context())).rejects.toMatchObject({ message: moveError.message, extensions: moveError.extensions });
    expect(await db.nodeRevision.count()).toBe(revisions);
  });
});
