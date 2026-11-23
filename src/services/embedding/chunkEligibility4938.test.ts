/**
 * #4938 F8 — the chunk path's content scope and COMMENTS scope read ONE eligibility builder (`chunkVectorEligibility`), the
 * chunk counterpart of `nodeVectorEligibility` (#3054's drift warning). One fixture, interleaved content and comments, and
 * each scope must return exactly its eligible set:
 * - a deleted comment never ranks (COMMENT_NOT_DELETED), even when the caller asked for deleted rows;
 * - a stub comment (retracted, kept for its replies; its vector not yet cleaned up) never ranks, in any scope (NOT_A_STUB);
 * - the access scope (memory) and the caller's exclusions apply in both scopes;
 * - content keeps its own deleted rule: an includeDeleted search admits a recoverable content tombstone.
 * A builder whose scopes diverge (for example NOT_A_STUB dropped from one) turns this red.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { postgresRetrievalProvider as provider } from '../../lib/retrieval/postgres.js';
import { chunkVectorEligibility } from './vectors.js';

const DIM = 768;
const q = Array.from({ length: DIM }, (_, i) => (i === 1 ? 1 : 0));
const lit = (i: number) => { const v = q.slice(); v[2] = i * 0.05; return `'[${v.join(',')}]'::vector`; };

let mem: string; let otherMem: string;
const id: Record<string, string> = {};

async function chunk(memoryId: string, nodeId: string, at: number): Promise<void> {
  await db.$executeRawUnsafe(`DELETE FROM node_embeddings WHERE node_id = '${nodeId}'`);
  await db.$executeRawUnsafe(`
    INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding, created_at)
    VALUES ('${generateId()}', '${nodeId}', '${memoryId}', 'chunk', 'test', 'stub', ${DIM}, 0, 0, 4, 'body', ${lit(at)}, now())`);
}

beforeAll(async () => {
  await cleanDb(db);
  const M = resolvers.Mutation as any;
  const org = await db.organization.create({ data: { id: generateId(), name: 'R4938', urn: `r4938-${generateId()}.test` } });
  const userId = (await db.user.create({ data: { handle: `r4938-${generateId()}` } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  const ctx = (): Context => ({ db, userId, roles: [] });
  mem = (await M.createMemory(null, { orgRef: org.id, name: 'r4938-chunks' }, ctx())).id;
  otherMem = (await M.createMemory(null, { orgRef: org.id, name: 'r4938-other' }, ctx())).id;
  await db.memory.updateMany({ where: { id: { in: [mem, otherMem] } }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });

  // Content, interleaved with the comments below by distance: A, B live; X live but excluded by the caller; D deleted.
  let at = 0;
  for (const name of ['A', 'B', 'X', 'D', 'T1', 'T2', 'T3']) {
    id[name] = generateId();
    await db.node.create({ data: { id: id[name]!, memoryId: mem, loc: `c-${name}`, name, content: 'body' } });
  }
  // Comments: cA, cB live; cX live but excluded; cDel deleted; cStub retracted (a stub) whose vector lingers.
  for (const [name, target] of [['cA', 'A'], ['cB', 'B'], ['cX', 'X'], ['cDel', 'T1'], ['cStub', 'T2']] as const) {
    id[name] = (await M.createComment(null, { targetRef: id[target], body: `comment ${name}` }, ctx())).id;
  }
  await M.deleteCommentThread(null, { commentRef: id.cDel, reason: 'r4938 deleted comment' }, ctx());
  // A stub is retracted with its node row kept (deleted_at NULL); its vectors are deleted in the same transaction, so a
  // lingering vector is exactly the state NOT_A_STUB guards against (#1608).
  await db.$executeRawUnsafe(`UPDATE comment_meta SET retracted_at = now() WHERE node_id = '${id.cStub}'`);
  await db.node.update({ where: { id: id.D! }, data: { deletedAt: new Date() } });
  // Another memory's content and comment: outside the access scope of every search below.
  id.O = generateId();
  await db.node.create({ data: { id: id.O, memoryId: otherMem, loc: 'o', name: 'o', content: 'body' } });
  id.cO = (await M.createComment(null, { targetRef: id.O, body: 'other memory' }, ctx())).id;

  for (const name of ['cStub', 'A', 'cA', 'cDel', 'B', 'cB', 'X', 'cX', 'D']) await chunk(mem, id[name]!, at++);
  for (const name of ['T1', 'T2', 'T3']) await db.$executeRawUnsafe(`DELETE FROM node_embeddings WHERE node_id = '${id[name]}'`);
  await chunk(otherMem, id.O, at++);
  await chunk(otherMem, id.cO, at++);
  const dead = await db.node.findUniqueOrThrow({ where: { id: id.cDel! } });
  expect(dead.deletedAt).not.toBeNull();
  expect((await db.node.findUniqueOrThrow({ where: { id: id.cStub! } })).deletedAt).toBeNull();
}, 120_000);

type Scope = 'CONTENT' | 'COMMENTS' | 'ALL';
async function ranked(scope: Scope, extra: { excludeNodeIds?: string[]; includeDeleted?: boolean } = {}): Promise<string[]> {
  // As the resolver calls it: with any filter, the filter carries the same content scope (its own scope rule, #1608).
  const filter = Object.keys(extra).length ? { contentScope: scope } : undefined;
  const hits = await provider.vectorSearchChunks({ db, memoryIds: [mem], queryEmbedding: q, limit: 100, contentScope: scope, filter, ...extra });
  const names = Object.fromEntries(Object.entries(id).map(([k, v]) => [v, k]));
  return hits.map((h) => names[h.nodeId] ?? `?${h.nodeId}`).sort();
}

describe('#4938 F8 — chunk content and COMMENTS scopes share one eligibility', () => {
  it('each scope returns exactly its eligible set (no filter)', async () => {
    expect(await ranked('CONTENT')).toEqual(['A', 'B', 'X']);
    expect(await ranked('COMMENTS')).toEqual(['cA', 'cB', 'cX']);
    expect(await ranked('ALL')).toEqual(['A', 'B', 'X', 'cA', 'cB', 'cX']);
  });

  it("the caller's exclusions apply in both scopes", async () => {
    const excludeNodeIds = [id.X!, id.cX!];
    expect(await ranked('CONTENT', { excludeNodeIds })).toEqual(['A', 'B']);
    expect(await ranked('COMMENTS', { excludeNodeIds })).toEqual(['cA', 'cB']);
    expect(await ranked('ALL', { excludeNodeIds })).toEqual(['A', 'B', 'cA', 'cB']);
  });

  it('includeDeleted admits a content tombstone, never a deleted comment, never a stub', async () => {
    expect(await ranked('CONTENT', { includeDeleted: true })).toEqual(['A', 'B', 'D', 'X']);
    expect(await ranked('COMMENTS', { includeDeleted: true })).toEqual(['cA', 'cB', 'cX']);
    // ALL ranks every non-stub row the filter admits; its deleted rule is the filter's, as on the node path. An includeDeleted
    // filter with no tombstone list compiles no deleted predicate, so ALL can rank a deleted comment here, which hydration
    // then drops (hrn:node:hadronmemory.com:hadron-server:findings:vector-filter-fragment-may-carry-no-deleted-rule). This
    // pin does not bless that; it pins only what F8 owns: the stub rule holds in every scope.
    const all = await ranked('ALL', { includeDeleted: true });
    expect(all).toEqual(expect.arrayContaining(['A', 'B', 'D', 'X', 'cA', 'cB', 'cX']));
    expect(all).not.toContain('cStub');
  });

  it('the builder is the one fragment both scopes read: same tail, differing only where the scope does', () => {
    const scope = { memoryIds: [mem], filterSql: undefined };
    const content = chunkVectorEligibility({ ...scope, scope: 'CONTENT' }).sql;
    const comments = chunkVectorEligibility({ ...scope, scope: 'COMMENTS' }).sql;
    const tail = (s: string) => s.slice(s.indexOf('WHERE')).replace(/\s+/g, ' ').trim();
    expect(tail(comments)).toBe(tail(content));
    expect(tail(content)).toContain('retracted_at IS NOT NULL');
    expect(comments).toContain("n.node_type = 'comment'");
    expect(content).toContain("n.node_type <> 'comment'");
  });
});
