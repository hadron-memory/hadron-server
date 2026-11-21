/**
 * #4703 (S4 follow-up; cor:sec:070:02): the requester declines their own open change on the ceremony page, with a passkey
 * proof as for approve. `open` -> `declined` happens exactly once under the request's row lock, the staged value is cleared
 * with it, the requester's poll shows `declined`, and anyone else is refused as for a missing request. Real database and
 * real software-passkey assertions, no provider calls.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { insertSoftPasskey, softPasskey } from '../../test/softPasskey.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { upsertPlatformActions } from '../grants/actions.js';
import { createCeremony } from '../passkeys/ceremony.js';
import { openSecretProof, proveSecretChange, completeSecretChange, declineSecretChange, secretDeclineChallenge } from './changeCeremony.js';
import type { ChangeRequest } from './changeRequests.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const RP = 'localhost', ORIGIN = 'http://localhost:4000';
let userId: string, appId: string, secretId: string;
const key = softPasskey();
const ctx = (): Context => ({ db, userId, roles: [] } as unknown as Context);
const error = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected refusal'); }, (e) => e);
async function stage() { return (await error(resolvers.Mutation.updateSecret({}, { ref: secretId, value: 'staged-canary' }, ctx()))).extensions.requestId as string; }
async function proof(id: string, k = key, nonce = 'browser-nonce-for-secret-change') {
  const open = await openSecretProof(db, { requestId: id, browserNonceHash: hash(nonce) });
  return proveSecretChange(db, { requestId: id, ceremonyId: open.ceremonyId, browserNonceHash: hash(nonce), credentialId: k.credentialId,
    assertion: k.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(open.challenge, 'base64url'), origin: ORIGIN, rpId: RP }) });
}
type Proved = Awaited<ReturnType<typeof proof>> & { outcome: 'change'; nonce: string; ceremonyId: string; challenge: string; decline: { ceremonyId: string; challenge: string } };
async function proved(id: string, k = key, nonce?: string) { return await proof(id, k, nonce) as unknown as Proved; }
const assertion = (k: typeof key, challenge: string) => k.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(challenge, 'base64url'), origin: ORIGIN, rpId: RP });
async function decline(id: string, p: Proved, k = key) {
  return declineSecretChange(db, { requestId: id, ceremonyId: p.decline.ceremonyId, browserNonceHash: hash(p.nonce), credentialId: k.credentialId,
    assertion: assertion(k, p.decline.challenge) });
}
async function complete(id: string, p: Proved, k = key) {
  return completeSecretChange(db, { requestId: id, ceremonyId: p.ceremonyId, browserNonceHash: hash(p.nonce), credentialId: k.credentialId,
    assertion: assertion(k, p.challenge) });
}
const row = async (id: string) => (await db.$queryRaw<ChangeRequest[]>`SELECT * FROM secret_change_requests WHERE id=${id}`)[0];

beforeEach(async () => {
  process.env.SECRET_ROOT_KEY = '22'.repeat(32); process.env.PASSKEY_SIGNING_ENABLED = 'true';
  process.env.PASSKEY_RP_ID = RP; process.env.SIGNING_CEREMONY_ORIGINS = ORIGIN;
  await cleanDb(db); await upsertPlatformActions(db);
  userId = (await db.user.create({ data: { email: `${generateId()}@s4.test` } })).id;
  appId = (await db.app.create({ data: { ownerUserId: userId, name: 'S4 decline', urn: `${generateId().toLowerCase()}:s4d` } })).id;
  secretId = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'canary', kind: 'generic', value: 'original' }, ctx())).id;
  await db.secret.update({ where: { id: secretId }, data: { protected: true } });
  await insertSoftPasskey(db, userId, key, { rpId: RP });
});

describe('#4703 the requester declines their own open change', () => {
  it('moves it to declined, clears the staged value, shows declined on the poll, and leaves the secret untouched', async () => {
    const id = await stage();
    expect((await row(id)).staged_value_encrypted).toBeTruthy();
    const p = await proved(id);
    expect(p.decline).toMatchObject({ ceremonyId: expect.any(String), challenge: expect.any(String) });
    await decline(id, p);
    const r = await row(id);
    expect(r.state).toBe('declined');
    expect(r.staged_value_encrypted).toBeNull();
    expect(r.ended_at).not.toBeNull();
    expect(await resolvers.Query.secretChangeRequest({}, { id }, ctx())).toMatchObject({ id, state: 'declined' });
    expect(await db.secretVersion.count({ where: { secretId } })).toBe(1);
  });

  it('a second decline, and an approve after a decline, change nothing', async () => {
    const id = await stage(), p = await proved(id);
    await decline(id, p);
    const ended = (await row(id)).ended_at;
    await expect(decline(id, p)).rejects.toThrow();
    await expect(complete(id, p)).rejects.toThrow();
    expect(await row(id)).toMatchObject({ state: 'declined', ended_at: ended, staged_value_encrypted: null });
    expect(await db.secretVersion.count({ where: { secretId } })).toBe(1);
  });

  it.each([
    ['completed', async (id: string, p: Proved) => { await complete(id, p); }],
    ['withdrawn', async (id: string) => { await resolvers.Mutation.withdrawSecretChangeRequest({}, { id }, ctx()); }],
  ])('a request that is already %s is not declined', async (state, end) => {
    const id = await stage(), p = await proved(id);
    await end(id, p);
    const before = await row(id);
    await expect(decline(id, p)).rejects.toThrow();
    expect(await row(id)).toMatchObject({ state, ended_at: before.ended_at });
  });

  it('an open request past its expiry ends expired, never declined', async () => {
    // The proof refuses an expired request, so the ceremony is minted directly (a request that expired between proof and decline).
    const src = await row(await stage()), expiredId = generateId();
    await db.secretChangeRequest.create({ data: { id: expiredId, appId, secretId, secretName: src.secret_name, secretKind: src.secret_kind,
      metadata: src.metadata as never, operation: src.operation, requesterId: userId, state: 'open', snapshot: src.snapshot,
      stagedValueEncrypted: src.staged_value_encrypted, keyVersion: src.key_version, sizeBytes: src.size_bytes, expiresAt: new Date(Date.now() - 10_000) } });
    const challenge = secretDeclineChallenge(await row(expiredId));
    const nonce = 'browser-nonce-expired';
    const ceremony = await db.$transaction((tx) => createCeremony(tx, { purpose: 'SECRET_CHANGE', browserNonceHash: hash(nonce), ttlSeconds: 600, challengeHash: createHash('sha256').update(challenge).digest('hex') }));
    await expect(declineSecretChange(db, { requestId: expiredId, ceremonyId: ceremony.id, browserNonceHash: hash(nonce), credentialId: key.credentialId,
      assertion: assertion(key, challenge.toString('base64url')) })).rejects.toMatchObject({ extensions: { code: 'SECRET_CHANGE_REQUEST_EXPIRED' } });
    expect(await row(expiredId)).toMatchObject({ state: 'expired', staged_value_encrypted: null });
  });
});

describe('#4703 only the requester, proving their own passkey', () => {
  it('refuses another person with their own passkey as for a missing request, changing nothing and spending nothing', async () => {
    const mine = await stage(), p = await proved(mine);
    const other = (await db.user.create({ data: { email: `${generateId()}@s4.test` } })).id;
    await db.appMember.create({ data: { appId, userId: other, role: 'reader' } });
    const k = softPasskey(); await insertSoftPasskey(db, other, k, { rpId: RP });
    const refusal = await error(decline(mine, p, k));
    const missing = await error(declineSecretChange(db, { requestId: 'no-such-request', ceremonyId: p.decline.ceremonyId, browserNonceHash: hash(p.nonce),
      credentialId: k.credentialId, assertion: assertion(k, p.decline.challenge) }));
    expect(refusal.constructor).toBe(missing.constructor);
    expect(refusal.message).toBe(missing.message);
    expect((await row(mine)).state).toBe('open');
    const [c] = await db.$queryRaw<Array<{ consumed_at: Date | null }>>`SELECT consumed_at FROM passkey_ceremonies WHERE id=${p.decline.ceremonyId}`;
    expect(c.consumed_at).toBeNull();
  });

  it('refuses the requester\'s own passkey assertion made over the APPROVE challenge (it cannot be replayed as a decline)', async () => {
    const id = await stage(), p = await proved(id);
    await expect(declineSecretChange(db, { requestId: id, ceremonyId: p.ceremonyId, browserNonceHash: hash(p.nonce), credentialId: key.credentialId,
      assertion: assertion(key, p.challenge) })).rejects.toThrow();
    expect((await row(id)).state).toBe('open');
  });

  it('refuses a decline assertion used to APPROVE', async () => {
    const id = await stage(), p = await proved(id);
    await expect(completeSecretChange(db, { requestId: id, ceremonyId: p.decline.ceremonyId, browserNonceHash: hash(p.nonce), credentialId: key.credentialId,
      assertion: assertion(key, p.decline.challenge) })).rejects.toThrow();
    expect((await row(id)).state).toBe('open');
    expect(await db.secretVersion.count({ where: { secretId } })).toBe(1);
  });

  it('refuses the wrong browser nonce', async () => {
    const id = await stage(), p = await proved(id);
    await expect(decline(id, { ...p, nonce: 'another-browser' })).rejects.toThrow();
    expect((await row(id)).state).toBe('open');
  });

  it('refuses a credential revoked between proof and decline', async () => {
    const id = await stage(), p = await proved(id);
    await db.$executeRaw`UPDATE passkey_credentials SET revoked_at=public.hadron_passkey_wall_now() WHERE credential_id=${key.credentialId}`;
    await expect(decline(id, p)).rejects.toThrow();
    expect((await row(id)).state).toBe('open');
  });

  it('refuses a first passkey in its cooling-off window, as an approve does, and keeps the request open', async () => {
    const cold = softPasskey(); await insertSoftPasskey(db, userId, cold, { rpId: RP, firstWindow: true });
    const id = await stage(), p = await proved(id, cold);
    await expect(decline(id, p, cold)).rejects.toMatchObject({ extensions: { code: 'PASSKEY_COOLING_OFF' } });
    expect((await row(id)).state).toBe('open');
    const [c] = await db.$queryRaw<Array<{ consumed_at: Date | null }>>`SELECT consumed_at FROM passkey_ceremonies WHERE id=${p.decline.ceremonyId}`;
    expect(c.consumed_at).toBeNull();
  });
});

describe('#4703 exactly once under concurrency', () => {
  it('two concurrent declines: one succeeds, one refused, one declined request', async () => {
    const id = await stage(), p = await proved(id);
    const both = await Promise.allSettled([decline(id, p), decline(id, p)]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await row(id)).state).toBe('declined');
  });

  it('two tabs: two distinct proofs of one request race to decline, and exactly one wins (BLIND F5)', async () => {
    const id = await stage();
    const tabA = await proved(id, key, 'browser-nonce-tab-a'), tabB = await proved(id, key, 'browser-nonce-tab-b');
    expect(tabA.decline.ceremonyId).not.toBe(tabB.decline.ceremonyId);
    const both = await Promise.allSettled([decline(id, tabA), decline(id, tabB)]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(both.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await row(id)).toMatchObject({ state: 'declined', staged_value_encrypted: null });
  });

  it('a decline racing an approve: exactly one terminal state, and a version only if the approve won', async () => {
    const id = await stage(), p = await proved(id);
    const both = await Promise.allSettled([decline(id, p), complete(id, p)]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const r = await row(id);
    expect(['declined', 'completed']).toContain(r.state);
    expect(r.staged_value_encrypted).toBeNull();
    expect(await db.secretVersion.count({ where: { secretId } })).toBe(r.state === 'completed' ? 2 : 1);
  });
});
