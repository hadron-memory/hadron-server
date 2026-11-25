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
import { batchReadEdges, markAdmittedMemories } from './resolvers.nodeBatchEdges.js';
import { BATCH_READ_MAX_EDGES } from '../../../lib/batchRead.js';
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
const batch = (id: string) => `{ nodeBatch(refs: ["${id}"]) { nodes { id incomingEdges { ${FIELDS} source { id } } outgoingEdges { ${FIELDS} target { id } } } } }`;
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
    const n = (r.data as any).nodeBatch.nodes[0];
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
    const r = await run(batch(near), context(member));
    expect((r.data as any).nodeBatch.nodes[0].incomingEdges.map((e: any) => e.name)).toEqual(['same-in']);
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

describe('#74 a capped read and an App scope', () => {
  it('a nodeBatch counts listed edges only', async () => {
    const mem = await memory('far-slug', { class: 'private', userId: alice, ownerUserId: alice });
    const far = (await createDbNode(db, { loc: 'far-loc', memoryId: mem })).id;
    await db.edge.createMany({ data: Array.from({ length: BATCH_READ_MAX_EDGES + 1 }, (_, i) =>
      ({ id: generateId(), loc: `far-loc:cap-${i}`, name: `cap-${i}`, memoryId: mem, sourceId: far, targetId: near })) as never });
    const r = await run(batch(near), context(member));
    expect(r.errors).toBeUndefined();
    expect((r.data as any).nodeBatch.nodes[0].incomingEdges.map((e: any) => e.name)).toEqual(['same-in']);
  });

  it('an unloaded far node that is soft-deleted is judged by its memory', async () => {
    const mem = await memory('far-slug', { class: 'private', userId: alice, ownerUserId: alice });
    const far = (await createDbNode(db, { loc: 'far-loc', memoryId: mem })).id;
    await edge('far-out', shared, near, far);
    await db.node.updateMany({ where: { id: { in: [far, sibling] } }, data: { deletedAt: new Date() } });
    const n = await db.node.findUniqueOrThrow({ where: { id: near }, include: { outgoingEdges: true } });
    expect(((await batchReadEdges(n as never, context(member), 'out')) as Array<{ name: string }>).map((e) => e.name)).toEqual(['same-out']);
  });

  it('a memory the read admitted is listed, and no other', async () => {
    const admitted = await memory('admitted', { class: 'private', userId: alice, ownerUserId: alice });
    const other = await memory('other-far', { class: 'private', userId: alice, ownerUserId: alice });
    const a = (await createDbNode(db, { loc: 'a', memoryId: admitted })).id;
    const o = (await createDbNode(db, { loc: 'o', memoryId: other })).id;
    await edge('admitted-out', shared, near, a);
    await edge('other-out', shared, near, o);
    const load = () => db.node.findUniqueOrThrow({ where: { id: near }, include: { outgoingEdges: { include: { target: true } } } });
    const names = async (n: object) => ((await batchReadEdges(n as never, context(member), 'out')) as Array<{ name: string }>).map((e) => e.name).sort();
    expect(await names(await load())).toEqual(['same-out']);
    const marked = await load();
    markAdmittedMemories([marked], new Set([admitted]));
    expect(await names(marked)).toEqual(['admitted-out', 'same-out']);
  });

  it('a far node that was not loaded with the edge is judged too', async () => {
    const mem = await memory('far-slug', { class: 'private', userId: alice, ownerUserId: alice });
    const far = (await createDbNode(db, { loc: 'far-loc', memoryId: mem })).id;
    await edge('far-out', shared, near, far);
    const n = await db.node.findUniqueOrThrow({ where: { id: near }, include: { outgoingEdges: true } });
    expect(((await batchReadEdges(n as never, context(member), 'out')) as Array<{ name: string }>).map((e) => e.name)).toEqual(['same-out']);
  });

  it('a node another gate returned keeps its same-memory edges', async () => {
    const n = await db.node.findUniqueOrThrow({ where: { id: near }, include: { outgoingEdges: { include: { target: true } } } });
    expect(((await batchReadEdges(n as never, context(outsider), 'out')) as Array<{ name: string }>).map((e) => e.name)).toEqual(['same-out']);
  });

  it('appNodes lists an edge between two memories of its App scope, and none to a base in scope through a child only', async () => {
    const agent = async (name: string, extendsAgentId?: string) => {
      const mem = await memory(name, { organizationId: orgId, class: 'system' });
      const row = await db.agent.create({ data: { organizationId: orgId, name, urn: `el74:${name}`, visibility: 'ORGANIZATION', systemMemoryId: mem, extendsAgentId } as never });
      return { id: row.id, mem };
    };
    const base = await agent('base');
    const one = await agent('one', base.id);
    const two = await agent('two');
    const app = await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'el74 app', urn: 'el74:el74-app' } });
    for (const x of [one, two]) await db.appAgent.create({ data: { appId: app.id, agentId: x.id } });
    const n1 = (await createDbNode(db, { loc: 'n1', memoryId: one.mem })).id;
    const n2 = (await createDbNode(db, { loc: 'n2', memoryId: two.mem })).id;
    const nb = (await createDbNode(db, { loc: 'nb', memoryId: base.mem })).id;
    await edge('in-scope', one.mem, n1, n2);
    await edge('to-base', one.mem, n1, nb);
    const r = await run(`{ appNodes(appRef: "${app.id}", limit: 50) { id outgoingEdges { name } } }`, context(member));
    expect(r.errors).toBeUndefined();
    const row = (r.data as any).appNodes.find((n: any) => n.id === n1);
    expect(row.outgoingEdges.map((e: any) => e.name)).toEqual(['in-scope']);
    const page = await run(`{ appNodesPage(appRef: "${app.id}", limit: 50) { items { id outgoingEdges { name } } } }`, context(member));
    expect((page.data as any).appNodesPage.items.find((n: any) => n.id === n1).outgoingEdges.map((e: any) => e.name)).toEqual(['in-scope']);
    // The base's own row reads through its child (#1893): its edge to a node of that child is listed there.
    for (const rows of [(r.data as any).appNodes, (page.data as any).appNodesPage.items]) expect(rows.some((n: any) => n.id === nb)).toBe(true);
    const inherited = await run(`{ appNodes(appRef: "${app.id}", limit: 50) { id incomingEdges { name } } }`, context(member));
    expect((inherited.data as any).appNodes.find((n: any) => n.id === nb).incomingEdges.map((e: any) => e.name)).toEqual(['to-base']);
  });

  it('an inherited node lists no edge whose memory the reader may not read, in both directions', async () => {
    const base = await memory('base', { organizationId: orgId, class: 'system' });
    const child = await memory('child', { organizationId: orgId, class: 'system' });
    const baseAgent = await db.agent.create({ data: { organizationId: orgId, name: 'base', urn: 'el74:base', visibility: 'ORGANIZATION', systemMemoryId: base } as never });
    const childAgent = await db.agent.create({ data: { organizationId: orgId, name: 'child', urn: 'el74:child', visibility: 'ORGANIZATION', systemMemoryId: child, extendsAgentId: baseAgent.id } as never });
    const app = await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'el74 app', urn: 'el74:el74-app' } });
    await db.appAgent.create({ data: { appId: app.id, agentId: childAgent.id } });
    const nb = (await createDbNode(db, { loc: 'nb', memoryId: base })).id;
    const mem = await memory('far-slug', { class: 'private', userId: alice, ownerUserId: alice });
    await edge('held-out', mem, nb, near);
    await edge('held-in', mem, near, nb);
    await edge('base-out', base, nb, near);
    await edge('shared-in', shared, near, nb);
    const q = `{ appNodes(appRef: "${app.id}", limit: 50) { id outgoingEdges { name } incomingEdges { name } } }`;
    const names = async (ctx: Context) => {
      const r = await run(q, ctx);
      expect(r.errors).toBeUndefined();
      const n = (r.data as any).appNodes.find((x: any) => x.id === nb);
      return [n.outgoingEdges.map((e: any) => e.name).sort(), n.incomingEdges.map((e: any) => e.name).sort()];
    };
    expect(await names(context(member))).toEqual([['base-out'], ['shared-in']]);
    expect(await names(context(alice))).toEqual([['base-out', 'held-out'], ['held-in', 'shared-in']]);
  });
});
