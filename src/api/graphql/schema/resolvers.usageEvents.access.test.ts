/**
 * Access-control tests for the usageEvents query (issue #250).
 *
 * usageEvents was gated only by requireRole(READER) — a global role tier with
 * no tenant scoping, so any authenticated user saw every tenant's events. It is
 * now scoped to the memories the caller may read (getAccessibleMemoryIds —
 * principals + memory-class rules per spec 034):
 *   - global path (no memoryId) → bounded to the readable-memory set.
 *   - scoped path (memoryId) → denied with [] (no existence leak) if unreadable.
 *
 * Fixture: orgA {memA knowledge, privMem private-owned-by-member} + orgB {memB
 * knowledge}. userMember ∈ orgA; userOther ∈ orgA (not the private owner);
 * userOutsider ∈ no org. One usage event per memory.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let memA: { id: string; urn: string };
let memB: { id: string; urn: string };
let privMem: { id: string; urn: string };
let nodeA: { id: string };
let nodeB: { id: string };
let userMember: { id: string };
let userOther: { id: string };
let userOutsider: { id: string };
let appKeyApp: { id: string };

function ctx(overrides: Partial<Context> = {}): Context {
  return { db, ...overrides } as Context;
}
const asMember = () => ctx({ userId: userMember.id, roles: ['READER'] });
const asOther = () => ctx({ userId: userOther.id, roles: ['READER'] });
const asOutsider = () => ctx({ userId: userOutsider.id, roles: ['READER'] });
const asAdmin = () => ctx({ userId: 'admin-user', roles: ['ADMIN'] });
// Mirrors a real App-key context (resolveAppKey sets roles: []).
const asAppKey = () => ctx({ appId: appKeyApp.id, roles: [] });

beforeEach(async () => {
  await cleanDb(db);

  orgA = await db.organization.create({
    data: { id: generateId(), name: 'acc-org-a', urn: `acc-org-a-${generateId()}` },
  });
  orgB = await db.organization.create({
    data: { id: generateId(), name: 'acc-org-b', urn: `acc-org-b-${generateId()}` },
  });

  userMember = await db.user.create({ data: { githubId: 5001, githubUsername: 'mem', roles: ['READER'] } });
  userOther = await db.user.create({ data: { githubId: 5002, githubUsername: 'oth', roles: ['READER'] } });
  userOutsider = await db.user.create({ data: { githubId: 5003, githubUsername: 'out', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: orgA.id, userId: userMember.id, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: orgA.id, userId: userOther.id, role: 'READER' } });

  memA = await db.memory.create({
    data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:mem-a`, name: 'mem-a', class: 'knowledge' },
  });
  memB = await db.memory.create({
    data: { id: generateId(), organizationId: orgB.id, urn: `${orgB.urn}:mem-b`, name: 'mem-b', class: 'knowledge' },
  });
  // Owner-only private memory in orgA, owned by userMember. (private: visibility
  // stays null per chk_memory_visibility_class; owner-only via userId.)
  privMem = await db.memory.create({
    data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:priv`, name: 'priv', class: 'private', userId: userMember.id },
  });

  nodeA = await db.node.create({ data: { id: generateId(), memoryId: memA.id, loc: 'a-loc', name: 'a' } });
  nodeB = await db.node.create({ data: { id: generateId(), memoryId: memB.id, loc: 'b-loc', name: 'b' } });
  const nodeP = await db.node.create({ data: { id: generateId(), memoryId: privMem.id, loc: 'p-loc', name: 'p' } });

  await db.usageEvent.createMany({
    data: [
      { id: generateId(), type: 'read', nodeLoc: 'a-loc', nodeId: nodeA.id, memoryId: memA.id },
      { id: generateId(), type: 'read', nodeLoc: 'b-loc', nodeId: nodeB.id, memoryId: memB.id },
      { id: generateId(), type: 'read', nodeLoc: 'p-loc', nodeId: nodeP.id, memoryId: privMem.id },
    ],
  });

  const a = await createDbAppWithKey(db, 'acc-app', orgA.id);
  appKeyApp = a.app;
});

const locsOf = (rows: { nodeLoc: string | null }[]) => new Set(rows.map((r) => r.nodeLoc));

describe('usageEvents access control — global path', () => {
  it('org member sees only their org + their own private memory (not other tenants)', async () => {
    const r = await resolvers.Query.usageEvents(null, {}, asMember());
    expect(locsOf(r)).toEqual(new Set(['a-loc', 'p-loc'])); // memA + privMem, NOT memB
    expect(r).toHaveLength(2);
  });

  it('a different org member does NOT see another member\'s private memory', async () => {
    const r = await resolvers.Query.usageEvents(null, {}, asOther());
    expect(locsOf(r)).toEqual(new Set(['a-loc'])); // memA only — privMem is owner-only
  });

  it('an outsider (no org membership) sees nothing', async () => {
    const r = await resolvers.Query.usageEvents(null, {}, asOutsider());
    expect(r).toEqual([]);
  });

  it('ADMIN sees all tenants but NOT another user\'s private memory', async () => {
    const r = await resolvers.Query.usageEvents(null, {}, asAdmin());
    expect(locsOf(r)).toEqual(new Set(['a-loc', 'b-loc'])); // memA + memB, privMem excluded
  });

  it('App key is rejected (roles: [] fails the READER gate)', async () => {
    await expect(resolvers.Query.usageEvents(null, {}, asAppKey())).rejects.toThrow('Forbidden');
  });
});

describe('usageEvents access control — scoped (memoryId) path', () => {
  it('member can read their org memory\'s events', async () => {
    const r = await resolvers.Query.usageEvents(null, { memoryId: memA.id }, asMember());
    expect(locsOf(r)).toEqual(new Set(['a-loc']));
  });

  it('member cannot read a memory in an org they don\'t belong to → [] (no leak)', async () => {
    const r = await resolvers.Query.usageEvents(null, { memoryId: memB.id }, asMember());
    expect(r).toEqual([]);
  });

  it('owner can read their private memory\'s events', async () => {
    const r = await resolvers.Query.usageEvents(null, { memoryId: privMem.id }, asMember());
    expect(locsOf(r)).toEqual(new Set(['p-loc']));
  });

  it('non-owner cannot read someone else\'s private memory → []', async () => {
    const r = await resolvers.Query.usageEvents(null, { memoryId: privMem.id }, asOther());
    expect(r).toEqual([]);
  });

  it('accepts a URN memoryId and still enforces access', async () => {
    const allowed = await resolvers.Query.usageEvents(null, { memoryId: memA.urn }, asMember());
    expect(locsOf(allowed)).toEqual(new Set(['a-loc']));
    const denied = await resolvers.Query.usageEvents(null, { memoryId: memB.urn }, asMember());
    expect(denied).toEqual([]);
  });
});

describe('usageEvents access control — nodeId path is access-bounded', () => {
  it('member can read a node in an accessible memory', async () => {
    const r = await resolvers.Query.usageEvents(null, { nodeId: nodeA.id }, asMember());
    expect(locsOf(r)).toEqual(new Set(['a-loc']));
  });

  it('member querying a node in an inaccessible memory gets [] (not the event)', async () => {
    const r = await resolvers.Query.usageEvents(null, { nodeId: nodeB.id }, asMember());
    expect(r).toEqual([]);
  });

  it('bare-loc nodeId is bounded to readable memories', async () => {
    // 'b-loc' only exists in memB (inaccessible to member) → [].
    const r = await resolvers.Query.usageEvents(null, { nodeId: 'b-loc' }, asMember());
    expect(r).toEqual([]);
  });
});
