/**
 * #860 — `hadron_update_node` had one way to change a node's edges: `edges`, which REPLACES the whole outgoing set (#835
 * made the hazard legible and gave single-edge tools; this makes the safe thing the easy thing). Holger's ruling (option 2,
 * additive): `addEdges` and `removeEdges` next to `edges`, refused together with it, `edges` itself unchanged.
 *
 * Contract pinned here (gate AT0.10023, Victor's FIT AT0.10017.1):
 * - add keeps every other edge; remove drops only the named ones; one call may do both (remove, then add, one transaction);
 * - `removeEdges` is `deleteEdge`'s door per item: unknown, another node's edge and an edge in an unreadable memory all get
 *   the same `Edge not found` text; one refused item refuses the call and writes nothing; governed edges keep their refusal;
 * - an idempotent re-add reads `unchanged`, not `added`, and creates no duplicate;
 * - the call mirrors once (one node-written event), after the commit.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { publishNodeWritten } from '../lib/events/nodeWritten.js';
import { deleteEdgeInDoorTx, nodeDoorTxContext } from '../api/graphql/schema/resolvers.mutation.node.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));
vi.mock('../lib/events/nodeWritten.js', async (orig) => ({
  ...(await orig<typeof import('../lib/events/nodeWritten.js')>()),
  publishNodeWritten: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../api/graphql/schema/resolvers.mutation.node.js', async (orig) => {
  const real = await orig<typeof import('../api/graphql/schema/resolvers.mutation.node.js')>();
  return { ...real, deleteEdgeInDoorTx: vi.fn(real.deleteEdgeInDoorTx) };
});

let adminId: string;
let memId: string;
let memUrn: string;
let source: { id: string; loc: string };
let other: { id: string; loc: string };
let t1: { id: string; loc: string };
let t2: { id: string; loc: string };
let t3: { id: string; loc: string };
let t4: { id: string; loc: string };
let e1: { id: string; loc: string };
let e2: { id: string; loc: string };
let e3: { id: string; loc: string };

const admin = (): Context => ({ db, roles: ['ADMIN'], userId: adminId } as Context);
const adminAuth = (): AuthContext => ({ userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` });
const callAs = (auth: AuthContext, tool: string, args: Record<string, unknown>): Promise<string> =>
  createTestableMcpServer(auth).callToolText(tool, args);
const call = (tool: string, args: Record<string, unknown>) => callAs(adminAuth(), tool, args);
const nodeUrnOf = (loc: string) => `${memUrn.replace(':', '::')}::${loc}`;

const node = (loc: string, name: string) =>
  db.node.create({ data: { id: generateId(), memoryId: memId, loc, name, ownerRepo: 'test/repo', tags: [] } });
const edgeFrom = async (src: { id: string; loc: string }, target: { id: string; loc: string }, name: string) => {
  const loc = `${src.loc}:${name}:${target.id.slice(0, 6)}`;
  const row = await db.edge.create({
    data: { id: generateId(), memoryId: memId, sourceId: src.id, targetId: target.id, name, loc },
  });
  return { id: row.id, loc };
};
const edgesOf = (src = source) => db.edge.findMany({ where: { sourceId: src.id }, orderBy: { name: 'asc' } });
const namesOf = async (src = source) => (await edgesOf(src)).map((e) => e.name);

beforeEach(async () => {
  vi.mocked(publishNodeWritten).mockClear();
  vi.mocked(deleteEdgeInDoorTx).mockClear();
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'e860-org', urn: 'e860-org' } });
  const a = await db.user.create({ data: { githubId: 8601, githubUsername: 'e860-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: a.id, role: 'ADMIN' } });
  adminId = a.id;
  const mem = await resolvers.Mutation.createMemory({}, { orgRef: org.id, name: 'edges860' }, admin());
  memId = mem.id;
  memUrn = mem.urn;
  source = await node('review:item', 'Item');
  other = await node('review:other', 'Other source');
  t1 = await node('review', 'Review');
  t2 = await node('docs:guide', 'Guide');
  t3 = await node('rel:other', 'Other');
  t4 = await node('rel:fresh', 'Fresh');
  e1 = await edgeFrom(source, t1, 'applies-when');
  e2 = await edgeFrom(source, t2, 'documented-by');
  e3 = await edgeFrom(source, t3, 'relates-to');
});

describe('addEdges (#860)', () => {
  it('adds an edge and keeps every sibling (edges: would have dropped them)', async () => {
    const out = await call('hadron_update_node', {
      urn: nodeUrnOf(source.loc),
      addEdges: [{ targetUrn: t4.id, name: 'seen-with' }],
    });
    expect(out).toContain('Node updated');
    expect(await namesOf()).toEqual(['applies-when', 'documented-by', 'relates-to', 'seen-with']);
    expect(out).toMatch(/edges: 1 added, 0 unchanged, 0 removed/);
  });

  it('an idempotent re-add reads unchanged, not created, and leaves one row', async () => {
    const args = { urn: nodeUrnOf(source.loc), addEdges: [{ targetUrn: t4.id, name: 'seen-with' }] };
    expect(await call('hadron_update_node', args)).toMatch(/1 added, 0 unchanged/);
    const again = await call('hadron_update_node', args);
    expect(again).toMatch(/edges: 0 added, 1 unchanged, 0 removed/);
    expect((await edgesOf()).filter((e) => e.name === 'seen-with')).toHaveLength(1);
  });

  it('an occupied loc with a different edge refuses the whole call and writes nothing', async () => {
    const out = await call('hadron_update_node', {
      urn: nodeUrnOf(source.loc),
      addEdges: [{ targetUrn: t4.id, name: 'fresh-one' }, { targetUrn: t4.id, name: 'x', loc: e1.loc }],
    });
    expect(out).toContain('edge_loc_conflict');
    expect(await namesOf()).toEqual(['applies-when', 'documented-by', 'relates-to']);
  });

  it('the same loc aimed at a DIFFERENT target is a conflict, not an idempotent re-add (Rook P3)', async () => {
    // e1 sits at e1.loc with target t1; the same loc, name and fields but target t4 is another edge.
    const row = await db.edge.findUniqueOrThrow({ where: { id: e1.id } });
    const out = await call('hadron_update_node', {
      urn: nodeUrnOf(source.loc),
      addEdges: [{ targetUrn: t4.id, name: row.name ?? undefined, loc: e1.loc }],
    });
    expect(out).toContain('edge_loc_conflict');
    const after = await db.edge.findUniqueOrThrow({ where: { id: e1.id } });
    expect(after.targetId).toBe(t1.id);
    expect(await namesOf()).toEqual(['applies-when', 'documented-by', 'relates-to']);
  });

  it('an unresolvable target refuses the whole call and writes nothing', async () => {
    const out = await call('hadron_update_node', {
      urn: nodeUrnOf(source.loc),
      addEdges: [{ targetUrn: t4.id, name: 'ok' }, { targetUrn: generateId(), name: 'ghost' }],
    });
    expect(out).toMatch(/Edge target not found/);
    expect(await namesOf()).toEqual(['applies-when', 'documented-by', 'relates-to']);
  });
});

describe('addEdges far-end read gate and re-add identity (#860, Juniper)', () => {
  it('a non-admin writer cannot point an edge at a node in a memory they cannot read, and learns nothing from the refusal', async () => {
    const org3 = await db.organization.create({ data: { id: generateId(), name: 'e860-org3', urn: 'e860-org3' } });
    const u3 = await db.user.create({ data: { githubId: 8604, githubUsername: 'e860-writer', roles: ['READER'] } });
    await db.orgMember.create({ data: { organizationId: org3.id, userId: u3.id, role: 'ADMIN' } });
    const own = await resolvers.Mutation.createMemory({}, { orgRef: org3.id, name: 'own' }, { db, roles: ['READER'], userId: u3.id } as Context);
    const mine = await db.node.create({ data: { id: generateId(), memoryId: own.id, loc: 'mine', name: 'mine', ownerRepo: 'x/y', tags: [] } });
    const mine2 = await db.node.create({ data: { id: generateId(), memoryId: own.id, loc: 'mine2', name: 'mine2', ownerRepo: 'x/y', tags: [] } });
    const auth: AuthContext = { userId: u3.id, roles: ['READER'], clientId: `user:${u3.id}` };
    const urn = `${own.urn.replace(':', '::')}::mine`;
    // t1 lives in the admin's memory, which this writer cannot read: the same text as a target that does not exist.
    const hidden = await callAs(auth, 'hadron_update_node', { urn, addEdges: [{ targetUrn: t1.id, name: 'peek' }] });
    const ghost = await callAs(auth, 'hadron_update_node', { urn, addEdges: [{ targetUrn: generateId(), name: 'peek' }] });
    expect(hidden).toMatch(/^Edge target not found/);
    expect(hidden.replace(t1.id, '<id>')).toBe(ghost.replace(/"[^"]+"/, '"<id>"').replace('<id>', '<id>'));
    expect(await db.edge.count({ where: { sourceId: mine.id } })).toBe(0);
    // Control: a target the writer can read is added.
    const ok = await callAs(auth, 'hadron_update_node', { urn, addEdges: [{ targetUrn: mine2.id, name: 'friend' }] });
    expect(ok).toMatch(/1 added/);
    expect(await db.edge.count({ where: { sourceId: mine.id } })).toBe(1);
  });

  it.each([
    ['name', { name: 'applies-when-OTHER' }],
    ['description', { description: 'a different description' }],
    ['isRunnable', { isRunnable: true }],
  ])('re-adding the same loc and target with a different %s is a conflict, not unchanged', async (_field, change) => {
    const row = await db.edge.findUniqueOrThrow({ where: { id: e1.id } });
    const out = await call('hadron_update_node', {
      urn: nodeUrnOf(source.loc),
      addEdges: [{ targetUrn: t1.id, name: row.name ?? undefined, loc: e1.loc, ...change }],
    });
    expect(out).toContain('edge_loc_conflict');
    const after = await db.edge.findUniqueOrThrow({ where: { id: e1.id } });
    expect(after.name).toBe(row.name);
    expect(after.description).toBe(row.description);
    expect(after.isRunnable).toBe(row.isRunnable);
  });

  it('re-adding the identical edge (same loc, target, name, description, isRunnable) is unchanged', async () => {
    const row = await db.edge.findUniqueOrThrow({ where: { id: e1.id } });
    const out = await call('hadron_update_node', {
      urn: nodeUrnOf(source.loc),
      addEdges: [{ targetUrn: t1.id, name: row.name ?? undefined, loc: e1.loc }],
    });
    expect(out).toMatch(/0 added, 1 unchanged/);
  });
});

describe('removeEdges (#860)', () => {
  it('removes only the named edge, by id', async () => {
    const out = await call('hadron_update_node', { urn: nodeUrnOf(source.loc), removeEdges: [e2.id] });
    expect(out).toMatch(/edges: 0 added, 0 unchanged, 1 removed/);
    expect(await namesOf()).toEqual(['applies-when', 'relates-to']);
  });

  it('accepts an hrn:edge URN, as hadron_delete_edge does', async () => {
    const out = await call('hadron_update_node', {
      urn: nodeUrnOf(source.loc),
      removeEdges: [`${memUrn.replace(':', '::')}::${e3.loc}`],
    });
    expect(out).toContain('Node updated');
    expect(await namesOf()).toEqual(['applies-when', 'documented-by']);
  });

  it('naming the same edge twice removes it once', async () => {
    const out = await call('hadron_update_node', { urn: nodeUrnOf(source.loc), removeEdges: [e1.id, e1.id] });
    expect(out).toMatch(/1 removed/);
    expect(await namesOf()).toEqual(['documented-by', 'relates-to']);
  });

  it('refuses an unknown, a foreign-readable and an unreadable-memory edge with the same text, and keeps the node whole', async () => {
    const foreign = await edgeFrom(other, t1, 'foreign');
    // An edge the caller cannot read at all: a second user's own memory.
    const org2 = await db.organization.create({ data: { id: generateId(), name: 'e860-org2', urn: 'e860-org2' } });
    const u2 = await db.user.create({ data: { githubId: 8602, githubUsername: 'e860-other', roles: ['READER'] } });
    await db.orgMember.create({ data: { organizationId: org2.id, userId: u2.id, role: 'ADMIN' } });
    const mem2 = await resolvers.Mutation.createMemory({}, { orgRef: org2.id, name: 'private' }, { db, roles: ['READER'], userId: u2.id } as Context);
    const s2 = await db.node.create({ data: { id: generateId(), memoryId: mem2.id, loc: 's', name: 's', ownerRepo: 'x/y', tags: [] } });
    const t2b = await db.node.create({ data: { id: generateId(), memoryId: mem2.id, loc: 't', name: 't', ownerRepo: 'x/y', tags: [] } });
    const hidden = await db.edge.create({ data: { id: generateId(), memoryId: mem2.id, sourceId: s2.id, targetId: t2b.id, name: 'hidden', loc: 's:hidden:t' } });

    const norm = (text: string, ref: string) => text.split(ref).join('<ref>');
    const ask = async (ref: string) => call('hadron_update_node', { urn: nodeUrnOf(source.loc), removeEdges: [ref] });
    const unknown = generateId();
    const outs = [
      norm(await ask(unknown), unknown),
      norm(await ask(foreign.id), foreign.id),
      norm(await ask(hidden.id), hidden.id),
    ];
    expect(outs[0]).toBe('Edge not found: "<ref>"');
    expect(outs[1]).toBe(outs[0]);
    expect(outs[2]).toBe(outs[0]);
    // deleteEdge's own answer for the same unknown ref is the same text.
    const del = await call('hadron_delete_edge', { edgeRef: unknown });
    expect(norm(del, unknown)).toBe(outs[0]);
    expect(await namesOf()).toEqual(['applies-when', 'documented-by', 'relates-to']);
    expect(await namesOf(other)).toEqual(['foreign']);
    expect(await db.edge.count({ where: { id: hidden.id } })).toBe(1);
  });

  it('one refused item refuses the whole call: nothing removed, nothing added', async () => {
    const out = await call('hadron_update_node', {
      urn: nodeUrnOf(source.loc),
      removeEdges: [e1.id, generateId()],
      addEdges: [{ targetUrn: t4.id, name: 'never' }],
    });
    expect(out).toMatch(/^Edge not found/);
    expect(await namesOf()).toEqual(['applies-when', 'documented-by', 'relates-to']);
    expect(vi.mocked(publishNodeWritten)).not.toHaveBeenCalled();
  });

  it('refuses a governed (derived include) edge with deleteEdge\'s own refusal, and removes nothing', async () => {
    const inc = await db.edge.create({
      data: { id: generateId(), memoryId: memId, sourceId: source.id, targetId: t4.id, name: 'include', loc: `${source.loc}:include:x`, governedKind: 'INCLUDE' },
    });
    const viaDelete = await call('hadron_delete_edge', { edgeRef: inc.id });
    const out = await call('hadron_update_node', { urn: nodeUrnOf(source.loc), removeEdges: [e1.id, inc.id] });
    expect(out).toBe(viaDelete.replace(/^/, ''));
    expect(await db.edge.count({ where: { id: { in: [e1.id, inc.id] } } })).toBe(2);
  });

  it('a pending edge cannot be named: it is unknown here (the accepted limit)', async () => {
    const pending = await db.pendingEdge.create({
      data: { id: generateId(), sourceId: source.id, targetId: 'not:there:yet', name: 'later', loc: `${source.loc}:later:nt` },
    });
    const out = await call('hadron_update_node', { urn: nodeUrnOf(source.loc), removeEdges: [pending.id] });
    expect(out).toBe(`Edge not found: "${pending.id}"`);
    expect(await db.pendingEdge.count({ where: { id: pending.id } })).toBe(1);
  });
});

describe('removeEdges re-checks the source under the edge lock and takes deleteEdge\'s locks (#860, BLIND P2-1 and P2-2)', () => {
  it('the shared door refuses an edge that is no longer the expected source\'s, and deletes nothing', async () => {
    // The preflight read the edge\'s source without a lock; by the time the door holds the edge row lock the edge may be
    // another node\'s. Modelled directly: an edge of `other`, asked for as `source`\'s.
    const foreign = await edgeFrom(other, t1, 'foreign');
    await expect(db.$transaction(async (tx) => {
      const ctx = await nodeDoorTxContext(admin(), tx, [memId]);
      await deleteEdgeInDoorTx(tx, ctx, { edgeId: foreign.id, edgeRef: foreign.id, memoryId: memId, expectedSourceId: source.id });
    })).rejects.toMatchObject({ extensions: { code: 'EDGE_NOT_FOUND' } });
    expect(await db.edge.count({ where: { id: foreign.id } })).toBe(1);
    // Without the expectation (deleteEdge\'s own call) the same door deletes it: the check is the new part.
    await db.$transaction(async (tx) => {
      const ctx = await nodeDoorTxContext(admin(), tx, [memId]);
      await deleteEdgeInDoorTx(tx, ctx, { edgeId: foreign.id, edgeRef: foreign.id, memoryId: memId });
    });
    expect(await db.edge.count({ where: { id: foreign.id } })).toBe(0);
  });

  it('removeEdges calls the shared door with this node as the expected source and the EDGE\'s own memory (BLIND P2-1, P2-3)', async () => {
    await call('hadron_update_node', { urn: nodeUrnOf(source.loc), removeEdges: [e1.id, e2.id] });
    const calls = vi.mocked(deleteEdgeInDoorTx).mock.calls.map((c) => c[2]);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.expectedSourceId).toBe(source.id);
      expect(c.memoryId).toBe(memId);
    }
    expect(calls.map((c) => c.edgeId).sort()).toEqual([e1.id, e2.id].sort());
  });

  it('a removal waits for a concurrent writer of the memory row, as deleteEdge does (memory FOR SHARE first)', async () => {
    let signalHeld!: () => void;
    let signalRelease!: () => void;
    const held = new Promise<void>((r) => { signalHeld = r; });
    const release = new Promise<void>((r) => { signalRelease = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memId} FOR UPDATE`;
      signalHeld();
      await release;
    }, { timeout: 20_000 });
    await held;
    let done = false;
    const removing = call('hadron_update_node', { urn: nodeUrnOf(source.loc), removeEdges: [e2.id] }).then((out) => { done = true; return out; });
    await new Promise((r) => setTimeout(r, 600));
    expect(done).toBe(false);          // blocked behind the memory row lock
    signalRelease();
    await holder;
    expect(await removing).toMatch(/1 removed/);
    expect(await namesOf()).toEqual(['applies-when', 'relates-to']);
  });
});

describe('pending edges are left alone (#860, Victor\'s FIT)', () => {
  it('addEdges and removeEdges never touch the source\'s pending edges (only an `edges` replace drops them)', async () => {
    const pending = await db.pendingEdge.create({
      data: { id: generateId(), sourceId: source.id, targetId: 'not:there:yet', name: 'later', loc: `${source.loc}:later:nt` },
    });
    const out = await call('hadron_update_node', {
      urn: nodeUrnOf(source.loc),
      removeEdges: [e1.id],
      addEdges: [{ targetUrn: t4.id, name: 'seen-with' }],
    });
    expect(out).toMatch(/edges: 1 added, 0 unchanged, 1 removed/);
    expect(await db.pendingEdge.count({ where: { id: pending.id } })).toBe(1);
    // Add alone and remove alone likewise.
    await call('hadron_update_node', { urn: nodeUrnOf(source.loc), addEdges: [{ targetUrn: t4.id, name: 'again' }] });
    await call('hadron_update_node', { urn: nodeUrnOf(source.loc), removeEdges: [e2.id] });
    expect(await db.pendingEdge.count({ where: { id: pending.id } })).toBe(1);
    // The replace path is the one that drops it (the contract the tool text states).
    await call('hadron_update_node', { urn: nodeUrnOf(source.loc), edges: [{ targetUrn: t1.id, name: 'applies-when' }] });
    expect(await db.pendingEdge.count({ where: { id: pending.id } })).toBe(0);
  });
});

describe('add and remove together (#860)', () => {
  it('removes first, then adds, in one call and one event', async () => {
    const out = await call('hadron_update_node', {
      urn: nodeUrnOf(source.loc),
      removeEdges: [e1.id],
      addEdges: [{ targetUrn: t4.id, name: 'seen-with' }],
    });
    expect(out).toMatch(/edges: 1 added, 0 unchanged, 1 removed/);
    expect(await namesOf()).toEqual(['documented-by', 'relates-to', 'seen-with']);
    expect(vi.mocked(publishNodeWritten)).toHaveBeenCalledTimes(1);
  });

  it('the same edge in both stands as added (it is re-created)', async () => {
    const out = await call('hadron_update_node', {
      urn: nodeUrnOf(source.loc),
      removeEdges: [e1.id],
      addEdges: [{ targetUrn: t1.id, name: 'applies-when', loc: e1.loc }],
    });
    expect(out).toMatch(/edges: 1 added, 0 unchanged, 1 removed/);
    const kept = (await edgesOf()).find((e) => e.name === 'applies-when');
    expect(kept?.loc).toBe(e1.loc);
    expect(kept?.id).not.toBe(e1.id);
  });

  it('does not touch the node\'s revision or content', async () => {
    const before = await db.node.findUnique({ where: { id: source.id } });
    await call('hadron_update_node', { urn: nodeUrnOf(source.loc), addEdges: [{ targetUrn: t4.id, name: 'seen-with' }] });
    const after = await db.node.findUnique({ where: { id: source.id } });
    expect(after?.content).toBe(before?.content);
    expect(after?.name).toBe(before?.name);
  });
});

describe('the argument rules (#860)', () => {
  it('edges together with addEdges or removeEdges is refused, and nothing is written', async () => {
    for (const extra of [{ addEdges: [{ targetUrn: t4.id, name: 'x' }] }, { removeEdges: [e1.id] }]) {
      const out = await call('hadron_update_node', {
        urn: nodeUrnOf(source.loc),
        edges: [{ targetUrn: t1.id, name: 'applies-when' }],
        ...extra,
      });
      expect(out).toMatch(/cannot be combined/);
      expect(await namesOf()).toEqual(['applies-when', 'documented-by', 'relates-to']);
    }
  });

  it('edges alone is unchanged: it still replaces the whole set (the #835 contract)', async () => {
    const out = await call('hadron_update_node', {
      urn: nodeUrnOf(source.loc),
      edges: [{ targetUrn: t1.id, name: 'applies-when-renamed' }],
    });
    expect(out).not.toMatch(/edges: \d+ added/);
    expect(await namesOf()).toEqual(['applies-when-renamed']);
  });

  it('a caller without write access learns nothing from the refusals', async () => {
    const reader = await db.user.create({ data: { githubId: 8603, githubUsername: 'e860-reader', roles: ['READER'] } });
    const auth: AuthContext = { userId: reader.id, roles: ['READER'], clientId: `user:${reader.id}` };
    const out = await callAs(auth, 'hadron_update_node', { urn: nodeUrnOf(source.loc), removeEdges: [e1.id], addEdges: [{ targetUrn: t4.id }] });
    expect(out).not.toMatch(/Edge not found|Edge target not found|1 added/);
    expect(await namesOf()).toEqual(['applies-when', 'documented-by', 'relates-to']);
  });
});
