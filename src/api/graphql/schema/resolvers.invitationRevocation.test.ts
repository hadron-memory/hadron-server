import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { deleteUserAccount } from '../../../controller/operations/deleteUser.js';

const M = resolvers.Mutation as any;
const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

let orgId: string;
let ownerId: string;
let adminId: string;
let inviteeId: string;

async function invite(senderUserId: string) {
  return db.userInvitation.create({
    data: {
      id: generateId(), slug: `revocation-${generateId()}`,
      senderUserId, organizationId: orgId, memberRole: 'READER',
      maxActivations: 1, createdBy: senderUserId,
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), urn: `revocation-${generateId()}`, name: 'Invitation revocation' },
  });
  orgId = org.id;
  const users = await Promise.all([1, 2, 3].map((n) => db.user.create({
    data: { id: generateId(), githubId: 155800 + n, githubUsername: `invite-revoke-${n}-${generateId()}` },
  })));
  [ownerId, adminId, inviteeId] = users.map((u) => u.id);
  await db.orgMember.createMany({ data: [
    { id: generateId(), organizationId: orgId, userId: ownerId, role: 'OWNER' },
    { id: generateId(), organizationId: orgId, userId: adminId, role: 'ADMIN' },
  ] });
});

describe('#1558 inviter revocation', () => {
  it('accepts an invitation from a platform admin without org membership', async () => {
    const platformAdmin = await db.user.create({ data: {
      id: generateId(), githubId: 155804, githubUsername: `platform-inviter-${generateId()}`,
      roles: ['ADMIN'],
    } });
    const issued = await M.createUserInvitation(null, {
      orgId, memberRole: 'READER', maxActivations: 2,
    }, ctx(platformAdmin.id));
    expect(await db.orgMember.findFirst({ where: { organizationId: orgId, userId: platformAdmin.id } }))
      .toBeNull();
    expect(await M.acceptInvitation(null, { slug: issued.slug }, ctx(inviteeId))).toBe(true);
    expect(await db.userInvitationActivation.count({ where: { invitationId: issued.id } })).toBe(1);
  });

  it('rejects a platform admin invitation after the issuer loses that role', async () => {
    const platformAdmin = await db.user.create({ data: {
      id: generateId(), githubId: 155805, githubUsername: `former-platform-inviter-${generateId()}`,
      roles: ['ADMIN'],
    } });
    const issued = await M.createUserInvitation(null, {
      orgId, memberRole: 'READER', maxActivations: 2,
    }, ctx(platformAdmin.id));
    await db.user.update({ where: { id: platformAdmin.id }, data: { roles: ['READER'] } });
    await expect(M.acceptInvitation(null, { slug: issued.slug }, ctx(inviteeId)))
      .rejects.toThrow('Invitation has been revoked');
    expect(await db.userInvitationActivation.count({ where: { invitationId: issued.id } })).toBe(0);
  });

  it('acceptance queued behind platform-role removal cannot activate the invitation', async () => {
    await db.user.update({ where: { id: ownerId }, data: { roles: ['ADMIN'] } });
    const platformAdmin = await db.user.create({ data: {
      id: generateId(), githubId: 155806, githubUsername: `racing-platform-inviter-${generateId()}`,
      roles: ['ADMIN'],
    } });
    const issued = await M.createUserInvitation(null, {
      orgId, memberRole: 'READER', maxActivations: 2,
    }, ctx(platformAdmin.id));
    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { held = resolve; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${platformAdmin.id} FOR SHARE`;
      held();
      await gate;
    }, { timeout: 20_000 });
    await locked;

    const demotion = M.updateUserRoles(null, { userId: platformAdmin.id, roles: ['READER'] },
      { ...ctx(ownerId), roles: ['ADMIN'] });
    let acceptance: Promise<{ ok: boolean }> | undefined;
    try {
      await waitForLockWaitersOfType(db, 'transactionid', 1);
      acceptance = M.acceptInvitation(null, { slug: issued.slug }, ctx(inviteeId)).then(
        () => ({ ok: true }), () => ({ ok: false }),
      );
      await waitForLockWaitersOfType(db, 'advisory', 1);
      release();
      await holder;
      await demotion;
      expect((await acceptance)?.ok).toBe(false);
      expect(await db.userInvitationActivation.count({ where: { invitationId: issued.id } })).toBe(0);
    } finally {
      release();
      await Promise.allSettled([holder, demotion, acceptance]);
    }
  });

  it('removal revokes only the removed admin’s invitations', async () => {
    const removed = await invite(adminId);
    const remaining = await invite(ownerId);
    await M.removeOrgMember(null, { orgId, userId: adminId }, ctx(ownerId));
    expect((await db.userInvitation.findUniqueOrThrow({ where: { id: removed.id } })).deletedAt).not.toBeNull();
    expect((await db.userInvitation.findUniqueOrThrow({ where: { id: remaining.id } })).deletedAt).toBeNull();
    await expect(M.acceptInvitation(null, { slug: removed.slug }, ctx(inviteeId)))
      .rejects.toThrow('Invitation not found');
    expect(await M.acceptInvitation(null, { slug: remaining.slug }, ctx(inviteeId))).toBe(true);
  });

  it('demotion below ADMIN revokes invitations', async () => {
    const issued = await invite(adminId);
    await M.updateOrgMember(null, { orgId, userId: adminId, role: 'CONTRIBUTOR' }, ctx(ownerId));
    expect((await db.userInvitation.findUniqueOrThrow({ where: { id: issued.id } })).deletedAt).not.toBeNull();
  });

  it('org deletion revokes invitations from every issuer', async () => {
    const first = await invite(adminId);
    const second = await invite(ownerId);
    await db.user.update({ where: { id: ownerId }, data: { roles: ['ADMIN'] } });
    await M.deleteOrganization(null, { id: orgId }, { db, userId: ownerId, roles: ['ADMIN'] } as Context);
    for (const id of [first.id, second.id]) {
      expect((await db.userInvitation.findUniqueOrThrow({ where: { id } })).deletedAt).not.toBeNull();
    }
  });

  it('account soft deletion revokes invitations issued in surviving orgs', async () => {
    const issued = await invite(adminId);
    await deleteUserAccount(db, { targetUserId: adminId, actorUserId: adminId });
    expect((await db.userInvitation.findUniqueOrThrow({ where: { id: issued.id } })).deletedAt).not.toBeNull();
  });

  it('acceptance rechecks the inviter even if a cascade was missed', async () => {
    const issued = await invite(adminId);
    await db.orgMember.update({
      where: { organizationId_userId: { organizationId: orgId, userId: adminId } },
      data: { role: 'READER' },
    });
    await expect(M.acceptInvitation(null, { slug: issued.slug }, ctx(inviteeId)))
      .rejects.toThrow('Invitation has been revoked');
    expect(await db.userInvitationActivation.count({ where: { invitationId: issued.id } })).toBe(0);
  });

  it('acceptance waiting behind removal cannot commit after revocation', async () => {
    const issued = await invite(adminId);
    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { held = resolve; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM user_invitations WHERE id = ${issued.id} FOR SHARE`;
      held();
      await gate;
    }, { timeout: 20_000 });
    await locked;

    const removal = M.removeOrgMember(null, { orgId, userId: adminId }, ctx(ownerId));
    try {
      await waitForLockWaitersOfType(db, 'transactionid', 1);
      const acceptance = M.acceptInvitation(null, { slug: issued.slug }, ctx(inviteeId));
      await waitForLockWaitersOfType(db, 'advisory', 1);
      release();
      await holder;
      await removal;
      await expect(acceptance).rejects.toThrow('Invitation not found');
      expect(await db.userInvitationActivation.count({ where: { invitationId: issued.id } })).toBe(0);
    } finally {
      release();
      await Promise.allSettled([holder, removal]);
    }
  });

  it('removal waits for an in-flight invite write, then revokes its result', async () => {
    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { held = resolve; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`;
      held();
      await gate;
    }, { timeout: 20_000 });
    await locked;

    const invitation = M.createUserInvitation(null, {
      orgId, memberRole: 'READER', maxActivations: 2,
    }, ctx(adminId));
    try {
      await waitForLockWaitersOfType(db, 'transactionid', 1);
      let removed = false;
      const removal = M.removeOrgMember(null, { orgId, userId: adminId }, ctx(ownerId))
        .then((value: unknown) => { removed = true; return value; });
      await waitForLockWaitersOfType(db, 'advisory', 1);
      expect(removed).toBe(false);
      release();
      await holder;
      const created = await invitation;
      await removal;
      expect((await db.userInvitation.findUniqueOrThrow({ where: { id: created.id } })).deletedAt).not.toBeNull();
    } finally {
      release();
      await Promise.allSettled([holder, invitation]);
    }
  });

  it('removal sees a member inserted while its serializable snapshot waited', async () => {
    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { held = resolve; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`;
      held();
      await gate;
    }, { timeout: 20_000 });
    await locked;

    const addition = M.addOrgMember(null, { orgId, userId: inviteeId, role: 'READER' }, ctx(ownerId));
    try {
      await waitForLockWaitersOfType(db, 'transactionid', 1);
      const removal = M.removeOrgMember(null, { orgId, userId: inviteeId }, ctx(ownerId));
      await waitForLockWaitersOfType(db, 'advisory', 1);
      release();
      await holder;
      await addition;
      await removal;
      const member = await db.orgMember.findUniqueOrThrow({
        where: { organizationId_userId: { organizationId: orgId, userId: inviteeId } },
      });
      expect(member.deletedAt).not.toBeNull();
    } finally {
      release();
      await Promise.allSettled([holder, addition]);
    }
  });
});
