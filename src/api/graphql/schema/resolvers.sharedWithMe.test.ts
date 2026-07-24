/**
 * #778 — memories shared WITH the caller (grantee), end to end:
 *
 *   - createMemoryShare rule: an ORG-OWNED personal memory may be shared only
 *     with a current member of its org; a FREE-STANDING (org-less) personal
 *     memory may be shared with anyone. (Agent-scoped app memories keep the
 *     spec-023 App/subscription model — covered by the 023-app-shape suites.)
 *   - memories(filter: { sharedWithMe: true }) lists the caller's grantee
 *     memories, membership-gated so the list stays in lockstep with what
 *     Query.memory will actually open; excludes owned/org memories; empty for
 *     an App-key caller.
 *   - Query.memory + node write gate honor the share (reader opens, writer
 *     writes); a revoked org membership drops an org-owned share from both.
 *   - Memory.myShare returns only the caller's own row (grantor + role), never
 *     a co-grantee's.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const Mem = resolvers.Memory as any;

let org: { id: string; urn: string };
let owner: { id: string };   // principal / grantor, member of org
let grantee: { id: string }; // co-member of org, granted on the shared memories
let stranger: { id: string }; // neither owner nor grantee, no membership

let freeShared: { id: string };   // owner's FREE-STANDING personal, reader share → grantee
let orgShared: { id: string };    // owner's ORG-OWNED personal, reader share → grantee (co-member)
let writerShared: { id: string }; // owner's FREE-STANDING personal, WRITER share → grantee
let granteeOwned: { id: string }; // grantee's OWN personal (not shared to them)
let orgKnowledge: { id: string }; // org-owned knowledge memory

const ctx = (userId?: string, roles: Context['roles'] = ['READER']): Context =>
  ({ db, userId, roles });

/** A free-standing (org-less) personal memory owned by `ownerId`. */
async function freeStandingPersonal(ownerId: string, name: string): Promise<{ id: string }> {
  return db.memory.create({
    data: {
      id: generateId(), urn: `${name}-${generateId().slice(-8)}`,
      name, class: 'personal', visibility: null,
      userId: ownerId, ownerUserId: ownerId,
    },
    select: { id: true },
  });
}

/** An org-owned personal memory owned by `ownerId` under `orgId`. */
async function orgOwnedPersonal(orgId: string, ownerId: string, name: string): Promise<{ id: string }> {
  return db.memory.create({
    data: {
      id: generateId(), organizationId: orgId, urn: `${name}-${generateId().slice(-8)}`,
      name, class: 'personal', visibility: null, userId: ownerId,
    },
    select: { id: true },
  });
}

async function share(memoryId: string, granteeId: string, grantorId: string, role: 'reader' | 'writer') {
  await db.memoryShare.create({ data: { memoryId, granteeId, grantorId, role } });
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'sw-org', urn: `sw-org-${Date.now()}` },
  });
  owner = await db.user.create({
    data: { id: generateId(), githubId: 78101, githubUsername: 'sw-owner', handle: 'sw-owner' },
  });
  grantee = await db.user.create({
    data: { id: generateId(), githubId: 78102, githubUsername: 'sw-grantee', handle: 'sw-grantee' },
  });
  stranger = await db.user.create({
    data: { id: generateId(), githubId: 78103, githubUsername: 'sw-stranger', handle: 'sw-stranger' },
  });
  // Owner and grantee are BOTH members of the org, so an org-owned personal
  // memory is legitimately shareable between them.
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: owner.id, role: 'OWNER' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: grantee.id, role: 'READER' },
  });

  freeShared = await freeStandingPersonal(owner.id, 'free-shared');
  await share(freeShared.id, grantee.id, owner.id, 'reader');

  orgShared = await orgOwnedPersonal(org.id, owner.id, 'org-shared');
  await share(orgShared.id, grantee.id, owner.id, 'reader');

  writerShared = await freeStandingPersonal(owner.id, 'writer-shared');
  await share(writerShared.id, grantee.id, owner.id, 'writer');

  granteeOwned = await freeStandingPersonal(grantee.id, 'grantee-own');

  orgKnowledge = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:knowledge`,
      name: 'org-knowledge', class: 'knowledge', visibility: 'ORGANIZATION',
    },
    select: { id: true },
  });
});

// ─── createMemoryShare rule ────────────────────────────────────────────────
describe('createMemoryShare rule (#778)', () => {
  const asOwner = () => ctx(owner.id);

  it('allows sharing an ORG-OWNED personal memory with a co-member', async () => {
    const mem = await orgOwnedPersonal(org.id, owner.id, 'org-comember');
    const { memoryShare } = await M.createMemoryShare(
      null, { memoryId: mem.id, granteeId: grantee.id, role: 'reader' }, asOwner(),
    );
    expect(memoryShare.granteeId).toBe(grantee.id);
  });

  it('REJECTS sharing an ORG-OWNED personal memory with a non-member', async () => {
    const mem = await orgOwnedPersonal(org.id, owner.id, 'org-nonmember');
    await expect(
      M.createMemoryShare(null, { memoryId: mem.id, granteeId: stranger.id, role: 'reader' }, asOwner()),
    ).rejects.toThrow(/only be shared with a member of its organization/);
  });

  it('allows sharing a FREE-STANDING personal memory with anyone (non-member)', async () => {
    const mem = await freeStandingPersonal(owner.id, 'free-anyone');
    const { memoryShare } = await M.createMemoryShare(
      null, { memoryId: mem.id, granteeId: stranger.id, role: 'writer' }, asOwner(),
    );
    expect(memoryShare.granteeId).toBe(stranger.id);
  });

  it('drops an org-owned share once the grantee leaves the org (re-share blocked)', async () => {
    const mem = await orgOwnedPersonal(org.id, owner.id, 'org-revoke');
    await M.createMemoryShare(null, { memoryId: mem.id, granteeId: grantee.id, role: 'reader' }, asOwner());
    await db.orgMember.updateMany({
      where: { organizationId: org.id, userId: grantee.id }, data: { deletedAt: new Date() },
    });
    await expect(
      M.createMemoryShare(null, { memoryId: mem.id, granteeId: grantee.id, role: 'writer' }, asOwner()),
    ).rejects.toThrow(/only be shared with a member of its organization/);
  });
});

// ─── sharedWithMe list ──────────────────────────────────────────────────────
describe('Query.memories(filter: { sharedWithMe: true }) — #778', () => {
  it('returns the caller\'s grantee memories (free-standing + org-owned co-member)', async () => {
    const page = await Q.memories(null, { filter: { sharedWithMe: true } }, ctx(grantee.id));
    expect(page.total).toBe(3);
    expect(page.items.map((m: { id: string }) => m.id).sort()).toEqual(
      [freeShared.id, orgShared.id, writerShared.id].sort(),
    );
  });

  it('excludes the grantee\'s OWN and the org\'s non-shared memories', async () => {
    const ids = (await Q.memories(null, { filter: { sharedWithMe: true } }, ctx(grantee.id)))
      .items.map((m: { id: string }) => m.id);
    expect(ids).not.toContain(granteeOwned.id);
    expect(ids).not.toContain(orgKnowledge.id);
  });

  it('drops an org-owned share when the grantee\'s org membership is revoked (list ⇔ readable)', async () => {
    await db.orgMember.updateMany({
      where: { organizationId: org.id, userId: grantee.id }, data: { deletedAt: new Date() },
    });
    const ids = (await Q.memories(null, { filter: { sharedWithMe: true } }, ctx(grantee.id)))
      .items.map((m: { id: string }) => m.id);
    // Free-standing shares survive; the org-owned one drops.
    expect(ids.sort()).toEqual([freeShared.id, writerShared.id].sort());
    expect(ids).not.toContain(orgShared.id);
  });

  it('is empty for the grantor/owner, a stranger, and an App-key caller', async () => {
    expect(await Q.memories(null, { filter: { sharedWithMe: true } }, ctx(owner.id)))
      .toEqual({ items: [], total: 0 });
    expect(await Q.memories(null, { filter: { sharedWithMe: true } }, ctx(stranger.id)))
      .toEqual({ items: [], total: 0 });
    const appCtx: Context = { db, appId: generateId(), roles: ['READER'] };
    expect(await Q.memories(null, { filter: { sharedWithMe: true } }, appCtx))
      .toEqual({ items: [], total: 0 });
  });

  it('honors limit: 0 as the count-only page', async () => {
    expect(await Q.memories(null, { filter: { sharedWithMe: true }, limit: 0 }, ctx(grantee.id)))
      .toMatchObject({ items: [], total: 3 });
  });
});

// ─── read gate (Query.memory) ───────────────────────────────────────────────
describe('Query.memory grantee read gate (#778)', () => {
  it('a grantee can open a free-standing AND an org-owned (co-member) shared memory', async () => {
    expect((await Q.memory(null, { ref: freeShared.id }, ctx(grantee.id)))?.id).toBe(freeShared.id);
    expect((await Q.memory(null, { ref: orgShared.id }, ctx(grantee.id)))?.id).toBe(orgShared.id);
  });

  it('the owner opens their own; a stranger is Forbidden', async () => {
    expect((await Q.memory(null, { ref: freeShared.id }, ctx(owner.id)))?.id).toBe(freeShared.id);
    await expect(Q.memory(null, { ref: freeShared.id }, ctx(stranger.id))).rejects.toThrow('Forbidden');
  });

  it('a grantee loses read on an org-owned share after losing org membership', async () => {
    await db.orgMember.updateMany({
      where: { organizationId: org.id, userId: grantee.id }, data: { deletedAt: new Date() },
    });
    await expect(Q.memory(null, { ref: orgShared.id }, ctx(grantee.id))).rejects.toThrow('Forbidden');
    // ...but the free-standing share is unaffected.
    expect((await Q.memory(null, { ref: freeShared.id }, ctx(grantee.id)))?.id).toBe(freeShared.id);
  });
});

// ─── write gate (requireMemoryWriteAccess via createNode) ───────────────────
describe('writer-share write gate (#778)', () => {
  it('a WRITER grantee may create a node; a READER grantee may not', async () => {
    const written = await M.createNode(
      null, { input: { memoryId: writerShared.id, loc: 'sw:writer-note', name: 'n' } }, ctx(grantee.id),
    );
    expect(written?.loc).toBe('sw:writer-note');

    await expect(
      M.createNode(
        null, { input: { memoryId: freeShared.id, loc: 'sw:reader-note', name: 'n' } }, ctx(grantee.id),
      ),
    ).rejects.toThrow(/Forbidden|no write access/);
  });
});

// ─── Memory.myShare ─────────────────────────────────────────────────────────
describe('Memory.myShare — #778', () => {
  it('returns the caller\'s own share (grantor + role) for a grantee', async () => {
    const s = await Mem.myShare({ id: freeShared.id }, {}, ctx(grantee.id));
    expect(s.granteeId).toBe(grantee.id);
    expect(s.grantorId).toBe(owner.id);
    expect(s.role).toBe('reader');
    expect((await Mem.myShare({ id: writerShared.id }, {}, ctx(grantee.id))).role).toBe('writer');
  });

  it('is null for the owner, a non-grantee, and an App-key caller', async () => {
    expect(await Mem.myShare({ id: freeShared.id }, {}, ctx(owner.id))).toBeNull();
    expect(await Mem.myShare({ id: freeShared.id }, {}, ctx(stranger.id))).toBeNull();
    const appCtx: Context = { db, appId: generateId(), roles: ['READER'] };
    expect(await Mem.myShare({ id: freeShared.id }, {}, appCtx)).toBeNull();
  });

  it('reads only the caller\'s row — never a co-grantee\'s (no leak)', async () => {
    const grantee2 = await db.user.create({
      data: { id: generateId(), githubId: 78104, githubUsername: 'sw-grantee2', handle: 'sw-grantee2' },
    });
    await share(freeShared.id, grantee2.id, owner.id, 'writer');
    const s1 = await Mem.myShare({ id: freeShared.id }, {}, ctx(grantee.id));
    const s2 = await Mem.myShare({ id: freeShared.id }, {}, ctx(grantee2.id));
    expect(s1.granteeId).toBe(grantee.id);
    expect(s1.role).toBe('reader');
    expect(s2.granteeId).toBe(grantee2.id);
    expect(s2.role).toBe('writer');
  });
});
