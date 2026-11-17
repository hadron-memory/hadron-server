/**
 * Access-control tests for the usageEvents query (issue #250).
 *
 * usageEvents was gated only by requireRole(READER) — a global role tier with
 * no tenant scoping, so any authenticated user saw every tenant's events. It is
 * now scoped to the memories the caller may read (getAccessibleMemoryIds —
 * principals + memory-class rules per spec 034):
 *   - no resource named → the caller's own activity (#2817, cor:acl:090:01); a bare loc spanning
 *     memories → bounded to the readable-memory set.
 *   - scoped path (memoryId) → MEMORY_NOT_FOUND if unreadable, exactly as if missing (#1381).
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
let appKeyId: string;

function ctx(overrides: Partial<Context> = {}): Context {
  return { db, ...overrides } as Context;
}
const asMember = () => ctx({ userId: userMember.id, roles: ['READER'] });
const asOther = () => ctx({ userId: userOther.id, roles: ['READER'] });
const asOutsider = () => ctx({ userId: userOutsider.id, roles: ['READER'] });
const asAdmin = () => ctx({ userId: 'admin-user', roles: ['ADMIN'] });
// Mirrors a real App-key context (resolveAppKey sets roles: []).
// The real hdr_app_ key context (middleware/auth.ts resolveAppKey) carries the key's own id.
const asAppKey = () => ctx({ appId: appKeyApp.id, appKeyId, roles: [] });

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
  appKeyId = a.appKey.id;
});

const locsOf = (rows: { nodeLoc: string | null }[]) => new Set(rows.map((r) => r.nodeLoc));

describe('usageEvents access control — no resource named, and a bare loc across memories', () => {
  // #2817 (cor:acl:090:01): naming no resource is the caller's OWN activity, never a feed of the
  // readable memories. The fixture events carry no user, so nobody owns them.
  it('naming no resource returns the caller\'s own activity only (none of these unattributed events)', async () => {
    for (const c of [asMember(), asOther(), asOutsider(), asAdmin()]) {
      expect(await resolvers.Query.usageEvents(null, {}, c)).toEqual([]);
    }
  });

  // The #250 tenant bounds now hold on the resource scope that spans memories: a bare loc matches
  // in every READABLE memory, and only there.
  const byLoc = async (c: Context) => {
    const out = new Set<string | null>();
    for (const loc of ['a-loc', 'b-loc', 'p-loc']) for (const r of await resolvers.Query.usageEvents(null, { loc }, c)) out.add(r.nodeLoc);
    return out;
  };

  it('org member sees only their org + their own private memory (not other tenants)', async () => {
    expect(await byLoc(asMember())).toEqual(new Set(['a-loc', 'p-loc'])); // memA + privMem, NOT memB
  });

  it('a different org member does NOT see another member\'s private memory', async () => {
    expect(await byLoc(asOther())).toEqual(new Set(['a-loc'])); // memA only — privMem is owner-only
  });

  it('an outsider (no org membership) sees nothing', async () => {
    expect(await byLoc(asOutsider())).toEqual(new Set());
  });

  it('ADMIN sees all tenants but NOT another user\'s private memory', async () => {
    expect(await byLoc(asAdmin())).toEqual(new Set(['a-loc', 'b-loc'])); // memA + memB, privMem excluded
  });

  it('App key naming no resource gets an empty result, not an error (#2817)', async () => {
    expect(await resolvers.Query.usageEvents(null, {}, asAppKey())).toEqual([]);
  });
});

describe('usageEvents access control — scoped (memoryId) path', () => {
  it('member can read their org memory\'s events', async () => {
    const r = await resolvers.Query.usageEvents(null, { memoryId: memA.id }, asMember());
    expect(locsOf(r)).toEqual(new Set(['a-loc']));
  });

  // #1381 (`cor:api:140:03`): an unreadable memory answers exactly as a missing
  // one. The old `[]` was the leak — a MISSING memory throws, so an empty page
  // meant "exists, not yours".
  it('member cannot read a memory in an org they don\'t belong to → MEMORY_NOT_FOUND, as if missing', async () => {
    await expect(resolvers.Query.usageEvents(null, { memoryId: memB.id }, asMember())).rejects.toThrow(
      `MEMORY_NOT_FOUND: ${memB.id}`,
    );
  });

  it('owner can read their private memory\'s events', async () => {
    const r = await resolvers.Query.usageEvents(null, { memoryId: privMem.id }, asMember());
    expect(locsOf(r)).toEqual(new Set(['p-loc']));
  });

  it('non-owner cannot read someone else\'s private memory → MEMORY_NOT_FOUND, as if missing', async () => {
    await expect(resolvers.Query.usageEvents(null, { memoryId: privMem.id }, asOther())).rejects.toThrow(
      `MEMORY_NOT_FOUND: ${privMem.id}`,
    );
  });

  it('accepts a URN memoryId and still enforces access', async () => {
    const allowed = await resolvers.Query.usageEvents(null, { memoryId: memA.urn }, asMember());
    expect(locsOf(allowed)).toEqual(new Set(['a-loc']));
    await expect(resolvers.Query.usageEvents(null, { memoryId: memB.urn }, asMember())).rejects.toThrow(
      `MEMORY_NOT_FOUND: ${memB.urn}`,
    );
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
