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

  it('resolves endpoints of a same-memory SYSTEM edge for an org member (#781 review P2)', async () => {
    // getAccessibleMemoryIds omits app/system-class org memories, but an org
    // member reaches them via appNodes / Query.memory's org-member fast-path —
    // which isMemoryReadableRow honors. The gate must not null these endpoints.
    const sysMem = await db.memory.create({
      data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:sys`, name: 'sys', class: 'system', visibility: null },
    });
    const s1 = await createDbNode(db, { loc: 's1', memoryId: sysMem.id });
    const s2 = await createDbNode(db, { loc: 's2', memoryId: sysMem.id });
    const e = { id: generateId(), memoryId: sysMem.id, sourceId: s1.id, targetId: s2.id, name: 'rel' };
    expect((await E.source(e, {}, ctx(member.id)))?.id).toBe(s1.id);
    expect((await E.target(e, {}, ctx(member.id)))?.id).toBe(s2.id);
  });

  it('a caller who can read NEITHER memory gets null for both', async () => {
    const stranger = await db.user.create({ data: { id: generateId(), githubId: 90103, githubUsername: 'eg-stranger' } });
    const e = crossEdge();
    expect(await E.source(e, {}, ctx(stranger.id))).toBeNull();
    expect(await E.target(e, {}, ctx(stranger.id))).toBeNull();
  });
});
