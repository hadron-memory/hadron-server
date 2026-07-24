/**
 * #778 — list memories shared WITH the caller (grantee) + expose the caller's
 * OWN share.
 *
 *   - memories(filter: { sharedWithMe: true }) returns exactly the caller's
 *     grantee memories, excludes their owned / org memories, and is empty for
 *     an App-key caller (sharing is a user-to-user concept).
 *   - Memory.myShare returns the caller's own MemoryShare row (grantor + role)
 *     for a grantee, and null for the owner / a non-grantee / an App-key caller
 *     — never the co-grantee-leaking owner-only `shares` list.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;
const Mem = resolvers.Memory as any;

let org: { id: string; urn: string };
let owner: { id: string };   // principal / grantor, member of org
let grantee: { id: string }; // granted reader on the shared memory, NOT an org member
let stranger: { id: string }; // neither owner nor grantee
let sharedMem: { id: string }; // owner's personal memory, shared WITH grantee
let granteeOwned: { id: string }; // grantee's OWN personal memory (not shared to them)
let orgKnowledge: { id: string }; // org-owned knowledge memory

const ctx = (userId?: string, roles: Context['roles'] = ['READER']): Context =>
  ({ db, userId, roles });

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
  // Owner is a member of the org; grantee deliberately is NOT — so the shared
  // memory reaching the grantee must come from the share, not org membership,
  // and must NOT be narrowed away by an active-org selection.
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: owner.id, role: 'OWNER' },
  });

  // Owner's personal memory, shared with the grantee as `reader`.
  sharedMem = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:owner-shared`,
      name: 'owner-shared', class: 'personal', visibility: null, userId: owner.id,
    },
  });
  await db.memoryShare.create({
    data: { memoryId: sharedMem.id, granteeId: grantee.id, grantorId: owner.id, role: 'reader' },
  });

  // The grantee's OWN personal memory — owned, never shared TO them. It must
  // NOT appear in their sharedWithMe slice (a grantee is never their own grantor).
  // Free-standing (org NULL) → the owner-XOR requires ownerUserId set.
  granteeOwned = await db.memory.create({
    data: {
      id: generateId(), urn: `grantee-own-${Date.now()}`,
      name: 'grantee-own', class: 'personal', visibility: null,
      userId: grantee.id, ownerUserId: grantee.id,
    },
  });

  // An org-owned knowledge memory — part of the owner's union, never a share.
  orgKnowledge = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:knowledge`,
      name: 'org-knowledge', class: 'knowledge', visibility: 'ORGANIZATION',
    },
  });
});

describe('Query.memories(filter: { sharedWithMe: true }) — #778', () => {
  it('returns exactly the caller\'s grantee memories', async () => {
    const page = await Q.memories(null, { filter: { sharedWithMe: true } }, ctx(grantee.id));
    expect(page.total).toBe(1);
    expect(page.items.map((m: { id: string }) => m.id)).toEqual([sharedMem.id]);
  });

  it('excludes the grantee\'s OWN memories (owned, not shared to them)', async () => {
    const page = await Q.memories(null, { filter: { sharedWithMe: true } }, ctx(grantee.id));
    const ids = page.items.map((m: { id: string }) => m.id);
    expect(ids).not.toContain(granteeOwned.id);
    expect(ids).not.toContain(orgKnowledge.id);
  });

  it('is empty for the grantor/owner (they are never their own grantee)', async () => {
    expect(await Q.memories(null, { filter: { sharedWithMe: true } }, ctx(owner.id)))
      .toEqual({ items: [], total: 0 });
  });

  it('is empty for a caller who has no shares', async () => {
    expect(await Q.memories(null, { filter: { sharedWithMe: true } }, ctx(stranger.id)))
      .toEqual({ items: [], total: 0 });
  });

  it('still honors the cor:api:100:01 active-org gate (non-member orgId → empty, no disclosure)', async () => {
    // The grantee is not a member of `org`, so passing it as the active org
    // hits the shared resolveOrgScope gate BEFORE the sharedWithMe branch and
    // collapses to an empty page with no org-existence disclosure — the same
    // uniform-read-surface rule every other slice obeys. The portal\'s
    // "shared with me" tab is a user-global view and passes no orgId, so it
    // sees the full shared set (asserted above).
    const page = await Q.memories(
      null, { filter: { sharedWithMe: true }, orgId: org.id }, ctx(grantee.id),
    );
    expect(page).toEqual({ items: [], total: 0 });
  });

  it('an App-key caller gets an empty page (sharing is user-to-user)', async () => {
    const appCtx: Context = { db, appId: generateId(), roles: ['READER'] };
    expect(await Q.memories(null, { filter: { sharedWithMe: true } }, appCtx))
      .toEqual({ items: [], total: 0 });
  });

  it('honors limit: 0 as the count-only page', async () => {
    expect(await Q.memories(null, { filter: { sharedWithMe: true }, limit: 0 }, ctx(grantee.id)))
      .toMatchObject({ items: [], total: 1 });
  });
});

describe('Memory.myShare — #778', () => {
  it('returns the caller\'s own share (grantor + role) for a grantee', async () => {
    const share = await Mem.myShare({ id: sharedMem.id }, {}, ctx(grantee.id));
    expect(share).not.toBeNull();
    expect(share.granteeId).toBe(grantee.id);
    expect(share.grantorId).toBe(owner.id);
    expect(share.role).toBe('reader');
  });

  it('is null for the owner (principal is not a grantee of their own memory)', async () => {
    expect(await Mem.myShare({ id: sharedMem.id }, {}, ctx(owner.id))).toBeNull();
  });

  it('is null for a non-grantee stranger', async () => {
    expect(await Mem.myShare({ id: sharedMem.id }, {}, ctx(stranger.id))).toBeNull();
  });

  it('is null for an App-key caller (no userId)', async () => {
    const appCtx: Context = { db, appId: generateId(), roles: ['READER'] };
    expect(await Mem.myShare({ id: sharedMem.id }, {}, appCtx)).toBeNull();
  });

  it('reads only the caller\'s row — never a co-grantee\'s (no leak)', async () => {
    // Add a SECOND grantee to the same memory. Each grantee\'s myShare must
    // return only their own row, never the other\'s (unlike the owner-only
    // `shares` list which returns all rows).
    const grantee2 = await db.user.create({
      data: { id: generateId(), githubId: 78104, githubUsername: 'sw-grantee2', handle: 'sw-grantee2' },
    });
    await db.memoryShare.create({
      data: { memoryId: sharedMem.id, granteeId: grantee2.id, grantorId: owner.id, role: 'writer' },
    });
    const s1 = await Mem.myShare({ id: sharedMem.id }, {}, ctx(grantee.id));
    const s2 = await Mem.myShare({ id: sharedMem.id }, {}, ctx(grantee2.id));
    expect(s1.granteeId).toBe(grantee.id);
    expect(s1.role).toBe('reader');
    expect(s2.granteeId).toBe(grantee2.id);
    expect(s2.role).toBe('writer');
  });
});
