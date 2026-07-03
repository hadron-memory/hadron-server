/**
 * OrgMember revocation lifecycle (PR-475 follow-up — the "deliberately NOT
 * swept" sites of findings:revoked-membership-auth-gates).
 *
 * The coherent design this file pins:
 *   - removeOrgMember REVOKES via soft delete (OrgMember carries the audit
 *     tuple; the platform hard-deletes only pure join rows — cor:dmo:010:04),
 *     idempotently, and the last-owner guard counts LIVE owners only.
 *   - Rejoin REACTIVATES the tombstone: acceptInvitation and addOrgMember
 *     clear deletedAt and set the fresh role (never a P2002, never a silent
 *     no-op that leaves the ex-member locked out).
 *   - updateOrgMember refuses to edit a revoked row.
 *   - The personal-workspace lookups treat a revoked personal membership as
 *     "no workspace" (self-healing) rather than resolving an inaccessible one.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { hasPersonalWorkspace } from '../../../provisioning/personal-workspace.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let owner: { id: string };
let member: { id: string };

const ctx = (userId: string, roles: Context['roles'] = ['READER']): Context =>
  ({ db, userId, roles });

const membershipRow = () =>
  db.orgMember.findUnique({
    where: { organizationId_userId: { organizationId: org.id, userId: member.id } },
  });

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'lifecycle-org', urn: `lifecycle-org-${Date.now()}` },
  });
  owner = await db.user.create({
    data: { id: generateId(), githubId: 48101, githubUsername: `lc-owner-${generateId().slice(-8)}` },
  });
  member = await db.user.create({
    data: { id: generateId(), githubId: 48102, githubUsername: `lc-member-${generateId().slice(-8)}` },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: owner.id, role: 'OWNER' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'CONTRIBUTOR' },
  });
});

describe('removeOrgMember — revocation is a soft delete', () => {
  it('soft-deletes the row (audit preserved) and the member loses list access', async () => {
    expect(
      await M.removeOrgMember(null, { orgId: org.id, userId: member.id }, ctx(owner.id)),
    ).toBe(true);
    const row = await membershipRow();
    expect(row).not.toBeNull(); // tombstone persists
    expect(row!.deletedAt).not.toBeNull();
    expect(row!.deletedBy).toBe(owner.id);
    // The revoked member no longer sees the org (gate parity).
    const orgs = await (resolvers.Query as any).organizations(null, {}, ctx(member.id));
    expect(orgs.total).toBe(0);
  });

  it('is idempotent on an already-revoked member — even an ex-OWNER', async () => {
    // Promote to OWNER, then revoke directly (two live owners at that point).
    await db.orgMember.update({
      where: { organizationId_userId: { organizationId: org.id, userId: member.id } },
      data: { role: 'OWNER' },
    });
    await M.removeOrgMember(null, { orgId: org.id, userId: member.id }, ctx(owner.id));
    // Re-removal: the revoked ex-OWNER is not in the live owners count, and
    // must NOT trip the last-owner guard — idempotent success.
    expect(
      await M.removeOrgMember(null, { orgId: org.id, userId: member.id }, ctx(owner.id)),
    ).toBe(true);
  });

  it('still refuses to remove the last LIVE owner', async () => {
    await expect(
      M.removeOrgMember(null, { orgId: org.id, userId: owner.id }, ctx(owner.id)),
    ).rejects.toThrow('last owner');
  });
});

describe('rejoin — reactivation of the tombstone', () => {
  beforeEach(async () => {
    await M.removeOrgMember(null, { orgId: org.id, userId: member.id }, ctx(owner.id));
  });

  it('acceptInvitation reactivates a revoked membership with the invite role', async () => {
    const invite = await db.userInvitation.create({
      data: {
        id: generateId(),
        slug: `lc-invite-${generateId().slice(-8)}`,
        senderUserId: owner.id,
        organizationId: org.id,
        memberRole: 'READER',
        maxActivations: 1,
        createdBy: owner.id,
      },
    });
    expect(await M.acceptInvitation(null, { slug: invite.slug }, ctx(member.id))).toBe(true);
    const row = await membershipRow();
    expect(row!.deletedAt).toBeNull();
    expect(row!.role).toBe('READER'); // the fresh invite's role, not the old one
  });

  it('addOrgMember reactivates a revoked row instead of failing with P2002', async () => {
    const out = await M.addOrgMember(
      null,
      { orgId: org.id, userId: member.id, role: 'READER' },
      ctx(owner.id),
    );
    expect(out.deletedAt).toBeNull();
    expect(out.role).toBe('READER');
  });

  it('addOrgMember rejects a LIVE duplicate with a clean error', async () => {
    await M.addOrgMember(null, { orgId: org.id, userId: member.id, role: 'READER' }, ctx(owner.id));
    await expect(
      M.addOrgMember(null, { orgId: org.id, userId: member.id, role: 'ADMIN' }, ctx(owner.id)),
    ).rejects.toThrow('already a member');
  });

  it('updateOrgMember refuses to edit a revoked row', async () => {
    await expect(
      M.updateOrgMember(null, { orgId: org.id, userId: member.id, role: 'ADMIN' }, ctx(owner.id)),
    ).rejects.toThrow('not a member');
  });
});

describe('personal-workspace lookups ignore revoked memberships', () => {
  it('hasPersonalWorkspace is false when the personal membership is revoked (self-healing)', async () => {
    const personalOrg = await db.organization.create({
      data: {
        id: generateId(),
        name: 'lc-personal',
        urn: `lc-personal-${Date.now()}`,
        isVisible: false,
      },
    });
    const m = await db.orgMember.create({
      data: { id: generateId(), organizationId: personalOrg.id, userId: member.id, role: 'OWNER' },
    });
    expect(await hasPersonalWorkspace(db, member.id)).toBe(true);
    await db.orgMember.update({ where: { id: m.id }, data: { deletedAt: new Date() } });
    expect(await hasPersonalWorkspace(db, member.id)).toBe(false);
  });
});
