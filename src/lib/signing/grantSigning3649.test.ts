/**
 * #3649 slice B (cor:acl:140:07, :09; the node-signing mirror cor:dmo:130:03): the database half of grant signing requests and
 * grant signature records, pinned against the guards directly with raw SQL (D1-D4), plus the request lifecycle module's
 * refusals and lock order. Grant rows come from the S1a fixtures (no production grant writer exists; gate selection 2).
 */
import { readFileSync } from 'fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { insertSoftPasskey, softPasskey } from '../../test/softPasskey.js';
import { DB_NOW, dropTestActions, insertGrant, insertGrantUnguarded, raw, seedWorld, type World } from '../grants/grantFixtures3668.js';
import { grantTermsFromRow, grantTermsHash } from '../grants/terms.js';
import { newSigningRequestId } from './requests.js';
import {
  createGrantSigningRequestInTransaction, GrantSigningRefusal, withdrawGrantSigningRequestInTransaction,
} from './grantRequests.js';

const RP = 'localhost';
const V1 = 'hadron-grant-signature-v1';
const HASH = 'a'.repeat(64);
const exec = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);
const query = <T>(sql: string, ...params: unknown[]) => db.$queryRawUnsafe<T[]>(sql, ...params);
const refused = (p: Promise<unknown>, pattern: RegExp) => expect(p).rejects.toThrow(pattern);

let w: World;
beforeEach(async () => { await cleanDb(db); w = await seedWorld(); });
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

async function versionOf(grantId: string): Promise<number> {
  return (await query<{ version: number }>('SELECT version FROM grants WHERE id = $1', grantId))[0].version;
}

/** A request inserted straight into the table (the guard runs; the module does not). `expiresSql` is its deadline (DB clock). */
async function insertRequest(grantId: string, over: Record<string, unknown> = {}, expiresSql = `${DB_NOW} + interval '1 hour'`): Promise<string> {
  const v: Record<string, unknown> = {
    id: newSigningRequestId(), grant_id: grantId, version: 1, terms_hash: HASH, payload_version: V1,
    requester_user_id: w.userId, ...over,
  };
  const cols = Object.keys(v);
  await exec(`INSERT INTO grant_signing_requests (${cols.join(', ')}, expires_at)
    VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, ${expiresSql})`, ...cols.map((c) => v[c]));
  return v.id as string;
}

async function stateOf(requestId: string): Promise<{ state: string; ended_at: Date | null; expires_at: Date }> {
  return (await query<{ state: string; ended_at: Date | null; expires_at: Date }>(
    'SELECT state, ended_at, expires_at FROM grant_signing_requests WHERE id = $1', requestId))[0];
}

/** A signature row for `requestId`, the signer's own soft passkey, shaped to pass the CHECK unless overridden. */
async function insertSignature(requestId: string, grantId: string, over: Record<string, unknown> = {}): Promise<string> {
  const key = softPasskey();
  const passkeyId = (over.passkey_credential_id as string | undefined) ?? await insertSoftPasskey(db, w.userId, key, { rpId: RP });
  const a = key.assert({ payload: Buffer.from('x'), origin: 'http://localhost', rpId: RP });
  const v: Record<string, unknown> = {
    id: generateId(), grant_id: grantId, signing_request_id: requestId, signer_id: w.userId, passkey_credential_id: passkeyId,
    version: 1, terms_hash: HASH, holder_kind: 'user', holder_id: w.userId, payload_version: V1, rp_id: RP,
    authenticator_data: a.authenticatorData, client_data_json: a.clientDataJson, signature: a.signature, ...over,
  };
  const cols = Object.keys(v);
  await exec(`INSERT INTO grant_signatures (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, ...cols.map((c) => v[c]));
  return v.id as string;
}

describe('prisma/grant-signing-invariants.sql parity', () => {
  it('the newest migration to carry it (20261110010200_grant_signing_rebase) ends with a byte-identical copy, and post-push includes the file after the grant guard', () => {
    const sql = readFileSync(new URL('../../../prisma/grant-signing-invariants.sql', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../../../prisma/migrations/20261110010200_grant_signing_rebase/migration.sql', import.meta.url), 'utf8');
    expect(migration.endsWith(sql)).toBe(true);
    const postPush = readFileSync(new URL('../../../prisma/post-push.sql', import.meta.url), 'utf8');
    expect(postPush.indexOf('\\ir grant-signing-invariants.sql')).toBeGreaterThan(postPush.indexOf('\\ir grant-invariants.sql'));
  });
});

describe('D2: shape CHECKs cannot pass on NULL', () => {
  it('a request needs a requester account: user or App, and NULL/NULL is refused', async () => {
    const g = await insertGrant(w);
    await refused(insertRequest(g, { requester_user_id: null }), /chk_grant_signing_request_shape/);
    await refused(insertRequest(g, { requester_user_id: '' }), /chk_grant_signing_request_shape/);
    expect(await insertRequest(g, { requester_user_id: null, requester_app_id: w.appId })).toBeTruthy();
    expect(await insertRequest(g)).toBeTruthy();
  });

  it('a request id is 22 base64url characters, the payload version is the grant one, and the terms hash is 64 lowercase hex', async () => {
    const g = await insertGrant(w);
    await refused(insertRequest(g, { id: 'short' }), /chk_grant_signing_request_shape/);
    await refused(insertRequest(g, { payload_version: 'hadron-signature-v3' }), /chk_grant_signing_request_shape/);
    await refused(insertRequest(g, { terms_hash: 'A'.repeat(64) }), /chk_grant_signing_request_shape/);
    await refused(insertRequest(g, { version: 0 }), /chk_grant_signing_request_shape|pending grant/);
  });

  it('a record\'s holder kind is one of the four and its RP ID hash matches its authenticator data', async () => {
    const g = await insertGrant(w);
    const r = await insertRequest(g);
    await refused(insertSignature(r, g, { holder_kind: 'org' }), /chk_grant_signature_shape|name the grant's holder/);
    await refused(insertSignature(r, g, { holder_kind: null }), /null value|chk_grant_signature_shape|name the grant's holder/);
    await refused(insertSignature(r, g, { rp_id: 'example.com' }), /chk_grant_signature_shape/);
    await refused(insertSignature(r, g, { holder_id: '' }), /chk_grant_signature_shape|name the grant's holder/);
  });
});

describe('D1: requests begin open on a pending grant, keep their pins and end exactly once', () => {
  it('a request begins open, at the grant\'s current version, on a grant that is pending', async () => {
    const g = await insertGrant(w);
    await refused(insertRequest(g, { state: 'completed' }), /begins open/);
    await refused(insertRequest(g, { version: 2 }), /pending grant at its current version/);
    const revoked = await insertGrantUnguarded(w, { revoked_at: raw(DB_NOW), revoked_by: 'someone' });
    const active = await insertGrantUnguarded(w, { activated_at: raw(DB_NOW), verification_kind: 'TEST', verified_by: 'test' });
    const departed = await insertGrantUnguarded(w, { holder_departed_at: raw(DB_NOW) });
    for (const id of [revoked, active, departed]) await refused(insertRequest(id), /pending grant/);
    const id = await insertRequest(g);
    const row = await stateOf(id);
    expect(row.state).toBe('open');
    expect(row.ended_at).toBeNull();
  });

  it('pinned fields are immutable, and a second end is refused', async () => {
    const g = await insertGrant(w);
    const id = await insertRequest(g);
    for (const set of ["version = 2", `terms_hash = '${'b'.repeat(64)}'`, "requester_user_id = 'someone'", "requester_worker_id = 'w'",
      "expires_at = expires_at + interval '1 hour'", "created_at = created_at - interval '1 hour'", `grant_id = '${await insertGrant(w)}'`]) {
      await refused(exec(`UPDATE grant_signing_requests SET ${set} WHERE id = $1`, id), /immutable/);
    }
    await exec(`UPDATE grant_signing_requests SET state = 'withdrawn' WHERE id = $1`, id);
    expect((await stateOf(id)).ended_at).not.toBeNull();
    await refused(exec(`UPDATE grant_signing_requests SET state = 'declined' WHERE id = $1`, id), /ends exactly once/);
    await refused(exec(`UPDATE grant_signing_requests SET state = 'open', ended_at = NULL WHERE id = $1`, id), /ends exactly once/);
  });

  it('completes only with its record, and expires only once its lifetime has passed', async () => {
    const g = await insertGrant(w);
    const id = await insertRequest(g);
    await refused(exec(`UPDATE grant_signing_requests SET state = 'completed' WHERE id = $1`, id), /only with its signature record/);
    await refused(exec(`UPDATE grant_signing_requests SET state = 'expired' WHERE id = $1`, id), /only once its lifetime has passed/);
  });

  it('a request and a record are deleted only with their grant: refused while it exists, cascaded with the App', async () => {
    const g = await insertGrant(w);
    const r = await insertRequest(g);
    const s = await insertSignature(r, g);
    await refused(exec('DELETE FROM grant_signing_requests WHERE id = $1', r), /kept for the grant's lifetime/);
    await refused(exec('DELETE FROM grant_signatures WHERE id = $1', s), /never deleted/);
    await exec('DELETE FROM apps WHERE id = $1', w.appId);
    expect(await query('SELECT 1 FROM grant_signing_requests WHERE id = $1', r)).toHaveLength(0);
    expect(await query('SELECT 1 FROM grant_signatures WHERE id = $1', s)).toHaveLength(0);
  });
});

describe('D1: signature records are insert-only against an open request whose pins they repeat', () => {
  it('records exactly what the request pinned, on a pending grant at that version, naming its holder', async () => {
    const g = await insertGrant(w);
    const r = await insertRequest(g);
    await refused(insertSignature(r, g, { version: 2 }), /exactly what its request pinned/);
    await refused(insertSignature(r, g, { terms_hash: 'b'.repeat(64) }), /exactly what its request pinned/);
    await refused(insertSignature(r, await insertGrant(w), {}), /exactly what its request pinned/);
    await refused(insertSignature(r, g, { holder_kind: 'agent', holder_id: w.agentId }), /name the grant's holder/);
    await refused(insertSignature(r, g, { holder_id: w.user2Id }), /name the grant's holder/);
    expect(await insertSignature(r, g)).toBeTruthy();
    // One record per request.
    await refused(insertSignature(r, g), /open signing request|already exists/);
  });

  it('needs an open request: an ended one is refused', async () => {
    const g = await insertGrant(w);
    const r = await insertRequest(g);
    await exec(`UPDATE grant_signing_requests SET state = 'withdrawn' WHERE id = $1`, r);
    await refused(insertSignature(r, g), /open signing request/);
  });

  it('needs the signer\'s OWN unrevoked passkey', async () => {
    const g = await insertGrant(w);
    const r = await insertRequest(g);
    const others = await insertSoftPasskey(db, w.user2Id, softPasskey(), { rpId: RP });
    await refused(insertSignature(r, g, { passkey_credential_id: others }), /own unrevoked passkey/);
    const mine = await insertSoftPasskey(db, w.userId, softPasskey(), { rpId: RP });
    await exec(`UPDATE passkey_credentials SET revoked_at = ${DB_NOW} WHERE id = $1`, mine);
    await refused(insertSignature(r, g, { passkey_credential_id: mine }), /own unrevoked passkey/);
  });

  it('never updates: a plain UPDATE and an INSERT ... ON CONFLICT DO UPDATE rewrite are both refused', async () => {
    const g = await insertGrant(w);
    const r = await insertRequest(g);
    const s = await insertSignature(r, g);
    await refused(exec(`UPDATE grant_signatures SET signer_id = 'someone' WHERE id = $1`, s), /append-only/);
    await refused(exec(`INSERT INTO grant_signatures (id, grant_id, signing_request_id, signer_id, passkey_credential_id, version, terms_hash,
        holder_kind, holder_id, payload_version, rp_id, authenticator_data, client_data_json, signature)
      SELECT id, grant_id, signing_request_id, signer_id, passkey_credential_id, version, terms_hash, holder_kind, holder_id,
        payload_version, rp_id, authenticator_data, client_data_json, signature FROM grant_signatures WHERE id = $1
      ON CONFLICT (id) DO UPDATE SET signer_id = 'someone'`, s), /append-only|open signing request/);
    expect((await query<{ signer_id: string }>('SELECT signer_id FROM grant_signatures WHERE id = $1', s))[0].signer_id).toBe(w.userId);
  });
});

/** Holds `lockSql` in its own transaction until a statement on this connection waits on it, then runs `whileHeld`. */
async function whileBlocking<T>(lockSql: string, params: unknown[], start: () => Promise<T>, whileHeld: (blocker: Client) => Promise<void>): Promise<T> {
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
    await whileHeld(blocker);
    await blocker.query('COMMIT');
    return await pending;
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    await blocker.end();
  }
}

describe('D1: the guards read the DB clock after their locks, not before (#3802 LOCAL F1)', () => {
  it('a record whose insert waited on its request past the deadline is refused', async () => {
    const g = await insertGrant(w);
    const r = await insertRequest(g, {}, `${DB_NOW} + interval '2 seconds'`);
    const outcome = whileBlocking('SELECT id FROM grant_signing_requests WHERE id = $1 FOR UPDATE', [r],
      () => insertSignature(r, g).then(() => 'inserted', (e: Error) => e.message),
      async (blocker) => {
        // Release only once the DB clock is past the request's deadline.
        for (let i = 0; i < 200; i++) {
          const { rows } = await blocker.query(`SELECT ${DB_NOW} > expires_at AS past FROM grant_signing_requests WHERE id = $1`, [r]);
          if (rows[0].past) return;
          await new Promise((res) => setTimeout(res, 50));
        }
        throw new Error('deadline never passed');
      });
    expect(await outcome).toMatch(/open signing request/);
    expect(await query('SELECT 1 FROM grant_signatures WHERE signing_request_id = $1', r)).toHaveLength(0);
  });

  it('control: the same wait before a far deadline still records', async () => {
    const g = await insertGrant(w);
    const r = await insertRequest(g);
    const outcome = whileBlocking('SELECT id FROM grant_signing_requests WHERE id = $1 FOR UPDATE', [r],
      () => insertSignature(r, g).then(() => 'inserted', (e: Error) => e.message),
      async () => { await new Promise((res) => setTimeout(res, 300)); });
    expect(await outcome).toBe('inserted');
  });

  it('a request whose insert waited on its grant is stamped created_at after the wait', async () => {
    const g = await insertGrant(w);
    let released: Date | null = null;
    const id = await whileBlocking('SELECT id FROM grants WHERE id = $1 FOR UPDATE', [g],
      () => insertRequest(g),
      async (blocker) => {
        await new Promise((res) => setTimeout(res, 300));
        released = (await blocker.query(`SELECT ${DB_NOW} AS t`)).rows[0].t as Date;
      });
    const [{ created_at }] = await query<{ created_at: Date }>('SELECT created_at FROM grant_signing_requests WHERE id = $1', id);
    expect(created_at.getTime()).toBeGreaterThanOrEqual(released!.getTime());
  });
});

describe('D3: an open request ends stale when its grant is revoked, its holder goes, or its terms move', () => {
  it('a revocation ends it stale', async () => {
    const g = await insertGrant(w);
    const r = await insertRequest(g);
    await exec(`UPDATE grants SET revoked_at = ${DB_NOW}, revoked_by = 'someone' WHERE id = $1`, g);
    expect((await stateOf(r)).state).toBe('stale');
  });

  it('the holder going ends it stale (a hard delete of a worker holder fires the departure trigger)', async () => {
    const g = await insertGrant(w, { user_id: null, worker_id: w.workerId });
    const r = await insertRequest(g);
    await exec('DELETE FROM sessions WHERE worker_id = $1', w.workerId);
    await exec('DELETE FROM workers WHERE id = $1', w.workerId);
    expect((await stateOf(r)).state).toBe('stale');
  });

  it('a recorded user merge that moves the holder link ends it stale (the signed holder would no longer match)', async () => {
    const g = await insertGrant(w);
    const r = await insertRequest(g);
    await exec('INSERT INTO user_merges (source_user_id, target_user_id) VALUES ($1, $2)', w.userId, w.user2Id);
    await exec('UPDATE grants SET user_id = $2 WHERE id = $1', g, w.user2Id);
    expect((await stateOf(r)).state).toBe('stale');
  });

  it('a write that moves none of those leaves it open, and an already-ended request is not touched', async () => {
    const g = await insertGrant(w, { issuer_user_id: w.user2Id });
    const open = await insertRequest(g);
    const ended = await insertRequest(g);
    await exec(`UPDATE grant_signing_requests SET state = 'withdrawn' WHERE id = $1`, ended);
    await exec(`UPDATE users SET deleted_at = ${DB_NOW} WHERE id = $1`, w.user2Id);
    await exec('UPDATE grants SET issuer_user_id = NULL WHERE id = $1', g); // the erased issuer's link: no terms move
    expect((await stateOf(open)).state).toBe('open');
    await exec(`UPDATE grants SET revoked_at = ${DB_NOW}, revoked_by = 'someone' WHERE id = $1`, g);
    expect((await stateOf(open)).state).toBe('stale');
    expect((await stateOf(ended)).state).toBe('withdrawn');
  });

  it('a stale end that races the deadline is an expiry at the deadline', async () => {
    const g = await insertGrant(w);
    const r = await insertRequest(g, {}, `${DB_NOW} + interval '300 milliseconds'`);
    await new Promise((res) => setTimeout(res, 450));
    await exec(`UPDATE grants SET revoked_at = ${DB_NOW}, revoked_by = 'someone' WHERE id = $1`, g);
    const row = await stateOf(r);
    expect(row.state).toBe('expired');
    expect(row.ended_at?.getTime()).toBe(row.expires_at.getTime());
    // The guard's own arm, reached directly: a stale end written past the deadline is stored as the expiry at the deadline,
    // and a person's end past it is refused.
    const direct = await insertRequest(await insertGrant(w), {}, `${DB_NOW} + interval '300 milliseconds'`);
    const person = await insertRequest((await query<{ grant_id: string }>('SELECT grant_id FROM grant_signing_requests WHERE id = $1', direct))[0].grant_id, {}, `${DB_NOW} + interval '300 milliseconds'`);
    await new Promise((res) => setTimeout(res, 450));
    await exec(`UPDATE grant_signing_requests SET state = 'stale' WHERE id = $1`, direct);
    const d = await stateOf(direct);
    expect(d.state).toBe('expired');
    expect(d.ended_at?.getTime()).toBe(d.expires_at.getTime());
    await refused(exec(`UPDATE grant_signing_requests SET state = 'withdrawn' WHERE id = $1`, person), /cannot end any other way/);
  });
});

describe('D4: the #1162 fence covers the requester worker and session', () => {
  it('a request naming a worker or a session that does not exist is refused by the fence', async () => {
    const g = await insertGrant(w);
    await refused(insertRequest(g, { requester_worker_id: 'no-such-worker' }), /worker reference to an identity that no longer exists/);
    await refused(insertRequest(g, { requester_session_id: 'no-such-session' }), /reference to an identity that no longer exists/);
    expect(await insertRequest(g, { requester_worker_id: w.workerId, requester_session_id: w.sessionId })).toBeTruthy();
  });

  it('a retained requester stamp is not re-checked: the request still ends after its worker and session are gone (#3802 BLIND)', async () => {
    const g = await insertGrant(w);
    const r = await insertRequest(g, { requester_worker_id: w.workerId, requester_session_id: w.sessionId });
    await exec('DELETE FROM sessions WHERE worker_id = $1', w.workerId);
    await exec('DELETE FROM workers WHERE id = $1', w.workerId);
    await exec(`UPDATE grant_signing_requests SET state = 'withdrawn' WHERE id = $1`, r);
    expect((await stateOf(r)).state).toBe('withdrawn');
    // The fence still refuses a NEW dangling stamp.
    await refused(insertRequest(g, { requester_worker_id: w.workerId }), /worker reference to an identity that no longer exists/);
  });
});

describe('the request module: typed refusals before any write, the pins it records, withdrawal', () => {
  const requester = () => ({ userId: w.userId, appId: null, workerId: w.workerId, sessionId: w.sessionId });
  const create = (grantId: string, appId = w.appId) =>
    db.$transaction((tx) => createGrantSigningRequestInTransaction(tx, grantId, { appId, requester: requester() }));
  const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e instanceof GrantSigningRefusal ? e.code : String(e); } return 'NO_ERROR'; };
  const count = async () => Number((await query<{ n: bigint }>('SELECT count(*) AS n FROM grant_signing_requests'))[0].n);

  it('pins the grant\'s version and its cor:acl:140:09 terms hash, and records the requester', async () => {
    const g = await insertGrant(w, { action_values: { entryNode: 'n1' }, reason: 'to run the nightly job' });
    const row = await create(g);
    const grant = await db.grant.findUniqueOrThrow({ where: { id: g } });
    expect(row).toMatchObject({ grantId: g, version: await versionOf(g), payloadVersion: V1, state: 'open', requesterUserId: w.userId,
      requesterAppId: null, requesterWorkerId: w.workerId, requesterSessionId: w.sessionId });
    expect(row.termsHash).toBe(grantTermsHash(grantTermsFromRow(grant)));
    expect(row.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('refuses, writing nothing: another App\'s grant, a missing one, one not pending, one past its expiry, unwritable terms', async () => {
    const pending = await insertGrant(w);
    const revoked = await insertGrantUnguarded(w, { revoked_at: raw(DB_NOW), revoked_by: 'someone' });
    const active = await insertGrantUnguarded(w, { activated_at: raw(DB_NOW), verification_kind: 'TEST', verified_by: 'test' });
    const departed = await insertGrantUnguarded(w, { holder_departed_at: raw(DB_NOW) });
    const expired = await insertGrantUnguarded(w, { expires_at: raw(`${DB_NOW} - interval '1 minute'`) });
    const badTerms = await insertGrant(w, { action_values: { entryNode: 7 } });
    expect(await code(create(pending, w.app2Id))).toBe('GRANT_NOT_FOUND');
    expect(await code(create(generateId()))).toBe('GRANT_NOT_FOUND');
    for (const id of [revoked, active, departed]) expect(await code(create(id))).toBe('GRANT_NOT_PENDING');
    expect(await code(create(expired))).toBe('GRANT_EXPIRED');
    expect(await code(create(badTerms))).toBe('GRANT_TERMS_UNREPRESENTABLE');
    expect(await count()).toBe(0);
  });

  it('a not-yet-started pending grant may be asked for (signing before the start is allowed, ruling 0255 item 16)', async () => {
    const g = await insertGrant(w, { starts_at: raw(`${DB_NOW} + interval '1 day'`) });
    expect((await create(g)).state).toBe('open');
  });

  it('withdraw: only the requester account, once; another account and an ended request are refused', async () => {
    const g = await insertGrant(w);
    const r = await create(g);
    const withdraw = (caller: { userId: string | null; appId: string | null }, appId = w.appId) =>
      db.$transaction((tx) => withdrawGrantSigningRequestInTransaction(tx, r.id, { appId, caller }));
    expect(await code(withdraw({ userId: w.user2Id, appId: null }))).toBe('SIGNING_REQUEST_NOT_REQUESTER');
    expect(await code(withdraw({ userId: null, appId: w.appId }))).toBe('SIGNING_REQUEST_NOT_REQUESTER');
    expect(await code(withdraw({ userId: w.userId, appId: null }, w.app2Id))).toBe('SIGNING_REQUEST_NOT_FOUND');
    expect((await withdraw({ userId: w.userId, appId: null })).state).toBe('withdrawn');
    expect(await code(withdraw({ userId: w.userId, appId: null }))).toBe('SIGNING_REQUEST_ENDED');
  });

  it('lock order: a create waits on the grant row a revoker holds, then is refused GRANT_NOT_PENDING (judged after the lock)', async () => {
    const g = await insertGrant(w);
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`UPDATE grants SET revoked_at = ${DB_NOW}, revoked_by = 'someone' WHERE id = $1`, [g]);
      const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      const pending = code(create(g));
      let waited = false;
      for (let i = 0; i < 200 && !waited; i++) {
        await new Promise((res) => setTimeout(res, 25));
        const [{ n }] = await query<{ n: bigint }>(`SELECT count(*) AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))`, blockerPid);
        waited = Number(n) > 0;
      }
      expect(waited).toBe(true);
      await blocker.query('COMMIT');
      expect(await pending).toBe('GRANT_NOT_PENDING');
      expect(await count()).toBe(0);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end();
    }
  });
});
