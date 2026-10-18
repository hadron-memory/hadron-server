/** #2040 S1 — the writeNodeCore hook (createNode / updateNode): refusals, rollback, derived edges. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let memoryId: string;
let admin: { id: string };
const as = (): Context => ({ db, userId: admin.id, roles: [] });
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const create = (loc: string, content: string) =>
  M.createNode(null, { input: { memoryId, loc, name: loc, abstract: loc, content } }, as());
const update = (loc: string, content: string, extra: Record<string, unknown> = {}) =>
  M.updateNode(null, { input: { memoryId, loc, content, ...extra } }, as());
const code = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e: any) { return String(e.extensions?.code ?? e.message); }
};
const includeEdges = (sourceLoc: string) => db.edge.findMany({
  where: { source: { memoryId, loc: sourceLoc }, governedKind: 'INCLUDE' }, include: { target: true },
});

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Inc Org', urn: 'inc.example' } });
  admin = await db.user.create({ data: { githubId: 204002, githubUsername: 'inc-admin2', handle: 'inc-admin2', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memoryId = (await M.createMemory(null, { orgId: org.id, name: 'inc' }, as())).id;
});

describe('include tags through createNode / updateNode (#2040)', () => {
  it('derives an INCLUDE edge per tag, and add / retarget / remove follow the content', async () => {
    await create('b', 'B'); await create('c', 'C');
    await create('a', 'x {{> b}} y');
    expect((await includeEdges('a')).map(e => e.target.loc)).toEqual(['b']);
    await update('a', '{{> c}} {{> c}}');
    expect((await includeEdges('a')).map(e => e.target.loc)).toEqual(['c']);
    await update('a', 'plain');
    expect(await includeEdges('a')).toEqual([]);
  });

  it('keeps derived edges when the write passes inline edges', async () => {
    await create('b', 'B'); await create('c', 'C');
    await create('a', '{{> b}}');
    await update('a', '{{> b}}', { edges: [{ name: 'see', targetId: 'c' }] });
    expect((await includeEdges('a')).map(e => e.target.loc)).toEqual(['b']);
    expect(await db.edge.count({ where: { source: { memoryId, loc: 'a' }, governedKind: null } })).toBe(1);
  });

  it('refuses a malformed tag and a cycle, leaving content, revisions and edges unchanged', async () => {
    await create('b', 'B');
    await create('a', '{{> b}}');
    const before = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'b' } });
    expect(await code(update('a', '{{> b bogus}}'))).toBe('INVALID_INCLUDE');
    expect(await code(update('b', '{{> a}}'))).toBe('INCLUDE_CYCLE');
    expect(await code(update('a', '{{> a}}'))).toBe('INCLUDE_CYCLE');
    const after = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'b' } });
    expect(after.content).toBe('B');
    expect(after.revSeq).toBe(before.revSeq);
    expect(await db.nodeRevision.count({ where: { nodeId: before.id } })).toBe(await db.nodeRevision.count({ where: { nodeId: after.id } }));
    expect((await includeEdges('a')).map(e => e.target.loc)).toEqual(['b']);
    expect(await includeEdges('b')).toEqual([]);
  });

  it('refuses a create whose tags are malformed, creating nothing', async () => {
    expect(await code(create('n', '{{> x rev=0}}'))).toBe('INVALID_INCLUDE');
    expect(await db.node.count({ where: { memoryId, loc: 'n' } })).toBe(0);
  });

  it('refuses a chain deeper than the cap', async () => {
    await create('n0', 'leaf');
    for (let i = 1; i <= 10; i++) await create(`n${i}`, `{{> n${i - 1}}}`);
    expect(await code(create('top', '{{> n10}}'))).toBe('INCLUDE_TOO_DEEP');
  });

  it('accepts a diamond', async () => {
    await create('d', 'D'); await create('l', '{{> d}}'); await create('r', '{{> d}}');
    expect(await code(create('top', '{{> l}} {{> r}}'))).toBe('NO_ERROR');
  });

  it('treats a tag in code as text', async () => {
    await create('a', '`{{> missing bogus}}`');
    expect(await includeEdges('a')).toEqual([]);
  });
});

describe('searchReplaceInNodes (#2040)', () => {
  const replace = (nodeIds: string[], oldText: string, newText: string) =>
    M.searchReplaceInNodes(null, { input: { nodeIds, fields: ['content'], oldText, newText, dryRun: false } }, as());
  const idOf = async (loc: string) => (await db.node.findFirstOrThrow({ where: { memoryId, loc } })).id;

  it('derives edges for a rewritten node', async () => {
    await create('b', 'B'); await create('a', 'see TOKEN');
    await replace([await idOf('a')], 'TOKEN', '{{> b}}');
    expect((await includeEdges('a')).map(e => e.target.loc)).toEqual(['b']);
  });

  it('a batch with one cycle rolls every node back', async () => {
    await create('b', 'x TOKEN'); await create('a', '{{> b}} TOKEN');
    const ids = [await idOf('a'), await idOf('b')];
    expect(await code(replace(ids, 'TOKEN', '{{> a}}'))).toBe('INCLUDE_CYCLE');
    expect((await db.node.findFirstOrThrow({ where: { memoryId, loc: 'b' } })).content).toBe('x TOKEN');
    expect((await db.node.findFirstOrThrow({ where: { memoryId, loc: 'a' } })).content).toBe('{{> b}} TOKEN');
  });
});

describe('mergeNodes and restoreNodeRevision (#2040)', () => {
  it('a merge that folds an include onto its own target is refused, leaving the target unchanged', async () => {
    const t = await db.node.create({ data: { id: generateId(), memoryId, loc: 't', name: 't' } });
    await create('s', '{{> t}}');
    const s = await db.node.findFirstOrThrow({ where: { memoryId, loc: 's' } });
    expect(await code(M.mergeNodes({}, { input: { source: s.id, target: t.id, include: ['CONTENT'] } } as never, as()))).toBe('INCLUDE_CYCLE');
    expect((await db.node.findUniqueOrThrow({ where: { id: t.id } })).content).toBeNull();
  });

  it('restoring a revision whose tags would now cycle is refused', async () => {
    await create('b', 'B'); await create('a', 'v1 {{> b}}');
    await update('a', 'v2 plain');
    await update('b', '{{> a}}');
    const a = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'a' } });
    const v1 = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: a.id, content: 'v1 {{> b}}' } });
    expect(await code(M.restoreNodeRevision(null, { revisionId: v1.id }, as()))).toBe('INCLUDE_CYCLE');
    expect((await db.node.findUniqueOrThrow({ where: { id: a.id } })).content).toBe('v2 plain');
  });
});

describe('direct edge mutation of a derived INCLUDE edge (#2040)', () => {
  it('deleteEdge and updateEdge refuse it, naming the content as the owner', async () => {
    await create('b', 'B'); await create('a', '{{> b}}');
    const [edge] = await includeEdges('a');
    expect(await code(M.deleteEdge(null, { edgeRef: edge.id }, as()))).toBe('INCLUDE_EDGE_DERIVED');
    expect(await code(M.updateEdge(null, { edgeRef: edge.id, name: 'x' }, as()))).toBe('INCLUDE_EDGE_DERIVED');
    expect(await includeEdges('a')).toHaveLength(1);
  });
});
