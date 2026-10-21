/** #1631 PR2 (cor:aut:040:07 S2, S3, S7): ending a first passkey's cooling-off window early. */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { insertSoftPasskey, softPasskey } from '../../test/softPasskey.js';
import { confirmFreshSignIn, recordIdpSignIn, startEmailSignIn } from './freshSignIn.js';
import { endWindowEarly, previewWindowEnd } from './endWindow.js';
import { lockAuthorityAnchors } from '../auth/authorityAnchors.js';

const h = (v: string) => createHash('sha256').update(v).digest('hex');
const BROWSER = 'end-window-browser';
let ana: string;
let first: string;

beforeEach(async () => {
  await cleanDb(db);
  ana = (await db.user.create({ data: { handle: 'ew-ana', roles: [] } })).id;
  // insertSoftPasskey registers a first passkey via github.
  first = await insertSoftPasskey(db, ana, softPasskey(), { firstWindow: true });
});

async function idp(userId: string, method: 'github' | 'google', browser = BROWSER) {
  const { legId } = await recordIdpSignIn(db, { userId, method, browserNonceHash: h(browser) });
  expect(await confirmFreshSignIn(db, { legSecret: legId, browserNonceHash: h(browser), channel: 'idp' })).toBe(true);
}
async function email(userId: string, browser = BROWSER) {
  const { token } = await startEmailSignIn(db, { userId, browserNonceHash: h(browser) });
  expect(await confirmFreshSignIn(db, { legSecret: token, browserNonceHash: h(browser), channel: 'email' })).toBe(true);
}
const end = (browser = BROWSER) => endWindowEarly(db, { signInBrowserHash: h(browser) });
const cred = () => db.passkeyCredential.findUniqueOrThrow({ where: { id: first } });

describe('end the window early', () => {
  it('a fresh sign-in by a different identity provider ends it, and the sign-in is spent (S7)', async () => {
    await idp(ana, 'google');
    expect(await end()).toEqual({ passkeyId: first });
    const c = await cred();
    expect(c.windowOutcome).toBe('ended-early');
    expect(c.windowEndedAt!.getTime()).toBeLessThan(c.windowEndsAt!.getTime());
    expect((await db.freshSignIn.findFirstOrThrow({ where: { userId: ana } })).consumedFor).toBe('end-window');
  });

  it('a browser-bound magic link counts as different from an identity-provider registration (S7)', async () => {
    await email(ana);
    expect(await end()).toEqual({ passkeyId: first });
  });

  it('the same method does not end it (S3), and the sign-in stays unspent', async () => {
    await idp(ana, 'github');
    expect(await end()).toBeNull();
    expect((await cred()).windowOutcome).toBeNull();
    expect((await db.freshSignIn.findFirstOrThrow({ where: { userId: ana } })).consumedAt).toBeNull();
  });

  it('two magic links are not different methods (S3)', async () => {
    const bea = (await db.user.create({ data: { handle: 'ew-bea', roles: [] } })).id;
    const beas = await insertSoftPasskey(db, bea, softPasskey(), { firstWindow: true });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw`UPDATE passkey_credentials SET registration_method = 'email' WHERE id = ${beas}`;
    });
    await email(bea);
    expect(await end()).toBeNull();
  });

  it('another user\'s in-window passkey is never touched: the acting user is the sign-in\'s (Rook)', async () => {
    const bea = (await db.user.create({ data: { handle: 'ew-bea', roles: [] } })).id;
    await idp(bea, 'google');
    expect(await end()).toBeNull();
    expect((await cred()).windowOutcome).toBeNull();
  });

  it('refuses when the window already ran out, or the passkey was revoked', async () => {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw`UPDATE passkey_credentials SET registered_at = registered_at - interval '73 hours', window_ends_at = window_ends_at - interval '73 hours' WHERE id = ${first}`;
    });
    await idp(ana, 'google');
    expect(await end()).toBeNull();
  });

  it('refuses with no fresh sign-in, on another browser, or two qualifying ones', async () => {
    expect(await end()).toBeNull();
    await idp(ana, 'google', 'other-browser');
    expect(await end()).toBeNull();
    const bea = (await db.user.create({ data: { handle: 'ew-bea', roles: [] } })).id;
    await idp(ana, 'google');
    await idp(bea, 'google');
    expect(await end()).toBeNull();
  });

  it('a window that runs out while the step waits on the anchor is not ended (Andi P2-2)', async () => {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw`UPDATE passkey_credentials SET registered_at = (now() AT TIME ZONE 'UTC') - interval '72 hours',
        window_ends_at = (now() AT TIME ZONE 'UTC') + interval '1500 milliseconds' WHERE id = ${first}`;
    });
    await idp(ana, 'google');
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let anchored!: () => void;
    const anchorTaken = new Promise<void>((r) => { anchored = r; });
    const holder = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'user', id: ana }], 'exclusive');
      anchored();
      await held;
    }, { timeout: 20_000 });
    await anchorTaken;
    const racer = end();
    await new Promise((r) => setTimeout(r, 2500));
    release();
    await holder;
    expect(await racer).toBeNull();
    expect((await cred()).windowOutcome).toBeNull();
  });

  it('two qualifying sign-ins on one browser, even for the same user, refuse and spend nothing (Rook P3-1)', async () => {
    await idp(ana, 'google');
    await idp(ana, 'google');
    expect(await end()).toBeNull();
    expect(await db.freshSignIn.count({ where: { consumedAt: { not: null } } })).toBe(0);
  });

  it('previews the passkey it would act on, without spending anything (Rook P3-2)', async () => {
    await idp(ana, 'google');
    const p = await previewWindowEnd(db, { signInBrowserHash: h(BROWSER) });
    expect(p).toMatchObject({ label: 'Soft key' });
    expect(p!.registeredAt).toBeInstanceOf(Date);
    expect((await db.freshSignIn.findFirstOrThrow({ where: { userId: ana } })).consumedAt).toBeNull();
    expect((await cred()).windowOutcome).toBeNull();
    // Nothing to preview with the same method, or for a browser with no sign-in.
    expect(await previewWindowEnd(db, { signInBrowserHash: h('nobody') })).toBeNull();
  });

  it('ends once', async () => {
    await idp(ana, 'google');
    expect(await end()).not.toBeNull();
    await idp(ana, 'google', 'second');
    expect(await end('second')).toBeNull();
  });
});
