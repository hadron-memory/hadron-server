/**
 * Resolver-level behavior for the object store API (#745): the full CRUD +
 * query round-trip as a projection over the node substrate — flat objects,
 * hidden/auto loc + name, the natural `key`, reserved-key rejection, schema
 * conformance inherited from createNode, the atomic merge from
 * updateNodeProperties, soft delete, and findObjects' match/where/sort
 * desugaring with schema-inferred casts + the objectType facet.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = (): any => resolvers.Mutation as any;
const Q = (): any => resolvers.Query as any;

let adminId: string;
let orgId: string;
let memId: string;
const admin = (): Context => ({ db, roles: ['ADMIN'], userId: adminId } as Context);
const createObject = (input: Record<string, unknown>) => M().createObject(null, input, admin());
const updateObject = (input: Record<string, unknown>, c: Context = admin()) => M().updateObject(null, input, c);
const deleteObject = (input: Record<string, unknown>) => M().deleteObject(null, input, admin());
const getObject = (ref: string) => Q().object(null, { ref }, admin());
const findObjects = (input: Record<string, unknown>) => Q().findObjects(null, input, admin());
const setSchema = (schema: unknown) => M().updateMemory(null, { id: memId, schema }, admin());

const competitorSchema = {
  objectTypes: {
    competitor: {
      fields: {
        name: { type: 'text', required: true },
        stage: { type: 'text' },
        fundingUsd: { type: 'number' },
      },
    },
  },
};

beforeEach(async () => {
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'obj-org', graphName: 'obj/graph' });
  orgId = made.org.id;
  memId = made.graph.id;
  const a = await db.user.create({ data: { githubId: 7731, githubUsername: 'obj-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: a.id, role: 'ADMIN' } });
  adminId = a.id;
});

describe('createObject', () => {
  it('creates an object and returns the flat projection { id, type, ...fields }', async () => {
    const obj = await createObject({ memoryRef: memId, type: 'competitor', fields: { name: 'Letta', stage: 'seed' } });
    expect(obj).toMatchObject({ type: 'competitor', name: 'Letta', stage: 'seed' });
    expect(typeof obj.id).toBe('string');
    // Backed by a real node with objectType + properties + an auto-derived, hidden loc.
    const node = await db.node.findUnique({ where: { id: obj.id } });
    expect(node!.objectType).toBe('competitor');
    expect(node!.properties).toEqual({ name: 'Letta', stage: 'seed' });
    expect(node!.loc.startsWith('competitor:')).toBe(true);
    expect(node!.name).toBe('Letta'); // derived from the name field
  });

  it('uses a natural key for a human-meaningful loc', async () => {
    const obj = await createObject({ memoryRef: memId, type: 'competitor', fields: { name: 'Letta' }, key: 'letta' });
    const node = await db.node.findUnique({ where: { id: obj.id } });
    expect(node!.loc).toBe('competitor:letta');
  });

  it('rejects a reserved field name (id / type)', async () => {
    await expect(createObject({ memoryRef: memId, type: 'competitor', fields: { id: 'x', name: 'n' } }))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('requires a type', async () => {
    await expect(createObject({ memoryRef: memId, type: '', fields: { name: 'n' } }))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('rejects a colon in the natural key (no injected loc hierarchy)', async () => {
    await expect(createObject({ memoryRef: memId, type: 'competitor', fields: { name: 'n' }, key: 'a:b' }))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('enforces the memory schema (inherited from createNode)', async () => {
    await setSchema(competitorSchema);
    // Missing the required `name`.
    await expect(createObject({ memoryRef: memId, type: 'competitor', fields: { stage: 'seed' } }))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
});

describe('getObject / updateObject / deleteObject', () => {
  it('reads an object by id, null for unknown', async () => {
    const obj = await createObject({ memoryRef: memId, type: 'competitor', fields: { name: 'Letta' } });
    expect(await getObject(obj.id)).toMatchObject({ id: obj.id, type: 'competitor', name: 'Letta' });
    expect(await getObject(generateId())).toBeNull();
  });

  it('returns null for a non-object node (no objectType) — the store only surfaces collection records', async () => {
    const n = await db.node.create({ data: { id: generateId(), memoryId: memId, loc: 'plain:note', name: 'plain' } as any });
    expect(await getObject(n.id)).toBeNull();
  });

  it('merges fields (patch wins, unmentioned preserved) and returns the flat object', async () => {
    const obj = await createObject({ memoryRef: memId, type: 'competitor', fields: { name: 'Letta', stage: 'seed' } });
    const updated = await updateObject({ ref: obj.id, fields: { stage: 'series-a', fundingUsd: 10 } });
    expect(updated).toMatchObject({ id: obj.id, type: 'competitor', name: 'Letta', stage: 'series-a', fundingUsd: 10 });
  });

  it('updates distinct objects concurrently with a two-connection pool (#1279)', async () => {
    const objects = [];
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      objects.push(await createObject({ memoryRef: memId, type: 'competitor', fields: { name } }));
    }
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('connection_limit', '2');
    const limitedDb = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      const updated = await Promise.all(objects.map((object, stage) =>
        updateObject({ ref: object.id, fields: { stage } }, { ...admin(), db: limitedDb }),
      ));
      expect(updated.map((object: any) => object.stage)).toEqual([0, 1, 2]);
    } finally {
      await limitedDb.$disconnect();
    }
  });

  it('an object field named `exports` keeps the shallow merge (#1278 review: the #1227 merge-patch is node-only)', async () => {
    const obj = await createObject({ memoryRef: memId, type: 'competitor', fields: { name: 'Letta', exports: { old: 1 } } });
    const updated = await updateObject({ ref: obj.id, fields: { exports: { new: 1 } } });
    expect(updated.exports).toEqual({ new: 1 });
  });

  it('soft-deletes so a subsequent read returns null', async () => {
    const obj = await createObject({ memoryRef: memId, type: 'competitor', fields: { name: 'Letta' } });
    expect(await deleteObject({ ref: obj.id })).toBe(true);
    expect(await getObject(obj.id)).toBeNull();
  });
});

describe('findObjects', () => {
  beforeEach(async () => {
    await setSchema(competitorSchema);
    await createObject({ memoryRef: memId, type: 'competitor', fields: { name: 'Alpha', stage: 'seed', fundingUsd: 5 } });
    await createObject({ memoryRef: memId, type: 'competitor', fields: { name: 'Beta', stage: 'series-a', fundingUsd: 10 } });
    await createObject({ memoryRef: memId, type: 'competitor', fields: { name: 'Gamma', stage: 'series-a', fundingUsd: 2 } });
    // A different collection — must never appear in a competitor query. Inserted
    // directly (the schema only declares `competitor`, so createObject would
    // rightly reject an undeclared collection).
    await db.node.create({ data: { id: generateId(), memoryId: memId, loc: 'insight:noise', name: 'noise', objectType: 'insight', properties: { name: 'noise' } } as any });
  });

  it('scopes to the collection (objectType facet) and returns flat objects', async () => {
    const { objects } = await findObjects({ memoryRef: memId, type: 'competitor' });
    expect(objects.map((o: any) => o.name).sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(objects.every((o: any) => o.type === 'competitor')).toBe(true);
  });

  it('match: equality shorthand filters (schema-inferred casts)', async () => {
    const { objects } = await findObjects({ memoryRef: memId, type: 'competitor', match: { stage: 'series-a' } });
    expect(objects.map((o: any) => o.name).sort()).toEqual(['Beta', 'Gamma']);
  });

  it('sort: single-field shorthand with the schema-inferred number cast (not lexical)', async () => {
    const { objects } = await findObjects({ memoryRef: memId, type: 'competitor', sort: { fundingUsd: 'desc' } });
    // numeric desc: 10, 5, 2 — lexical would misorder.
    expect(objects.map((o: any) => o.name)).toEqual(['Beta', 'Alpha', 'Gamma']);
  });

  it('composes match + a full where predicate + sort (the payoff query)', async () => {
    const { objects } = await findObjects({
      memoryRef: memId,
      type: 'competitor',
      match: { stage: 'series-a' },
      where: { path: ['fundingUsd'], as: 'number', gte: 5 },
      sort: { fundingUsd: 'desc' },
    });
    // series-a AND funding>=5 → Beta(10) only (Gamma is 2).
    expect(objects.map((o: any) => o.name)).toEqual(['Beta']);
  });

  it('paginates', async () => {
    const page = await findObjects({ memoryRef: memId, type: 'competitor', sort: { fundingUsd: 'desc' }, limit: 1, offset: 1 });
    expect(page.objects.map((o: any) => o.name)).toEqual(['Alpha']);
  });
});

it('object counting does not enable totals for ordinary findNodes browse (#2514)', async () => {
  await createObject({ memoryRef: memId, type: 'competitor', fields: { name: 'A' } });
  const ordinary = await Q().findNodes(null, { filter: { memoryIds: [memId], objectType: 'competitor' } }, admin());
  expect(ordinary.total).toBeNull();
  const objects = await findObjects({ memoryRef: memId, type: 'competitor' });
  expect(objects.total).toBe(1);
});


it('conceals object totals from a caller outside the memory scope (#2514)', async () => {
  await createObject({ memoryRef: memId, type: 'competitor', fields: { name: 'Hidden' } });
  const outsider = await db.user.create({ data: { githubId: 7732, githubUsername: 'obj-outsider' } });
  const result = await Q().findObjects(null, { memoryRef: memId, type: 'competitor' },
    { db, roles: [], userId: outsider.id } as Context);
  expect(result).toMatchObject({ objects: [], total: 0 });
});
