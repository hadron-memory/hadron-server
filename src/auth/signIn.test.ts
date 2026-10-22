/**
 * #1897 foundation A (R66): a revocable sign-in root and the lineage of what descends from it.
 * Real Postgres: the guarantees live in locks, FKs and triggers, not in application branches.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { signJwt } from './jwt.js';
import { createSignIn, endSignInsCompletedBy, verifyAuthenticatedJwt } from './signIn.js';
import { mintUserApiKey, resolveAuthContext } from '../middleware/auth.js';
import { issueLoginCode, redeemLoginCode } from './authHandoff.js';

let userId: string;
let otherUserId: string;
let passkeyId: string;
let otherPasskeyId: string;

async function seedPasskey(ownerId: string, tag: string): Promise<string> {
  const id = generateId();
  await db.$executeRaw`INSERT INTO passkey_credentials
    (id, owner_id, credential_id, public_key, algorithm, user_handle, enrollment_rp_id, label, registered_at, counter, transports, backup_eligible, backed_up)
    VALUES (${id}, ${ownerId}, ${Buffer.from(`cred-${tag}-${id}`)}, ${Buffer.from('pk')}, -7, ${Buffer.alloc(32, 1)}, 'example.test', 'Synthetic',
      (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3), 0, ARRAY['internal'], false, false)`;
  return id;
}
async function revoke(id: string) {
  await db.$executeRaw`UPDATE passkey_credentials SET revoked_at=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id=${id}`;
}
async function signIn(owner = userId, passkey: string | null = passkeyId) {
  return db.$transaction((tx) => createSignIn(tx, { userId: owner, method: 'email', passkeyId: passkey }));
}
function bearer(token: string): Request {
  return { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
}
function jwtFor(sub: string, sid?: string) {
  return signJwt({ sub, roles: [], email: 'a@example.com', ...(sid ? { sid } : {}) });
}

beforeEach(async () => {
  await cleanDb(db);
  userId = (await db.user.create({ data: { githubId: 1897001, githubUsername: 'sign-in-a', roles: [] } })).id;
  otherUserId = (await db.user.create({ data: { githubId: 1897002, githubUsername: 'sign-in-b', roles: [] } })).id;
  passkeyId = await seedPasskey(userId, 'a');
  otherPasskeyId = await seedPasskey(userId, 'b');
});

describe('sid-bearing JWTs consult the database', () => {
  it('accepts a live sign-in and refuses it the moment the passkey that completed it is cancelled', async () => {
    const si = await signIn();
    const token = await jwtFor(userId, si.id);
    await expect(verifyAuthenticatedJwt(token, db)).resolves.toMatchObject({ sub: userId, sid: si.id });
    expect((await resolveAuthContext(bearer(token), db)).userId).toBe(userId);
    await revoke(passkeyId);
    await db.$transaction((tx) => endSignInsCompletedBy(tx, passkeyId));
    await expect(verifyAuthenticatedJwt(token, db)).rejects.toThrow();
    expect(await resolveAuthContext(bearer(token), db)).toEqual({});
  });
  it('a crypto-valid sid naming no row is invalid, never legacy', async () => {
    await expect(verifyAuthenticatedJwt(await jwtFor(userId, generateId()), db)).rejects.toThrow();
  });
  it('a sid naming another owner\'s sign-in is invalid', async () => {
    const si = await signIn(userId);
    await expect(verifyAuthenticatedJwt(await jwtFor(otherUserId, si.id), db)).rejects.toThrow();
  });
  it('a pre-cutover JWT without sid keeps validating (S6)', async () => {
    await expect(verifyAuthenticatedJwt(await jwtFor(userId), db)).resolves.toMatchObject({ sub: userId });
  });
});

describe('endSignInsCompletedBy', () => {
  it('ends exactly that passkey\'s sign-ins, their keys and descendants, and nothing else', async () => {
    const mine = await signIn(userId, passkeyId);
    const theirs = await signIn(userId, otherPasskeyId);
    const rootKey = await mintUserApiKey(db, { userId, label: 'root', createdBy: userId, issuedVia: 'oauth:c', originSignInId: mine.id });
    const child = await mintUserApiKey(db, { userId, label: 'child', createdBy: userId, issuedVia: 'oauth:c', mintedByKeyId: rootKey.userApiKey.id });
    const otherLineage = await mintUserApiKey(db, { userId, label: 'other', createdBy: userId, issuedVia: 'oauth:c', originSignInId: theirs.id });
    const direct = await mintUserApiKey(db, { userId, label: 'direct', createdBy: userId, issuedVia: 'portal' });
    expect(child.userApiKey.originSignInId).toBe(mine.id);
    await revoke(passkeyId);
    await db.$transaction((tx) => endSignInsCompletedBy(tx, passkeyId));
    const rows = await db.userApiKey.findMany({ where: { userId } });
    const by = (id: string) => rows.find((r) => r.id === id)!;
    expect(by(rootKey.userApiKey.id).revokedAt).not.toBeNull();
    expect(by(child.userApiKey.id).revokedAt).not.toBeNull();
    expect(by(otherLineage.userApiKey.id).revokedAt).toBeNull();
    expect(by(direct.userApiKey.id).revokedAt).toBeNull();
    expect((await db.signIn.findUnique({ where: { id: mine.id } }))!.endedAt).not.toBeNull();
    expect((await db.signIn.findUnique({ where: { id: theirs.id } }))!.endedAt).toBeNull();
    expect((await resolveAuthContext(bearer(rootKey.rawKey), db))).toEqual({});
    expect((await resolveAuthContext(bearer(direct.rawKey), db)).userId).toBe(userId);
  });
  it('is idempotent and keeps the first revocation time', async () => {
    const si = await signIn();
    const key = await mintUserApiKey(db, { userId, label: 'k', createdBy: userId, issuedVia: 'oauth:c', originSignInId: si.id });
    await revoke(passkeyId);
    await db.$transaction((tx) => endSignInsCompletedBy(tx, passkeyId));
    const first = (await db.userApiKey.findUnique({ where: { id: key.userApiKey.id } }))!.revokedAt;
    await db.$transaction((tx) => endSignInsCompletedBy(tx, passkeyId));
    expect((await db.userApiKey.findUnique({ where: { id: key.userApiKey.id } }))!.revokedAt).toEqual(first);
  });
  it('zero completed sign-ins is a valid empty lineage', async () => {
    await revoke(otherPasskeyId);
    await expect(db.$transaction((tx) => endSignInsCompletedBy(tx, otherPasskeyId))).resolves.toBeUndefined();
  });
  it('refuses an unknown passkey and a passkey that is not yet revoked (loud, never a silent no-op)', async () => {
    await expect(db.$transaction((tx) => endSignInsCompletedBy(tx, generateId()))).rejects.toThrow();
    await expect(db.$transaction((tx) => endSignInsCompletedBy(tx, passkeyId))).rejects.toThrow();
  });
  it('invalidates outstanding handoff and authorization codes of the ended roots', async () => {
    const si = await signIn();
    const h = await db.authHandoffCode.create({ data: { codeHash: generateId(), kind: 'login', userId, signInId: si.id, expiresAt: new Date(Date.now() + 60_000) } });
    await revoke(passkeyId);
    await db.$transaction((tx) => endSignInsCompletedBy(tx, passkeyId));
    expect((await db.authHandoffCode.findUnique({ where: { id: h.id } }))!.redeemedAt).not.toBeNull();
  });
});

describe('minting under an ended root', () => {
  it('refuses a root-carrying mint once the sign-in is ended, and a descendant of an ended root', async () => {
    const si = await signIn();
    const key = await mintUserApiKey(db, { userId, label: 'k', createdBy: userId, issuedVia: 'oauth:c', originSignInId: si.id });
    await revoke(passkeyId);
    await db.$transaction((tx) => endSignInsCompletedBy(tx, passkeyId));
    await expect(mintUserApiKey(db, { userId, label: 'late', createdBy: userId, issuedVia: 'oauth:c', originSignInId: si.id })).rejects.toThrow();
    await expect(mintUserApiKey(db, { userId, label: 'late-child', createdBy: userId, issuedVia: 'oauth:c', mintedByKeyId: key.userApiKey.id })).rejects.toThrow();
    expect(await db.userApiKey.count({ where: { userId, originSignInId: si.id } })).toBe(1);
  });
  it('a mint racing the cancellation never leaves a live key (both orders)', async () => {
    for (let i = 0; i < 8; i++) {
      const pk = await seedPasskey(userId, `race${i}`);
      const si = await signIn(userId, pk);
      await revoke(pk);
      const mint = mintUserApiKey(db, { userId, label: 'race', createdBy: userId, issuedVia: 'oauth:c', originSignInId: si.id }).catch(() => null);
      const end = db.$transaction((tx) => endSignInsCompletedBy(tx, pk));
      await Promise.all([mint, end]);
      expect(await db.userApiKey.count({ where: { originSignInId: si.id, revokedAt: null } })).toBe(0);
    }
  });
  it('refuses a root of another owner', async () => {
    const si = await signIn(userId);
    await expect(mintUserApiKey(db, { userId: otherUserId, label: 'x', createdBy: otherUserId, issuedVia: 'oauth:c', originSignInId: si.id })).rejects.toThrow();
  });
});

describe('login handoff carries the root', () => {
  it('redeems with the sign-in id, and refuses once the sign-in has ended', async () => {
    const si = await signIn();
    const code = await issueLoginCode({ userId, redirect: '/', isNew: false, signInId: si.id });
    await expect(redeemLoginCode(code)).resolves.toMatchObject({ userId, signInId: si.id });
    const second = await issueLoginCode({ userId, redirect: '/', isNew: false, signInId: si.id });
    await revoke(passkeyId);
    await db.$transaction((tx) => endSignInsCompletedBy(tx, passkeyId));
    await expect(redeemLoginCode(second)).resolves.toBeNull();
  });
  it('an unrooted (identity-provider) handoff is unchanged', async () => {
    const code = await issueLoginCode({ userId, redirect: '/x', isNew: true });
    await expect(redeemLoginCode(code)).resolves.toMatchObject({ userId, signInId: null, redirect: '/x' });
  });
});

describe('handoff expiry is judged after the row lock', () => {
  it('a handoff that expires while its row is locked elsewhere is not redeemed', async () => {
    const code = await issueLoginCode({ userId, redirect: '/', isNew: false });
    await db.authHandoffCode.updateMany({ where: { userId }, data: { expiresAt: new Date(Date.now() + 1500) } });
    let redeemed: Promise<unknown> | undefined;
    const { waitForLockWaitersOfType } = await import('../test/lockWait.js');
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM auth_handoff_codes WHERE user_id = ${userId} FOR UPDATE`;
      redeemed = redeemLoginCode(code);
      await waitForLockWaitersOfType(db, 'transactionid');
      await new Promise((r) => setTimeout(r, 1700));
    });
    await expect(redeemed).resolves.toBeNull();
  });
});

describe('database invariants', () => {
  it('lineage and identity never change; a sign-in with keys is never deleted; same-owner FK', async () => {
    const si = await signIn();
    const key = await mintUserApiKey(db, { userId, label: 'k', createdBy: userId, issuedVia: 'oauth:c', originSignInId: si.id });
    await expect(db.$executeRaw`UPDATE user_api_keys SET origin_sign_in_id=NULL WHERE id=${key.userApiKey.id}`).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE sign_ins SET completed_by_passkey_id=${otherPasskeyId} WHERE id=${si.id}`).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE sign_ins SET user_id=${otherUserId} WHERE id=${si.id}`).rejects.toThrow();
    await expect(db.$executeRaw`DELETE FROM sign_ins WHERE id=${si.id}`).rejects.toThrow();
    await expect(db.$executeRaw`INSERT INTO user_api_keys (id,user_id,key_hash,key_preview,oauth_scopes,created_at,origin_sign_in_id) VALUES (${generateId()},${otherUserId},${generateId()},'abcd',ARRAY[]::text[],now(),${si.id})`).rejects.toThrow();
    // Baloo P2-1: the completing credential must belong to the sign-in's own user.
    const foreignPasskey = await seedPasskey(otherUserId, 'foreign');
    await expect(db.$executeRaw`INSERT INTO sign_ins (id, user_id, method, completed_by_passkey_id, expires_at) VALUES (${generateId()}, ${userId}, 'email', ${foreignPasskey}, now() + interval '1 day')`).rejects.toThrow();
    await expect(db.$transaction((tx) => createSignIn(tx, { userId: otherUserId, method: 'email', passkeyId }))).rejects.toThrow();
    await db.$executeRaw`UPDATE sign_ins SET ended_at=now(), end_reason='x' WHERE id=${si.id}`;
    await expect(db.$executeRaw`UPDATE sign_ins SET ended_at=NULL, end_reason=NULL WHERE id=${si.id}`).rejects.toThrow();
  });
  it('the migration, post-push and test template carry the same guard', () => {
    const guard = readFileSync('prisma/signin-invariants.sql', 'utf8');
    const dir = readdirSync('prisma/migrations').find((d) => d.endsWith('_sign_in_lineage'))!;
    expect(readFileSync(`prisma/migrations/${dir}/migration.sql`, 'utf8').endsWith(guard)).toBe(true);
    expect(readFileSync('prisma/post-push.sql', 'utf8')).toContain('\\ir signin-invariants.sql');
    expect(readFileSync('src/test/globalSetup.ts', 'utf8')).toContain('../../prisma/signin-invariants.sql');
  });
});

describe('every authentication consumer is DB-aware (static inventory)', () => {
  it('no source file outside the allowlist authenticates with the crypto-only verifyJwt', () => {
    const files = readdirSync('src', { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.startsWith('generated/'));
    const allowed = new Set(['auth/jwt.ts', 'auth/signIn.ts', 'auth/index.ts']);
    const offenders = files.filter((f) => !allowed.has(f) && /\bverifyJwt\s*\(/.test(readFileSync(`src/${f}`, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
void vi;

describe('MCP delegation keeps the sign-in root (Rodolfo, #2116)', () => {
  it('every MCP bridge that forwards the presented key also forwards the sign-in root', () => {
    const dir = 'src/mcp';
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    for (const f of files) {
      const src = readFileSync(`${dir}/${f}`, 'utf8');
      const keys = (src.match(/apiKeyId: auth\.apiKeyId/g) ?? []).length;
      const roots = (src.match(/signInId: auth\.signInId/g) ?? []).length;
      expect({ f, roots }).toEqual({ f, roots: keys });
    }
  });
  it('a captured sign-in JWT request is refused at an MCP delegated write once the sign-in ends', async () => {
    const { resolvers } = await import('../api/graphql/schema/resolvers.js');
    const { createTestableMcpServer } = await import('../mcp/server.js');
    const org = await db.organization.create({ data: { urn: `review-${generateId()}.example`, name: 'Synthetic' } });
    await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
    const agent = await (resolvers.Mutation as any).createAgent({}, { orgId: org.id, name: 'Review' }, { db, userId, roles: [] });
    const node = await db.node.create({ data: { memoryId: agent.systemMemoryId, loc: 'tasks:index', name: 'Index', content: 'Synthetic' } });
    const si = await signIn();
    const auth = await resolveAuthContext(bearer(await jwtFor(userId, si.id)), db);
    expect(auth.signInId).toBe(si.id);
    await revoke(passkeyId);
    await db.$transaction((tx) => endSignInsCompletedBy(tx, passkeyId));
    await createTestableMcpServer(auth).callToolText('hadron_agent_set_index_refs', { agentRef: agent.id, tasksIndexRef: node.id });
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).tasksIndexRef).toBeNull();
  }, 30000);
});
