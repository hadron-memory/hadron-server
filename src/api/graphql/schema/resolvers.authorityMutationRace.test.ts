import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { deleteUserAccount } from '../../../controller/operations/deleteUser.js';
import { mintUserApiKey } from '../../../middleware/auth.js';

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
