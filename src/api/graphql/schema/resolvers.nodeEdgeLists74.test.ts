/**
 * hadron-internal#74 (cor:api:140:03, cor:acl:010:02): which edges `Node.incomingEdges` and `Node.outgoingEdges` list, through real
 * GraphQL execution. An edge is listed when the reader may read the memory that holds it and the memory of its far node.
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

const FIELDS = 'id urn loc name description data createdAt createdByUser { handle }';
const single = (id: string) => `{ node(ref: "${id}") { id incomingEdges { ${FIELDS} source { id } } outgoingEdges { ${FIELDS} target { id } } } }`;
const batch = (id: string) => `{ nodeBatch(refs: ["${id}"]) { items { node { id incomingEdges { ${FIELDS} source { id } } outgoingEdges { ${FIELDS} target { id } } } } } }`;
const context = (userId?: string, roles: Context['roles'] = []): Context => ({ db, userId, roles }) as Context;

type Listed = { incoming: string[]; outgoing: string[]; text: string };
async function list(nodeId: string, ctx: Context): Promise<Listed> {
  const r = await run(single(nodeId), ctx);
  expect(r.errors).toBeUndefined();
  const n = (r.data as any).node;
  return { incoming: n.incomingEdges.map((e: any) => e.name).sort(), outgoing: n.outgoingEdges.map((e: any) => e.name).sort(), text: JSON.stringify(r.data) };
}

let orgId: string, alice: string, member: string, owner: string, admin: string, outsider: string;
let shared: string, near: string, sibling: string;
const memory = (slug: string, data: Record<string, unknown>) =>
  db.memory.create({ data: { id: generateId(), name: slug, urn: `el74:${slug}`, vectorIndexEnabled: false, ...data } as never }).then((m) => m.id);
const edge = (name: string, memoryId: string, sourceId: string, targetId: string) =>
  db.edge.create({ data: { id: generateId(), loc: `far-loc:${name}`, name, memoryId, sourceId, targetId, description: 'FAR_DESCRIPTION', data: { note: 'FAR_DATA' }, createdBy: alice } as never });

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'el74', urn: 'el74' } })).id;
  const user = async (handle: string, role?: 'READER' | 'OWNER', roles: string[] = []) => {
    const u = await db.user.create({ data: { id: generateId(), handle, email: `${handle}@example.test`, roles: roles as never } });
    if (role) await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId: u.id, role } });
    return u.id;
  };
  alice = await user('el74-alice', 'READER');
  member = await user('el74-member', 'READER');
  owner = await user('el74-owner', 'OWNER');
  admin = await user('el74-admin', undefined, ['ADMIN']);
  outsider = await user('el74-outsider');
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

describe.each(SHAPES)('#74 a far node in a %s memory', (_shape, shape) => {
  let mem: string, far: string;
  beforeEach(async () => {
    mem = await memory('far-slug', shape());
    far = (await createDbNode(db, { loc: 'far-loc', memoryId: mem })).id;
    await edge('far-in', mem, far, near);
    await edge('far-out', shared, near, far);
  });

  it.each(READERS)('%s lists the same-memory edges only, in both directions', async (_reader, ctx) => {
    const got = await list(near, ctx());
    expect([got.incoming, got.outgoing]).toEqual([['same-in'], ['same-out']]);
    for (const text of ['far-slug', 'far-loc:far-in', 'far-loc:far-out', '"far-in"', '"far-out"']) expect(got.text).not.toContain(text);
  });

  it('a nodeBatch answers the same', async () => {
    const r = await run(batch(near), context(member));
    expect(r.errors).toBeUndefined();
    const n = (r.data as any).nodeBatch.items[0].node;
    expect([n.incomingEdges.map((e: any) => e.name), n.outgoingEdges.map((e: any) => e.name)]).toEqual([['same-in'], ['same-out']]);
  });

  it('a PUBLIC near node: an outsider and an anonymous reader list no far edge', async () => {
    await db.memory.update({ where: { id: shared }, data: { visibility: 'PUBLIC' } });
    for (const ctx of [context(outsider), context()]) {
      const got = await list(near, ctx);
      expect([got.incoming, got.outgoing]).toEqual([['same-in'], ['same-out']]);
    }
  });

  it('the memory\'s owner lists them all', async () => {
    const got = await list(near, context(alice));
    expect([got.incoming, got.outgoing]).toEqual([['far-in', 'same-in'], ['far-out', 'same-out']]);
  });

  it('a soft-deleted far node changes nothing', async () => {
    await db.node.update({ where: { id: far }, data: { deletedAt: new Date() } });
    const got = await list(near, context(member));
    expect([got.incoming, got.outgoing]).toEqual([['same-in'], ['same-out']]);
  });

  it('an edge it holds between two readable nodes is not listed', async () => {
    await edge('third', mem, sibling, near);
    expect((await list(near, context(member))).incoming).toEqual(['same-in']);
    expect((await list(sibling, context(member))).outgoing).toEqual(['same-in']);
  });
});

describe('#74 readable memories', () => {
  it('a cross-memory edge between two memories the reader may read is listed in both directions', async () => {
    const other = await memory('other', { organizationId: orgId, class: 'knowledge', visibility: 'ORGANIZATION' });
    const n = (await createDbNode(db, { loc: 'n', memoryId: other })).id;
    await edge('other-in', other, n, near);
    await edge('other-out', shared, near, n);
    for (const [, ctx] of READERS) {
      const got = await list(near, ctx());
      expect([got.incoming, got.outgoing]).toEqual([['other-in', 'same-in'], ['other-out', 'same-out']]);
    }
  });
});
