/**
 * Access-control tests for the recordUsage mutation (issue #825).
 *
 * recordUsage resolved its `nodeLoc` with an unscoped `findFirst` and no access
 * check, then stamped the resolved node's id AND memoryId onto the UsageEvent.
 * Because `loc` is unique per MEMORY rather than globally, a guessable loc
 * ("preflight", a spec citation) let a caller attribute a usage row to another
 * tenant's memory — and #796/#799 scope usage analytics on
 * `UsageEvent.memoryId`, so those rows surface in that org's dashboards.
 *
 * The sibling defect was the unauthenticated `POST /usage` REST endpoint, which
 * reached the same resolution through `createUsageEvent`. That endpoint and its
 * controller operation are DELETED — nothing called them — so this file covers
 * the surface that remains.
 *
 * Resolution now runs through the shared read gate (`resolveReadableNodeByLoc`
 * → `memoryAccessFilter`), so attribution can only ever name a node the caller
 * can read. Unreadable, absent, and ambiguous all yield NO attribution rather
 * than an error: the raw `nodeLoc` string is still recorded, and denied stays
 * indistinguishable from missing.
 *
 * Fixture mirrors resolvers.nodeUsage.access.test.ts: orgA {memA knowledge,
 * privMem private-owned-by-userMember} + orgB {memB knowledge}. The SAME loc
 * exists in all three, so a leak shows up as the wrong memoryId rather than as
 * a missing test.
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
let nodeA: { id: string };
let nodeB: { id: string };
let nodeP: { id: string };

function ctx(overrides: Partial<Context> = {}): Context {
  return { db, ...overrides } as Context;
}
const asMember = () => ctx({ userId: userMember.id, roles: ['READER'] });
const asOther = () => ctx({ userId: userOther.id, roles: ['READER'] });
const asOutsider = () => ctx({ userId: userOutsider.id, roles: ['READER'] });
const asAppKey = () => ctx({ appId: appKeyApp.id, roles: [] });

const record = (nodeLoc: string | undefined, c: Context, type = 'read') =>
  (resolvers.Mutation as any).recordUsage({}, { event: { type, nodeLoc } }, c);

/** The row recordUsage just wrote. */
async function lastEvent() {
  return db.usageEvent.findFirst({ orderBy: { createdAt: 'desc' } });
}

beforeEach(async () => {
  await cleanDb(db);

  orgA = await db.organization.create({
    data: { id: generateId(), name: 'ru-org-a', urn: `ru-org-a-${generateId()}` },
  });
  orgB = await db.organization.create({
    data: { id: generateId(), name: 'ru-org-b', urn: `ru-org-b-${generateId()}` },
  });

  userMember = await db.user.create({ data: { githubId: 6101, githubUsername: 'ru-mem', roles: ['READER'] } });
  userOther = await db.user.create({ data: { githubId: 6102, githubUsername: 'ru-oth', roles: ['READER'] } });
  userOutsider = await db.user.create({ data: { githubId: 6103, githubUsername: 'ru-out', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: orgA.id, userId: userMember.id, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: orgA.id, userId: userOther.id, role: 'READER' } });

  memA = await db.memory.create({
    data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:mem-a`, name: 'mem-a', class: 'knowledge' },
  });
  memB = await db.memory.create({
    data: { id: generateId(), organizationId: orgB.id, urn: `${orgB.urn}:mem-b`, name: 'mem-b', class: 'knowledge' },
  });
  privMem = await db.memory.create({
    data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:ru-priv`, name: 'ru-priv', class: 'private', userId: userMember.id },
  });

  // The same loc in all three memories — the collision that made this exploitable.
  nodeA = await db.node.create({ data: { id: generateId(), memoryId: memA.id, loc: SHARED_LOC, name: 'a' } });
  nodeB = await db.node.create({ data: { id: generateId(), memoryId: memB.id, loc: SHARED_LOC, name: 'b' } });
  nodeP = await db.node.create({ data: { id: generateId(), memoryId: privMem.id, loc: SHARED_LOC, name: 'p' } });
  // A loc only orgB carries — the clean "denied, not ambiguous" case.
  await db.node.create({ data: { id: generateId(), memoryId: memB.id, loc: 'b-only', name: 'b-only' } });
  // A loc only memA carries — the clean readable case.
  await db.node.create({ data: { id: generateId(), memoryId: memA.id, loc: 'a-only', name: 'a-only' } });

  const a = await createDbAppWithKey(db, 'ru-app', orgA.id);
  appKeyApp = a.app;
});

describe('recordUsage — attribution cannot name another tenant', () => {
  it('never attributes to a memory the caller cannot read', async () => {
    // asOther records against a loc present in orgA, orgB, AND userMember's
    // private memory. Exactly ONE of the three is readable by them (memA), so
    // the outcome is deterministic under the fix: memA, never orgB's copy.
    //
    // Note this is only a sharp assertion post-fix. Against the old unscoped
    // `findFirst` the row chosen was arbitrary, so a leak here reproduced
    // intermittently — which is why the deterministic guards are the 'b-only'
    // and outsider cases below.
    await record(SHARED_LOC, asOther());
    const e = await lastEvent();
    expect(e!.memoryId).toBe(memA.id);
    expect(e!.nodeId).toBe(nodeA.id);
    expect(e!.memoryId).not.toBe(memB.id); // the cross-tenant leak
    expect(e!.memoryId).not.toBe(privMem.id); // owner-only; asOther is not the owner
  });

  it('a loc readable in exactly one memory attributes to it', async () => {
    await record('a-only', asMember());
    const e = await lastEvent();
    expect(e!.memoryId).toBe(memA.id);
    expect(e!.nodeLoc).toBe('a-only');
    expect(e!.nodeId).toBeTruthy();
  });

  it('a loc readable in SEVERAL memories attributes to NONE — it refuses to guess', async () => {
    // userMember can read both memA and their own privMem, so SHARED_LOC is
    // genuinely ambiguous. Picking one is the bug; the row records unattributed.
    await record(SHARED_LOC, asMember());
    const e = await lastEvent();
    expect(e!.nodeLoc).toBe(SHARED_LOC); // the caller's own string is kept
    expect(e!.nodeId).toBeNull();
    expect(e!.memoryId).toBeNull();
  });

  it('a loc only another tenant carries records unattributed, not an error', async () => {
    await record('b-only', asMember());
    const e = await lastEvent();
    expect(e!.nodeLoc).toBe('b-only');
    expect(e!.nodeId).toBeNull();
    expect(e!.memoryId).toBeNull();
  });

  it('denied and nonexistent are indistinguishable (no existence oracle)', async () => {
    await record('b-only', asMember());
    const denied = await lastEvent();
    await record('no-such-loc-anywhere', asMember());
    const missing = await lastEvent();
    expect([denied!.nodeId, denied!.memoryId]).toEqual([missing!.nodeId, missing!.memoryId]);
  });

  it('an outsider with no org membership attributes to nothing', async () => {
    await record(SHARED_LOC, asOutsider());
    const e = await lastEvent();
    expect(e!.nodeId).toBeNull();
    expect(e!.memoryId).toBeNull();
  });

  it('omitting nodeLoc records an unattributed event, as before', async () => {
    await record(undefined, asMember(), 'page-view');
    const e = await lastEvent();
    expect(e!.type).toBe('page-view');
    expect(e!.nodeLoc).toBeNull();
    expect(e!.nodeId).toBeNull();
  });
});

describe('recordUsage — principal gate', () => {
  it('requires an authenticated READER — an App key (roles: []) is rejected', async () => {
    await expect(record(SHARED_LOC, asAppKey())).rejects.toThrow('Forbidden');
  });

  it('rejects a caller with no roles at all', async () => {
    await expect(record(SHARED_LOC, ctx({ roles: [] }))).rejects.toThrow('Forbidden');
  });

  it('writes nothing when the gate rejects', async () => {
    await db.usageEvent.deleteMany({});
    await expect(record(SHARED_LOC, ctx({ roles: [] }))).rejects.toThrow();
    expect(await db.usageEvent.count()).toBe(0);
  });
});

describe('recordUsage — attribution still carries the principal (spec 046 FR-001)', () => {
  it('records userId so the event is visible to own-activity scopes', async () => {
    await record('a-only', asMember());
    const e = await lastEvent();
    expect(e!.userId).toBe(userMember.id);
  });
});

// A real node beats a link at the same readable loc — preserved from the
// pre-#825 preference order (`isLink: false` was tried first).
describe('recordUsage — link vs real node', () => {
  it('prefers the real node when a link shares its loc in the same memory', async () => {
    // Same loc cannot repeat within one memory, so put the link in privMem —
    // readable only by userMember, who also reads memA's copy.
    await db.node.update({ where: { id: nodeP.id }, data: { isLink: true } });
    await record(SHARED_LOC, asMember());
    const e = await lastEvent();
    // memA's real node wins over privMem's link, rather than reading as ambiguous.
    expect(e!.nodeId).toBe(nodeA.id);
    expect(e!.memoryId).toBe(memA.id);
    expect(nodeB.id).not.toBe(e!.nodeId); // orgB never in play
  });
});

/** #1662: session attribution follows ownership, independently of liveness. */
describe('recordUsage — session attribution ownership', () => {
  async function makeSession(overrides: Record<string, unknown> = {}) {
    return db.session.create({ data: {
      id: generateId(), userId: userMember.id, appId: appKeyApp.id,
      ...overrides,
    } });
  }
  async function recordSession(sessionId: string | undefined, c: Context) {
    await (resolvers.Mutation as any).recordUsage({}, {
      event: { type: 'read', sessionId, tokensIn: 42, tokensOut: 7 },
    }, c);
    return lastEvent();
  }

  it('keeps the owning user attribution and live activity', async () => {
    const s = await makeSession();
    const e = await recordSession(s.id, asMember());
    expect(e).toMatchObject({ sessionId: s.id, countsAsActivity: true, tokensIn: 42 });
  });

  it('drops another user session without changing its history, totals or liveness', async () => {
    const at = new Date(Date.now() - 30 * 60 * 60 * 1000);
    const s = await makeSession({ startedAt: at, updatedAt: at });
    const e = await recordSession(s.id, asOther());
    expect(e).toMatchObject({ sessionId: null, countsAsActivity: false, userId: userOther.id });
    expect(await db.usageEvent.count({ where: { sessionId: s.id } })).toBe(0);
    expect(await db.usageEvent.aggregate({ where: { sessionId: s.id }, _sum: { tokensIn: true } }))
      .toMatchObject({ _sum: { tokensIn: null } });
    expect(await db.session.findUnique({ where: { id: s.id } })).toEqual(s);
  });

  it('does not let a platform admin attribute to another user', async () => {
    const s = await makeSession();
    const e = await recordSession(s.id, ctx({ userId: userOther.id, roles: ['ADMIN'] }));
    expect(e!.sessionId).toBeNull();
  });

  it('drops impersonated ownership', async () => {
    const s = await makeSession();
    const e = await recordSession(s.id, ctx({ ...asMember(), impersonation: {
      sessionId: generateId(), actorUserId: userOther.id, orgId: orgA.id,
      expiresAt: new Date(Date.now() + 60000),
    } }));
    expect(e).toMatchObject({ sessionId: null, countsAsActivity: false });
  });

  it('a hybrid user does not inherit the selected App ownership', async () => {
    const s = await makeSession();
    const e = await recordSession(s.id, ctx({ ...asOther(), appId: appKeyApp.id }));
    expect(e!.sessionId).toBeNull();
  });

  it('a hybrid user retains their own session attribution', async () => {
    const s = await makeSession();
    const e = await recordSession(s.id, ctx({ ...asMember(), appId: appKeyApp.id }));
    expect(e!.sessionId).toBe(s.id);
  });

  it('a hybrid user cannot attribute to a person-less selected-App session', async () => {
    const s = await makeSession({ userId: null });
    const e = await recordSession(s.id, ctx({ ...asMember(), appId: appKeyApp.id }));
    expect(e!.sessionId).toBeNull();
  });

  it.each(['lapsed', 'ended', 'expired'] as const)('keeps late owned %s attribution without activity', async (state) => {
    const at = new Date(Date.now() - 30 * 60 * 60 * 1000);
    const s = await makeSession({ startedAt: at, updatedAt: at,
      ...(state === 'ended' ? { endedAt: at } : {}),
      ...(state === 'expired' ? { expiresAt: at } : {}),
    });
    const e = await recordSession(s.id, asMember());
    expect(e).toMatchObject({ sessionId: s.id, countsAsActivity: false });
    expect(await db.session.findUnique({ where: { id: s.id } })).toEqual(s);
  });

  it('missing, deleted and denied session references all drop attribution', async () => {
    const deleted = await makeSession({ deletedAt: new Date() });
    const foreign = await makeSession({ userId: userOther.id });
    for (const id of [generateId(), deleted.id, foreign.id]) {
      const e = await recordSession(id, asMember());
      expect(e).toMatchObject({ sessionId: null, countsAsActivity: false });
    }
  });

  it.each(['delete', 'reassign'] as const)('rechecks ownership after a concurrent %s commits', async (change) => {
    const s = await makeSession();
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writer = db.$transaction(async (tx) => {
      await tx.session.update({ where: { id: s.id }, data: change === 'delete'
        ? { deletedAt: new Date() } : { userId: userOther.id } });
      locked();
      await gate;
    }, { timeout: 10000 });
    await ready;
    const recording = recordSession(s.id, asMember());
    try {
      let waited = false;
      for (let i = 0; i < 100; i++) {
        const rows = await db.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%SELECT id FROM sessions%' AND query LIKE '%FOR SHARE%') AS waiting`;
        if (rows[0].waiting) { waited = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waited).toBe(true);
    } finally {
      release();
      await writer;
    }
    expect(await recording).toMatchObject({ sessionId: null, countsAsActivity: false });
    expect(await db.usageEvent.count({ where: { sessionId: s.id } })).toBe(0);
  });

  it('omitting the session still records usage without session attribution', async () => {
    expect(await recordSession(undefined, asMember())).toMatchObject({ sessionId: null, countsAsActivity: false });
  });

  it('does not widen the existing App-key READER gate', async () => {
    const s = await makeSession({ userId: null });
    await expect(recordSession(s.id, asAppKey())).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await db.usageEvent.count()).toBe(0);
  });
});
