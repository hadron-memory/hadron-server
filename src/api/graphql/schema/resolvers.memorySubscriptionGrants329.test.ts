/**
 * issue #329 — cross-org MemorySubscription grants in the effectiveAccess
 * audit.
 *
 * A subject whose only path to a memory is their org's subscription used to
 * be under-reported (the deliberate omission at effectiveAccess.ts:317). These
 * pins hold the new MEMORY_SUBSCRIPTION grant to the two ENFORCED gates it
 * mirrors — getOrgReadableMemoryIds (read, via subscribedMemoryWhere) and
 * requireMemoryWriteAccess (write) — including every exclusion the gates
 * apply: an access audit must never OVER-report (the #1440 lesson, pinned as
 * findings:group-subscription-row-bypasses-memorymember).
 *
 * Acceptance map (gate comment on #329):
 *   items 1–4  → the grant-shape pins below (RED on main: no grant at all);
 *   item 5     → the over-report guards (green on main BY DESIGN — main has
 *                no subscription arm, so they are regression pins against
 *                this change over-granting, the same posture as #5301's
 *                only-such-a-row pin);
 *   item 6     → the parity block (audit vs both enforced gates, per fixture);
 *   item 7     → the caller-authorization pins (cor:acl:060:01 unchanged).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { requireMemoryWriteAccess } from './resolvers.helpers.js';
import { getOrgReadableMemoryIds } from '../../../lib/auth/orgReadableMemory.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

function ctx(overrides: Partial<Context> = {}): Context {
  return { db, ...overrides };
}

const call = (user: string, resource: string, caller: Context) =>
  resolvers.Query.effectiveAccess(null, { user, resource }, caller);

// The wire value is new (ahead of the @hadron-memory/access-control union),
// so tests compare through the widened string form.
const subGrants = (res: Awaited<ReturnType<typeof call>>) =>
  res.grants.filter((g) => (g.source as string) === 'MEMORY_SUBSCRIPTION');

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let kb: { id: string; urn: string };
let admin: { id: string }; // platform OWNER — the privileged audit caller
let readerB: { id: string }; // READER member of the subscribing org B
let contribB: { id: string }; // CONTRIBUTOR member of the subscribing org B
let stranger: { id: string }; // member of nothing

const asAdmin = () => ctx({ userId: admin.id, roles: ['OWNER'] });

/** A live subscription row of org B on the memory, at the given role. */
async function subscribe(role: 'READER' | 'CONTRIBUTOR', memoryId = kb.id) {
  return db.memorySubscription.create({
    data: { memoryId, organizationId: orgB.id, role },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const a = await createDbOrgAndGraph(db, {
    orgName: 'subowner',
    graphName: 'kb',
    visibility: 'ORGANIZATION',
  });
  orgA = a.org as any;
  kb = a.graph as any;
  orgB = await db.organization.create({
    data: { id: generateId(), name: 'subber', urn: 'subber' },
  });
  admin = await db.user.create({ data: { githubId: 1, githubUsername: 'op', roles: ['OWNER'] } });
  readerB = await db.user.create({ data: { githubId: 2, githubUsername: 'rb', roles: ['READER'] } });
  contribB = await db.user.create({ data: { githubId: 3, githubUsername: 'cb', roles: ['READER'] } });
  stranger = await db.user.create({ data: { githubId: 4, githubUsername: 'st', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: orgB.id, userId: readerB.id, role: 'READER' } });
  await db.orgMember.create({
    data: { organizationId: orgB.id, userId: contribB.id, role: 'CONTRIBUTOR' },
  });
});

describe('#329 memory — subscription grants (items 1–4)', () => {
  it('item 1: a READER member of a subscribing org reads (any member role, READER subscription)', async () => {
    await subscribe('READER');
    const res = await call(readerB.id, `hrn:memory:${kb.urn}`, asAdmin());
    expect(res.canRead).toBe(true);
    expect(res.canWrite).toBe(false);
    expect(res.canManage).toBe(false);
    expect(res.canDelete).toBe(false);
    const grants = subGrants(res);
    expect(grants).toHaveLength(1);
    expect(grants[0].role).toBe('READER');
    expect(grants[0].via).toBe(orgB.urn);
  });

  it('item 2: CONTRIBUTOR member + CONTRIBUTOR subscription — read AND write, never manage', async () => {
    await subscribe('CONTRIBUTOR');
    const res = await call(contribB.id, `hrn:memory:${kb.urn}`, asAdmin());
    expect(res.canRead).toBe(true);
    expect(res.canWrite).toBe(true);
    expect(res.canManage).toBe(false);
    expect(res.canDelete).toBe(false);
    const grants = subGrants(res);
    expect(grants).toHaveLength(1);
    expect(grants[0].role).toBe('CONTRIBUTOR');
    expect(grants[0].via).toBe(orgB.urn);
  });

  it('item 3: READER member + CONTRIBUTOR subscription — read, NOT write (member role gates write)', async () => {
    await subscribe('CONTRIBUTOR');
    const res = await call(readerB.id, `hrn:memory:${kb.urn}`, asAdmin());
    expect(res.canRead).toBe(true);
    expect(res.canWrite).toBe(false);
    expect(subGrants(res)).toHaveLength(1);
  });

  it('item 4: CONTRIBUTOR member + READER subscription — read, NOT write (subscription role gates write)', async () => {
    await subscribe('READER');
    const res = await call(contribB.id, `hrn:memory:${kb.urn}`, asAdmin());
    expect(res.canRead).toBe(true);
    expect(res.canWrite).toBe(false);
    expect(subGrants(res)).toHaveLength(1);
  });

  it('the owning org\'s own members keep their ORG_ROLE grants alongside (no regression in the composite)', async () => {
    // A CONTRIBUTOR member of the OWNING org (no subscription) still gets
    // ORG_ROLE write — the new arm must not disturb the existing composite.
    const contribA = await db.user.create({ data: { githubId: 9, githubUsername: 'ca', roles: ['READER'] } });
    await db.orgMember.create({
      data: { organizationId: orgA.id, userId: contribA.id, role: 'CONTRIBUTOR' },
    });
    const res = await call(contribA.id, `hrn:memory:${kb.urn}`, asAdmin());
    expect(res.canWrite).toBe(true);
    expect(subGrants(res)).toHaveLength(0);
    expect(res.grants.map((g) => g.source)).toEqual(['ORG_ROLE']);
  });
});

describe('#329 memory — never over-reported (item 5; regression pins, green on main by design)', () => {
  it('a revoked (soft-deleted) subscription grants nothing', async () => {
    await subscribe('CONTRIBUTOR');
    await db.memorySubscription.updateMany({
      where: { memoryId: kb.id, organizationId: orgB.id },
      data: { deletedAt: new Date() },
    });
    const res = await call(contribB.id, `hrn:memory:${kb.urn}`, asAdmin());
    expect(subGrants(res)).toHaveLength(0);
    expect(res.canRead).toBe(false);
    expect(res.canWrite).toBe(false);
  });

  it('a revoked org membership grants nothing even with a live subscription', async () => {
    await subscribe('CONTRIBUTOR');
    await db.orgMember.updateMany({
      where: { organizationId: orgB.id, userId: contribB.id },
      data: { deletedAt: new Date() },
    });
    const res = await call(contribB.id, `hrn:memory:${kb.urn}`, asAdmin());
    expect(subGrants(res)).toHaveLength(0);
    expect(res.canRead).toBe(false);
  });

  it('a group-class memory is never subscription-reachable (MemoryMember stays exclusive)', async () => {
    const group = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        urn: `${orgA.urn}:grp`,
        name: 'grp',
        class: 'group',
        visibility: 'GROUP',
      },
    });
    await subscribe('CONTRIBUTOR', group.id);
    const res = await call(contribB.id, `hrn:memory:${group.urn}`, asAdmin());
    expect(subGrants(res)).toHaveLength(0);
    expect(res.canRead).toBe(false);
    expect(res.canWrite).toBe(false);
  });

  it('a system-class memory is never subscription-reachable', async () => {
    // A bare system row is openable by nobody (no live Agent points at it),
    // so the audit itself refuses — the fixture must be a LIVE Agent's own
    // system memory, audited by an org-A ADMIN (the Agent's manager, the one
    // caller who can open it). The SUBJECT stays the subscriber.
    const sys = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        urn: `${orgA.urn}:sysdef`,
        name: 'sysdef',
        class: 'system',
      },
    });
    await db.agent.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        urn: `${orgA.urn}:sysagent`,
        name: 'sysagent',
        systemMemoryId: sys.id,
      },
    });
    const orgAAdmin = await db.user.create({
      data: { githubId: 8, githubUsername: 'oaa', roles: ['READER'] },
    });
    await db.orgMember.create({
      data: { organizationId: orgA.id, userId: orgAAdmin.id, role: 'ADMIN' },
    });
    await subscribe('CONTRIBUTOR', sys.id);
    const res = await call(contribB.id, `hrn:memory:${sys.urn}`, ctx({ userId: orgAAdmin.id, roles: ['READER'] }));
    expect(subGrants(res)).toHaveLength(0);
    expect(res.canWrite).toBe(false);
  });

  it('personal and private memories are never subscription-reachable (strict owner)', async () => {
    for (const cls of ['personal', 'private'] as const) {
      const mem = await db.memory.create({
        data: {
          id: generateId(),
          organizationId: orgA.id,
          urn: `${orgA.urn}:${cls}-x`,
          name: `${cls}-x`,
          class: cls,
          userId: admin.id,
        },
      });
      await subscribe('CONTRIBUTOR', mem.id);
      const res = await call(contribB.id, `hrn:memory:${mem.urn}`, asAdmin());
      expect(subGrants(res)).toHaveLength(0);
      expect(res.canRead).toBe(false);
      expect(res.canWrite).toBe(false);
    }
  });

  it('an app-scoped knowledge memory (appId set) is never subscription-reachable (#653)', async () => {
    const app = await db.app.create({
      data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:scopedapp`, name: 'scopedapp' },
    });
    const mem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        appId: app.id,
        urn: `${orgA.urn}:scopedkb`,
        name: 'scopedkb',
        class: 'knowledge',
      },
    });
    await subscribe('CONTRIBUTOR', mem.id);
    const res = await call(contribB.id, `hrn:memory:${mem.urn}`, asAdmin());
    expect(subGrants(res)).toHaveLength(0);
    expect(res.canRead).toBe(false);
    expect(res.canWrite).toBe(false);
  });

  it('a per-user holding (userMemoryOfAgentId set) is never subscription-reachable', async () => {
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:holdagent`, name: 'h' },
    });
    const mem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        urn: `${orgA.urn}:holding`,
        name: 'holding',
        class: 'knowledge',
        visibility: 'ORGANIZATION',
        userMemoryOfAgentId: agent.id,
        createdBy: readerB.id,
      },
    });
    await subscribe('CONTRIBUTOR', mem.id);
    const res = await call(contribB.id, `hrn:memory:${mem.urn}`, asAdmin());
    expect(subGrants(res)).toHaveLength(0);
    expect(res.canRead).toBe(false);
    expect(res.canWrite).toBe(false);
  });
});

describe('#329 parity with the enforced gates (item 6)', () => {
  // The audit's read/write answers must equal what getOrgReadableMemoryIds
  // and requireMemoryWriteAccess decide for the SAME user on the SAME memory,
  // for every fixture shape above.
  async function assertParity(subjectId: string, memoryId: string, memoryUrn: string) {
    const res = await call(subjectId, `hrn:memory:${memoryUrn}`, asAdmin());
    const gateRead = (
      await getOrgReadableMemoryIds(db, subjectId, memoryId)
    ).includes(memoryId);
    let gateWrite = false;
    try {
      await requireMemoryWriteAccess(ctx({ userId: subjectId, roles: ['READER'] }), memoryId);
      gateWrite = true;
    } catch (e) {
      expect((e as Error).message).toBe('Forbidden: no write access to this memory');
    }
    expect({ read: res.canRead, write: res.canWrite }).toEqual({
      read: gateRead,
      write: gateWrite,
    });
  }

  it('live READER subscription, READER member', async () => {
    await subscribe('READER');
    await assertParity(readerB.id, kb.id, kb.urn);
  });

  it('live CONTRIBUTOR subscription, CONTRIBUTOR member', async () => {
    await subscribe('CONTRIBUTOR');
    await assertParity(contribB.id, kb.id, kb.urn);
  });

  it('CONTRIBUTOR subscription, READER member (asymmetric roles)', async () => {
    await subscribe('CONTRIBUTOR');
    await assertParity(readerB.id, kb.id, kb.urn);
  });

  it('READER subscription, CONTRIBUTOR member (asymmetric roles)', async () => {
    await subscribe('READER');
    await assertParity(contribB.id, kb.id, kb.urn);
  });

  it('revoked subscription', async () => {
    await subscribe('CONTRIBUTOR');
    await db.memorySubscription.updateMany({
      where: { memoryId: kb.id, organizationId: orgB.id },
      data: { deletedAt: new Date() },
    });
    await assertParity(contribB.id, kb.id, kb.urn);
  });

  it('group memory under a live subscription', async () => {
    const group = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        urn: `${orgA.urn}:grpp`,
        name: 'grpp',
        class: 'group',
        visibility: 'GROUP',
      },
    });
    await subscribe('CONTRIBUTOR', group.id);
    await assertParity(contribB.id, group.id, group.urn);
  });

  it('a stranger with no membership and no subscription', async () => {
    await assertParity(stranger.id, kb.id, kb.urn);
  });
});

describe('#329 caller authorization unchanged (item 7, cor:acl:060:01)', () => {
  it('a subject\'s new subscription grant does not widen WHO may audit: a stranger still gets NOT_FOUND', async () => {
    await subscribe('CONTRIBUTOR');
    // readerB now has access, but stranger can neither open the memory nor
    // audit — exactly as before the change.
    await expect(
      call(readerB.id, `hrn:memory:${kb.urn}`, ctx({ userId: stranger.id, roles: ['READER'] })),
    ).rejects.toThrow('Resource not found');
  });

  it('self-audit surfaces the subscription grant (the only thing self-audit ever discloses)', async () => {
    await subscribe('READER');
    const res = await call(readerB.id, `hrn:memory:${kb.urn}`, ctx({ userId: readerB.id, roles: ['READER'] }));
    expect(res.canRead).toBe(true);
    expect(subGrants(res)).toHaveLength(1);
  });
});
