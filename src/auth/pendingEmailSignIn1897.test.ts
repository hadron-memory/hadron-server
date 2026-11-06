/** #1897 slice B1: the pending email sign-in row, its guards, and its one-shot completion (real Postgres). */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createSignIn } from './signIn.js';
import {
  completePending, createPendingEmailSignIn, loadLivePending, setPendingCeremony, sha256Hex, sweepPendingEmailSignIns,
} from './pendingEmailSignIn.js';

let alice: string;
let bob: string;
const PORTAL = { kind: 'PORTAL' as const, clientStateHash: sha256Hex('portal-nonce'), redirect: '/', isNew: false };

beforeEach(async () => {
  await cleanDb(db);
  alice = (await db.user.create({ data: { handle: 'pending-alice', roles: [] } })).id;
  bob = (await db.user.create({ data: { handle: 'pending-bob', roles: [] } })).id;
});

const rowOf = (id: string) => db.$queryRaw<Array<Record<string, any>>>`SELECT * FROM pending_email_sign_ins WHERE id = ${id}`.then((r) => r[0]);
async function age(id: string, seconds: number) {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    await tx.$executeRaw`UPDATE pending_email_sign_ins SET created_at = created_at - make_interval(secs => ${seconds}),
      expires_at = expires_at - make_interval(secs => ${seconds}) WHERE id = ${id}`;
  });
}

describe('schema', () => {
  it('the migration carries the invariants file verbatim', () => {
    const inv = readFileSync(new URL('../../prisma/pending-email-sign-in-invariants.sql', import.meta.url), 'utf8');
    const mig = readFileSync(new URL('../../prisma/migrations/20261021120000_pending_email_sign_ins/migration.sql', import.meta.url), 'utf8');
    expect(mig.endsWith(inv)).toBe(true);
  });

  it('a pending row stores only the hash of its cookie, lives ten minutes, and begins uncompleted', async () => {
    const { id, cookieSecret } = await createPendingEmailSignIn(db, { userId: alice, continuation: PORTAL });
    const row = await rowOf(id);
    expect(row.browser_hash).toBe(sha256Hex(cookieSecret));
    expect(JSON.stringify(row)).not.toContain(cookieSecret);
    expect(row.completed_at).toBeNull();
    expect(row.sign_in_id).toBeNull();
    const ttl = (new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()) / 1000;
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it('each continuation carries exactly its own columns', async () => {
    const ok = (continuation: any) => createPendingEmailSignIn(db, { userId: alice, continuation });
    await expect(ok({ kind: 'OAUTH', returnTo: '/oauth/authorize?x=1' })).resolves.toBeTruthy();
    const raw = (cols: { continuation: string; client_state_hash?: string | null; redirect?: string | null; is_new?: boolean | null; return_to?: string | null }) =>
      db.$executeRaw`INSERT INTO pending_email_sign_ins (id, user_id, continuation, client_state_hash, redirect, is_new, return_to, browser_hash, expires_at)
        VALUES (${generateId()}, ${alice}, ${cols.continuation}, ${cols.client_state_hash ?? null}, ${cols.redirect ?? null}, ${cols.is_new ?? null},
                ${cols.return_to ?? null}, ${sha256Hex(generateId())}, (clock_timestamp() AT TIME ZONE 'UTC') + interval '10 minutes')`;
    await expect(raw({ continuation: 'PORTAL', redirect: '/', is_new: false, return_to: '/x' })).rejects.toThrow();
    await expect(raw({ continuation: 'PORTAL', is_new: false })).rejects.toThrow();
    await expect(raw({ continuation: 'OAUTH', return_to: '/x', client_state_hash: sha256Hex('n') })).rejects.toThrow();
    await expect(raw({ continuation: 'OAUTH', return_to: '/x', redirect: '/' })).rejects.toThrow();
    await expect(raw({ continuation: 'OAUTH' })).rejects.toThrow();
    await expect(raw({ continuation: 'WEIRD', return_to: '/x' })).rejects.toThrow();
  });

  it('identity and continuation never change, and a row cannot be born completed', async () => {
    const { id } = await createPendingEmailSignIn(db, { userId: alice, continuation: PORTAL });
    for (const sql of [
      `UPDATE pending_email_sign_ins SET user_id = '${bob}' WHERE id = '${id}'`,
      `UPDATE pending_email_sign_ins SET redirect = '/elsewhere' WHERE id = '${id}'`,
      `UPDATE pending_email_sign_ins SET client_state_hash = '${sha256Hex('other')}' WHERE id = '${id}'`,
      `UPDATE pending_email_sign_ins SET browser_hash = '${sha256Hex('other')}' WHERE id = '${id}'`,
      `UPDATE pending_email_sign_ins SET expires_at = expires_at + interval '1 day' WHERE id = '${id}'`,
    ]) await expect(db.$executeRawUnsafe(sql)).rejects.toThrow();
    await expect(db.$executeRaw`INSERT INTO pending_email_sign_ins (id, user_id, continuation, redirect, is_new, browser_hash, expires_at, completed_at)
      VALUES (${generateId()}, ${alice}, 'PORTAL', '/', false, ${sha256Hex(generateId())}, (clock_timestamp() AT TIME ZONE 'UTC') + interval '10 minutes', now())`).rejects.toThrow();
  });
});

describe('lookup and completion', () => {
  it('finds a live pending flow by its cookie and by nothing else', async () => {
    const { id, cookieSecret } = await createPendingEmailSignIn(db, { userId: alice, continuation: PORTAL });
    expect((await loadLivePending(db, cookieSecret))?.id).toBe(id);
    expect(await loadLivePending(db, sha256Hex(cookieSecret))).toBeNull();
    expect(await loadLivePending(db, 'x'.repeat(200))).toBeNull();
    expect(await loadLivePending(db, 'has space')).toBeNull();
    expect(await loadLivePending(db, null)).toBeNull();
    expect(await loadLivePending(db, '')).toBeNull();
  });

  it('expired, completed and unknown are the same null', async () => {
    const a = await createPendingEmailSignIn(db, { userId: alice, continuation: PORTAL });
    await age(a.id, 601);
    expect(await loadLivePending(db, a.cookieSecret)).toBeNull();
    const b = await createPendingEmailSignIn(db, { userId: alice, continuation: PORTAL });
    const si = await db.$transaction((tx) => createSignIn(tx, { userId: alice, method: 'email', passkeyId: null }));
    expect(await completePending(db, b.id, si.id)).toBe(true);
    expect(await loadLivePending(db, b.cookieSecret)).toBeNull();
    expect(await loadLivePending(db, 'never-issued-secret-aaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull();
  });

  it('completes once, with a sign-in of the same user only', async () => {
    const { id } = await createPendingEmailSignIn(db, { userId: alice, continuation: PORTAL });
    const foreign = await db.$transaction((tx) => createSignIn(tx, { userId: bob, method: 'email', passkeyId: null }));
    await expect(completePending(db, id, foreign.id)).rejects.toThrow();
    const mine = await db.$transaction((tx) => createSignIn(tx, { userId: alice, method: 'email', passkeyId: null }));
    expect(await completePending(db, id, mine.id)).toBe(true);
    const done = await rowOf(id);
    expect(done.sign_in_id).toBe(mine.id);
    expect(done.completed_at).not.toBeNull();
    const second = await db.$transaction((tx) => createSignIn(tx, { userId: alice, method: 'email', passkeyId: null }));
    expect(await completePending(db, id, second.id)).toBe(false);
    expect((await rowOf(id)).sign_in_id).toBe(mine.id);
  });

  it('refuses to complete an expired flow', async () => {
    const { id } = await createPendingEmailSignIn(db, { userId: alice, continuation: PORTAL });
    await age(id, 601);
    const si = await db.$transaction((tx) => createSignIn(tx, { userId: alice, method: 'email', passkeyId: null }));
    expect(await completePending(db, id, si.id)).toBe(false);
    expect((await rowOf(id)).completed_at).toBeNull();
  });

  it('records the current ceremony, and two concurrent completions have exactly one winner', async () => {
    const { id } = await createPendingEmailSignIn(db, { userId: alice, continuation: PORTAL });
    await setPendingCeremony(db, id, 'ceremony-1');
    expect((await rowOf(id)).ceremony_id).toBe('ceremony-1');
    const a = await db.$transaction((tx) => createSignIn(tx, { userId: alice, method: 'email', passkeyId: null }));
    const b = await db.$transaction((tx) => createSignIn(tx, { userId: alice, method: 'email', passkeyId: null }));
    const results = await Promise.all([completePending(db, id, a.id), completePending(db, id, b.id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('sweeps rows older than the retention window and keeps recent ones', async () => {
    const old = await createPendingEmailSignIn(db, { userId: alice, continuation: PORTAL });
    const fresh = await createPendingEmailSignIn(db, { userId: alice, continuation: PORTAL });
    await age(old.id, 25 * 3600);
    await sweepPendingEmailSignIns(db);
    expect(await rowOf(old.id)).toBeUndefined();
    expect(await rowOf(fresh.id)).toBeDefined();
  });
});
