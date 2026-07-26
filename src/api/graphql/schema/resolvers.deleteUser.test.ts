/**
 * Integration tests for Mutation.deleteUser — self-serve account deletion
 * (#662; Apple App Store 5.1.1(v)).
 *
 * Covers:
 *   - self-delete happy path (org-less user): owned memories hard-erased,
 *     keys revoked, sessions/widgets deleted, user row scrubbed + soft-deleted,
 *     and a subsequent authenticated call is rejected (auth keys on deletedAt);
 *   - sole-OWNER org with other members → SOLE_ORG_OWNER, full rollback;
 *   - sole-member org → org soft-deleted with the account;
 *   - plain membership → OrgMember soft-deleted, org untouched;
 *   - non-admin deleting another user → FORBIDDEN, identical for existing and
 *     non-existent targets (no user-enumeration oracle);
 *   - platform admin deleting another user → works (and self-delete is never
 *     blocked by the caller's own admin bit);
 *   - App-key caller → UNAUTHENTICATED.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Request } from 'express';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { mintUserApiKey, resolveAuthContext } from '../../../middleware/auth.js';
import { resolvers, type Context } from './resolvers.js';

let seq = 0;

/** Create a live user with a unique handle/email for this test run. */
async function makeUser(overrides: { roles?: ('ADMIN' | 'OWNER' | 'READER')[] } = {}) {
  seq += 1;
  const tag = `${Date.now()}-${seq}`;
  return db.user.create({
    data: {
      id: generateId(),
      handle: `del-test-${tag}`,
      name: `Del Test ${tag}`,
      email: `del-test-${tag}@example.com`,
      roles: overrides.roles ?? ['READER'],
    },
  });
}

/** Create an org plus one live membership row for `userId`. */
async function makeOrgWithMember(userId: string, role: 'OWNER' | 'ADMIN' | 'READER') {
  seq += 1;
  const org = await db.organization.create({
    data: {
      id: generateId(),
      name: `del-test-org-${seq}`,
      urn: `del-test-org-${Date.now()}-${seq}.test`,
    },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId, role },
  });
  return org;
}

/** Context for a user credential (JWT-shaped: userId + global roles). */
function userCtx(user: { id: string; roles?: string[] }): Context {
  return {
    db,
    userId: user.id,
    roles: (user.roles ?? ['READER']) as Context['roles'],
  };
}

/** Minimal fake request carrying a bearer token for resolveAuthContext. */
function bearerReq(token: string): Request {
  return { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
}

beforeEach(async () => {
  await cleanDb(db);
});

describe('Mutation.deleteUser — self-delete happy path (org-less user)', () => {
  it('erases owned data, revokes keys, scrubs + soft-deletes the user, and blocks re-auth', async () => {
    const user = await makeUser();
    const originalHandle = user.handle;

    // Free-standing personal memory (spec 034: user-owned, no org/app).
    const personal = await db.memory.create({
      data: {
        id: generateId(),
        ownerUserId: user.id,
        userId: user.id,
        urn: `${user.handle}:personal-notes`,
        name: 'Personal Notes',
        class: 'personal',
      },
    });
    const node = await db.node.create({
      data: {
        id: generateId(),
        memoryId: personal.id,
        name: 'secret-note',
        loc: 'secret-note',
        content: 'private content',
      },
    });
    // User-owned tenant memory (spec 047 MemoryTenantOwner).
    const tenantMem = await db.memory.create({
      data: {
        id: generateId(),
        ownerUserId: user.id,
        urn: `${user.handle}:kb`,
        name: 'My KB',
        class: 'knowledge',
      },
    });

    const { rawKey, userApiKey } = await mintUserApiKey(db, {
      userId: user.id,
      label: 'test key',
      createdBy: user.id,
      issuedVia: 'portal',
    });
    // The key authenticates BEFORE deletion (sanity for the re-auth check).
    expect((await resolveAuthContext(bearerReq(rawKey), db)).userId).toBe(user.id);

    await db.session.create({ data: { id: generateId(), userId: user.id } });
    await db.dashboardWidget.create({
      data: { id: generateId(), userId: user.id, type: 'MEMORY_STATS', position: 0 },
    });

    const result = await resolvers.Mutation.deleteUser({}, {}, userCtx(user));
    expect(result).toBe(true);

    // Owned memories + their nodes are HARD-erased.
    expect(await db.memory.findUnique({ where: { id: personal.id } })).toBeNull();
    expect(await db.memory.findUnique({ where: { id: tenantMem.id } })).toBeNull();
    expect(await db.node.findUnique({ where: { id: node.id } })).toBeNull();

    // Credentials: keys revoked (kept for audit), sessions/widgets deleted.
    const keyRow = await db.userApiKey.findUniqueOrThrow({ where: { id: userApiKey.id } });
    expect(keyRow.revokedAt).not.toBeNull();
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.dashboardWidget.count({ where: { userId: user.id } })).toBe(0);

    // User row: kept (FK integrity) but scrubbed + soft-deleted.
    const scrubbed = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(scrubbed.deletedAt).not.toBeNull();
    expect(scrubbed.deletedBy).toBe(user.id);
    expect(scrubbed.name).toBeNull();
    expect(scrubbed.email).toBeNull();
    expect(scrubbed.handle).toMatch(/^deleted-[0-9a-f]{12}$/);
    expect(scrubbed.handle).not.toBe(originalHandle);

    // Deleted users no longer authenticate (middleware keys on deletedAt +
    // revokedAt) — the exact contract the iOS app relies on post-deletion.
    expect(await resolveAuthContext(bearerReq(rawKey), db)).toEqual({});
  });
});

describe('Mutation.deleteUser — org membership auto-resolve', () => {
  it('sole OWNER of an org with other members → SOLE_ORG_OWNER and NOTHING deleted', async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const org = await makeOrgWithMember(owner.id, 'OWNER');
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org.id, userId: other.id, role: 'READER' },
    });

    const mem = await db.memory.create({
      data: {
        id: generateId(),
        ownerUserId: owner.id,
        userId: owner.id,
        urn: `${owner.handle}:blocked-notes`,
        name: 'Blocked Notes',
        class: 'personal',
      },
    });
    const { userApiKey } = await mintUserApiKey(db, {
      userId: owner.id,
      label: 'blocked key',
      createdBy: owner.id,
      issuedVia: 'portal',
    });

    let caught: unknown;
    try {
      await resolvers.Mutation.deleteUser({}, {}, userCtx(owner));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GraphQLError);
    const err = caught as GraphQLError;
    expect(err.extensions.code).toBe('SOLE_ORG_OWNER');
    expect(err.extensions.organizations).toEqual([{ id: org.id, name: org.name }]);

    // Transaction rolled back — NOTHING was deleted or revoked.
    expect(await db.memory.findUnique({ where: { id: mem.id } })).not.toBeNull();
    const keyRow = await db.userApiKey.findUniqueOrThrow({ where: { id: userApiKey.id } });
    expect(keyRow.revokedAt).toBeNull();
    const userRow = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(userRow.deletedAt).toBeNull();
    expect(userRow.email).toBe(owner.email);
    const membership = await db.orgMember.findUniqueOrThrow({
      where: { organizationId_userId: { organizationId: org.id, userId: owner.id } },
    });
    expect(membership.deletedAt).toBeNull();
  });

  it('sole member of an org → the org is soft-deleted with the account', async () => {
    const user = await makeUser();
    const org = await makeOrgWithMember(user.id, 'OWNER');

    await resolvers.Mutation.deleteUser({}, {}, userCtx(user));

    const orgRow = await db.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(orgRow.deletedAt).not.toBeNull();
    const membership = await db.orgMember.findUniqueOrThrow({
      where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
    });
    expect(membership.deletedAt).not.toBeNull();
    const userRow = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(userRow.deletedAt).not.toBeNull();
  });

  it('plain membership → OrgMember soft-deleted, org untouched', async () => {
    const user = await makeUser();
    const owner = await makeUser();
    const org = await makeOrgWithMember(owner.id, 'OWNER');
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'READER' },
    });

    await resolvers.Mutation.deleteUser({}, {}, userCtx(user));

    const orgRow = await db.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(orgRow.deletedAt).toBeNull();
    const gone = await db.orgMember.findUniqueOrThrow({
      where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
    });
    expect(gone.deletedAt).not.toBeNull();
    expect(gone.deletedBy).toBe(user.id);
    const kept = await db.orgMember.findUniqueOrThrow({
      where: { organizationId_userId: { organizationId: org.id, userId: owner.id } },
    });
    expect(kept.deletedAt).toBeNull();
  });

  it('OWNER alongside ANOTHER active OWNER → not blocked, org untouched', async () => {
    const user = await makeUser();
    const coOwner = await makeUser();
    const org = await makeOrgWithMember(user.id, 'OWNER');
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org.id, userId: coOwner.id, role: 'OWNER' },
    });

    await resolvers.Mutation.deleteUser({}, {}, userCtx(user));

    const orgRow = await db.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(orgRow.deletedAt).toBeNull();
    const userRow = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(userRow.deletedAt).not.toBeNull();
  });
});

describe('Mutation.deleteUser — authorization', () => {
  it('non-admin deleting another user → FORBIDDEN, identical for existing and non-existent targets', async () => {
    const caller = await makeUser();
    const victim = await makeUser();

    const grab = async (userRef: string) => {
      try {
        await resolvers.Mutation.deleteUser({}, { userRef }, userCtx(caller));
        throw new Error('expected deleteUser to throw');
      } catch (e) {
        return e as GraphQLError;
      }
    };

    const existing = await grab(victim.id);
    const missing = await grab('hrn:user:no-such-handle-662');
    expect(existing.extensions.code).toBe('FORBIDDEN');
    // No user-enumeration oracle: the two failures are indistinguishable.
    expect(missing.message).toBe(existing.message);
    expect(missing.extensions.code).toBe(existing.extensions.code);

    // The named target was untouched.
    const victimRow = await db.user.findUniqueOrThrow({ where: { id: victim.id } });
    expect(victimRow.deletedAt).toBeNull();
  });

  it('non-admin CAN name themself (userRef resolving to the caller is the self path)', async () => {
    const user = await makeUser();
    const result = await resolvers.Mutation.deleteUser(
      {},
      { userRef: user.id },
      userCtx(user),
    );
    expect(result).toBe(true);
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.deletedAt).not.toBeNull();
  });

  it('platform admin deleting another user → works (caller untouched)', async () => {
    const admin = await makeUser({ roles: ['ADMIN'] });
    const victim = await makeUser();

    const result = await resolvers.Mutation.deleteUser(
      {},
      { userRef: victim.id },
      userCtx(admin),
    );
    expect(result).toBe(true);

    const victimRow = await db.user.findUniqueOrThrow({ where: { id: victim.id } });
    expect(victimRow.deletedAt).not.toBeNull();
    expect(victimRow.deletedBy).toBe(admin.id);
    const adminRow = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(adminRow.deletedAt).toBeNull();
  });

  it('platform admin naming a non-existent target gets the real resolution error (not FORBIDDEN)', async () => {
    const admin = await makeUser({ roles: ['ADMIN'] });
    await expect(
      resolvers.Mutation.deleteUser({}, { userRef: 'hrn:user:no-such-handle-662' }, userCtx(admin)),
    ).rejects.toThrow(/USER_NOT_FOUND/);
  });

  it('a platform admin may delete their own account (own admin bit never blocks the self path)', async () => {
    const admin = await makeUser({ roles: ['ADMIN'] });
    const result = await resolvers.Mutation.deleteUser({}, {}, userCtx(admin));
    expect(result).toBe(true);
    const row = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(row.deletedAt).not.toBeNull();
  });

  it('App-key caller → UNAUTHENTICATED', async () => {
    const appKeyCtx: Context = { db, appId: generateId(), roles: [] };
    try {
      await resolvers.Mutation.deleteUser({}, {}, appKeyCtx);
      throw new Error('expected deleteUser to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(GraphQLError);
      expect((e as GraphQLError).extensions.code).toBe('UNAUTHENTICATED');
    }
  });
});
