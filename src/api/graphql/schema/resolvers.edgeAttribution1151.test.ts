/**
 * #1151 — read half of attribution: `Edge.createdAt/updatedAt`, `Node.createdByUser`,
 * `Edge.createdByUser/updatedByUser`, through REAL GraphQL execution.
 *
 * One projection (handle + URN, the revision-editor shape), never a raw id; an identity is named only to a
 * caller who may read the memory the ROW lives in (an Edge's memoryId is its source side, so a cross-memory edge
 * reached from the other side stays anonymous: the nested-field rule, hadron-server CLAUDE.md #552).
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
      return typeof resolver === 'function'
        ? resolver(parent, args, context, info)
        : defaultFieldResolver(parent, args, context, info);
    },
  });
}

let author: { id: string; handle: string | null };
let editor: { id: string; handle: string | null };
let reader: { id: string };
let memA: { id: string };
let memB: { id: string };
let nodeA: { id: string };
let nodeA2: { id: string };
let nodeB: { id: string };
const edges: Record<string, string> = {};
const rctx = (userId: string): Context => ({ db, userId, roles: [] }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  const orgA = await db.organization.create({ data: { id: generateId(), name: 'ea', urn: 'ea1151' } });
  const orgB = await db.organization.create({ data: { id: generateId(), name: 'eb', urn: 'eb1151' } });
  author = await db.user.create({ data: { id: generateId(), githubId: 115101, githubUsername: 'ea-author', handle: 'ea-author' } });
  editor = await db.user.create({ data: { id: generateId(), githubId: 115102, githubUsername: 'ea-editor', handle: 'ea-editor' } });
  reader = await db.user.create({ data: { id: generateId(), githubId: 115103, githubUsername: 'ea-reader', handle: 'ea-reader' } });
  for (const u of [author, editor, reader]) {
    await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: u.id, role: 'READER' } });
  }
  memA = await db.memory.create({ data: { id: generateId(), organizationId: orgA.id, urn: 'ea1151:a', name: 'a', class: 'knowledge', visibility: 'ORGANIZATION' } });
  memB = await db.memory.create({ data: { id: generateId(), organizationId: orgB.id, urn: 'eb1151:b', name: 'b', class: 'knowledge', visibility: 'ORGANIZATION' } });
  nodeA = await createDbNode(db, { loc: 'na', memoryId: memA.id });
  nodeA2 = await createDbNode(db, { loc: 'na2', memoryId: memA.id });
  nodeB = await createDbNode(db, { loc: 'nb', memoryId: memB.id });
  const mk = (key: string, data: Record<string, unknown>) =>
    db.edge.create({ data: { id: generateId(), loc: `e:${key}`, name: key, ...data } as never }).then((e) => { edges[key] = e.id; });
  await mk('user', { memoryId: memA.id, sourceId: nodeA.id, targetId: nodeA2.id, createdBy: author.id, updatedBy: editor.id });
  await mk('client', { memoryId: memA.id, sourceId: nodeA.id, targetId: nodeA2.id, createdBy: 'client-abc', updatedBy: 'client-abc' });
  await mk('none', { memoryId: memA.id, sourceId: nodeA.id, targetId: nodeA2.id });
  // memB → memA: Edge.memoryId is memB, which `reader` (orgA only) cannot read; reached via nodeA.incomingEdges.
  await mk('foreign', { memoryId: memB.id, sourceId: nodeB.id, targetId: nodeA.id, createdBy: author.id, updatedBy: editor.id });
  await db.node.update({ where: { id: nodeA.id }, data: { createdBy: author.id } });
  await db.node.update({ where: { id: nodeA2.id }, data: { createdBy: 'client-abc' } });
});

const Q = `loc createdAt updatedAt createdByUser { handle urn } updatedByUser { handle urn }`;

describe('Edge timestamps and attribution (#1151)', () => {
  it('Edge.createdAt / updatedAt are queryable and carry the row values', async () => {
    const r = await run(`{ edge(ref: "${edges.user}") { createdAt updatedAt } }`, rctx(reader.id));
    expect(r.errors).toBeUndefined();
    const row = await db.edge.findUniqueOrThrow({ where: { id: edges.user } });
    expect(new Date((r.data as any).edge.createdAt).getTime()).toBe(row.createdAt.getTime());
  });

  it('a co-member sees the creator and the last editor as handle + urn', async () => {
    const r = await run(`{ edge(ref: "${edges.user}") { ${Q} } }`, rctx(reader.id));
    expect(r.errors).toBeUndefined();
    const e = (r.data as any).edge;
    expect(e.createdByUser).toEqual({ handle: 'ea-author', urn: expect.stringContaining('ea-author') });
    expect(e.updatedByUser?.handle).toBe('ea-editor');
  });

  it('a clientId or null in the column gives null, never the raw value', async () => {
    const r = await run(`{ edges(filter: { memoryId: "${memA.id}" }) { items { ${Q} } } }`, rctx(reader.id));
    expect(r.errors).toBeUndefined();
    for (const key of ['client', 'none']) {
      const e = (r.data as any).edges.items.find((i: any) => i.loc === `e:${key}`);
      expect(e.createdByUser).toBeNull();
      expect(e.updatedByUser).toBeNull();
    }
    expect(JSON.stringify(r.data)).not.toContain('client-abc');
  });

  it('an edge whose own memory the caller cannot read names nobody (cross-memory, other tenant)', async () => {
    const r = await run(`{ node(ref: "${nodeA.id}") { incomingEdges { ${Q} } } }`, rctx(reader.id));
    expect(r.errors).toBeUndefined();
    const e = (r.data as any).node.incomingEdges.find((i: any) => i.loc === 'e:foreign');
    expect(e).toBeDefined();
    expect(e.createdByUser).toBeNull();
    expect(e.updatedByUser).toBeNull();
  });
});

describe('Node.createdByUser (#1151)', () => {
  it('names the creating user; a clientId creator gives null', async () => {
    const r = await run(`{ a: node(ref: "${nodeA.id}") { createdByUser { handle urn } } b: node(ref: "${nodeA2.id}") { createdByUser { handle urn } } }`, rctx(reader.id));
    expect(r.errors).toBeUndefined();
    expect((r.data as any).a.createdByUser?.handle).toBe('ea-author');
    expect((r.data as any).b.createdByUser).toBeNull();
  });
});

describe('fail closed (#1151)', () => {
  it('an Edge parent selected without its memory, or without the column, names nobody', async () => {
    const E = resolvers.Edge as any;
    expect(await E.createdByUser({ id: edges.user, createdBy: author.id }, {}, rctx(reader.id))).toBeNull(); // no memoryId
    expect(await E.createdByUser({ id: edges.user, memoryId: memA.id }, {}, rctx(reader.id))).toBeNull(); // column unselected
    expect((await E.createdByUser({ id: edges.user, memoryId: memA.id, createdBy: author.id }, {}, rctx(reader.id)))?.handle).toBe('ea-author');
  });
});
