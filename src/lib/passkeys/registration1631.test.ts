/**
 * #1631 PR2 (cor:aut:040:02, 05, 06, 07): binding a REGISTER ceremony (first or later) and finishing it, against a real
 * database and a software authenticator. Rook's §10 conditions (#1631 6316353964) are pinned by name.
 */
import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { insertSoftPasskey, softPasskey, type SoftPasskey } from '../../test/softPasskey.js';
import { createCeremony } from './ceremony.js';
import { lockAuthorityAnchors } from '../auth/authorityAnchors.js';
import { confirmFreshSignIn, recordIdpSignIn, startEmailSignIn } from './freshSignIn.js';
import {
  bindFirstRegistration, bindLaterRegistration, finishRegistration, firstPasskeyWindowHours, LABEL_MAX_LENGTH,
} from './registration.js';

const RP = 'example.test';
const ORIGIN = 'https://sign.example.test';
const origins = [ORIGIN];
const h = (v: string) => createHash('sha256').update(v).digest('hex');
const CEREMONY_COOKIE = 'ceremony-cookie';
const SIGN_IN_COOKIE = 'sign-in-browser-cookie';
let ana: string;

beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('PASSKEY_RP_ID', RP);
  ana = (await db.user.create({ data: { handle: 'reg-ana', roles: [] } })).id;
});

async function ceremony(cookie = CEREMONY_COOKIE, ttlSeconds = 300) {
  return (await db.$transaction((tx) => createCeremony(tx, { purpose: 'REGISTER', browserNonceHash: h(cookie), ttlSeconds, challengeIsId: true }))).id;
}

/** A confirmed IdP fresh sign-in for `userId` on the sign-in browser `cookie`. */
async function freshSignIn(userId = ana, cookie = SIGN_IN_COOKIE, method: 'github' | 'google' = 'github') {
  const { legId } = await recordIdpSignIn(db, { userId, method, browserNonceHash: h(cookie) });
  expect(await confirmFreshSignIn(db, { legSecret: legId, browserNonceHash: h(cookie), channel: 'idp' })).toBe(true);
}

const bindFirst = (ceremonyId: string, over: { ceremonyCookie?: string; signInCookie?: string } = {}) =>
  bindFirstRegistration(db, { ceremonyId, ceremonyNonceHash: h(over.ceremonyCookie ?? CEREMONY_COOKIE), signInBrowserHash: h(over.signInCookie ?? SIGN_IN_COOKIE) });

function vouchBody(key: SoftPasskey, ceremonyId: string, over: { counter?: number; uv?: boolean; type?: string; origin?: string; challenge?: Buffer } = {}) {
  const a = key.assert({ payload: Buffer.alloc(0), rawChallenge: over.challenge ?? Buffer.from(ceremonyId, 'base64url'), origin: over.origin ?? ORIGIN, rpId: RP, counter: over.counter ?? 1, uv: over.uv, type: over.type });
  return { credentialId: key.credentialId, ...a };
}
const bindLater = (ceremonyId: string, vouch: ReturnType<typeof vouchBody>, ceremonyCookie = CEREMONY_COOKIE) =>
  bindLaterRegistration(db, { ceremonyId, ceremonyNonceHash: h(ceremonyCookie), vouch, rpId: RP, origins });

function finish(ceremonyId: string, key: SoftPasskey, over: {
  uv?: boolean; type?: string; origin?: string; rpId?: string; challenge?: Buffer; ceremonyCookie?: string; signInCookie?: string | null; label?: string; windowHours?: number;
} = {}) {
  const response = key.create({ rawChallenge: over.challenge ?? Buffer.from(ceremonyId, 'base64url'), origin: over.origin ?? ORIGIN, rpId: over.rpId ?? RP, uv: over.uv, type: over.type });
  return finishRegistration(db, {
    ceremonyId, ceremonyNonceHash: h(over.ceremonyCookie ?? CEREMONY_COOKIE),
    signInBrowserHash: over.signInCookie === null ? null : h(over.signInCookie ?? SIGN_IN_COOKIE),
    response, label: over.label ?? 'Laptop', rpId: RP, origins, windowHours: over.windowHours ?? 72,
  });
}

const ceremonyRow = (id: string) => db.passkeyCeremony.findUniqueOrThrow({ where: { id } });

describe('first passkey: binding at the options step', () => {
  it('binds the user from the one confirmed fresh sign-in on this browser, spending it there', async () => {
    await freshSignIn();
    const id = await ceremony();
    const b = await bindFirst(id);
    expect(b).toMatchObject({ userId: ana, handle: 'reg-ana', excludeCredentialIds: [] });
    expect(b!.userHandle).toHaveLength(32);
    expect(await ceremonyRow(id)).toMatchObject({ userId: ana, kind: 'first', registrationMethod: 'github', signInBrowserHash: h(SIGN_IN_COOKIE), consumedAt: null });
    expect(await db.freshSignIn.findFirstOrThrow({ where: { userId: ana } })).toMatchObject({ consumedFor: 'register' });
  });

  it('refuses a user who holds an unrevoked passkey (it would not be a first passkey)', async () => {
    await insertSoftPasskey(db, ana, softPasskey());
    await freshSignIn();
    expect(await bindFirst(await ceremony())).toBeNull();
    expect((await db.freshSignIn.findFirstOrThrow({ where: { userId: ana } })).consumedAt).toBeNull();
  });

  it('a user whose every passkey is revoked registers a first passkey again (040:07 S6)', async () => {
    const old = await insertSoftPasskey(db, ana, softPasskey());
    await db.$executeRaw`UPDATE passkey_credentials SET revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id = ${old}`;
    await freshSignIn();
    expect(await bindFirst(await ceremony())).not.toBeNull();
  });

  it('refuses with no fresh sign-in, an unconfirmed one, or one on another browser', async () => {
    const id = await ceremony();
    expect(await bindFirst(id)).toBeNull();
    await recordIdpSignIn(db, { userId: ana, method: 'github', browserNonceHash: h(SIGN_IN_COOKIE) });
    expect(await bindFirst(id)).toBeNull();
    await freshSignIn(ana, 'another-browser');
    expect(await bindFirst(id)).toBeNull();
  });

  it('refuses when two qualifying fresh sign-ins match the browser, rather than picking one (Rook Q2.1)', async () => {
    const bea = (await db.user.create({ data: { handle: 'reg-bea', roles: [] } })).id;
    await freshSignIn(ana);
    await freshSignIn(bea);
    expect(await bindFirst(await ceremony())).toBeNull();
    expect(await db.freshSignIn.count({ where: { consumedAt: { not: null } } })).toBe(0);
  });

  it('two qualifying sign-ins on this browser for the SAME user also refuse (Rook P3-1)', async () => {
    await freshSignIn(ana);
    await freshSignIn(ana);
    expect(await bindFirst(await ceremony())).toBeNull();
    expect(await db.freshSignIn.count({ where: { consumedAt: { not: null } } })).toBe(0);
  });

  it('refuses a fresh sign-in older than 10 minutes when the step begins', async () => {
    await freshSignIn();
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw`UPDATE fresh_sign_ins SET created_at = created_at - interval '11 minutes',
        signed_in_at = signed_in_at - interval '11 minutes', confirmed_at = confirmed_at - interval '11 minutes'`;
    });
    expect(await bindFirst(await ceremony())).toBeNull();
  });

  it('binds once: a second options call neither rebinds nor spends another sign-in (Rook Q1.3)', async () => {
    await freshSignIn();
    const id = await ceremony();
    expect(await bindFirst(id)).not.toBeNull();
    await freshSignIn(ana, 'second-browser');
    expect(await bindFirst(id, { signInCookie: 'second-browser' })).toBeNull();
    expect(await db.freshSignIn.count({ where: { consumedAt: null } })).toBe(1);
  });

  it('refuses a ceremony from another browser, an expired one, or one of another purpose', async () => {
    await freshSignIn();
    expect(await bindFirst(await ceremony(), { ceremonyCookie: 'other-ceremony-browser' })).toBeNull();
    const expired = await ceremony(CEREMONY_COOKIE, 1);
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw`UPDATE passkey_ceremonies SET expires_at = created_at WHERE id = ${expired}`;
    });
    expect(await bindFirst(expired)).toBeNull();
    const stepUp = (await db.$transaction((tx) => createCeremony(tx, { purpose: 'STEP_UP_ONLY', browserNonceHash: h(CEREMONY_COOKIE), ttlSeconds: 300, challengeIsId: true }))).id;
    expect(await bindFirst(stepUp)).toBeNull();
    expect((await db.freshSignIn.findFirstOrThrow({ where: { userId: ana } })).consumedAt).toBeNull();
  });

  it('refuses a deleted user', async () => {
    await freshSignIn();
    await db.user.update({ where: { id: ana }, data: { deletedAt: new Date() } });
    expect(await bindFirst(await ceremony())).toBeNull();
  });
});

describe('later passkey: binding with a vouch', () => {
  let key: SoftPasskey;
  let keyId: string;
  beforeEach(async () => {
    key = softPasskey();
    keyId = await insertSoftPasskey(db, ana, key);
  });

  it('binds the vouching passkey\'s owner, advances its counter, and needs no fresh sign-in', async () => {
    const id = await ceremony();
    const b = await bindLater(id, vouchBody(key, id));
    expect(b).toMatchObject({ userId: ana, handle: 'reg-ana' });
    expect(b!.excludeCredentialIds.map((c) => c.toString('hex'))).toEqual([key.credentialId.toString('hex')]);
    expect(await ceremonyRow(id)).toMatchObject({ userId: ana, kind: 'later', vouchPasskeyId: keyId, registrationMethod: null, consumedAt: null });
    expect((await db.passkeyCredential.findUniqueOrThrow({ where: { id: keyId } })).counter).toBe(1n);
  });

  it('refuses a voucher still in its cooling-off window (040:02 S4)', async () => {
    const inWindow = softPasskey();
    const bea = (await db.user.create({ data: { handle: 'reg-bea', roles: [] } })).id;
    await insertSoftPasskey(db, bea, inWindow, { firstWindow: true });
    const id = await ceremony();
    expect(await bindLater(id, vouchBody(inWindow, id))).toBeNull();
    expect((await ceremonyRow(id)).userId).toBeNull();
  });

  it('accepts a voucher whose window ran out', async () => {
    const ranOut = softPasskey();
    const bea = (await db.user.create({ data: { handle: 'reg-bea', roles: [] } })).id;
    const ranOutId = await insertSoftPasskey(db, bea, ranOut, { firstWindow: true });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw`UPDATE passkey_credentials SET registered_at = registered_at - interval '73 hours', window_ends_at = window_ends_at - interval '73 hours' WHERE id = ${ranOutId}`;
    });
    const id = await ceremony();
    expect(await bindLater(id, vouchBody(ranOut, id))).toMatchObject({ userId: bea });
  });

  it.each([
    ['without user verification', { uv: false }],
    ['typed webauthn.create (a creation response standing in for an assertion)', { type: 'webauthn.create' }],
    ['from an unlisted origin', { origin: 'https://evil.example' }],
    ['over another challenge', { challenge: randomBytes(32) }],
  ])('refuses a vouch %s', async (_c, over) => {
    const id = await ceremony();
    expect(await bindLater(id, vouchBody(key, id, over))).toBeNull();
    expect((await ceremonyRow(id)).userId).toBeNull();
  });

  it('refuses a revoked voucher, or one enrolled under another RP ID', async () => {
    const other = softPasskey();
    const bea = (await db.user.create({ data: { handle: 'reg-bea', roles: [] } })).id;
    await insertSoftPasskey(db, bea, other, { rpId: 'old.example.test' });
    const id = await ceremony();
    expect(await bindLater(id, vouchBody(other, id))).toBeNull();
    await db.$executeRaw`UPDATE passkey_credentials SET revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id = ${keyId}`;
    const id2 = await ceremony();
    expect(await bindLater(id2, vouchBody(key, id2))).toBeNull();
  });

  it('refuses a voucher whose counter did not advance (a cloned authenticator)', async () => {
    const id = await ceremony();
    expect(await bindLater(id, vouchBody(key, id, { counter: 5 }))).not.toBeNull();
    const id2 = await ceremony();
    expect(await bindLater(id2, vouchBody(key, id2, { counter: 5 }))).toBeNull();
    expect((await ceremonyRow(id2)).userId).toBeNull();
  });

  it('refuses a ceremony from another browser, and binds once', async () => {
    const id = await ceremony();
    expect(await bindLater(id, vouchBody(key, id), 'other-ceremony-browser')).toBeNull();
    expect(await bindLater(id, vouchBody(key, id))).not.toBeNull();
    expect(await bindLater(id, vouchBody(key, id, { counter: 2 }))).toBeNull();
  });
});

describe('finish', () => {
  it('a first passkey: credential with its enrollment RP ID, method and 72-hour window, a cancel token and a first notice', async () => {
    await freshSignIn(ana, SIGN_IN_COOKIE, 'google');
    const id = await ceremony();
    await bindFirst(id);
    const key = softPasskey();
    const r = await finish(id, key);
    expect(r).toMatchObject({ userId: ana, kind: 'first' });
    const c = await db.passkeyCredential.findUniqueOrThrow({ where: { id: r!.passkeyId } });
    expect(c).toMatchObject({ ownerId: ana, enrollmentRpId: RP, registrationMethod: 'google', label: 'Laptop', revokedAt: null, counter: 0n });
    expect(Buffer.from(c.credentialId).equals(key.credentialId)).toBe(true);
    expect(Buffer.from(c.publicKey).equals(key.cosePublicKey)).toBe(true);
    expect(Buffer.from(c.userHandle).equals(Buffer.from((await ceremonyRow(id)).userHandle!))).toBe(true);
    expect(c.windowEndsAt!.getTime() - c.registeredAt.getTime()).toBe(72 * 3600 * 1000);
    expect(await db.passkeyCancelToken.count({ where: { passkeyId: c.id } })).toBe(1);
    const notice = await db.passkeyRegistrationNotice.findUniqueOrThrow({ where: { passkeyId: c.id } });
    expect(notice).toMatchObject({ userId: ana, kind: 'first', sentAt: null });
    expect(notice.cancelTokenEnc).not.toBeNull();
    expect((await ceremonyRow(id)).consumedAt).not.toBeNull();
  });

  it('a deployment window of 96 hours is honoured', async () => {
    await freshSignIn();
    const id = await ceremony();
    await bindFirst(id);
    const r = await finish(id, softPasskey(), { windowHours: 96 });
    const c = await db.passkeyCredential.findUniqueOrThrow({ where: { id: r!.passkeyId } });
    expect(c.windowEndsAt!.getTime() - c.registeredAt.getTime()).toBe(96 * 3600 * 1000);
  });

  it('a later passkey: no window, no cancel token, an informational notice (040:02 S2)', async () => {
    const voucher = softPasskey();
    await insertSoftPasskey(db, ana, voucher);
    const id = await ceremony();
    await bindLater(id, vouchBody(voucher, id));
    const r = await finish(id, softPasskey(), { signInCookie: null });
    expect(r).toMatchObject({ kind: 'later' });
    const c = await db.passkeyCredential.findUniqueOrThrow({ where: { id: r!.passkeyId } });
    expect(c).toMatchObject({ windowEndsAt: null, registrationMethod: null });
    expect(await db.passkeyCancelToken.count({ where: { passkeyId: c.id } })).toBe(0);
    expect(await db.passkeyRegistrationNotice.findUniqueOrThrow({ where: { passkeyId: c.id } })).toMatchObject({ kind: 'later', cancelTokenEnc: null });
  });

  describe('refusals leave no credential and the ceremony unconsumed', () => {
    let id: string;
    beforeEach(async () => {
      await freshSignIn();
      id = await ceremony();
      await bindFirst(id);
    });
    const none = async () => {
      expect(await db.passkeyCredential.count()).toBe(0);
      expect((await ceremonyRow(id)).consumedAt).toBeNull();
    };
    it.each([
      ['without user verification (040:02 S6)', { uv: false }],
      ['typed webauthn.get', { type: 'webauthn.get' }],
      ['from an unlisted origin', { origin: 'https://evil.example' }],
      ['for another RP ID', { rpId: 'evil.example' }],
      ['over another challenge', { challenge: randomBytes(32) }],
      ['from another ceremony browser', { ceremonyCookie: 'other-ceremony-browser' }],
      ['from another sign-in browser (Rook Q1.1)', { signInCookie: 'other-sign-in-browser' }],
      ['with no sign-in browser cookie', { signInCookie: null }],
      ['with an over-long label', { label: 'x'.repeat(LABEL_MAX_LENGTH + 1) }],
    ])('refuses a response %s', async (_c, over) => {
      expect(await finish(id, softPasskey(), over)).toBeNull();
      await none();
    });

    it('refuses a credential the client reports as not discoverable (cor:aut:040:05, Andi P2-1)', async () => {
      const key = softPasskey();
      const response = key.create({ rawChallenge: Buffer.from(id, 'base64url'), origin: ORIGIN, rpId: RP });
      response.clientExtensionResults = { credProps: { rk: false } };
      expect(await finishRegistration(db, {
        ceremonyId: id, ceremonyNonceHash: h(CEREMONY_COOKIE), signInBrowserHash: h(SIGN_IN_COOKIE),
        response, label: 'L', rpId: RP, origins, windowHours: 72,
      })).toBeNull();
      await none();
    });

    it('refuses an unbound ceremony', async () => {
      const unbound = await ceremony();
      expect(await finish(unbound, softPasskey())).toBeNull();
    });

    it('is single-use: a replay of the finish refuses', async () => {
      const key = softPasskey();
      expect(await finish(id, key)).not.toBeNull();
      expect(await finish(id, key)).toBeNull();
      expect(await db.passkeyCredential.count()).toBe(1);
    });

    it('refuses if another first passkey was registered after the options step (two ceremonies race)', async () => {
      await insertSoftPasskey(db, ana, softPasskey(), { firstWindow: true });
      expect(await finish(id, softPasskey())).toBeNull();
      expect(await db.passkeyCredential.count()).toBe(1);
    });

    it('refuses a deleted user', async () => {
      await db.user.update({ where: { id: ana }, data: { deletedAt: new Date() } });
      expect(await finish(id, softPasskey())).toBeNull();
      await none();
    });
  });

  it('refuses a later passkey whose voucher was revoked after the options step', async () => {
    const voucher = softPasskey();
    const vid = await insertSoftPasskey(db, ana, voucher);
    const id = await ceremony();
    await bindLater(id, vouchBody(voucher, id));
    await db.$executeRaw`UPDATE passkey_credentials SET revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id = ${vid}`;
    expect(await finish(id, softPasskey(), { signInCookie: null })).toBeNull();
  });

  it('never registers a credential id twice, a revoked one included', async () => {
    const reused = softPasskey();
    const old = await insertSoftPasskey(db, ana, reused);
    await db.$executeRaw`UPDATE passkey_credentials SET revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id = ${old}`;
    await freshSignIn();
    const id = await ceremony();
    await bindFirst(id);
    expect(await finish(id, reused)).toBeNull();
    expect(await db.passkeyCredential.count()).toBe(1);
  });

  it('two concurrent finishes of ONE ceremony register once', async () => {
    await freshSignIn();
    const id = await ceremony();
    await bindFirst(id);
    const results = await Promise.all([finish(id, softPasskey()), finish(id, softPasskey())]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.passkeyCredential.count({ where: { ownerId: ana } })).toBe(1);
  });

  it('two concurrent finishes of ONE later-passkey ceremony register once (nothing else masks the single use)', async () => {
    const voucher = softPasskey();
    await insertSoftPasskey(db, ana, voucher);
    const id = await ceremony();
    await bindLater(id, vouchBody(voucher, id));
    const results = await Promise.all([finish(id, softPasskey(), { signInCookie: null }), finish(id, softPasskey(), { signInCookie: null })]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.passkeyCredential.count({ where: { ownerId: ana } })).toBe(2);
  });

  it('finish waits on the user authority anchor, and refuses once a passkey committed meanwhile (deterministic race)', async () => {
    await freshSignIn();
    const id = await ceremony();
    await bindFirst(id);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let anchored!: () => void;
    const anchorTaken = new Promise<void>((r) => { anchored = r; });
    const holder = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'user', id: ana }], 'exclusive');
      anchored();
      await held;
      await tx.$executeRaw`INSERT INTO passkey_credentials
        (id, owner_id, credential_id, public_key, algorithm, user_handle, enrollment_rp_id, label, registered_at, counter, transports, backup_eligible, backed_up)
        VALUES ('race-winner', ${ana}, ${randomBytes(16)}, ${softPasskey().cosePublicKey}, -7, ${randomBytes(32)}, ${RP}, 'Winner',
          (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3), 0, ARRAY['internal'], false, false)`;
    }, { timeout: 20_000 });
    await anchorTaken;
    let settled = false;
    const racer = finish(id, softPasskey()).then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);
    release();
    await holder;
    expect(await racer).toBeNull();
    expect(await db.passkeyCredential.count({ where: { ownerId: ana } })).toBe(1);
  });

  it('two concurrent first-passkey finishes for one user register at most one', async () => {
    await freshSignIn(ana, 'b1');
    const c1 = await ceremony('c1');
    await bindFirst(c1, { ceremonyCookie: 'c1', signInCookie: 'b1' });
    await freshSignIn(ana, 'b2');
    const c2 = await ceremony('c2');
    await bindFirst(c2, { ceremonyCookie: 'c2', signInCookie: 'b2' });
    const results = await Promise.all([
      finish(c1, softPasskey(), { ceremonyCookie: 'c1', signInCookie: 'b1' }),
      finish(c2, softPasskey(), { ceremonyCookie: 'c2', signInCookie: 'b2' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.passkeyCredential.count({ where: { ownerId: ana } })).toBe(1);
  });
});

describe('an email-leg first passkey', () => {
  it('records email as its registration method', async () => {
    const { token } = await startEmailSignIn(db, { userId: ana, browserNonceHash: h(SIGN_IN_COOKIE) });
    expect(await confirmFreshSignIn(db, { legSecret: token, browserNonceHash: h(SIGN_IN_COOKIE), channel: 'email' })).toBe(true);
    const id = await ceremony();
    expect(await bindFirst(id)).not.toBeNull();
    const r = await finish(id, softPasskey());
    expect((await db.passkeyCredential.findUniqueOrThrow({ where: { id: r!.passkeyId } })).registrationMethod).toBe('email');
  });
});

describe('window length (cor:aut:040:07: never shorter than 72 hours)', () => {
  it.each([
    [undefined, 72], ['72', 72], ['96', 96],
  ])('PASSKEY_FIRST_WINDOW_HOURS=%s gives %i', (v, hours) => {
    expect(firstPasskeyWindowHours(v === undefined ? {} : { PASSKEY_FIRST_WINDOW_HOURS: v })).toBe(hours);
  });
  it.each(['71', '0', '-5', '72.5', 'abc', ''])('refuses %j', (v) => {
    expect(() => firstPasskeyWindowHours({ PASSKEY_FIRST_WINDOW_HOURS: v })).toThrow();
  });
});

describe('guard', () => {
  it('a ceremony is bound once', async () => {
    await freshSignIn();
    const id = await ceremony();
    await bindFirst(id);
    const bea = (await db.user.create({ data: { handle: 'reg-bea', roles: [] } })).id;
    await expect(db.$executeRaw`UPDATE passkey_ceremonies SET user_id = ${bea} WHERE id = ${id}`).rejects.toThrow(/bound once/);
  });
  it('a binding must be complete and consistent with its kind', async () => {
    const id = await ceremony();
    await expect(db.$executeRaw`UPDATE passkey_ceremonies SET user_id = ${ana}, kind = 'first', user_handle = ${randomBytes(32)} WHERE id = ${id}`)
      .rejects.toThrow(/chk_passkey_ceremony_registration/);
  });
  it('a notice is never deleted', async () => {
    await freshSignIn();
    const id = await ceremony();
    await bindFirst(id);
    const r = await finish(id, softPasskey());
    await expect(db.$executeRaw`DELETE FROM passkey_registration_notices WHERE passkey_id = ${r!.passkeyId}`).rejects.toThrow(/never deleted/);
  });
});
