/**
 * Access-control tests for the nodeUsage query (issue #802).
 *
 * nodeUsage had NO gate at all — no requireRole, no memory scoping — so any
 * caller could read usage events for any node loc in any tenant. Since `loc`
 * names no memory, the nodeLoc match is cross-memory, which made a guessable
 * loc ("preflight", a spec citation) a practical cross-tenant read. It is now
 * gated like its siblings (usageEvents #250, memoryUsageSummary, nodeRevisions
 * #602): requireRole(READER) plus scoping to getAccessibleMemoryIds.
 *
 * Scoping rides the denormalized UsageEvent.memoryId COLUMN, not a
 * `node: { memoryId }` relation join (#796/#799) — the deleted-node cases below
 * are the regression guard for that.
 *
 * Fixture mirrors resolvers.usageEvents.access.test.ts: orgA {memA knowledge,
 * privMem private-owned-by-member} + orgB {memB knowledge}. userMember ∈ orgA;
 * userOther ∈ orgA (not the private owner); userOutsider ∈ no org. The SAME loc
 * ('shared-loc') exists in all three memories, so a leak shows up as an extra
 * row rather than as a missing test.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const SHARED_LOC = 'shared-loc';

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let memA: { id: string; urn: string };
let memB: { id: string; urn: string };
let privMem: { id: string; urn: string };
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

const memoriesOf = (rows: { memoryId: string | null }[]) => new Set(rows.map((r) => r.memoryId));

beforeEach(async () => {
  await cleanDb(db);

  orgA = await db.organization.create({
    data: { id: generateId(), name: 'nu-org-a', urn: `nu-org-a-${generateId()}` },
  });
  orgB = await db.organization.create({
    data: { id: generateId(), name: 'nu-org-b', urn: `nu-org-b-${generateId()}` },
  });

  userMember = await db.user.create({ data: { githubId: 6001, githubUsername: 'nu-mem', roles: ['READER'] } });
  userOther = await db.user.create({ data: { githubId: 6002, githubUsername: 'nu-oth', roles: ['READER'] } });
  userOutsider = await db.user.create({ data: { githubId: 6003, githubUsername: 'nu-out', roles: ['READER'] } });
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
    data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:nu-priv`, name: 'nu-priv', class: 'private', userId: userMember.id },
  });

  // The SAME loc in all three memories — the cross-memory collision nodeUsage
  // must bound, since `loc` alone names no memory.
  const nodeA = await db.node.create({ data: { id: generateId(), memoryId: memA.id, loc: SHARED_LOC, name: 'a' } });
  const nodeB = await db.node.create({ data: { id: generateId(), memoryId: memB.id, loc: SHARED_LOC, name: 'b' } });
  const nodeP = await db.node.create({ data: { id: generateId(), memoryId: privMem.id, loc: SHARED_LOC, name: 'p' } });

  await db.usageEvent.createMany({
    data: [
      { id: generateId(), type: 'read', nodeLoc: SHARED_LOC, nodeId: nodeA.id, memoryId: memA.id },
      { id: generateId(), type: 'read', nodeLoc: SHARED_LOC, nodeId: nodeB.id, memoryId: memB.id },
      { id: generateId(), type: 'read', nodeLoc: SHARED_LOC, nodeId: nodeP.id, memoryId: privMem.id },
      // A loc only memA carries — proves scoping doesn't depend on collision.
      { id: generateId(), type: 'read', nodeLoc: 'a-only', nodeId: nodeA.id, memoryId: memA.id },
    ],
  });

  const a = await createDbAppWithKey(db, 'nu-app', orgA.id);
  appKeyApp = a.app;
});

describe('nodeUsage access control', () => {
  it('org member sees only their org + their own private memory (not other tenants)', async () => {
    const r = await resolvers.Query.nodeUsage(null, { loc: SHARED_LOC }, asMember());
    expect(memoriesOf(r)).toEqual(new Set([memA.id, privMem.id])); // NOT memB
    expect(r).toHaveLength(2);
  });

  it("a different org member does NOT see another member's private memory", async () => {
    const r = await resolvers.Query.nodeUsage(null, { loc: SHARED_LOC }, asOther());
    expect(memoriesOf(r)).toEqual(new Set([memA.id])); // privMem is owner-only
  });

  it('an outsider (no org membership) sees nothing', async () => {
    const r = await resolvers.Query.nodeUsage(null, { loc: SHARED_LOC }, asOutsider());
    expect(r).toEqual([]);
  });

  it("ADMIN sees all tenants but NOT another user's private memory", async () => {
    const r = await resolvers.Query.nodeUsage(null, { loc: SHARED_LOC }, asAdmin());
    expect(memoriesOf(r)).toEqual(new Set([memA.id, memB.id])); // privMem excluded
  });

  it('App key is rejected (roles: [] fails the READER gate)', async () => {
    await expect(resolvers.Query.nodeUsage(null, { loc: SHARED_LOC }, asAppKey())).rejects.toThrow('Forbidden');
  });

  it('a loc that exists only in an inaccessible memory returns [] (no existence disclosure)', async () => {
    const nodeBOnly = await db.node.create({
      data: { id: generateId(), memoryId: memB.id, loc: 'b-only', name: 'b-only' },
    });
    await db.usageEvent.create({
      data: { id: generateId(), type: 'read', nodeLoc: 'b-only', nodeId: nodeBOnly.id, memoryId: memB.id },
    });
    const denied = await resolvers.Query.nodeUsage(null, { loc: 'b-only' }, asMember());
    const missing = await resolvers.Query.nodeUsage(null, { loc: 'no-such-loc' }, asMember());
    // Denied and nonexistent are indistinguishable.
    expect(denied).toEqual([]);
    expect(missing).toEqual([]);
  });

  it('a readable loc unique to one memory still returns its events', async () => {
    const r = await resolvers.Query.nodeUsage(null, { loc: 'a-only' }, asMember());
    expect(memoriesOf(r)).toEqual(new Set([memA.id]));
  });

  it('honors the limit (and defaults without it)', async () => {
    expect(await resolvers.Query.nodeUsage(null, { loc: SHARED_LOC, limit: 1 }, asMember())).toHaveLength(1);
    expect(await resolvers.Query.nodeUsage(null, { loc: SHARED_LOC }, asMember())).toHaveLength(2);
  });
});

describe('nodeUsage scopes on the memoryId COLUMN, not a node relation join', () => {
  // #796/#799 moved memory-scoped usage filtering off `node: { memoryId }`
  // because nodeId is SetNull: joining through the node erases an event the
  // moment its node is deleted. These two cases fail if that join comes back.
  it('still returns an event whose node has been deleted (nodeId null, memoryId set)', async () => {
    await db.usageEvent.create({
      data: { id: generateId(), type: 'read', nodeLoc: 'gone-loc', nodeId: null, memoryId: memA.id },
    });
    const r = await resolvers.Query.nodeUsage(null, { loc: 'gone-loc' }, asMember());
    expect(memoriesOf(r)).toEqual(new Set([memA.id]));
  });

  it('a deleted-node event in an INACCESSIBLE memory is still denied', async () => {
    await db.usageEvent.create({
      data: { id: generateId(), type: 'read', nodeLoc: 'gone-loc-b', nodeId: null, memoryId: memB.id },
    });
    const r = await resolvers.Query.nodeUsage(null, { loc: 'gone-loc-b' }, asMember());
    expect(r).toEqual([]);
  });

  it('excludes an unattributed event (memoryId null), matching usageEvents', async () => {
    // Pre-#796 rows whose node was already gone at backfill time. `IN` never
    // matches NULL, so they are invisible on every memory-scoped surface.
    await db.usageEvent.create({
      data: { id: generateId(), type: 'read', nodeLoc: 'orphan-loc', nodeId: null, memoryId: null },
    });
    expect(await resolvers.Query.nodeUsage(null, { loc: 'orphan-loc' }, asMember())).toEqual([]);
    expect(await resolvers.Query.nodeUsage(null, { loc: 'orphan-loc' }, asAdmin())).toEqual([]);
  });
});

describe('nodeUsage ≡ usageEvents(loc: <loc>) — the #802 deprecation promise', () => {
  // nodeUsage is deprecated in favour of usageEvents(loc:). The notice tells
  // callers the rewrite is a rename, so these must agree ROW FOR ROW — including
  // on who is denied. If they ever diverge, the deprecation is lying and callers
  // who follow it silently change behaviour. (The schema-shape half of the
  // promise is guarded in resolvers.nodeUsageDeprecation.test.ts.)
  //
  // The target is the loc ARGUMENT, not nodeId: nodeId shape-classifies its
  // input, and a hierarchical loc with ≥3 colon segments qualifies as node-URN
  // shape and routes to resolveNodeRef instead of the loc filter (PR-986
  // review, Codex P2) — the hierarchical cases below pin both halves of that.
  const bothFor = async (c: Context, loc: string, limit?: number) => {
    const viaDeprecated = await resolvers.Query.nodeUsage(null, { loc, limit }, c);
    const viaTarget = await resolvers.Query.usageEvents(null, { loc, limit }, c);
    return [viaDeprecated, viaTarget] as const;
  };
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

  it('agrees for a member on a loc that collides across memories', async () => {
    const [dep, target] = await bothFor(asMember(), SHARED_LOC);
    expect(ids(dep)).toEqual(ids(target));
    expect(dep).not.toHaveLength(0); // the comparison would be vacuous on []
  });

  it('agrees for ADMIN (the widest principal)', async () => {
    const [dep, target] = await bothFor(asAdmin(), SHARED_LOC);
    expect(ids(dep)).toEqual(ids(target));
    expect(dep).not.toHaveLength(0);
  });

  it('agrees on DENIAL for an outsider, and on a loc only a foreign tenant has', async () => {
    const [depOut, targetOut] = await bothFor(asOutsider(), SHARED_LOC);
    expect(ids(depOut)).toEqual(ids(targetOut));
    expect(depOut).toEqual([]);

    const nodeBOnly = await db.node.create({
      data: { id: generateId(), memoryId: memB.id, loc: 'b-only-eq', name: 'b-only-eq' },
    });
    await db.usageEvent.create({
      data: { id: generateId(), type: 'read', nodeLoc: 'b-only-eq', nodeId: nodeBOnly.id, memoryId: memB.id },
    });
    const [depDenied, targetDenied] = await bothFor(asMember(), 'b-only-eq');
    expect(ids(depDenied)).toEqual(ids(targetDenied));
    expect(depDenied).toEqual([]);
  });

  it('agrees on a deleted-node event — both read the memoryId column, not the relation', async () => {
    await db.usageEvent.create({
      data: { id: generateId(), type: 'read', nodeLoc: 'gone-eq', nodeId: null, memoryId: memA.id },
    });
    const [dep, target] = await bothFor(asMember(), 'gone-eq');
    expect(ids(dep)).toEqual(ids(target));
    expect(dep).toHaveLength(1);
  });

  it('agrees under a limit', async () => {
    const [dep, target] = await bothFor(asMember(), SHARED_LOC, 1);
    expect(ids(dep)).toEqual(ids(target));
    expect(dep).toHaveLength(1);
  });

  it('agrees on a HIERARCHICAL loc that collides across memories (the spec-citation shape)', async () => {
    // 'cor:acl:010:01' has 4 colon segments — real locs look like this (the
    // whole specs corpus does). This is the shape Codex flagged on PR-986:
    // routed through nodeId it would misclassify as a node URN.
    const specLoc = 'cor:acl:010:01';
    const nA = await db.node.create({ data: { id: generateId(), memoryId: memA.id, loc: specLoc, name: 'sa' } });
    const nB = await db.node.create({ data: { id: generateId(), memoryId: memB.id, loc: specLoc, name: 'sb' } });
    await db.usageEvent.createMany({
      data: [
        { id: generateId(), type: 'read', nodeLoc: specLoc, nodeId: nA.id, memoryId: memA.id },
        { id: generateId(), type: 'read', nodeLoc: specLoc, nodeId: nB.id, memoryId: memB.id },
      ],
    });
    const [dep, target] = await bothFor(asMember(), specLoc);
    expect(ids(dep)).toEqual(ids(target));
    expect(memoriesOf(dep)).toEqual(new Set([memA.id])); // memB stays out of scope
    expect(dep).not.toHaveLength(0);
  });

  it('nodeId: <hierarchical loc> is NOT the migration path — it URN-classifies and throws', async () => {
    // The other half of the PR-986 finding, pinned so the loc argument can't be
    // "simplified away": ≥3 colon segments qualify as node-URN shape, so nodeId
    // routes to resolveNodeRef, which cannot find a memory named 'cor:acl' and
    // throws — where nodeUsage / usageEvents(loc:) return the events.
    const specLoc = 'cor:acl:010:01';
    const nA = await db.node.create({ data: { id: generateId(), memoryId: memA.id, loc: specLoc, name: 'sa' } });
    await db.usageEvent.create({
      data: { id: generateId(), type: 'read', nodeLoc: specLoc, nodeId: nA.id, memoryId: memA.id },
    });
    await expect(
      resolvers.Query.usageEvents(null, { nodeId: specLoc }, asMember()),
    ).rejects.toThrow();
    expect(await resolvers.Query.usageEvents(null, { loc: specLoc }, asMember())).toHaveLength(1);
  });

  it('rejects nodeId and loc together (BAD_USER_INPUT, before any lookup)', async () => {
    await expect(
      resolvers.Query.usageEvents(null, { nodeId: SHARED_LOC, loc: SHARED_LOC }, asMember()),
    ).rejects.toThrow('Provide either nodeId or loc, not both');
  });
});

// #2957: `nodeUsage` and `usageEvents` ordered by createdAt alone, so events
// sharing one created_at (a createMany, a coarse clock) came back in whatever
// order the plan picked, and two limit-1 reads could return different rows.
// Both now break ties on id desc, as the paged readers already do.
describe('tied created_at ordering (#2957)', () => {
  it('limit 1 returns the greatest id on both reads, whatever the insert order', async () => {
    const node = await db.node.create({ data: { id: generateId(), memoryId: memA.id, loc: 'tied-loc', name: 'tied' } });
    const at = new Date('2026-01-01T00:00:00.000Z');
    // Fixed ids, inserted in non-sorted order, so heap order is not id order.
    const idsInOrder = ['tie-b', 'tie-d', 'tie-a', 'tie-c'].map((s) => `${s}-${generateId()}`);
    for (const id of idsInOrder) {
      await db.usageEvent.create({
        data: { id, type: 'read', nodeLoc: 'tied-loc', nodeId: node.id, memoryId: memA.id, createdAt: at },
      });
    }
    const greatest = [...idsInOrder].sort().at(-1)!;
    const viaDeprecated = await resolvers.Query.nodeUsage(null, { loc: 'tied-loc', limit: 1 }, asMember());
    const viaTarget = await resolvers.Query.usageEvents(null, { loc: 'tied-loc', limit: 1 }, asMember());
    expect(viaDeprecated.map((r) => r.id)).toEqual([greatest]);
    expect(viaTarget.map((r) => r.id)).toEqual([greatest]);
    // Full order is id desc as well.
    const all = await resolvers.Query.nodeUsage(null, { loc: 'tied-loc' }, asMember());
    expect(all.map((r) => r.id)).toEqual([...idsInOrder].sort().reverse());
  });
});
