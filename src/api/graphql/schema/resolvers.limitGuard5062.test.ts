/**
 * #5062 (S4a of #2213): a NEGATIVE `limit` on `nodeUsage`, `nodeEdgeRemovals` and `nodeRevisions` is an empty list, as in
 * `clampListTake`, `pageArgs` and every `<field>Page` sibling. Before, the value went to `take` as given and Prisma read a
 * negative `take` from the far end of the order, so `limit: -1` returned the OLDEST row.
 *
 * The gate says NO ceiling lands on any of the three (a cap needs client companions and, on nodeUsage, a `...Page` sibling,
 * cor:api:120:04), so `limit: 100000` still returns every row, and the default stays 20. Access answers are unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;
const ROWS = 205; // past the default of 20 and past the 200 a clamp would pick, so a ceiling would show
const adminCtx = (): Context => ({ db, roles: ['ADMIN'], userId: 'admin-user' }) as Context;

let nodeId: string;
let memoryId: string;
let nodeRef: string;
let outsiderId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'lg-org', urn: `lg-org-${generateId()}` } });
  const mem = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:mem`, name: 'mem', class: 'knowledge' } });
  memoryId = mem.id;
  const node = await db.node.create({ data: { id: generateId(), memoryId, loc: 'guide', name: 'Guide' } });
  nodeId = node.id;
  nodeRef = node.id;
  const t0 = Date.UTC(2026, 0, 1);
  const at = (i: number) => new Date(t0 + i * 1000); // strictly increasing, so "newest first" is index descending
  const idx = Array.from({ length: ROWS }, (_, i) => i);
  await db.nodeRevision.createMany({ data: idx.map((i) => ({ id: generateId(), nodeId, memoryId, loc: 'guide', name: `v${i}`, createdAt: at(i) })) });
  await db.nodeEdgeRemoval.createMany({
    data: idx.map((i) => ({
      id: generateId(), sourceId: nodeId, memoryId, edgeId: generateId(), edgeLoc: `e${i}`, targetId: generateId(),
      targetMemoryId: memoryId, targetLoc: `t${i}`, reason: 'TARGET_HARD_DELETED', createdAt: at(i),
    })),
  });
  await db.usageEvent.createMany({ data: idx.map((i) => ({ id: generateId(), type: 'read', nodeLoc: 'guide', nodeId, memoryId, createdAt: at(i) })) });
  outsiderId = (await db.user.create({ data: { githubId: 50621, githubUsername: 'lg-out', roles: ['READER'] } })).id;
});

const FIELDS: Array<[string, (limit?: number, ctx?: Context) => Promise<unknown[]>]> = [
  ['nodeUsage', (limit, ctx = adminCtx()) => Q.nodeUsage(null, { loc: 'guide', ...(limit === undefined ? {} : { limit }) }, ctx)],
  ['nodeEdgeRemovals', (limit, ctx = adminCtx()) => Q.nodeEdgeRemovals(null, { nodeRef, ...(limit === undefined ? {} : { limit }) }, ctx)],
  ['nodeRevisions', (limit, ctx = adminCtx()) => Q.nodeRevisions(null, { nodeRef, ...(limit === undefined ? {} : { limit }) }, ctx)],
];

describe.each(FIELDS)('%s limit guard (#5062)', (_name, run) => {
  it.each([-1, -5, -100000])('limit %i is an empty list (not the far end of the order)', async (limit) => {
    expect(await run(limit)).toEqual([]);
  });
  it('limit 0 is an empty list', async () => {
    expect(await run(0)).toEqual([]);
  });
  it('no ceiling lands: limit 100000 returns every row', async () => {
    expect(await run(100000)).toHaveLength(ROWS);
  });
  it('the default is 20, and an explicit 20 or smaller limit is honoured', async () => {
    expect(await run()).toHaveLength(20);
    expect(await run(20)).toHaveLength(20);
    expect(await run(7)).toHaveLength(7);
  });
  it('newest first, unchanged by the guard', async () => {
    const rows = (await run(3)) as Array<{ createdAt: Date }>;
    expect(rows.map((r) => r.createdAt.getTime())).toEqual([...rows.map((r) => r.createdAt.getTime())].sort((a, b) => b - a));
  });
  it('access unchanged: a caller who cannot read the memory gets an empty list, whatever the limit', async () => {
    const outsider = { db, roles: ['READER'], userId: outsiderId } as Context;
    expect(await run(undefined, outsider)).toEqual([]);
    expect(await run(-1, outsider)).toEqual([]);
    expect(await run(100000, outsider)).toEqual([]);
  });
});
