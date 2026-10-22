/** #2040 S1 — the writeNodeCore hook (createNode / updateNode): refusals, rollback, derived edges. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { BROKEN_INCLUDE_NOTICE } from './resolveNodeContent.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let memoryId: string;
let memoryUrn: string;
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
const server = new ApolloServer<Context>({ typeDefs, resolvers });
const read = async (loc: string) => {
  const res = await server.executeOperation(
    { query: 'query($ref: ID!) { node(ref: $ref) { content } }', variables: { ref: `hrn:node:${memoryUrn}:${loc}` } },
    { contextValue: as() },
  );
  if (res.body.kind !== 'single') throw new Error('unexpected incremental result');
  return (res.body.singleResult.data as { node: { content: string } }).node.content;
};
const includeEdges = (sourceLoc: string) => db.edge.findMany({
  where: { source: { memoryId, loc: sourceLoc }, governedKind: 'INCLUDE' }, include: { target: true },
});

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Inc Org', urn: 'inc.example' } });
  admin = await db.user.create({ data: { githubId: 204002, githubUsername: 'inc-admin2', handle: 'inc-admin2', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const m = await M.createMemory(null, { orgId: org.id, name: 'inc' }, as());
  memoryId = m.id; memoryUrn = m.urn;
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

  // #2134 — cor:dmo:150:06: over-depth is a broken include at read, never a
  // write refusal. Depth counts from the includer: its own tags are level 1.
  it('saves a chain deeper than the cap, on create and on update; the read shows the notice past level 10 only', async () => {
    await create('n0', 'L0');
    for (let i = 1; i <= 10; i++) await create(`n${i}`, `L${i}{{> n${i - 1}}}`);
    // top -> n9 .. n0 is 10 levels: every level resolves.
    expect(await code(create('ten', '{{> n9}}'))).toBe('NO_ERROR');
    expect(await read('ten')).toBe('L9L8L7L6L5L4L3L2L1L0');
    // top -> n10 .. n0 is 11 levels: it saves, and only the 11th is the notice.
    expect(await code(create('eleven', '{{> n10}}'))).toBe('NO_ERROR');
    expect(await read('eleven')).toBe(`L10L9L8L7L6L5L4L3L2L1${BROKEN_INCLUDE_NOTICE}`);
    await create('later', 'plain');
    expect(await code(update('later', '{{> n0}} {{> n10}}'))).toBe('NO_ERROR');
    expect((await includeEdges('later')).map(e => e.target.loc).sort()).toEqual(['n0', 'n10']);
  });

  it('refuses a cycle longer than the depth cap, naming the authored tag, with no residue', async () => {
    // a -> c1 -> ... -> c12; closing c12 -> a makes a 13-node loop.
    await create('c12', 'end');
    for (let i = 11; i >= 1; i--) await create(`c${i}`, `{{> c${i + 1}}}`);
    await create('a', '{{> c1}}');
    const before = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'c12' } });
    let err: any;
    try { await update('c12', 'end {{> a}}'); } catch (e) { err = e; }
    expect(err?.extensions?.code).toBe('INCLUDE_CYCLE');
    expect(err?.extensions?.tag).toBe('{{> a}}');
    const after = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'c12' } });
    expect(after.content).toBe('end');
    expect(after.revSeq).toBe(before.revSeq);
    expect(await includeEdges('c12')).toEqual([]);
  });

  it('terminates on a stored cycle that does not pass through the writer, and saves', async () => {
    // x <-> y made directly (a write would refuse it): the walk must not loop.
    await db.node.create({ data: { id: generateId(), memoryId, loc: 'x', name: 'x', content: 'X{{> y}}' } });
    await db.node.create({ data: { id: generateId(), memoryId, loc: 'y', name: 'y', content: 'Y{{> x}}' } });
    expect(await code(create('w', '{{> x}} {{> y}}'))).toBe('NO_ERROR');
    expect((await includeEdges('w')).map(e => e.target.loc).sort()).toEqual(['x', 'y']);
  });

  it('cycle detection skips a node already walked on another branch without missing the cycle, in either tag order', async () => {
    // `d` is reached first through `s` (it doesn't reach `a`), then again on the
    // hub path, where it is skipped; the hub path still reaches `a`.
    await create('d', 'D');
    await create('s', '{{> d}}');
    await create('a', 'A');
    for (let i = 11; i >= 1; i--) await create(`p${i}`, i === 11 ? '{{> a}}' : `{{> d}} {{> p${i + 1}}}`);
    await create('hub', '{{> p1}}');
    expect(await code(update('a', '{{> s}} {{> hub}}'))).toBe('INCLUDE_CYCLE');
    expect(await code(update('a', '{{> hub}} {{> s}}'))).toBe('INCLUDE_CYCLE');
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

describe('run prompt assembly (#2040)', () => {
  it('does not inline an include target a second time as a referenced node', async () => {
    const { assembleRunNodePrompt } = await import('../runNodeRender.js');
    const target = { loc: 'b', name: 'b', content: 'B body', memoryId: 'm' };
    const out = await assembleRunNodePrompt(
      { id: 'a', name: 'a', loc: 'a', content: 'x', memoryId: 'm', outgoingEdges: [{ name: 'includes', loc: 'includes:a:b', governedKind: 'INCLUDE', target }] } as never,
      undefined,
      { compileTemplate: async (c: string) => c, includeTarget: async () => true, memoryUrnOf: async () => 'o:m' } as never,
    );
    expect(out).not.toContain('Referenced Nodes');
  });
});

describe('copy paths conceal foreign targets (#2040, §10)', () => {
  it('clone refuses a copied tag to an unreadable foreign target, exactly like a missing one (#2167)', async () => {
    const foreignOrg = await db.organization.create({ data: { id: generateId(), name: 'Foreign', urn: 'foreign.example' } });
    const foreign = await db.memory.create({ data: { id: generateId(), name: 'secret', urn: 'foreign.example:secret', class: 'knowledge', organizationId: foreignOrg.id } });
    await db.node.create({ data: { id: generateId(), memoryId: foreign.id, loc: 'hidden', name: 'hidden', content: 'H' } });
    await create('local', 'L');
    // Stored directly: a write ADDING these foreign tags is refused (#2041 S2b).
    // The update below leaves them unchanged, so it saves and derives `local`'s edge.
    const srcText = '{{> local}} {{> hrn:node:foreign.example:secret:hidden}} {{> hrn:node:foreign.example:secret:absent}}';
    await db.node.create({ data: { id: generateId(), memoryId, loc: 'src', name: 'src', content: srcText } });
    await update('src', `${srcText} .`);
    expect((await includeEdges('src')).map(e => e.target.loc)).toEqual(['local']);
    const org = await db.organization.findFirstOrThrow({ where: { urn: 'inc.example' } });
    // A copy is an includer write: every copied tag counts as added, so the
    // unreadable and the missing foreign tag refuse alike, naming only the tag.
    const refused = await M.cloneMemory(null, { ref: memoryId, targetUrn: `hrn:mem:${org.urn}:copy` }, as())
      .then(() => null, (e: any) => e);
    expect(refused?.extensions?.code).toBe('INCLUDE_TARGET_UNAVAILABLE');
    expect(refused.extensions.tag).toBe('{{> hrn:node:foreign.example:secret:hidden}}');
    expect(await db.memory.count({ where: { urn: `${org.urn}:copy` } })).toBe(0);
    // loc-scope-ok: deliberately global — no include edge anywhere may name the foreign target.
    expect(await db.edge.count({ where: { governedKind: 'INCLUDE', loc: { contains: foreign.id } } })).toBe(0);
  });
});
