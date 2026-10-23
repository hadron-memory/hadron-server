/**
 * #2124 — `governedKind` on the edge read model, through REAL GraphQL execution.
 *
 * null = an ordinary edge (stored SQL NULL only); INCLUDE / COMMENT_ANCHOR /
 * COMMENT_REPLY are the edge's own stored column, read under the gate that
 * already admitted the edge. Never inferred from name or loc.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbNode } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

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

let memId: string;
let ctx: Context;
let src: { id: string; loc: string };
let commented: { id: string };
let rootComment: { id: string };
const edgeIds: Record<string, string> = {};
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'gk', urn: 'gk2124' } });
  const user = await db.user.create({ data: { id: generateId(), githubId: 212401, githubUsername: 'gk-admin' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const mem = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'gk2124:m', name: 'm', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  memId = mem.id;
  ctx = { db, userId: user.id, roles: [] } as Context;
  src = await createDbNode(db, { loc: 'src', memoryId: memId });
  // An ordinary edge deliberately NAMED `includes`: the name must not matter.
  const t1 = await createDbNode(db, { loc: 't-ordinary', memoryId: memId });
  const t2 = await createDbNode(db, { loc: 't-include', memoryId: memId });
  edgeIds.ordinary = (await db.edge.create({ data: { id: generateId(), memoryId: memId, sourceId: src.id, targetId: t1.id, loc: 'src:rel:ordinary', name: 'includes' } })).id;
  edgeIds.include = (await db.edge.create({ data: { id: generateId(), memoryId: memId, sourceId: src.id, targetId: t2.id, loc: 'src:rel:include', name: 'include', governedKind: 'INCLUDE' } })).id;
  commented = await createDbNode(db, { loc: 'commented', memoryId: memId });
  // The comment edges come from the real comment path (their triggers refuse hand-built rows).
  rootComment = await M.createComment(null, { targetRef: commented.id, body: 'root' }, ctx);
  const reply = await M.replyToComment(null, { commentRef: rootComment.id, body: 'reply' }, ctx);
  edgeIds.anchor = (await db.edge.findFirstOrThrow({ where: { sourceId: rootComment.id } })).id;
  edgeIds.reply = (await db.edge.findFirstOrThrow({ where: { sourceId: reply.id } })).id;
});

const kindsOf = (items: Array<{ governedKind: string | null }>) => items.map((i) => i.governedKind).sort((a, b) => String(a) < String(b) ? -1 : 1);
const ALL = ['COMMENT_ANCHOR', 'COMMENT_REPLY', 'INCLUDE', null];

describe('Edge.governedKind (#2124)', () => {
  it('edges(filter) reports each stored kind; a normal edge named "includes" is null', async () => {
    const r = await run(`{ edges(filter: { memoryId: "${memId}" }) { items { loc governedKind } } }`, ctx);
    expect(r.errors).toBeUndefined();
    expect(kindsOf((r.data as any).edges.items)).toEqual(ALL);
    const ordinary = (r.data as any).edges.items.find((i: any) => i.loc === 'src:rel:ordinary');
    expect(ordinary.governedKind).toBeNull();
  });

  it('edge(ref:) reports the kind', async () => {
    const r = await run(`{ edge(ref: "${edgeIds.include}") { governedKind } }`, ctx);
    expect(r.errors).toBeUndefined();
    expect((r.data as any).edge.governedKind).toBe('INCLUDE');
  });

  it('Node.outgoingEdges and Node.incomingEdges carry the kind', async () => {
    const out = await run(`{ node(ref: "${src.id}") { outgoingEdges { loc governedKind } } }`, ctx);
    expect(out.errors).toBeUndefined();
    expect(kindsOf((out.data as any).node.outgoingEdges)).toEqual(['INCLUDE', null]);
    const inc = await run(`{ node(ref: "${commented.id}") { incomingEdges { governedKind } } }`, ctx);
    expect(inc.errors).toBeUndefined();
    expect((inc.data as any).node.incomingEdges).toEqual([{ governedKind: 'COMMENT_ANCHOR' }]);
    const rep = await run(`{ node(ref: "${rootComment.id}") { incomingEdges { governedKind } } }`, ctx);
    expect(rep.errors).toBeUndefined();
    expect((rep.data as any).node.incomingEdges).toEqual([{ governedKind: 'COMMENT_REPLY' }]);
  });

  it('the slim memoryEdges projection carries the kind', async () => {
    const r = await run(`{ memoryEdges(memoryRef: "${memId}") { edges { loc governedKind } } }`, ctx);
    expect(r.errors).toBeUndefined();
    expect(kindsOf((r.data as any).memoryEdges.edges)).toEqual(ALL);
  });

  it('an unknown raw stored value is an error, never null/ordinary', async () => {
    const E = resolvers.Edge as any;
    const G = resolvers.GraphEdge as any;
    expect(() => E.governedKind({ governedKind: 'FUTURE_KIND' })).toThrow('UNSUPPORTED_EDGE_GOVERNED_KIND');
    expect(() => G.governedKind({ governedKind: 'FUTURE_KIND' })).toThrow('UNSUPPORTED_EDGE_GOVERNED_KIND');
    expect(() => E.governedKind({ id: 'x' })).toThrow('UNSUPPORTED_EDGE_GOVERNED_KIND'); // column not selected
  });

  it('no write input accepts governedKind', () => {
    expect(typeDefs).not.toMatch(/input\s+\w*Edge\w*\s*\{[^}]*governedKind/);
  });
});
