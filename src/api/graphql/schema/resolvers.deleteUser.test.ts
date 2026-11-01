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

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request } from 'express';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { mintUserApiKey, resolveAuthContext } from '../../../middleware/auth.js';
import { signJwt } from '../../../auth/jwt.js';
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

  it('a still-valid JWT of the deleted user stops authenticating immediately', async () => {
    // JWTs are self-contained (resolveJwt verifies the signature, not a DB
    // row), so without the liveness check a deleted user's session token
    // would keep working until exp — the Codex P1 on PR #800.
    const user = await makeUser();
    const jwt = await signJwt({ sub: user.id, roles: ['CONTRIBUTOR'] });
    expect((await resolveAuthContext(bearerReq(jwt), db)).userId).toBe(user.id);

    await resolvers.Mutation.deleteUser({}, {}, userCtx(user));

    expect(await resolveAuthContext(bearerReq(jwt), db)).toEqual({});
  });
});

describe('Mutation.deleteUser — app-scoped personal memory erasure (#422)', () => {
  it.each([false, true])('erases the Agent-linked memory before its Agent (installed and cast: %s)', async (cast) => {
    const user = await makeUser();
    const agent = await db.agent.create({
      data: { id: generateId(), ownerUserId: user.id, urn: `${user.handle}:assistant`, name: 'Assistant', visibility: 'PERSONAL' },
    });
    const app = await db.app.create({
      data: { id: generateId(), ownerUserId: user.id, urn: `${user.handle}:workspace`, name: 'Workspace' },
    });
    const personal = await db.memory.create({
      data: {
        id: generateId(), ownerUserId: user.id, userId: user.id,
        appId: app.id, userMemoryOfAgentId: agent.id,
        urn: `${user.handle}:assistant-notes`, name: 'Assistant Notes', class: 'personal',
      },
    });
    const node = await db.node.create({
      data: { id: generateId(), memoryId: personal.id, loc: 'private-note', name: 'Private note', content: 'Owner data' },
    });
    if (cast) await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    const worker = cast ? await db.worker.create({
      data: {
        ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id,
        name: 'Assistant', slug: 'assistant',
      },
    }) : null;

    // This persisted shape activates chk_memory_personal_agent_id: deleting
    // the Agent first would SET NULL on its FK and violate that CHECK.
    expect(await db.memory.findUniqueOrThrow({ where: { id: personal.id } })).toMatchObject({
      class: 'personal', appId: app.id, userId: user.id, userMemoryOfAgentId: agent.id,
    });
    await expect(resolvers.Mutation.deleteUser({}, {}, userCtx(user))).resolves.toBe(true);

    expect(await db.memory.findUnique({ where: { id: personal.id } })).toBeNull();
    expect(await db.node.findUnique({ where: { id: node.id } })).toBeNull();
    expect(await db.agent.findUnique({ where: { id: agent.id } })).toBeNull();
    expect(await db.app.findUnique({ where: { id: app.id } })).toBeNull();
    expect(await db.appAgent.count({ where: { appId: app.id, agentId: agent.id } })).toBe(0);
    if (worker) expect(await db.worker.findUnique({ where: { id: worker.id } })).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).deletedAt).not.toBeNull();
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
      { userRef: victim.id, reason: 'test erasure' },
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

// ── #1647 (cor:aut:020:03): reason, audit, notification ────────────────
import { processUserDeletionNotices, MAX_NOTICE_ATTEMPTS, NOTICE_LEASE_MS } from '../../../jobs/sendUserDeletionNotices.js';
import { decryptToken } from '../../../lib/tokenCrypto.js';

describe('deleteUser reason + audit + notice (#1647)', () => {
  const del = (args: Record<string, unknown>, caller: { id: string; roles?: string[] }) =>
    resolvers.Mutation.deleteUser({}, args, userCtx(caller));
  const codeOf = async (p: Promise<unknown>) => {
    try { await p; } catch (e) { return (e as GraphQLError).extensions?.code; }
    return 'NO_ERROR';
  };

  it('requires a reason when an admin deletes ANOTHER user, and the user survives the refusal', async () => {
    const admin = await makeUser({ roles: ['ADMIN'] });
    const victim = await makeUser();
    for (const reason of [undefined, '', '   ', 'x'.repeat(501)]) {
      expect(await codeOf(del({ userRef: victim.id, reason }, admin))).toBe('BAD_USER_INPUT');
    }
    expect((await db.user.findUniqueOrThrow({ where: { id: victim.id } })).deletedAt).toBeNull();
    expect(await db.userDeletionAudit.count()).toBe(0);
  });

  it('counts Unicode code points, not UTF-16 units, and trims', async () => {
    const admin = await makeUser({ roles: ['ADMIN'] });
    const victim = await makeUser();
    const reason = '😀'.repeat(500); // 1000 UTF-16 units, 500 code points
    expect(await codeOf(del({ userRef: victim.id, reason: `  ${reason}  ` }, admin))).toBe('NO_ERROR');
    const audit = await db.userDeletionAudit.findFirstOrThrow();
    expect(audit.reason).toBe(reason);
    expect(audit.actorUserId).toBe(admin.id);
    expect(audit.targetUserId).toBe(victim.id);
  });

  it('a non-admin learns nothing: FORBIDDEN comes before reason validation, for real and unknown targets alike', async () => {
    const caller = await makeUser();
    const victim = await makeUser();
    expect(await codeOf(del({ userRef: victim.id }, caller))).toBe('FORBIDDEN');
    expect(await codeOf(del({ userRef: 'hrn:user:nobody-1647', reason: 'x'.repeat(900) }, caller))).toBe('FORBIDDEN');
    expect(await db.userDeletionAudit.count()).toBe(0);
  });

  it('self-delete needs no reason and writes no audit or notice', async () => {
    const user = await makeUser();
    expect(await del({}, user)).toBe(true);
    expect(await db.userDeletionAudit.count()).toBe(0);
    expect(await db.userDeletionNotice.count()).toBe(0);
  });

  it('a second call on an erased account yields no second audit or erasure', async () => {
    const admin = await makeUser({ roles: ['ADMIN'] });
    const victim = await makeUser();
    await del({ userRef: victim.id, reason: 'first' }, admin);
    await codeOf(del({ userRef: victim.id, reason: 'second' }, admin));
    const rows = await db.userDeletionAudit.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('first');
  });

  it('concurrent calls complete one operation', async () => {
    const admin = await makeUser({ roles: ['ADMIN'] });
    const victim = await makeUser();
    await Promise.allSettled([
      del({ userRef: victim.id, reason: 'a' }, admin),
      del({ userRef: victim.id, reason: 'b' }, admin),
    ]);
    expect(await db.userDeletionAudit.count()).toBe(1);
    expect(await db.userDeletionNotice.count()).toBe(1);
  });

  it('the audit is immutable', async () => {
    const admin = await makeUser({ roles: ['ADMIN'] });
    const victim = await makeUser();
    await del({ userRef: victim.id, reason: 'r' }, admin);
    await expect(db.userDeletionAudit.updateMany({ data: { reason: 'edited' } })).rejects.toThrow();
    await expect(db.userDeletionAudit.deleteMany()).rejects.toThrow();
  });

  it('a failure after the audit write rolls the audit, the notice and the erasure back together', async () => {
    const admin = await makeUser({ roles: ['ADMIN'] });
    const victim = await makeUser();
    // A blocking org makes the deletion throw AFTER earlier steps ran.
    const org = await makeOrgWithMember(victim.id, 'OWNER');
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: (await makeUser()).id, role: 'READER' } });
    expect(await codeOf(del({ userRef: victim.id, reason: 'r' }, admin))).toBe('SOLE_ORG_OWNER');
    expect(await db.userDeletionAudit.count()).toBe(0);
    expect(await db.userDeletionNotice.count()).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: victim.id } })).deletedAt).toBeNull();
  });

  describe('notice outbox', () => {
    const ok = { configured: () => true, send: async () => {} };

    it('stores the address encrypted (not in the audit), then SENT on ack and clears the ciphertext; the notice has no reason', async () => {
      const admin = await makeUser({ roles: ['ADMIN'] });
      const victim = await makeUser();
      await del({ userRef: victim.id, reason: 'secret-reason-1647' }, admin);
      const pending = await db.userDeletionNotice.findFirstOrThrow();
      expect(pending.status).toBe('PENDING');
      expect(pending.recipientCiphertext).not.toContain(victim.email!);
      expect(decryptToken(pending.recipientCiphertext!)).toBe(victim.email);
      expect(JSON.stringify(await db.userDeletionAudit.findMany())).not.toContain(victim.email!);

      const sent: string[] = [];
      await processUserDeletionNotices(db, { configured: () => true, send: async (to) => { sent.push(to); } });
      expect(sent).toEqual([victim.email]);
      const done = await db.userDeletionNotice.findFirstOrThrow();
      expect(done.status).toBe('SENT');
      expect(done.recipientCiphertext).toBeNull();
      // A further pass sends nothing.
      await processUserDeletionNotices(db, { configured: () => true, send: async (to) => { sent.push(to); } });
      expect(sent).toHaveLength(1);
    });

    it('retries up to 3 times then FAILED, clearing the ciphertext', async () => {
      const admin = await makeUser({ roles: ['ADMIN'] });
      const victim = await makeUser();
      await del({ userRef: victim.id, reason: 'r' }, admin);
      let calls = 0;
      const bad = { configured: () => true, send: async () => { calls += 1; throw new Error('boom'); } };
      for (let i = 0; i < MAX_NOTICE_ATTEMPTS + 2; i++) await processUserDeletionNotices(db, bad);
      expect(calls).toBe(MAX_NOTICE_ATTEMPTS);
      const row = await db.userDeletionNotice.findFirstOrThrow();
      expect(row.status).toBe('FAILED');
      expect(row.recipientCiphertext).toBeNull();
    });

    it('a failed first try stays PENDING and a restart (a new pass) resumes it', async () => {
      const admin = await makeUser({ roles: ['ADMIN'] });
      const victim = await makeUser();
      await del({ userRef: victim.id, reason: 'r' }, admin);
      await processUserDeletionNotices(db, { configured: () => true, send: async () => { throw new Error('once'); } });
      expect((await db.userDeletionNotice.findFirstOrThrow()).status).toBe('PENDING');
      await processUserDeletionNotices(db, ok);
      expect((await db.userDeletionNotice.findFirstOrThrow()).status).toBe('SENT');
    });

    it('no recipient is UNAVAILABLE at once; no configured sender is UNAVAILABLE at send time', async () => {
      const admin = await makeUser({ roles: ['ADMIN'] });
      const noMail = await makeUser();
      await db.user.update({ where: { id: noMail.id }, data: { email: null } });
      const victim = await makeUser();
      await del({ userRef: noMail.id, reason: 'r' }, admin);
      await del({ userRef: victim.id, reason: 'r' }, admin);
      const before = await db.userDeletionNotice.findMany({ orderBy: { createdAt: 'asc' } });
      expect(before.map((n) => n.status)).toEqual(['UNAVAILABLE', 'PENDING']);
      await processUserDeletionNotices(db, { configured: () => false, send: async () => { throw new Error('never'); } });
      const after = await db.userDeletionNotice.findMany();
      expect(after.every((n) => n.status === 'UNAVAILABLE' && n.recipientCiphertext === null)).toBe(true);
    });
  });
});

describe('notice outbox claim / lease (#1647 fix head)', () => {
  const t0 = new Date('2026-10-16T06:00:00.000Z');
  const later = (ms: number) => () => new Date(t0.getTime() + ms);
  async function pendingNotice() {
    const admin = await makeUser({ roles: ['ADMIN'] });
    const victim = await makeUser();
    await resolvers.Mutation.deleteUser({}, { userRef: victim.id, reason: 'r' }, userCtx(admin));
    return db.userDeletionNotice.findFirstOrThrow();
  }
  const deferred = () => {
    let resolve!: () => void; let reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  it('no pass reclaims a notice while another pass has a send in flight', async () => {
    await pendingNotice();
    const held = deferred();
    let calls = 0;
    const sender = { configured: () => true, send: () => { calls += 1; return held.promise; } };
    const first = processUserDeletionNotices(db, sender, () => t0);
    await vi.waitFor(() => expect(calls).toBe(1));
    await processUserDeletionNotices(db, sender, later(1000)); // overlapping pass, lease live
    await processUserDeletionNotices(db, sender, later(2000));
    expect(calls).toBe(1);
    held.resolve();
    await first;
    expect((await db.userDeletionNotice.findFirstOrThrow()).status).toBe('SENT');
  });

  it('a crashed final try is FAILED after the lease, never a 4th send', async () => {
    const n = await pendingNotice();
    await db.userDeletionNotice.update({ where: { auditId: n.auditId }, data: { attempts: MAX_NOTICE_ATTEMPTS, leaseUntil: t0, claimToken: 'dead' } });
    let calls = 0;
    await processUserDeletionNotices(db, { configured: () => true, send: async () => { calls += 1; } }, later(60 * 60 * 1000));
    const row = await db.userDeletionNotice.findFirstOrThrow();
    expect(calls).toBe(0);
    expect(row.status).toBe('FAILED');
    expect(row.recipientCiphertext).toBeNull();
  });

  it('a live lease on the last try is left alone (no early FAILED while the 3rd send is in flight)', async () => {
    const n = await pendingNotice();
    await db.userDeletionNotice.update({ where: { auditId: n.auditId }, data: { attempts: MAX_NOTICE_ATTEMPTS, leaseUntil: new Date(t0.getTime() + 60_000), claimToken: 'live' } });
    await processUserDeletionNotices(db, { configured: () => true, send: async () => {} }, () => t0);
    expect((await db.userDeletionNotice.findFirstOrThrow()).status).toBe('PENDING');
  });

  it("a late success is not overwritten by a newer claim's failure", async () => {
    await pendingNotice();
    const heldA = deferred();
    let aCalls = 0;
    const slow = { configured: () => true, send: () => { aCalls += 1; return heldA.promise; } };
    const a = processUserDeletionNotices(db, slow, () => t0); // claim 1, then hangs
    await vi.waitFor(() => expect(aCalls).toBe(1));
    // The lease lapses; a second pass claims try 2 and fails.
    await processUserDeletionNotices(db, { configured: () => true, send: async () => { throw new Error('boom'); } }, later(NOTICE_LEASE_MS + 1000));
    expect((await db.userDeletionNotice.findFirstOrThrow()).status).toBe('PENDING');
    heldA.resolve(); // the first send finally acknowledges
    await a;
    const row = await db.userDeletionNotice.findFirstOrThrow();
    expect(row.status).toBe('SENT');
    expect(row.recipientCiphertext).toBeNull();
  });

  it("an older claim's failure cannot fail or release a newer claim", async () => {
    await pendingNotice();
    const heldA = deferred();
    let aCalls = 0;
    const a = processUserDeletionNotices(db, { configured: () => true, send: () => { aCalls += 1; return heldA.promise; } }, () => t0);
    await vi.waitFor(() => expect(aCalls).toBe(1));
    const heldB = deferred();
    let bCalls = 0;
    const b = processUserDeletionNotices(db, { configured: () => true, send: () => { bCalls += 1; return heldB.promise; } }, later(NOTICE_LEASE_MS + 1000));
    await vi.waitFor(() => expect(bCalls).toBe(1));
    heldA.reject(new Error('stale failure')); // A fails while B's claim is live
    await a;
    const mid = await db.userDeletionNotice.findFirstOrThrow();
    expect(mid.status).toBe('PENDING');
    expect(mid.leaseUntil).not.toBeNull(); // B's lease intact
    heldB.resolve();
    await b;
    expect((await db.userDeletionNotice.findFirstOrThrow()).status).toBe('SENT');
  });
});
