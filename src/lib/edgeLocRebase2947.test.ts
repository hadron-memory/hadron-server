/**
 * #2947 (rulings 0153, 0154, 0161, 0162; cor:api:190:01, :02): a move keeps derived edge locs in step with their
 * endpoints, an authored loc stays as written, and every edge URN a move changes keeps resolving through an EDGE alias.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolveEdgeRef } from './entityRef/edgeRef.js';
import { EdgeNotFoundError } from './entityRef/errors.js';
import { safeEdgeUrnV2 } from './urnEmit.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/mirrorNodeMove.js', () => ({ mirrorNodeMoveToGit: vi.fn().mockResolvedValue(undefined) }));

let mover: { id: string };
let mem: { id: string; urn: string };
let other: { id: string; urn: string };
const ctx = (): Context => ({ db, userId: mover.id, roles: ['ADMIN'] });
const node = (memoryId: string, loc: string) => db.node.create({
  data: { id: generateId(), memoryId, loc, name: loc, content: `body of ${loc}`, mintedAt: new Date(), mintedByInfo: 'test' },
});
const nodeUrn = (m: { urn: string }, loc: string) => `hrn:node:${m.urn}:${loc}`;
const edgeUrn = (m: { urn: string }, loc: string) => safeEdgeUrnV2(m.urn, loc);
/** Derived: no loc supplied, so createEdge derives `<src>:<name>:<tgt>`. Authored: the caller's loc. */
const link = async (src: { id: string }, tgt: { id: string }, name: string, loc?: string) =>
  (await resolvers.Mutation.createEdge(null, { sourceRef: src.id, targetRef: tgt.id, name, ...(loc ? { loc } : {}) }, ctx())) as { id: string; loc: string };
/** Same memory: `to` in `mem`. Cross memory: `to` in `crossTo` (the full destination URN names the memory). */
const move = (n: { id: string }, to: string, _memory: { urn: string } = mem, crossTo?: { urn: string }) =>
  resolvers.Mutation.moveNode(null, { sourceRef: n.id, targetUrn: nodeUrn(crossTo ?? mem, to) }, ctx());
const edgeNow = (id: string) => db.edge.findUniqueOrThrow({ where: { id } });
const aliases = (id: string) => db.urnAlias.findMany({ where: { entityType: 'EDGE' as never, entityId: id }, orderBy: { urn: 'asc' } });
const bare = (urn: string) => urn.replace(/^hrn:edge:/, '');

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Edge Org', urn: 'edge-org.example' } });
  mover = await db.user.create({ data: { githubId: 294701, githubUsername: 'edge-mover', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: mover.id, role: 'ADMIN' } });
  const m = (name: string) => db.memory.create({ data: {
    id: generateId(), organizationId: org.id, urn: `${org.urn}:${name}`, name, class: 'knowledge', visibility: 'ORGANIZATION',
  } });
  mem = await m('src');
  other = await m('dst');
});

describe('#2947 derived locs rebase on a move (ask 1)', () => {
  it('same memory, SOURCE moved: the loc is the one derivation gives from the new endpoints', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c');
    const e = await link(a, c, 'uses');
    expect(e.loc).toBe('a:uses:c');
    await move(a, 'b');
    expect((await edgeNow(e.id)).loc).toBe('b:uses:c');
  });

  it('same memory, TARGET moved', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c');
    const e = await link(a, c, 'uses');
    await move(c, 'd');
    expect((await edgeNow(e.id)).loc).toBe('a:uses:d');
  });

  it('same memory, both ends inside one moved subtree', async () => {
    const p = await node(mem.id, 'p'); const k = await node(mem.id, 'p:k');
    const e = await link(p, k, 'has');
    await move(p, 'q');
    expect((await edgeNow(e.id)).loc).toBe('q:has:q:k');
  });

  it('cross memory: source moved, target moved (boundary, source stays), both moved', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c');
    const outgoing = await link(a, c, 'uses');           // source moves
    const t = await node(mem.id, 't');
    const s = await node(mem.id, 's');
    const boundary = await link(s, t, 'sees');            // only the target moves
    await move(a, 'a', mem, other);
    await move(t, 't', mem, other);
    const o = await edgeNow(outgoing.id);
    expect(o.loc).toBe('a:uses:c');                       // target c stayed, loc unchanged by derivation
    expect(o.memoryId).toBe(other.id);
    const b = await edgeNow(boundary.id);
    expect(b.memoryId).toBe(mem.id);                      // source stayed
    expect(b.loc).toBe('s:sees:t');
    // Now rename on the way over. Holger's ruling of 2026-11-21 ("don't rebase"): the edge's own memory is not the
    // target's new memory, so the stored loc stays; a rebased loc would hand source-memory readers the destination's loc
    // (and an existence oracle for a guessed one) past the endpoint gate.
    const x = await node(mem.id, 'x'); const y = await node(mem.id, 'y');
    const e = await link(x, y, 'to');
    await move(y, 'y2', mem, other);
    const kept = await edgeNow(e.id);
    expect(kept.loc).toBe('x:to:y');
    expect(kept.memoryId).toBe(mem.id);
    expect(kept.loc).not.toContain('y2');
  });

  it('a rebase onto a slot already held by a live or soft-deleted edge succeeds with a numbered suffix', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c'); const q = await node(mem.id, 'q');
    const e = await link(a, c, 'uses');
    // An unrelated edge row holds the slot the rebase wants (`z:uses:c`), live in one run and soft-deleted in the other.
    for (const [i, deletedAt] of [new Date(), null].entries()) {
      const holder = await db.edge.create({ data: { id: generateId(), memoryId: mem.id, sourceId: q.id, targetId: c.id, loc: i === 0 ? 'z:uses:c' : 'z:uses:c:2', name: 'held', deletedAt } });
      void holder;
    }
    await move(a, 'z');
    expect((await edgeNow(e.id)).loc).toBe('z:uses:c:3');
  });

  it('a rebase onto the moved subtree\'s own old slots works (no mid-transaction unique trip)', async () => {
    const top = await node(mem.id, 'a:b'); const deep = await node(mem.id, 'a:b:b'); const c = await node(mem.id, 'c');
    const e1 = await link(top, c, 'r');                   // a:b:r:c
    const e2 = await link(deep, c, 'r');                  // a:b:b:r:c
    await move(top, 'a');                                 // a:b:b -> a:b takes the source's old node slot
    expect((await edgeNow(e1.id)).loc).toBe('a:r:c');
    expect((await edgeNow(e2.id)).loc).toBe('a:b:r:c');   // e1's old edge slot
  });
});

describe('#2947 the old edge URN keeps resolving (ask 2, ruling 0162)', () => {
  it('a same-memory rebase aliases the old URN to the live edge; a live occupant wins', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c');
    const e = await link(a, c, 'uses');
    const oldUrn = edgeUrn(mem, 'a:uses:c');
    await move(a, 'b');
    expect((await aliases(e.id)).map((r) => r.urn)).toEqual([bare(oldUrn)]);
    expect(await resolveEdgeRef(db, oldUrn)).toEqual({ id: e.id });
    expect((await resolvers.Query.edge(null, { ref: oldUrn }, ctx()))?.id).toBe(e.id);
    // The new URN resolves too.
    expect(await resolveEdgeRef(db, edgeUrn(mem, 'b:uses:c'))).toEqual({ id: e.id });
    // A live edge later at the old loc beats the alias.
    const a2 = await node(mem.id, 'a');
    const occupant = await link(a2, c, 'uses');
    expect(await resolveEdgeRef(db, oldUrn)).toEqual({ id: occupant.id });
  });

  it('a cross-memory rebase aliases the old URN in the OLD memory', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c');
    const e = await link(a, c, 'uses');
    await move(a, 'a2', mem, other);
    const now = await edgeNow(e.id);
    expect(now.memoryId).toBe(other.id);
    expect(now.loc).toBe('a2:uses:c');
    expect(await resolveEdgeRef(db, edgeUrn(mem, 'a:uses:c'))).toEqual({ id: e.id });
    expect(await resolveEdgeRef(db, edgeUrn(other, 'a2:uses:c'))).toEqual({ id: e.id });
  });

  it('the old URN of an edge carried out of a memory still resolves after that memory is gone', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c');
    const e = await link(a, c, 'uses');
    await move(a, 'a2', mem, other);
    await db.memory.update({ where: { id: mem.id }, data: { deletedAt: new Date() } });
    // The old memory no longer resolves, so only the EDGE alias can answer; the edge it names is live in the new memory.
    expect(await resolveEdgeRef(db, edgeUrn(mem, 'a:uses:c'))).toEqual({ id: e.id });
  });

  it('a soft-deleted edge is not resurrected by its alias', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c');
    const e = await link(a, c, 'uses');
    await move(a, 'b');
    await db.edge.update({ where: { id: e.id }, data: { deletedAt: new Date() } });
    await expect(resolveEdgeRef(db, edgeUrn(mem, 'a:uses:c'))).rejects.toBeInstanceOf(EdgeNotFoundError);
  });
});

describe('#2947 authored locs are unchanged (ask 3, rulings 0154, 0161)', () => {
  it('same memory: keeps loc and URN, writes no alias', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c');
    const e = await link(a, c, 'uses', 'my-own-loc');
    await move(a, 'b');
    expect((await edgeNow(e.id)).loc).toBe('my-own-loc');
    expect(await aliases(e.id)).toEqual([]);
  });

  it('an authored loc that equals the derivation stays authored (recorded, not inferred)', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c');
    const e = await link(a, c, 'uses', 'a:uses:c');
    await move(a, 'b');
    expect((await edgeNow(e.id)).loc).toBe('a:uses:c');
    expect(await aliases(e.id)).toEqual([]);
  });

  it('cross memory: the authored outgoing edge keeps its loc, and its old URN (old memory) resolves via an alias', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c');
    const e = await link(a, c, 'uses', 'my-own-loc');
    await move(a, 'a', mem, other);
    const now = await edgeNow(e.id);
    expect(now).toMatchObject({ loc: 'my-own-loc', memoryId: other.id });
    expect(await resolveEdgeRef(db, edgeUrn(mem, 'my-own-loc'))).toEqual({ id: e.id });
    expect(await resolveEdgeRef(db, edgeUrn(other, 'my-own-loc'))).toEqual({ id: e.id });
  });

  it('cross memory collision: a numbered suffix, the move proceeds, the old URN resolves to the renumbered edge', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c');
    const e = await link(a, c, 'uses', 'taken');
    const hold = await node(other.id, 'h'); const hold2 = await node(other.id, 'h2');
    const held = await link(hold, hold2, 'x', 'taken');
    await db.edge.update({ where: { id: held.id }, data: { deletedAt: new Date() } }); // soft-deleted holder still blocks
    await move(a, 'a', mem, other);
    const now = await edgeNow(e.id);
    expect(now.memoryId).toBe(other.id);
    expect(now.loc).toBe('taken:2');
    expect(await resolveEdgeRef(db, edgeUrn(mem, 'taken'))).toEqual({ id: e.id });
  });
});
