/** #1631 PR3 (cor:aut:040:08 S1-S5, S10; 040:07 S8): an owner revokes a passkey, proving with another passkey or an IdP. */
import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { insertSoftPasskey, softPasskey, type SoftPasskey } from '../../test/softPasskey.js';
import { createSignIn } from '../../auth/signIn.js';
import { createCeremony } from './ceremony.js';
import { confirmFreshSignIn, recordIdpSignIn, startEmailSignIn } from './freshSignIn.js';
import { bindRevokeByIdp, bindRevokeByPasskey, finishRevoke } from './revoke.js';

const RP = 'example.test';
const ORIGIN = 'https://sign.example.test';
const h = (v: string) => createHash('sha256').update(v).digest('hex');
const C = 'revoke-ceremony-cookie';
const S = 'revoke-sign-in-cookie';
let ana: string;
let laptop: SoftPasskey; let laptopId: string;
let phone: SoftPasskey; let phoneId: string;

beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('PASSKEY_RP_ID', RP);
  ana = (await db.user.create({ data: { handle: 'rev-ana', roles: [] } })).id;
  laptop = softPasskey(); laptopId = await insertSoftPasskey(db, ana, laptop, { label: 'Laptop' });
  phone = softPasskey(); phoneId = await insertSoftPasskey(db, ana, phone, { label: 'Phone' });
});

const ceremony = async (cookie = C) =>
  (await db.$transaction((tx) => createCeremony(tx, { purpose: 'REVOKE', browserNonceHash: h(cookie), ttlSeconds: 300, challengeIsId: true }))).id;
const proof = (key: SoftPasskey, id: string, over: { counter?: number; uv?: boolean } = {}) => {
  const a = key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(id, 'base64url'), origin: ORIGIN, rpId: RP, counter: over.counter ?? 1, uv: over.uv });
  return { credentialId: key.credentialId, ...a };
};
const byPasskey = (id: string, key: SoftPasskey, cookie = C, over = {}) =>
  bindRevokeByPasskey(db, { ceremonyId: id, ceremonyNonceHash: h(cookie), proof: proof(key, id, over), rpId: RP, origins: [ORIGIN] });
async function idp(userId = ana, method: 'github' | 'google' = 'github', cookie = S) {
  const { legId } = await recordIdpSignIn(db, { userId, method, browserNonceHash: h(cookie) });
  expect(await confirmFreshSignIn(db, { legSecret: legId, browserNonceHash: h(cookie), channel: 'idp' })).toBe(true);
}
const finish = (id: string, target: SoftPasskey | Buffer, over: { ceremonyCookie?: string; signInCookie?: string | null } = {}) =>
  finishRevoke(db, {
    ceremonyId: id, ceremonyNonceHash: h(over.ceremonyCookie ?? C),
    signInBrowserHash: over.signInCookie === null || over.signInCookie === undefined ? null : h(over.signInCookie),
    targetCredentialId: Buffer.isBuffer(target) ? target : target.credentialId,
  });
const rec = (id: string) => db.passkeyCredential.findUniqueOrThrow({ where: { id } });

describe('proving with another passkey (040:08 S1)', () => {
  it('binds the owner, lists their passkeys marking the prover, and revokes ANOTHER one', async () => {
    const id = await ceremony();
    const b = await byPasskey(id, phone);
    expect(b!.userId).toBe(ana);
    expect(b!.passkeys.map((p) => [p.label, p.prover]).sort()).toEqual([['Laptop', false], ['Phone', true]]);
    expect(await finish(id, laptop)).toMatchObject({ passkeyId: laptopId, windowCancelled: false });
    expect((await rec(laptopId)).revokedAt).not.toBeNull();
    expect((await rec(phoneId)).revokedAt).toBeNull();
  });

  it('never revokes the passkey that proved the ceremony ("another" passkey)', async () => {
    const id = await ceremony();
    await byPasskey(id, phone);
    expect(await finish(id, phone)).toBeNull();
    expect((await rec(phoneId)).revokedAt).toBeNull();
  });

  it('a lone first passkey in its window proves, but has nothing to revoke: never itself (Rook Q1.5)', async () => {
    const zoe = (await db.user.create({ data: { handle: 'rev-zoe', roles: [] } })).id;
    const only = softPasskey(); const onlyId = await insertSoftPasskey(db, zoe, only, { firstWindow: true });
    const id = await ceremony();
    const b = await byPasskey(id, only);
    expect(b!.passkeys.map((p) => [p.passkeyId, p.prover, p.inWindow])).toEqual([[onlyId, true, true]]);
    expect(await finish(id, only)).toBeNull();
    expect((await rec(onlyId)).revokedAt).toBeNull();
  });

  it('a passkey still in its cooling-off window may prove (no window exclusion for revoking)', async () => {
    const fresh = softPasskey();
    await insertSoftPasskey(db, ana, fresh, { firstWindow: true });
    const id = await ceremony();
    expect(await byPasskey(id, fresh)).not.toBeNull();
  });

  it('refuses a revoked prover, a proof without user verification, and a prover revoked before the finish', async () => {
    await db.$executeRaw`UPDATE passkey_credentials SET revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id = ${phoneId}`;
    expect(await byPasskey(await ceremony(), phone)).toBeNull();
    expect(await byPasskey(await ceremony(), laptop, C, { uv: false })).toBeNull();
    const third = softPasskey(); const thirdId = await insertSoftPasskey(db, ana, third);
    const id = await ceremony();
    await byPasskey(id, laptop);
    await db.$executeRaw`UPDATE passkey_credentials SET revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id = ${laptopId}`;
    expect(await finish(id, third)).toBeNull();
    expect((await rec(thirdId)).revokedAt).toBeNull();
  });
});

describe('proving with an identity-provider sign-in (040:08 S2, S10)', () => {
  it('a fresh GitHub sign-in on this browser binds the owner and may revoke any of their passkeys', async () => {
    await idp();
    const id = await ceremony();
    const b = await bindRevokeByIdp(db, { ceremonyId: id, ceremonyNonceHash: h(C), signInBrowserHash: h(S) });
    expect(b!.passkeys.every((p) => !p.prover)).toBe(true);
    expect(await finish(id, phone, { signInCookie: S })).toMatchObject({ passkeyId: phoneId });
    expect((await db.freshSignIn.findFirstOrThrow({ where: { userId: ana } })).consumedFor).toBe('revoke');
  });

  it('a magic link never revokes (S10), and the sign-in stays unspent', async () => {
    const { token } = await startEmailSignIn(db, { userId: ana, browserNonceHash: h(S) });
    expect(await confirmFreshSignIn(db, { legSecret: token, browserNonceHash: h(S), channel: 'email' })).toBe(true);
    expect(await bindRevokeByIdp(db, { ceremonyId: await ceremony(), ceremonyNonceHash: h(C), signInBrowserHash: h(S) })).toBeNull();
    expect((await db.freshSignIn.findFirstOrThrow({ where: { userId: ana } })).consumedAt).toBeNull();
  });

  it('finish needs the same sign-in browser, and two qualifying sign-ins refuse', async () => {
    await idp();
    const id = await ceremony();
    await bindRevokeByIdp(db, { ceremonyId: id, ceremonyNonceHash: h(C), signInBrowserHash: h(S) });
    expect(await finish(id, phone, { signInCookie: 'other' })).toBeNull();
    expect(await finish(id, phone, { signInCookie: null })).toBeNull();
    await idp(ana, 'google', 'two');
    await idp(ana, 'github', 'two');
    expect(await bindRevokeByIdp(db, { ceremonyId: await ceremony(), ceremonyNonceHash: h(C), signInBrowserHash: h('two') })).toBeNull();
  });
});

describe('what a revocation does, and only for the owner', () => {
  it('a first passkey revoked in its window closes the window as cancelled at the revocation time (040:07 S8)', async () => {
    const fresh = softPasskey(); const freshId = await insertSoftPasskey(db, ana, fresh, { firstWindow: true });
    const id = await ceremony();
    await byPasskey(id, laptop);
    expect(await finish(id, fresh)).toMatchObject({ windowCancelled: true });
    const r = await rec(freshId);
    expect(r.windowOutcome).toBe('cancelled');
    expect(r.windowEndedAt?.getTime()).toBe(r.revokedAt?.getTime());
    expect(r.cancelledAt).toBeNull();
  });

  it('ends no sign-in the revoked passkey completed (040:08: the cancel link only)', async () => {
    const si = await db.$transaction((tx) => createSignIn(tx, { userId: ana, method: 'email', passkeyId: laptopId }));
    const id = await ceremony();
    await byPasskey(id, phone);
    await finish(id, laptop);
    expect((await db.signIn.findUniqueOrThrow({ where: { id: si.id } })).endedAt).toBeNull();
  });

  it('never revokes another user\'s passkey, an unknown one, or an already revoked one (S4)', async () => {
    const bea = (await db.user.create({ data: { handle: 'rev-bea', roles: [] } })).id;
    const beas = softPasskey(); const beaId = await insertSoftPasskey(db, bea, beas);
    const id = await ceremony();
    await byPasskey(id, phone);
    expect(await finish(id, beas)).toBeNull();
    expect(await finish(id, randomBytes(16))).toBeNull();
    expect((await rec(beaId)).revokedAt).toBeNull();
    await db.$executeRaw`UPDATE passkey_credentials SET revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id = ${laptopId}`;
    expect(await finish(id, laptop)).toBeNull();
  });

  it('a ceremony binds once, finishes once, and only from its own browser', async () => {
    const id = await ceremony();
    expect(await byPasskey(id, phone)).not.toBeNull();
    expect(await byPasskey(id, laptop, C, { counter: 2 })).toBeNull();
    expect(await finish(id, laptop, { ceremonyCookie: 'other-browser' })).toBeNull();
    expect(await finish(id, laptop)).not.toBeNull();
    const third = softPasskey(); await insertSoftPasskey(db, ana, third);
    expect(await finish(id, third)).toBeNull();
  });

  it('a deleted owner revokes nothing', async () => {
    const id = await ceremony();
    await byPasskey(id, phone);
    await db.user.update({ where: { id: ana }, data: { deletedAt: new Date() } });
    expect(await finish(id, laptop)).toBeNull();
    expect((await rec(laptopId)).revokedAt).toBeNull();
  });

  it('a REGISTER ceremony is not a revoke ceremony', async () => {
    const reg = (await db.$transaction((tx) => createCeremony(tx, { purpose: 'REGISTER', browserNonceHash: h(C), ttlSeconds: 300, challengeIsId: true }))).id;
    expect(await byPasskey(reg, phone)).toBeNull();
  });
});
