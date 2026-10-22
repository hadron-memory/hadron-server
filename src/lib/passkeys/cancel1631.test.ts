/** #1631 PR2 (cor:aut:040:07 S5, 040:08 S6-S9): a first passkey's cancel link. */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { insertSoftPasskey, softPasskey } from '../../test/softPasskey.js';
import { createSignIn } from '../../auth/signIn.js';
import { lockAuthorityAnchors } from '../auth/authorityAnchors.js';
import { cancelFirstPasskey, issueCancelToken } from './cancel.js';

let ana: string;
let first: string;
let token: string;
const req = { ip: '203.0.113.7', userAgent: 'Mail/1.0' };

beforeEach(async () => {
  await cleanDb(db);
  ana = (await db.user.create({ data: { handle: 'cancel-ana', roles: [] } })).id;
  first = await insertSoftPasskey(db, ana, softPasskey(), { firstWindow: true });
  token = await db.$transaction((tx) => issueCancelToken(tx, first));
});

const cred = () => db.passkeyCredential.findUniqueOrThrow({ where: { id: first } });

/** Move the window's end into the past, past the guard, to simulate a window that ran out. */
async function runOut(id: string) {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw`UPDATE passkey_credentials SET registered_at = registered_at - interval '73 hours',
      window_ends_at = window_ends_at - interval '73 hours' WHERE id = ${id}`;
  });
}

describe('cancel link', () => {
  it('revokes the first passkey as cancelled, with time, IP and user agent, without a sign-in (040:08 S6, S8)', async () => {
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await cancelFirstPasskey(db, { token, ...req })).toBe(true);
    const c = await cred();
    expect(c.revokedAt).not.toBeNull();
    expect(c).toMatchObject({ windowOutcome: 'cancelled', cancelIp: req.ip, cancelUserAgent: req.userAgent });
    expect(c.cancelledAt?.getTime()).toBe(c.revokedAt?.getTime());
    expect(c.windowEndedAt?.getTime()).toBe(c.revokedAt?.getTime());
    expect((await db.passkeyCancelToken.findUniqueOrThrow({ where: { passkeyId: first } })).usedAt).not.toBeNull();
  });

  it('ends every sign-in that passkey completed, and nothing else (040:08 S9, R66)', async () => {
    const other = await insertSoftPasskey(db, ana, softPasskey());
    const mine = await db.$transaction((tx) => createSignIn(tx, { userId: ana, method: 'email', passkeyId: first }));
    const theirs = await db.$transaction((tx) => createSignIn(tx, { userId: ana, method: 'email', passkeyId: other }));
    const idp = await db.$transaction((tx) => createSignIn(tx, { userId: ana, method: 'github', passkeyId: null }));
    expect(await cancelFirstPasskey(db, { token, ...req })).toBe(true);
    expect((await db.signIn.findUniqueOrThrow({ where: { id: mine.id } })).endedAt).not.toBeNull();
    expect((await db.signIn.findUniqueOrThrow({ where: { id: theirs.id } })).endedAt).toBeNull();
    expect((await db.signIn.findUniqueOrThrow({ where: { id: idp.id } })).endedAt).toBeNull();
  });

  it('works once (040:08 S7)', async () => {
    expect(await cancelFirstPasskey(db, { token, ...req })).toBe(true);
    const after = await cred();
    expect(await cancelFirstPasskey(db, { token, ip: '198.51.100.1', userAgent: 'Other' })).toBe(false);
    expect((await cred()).cancelIp).toBe(after.cancelIp);
  });

  it('a spent token never cancels, even while the window is still open', async () => {
    await db.$executeRaw`UPDATE passkey_cancel_tokens SET used_at = now() WHERE passkey_id = ${first}`;
    expect(await cancelFirstPasskey(db, { token, ...req })).toBe(false);
    expect((await cred()).revokedAt).toBeNull();
  });

  it('does nothing once the window has ended (040:08 S7)', async () => {
    await runOut(first);
    expect(await cancelFirstPasskey(db, { token, ...req })).toBe(false);
    expect((await cred()).revokedAt).toBeNull();
    expect((await db.passkeyCancelToken.findUniqueOrThrow({ where: { passkeyId: first } })).usedAt).toBeNull();
  });

  it('does nothing for a passkey already revoked by another route', async () => {
    await db.$executeRaw`UPDATE passkey_credentials SET revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3),
      window_outcome = 'cancelled', window_ended_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id = ${first}`;
    expect(await cancelFirstPasskey(db, { token, ...req })).toBe(false);
    expect((await cred()).cancelIp).toBeNull();
  });

  it('refuses an unknown or malformed token', async () => {
    expect(await cancelFirstPasskey(db, { token: 'A'.repeat(43), ...req })).toBe(false);
    expect(await cancelFirstPasskey(db, { token: 'short', ...req })).toBe(false);
    expect((await cred()).revokedAt).toBeNull();
  });

  it('a window that runs out while the cancel waits on the owner\'s anchor refuses (Andi P2-2: decide by the clock after the wait)', async () => {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw`UPDATE passkey_credentials SET registered_at = (now() AT TIME ZONE 'UTC') - interval '72 hours',
        window_ends_at = (now() AT TIME ZONE 'UTC') + interval '1500 milliseconds' WHERE id = ${first}`;
    });
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
    const racer = cancelFirstPasskey(db, { token, ...req });
    await new Promise((r) => setTimeout(r, 2500));
    release();
    await holder;
    expect(await racer).toBe(false);
    expect((await cred()).revokedAt).toBeNull();
  });

  it('two concurrent cancels revoke once', async () => {
    const results = await Promise.all([cancelFirstPasskey(db, { token, ...req }), cancelFirstPasskey(db, { token, ...req })]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('issuing', () => {
  it('only a first passkey with an open window gets a token, and only one', async () => {
    const later = await insertSoftPasskey(db, ana, softPasskey());
    await expect(db.$transaction((tx) => issueCancelToken(tx, later))).rejects.toThrow();
    await expect(db.$transaction((tx) => issueCancelToken(tx, first))).rejects.toThrow();
  });
  it('stores only the hash', async () => {
    const row = await db.passkeyCancelToken.findUniqueOrThrow({ where: { passkeyId: first } });
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.tokenHash).not.toContain(token);
  });
});

describe('guard', () => {
  it('the migration and both schema-push paths carry the same guard', () => {
    const guard = readFileSync('prisma/passkey-registration-invariants.sql', 'utf8');
    expect(readFileSync('prisma/migrations/20261022030000_passkey_revoke/migration.sql', 'utf8').endsWith(guard)).toBe(true);
    expect(readFileSync('prisma/post-push.sql', 'utf8')).toContain('\\ir passkey-registration-invariants.sql');
    expect(readFileSync('src/test/globalSetup.ts', 'utf8')).toContain('../../prisma/passkey-registration-invariants.sql');
  });
  it('a token is never deleted, spent once, and its identity is immutable', async () => {
    const { id } = await db.passkeyCancelToken.findUniqueOrThrow({ where: { passkeyId: first } });
    await expect(db.$executeRaw`DELETE FROM passkey_cancel_tokens WHERE id = ${id}`).rejects.toThrow(/never deleted/);
    await expect(db.$executeRaw`UPDATE passkey_cancel_tokens SET token_hash = ${'0'.repeat(64)} WHERE id = ${id}`).rejects.toThrow(/immutable/);
    await db.$executeRaw`UPDATE passkey_cancel_tokens SET used_at = '2001-01-01' WHERE id = ${id}`;
    const row = await db.passkeyCancelToken.findUniqueOrThrow({ where: { id } });
    expect(row.usedAt!.getFullYear()).toBeGreaterThan(2001);
    await expect(db.$executeRaw`UPDATE passkey_cancel_tokens SET used_at = NULL WHERE id = ${id}`).rejects.toThrow(/spent once/);
  });
});
