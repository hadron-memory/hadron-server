/**
 * #1631 PR3 (cor:aut:040:05, #10404): account deletion keeps every passkey record as a verification record (public
 * key, credential id, times, window outcome) and erases only its identifying parts: the label, and the cancel record's
 * IP address and user agent. The passkey guard allows exactly that, and only for a deleted owner.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { insertSoftPasskey, softPasskey } from '../../test/softPasskey.js';
import { cancelFirstPasskey, issueCancelToken } from '../../lib/passkeys/cancel.js';
import { recordIdpSignIn } from '../../lib/passkeys/freshSignIn.js';
import { createCeremony } from '../../lib/passkeys/ceremony.js';
import { generateId } from '../../lib/id.js';
import { encryptToken } from '../../lib/tokenCrypto.js';
import { deleteUserAccount } from './deleteUser.js';

const h = (v: string) => createHash('sha256').update(v).digest('hex');
let ana: string;
let kept: string;
let cancelled: string;

beforeEach(async () => {
  await cleanDb(db);
  ana = (await db.user.create({ data: { handle: 'erase-ana', email: 'ana@example.test', roles: [] } })).id;
  kept = await insertSoftPasskey(db, ana, softPasskey(), { label: 'Work laptop' });
  cancelled = await insertSoftPasskey(db, ana, softPasskey(), { firstWindow: true, label: 'Phone' });
  const token = await db.$transaction((tx) => issueCancelToken(tx, cancelled));
  expect(await cancelFirstPasskey(db, { token, ip: '203.0.113.9', userAgent: 'MailApp/3' })).toBe(true);
});

const rec = (id: string) => db.passkeyCredential.findUniqueOrThrow({ where: { id } });

describe('account deletion erases a passkey record\'s identifying parts and keeps the verification record', () => {
  it('erases the label and the cancel IP and user agent, and keeps key, id, times and window outcome', async () => {
    const before = { kept: await rec(kept), cancelled: await rec(cancelled) };
    await deleteUserAccount(db, { targetUserId: ana, actorUserId: ana });
    for (const [id, b] of [[kept, before.kept], [cancelled, before.cancelled]] as const) {
      const a = await rec(id);
      expect(a.label).toBe('Erased passkey');
      expect(Buffer.from(a.publicKey).equals(Buffer.from(b.publicKey))).toBe(true);
      expect(Buffer.from(a.credentialId).equals(Buffer.from(b.credentialId))).toBe(true);
      expect(a).toMatchObject({ ownerId: ana, registeredAt: b.registeredAt, revokedAt: b.revokedAt, windowOutcome: b.windowOutcome, windowEndedAt: b.windowEndedAt, cancelledAt: b.cancelledAt, enrollmentRpId: b.enrollmentRpId });
    }
    expect(await rec(cancelled)).toMatchObject({ cancelIp: '', cancelUserAgent: '' });
    expect((await rec(kept)).cancelIp).toBeNull();
  });

  it('removes the user\'s fresh sign-ins and bound ceremonies, and settles an unsent notice without its cancel token', async () => {
    await recordIdpSignIn(db, { userId: ana, method: 'github', browserNonceHash: h('b') });
    const c = (await db.$transaction((tx) => createCeremony(tx, { purpose: 'REGISTER', browserNonceHash: h('c'), ttlSeconds: 300, challengeIsId: true }))).id;
    await db.$executeRaw`UPDATE passkey_ceremonies SET user_id = ${ana}, kind = 'later', vouch_passkey_id = ${kept}, user_handle = ${Buffer.alloc(32, 7)} WHERE id = ${c}`;
    const first = await insertSoftPasskey(db, ana, softPasskey(), { firstWindow: true });
    const token = await db.$transaction((tx) => issueCancelToken(tx, first));
    await db.$executeRaw`INSERT INTO passkey_registration_notices (id, passkey_id, user_id, kind, cancel_token_enc)
      VALUES (${generateId()}, ${first}, ${ana}, 'first', ${encryptToken(token)})`;
    await deleteUserAccount(db, { targetUserId: ana, actorUserId: ana });
    expect(await db.freshSignIn.count({ where: { userId: ana } })).toBe(0);
    expect(await db.passkeyCeremony.count({ where: { userId: ana } })).toBe(0);
    const n = await db.passkeyRegistrationNotice.findUniqueOrThrow({ where: { passkeyId: first } });
    expect(n.cancelTokenEnc).toBeNull();
    expect(n.failedAt).not.toBeNull();
  });
});

describe('the erasure commits with the deletion, or not at all (Rook Q2.3)', () => {
  it('a failing erase rolls the whole deletion back: the user stays live and the label stays', async () => {
    await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_fail_erase() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.label = 'Erased passkey' THEN RAISE EXCEPTION 'injected erase failure'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe('CREATE TRIGGER test_fail_erase BEFORE UPDATE ON passkey_credentials FOR EACH ROW EXECUTE FUNCTION test_fail_erase()');
    try {
      await expect(deleteUserAccount(db, { targetUserId: ana, actorUserId: ana })).rejects.toThrow(/injected erase failure/);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fail_erase ON passkey_credentials');
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_erase()');
    }
    expect((await db.user.findUniqueOrThrow({ where: { id: ana } })).deletedAt).toBeNull();
    expect((await rec(kept)).label).toBe('Work laptop');
  });
});

describe('a user merge is refused while the source holds a live passkey (Holger, 2026-10-21, #29507)', () => {
  it('refuses with a typed error and moves nothing; once the source has no live passkey the merge proceeds and leaves the records with the source', async () => {
    const { mergeUsers } = await import('../../test/mergeConsent.js');
    const target = (await db.user.create({ data: { handle: 'erase-target', roles: [] } })).id;
    const admin = (await db.user.create({ data: { handle: 'erase-admin', roles: ['ADMIN'] } })).id;
    const refused = await mergeUsers(db, { sourceUserId: ana, targetUserId: target, actorUserId: admin } as never).catch((e) => e);
    expect(refused?.extensions?.code).toBe('MERGE_SOURCE_HAS_PASSKEYS');
    expect((await db.user.findUniqueOrThrow({ where: { id: ana } })).deletedAt).toBeNull();
    await db.$executeRaw`UPDATE passkey_credentials SET revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id = ${kept}`;
    await mergeUsers(db, { sourceUserId: ana, targetUserId: target, actorUserId: admin } as never);
    expect((await db.user.findUniqueOrThrow({ where: { id: ana } })).deletedAt).not.toBeNull();
    expect((await rec(kept)).ownerId).toBe(ana);
    expect(await db.passkeyCredential.count({ where: { ownerId: target } })).toBe(0);
  });
});

describe('the guard allows the erasure and nothing else', () => {
  it('a live owner\'s label and cancel record cannot change, even to the erased values', async () => {
    await expect(db.$executeRaw`UPDATE passkey_credentials SET label = 'Renamed' WHERE id = ${kept}`).rejects.toThrow(/immutable/i);
    await expect(db.$executeRaw`UPDATE passkey_credentials SET label = 'Erased passkey' WHERE id = ${kept}`).rejects.toThrow(/immutable/i);
    await expect(db.$executeRaw`UPDATE passkey_credentials SET cancel_ip = '' WHERE id = ${cancelled}`).rejects.toThrow(/immutable/i);
  });

  it('for a deleted owner, only the erased values are accepted, and an erased value never changes again', async () => {
    await db.user.update({ where: { id: ana }, data: { deletedAt: new Date() } });
    await expect(db.$executeRaw`UPDATE passkey_credentials SET label = 'Other' WHERE id = ${kept}`).rejects.toThrow(/immutable/i);
    await expect(db.$executeRaw`UPDATE passkey_credentials SET cancel_ip = '198.51.100.1' WHERE id = ${cancelled}`).rejects.toThrow(/immutable/i);
    // Holger (#29507): an erased label reads as the fixed text 'Erased passkey'; nothing else, '' included.
    await expect(db.$executeRaw`UPDATE passkey_credentials SET label = '' WHERE id = ${kept}`).rejects.toThrow(/immutable/i);
    await db.$executeRaw`UPDATE passkey_credentials SET label = 'Erased passkey' WHERE id = ${kept}`;
    await db.$executeRaw`UPDATE passkey_credentials SET label = 'Erased passkey', cancel_ip = '', cancel_user_agent = '' WHERE id = ${cancelled}`;
    await expect(db.$executeRaw`UPDATE passkey_credentials SET label = 'Back' WHERE id = ${kept}`).rejects.toThrow(/immutable/i);
    await expect(db.$executeRaw`UPDATE passkey_credentials SET cancel_ip = '203.0.113.9' WHERE id = ${cancelled}`).rejects.toThrow(/immutable/i);
  });

  it('a deleted owner\'s record still can\'t be deleted or have its identity changed', async () => {
    await db.user.update({ where: { id: ana }, data: { deletedAt: new Date() } });
    await expect(db.$executeRaw`DELETE FROM passkey_credentials WHERE id = ${kept}`).rejects.toThrow(/never deleted/i);
    await expect(db.$executeRaw`UPDATE passkey_credentials SET public_key = ${Buffer.from('x')} WHERE id = ${kept}`).rejects.toThrow(/immutable/i);
  });

  it('the newest migration carries the shared guard verbatim', () => {
    const guard = readFileSync('prisma/passkey-invariants.sql', 'utf8');
    expect(readFileSync('prisma/migrations/20261021110000_passkey_erasure/migration.sql', 'utf8').endsWith(guard)).toBe(true);
  });
});
