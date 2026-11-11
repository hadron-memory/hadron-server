/** #3868 — cor:api:190:03 "the plan is true when it is answered": memory URNs come from the plan's own snapshot. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph, createDbNode } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;
let src: { id: string; urn: string };
let dest: { id: string; urn: string };
let userId: string;
const nodeUrn = (memUrn: string, loc: string) => `hrn:node:${memUrn.replace(/^hrn:mem:/, '')}:${loc}`;

/** A db whose first $transaction renames both memories right AFTER it commits: the window between the plan snapshot and the response. */
function renamingDb(): Context['db'] {
  let done = false;
  return new Proxy(db as any, {
    get(target, prop, receiver) {
      if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
      return async (...args: unknown[]) => {
        const out = await (target.$transaction as any)(...args);
        if (!done) {
          done = true;
          for (const m of [src, dest]) await db.memory.update({ where: { id: m.id }, data: { urn: `${m.urn}-renamed` } });
        }
        return out;
      };
    },
  }) as Context['db'];
}

beforeEach(async () => {
  await cleanDb(db);
  userId = (await db.user.create({ data: { githubId: 3868, githubUsername: 'plan3868', roles: ['ADMIN'] } })).id;
  src = (await createDbOrgAndGraph(db, { orgName: 'plan3868', graphName: 'src', visibility: 'PUBLIC' })).graph;
  dest = (await createDbOrgAndGraph(db, { orgName: 'plan3868b', graphName: 'dst', visibility: 'PUBLIC' })).graph;
});

describe('planNodeMove memory URNs are one snapshot #3868', () => {
  it('a rename landing after the plan transaction does not leak into the plan', async () => {
    const root = await createDbNode(db, { memoryId: src.id, loc: 'a' });
    await createDbNode(db, { memoryId: src.id, loc: 'a:b' });
    const plan = await M.planNodeMove(null, { sourceRef: root.id, targetUrn: nodeUrn(dest.urn, 'z') },
      { db: renamingDb(), userId, roles: ['ADMIN'] } as Context);
    expect(plan.pointInTime).toBe(true);
    expect(plan.nodes.map((n: any) => [n.currentUrn, n.newUrn])).toEqual([
      [nodeUrn(src.urn, 'a'), nodeUrn(dest.urn, 'z')],
      [nodeUrn(src.urn, 'a:b'), nodeUrn(dest.urn, 'z:b')],
    ]);
  });

  it('the plan still writes nothing', async () => {
    const root = await createDbNode(db, { memoryId: src.id, loc: 'a' });
    const before = await db.node.findMany({ orderBy: { id: 'asc' } });
    await M.planNodeMove(null, { sourceRef: root.id, targetUrn: nodeUrn(dest.urn, 'z') },
      { db, userId, roles: ['ADMIN'] } as Context);
    expect(await db.node.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });
});
