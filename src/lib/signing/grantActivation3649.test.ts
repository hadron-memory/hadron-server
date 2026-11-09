/**
 * #3649 slice C (cor:acl:140:07, :04; cor:acl:140:03): the database half of ACTIVATING a grant by its signature.
 *
 * - The grant guard allows the activation move exactly once, and only together with a signature record of THIS grant, at
 *   its version, by the person named as verifier, whose request completed. The signer becomes the issuer (cor:acl:140:04).
 *   `activated_at` is the database's clock, never the writer's.
 * - Activation ends every OTHER open request on the grant (slice B design choice 6), through the stale trigger.
 * - NP-2 (BLIND delta on #3802, carried here): a request whose insert waited on its grant keeps the lifetime its inserter
 *   asked for, re-based on the post-lock clock.
 * - §10 P3s carried from #3802 (Rodolfo): the record guard's pending-grant arm, the withdraw's expiry store, the withdraw's
 *   refusal order.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { insertSoftPasskey, softPasskey } from '../../test/softPasskey.js';
import { DB_NOW, dropTestActions, insertGrant, seedWorld, type World } from '../grants/grantFixtures3668.js';
import { newSigningRequestId } from './requests.js';
import {
  createGrantSigningRequestInTransaction, GrantSigningRefusal, withdrawGrantSigningRequestInTransaction,
} from './grantRequests.js';
import { signingRequestTtlSeconds } from './config.js';

const RP = 'localhost';
const V1 = 'hadron-grant-signature-v1';
const HASH = 'a'.repeat(64);
const exec = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);
const query = <T>(sql: string, ...params: unknown[]) => db.$queryRawUnsafe<T[]>(sql, ...params);
const refused = (p: Promise<unknown>, pattern: RegExp) => expect(p).rejects.toThrow(pattern);

let w: World;
beforeEach(async () => { await cleanDb(db); w = await seedWorld(); });
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

async function insertRequest(grantId: string, over: Record<string, unknown> = {}, expiresSql = `${DB_NOW} + interval '1 hour'`): Promise<string> {
  const v: Record<string, unknown> = {
    id: newSigningRequestId(), grant_id: grantId, version: 1, terms_hash: HASH, payload_version: V1, requester_user_id: w.userId, ...over,
  };
  const cols = Object.keys(v);
  await exec(`INSERT INTO grant_signing_requests (${cols.join(', ')}, expires_at)
    VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, ${expiresSql})`, ...cols.map((c) => v[c]));
  return v.id as string;
}

/** A record for `requestId` by `signer`'s own soft passkey (the user holder is w.userId). */
async function insertSignature(requestId: string, grantId: string, signer = w.user2Id): Promise<string> {
  const key = softPasskey();
  const passkeyId = await insertSoftPasskey(db, signer, key, { rpId: RP });
  const a = key.assert({ payload: Buffer.from('x'), origin: 'http://localhost', rpId: RP });
  const v: Record<string, unknown> = {
    id: generateId(), grant_id: grantId, signing_request_id: requestId, signer_id: signer, passkey_credential_id: passkeyId,
    version: 1, terms_hash: HASH, holder_kind: 'user', holder_id: w.userId, payload_version: V1, rp_id: RP,
    authenticator_data: a.authenticatorData, client_data_json: a.clientDataJson, signature: a.signature,
  };
  const cols = Object.keys(v);
  await exec(`INSERT INTO grant_signatures (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, ...cols.map((c) => v[c]));
  return v.id as string;
}

const complete = (requestId: string) => exec(`UPDATE grant_signing_requests SET state = 'completed' WHERE id = $1`, requestId);
const activate = (grantId: string, signatureId: string | null, signer: string | null = w.user2Id, kind: string | null = 'passkey') =>
  exec(`UPDATE grants SET activated_at = ${DB_NOW}, verification_kind = $2, verified_by = $3, signature_id = $4 WHERE id = $1`,
    grantId, kind, signer, signatureId);

/** A grant with one completed request and its record, ready to activate. */
async function signed(): Promise<{ g: string; r: string; s: string }> {
  const g = await insertGrant(w);
  const r = await insertRequest(g);
  const s = await insertSignature(r, g);
  await complete(r);
  return { g, r, s };
}

describe('the activation arm of the grant guard', () => {
  it('activates once with its own completed signature; the signer becomes the issuer; the time is the DB clock', async () => {
    const { g, s } = await signed();
    await exec(`UPDATE grants SET activated_at = '2001-01-01', verification_kind = 'passkey', verified_by = $2, signature_id = $3 WHERE id = $1`,
      g, w.user2Id, s);
    const [row] = await query<{ activated_at: Date; issuer_user_id: string | null; verified_by: string; signature_id: string }>(
      'SELECT activated_at, issuer_user_id, verified_by, signature_id FROM grants WHERE id = $1', g);
    expect(row.activated_at.getUTCFullYear()).toBeGreaterThan(2001);
    expect(row.issuer_user_id).toBe(w.user2Id);
    expect(row).toMatchObject({ verified_by: w.user2Id, signature_id: s });
  });

  it('refuses an activation with no signature, another grant\'s signature, another verifier, or another kind', async () => {
    const { g, s } = await signed();
    const other = await signed();
    await refused(activate(g, null), /append-only|activat/);
    await refused(activate(g, other.s), /append-only|activat/);
    await refused(activate(g, s, w.userId), /append-only|activat/);
    await refused(activate(g, s, w.user2Id, 'click'), /append-only|activat/);
    await refused(activate(g, s, null), /append-only|activat/);
  });

  it('refuses a signature whose request has not completed', async () => {
    const g = await insertGrant(w);
    const r = await insertRequest(g);
    const s = await insertSignature(r, g);
    await refused(activate(g, s), /append-only|activat/);
  });

  it('refuses a second activation, and any move of the activation columns afterwards', async () => {
    const { g, s } = await signed();
    await activate(g, s);
    await refused(exec(`UPDATE grants SET activated_at = ${DB_NOW} + interval '1 second' WHERE id = $1`, g), /append-only/);
    await refused(exec(`UPDATE grants SET verification_kind = 'other' WHERE id = $1`, g), /append-only/);
    await refused(exec(`UPDATE grants SET signature_id = NULL WHERE id = $1`, g), /append-only/);
    await refused(exec(`UPDATE grants SET activated_at = NULL WHERE id = $1`, g), /append-only/);
  });

  it('refuses activating a revoked grant', async () => {
    const { g, s } = await signed();
    await exec(`UPDATE grants SET revoked_at = ${DB_NOW}, revoked_by = 'someone' WHERE id = $1`, g);
    await refused(activate(g, s), /append-only|activat/);
  });
});

describe('activation ends the other open requests on the grant (slice B design choice 6)', () => {
  it('a second open request ends stale when the grant activates', async () => {
    const g = await insertGrant(w);
    const r1 = await insertRequest(g);
    const r2 = await insertRequest(g);
    const s = await insertSignature(r1, g);
    await complete(r1);
    await activate(g, s);
    const states = await query<{ id: string; state: string }>('SELECT id, state FROM grant_signing_requests WHERE grant_id = $1', g);
    expect(Object.fromEntries(states.map((x) => [x.id, x.state]))).toEqual({ [r1]: 'completed', [r2]: 'stale' });
  });

  it('§10 P3-1 (#3802): the record guard alone refuses a record on an ACTIVE grant whose other request is still open', async () => {
    const g = await insertGrant(w);
    const r1 = await insertRequest(g);
    const r2 = await insertRequest(g);
    const s = await insertSignature(r1, g);
    await complete(r1);
    // Keep r2 open past the activation, so the pending-grant arm is the only thing that can refuse its record.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grant_signing_stale');
      await tx.$executeRawUnsafe(`UPDATE grants SET activated_at = ${DB_NOW}, verification_kind = 'passkey', verified_by = $2, signature_id = $3 WHERE id = $1`,
        g, w.user2Id, s);
      await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grant_signing_stale');
    });
    expect((await query<{ state: string }>('SELECT state FROM grant_signing_requests WHERE id = $1', r2))[0].state).toBe('open');
    await refused(insertSignature(r2, g), /pending grant/);
  });
});

async function whileBlocking<T>(lockSql: string, params: unknown[], start: () => Promise<T>, holdMs: number): Promise<T> {
  const blocker = new Client({ connectionString: process.env.DATABASE_URL });
  await blocker.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query(lockSql, params);
    const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    const pending = start();
    pending.catch(() => undefined);
    let waited = false;
    for (let i = 0; i < 200 && !waited; i++) {
      await new Promise((res) => setTimeout(res, 25));
      const [{ n }] = await query<{ n: bigint }>(`SELECT count(*) AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))`, blockerPid);
      waited = Number(n) > 0;
    }
    expect(waited, 'the write under test waited on the blocker').toBe(true);
    await new Promise((res) => setTimeout(res, holdMs));
    await blocker.query('COMMIT');
    return await pending;
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    await blocker.end();
  }
}

describe('NP-2 (#3802 BLIND delta): a request keeps the lifetime it asked for across a lock wait', () => {
  it('an insert whose trigger waits on the grant keeps expires_at - created_at exactly as inserted', async () => {
    const g = await insertGrant(w);
    const id = newSigningRequestId();
    // One clock read for both times (as the module writes them), then the trigger's FOR SHARE on the grant waits.
    await whileBlocking('SELECT id FROM grants WHERE id = $1 FOR UPDATE', [g],
      () => exec(`WITH n AS (SELECT hadron_signing_now() AS t)
        INSERT INTO grant_signing_requests (id, grant_id, version, terms_hash, payload_version, requester_user_id, created_at, expires_at)
        SELECT $1, $2, 1, $3, $4, $5, n.t, n.t + interval '1 hour' FROM n`, id, g, HASH, V1, w.userId), 700);
    const [row] = await query<{ created_at: Date; expires_at: Date }>('SELECT created_at, expires_at FROM grant_signing_requests WHERE id = $1', id);
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(3_600_000);
  });

  it('control: created by the module (which locks the grant first): expires_at - created_at is exactly the TTL', async () => {
    const g = await insertGrant(w);
    const row = await whileBlocking('SELECT id FROM grants WHERE id = $1 FOR UPDATE', [g],
      () => db.$transaction((tx) => createGrantSigningRequestInTransaction(tx, g, {
        appId: w.appId, requester: { userId: w.userId, appId: null, workerId: null, sessionId: null },
      })), 700);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(signingRequestTtlSeconds() * 1000);
  });
});

describe('§10 P3s carried from #3802 (Rodolfo): withdraw', () => {
  const caller = () => ({ userId: w.userId, appId: null });
  it('P3-2: a withdraw past the deadline is SIGNING_REQUEST_ENDED / EXPIRED, never a raw 23514', async () => {
    const g = await insertGrant(w);
    const r = await insertRequest(g, {}, `${DB_NOW} + interval '200 milliseconds'`);
    await new Promise((res) => setTimeout(res, 400));
    const e = await db.$transaction((tx) => withdrawGrantSigningRequestInTransaction(tx, r, { appId: w.appId, caller: caller() }))
      .then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(GrantSigningRefusal);
    expect(e).toMatchObject({ code: 'SIGNING_REQUEST_ENDED', details: { state: 'EXPIRED' } });
  });

  it('P3-3: someone else\'s ended request is NOT_REQUESTER first, before ENDED', async () => {
    const g = await insertGrant(w);
    const r = await insertRequest(g);
    await exec(`UPDATE grant_signing_requests SET state = 'withdrawn' WHERE id = $1`, r);
    const e = await db.$transaction((tx) => withdrawGrantSigningRequestInTransaction(tx, r, { appId: w.appId, caller: { userId: w.user2Id, appId: null } }))
      .then(() => null, (x: unknown) => x);
    expect(e).toMatchObject({ code: 'SIGNING_REQUEST_NOT_REQUESTER' });
  });
});
