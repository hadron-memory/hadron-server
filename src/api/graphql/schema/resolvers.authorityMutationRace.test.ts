import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { deleteUserAccount } from '../../../controller/operations/deleteUser.js';
import { mintUserApiKey } from '../../../middleware/auth.js';
import { withAuthorizedTx } from './authorizedTx.js';

const M = resolvers.Mutation as any;
let ownerId: string;
let orgId: string;
let appId: string;

beforeEach(async () => {
  await cleanDb(db);
  const owner = await db.user.create({ data: {
    id: generateId(), githubId: 1551001, githubUsername: `authority-${generateId()}`,
  } });
  ownerId = owner.id;
  const org = await db.organization.create({ data: {
    id: generateId(), urn: `authority-${generateId()}`, name: 'Authority race',
  } });
  orgId = org.id;
  await db.orgMember.create({ data: {
    id: generateId(), organizationId: orgId, userId: ownerId, role: 'OWNER',
  } });
  const app = await db.app.create({ data: {
    id: generateId(), organizationId: orgId, urn: `${org.urn}:app`, name: 'Race App',
  } });
  appId = app.id;
});

const ctx = (): Context => ({ db, userId: ownerId, roles: ['READER'] }) as Context;

describe('#1551 actual mutation races', () => {
  it('does not add a member after the target User is tombstoned during its row-lock wait', async () => {
    const target = await db.user.create({ data: {
      id: generateId(), githubId: 1551010, githubUsername: `deleted-target-${generateId()}`,
    } });
    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { held = resolve; });
    const deletion = db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
      held();
      await gate;
    }, { timeout: 20_000 });
    await locked;

    const grant = M.addOrgMember(null, { orgId, userId: target.id, role: 'READER' }, ctx())
      .then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
    try {
      await waitForLockWaitersOfType(db, 'transactionid', 1);
      release();
      await deletion;
      const result = await grant;
      expect(result.ok).toBe(false);
      expect((result.error as Error)?.message).toMatch(/Forbidden/);
      expect(await db.orgMember.count({ where: { organizationId: orgId, userId: target.id } })).toBe(0);
    } finally {
      release();
      await Promise.allSettled([deletion, grant]);
    }
  });

  it('does not create an Agent org grant after the Agent is tombstoned during its row-lock wait', async () => {
    const agent = await db.agent.create({ data: {
      id: generateId(), organizationId: orgId, urn: `authority-agent-${generateId()}`,
      name: 'Deleted target', visibility: 'PUBLIC',
    } });
    const subscriberOrg = await db.organization.create({ data: {
      id: generateId(), urn: `subscriber-${generateId()}`, name: 'Subscriber',
    } });
    await db.orgMember.create({ data: {
      id: generateId(), organizationId: subscriberOrg.id, userId: ownerId, role: 'ADMIN',
    } });
    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { held = resolve; });
    const deletion = db.$transaction(async (tx) => {
      await tx.agent.update({ where: { id: agent.id }, data: { deletedAt: new Date() } });
      held();
      await gate;
    }, { timeout: 20_000 });
    await locked;

    const grant = M.createAgentOrgGrant(null, { agentRef: agent.id, orgRef: subscriberOrg.id }, ctx())
      .then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
    try {
      await waitForLockWaitersOfType(db, 'transactionid', 1);
      release();
      await deletion;
      const result = await grant;
      expect(result.ok).toBe(false);
      expect((result.error as Error)?.message).toMatch(/Forbidden/);
      expect(await db.agentOrgGrant.count({ where: { orgId: subscriberOrg.id, agentId: agent.id } })).toBe(0);
    } finally {
      release();
      await Promise.allSettled([deletion, grant]);
    }
  });

  it('reloads platform roles before an App-key grant', async () => {
    const formerAdmin = await db.user.create({ data: {
      id: generateId(), githubId: 1551003, githubUsername: `former-admin-${generateId()}`,
      roles: ['READER'],
    } });
    await expect(M.createAppKey(null, { appRef: appId, label: 'stale role' },
      { db, userId: formerAdmin.id, roles: ['ADMIN'] } as Context))
      .rejects.toThrow(/Forbidden/);
    expect(await db.appKey.count({ where: { appId } })).toBe(0);
  });

  it('keeps platform roles empty in an impersonated transaction context', async () => {
    await db.user.update({ where: { id: ownerId }, data: { roles: ['ADMIN'] } });
    const result = await withAuthorizedTx({
      db, userId: ownerId, roles: [],
      impersonation: { sessionId: generateId(), actorUserId: ownerId, orgId, expiresAt: new Date(Date.now() + 60_000) },
    }, [{ kind: 'org', id: orgId }], async (txCtx) => {
      expect(txCtx.roles).toEqual([]);
      expect(txCtx.impersonation?.orgId).toBe(orgId);
    }, async () => true);
    expect(result).toBe(true);
  });

  it('a queued grant cannot use the user key revoked before its authority gate', async () => {
    const { userApiKey } = await mintUserApiKey(db, {
      userId: ownerId, createdBy: ownerId, label: 'presented key', issuedVia: 'portal',
    });
    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { held = resolve; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM user_api_keys WHERE id = ${userApiKey.id} FOR SHARE`;
      held();
      await gate;
    }, { timeout: 20_000 });
    await locked;

    const revocation = M.revokeUserApiKey(null, { id: userApiKey.id }, ctx());
    let grant: Promise<{ ok: boolean; error?: unknown }> | undefined;
    try {
      await waitForLockWaitersOfType(db, 'transactionid', 1);
      grant = M.createAppKey(null, { appRef: appId, label: 'revoked caller' },
        { ...ctx(), apiKeyId: userApiKey.id })
        .then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
      await waitForLockWaitersOfType(db, 'advisory', 1);
      release();
      await holder;
      await revocation;
      const result = await grant;
      expect(result?.ok).toBe(false);
      expect((result?.error as Error)?.message).toMatch(/Forbidden/);
      expect(await db.appKey.count({ where: { appId } })).toBe(0);
    } finally {
      release();
      await Promise.allSettled([holder, revocation, grant]);
    }
  });

  it('OAuth/bootstrap mint helper cannot issue a key after account deletion', async () => {
    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { held = resolve; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${ownerId} FOR UPDATE`;
      held();
      await gate;
    }, { timeout: 20_000 });
    await locked;

    const mint = mintUserApiKey(db, {
      userId: ownerId, createdBy: ownerId, label: 'external path', issuedVia: 'oauth:test',
    });
    try {
      await waitForLockWaitersOfType(db, 'transactionid', 1);
      const deletion = deleteUserAccount(db, { targetUserId: ownerId, actorUserId: ownerId });
      await waitForLockWaitersOfType(db, 'advisory', 1);
      release();
      await holder;
      const issued = await mint;
      await deletion;
      expect((await db.userApiKey.findUniqueOrThrow({ where: { id: issued.userApiKey.id } })).revokedAt)
        .not.toBeNull();
    } finally {
      release();
      await Promise.allSettled([holder, mint]);
    }
  });

  it('account deletion revokes a user key minted before the user-anchor handoff', async () => {
    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { held = resolve; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${ownerId} FOR UPDATE`;
      held();
      await gate;
    }, { timeout: 20_000 });
    await locked;

    const issuance = M.createUserApiKey(null, { label: 'before account deletion' }, ctx());
    try {
      await waitForLockWaitersOfType(db, 'transactionid', 1);
      const deletion = deleteUserAccount(db, { targetUserId: ownerId, actorUserId: ownerId });
      await waitForLockWaitersOfType(db, 'advisory', 1);
      release();
      await holder;
      const issued = await issuance;
      await deletion;
      expect((await db.userApiKey.findUniqueOrThrow({ where: { id: issued.userApiKey.id } })).revokedAt)
        .not.toBeNull();
      expect((await db.user.findUniqueOrThrow({ where: { id: ownerId } })).deletedAt).not.toBeNull();
    } finally {
      release();
      await Promise.allSettled([holder, issuance]);
    }
  });

  it('platform-role revocation waits for a user-key mint, then leaves its authority downgraded', async () => {
    await db.user.update({ where: { id: ownerId }, data: { roles: ['ADMIN'] } });
    const admin = await db.user.create({ data: {
      id: generateId(), githubId: 1551002, githubUsername: `role-admin-${generateId()}`,
      roles: ['ADMIN'],
    } });
    let release!: () => void;
    let held!: () => void;
    const holdGate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { held = resolve; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${ownerId} FOR UPDATE`;
      held();
      await holdGate;
    }, { timeout: 20_000 });
    await locked;

    const mint = M.createUserApiKey(null, { label: 'race' }, ctx());
    try {
      await waitForLockWaitersOfType(db, 'transactionid', 1);
      let revoked = false;
      const revoke = M.updateUserRoles(null, { userId: ownerId, roles: ['READER'] },
        { db, userId: admin.id, roles: ['ADMIN'] } as Context)
        .then((value: unknown) => { revoked = true; return value; });
      await waitForLockWaitersOfType(db, 'advisory', 1);
      expect(revoked).toBe(false);
      release();
      await holder;
      const issued = await mint;
      await revoke;
      expect(await db.userApiKey.findUnique({ where: { id: issued.userApiKey.id } })).not.toBeNull();
      expect((await db.user.findUniqueOrThrow({ where: { id: ownerId } })).roles).toEqual(['READER']);
    } finally {
      release();
      await Promise.allSettled([holder, mint]);
    }
  });

  it('App deletion waits for an in-flight App-key grant, then disables that key', async () => {
    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { held = resolve; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM apps WHERE id = ${appId} FOR UPDATE`;
      held();
      await gate;
    }, { timeout: 20_000 });
    await locked;

    const issuance = M.createAppKey(null, { appRef: appId, label: 'race' }, ctx());
    try {
      await waitForLockWaitersOfType(db, 'transactionid', 1);
      let deleted = false;
      const deletion = M.deleteApp(null, { ref: appId }, ctx()).then((value: unknown) => {
        deleted = true;
        return value;
      });
      await waitForLockWaitersOfType(db, 'advisory', 1);
      expect(deleted).toBe(false);
      release();
      await holder;
      const issued = await issuance;
      await deletion;
      expect((await db.appKey.findUniqueOrThrow({ where: { id: issued.key.id } })).revokedAt).toBeNull();
      expect((await db.app.findUniqueOrThrow({ where: { id: appId } })).deletedAt).not.toBeNull();
    } finally {
      release();
      await Promise.allSettled([holder, issuance]);
    }
  });
});
