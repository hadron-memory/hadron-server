/**
 * hadron-internal#79 (cor:api:140:03, cor:acl:010:02): which edges `edge` and `edges` return, through real GraphQL execution. The rule is
 * the node lists' (resolvers.nodeEdgeLists74.test.ts): the reader may read the memory that holds the edge and the memory of each end.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbNode } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const schema = buildSchema(typeDefs);
async function run(source: string, ctx: Context) {
  return graphql({
    schema, source, contextValue: ctx,
    fieldResolver: (parent, args, context, info) => {
      const fields = resolvers[info.parentType.name as keyof typeof resolvers] as Record<string, Function> | undefined;
      const resolver = fields?.[info.fieldName];
      return typeof resolver === 'function' ? resolver(parent, args, context, info) : defaultFieldResolver(parent, args, context, info);
    },
  });
}

const FIELDS = 'id urn loc name description data createdAt createdByUser { handle } source { id } target { id }';
const context = (userId?: string, roles: Context['roles'] = []): Context => ({ db, userId, roles }) as Context;
async function page(filter: string, ctx: Context, args = ''): Promise<{ names: string[]; total: number; text: string }> {
  const r = await run(`{ edges(filter: { ${filter} }${args}) { total items { ${FIELDS} } } }`, ctx);
  expect(r.errors).toBeUndefined();
  const p = (r.data as any).edges;
  return { names: p.items.map((e: any) => e.name).sort(), total: p.total, text: JSON.stringify(r.data) };
}
async function one(ref: string, ctx: Context): Promise<any> {
  const r = await run(`{ edge(ref: "${ref}") { ${FIELDS} } }`, ctx);
  expect(r.errors).toBeUndefined();
  return (r.data as any).edge;
}

let orgId: string, alice: string, member: string, owner: string, admin: string, outsider: string;
let shared: string, near: string, sibling: string;
const memory = (slug: string, data: Record<string, unknown>) =>
  db.memory.create({ data: { id: generateId(), name: slug, urn: `er79:${slug}`, vectorIndexEnabled: false, ...data } as never }).then((m) => m.id);
const edge = (name: string, memoryId: string, sourceId: string, targetId: string) => {
  const plain = name.startsWith('same');
  return db.edge.create({ data: { id: generateId(), loc: plain ? `e:${name}` : `far-loc:${name}`, name, memoryId, sourceId, targetId, description: plain ? 'd' : 'FAR_DESCRIPTION', data: { note: plain ? 'n' : 'FAR_DATA' }, createdBy: alice } as never });
};

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'er79', urn: 'er79' } })).id;
  const user = async (handle: string, role?: 'READER' | 'OWNER', roles: string[] = []) => {
    const u = await db.user.create({ data: { id: generateId(), handle, email: `${handle}@example.test`, roles: roles as never } });
    if (role) await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId: u.id, role } });
    return u.id;
  };
  alice = await user('er79-alice', 'READER');
  member = await user('er79-member', 'READER');
  owner = await user('er79-owner', 'OWNER');
  admin = await user('er79-admin', undefined, ['ADMIN']);
  outsider = await user('er79-outsider');
  shared = await memory('shared', { organizationId: orgId, class: 'knowledge', visibility: 'ORGANIZATION' });
  near = (await createDbNode(db, { loc: 'near', memoryId: shared })).id;
  sibling = (await createDbNode(db, { loc: 'sibling', memoryId: shared })).id;
  await edge('same-in', shared, sibling, near);
  await edge('same-out', shared, near, sibling);
});

const READERS: Array<[string, () => Context]> = [
  ['an org member', () => context(member)],
  ['the org owner', () => context(owner)],
  ['a platform admin', () => context(admin, ['ADMIN'])],
];
const SHAPES: Array<[string, () => Record<string, unknown>]> = [
  ['personal, user-owned', () => ({ class: 'personal', userId: alice, ownerUserId: alice })],
  ['private, user-owned', () => ({ class: 'private', userId: alice, ownerUserId: alice })],
  ['personal, org-owned', () => ({ class: 'personal', userId: alice, organizationId: orgId })],
  ['private, org-owned', () => ({ class: 'private', userId: alice, organizationId: orgId })],
];

describe.each(SHAPES)('#79 a far node in a %s memory', (_shape, shape) => {
  let mem: string, far: string, farIn: string, farOut: string;
  beforeEach(async () => {
    mem = await memory('far-slug', shape());
    far = (await createDbNode(db, { loc: 'far-loc', memoryId: mem })).id;
    farIn = (await edge('far-in', mem, far, near)).id;
    farOut = (await edge('far-out', shared, near, far)).id;
  });
  const nothingFar = (text: string) => { for (const s of ['far-slug', 'far-loc', 'FAR_', 'far-in', 'far-out']) expect(text).not.toContain(s); };

  it.each(READERS)('%s: edges by source, by target and by memory, and edge by id', async (_reader, ctx) => {
    for (const [filter, names] of [[`sourceNodeId: "${near}"`, ['same-out']], [`targetNodeId: "${near}"`, ['same-in']], [`memoryId: "${shared}"`, ['same-in', 'same-out']]] as const) {
      const got = await page(filter, ctx());
      expect([filter, got.names, got.total]).toEqual([filter, names, names.length]);
      nothingFar(got.text);
    }
    expect(await one(farOut, ctx())).toBeNull();
    expect(await one(farIn, ctx())).toBeNull();
  });

  it.each(READERS)('%s: a far node as the filter answers as a missing one, by id and by URN', async (_reader, ctx) => {
    const urn = (await run(`{ node(ref: "${far}") { urn } }`, context(alice))).data as any;
    for (const ref of [far, urn.node.urn]) {
      for (const key of ['sourceNodeId', 'targetNodeId']) expect(await page(`${key}: "${ref}"`, ctx())).toMatchObject({ names: [], total: 0 });
    }
  });

  it('a PUBLIC near node: an outsider and an anonymous reader get no far edge', async () => {
    await db.memory.update({ where: { id: shared }, data: { visibility: 'PUBLIC' } });
    for (const ctx of [context(outsider), context()]) {
      const r = await run(`{ edges(filter: { sourceNodeId: "${near}" }) { total items { ${FIELDS} } } edge(ref: "${farOut}") { id } }`, ctx);
      nothingFar(JSON.stringify(r.data ?? {}));
      if (!r.errors) expect([(r.data as any).edges.items.map((e: any) => e.name).filter((n: string) => n.startsWith('far')), (r.data as any).edge]).toEqual([[], null]);
    }
  });

  it('the memory\'s owner gets them all', async () => {
    expect((await page(`sourceNodeId: "${near}"`, context(alice))).names).toEqual(['far-out', 'same-out']);
    expect((await page(`targetNodeId: "${near}"`, context(alice))).names).toEqual(['far-in', 'same-in']);
    expect((await page(`targetNodeId: "${far}"`, context(alice))).names).toEqual(['far-out']);
    expect((await one(farOut, context(alice))).id).toBe(farOut);
    expect((await one(farIn, context(alice))).id).toBe(farIn);
  });

  it('an edge it holds between two readable nodes, and a soft-deleted far node', async () => {
    const third = (await edge('third', mem, sibling, near)).id;
    expect((await page(`targetNodeId: "${near}"`, context(member))).names).toEqual(['same-in']);
    expect(await one(third, context(member))).toBeNull();
    await db.node.update({ where: { id: far }, data: { deletedAt: new Date() } });
    expect((await page(`sourceNodeId: "${near}"`, context(member))).names).toEqual(['same-out']);
    expect(await one(farOut, context(member))).toBeNull();
  });
});

describe('#79 readable memories', () => {
  it('cross-memory edges, and a soft-deleted end in a readable memory, are returned', async () => {
    const other = await memory('other', { organizationId: orgId, class: 'knowledge', visibility: 'ORGANIZATION' });
    const n = (await createDbNode(db, { loc: 'n', memoryId: other })).id;
    const out = (await edge('other-out', shared, near, n)).id;
    await edge('other-in', other, n, near);
    for (const [, ctx] of READERS) {
      expect((await page(`sourceNodeId: "${near}"`, ctx())).names).toEqual(['other-out', 'same-out']);
      expect((await page(`targetNodeId: "${n}"`, ctx())).names).toEqual(['other-out']);
      expect((await page(`sourceNodeId: "${n}"`, ctx())).names).toEqual(['other-in']);
      expect((await one(out, ctx())).target.id).toBe(n);
    }
    await db.node.update({ where: { id: n }, data: { deletedAt: new Date() } });
    const got = await one(out, context(member));
    expect([got.id, got.target]).toEqual([out, null]);
    expect((await page(`sourceNodeId: "${near}"`, context(member))).names).toEqual(['other-out', 'same-out']);
  });

  it('a page counts and pages returned edges only', async () => {
    const mem = await memory('far-slug', { class: 'private', userId: alice, ownerUserId: alice });
    for (let i = 0; i < 3; i += 1) await edge(`a-far-${i}`, shared, near, (await createDbNode(db, { loc: `far-loc-${i}`, memoryId: mem })).id);
    expect(await page(`memoryId: "${shared}"`, context(member), ', limit: 2')).toMatchObject({ names: ['same-in', 'same-out'], total: 2 });
  });
});
