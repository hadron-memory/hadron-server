/**
 * #781 — Edge.source / Edge.target endpoint gate.
 *
 * `edge`/`edges` authorize a read on the denormalized `Edge.memoryId`, and
 * `Node.incomingEdges` reaches edges whose memoryId the caller never authorized.
 * The endpoint resolvers used to load the endpoint node by FK with NO re-check,
 * so a cross-memory edge (source in memory A, target in memory B) let a caller
 * who can read only one side resolve the far node — a cross-tenant leak. The
 * resolvers now return null for an endpoint whose memory the caller can't read,
 * routed through the shared getAccessibleMemoryIds gate.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbNode } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const E = resolvers.Edge as any;

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let member: { id: string }; // member of orgA only
let admin: { id: string };  // platform ADMIN
let memA: { id: string };   // orgA knowledge memory — member can read
let memB: { id: string };   // orgB knowledge memory — member CANNOT read
let nodeA: { id: string; loc: string };
let nodeB: { id: string; loc: string };

const ctx = (userId?: string, roles: Context['roles'] = ['READER']): Context =>
  ({ db, userId, roles });

beforeEach(async () => {
  await cleanDb(db);
  orgA = await db.organization.create({ data: { id: generateId(), name: 'egA', urn: `egA-${Date.now()}` } });
  orgB = await db.organization.create({ data: { id: generateId(), name: 'egB', urn: `egB-${Date.now()}` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 90101, githubUsername: 'eg-member' } });
  admin = await db.user.create({ data: { id: generateId(), githubId: 90102, githubUsername: 'eg-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: member.id, role: 'READER' } });

  memA = await db.memory.create({
    data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:a`, name: 'a', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  memB = await db.memory.create({
    data: { id: generateId(), organizationId: orgB.id, urn: `${orgB.urn}:b`, name: 'b', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  nodeA = await createDbNode(db, { loc: 'na', memoryId: memA.id });
  nodeB = await createDbNode(db, { loc: 'nb', memoryId: memB.id });
});

// A cross-memory edge row: source in memA, target in memB (edge.memoryId = memA,
// the source side). Both the not-preloaded (lazy-load) and preloaded shapes.
const crossEdge = () => ({
  id: generateId(),
  memoryId: memA.id,
  sourceId: nodeA.id,
  targetId: nodeB.id,
  name: 'rel',
});

describe('Edge.source / Edge.target cross-memory gate (#781)', () => {
  it('returns the readable endpoint and NULLs the unreadable one (lazy load)', async () => {
    const e = crossEdge();
    // member can read memA (source) but not memB (target).
    expect((await E.source(e, {}, ctx(member.id)))?.id).toBe(nodeA.id);
    expect(await E.target(e, {}, ctx(member.id))).toBeNull();
  });

  it('gates a PRELOADED endpoint too (not just the lazy path)', async () => {
    const full = { ...crossEdge(), source: { ...nodeA, memoryId: memA.id }, target: { ...nodeB, memoryId: memB.id } };
    expect((await E.source(full, {}, ctx(member.id)))?.id).toBe(nodeA.id);
    expect(await E.target(full, {}, ctx(member.id))).toBeNull();
  });

  it('gates the SOURCE side of an incoming cross-memory edge (source in the unreadable memory)', async () => {
    // Edge from memB → memA (e.g. reached via nodeA's incomingEdges). edge.memoryId
    // is the source side (memB), which the member never authorized.
    const incoming = { id: generateId(), memoryId: memB.id, sourceId: nodeB.id, targetId: nodeA.id, name: 'rel' };
    expect(await E.source(incoming, {}, ctx(member.id))).toBeNull(); // memB source hidden
    expect((await E.target(incoming, {}, ctx(member.id)))?.id).toBe(nodeA.id); // memA target visible
  });

  it('returns BOTH endpoints for a same-memory edge (the common case is unaffected)', async () => {
    const nodeA2 = await createDbNode(db, { loc: 'na2', memoryId: memA.id });
    const sameMem = { id: generateId(), memoryId: memA.id, sourceId: nodeA.id, targetId: nodeA2.id, name: 'rel' };
    expect((await E.source(sameMem, {}, ctx(member.id)))?.id).toBe(nodeA.id);
    expect((await E.target(sameMem, {}, ctx(member.id)))?.id).toBe(nodeA2.id);
  });

  it('a platform admin resolves both endpoints across memories', async () => {
    const e = crossEdge();
    expect((await E.source(e, {}, ctx(admin.id, ['ADMIN'])))?.id).toBe(nodeA.id);
    expect((await E.target(e, {}, ctx(admin.id, ['ADMIN'])))?.id).toBe(nodeB.id);
  });

  it('resolves endpoints of a same-memory SYSTEM edge via the fast path (#781 review P2)', async () => {
    // getAccessibleMemoryIds omits app/system-class org memories (reachable via
    // appNodes' broader auth), so a per-endpoint node-content check would null
    // them. The same-memory fast path (edge + both endpoints share one memory)
    // returns them without a per-endpoint check — no over-restriction.
    const sysMem = await db.memory.create({
      data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:sys`, name: 'sys', class: 'system', visibility: null },
    });
    const s1 = await createDbNode(db, { loc: 's1', memoryId: sysMem.id });
    const s2 = await createDbNode(db, { loc: 's2', memoryId: sysMem.id });
    const e = { id: generateId(), memoryId: sysMem.id, sourceId: s1.id, targetId: s2.id, name: 'rel' };
    expect((await E.source(e, {}, ctx(member.id)))?.id).toBe(s1.id);
    expect((await E.target(e, {}, ctx(member.id)))?.id).toBe(s2.id);
  });

  it('does NOT apply the fast path when Edge.memoryId is STALE vs the endpoints (#781 review P1)', async () => {
    // A cross-memory node move can leave an A→B edge's memoryId at A while both
    // endpoints now live in B. Edge/edges still authorize it as memory A, so a
    // caller who can read only A must NOT get the B nodes via the same-memory
    // shortcut. Both endpoints are in memB (unreadable) but edge.memoryId = memA.
    const b1 = await createDbNode(db, { loc: 'b1', memoryId: memB.id });
    const b2 = await createDbNode(db, { loc: 'b2', memoryId: memB.id });
    const staleEdge = { id: generateId(), memoryId: memA.id, sourceId: b1.id, targetId: b2.id, name: 'rel' };
    expect(await E.source(staleEdge, {}, ctx(member.id))).toBeNull(); // memB, gated
    expect(await E.target(staleEdge, {}, ctx(member.id))).toBeNull();
  });

  it('a caller who can read NEITHER memory gets null for both', async () => {
    const stranger = await db.user.create({ data: { id: generateId(), githubId: 90103, githubUsername: 'eg-stranger' } });
    const e = crossEdge();
    expect(await E.source(e, {}, ctx(stranger.id))).toBeNull();
    expect(await E.target(e, {}, ctx(stranger.id))).toBeNull();
  });
});

/**
 * #755 — the WRITE half of the same story. `createNode`/`updateNode` resolve
 * inline `edges: [{ targetId }]` through `resolveNodeRef` with no gate on the
 * resolved target's memory, while the standalone `createEdge` requires write on
 * the source and read on the target ("Without this any CONTRIBUTOR could write
 * an edge into a memory they can't touch").
 *
 * Left open, that plants an edge pointing at a node the caller can't read;
 * paired with endpoint hydration it was a cross-tenant read primitive. The
 * #781 gate above blocks the read-back, but the write must be refused too —
 * defense in depth, and the edge row itself is a disclosure (it names a
 * foreign node id) plus a write-integrity violation.
 */
describe('createNode/updateNode inline edge targets — cross-memory gate (#755)', () => {
  let contributor: { id: string }; // CONTRIBUTOR in orgA: can write memA, cannot read memB

  const asContributor = (): Context => ({ db, userId: contributor.id, roles: ['CONTRIBUTOR'] });

  beforeEach(async () => {
    contributor = await db.user.create({
      data: { id: generateId(), githubId: 90103, githubUsername: 'eg-contrib', roles: ['CONTRIBUTOR'] },
    });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: orgA.id, userId: contributor.id, role: 'CONTRIBUTOR' },
    });
  });

  it('createNode refuses an inline edge into a memory the caller cannot read', async () => {
    await expect(
      resolvers.Mutation.createNode(
        {},
        { input: { memoryId: memA.id, loc: 'exfil', name: 'exfil', edges: [{ targetId: nodeB.id, name: 'rel' }] } as never },
        asContributor(),
      ),
    ).rejects.toThrow(/Edge target not found/);
    // Nothing was written — neither the node nor a dangling edge.
    expect(await db.node.count({ where: { loc: 'exfil', memoryId: memA.id } })).toBe(0);
    expect(await db.edge.count({ where: { targetId: nodeB.id } })).toBe(0);
  });

  it('updateNode refuses the same inline edge', async () => {
    const own = await createDbNode(db, { loc: 'mine', memoryId: memA.id });
    await expect(
      resolvers.Mutation.updateNode(
        {},
        { input: { id: own.id, edges: [{ targetId: nodeB.id, name: 'rel' }] } as never },
        asContributor(),
      ),
    ).rejects.toThrow(/Edge target not found/);
    expect(await db.edge.count({ where: { sourceId: own.id } })).toBe(0);
  });

  it('the denial is indistinguishable from a genuine miss (no existence oracle)', async () => {
    const attempt = (targetId: string) =>
      resolvers.Mutation.createNode(
        {},
        { input: { memoryId: memA.id, loc: `probe-${targetId.slice(0, 6)}`, name: 'p', edges: [{ targetId, name: 'rel' }] } as never },
        asContributor(),
      ).then(() => null, (e: Error) => e.message.replace(targetId, '<REF>'));

    const bogusId = generateId();
    expect(await attempt(nodeB.id)).toBe(await attempt(bogusId));
    expect(await attempt(nodeB.id)).toMatch(/Edge target not found/);
  });

  it('a same-memory inline edge still works (the common case is unaffected)', async () => {
    const created = await resolvers.Mutation.createNode(
      {},
      { input: { memoryId: memA.id, loc: 'ok', name: 'ok', edges: [{ targetId: nodeA.id, name: 'rel' }] } as never },
      asContributor(),
    );
    expect(await db.edge.count({ where: { sourceId: created.id, targetId: nodeA.id } })).toBe(1);
  });

  it('a caller who CAN read both memories may still link across them', async () => {
    // Platform admin reads memB, so the cross-memory edge is legitimate.
    const created = await resolvers.Mutation.createNode(
      {},
      { input: { memoryId: memA.id, loc: 'cross-ok', name: 'cross', edges: [{ targetId: nodeB.id, name: 'rel' }] } as never },
      ctx(admin.id, ['ADMIN']),
    );
    expect(await db.edge.count({ where: { sourceId: created.id, targetId: nodeB.id } })).toBe(1);
  });
});
