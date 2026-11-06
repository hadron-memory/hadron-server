/**
 * #3456 — memoryLocSegments (cor:api:090:05): the distinct next loc segments under a parent loc.
 * Scenarios S1-S8 of the spec, plus the readable-set parity with findNodes and the no-oracle rule.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const admin = (): Context => ({ db, roles: ['ADMIN'], userId: 'admin-3456' } as Context);
const stranger = (): Context => ({ db, roles: [], userId: 'leo-3456' } as Context);
const segs = (args: Record<string, unknown>, ctx: Context = admin()) =>
  (resolvers.Query as any).memoryLocSegments(null, args, ctx);
const findNodes = (args: Record<string, unknown>, ctx: Context = admin()) => (resolvers.Query as any).findNodes(null, args, ctx);
const names = (page: any): string[] => page.items.map((i: any) => i.segment);

let M: { id: string };
let M2: { id: string };
const mk = (loc: string, extra: Record<string, unknown> = {}, memoryId = M.id) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, ...extra } as any });

/** A whole comment node (node + meta + its one anchor), the only way the comment invariant admits one. */
const mkComment = async (loc: string) => {
  const target = await mk(`target-of-${loc.replace(/:/g, '-')}`, { deletedAt: new Date() });
  return db.$transaction(async (tx) => {
    const id = generateId();
    await tx.node.create({ data: { id, memoryId: M.id, loc, name: 'Comment', nodeType: 'comment', content: 'x' } });
    await tx.commentMeta.create({ data: { nodeId: id, targetNodeId: target.id, threadState: 'OPEN', authorKey: 'u:x' } });
    await tx.edge.create({ data: {
      memoryId: M.id, sourceId: id, targetId: target.id, loc: `${loc}-anchor`, name: 'comment-anchor',
      governedKind: 'COMMENT_ANCHOR', anchorRevNo: 1, anchorApprovalHash: 'a'.repeat(64),
    } });
    return id;
  });
};

beforeEach(async () => {
  await cleanDb(db);
  M = (await createDbOrgAndGraph(db, { orgName: 'seg-org', graphName: 'seg/m' })).graph as any;
  M2 = (await createDbOrgAndGraph(db, { orgName: 'seg-org2', graphName: 'seg/m2' })).graph as any;
});

describe('#3456 S1/S2: node-less branches are listed and marked', () => {
  beforeEach(async () => {
    await mk('findings:flaky-ci');
    await mk('findings:slow-db');
    await mk('ops');
    await mk('ops:alpha');
  });

  it('S1: the root lists findings (no node) and ops (node-backed), each naming the memory', async () => {
    const page = await segs({ memoryIds: [M.id], parentLoc: '' });
    expect(page.items).toEqual([
      { segment: 'findings', hasNode: false, memoryId: M.id },
      { segment: 'ops', hasNode: true, memoryId: M.id },
    ]);
    expect(page.hasMore).toBe(false);
    expect(page.endCursor).toBeNull();
  });

  it('S2: under findings, both children are node-backed', async () => {
    const page = await segs({ memoryIds: [M.id], parentLoc: 'findings' });
    expect(page.items).toEqual([
      { segment: 'flaky-ci', hasNode: true, memoryId: M.id },
      { segment: 'slow-db', hasNode: true, memoryId: M.id },
    ]);
  });

  it('lists one level only: no grandchildren, and a leaf has no segments below it', async () => {
    expect(names(await segs({ memoryIds: [M.id], parentLoc: 'ops' }))).toEqual(['alpha']);
    expect(names(await segs({ memoryIds: [M.id], parentLoc: 'ops:alpha' }))).toEqual([]);
  });
});

describe('#3456 S3: sibling order (ruling 0217)', () => {
  it('positioned node-backed first by position, then everything else by name, node-less branches among the rest', async () => {
    await mk('ops');
    await mk('ops:b', { seq: 1 });
    await mk('ops:a');
    await mk('ops:c:x');
    await mk('ops:z', { seq: 0 });
    const page = await segs({ memoryIds: [M.id], parentLoc: 'ops' });
    expect(names(page)).toEqual(['z', 'b', 'a', 'c']);
    expect(page.items.map((i: any) => i.hasNode)).toEqual([true, true, true, false]);
  });

  it('equal positions fall back to name', async () => {
    await mk('p:b', { seq: 2 });
    await mk('p:a', { seq: 2 });
    expect(names(await segs({ memoryIds: [M.id], parentLoc: 'p' }))).toEqual(['a', 'b']);
  });
});

describe('#3456 S4: paging', () => {
  beforeEach(async () => {
    for (let i = 0; i < 45; i++) await mk(`k${String(i).padStart(2, '0')}:leaf`);
  });

  it('default page is 20, says more exists, and the continuation returns every segment exactly once', async () => {
    const seen: string[] = [];
    let page = await segs({ memoryIds: [M.id], parentLoc: '' });
    expect(page.items.length).toBe(20);
    expect(page.hasMore).toBe(true);
    expect(page.endCursor).toEqual(expect.any(String));
    seen.push(...names(page));
    let guard = 0;
    while (page.hasMore && guard++ < 10) {
      page = await segs({ memoryIds: [M.id], parentLoc: '', after: page.endCursor });
      seen.push(...names(page));
    }
    expect(seen.length).toBe(45);
    expect(new Set(seen).size).toBe(45);
    expect(page.endCursor).toBeNull();
  });

  it('a limit over the cap is served at the cap, never refused; 0 and negatives become 1', async () => {
    for (let i = 0; i < 210; i++) await mk(`big${String(i).padStart(3, '0')}`);
    expect((await segs({ memoryIds: [M.id], parentLoc: '', limit: 100000 })).items.length).toBe(200);
    expect((await segs({ memoryIds: [M.id], parentLoc: '', limit: 0 })).items.length).toBe(1);
    expect((await segs({ memoryIds: [M.id], parentLoc: '', limit: -5 })).items.length).toBe(1);
  });

  it('pages across positioned and unpositioned rows without a repeat or a skip', async () => {
    for (let i = 0; i < 6; i++) await mk(`o:s${i}`, { seq: 10 - i });
    for (let i = 0; i < 6; i++) await mk(`o:t${i}`);
    await mk('o:u:deep');
    const all = names(await segs({ memoryIds: [M.id], parentLoc: 'o', limit: 200 }));
    expect(all).toEqual(['s5', 's4', 's3', 's2', 's1', 's0', 't0', 't1', 't2', 't3', 't4', 't5', 'u']);
    const got: string[] = [];
    let after: string | null = null;
    for (let i = 0; i < 20; i++) {
      const p: any = await segs({ memoryIds: [M.id], parentLoc: 'o', limit: 4, after });
      got.push(...names(p));
      if (!p.hasMore) break;
      after = p.endCursor;
    }
    expect(got).toEqual(all);
  });
});

describe('#3456 S6 and the findNodes defaults', () => {
  it('S6: a branch made only of soft-deleted nodes is not listed', async () => {
    await mk('old:x', { deletedAt: new Date() });
    await mk('keep:x');
    expect(names(await segs({ memoryIds: [M.id], parentLoc: '' }))).toEqual(['keep']);
  });

  it('a branch made only of comment or system-type nodes is not listed; a deleted node does not make hasNode true', async () => {
    await mkComment('c1:x');
    await mk('s1:x', { nodeType: 'system' });
    await mk('h', { deletedAt: new Date() });
    await mk('h:child');
    await mk('real');
    const page = await segs({ memoryIds: [M.id], parentLoc: '' });
    expect(page.items).toEqual([
      { segment: 'h', hasNode: false, memoryId: M.id },
      { segment: 'real', hasNode: true, memoryId: M.id },
    ]);
  });

  it('the colon is the boundary and LIKE metacharacters are literal', async () => {
    await mk('findings:auth:oauth');
    await mk('findings:authz:x');
    await mk('a_b:c');
    await mk('axb:c');
    await mk('a%b:c');
    expect(names(await segs({ memoryIds: [M.id], parentLoc: 'findings:auth' }))).toEqual(['oauth']);
    expect(names(await segs({ memoryIds: [M.id], parentLoc: 'a_b' }))).toEqual(['c']);
    expect(names(await segs({ memoryIds: [M.id], parentLoc: 'a%b' }))).toEqual(['c']);
    expect(names(await segs({ memoryIds: [M.id], parentLoc: 'a' }))).toEqual([]);
    expect(names(await segs({ memoryIds: [M.id], parentLoc: '' })).sort()).toEqual(['a%b', 'a_b', 'axb', 'findings'].sort());
  });

  it('parity: the set of top segments equals the first segments of every loc findNodes returns for the same memory', async () => {
    for (const l of ['x:1', 'x:2:3', 'y', 'z:q:r', 'a_b:c', 'plain']) await mk(l);
    await mk('gone:1', { deletedAt: new Date() });
    await mkComment('cm:1');
    const fn = await findNodes({ filter: { memoryIds: [M.id] }, limit: 200 });
    const expected = [...new Set<string>(fn.hits.map((h: any) => (h.node.loc as string).split(':')[0]))].sort();
    expect(names(await segs({ memoryIds: [M.id], parentLoc: '', limit: 200 })).sort()).toEqual(expected);
  });
});

describe('#3456 S8: several memories', () => {
  it('rows are grouped by memory id, sibling order inside each, and a segment in two memories gives two rows', async () => {
    await mk('notes', { seq: 1 });
    await mk('alpha');
    await mk('notes:x', {}, M2.id);
    await mk('beta', {}, M2.id);
    const page = await segs({ memoryIds: [M.id, M2.id], parentLoc: '', limit: 200 });
    const byMem = (id: string) => page.items.filter((i: any) => i.memoryId === id).map((i: any) => [i.segment, i.hasNode]);
    expect(byMem(M.id)).toEqual([['notes', true], ['alpha', true]]);
    expect(byMem(M2.id)).toEqual([['beta', true], ['notes', false]]);
    const order = page.items.map((i: any) => i.memoryId);
    expect(order).toEqual([...order].sort());
  });
});

describe('#3456 S5/S7: no existence oracle, never the default scope', () => {
  beforeEach(async () => {
    await mk('secret:one');
    await mk('mine'); // unreadable to the stranger as well: the stranger owns nothing
  });

  it('S5: an unreadable memory, an empty memory and a missing one give the identical empty page', async () => {
    const empty = { items: [], hasMore: false, endCursor: null };
    expect(await segs({ memoryIds: [M.id], parentLoc: '' }, stranger())).toEqual(empty);
    expect(await segs({ memoryIds: [M2.id], parentLoc: '' }, stranger())).toEqual(empty);
    expect(await segs({ memoryIds: [generateId()], parentLoc: '' }, stranger())).toEqual(empty);
    expect(await segs({ memoryIds: ['seg-org:seg/nowhere'], parentLoc: '' }, stranger())).toEqual(empty);
    expect(await segs({ memoryIds: [M2.id], parentLoc: '' })).toEqual(empty); // admin, empty readable memory
    expect(await segs({ memoryIds: [M.id], parentLoc: 'no:such' })).toEqual(empty); // parent with nothing below
  });

  it('S7: naming only an unreadable memory never falls back to the memories the caller can read', async () => {
    // The admin can read both; the stranger can read neither, so use a mixed ask: the readable one is named
    // alongside an unresolvable ref, and the unresolvable ref adds nothing and widens nothing.
    const mixed = await segs({ memoryIds: [M.id, generateId()], parentLoc: '' });
    expect(new Set(mixed.items.map((i: any) => i.memoryId))).toEqual(new Set([M.id]));
    const onlyBad = await segs({ memoryIds: [generateId()], parentLoc: '' });
    expect(onlyBad.items).toEqual([]);
  });

  it('an omitted or empty memoryIds is refused with BAD_USER_INPUT, before any read', async () => {
    await expect(segs({ memoryIds: [], parentLoc: '' })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await expect(segs({ parentLoc: '' })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
});

describe('#3456 input validation', () => {
  it('a malformed parent loc and a foreign cursor are refused, without echoing the value', async () => {
    for (const bad of [':a', 'a:', 'a::b']) {
      await expect(segs({ memoryIds: [M.id], parentLoc: bad })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    }
    const err = await segs({ memoryIds: [M.id], parentLoc: '', after: 'not-a-cursor' }).catch((e: any) => e);
    expect(err.extensions.code).toBe('BAD_USER_INPUT');
    expect(String(err.message)).not.toContain('not-a-cursor');
  });
});
