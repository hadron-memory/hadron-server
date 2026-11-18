import { transportRateIdentity } from '../../../lib/rateLimit/identity.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { orgMutations } from './resolvers.mutation.org.js';

beforeEach(() => cleanDb(db));

describe('#1642 dual account consent', () => {
  it('a platform admin cannot merge either account without its consent', async () => {
    const admin = await db.user.create({ data: { handle: 'consent-admin', roles: ['ADMIN'] } });
    const source = await db.user.create({ data: { handle: 'consent-source' } });
    const target = await db.user.create({ data: { handle: 'consent-target' } });
    await expect(orgMutations.mergeUsers({}, { input: { source: source.id, target: target.id } },
      { db, userId: admin.id, roles: ['ADMIN'] })).rejects.toMatchObject({
      extensions: { code: 'MERGE_CONSENT_REQUIRED' },
    });
    expect((await db.user.findUniqueOrThrow({ where: { id: source.id } })).deletedAt).toBeNull();
    expect(await db.userMerge.count()).toBe(0);
  });
});

import { beginUserMergeConsent, approveUserMergeConsent } from '../../../lib/userMergeConsent.js';
import { mergeUsers } from '../../../controller/operations/mergeUsers.js';
import { createHash } from 'node:crypto';
import type { Context } from './resolvers.helpers.js';

async function fixture() {
  const admin = await db.user.create({ data: { handle: 'admin', roles: ['ADMIN'] } });
  const source = await db.user.create({ data: { handle: 'source' } });
  const target = await db.user.create({ data: { handle: 'target' } });
  const { proof } = await beginUserMergeConsent(db, source.id, target.id, admin.id, transportRateIdentity({ userId: admin.id }));
  const key = { proofHash: createHash('sha256').update(proof).digest('hex') };
  const c = await db.userMergeConsent.findUniqueOrThrow({ where: key });
  const context = (userId: string): Context => ({ db, userId, roles: ['READER'], login: { at: c.createdAt.getTime(), method: 'email' } });
  const execute = () => mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id, actorUserId: admin.id, mergeGlobalRoles: true, consentProof: proof });
  return { admin, source, target, proof, key, c, context, execute };
}

it('requires both fresh logins and consumes the proof with a sealed merge receipt', async () => {
  const f = await fixture();
  await approveUserMergeConsent(f.context(f.source.id), f.proof, f.source.id, f.target.id);
  await expect(f.execute()).rejects.toMatchObject({ extensions: { code: 'MERGE_CONSENT_REQUIRED' } });
  expect((await db.userMergeConsent.findUniqueOrThrow({ where: f.key })).consumedAt).toBeNull();
  await approveUserMergeConsent(f.context(f.target.id), f.proof, f.source.id, f.target.id);
  await f.execute();
  const receipt = await db.userMerge.findUniqueOrThrow({ where: { sourceUserId: f.source.id } });
  expect(receipt.consentHash).toBe(f.key.proofHash);
  expect(receipt.consentReceipt).toMatchObject({ sourceUserId: f.source.id, targetUserId: f.target.id, scope: 'FULL_CONSOLIDATION', sourceLoginMethod: 'email', targetLoginMethod: 'email' });
  expect((await db.userMergeConsent.findUniqueOrThrow({ where: f.key })).consumedAt).not.toBeNull();
  await expect(approveUserMergeConsent(f.context(f.target.id), f.proof, f.source.id, f.target.id)).rejects.toMatchObject({ extensions: { code: 'MERGE_CONSENT_REQUIRED' } });
});

it('rejects old sessions, outsiders, API keys, Apps and impersonation as approvals', async () => {
  const f = await fixture();
  const base = f.context(f.source.id);
  for (const ctx of [
    { ...base, login: undefined },
    { ...base, login: { at: f.c.createdAt.getTime() - 1, method: 'email' as const } },
    { ...base, userId: f.admin.id },
    { ...base, apiKeyId: 'key' },
    { ...base, appId: 'app' },
    { ...base, sessionId: 'session' },
    { ...base, impersonation: { adminUserId: f.admin.id, reason: 'test' } },
  ]) await expect(approveUserMergeConsent(ctx as Context, f.proof, f.source.id, f.target.id)).rejects.toMatchObject({ extensions: { code: 'MERGE_CONSENT_REQUIRED' } });
  expect((await db.userMergeConsent.findUniqueOrThrow({ where: f.key })).sourceLoginAt).toBeNull();
});

it('rejects expiry and exact ordered-pair substitution without transferring data', async () => {
  const f = await fixture();
  await approveUserMergeConsent(f.context(f.source.id), f.proof, f.source.id, f.target.id);
  await approveUserMergeConsent(f.context(f.target.id), f.proof, f.source.id, f.target.id);
  await expect(mergeUsers(db, { sourceUserId: f.target.id, targetUserId: f.source.id, actorUserId: f.admin.id, mergeGlobalRoles: true, consentProof: f.proof })).rejects.toMatchObject({ extensions: { code: 'MERGE_CONSENT_REQUIRED' } });
  await db.userMergeConsent.update({ where: f.key, data: { expiresAt: new Date(0) } });
  await expect(f.execute()).rejects.toMatchObject({ extensions: { code: 'MERGE_CONSENT_REQUIRED' } });
  await expect(approveUserMergeConsent(f.context(f.source.id), f.proof, f.source.id, f.target.id)).rejects.toMatchObject({ extensions: { code: 'MERGE_CONSENT_REQUIRED' } });
  expect(await db.userMerge.count()).toBe(0);
  expect((await db.user.findUniqueOrThrow({ where: { id: f.source.id } })).deletedAt).toBeNull();
});

it('rechecks the executing admin role under locks', async () => {
  const f = await fixture();
  await approveUserMergeConsent(f.context(f.source.id), f.proof, f.source.id, f.target.id);
  await approveUserMergeConsent(f.context(f.target.id), f.proof, f.source.id, f.target.id);
  await db.user.update({ where: { id: f.admin.id }, data: { roles: ['READER'] } });
  await expect(f.execute()).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  expect((await db.userMergeConsent.findUniqueOrThrow({ where: f.key })).consumedAt).toBeNull();
});

it('admits one concurrent execution and refuses reuse', async () => {
  const f = await fixture();
  await approveUserMergeConsent(f.context(f.source.id), f.proof, f.source.id, f.target.id);
  await approveUserMergeConsent(f.context(f.target.id), f.proof, f.source.id, f.target.id);
  const results = await Promise.allSettled([f.execute(), f.execute()]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  await expect(f.execute()).rejects.toThrow();
  expect(await db.userMerge.count()).toBe(1);
});

it('rolls back proof consumption and all transfers if the final receipt fails', async () => {
  const f = await fixture();
  await approveUserMergeConsent(f.context(f.source.id), f.proof, f.source.id, f.target.id);
  await approveUserMergeConsent(f.context(f.target.id), f.proof, f.source.id, f.target.id);
  // Force a unique violation at the final receipt INSERT, after the transfers.
  await db.userMerge.create({ data: { sourceUserId: f.source.id, targetUserId: f.target.id, mergedBy: f.admin.id } });
  await expect(f.execute()).rejects.toThrow();
  expect((await db.userMergeConsent.findUniqueOrThrow({ where: f.key })).consumedAt).toBeNull();
  expect((await db.user.findUniqueOrThrow({ where: { id: f.source.id } })).deletedAt).toBeNull();
});

it('approval names the ordered pair and refuses swapped or foreign refs without writing', async () => {
  const f = await fixture();
  const approve = (source: string, target: string) => orgMutations.approveMergeUsersConsent({},
    { proof: f.proof, source, target }, f.context(f.source.id));
  for (const [source, target] of [[f.target.id, f.source.id], [f.source.id, f.admin.id], [f.source.id, 'missing-user']]) {
    await expect(approve(source, target)).rejects.toMatchObject({ extensions: { code: 'MERGE_CONSENT_REQUIRED' } });
    expect((await db.userMergeConsent.findUniqueOrThrow({ where: f.key })).sourceLoginAt).toBeNull();
  }
  await expect(approve('hrn:user:source', 'target')).resolves.toBe(true);
});

it('another platform admin cannot execute the requester’s approved proof', async () => {
  const f = await fixture();
  const other = await db.user.create({ data: { handle: 'other-admin', roles: ['ADMIN'] } });
  await approveUserMergeConsent(f.context(f.source.id), f.proof, f.source.id, f.target.id);
  await approveUserMergeConsent(f.context(f.target.id), f.proof, f.source.id, f.target.id);
  await expect(mergeUsers(db, { sourceUserId: f.source.id, targetUserId: f.target.id, actorUserId: other.id,
    mergeGlobalRoles: true, consentProof: f.proof })).rejects.toMatchObject({ extensions: { code: 'MERGE_CONSENT_REQUIRED' } });
  expect((await db.userMergeConsent.findUniqueOrThrow({ where: f.key })).consumedAt).toBeNull();
  expect((await db.user.findUniqueOrThrow({ where: { id: f.source.id } })).deletedAt).toBeNull();
  await expect(f.execute()).resolves.toMatchObject({ id: f.target.id });
});


it('fresh login remains usable with app clock skew in either direction', async () => {
  const { verifiedLoginEvidence } = await import('../../../auth/loginEvidence.js');
  const f = await fixture();
  const wallTime = Date.now();
  for (const offset of [-3_600_000, 3_600_000]) {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(wallTime + offset);
    try {
      const login = await verifiedLoginEvidence(db, 'google');
      expect(Math.abs(login.at - wallTime)).toBeLessThan(30_000);
      const ctx = { ...f.context(f.source.id), login };
      await expect(approveUserMergeConsent(ctx, f.proof, f.source.id, f.target.id)).resolves.toBe(true);
    } finally { clock.mockRestore(); }
  }
});

it('an admin API key cannot begin consent', async () => {
  const f = await fixture();
  const ctx = { db, userId: f.admin.id, roles: ['ADMIN' as const], apiKeyId: 'admin-user-key' };
  await expect(orgMutations.beginMergeUsersConsent({}, { source: f.source.id, target: f.target.id }, ctx))
    .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  expect(await db.userMergeConsent.count()).toBe(1);
});

it('an admin API key cannot execute a dual-approved merge', async () => {
  const f = await fixture();
  const ctx = { db, userId: f.admin.id, roles: ['ADMIN' as const], apiKeyId: 'admin-user-key' };
  await approveUserMergeConsent(f.context(f.source.id), f.proof, f.source.id, f.target.id);
  await approveUserMergeConsent(f.context(f.target.id), f.proof, f.source.id, f.target.id);
  await expect(orgMutations.mergeUsers({}, { input: { source: f.source.id, target: f.target.id, consentProof: f.proof } }, ctx))
    .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  expect((await db.userMergeConsent.findUniqueOrThrow({ where: f.key })).consumedAt).toBeNull();
  expect(await db.userMerge.count()).toBe(0);
});

it.each([false, true])('a requester demoted after begin cannot execute under lock (mergeGlobalRoles=%s)', async (mergeGlobalRoles) => {
  const f = await fixture();
  await approveUserMergeConsent(f.context(f.source.id), f.proof, f.source.id, f.target.id);
  await approveUserMergeConsent(f.context(f.target.id), f.proof, f.source.id, f.target.id);
  await db.user.update({ where: { id: f.admin.id }, data: { roles: ['READER'] } });
  await expect(mergeUsers(db, { sourceUserId: f.source.id, targetUserId: f.target.id,
    actorUserId: f.admin.id, mergeGlobalRoles, consentProof: f.proof })).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  expect((await db.userMergeConsent.findUniqueOrThrow({ where: f.key })).consumedAt).toBeNull();
  expect((await db.user.findUniqueOrThrow({ where: { id: f.source.id } })).deletedAt).toBeNull();
  expect(await db.userMerge.count()).toBe(0);
});

it('refuses future login evidence and keeps the first approval sealed', async () => {
  const f = await fixture();
  const ctx = f.context(f.source.id);
  await expect(approveUserMergeConsent({ ...ctx, login: { at: Date.now() + 3_600_000, method: 'email' } },
    f.proof, f.source.id, f.target.id)).rejects.toMatchObject({ extensions: { code: 'MERGE_CONSENT_REQUIRED' } });
  await approveUserMergeConsent(ctx, f.proof, f.source.id, f.target.id);
  const first = await db.userMergeConsent.findUniqueOrThrow({ where: f.key });
  await approveUserMergeConsent({ ...ctx, login: { at: ctx.login!.at, method: 'google' } }, f.proof, f.source.id, f.target.id);
  const second = await db.userMergeConsent.findUniqueOrThrow({ where: f.key });
  expect(second.sourceLoginAt).toEqual(first.sourceLoginAt);
  expect(second.sourceLoginMethod).toBe('email');
});

it('refuses an altered scope at both approval and consumption', async () => {
  const f = await fixture();
  await approveUserMergeConsent(f.context(f.source.id), f.proof, f.source.id, f.target.id);
  await approveUserMergeConsent(f.context(f.target.id), f.proof, f.source.id, f.target.id);
  await db.userMergeConsent.update({ where: f.key, data: { scope: 'PARTIAL' } });
  await expect(approveUserMergeConsent(f.context(f.source.id), f.proof, f.source.id, f.target.id))
    .rejects.toMatchObject({ extensions: { code: 'MERGE_CONSENT_REQUIRED' } });
  await expect(f.execute()).rejects.toMatchObject({ extensions: { code: 'MERGE_CONSENT_REQUIRED' } });
  expect((await db.userMergeConsent.findUniqueOrThrow({ where: f.key })).consumedAt).toBeNull();
});

it('a deleted party cannot receive a new approval', async () => {
  const f = await fixture();
  await db.user.update({ where: { id: f.target.id }, data: { deletedAt: new Date() } });
  await expect(approveUserMergeConsent(f.context(f.source.id), f.proof, f.source.id, f.target.id))
    .rejects.toMatchObject({ extensions: { code: 'MERGE_CONSENT_REQUIRED' } });
  expect((await db.userMergeConsent.findUniqueOrThrow({ where: f.key })).sourceLoginAt).toBeNull();
});
