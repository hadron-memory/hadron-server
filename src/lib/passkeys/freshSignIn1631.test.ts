/** #1631 PR1b slice 2 (cor:aut:040:09): the fresh-sign-in record, its same-browser confirm, and its consume. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import {
  confirmFreshSignIn, consumeFreshSignIn, recordIdpSignIn, startEmailSignIn, sweepFreshSignIns,
  type FreshSignInPurpose,
} from './freshSignIn.js';

const h = (v: string) => createHash('sha256').update(v).digest('hex');
const BROWSER_A = h('browser-a');
const BROWSER_B = h('browser-b');
let alice: string;
let bob: string;

beforeEach(async () => {
  await cleanDb(db);
  alice = (await db.user.create({ data: { handle: 'fresh-alice', roles: [] } })).id;
  bob = (await db.user.create({ data: { handle: 'fresh-bob', roles: [] } })).id;
});

const consume = (browserNonceHash: string, actingUserId: string, purpose: FreshSignInPurpose = 'register') =>
  db.$transaction((tx) => consumeFreshSignIn(tx, { browserNonceHash, actingUserId, purpose }));

/** Move a row's times back, past the guard, to simulate age. */
async function age(id: string, seconds: number) {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    await tx.$executeRaw`UPDATE fresh_sign_ins SET
      created_at = created_at - make_interval(secs => ${seconds}),
      signed_in_at = signed_in_at - make_interval(secs => ${seconds}),
      confirmed_at = confirmed_at - make_interval(secs => ${seconds})
      WHERE id = ${id}`;
  });
}

describe('IdP leg', () => {
  it('records an unconfirmed row that consumes nothing until the same browser confirms it with the leg id', async () => {
    const { legId } = await recordIdpSignIn(db, { userId: alice, method: 'github', browserNonceHash: BROWSER_A });
    expect(legId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await db.freshSignIn.findFirstOrThrow({ where: { userId: alice } });
    expect(row).toMatchObject({ method: 'github', browserNonceHash: BROWSER_A, legHash: h(legId), confirmedAt: null });
    expect(row.signedInAt).not.toBeNull();
    expect(await consume(BROWSER_A, alice)).toBeNull();

    expect(await confirmFreshSignIn(db, { legSecret: legId, browserNonceHash: BROWSER_A })).toBe(true);
    expect(await consume(BROWSER_A, alice)).toMatchObject({ id: row.id, method: 'github' });
    const spent = await db.freshSignIn.findUniqueOrThrow({ where: { id: row.id } });
    expect(spent.consumedFor).toBe('register');
    expect(await consume(BROWSER_A, alice)).toBeNull();
  });

  it('a leg started in browser A and finished in browser B confirms in neither (Ruth red pin 1)', async () => {
    const { legId } = await recordIdpSignIn(db, { userId: alice, method: 'google', browserNonceHash: BROWSER_A });
    // B finished the IdP proof, so B holds the leg id, but not A's cookie.
    expect(await confirmFreshSignIn(db, { legSecret: legId, browserNonceHash: BROWSER_B })).toBe(false);
    // A holds the cookie but never learns the leg id.
    expect(await confirmFreshSignIn(db, { legSecret: 'x'.repeat(43), browserNonceHash: BROWSER_A })).toBe(false);
    expect(await consume(BROWSER_A, alice)).toBeNull();
    expect(await consume(BROWSER_B, alice)).toBeNull();
    // A refused attempt does not burn the leg for its rightful browser.
    expect(await confirmFreshSignIn(db, { legSecret: legId, browserNonceHash: BROWSER_A })).toBe(true);
  });

  it('confirms once', async () => {
    const { legId } = await recordIdpSignIn(db, { userId: alice, method: 'apple', browserNonceHash: BROWSER_A });
    expect(await confirmFreshSignIn(db, { legSecret: legId, browserNonceHash: BROWSER_A })).toBe(true);
    expect(await confirmFreshSignIn(db, { legSecret: legId, browserNonceHash: BROWSER_A })).toBe(false);
  });

  it('refuses a fresh sign-in for user A on user B\'s ceremony (Ruth red pin 3)', async () => {
    const { legId } = await recordIdpSignIn(db, { userId: alice, method: 'github', browserNonceHash: BROWSER_A });
    await confirmFreshSignIn(db, { legSecret: legId, browserNonceHash: BROWSER_A });
    expect(await consume(BROWSER_A, bob)).toBeNull();
    expect(await consume(BROWSER_A, alice)).not.toBeNull();
  });

  it('is not fresh 10 minutes after the identity proof', async () => {
    const { legId } = await recordIdpSignIn(db, { userId: alice, method: 'github', browserNonceHash: BROWSER_A });
    await confirmFreshSignIn(db, { legSecret: legId, browserNonceHash: BROWSER_A });
    const { id } = await db.freshSignIn.findFirstOrThrow({ where: { userId: alice } });
    await age(id, 10 * 60 + 1);
    expect(await consume(BROWSER_A, alice)).toBeNull();
  });

  it('is still fresh just inside 10 minutes', async () => {
    const { legId } = await recordIdpSignIn(db, { userId: alice, method: 'github', browserNonceHash: BROWSER_A });
    await confirmFreshSignIn(db, { legSecret: legId, browserNonceHash: BROWSER_A });
    const { id } = await db.freshSignIn.findFirstOrThrow({ where: { userId: alice } });
    await age(id, 10 * 60 - 30);
    expect(await consume(BROWSER_A, alice)).not.toBeNull();
  });

  it('cannot be confirmed after the leg expired', async () => {
    const { legId } = await recordIdpSignIn(db, { userId: alice, method: 'github', browserNonceHash: BROWSER_A });
    const { id } = await db.freshSignIn.findFirstOrThrow({ where: { userId: alice } });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      await tx.$executeRaw`UPDATE fresh_sign_ins SET expires_at = created_at + interval '1 millisecond', signed_in_at = created_at WHERE id = ${id}`;
    });
    expect(await confirmFreshSignIn(db, { legSecret: legId, browserNonceHash: BROWSER_A })).toBe(false);
  });

  it('a deleted user can neither confirm nor consume', async () => {
    const { legId } = await recordIdpSignIn(db, { userId: alice, method: 'github', browserNonceHash: BROWSER_A });
    await db.user.update({ where: { id: alice }, data: { deletedAt: new Date() } });
    expect(await confirmFreshSignIn(db, { legSecret: legId, browserNonceHash: BROWSER_A })).toBe(false);
  });

  it('revoke accepts an IdP sign-in', async () => {
    const { legId } = await recordIdpSignIn(db, { userId: alice, method: 'google', browserNonceHash: BROWSER_A });
    await confirmFreshSignIn(db, { legSecret: legId, browserNonceHash: BROWSER_A });
    expect(await consume(BROWSER_A, alice, 'revoke')).toMatchObject({ method: 'google' });
  });
});

describe('email leg', () => {
  it('has no identity proof until the confirming POST, which sets signed_in_at', async () => {
    const { token } = await startEmailSignIn(db, { userId: alice, browserNonceHash: BROWSER_A });
    const before = await db.freshSignIn.findFirstOrThrow({ where: { userId: alice } });
    expect(before).toMatchObject({ method: 'email', signedInAt: null, confirmedAt: null, legHash: h(token) });
    expect(await confirmFreshSignIn(db, { legSecret: token, browserNonceHash: BROWSER_B })).toBe(false);
    expect(await confirmFreshSignIn(db, { legSecret: token, browserNonceHash: BROWSER_A })).toBe(true);
    const after = await db.freshSignIn.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.signedInAt).not.toBeNull();
    expect(after.confirmedAt?.getTime()).toBe(after.signedInAt?.getTime());
  });

  it('never counts for revoke (a magic link is never fresh enough to revoke)', async () => {
    const { token } = await startEmailSignIn(db, { userId: alice, browserNonceHash: BROWSER_A });
    await confirmFreshSignIn(db, { legSecret: token, browserNonceHash: BROWSER_A });
    expect(await consume(BROWSER_A, alice, 'revoke')).toBeNull();
    expect(await consume(BROWSER_A, alice, 'end-window')).toMatchObject({ method: 'email' });
  });
});

describe('guard', () => {
  it('the migration and both schema-push paths carry the same guard', () => {
    const guard = readFileSync('prisma/fresh-sign-in-invariants.sql', 'utf8');
    expect(readFileSync('prisma/migrations/20261021080000_fresh_sign_ins/migration.sql', 'utf8').endsWith(guard)).toBe(true);
    expect(readFileSync('prisma/post-push.sql', 'utf8')).toContain('\\ir fresh-sign-in-invariants.sql');
    expect(readFileSync('src/test/globalSetup.ts', 'utf8')).toContain('../../prisma/fresh-sign-in-invariants.sql');
  });

  it('writes times from the database clock, whatever the statement said', async () => {
    const { legId } = await recordIdpSignIn(db, { userId: alice, method: 'github', browserNonceHash: BROWSER_A });
    const { id } = await db.freshSignIn.findFirstOrThrow({ where: { userId: alice } });
    await db.$executeRaw`UPDATE fresh_sign_ins SET confirmed_at = '2001-01-01' WHERE id = ${id}`;
    const row = await db.freshSignIn.findUniqueOrThrow({ where: { id } });
    expect(row.confirmedAt!.getFullYear()).toBeGreaterThan(2001);
    void legId;
  });

  it.each([
    ['user_id', (id: string) => db.$executeRaw`UPDATE fresh_sign_ins SET user_id = ${bob} WHERE id = ${id}`],
    ['method', (id: string) => db.$executeRaw`UPDATE fresh_sign_ins SET method = 'google' WHERE id = ${id}`],
    ['browser_nonce_hash', (id: string) => db.$executeRaw`UPDATE fresh_sign_ins SET browser_nonce_hash = ${BROWSER_B} WHERE id = ${id}`],
    ['expires_at', (id: string) => db.$executeRaw`UPDATE fresh_sign_ins SET expires_at = expires_at + interval '1 hour' WHERE id = ${id}`],
  ])('keeps %s immutable', async (_c, mutate) => {
    await recordIdpSignIn(db, { userId: alice, method: 'github', browserNonceHash: BROWSER_A });
    const { id } = await db.freshSignIn.findFirstOrThrow({ where: { userId: alice } });
    await expect(mutate(id)).rejects.toThrow(/immutable/);
  });

  it('sets confirmed_at once', async () => {
    const { legId } = await recordIdpSignIn(db, { userId: alice, method: 'github', browserNonceHash: BROWSER_A });
    await confirmFreshSignIn(db, { legSecret: legId, browserNonceHash: BROWSER_A });
    const { id } = await db.freshSignIn.findFirstOrThrow({ where: { userId: alice } });
    await expect(db.$executeRaw`UPDATE fresh_sign_ins SET confirmed_at = NULL WHERE id = ${id}`).rejects.toThrow(/set once/);
  });

  it('refuses to spend an unconfirmed row, or an email row for revoke, even by hand', async () => {
    await recordIdpSignIn(db, { userId: alice, method: 'github', browserNonceHash: BROWSER_A });
    const { id } = await db.freshSignIn.findFirstOrThrow({ where: { userId: alice } });
    await expect(db.$executeRaw`UPDATE fresh_sign_ins SET consumed_at = now(), consumed_for = 'register' WHERE id = ${id}`).rejects.toThrow(/chk_fresh_sign_in_shape/);
    const { token } = await startEmailSignIn(db, { userId: bob, browserNonceHash: BROWSER_A });
    await confirmFreshSignIn(db, { legSecret: token, browserNonceHash: BROWSER_A });
    const email = await db.freshSignIn.findFirstOrThrow({ where: { userId: bob } });
    await expect(db.$executeRaw`UPDATE fresh_sign_ins SET consumed_at = now(), consumed_for = 'revoke' WHERE id = ${email.id}`).rejects.toThrow(/chk_fresh_sign_in_shape/);
  });

  it('refuses a spent row with no purpose (Gene P2: NULL IN (...) is UNKNOWN, which a CHECK lets pass)', async () => {
    const { legId } = await recordIdpSignIn(db, { userId: alice, method: 'github', browserNonceHash: BROWSER_A });
    await confirmFreshSignIn(db, { legSecret: legId, browserNonceHash: BROWSER_A });
    const { id } = await db.freshSignIn.findFirstOrThrow({ where: { userId: alice } });
    await expect(db.$executeRaw`UPDATE fresh_sign_ins SET consumed_at = now() WHERE id = ${id}`).rejects.toThrow(/chk_fresh_sign_in_shape/);
    // The control: the same write with a purpose is accepted.
    await db.$executeRaw`UPDATE fresh_sign_ins SET consumed_at = now(), consumed_for = 'register' WHERE id = ${id}`;
  });

  it('refuses a row inserted already confirmed', async () => {
    await expect(db.$executeRaw`INSERT INTO fresh_sign_ins (id, user_id, method, browser_nonce_hash, leg_hash, expires_at, signed_in_at, confirmed_at)
      VALUES ('x1', ${alice}, 'github', ${BROWSER_A}, ${h('leg')}, now() + interval '1 hour', now(), now())`).rejects.toThrow(/unconfirmed/);
  });
});

describe('retention', () => {
  it('sweeps rows older than 24 hours and keeps newer ones', async () => {
    await recordIdpSignIn(db, { userId: alice, method: 'github', browserNonceHash: BROWSER_A });
    await recordIdpSignIn(db, { userId: bob, method: 'github', browserNonceHash: BROWSER_B });
    const old = await db.freshSignIn.findFirstOrThrow({ where: { userId: alice } });
    await age(old.id, 24 * 3600 + 1);
    await sweepFreshSignIns(db);
    expect(await db.freshSignIn.count({ where: { userId: alice } })).toBe(0);
    expect(await db.freshSignIn.count({ where: { userId: bob } })).toBe(1);
  });
});
