/**
 * #3737 — a same-browser proof and a completion of that browser's open signing ceremony took the SIGN ceremony row
 * and the passkey credential row in opposite order, so PostgreSQL could abort one with 40P01.
 *
 * These pins drive the REAL `proveForSigning` and `completeSigning` on two pool connections, in BOTH commit orders.
 * A third raw connection (the "gate") holds one row the first mover must wait on, so the interleave is staged by a
 * real lock wait rather than by timing: the other function is then started, observed blocked through
 * `pg_stat_activity` / `pg_blocking_pids` (bounded poll), and only then is the gate released.
 *
 *   completion first:  gate holds the node row; completion holds its SIGN row and waits on the node; the proof starts.
 *   proof first:       gate holds the SIGN_PROOF row; the proof holds the credential and waits on it; completion starts.
 *
 * Whatever the order, the result must be one lawful outcome, no 40P01, and an unchanged database-wide deadlock count
 * (the test database is private to this worker, so no unrelated session can move it).
 */
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbNode, createDbOrgAndGraph } from '../../test/helpers.js';
import { insertSoftPasskey, softPasskey, type SoftPasskey } from '../../test/softPasskey.js';
import { createSigningRequestInTransaction, SigningRefusal } from './requests.js';
import { CeremonyRefused, completeSigning, openProofCeremony, proofChallenge, proveForSigning } from './signingCeremony.js';
import { signatureChallenge, signaturePayloadBytes } from './payload.js';
import { clearSignatureVerifyCache } from './verify.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();
const sha256Hex = (b: Buffer | string) => sha256(b).toString('hex');

interface World {
  requestId: string; nodeId: string; key: SoftPasskey; userId: string;
  /** The browser value the signing ceremony is bound to (the rotated cookie), hashed. */
  browserHash: string; signCeremonyId: string; signingChallenge: Buffer;
}

async function seed(): Promise<World> {
  const { org, graph } = await createDbOrgAndGraph(db, { orgName: 'lo-org', graphName: 'lo' });
  const requester = await db.user.create({ data: { handle: 'lo-requester', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: requester.id, role: 'CONTRIBUTOR' } });
  const user = await db.user.create({ data: { handle: 'lo-signer', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'CONTRIBUTOR' } });
  const key = softPasskey();
  await insertSoftPasskey(db, user.id, key, { label: 'lo key' });
  const node = await createDbNode(db, { loc: 'policies:lo', memoryId: graph.id, name: 'Lock order', content: 'Body.\n' });
  const req = await db.$transaction((tx) => createSigningRequestInTransaction(tx, node.id, {
    memoryId: graph.id, requester: { userId: requester.id, appId: null, workerId: null, sessionId: null }, mayWrite: async () => true,
  }));
  // A first proof (counter 1) mints the one signing ceremony, bound to a fresh browser value.
  const pre = sha256Hex('lo-pre-proof-cookie');
  const proved = await proofWith(req.id, key, pre, 1);
  expect(proved.outcome).toBe('open');
  const sessionNonce = (proved as { sessionNonce?: string }).sessionNonce!;
  const browserHash = sha256Hex(sessionNonce);
  const [cer] = await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM passkey_ceremonies WHERE purpose = 'SIGN' AND consumed_at IS NULL`;
  const signingChallenge = signatureChallenge(signaturePayloadBytes(req.payloadVersion, { nodeId: node.id, approvalHash: req.approvalHash, requestId: req.id }));
  return { requestId: req.id, nodeId: node.id, key, userId: user.id, browserHash, signCeremonyId: cer.id, signingChallenge };
}

/** Open a proof ceremony for `browserHash` and answer it with `key` at `counter`; returns the prepared call. */
async function prepareProof(requestId: string, key: SoftPasskey, browserHash: string, counter: number) {
  const { ceremonyId, challenge } = await openProofCeremony(db, { requestId, browserNonceHash: browserHash });
  const a = key.assert({ payload: Buffer.alloc(0), rawChallenge: proofChallenge(requestId, ceremonyId), origin: ORIGIN, rpId: RP, counter });
  void challenge;
  return {
    ceremonyId,
    run: () => proveForSigning(db, { requestId, ceremonyId, browserNonceHash: browserHash, credentialId: key.credentialId, assertion: a, rpId: RP, origins: [ORIGIN] }),
  };
}
async function proofWith(requestId: string, key: SoftPasskey, browserHash: string, counter: number) {
  return (await prepareProof(requestId, key, browserHash, counter)).run();
}

let observer: Client;
let gate: Client;

beforeEach(async () => {
  await cleanDb(db);
  clearSignatureVerifyCache();
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', RP);
  vi.stubEnv('SIGNING_CEREMONY_ORIGINS', ORIGIN);
  observer = new Client({ connectionString: process.env.DATABASE_URL });
  gate = new Client({ connectionString: process.env.DATABASE_URL });
  await observer.connect();
  await gate.connect();
  await observer.query(`SET statement_timeout = '10s'`);
  await gate.query(`SET statement_timeout = '30s'`);
  await gate.query(`SET lock_timeout = '30s'`);
});

afterEach(async () => {
  await gate.query('ROLLBACK').catch(() => undefined);
  await gate.end().catch(() => undefined);
  await observer.end().catch(() => undefined);
  vi.unstubAllEnvs();
});

interface Waiting { pid: number; query: string; blockers: number[] }

/** Bounded poll: a backend (not in `exclude`) waiting on a lock. */
async function waitBlocked(exclude: number[] = []): Promise<Waiting> {
  const deadline = Date.now() + 8000;
  for (;;) {
    await observer.query('SELECT pg_stat_clear_snapshot()');
    const r = await observer.query<{ pid: number; query: string; blockers: number[] }>(
      `SELECT pid, query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`);
    const hit = r.rows.find((x) => !exclude.includes(x.pid));
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error('no backend ever blocked on a lock');
    await new Promise((res) => setTimeout(res, 25));
  }
}

const deadlocks = async () => {
  await observer.query('SELECT pg_stat_clear_snapshot()');
  return Number((await observer.query(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`)).rows[0].deadlocks);
};

const isDeadlock = (e: unknown) => /deadlock detected|40P01/i.test(String((e as { message?: string })?.message ?? e)
  + String(JSON.stringify((e as { meta?: unknown })?.meta ?? '')));

async function state(w: World) {
  const [req] = await db.$queryRaw<Array<{ state: string }>>`SELECT state FROM signing_requests WHERE id = ${w.requestId}`;
  const sigs = await db.nodeSignature.count({ where: { nodeId: w.nodeId } });
  const [cred] = await db.$queryRaw<Array<{ counter: bigint }>>`SELECT counter FROM passkey_credentials WHERE owner_id = ${w.userId}`;
  const [old] = await db.$queryRaw<Array<{ consumed: boolean }>>`SELECT consumed_at IS NOT NULL AS consumed FROM passkey_ceremonies WHERE id = ${w.signCeremonyId}`;
  return { request: req.state, signatures: sigs, counter: Number(cred.counter), oldSignConsumed: old.consumed };
}

function completion(w: World, counter: number) {
  const a = w.key.assert({ payload: Buffer.alloc(0), rawChallenge: w.signingChallenge, origin: ORIGIN, rpId: RP, counter });
  return () => completeSigning(db, { requestId: w.requestId, ceremonyId: w.signCeremonyId, browserNonceHash: w.browserHash, credentialId: w.key.credentialId, assertion: a });
}

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));
}

describe('#3737 proof vs completion lock order (real functions, two connections)', () => {
  it('completion first: the proof waits on the signer anchor, then is refused; one signature, request completed, no deadlock', async () => {
    const w = await seed();
    const proof = await prepareProof(w.requestId, w.key, w.browserHash, 2);
    const before = await deadlocks();

    // The gate holds the node row, so completion parks right after it has spent its SIGN ceremony.
    await gate.query('BEGIN');
    await gate.query('SELECT id FROM nodes WHERE id = $1 FOR UPDATE', [w.nodeId]);
    const c = settle(completion(w, 3)());
    const cWait = await waitBlocked();
    expect(cWait.query).toMatch(/FROM nodes WHERE id/);

    const p = settle(proof.run());
    const pWait = await waitBlocked([cWait.pid]);
    await gate.query('COMMIT');
    const [cr, pr] = await Promise.all([c, p]);
    await new Promise((res) => setTimeout(res, 1700));

    // No transaction was aborted as a deadlock victim, and the database-wide count did not move.
    for (const r of [cr, pr]) if (!r.ok) expect(isDeadlock(r.error), `a deadlock victim: ${String((r.error as Error)?.message)}`).toBe(false);
    expect(await deadlocks()).toBe(before);
    // The intended wait: the proof sits on the signer's user anchor, held by the completion.
    expect(pWait.query).toMatch(/pg_advisory_xact_lock/);
    expect(pWait.blockers).toEqual([cWait.pid]);
    // One lawful outcome: completion won; the proof is the typed refusal.
    expect(cr.ok).toBe(true);
    expect(!pr.ok && pr.error instanceof CeremonyRefused).toBe(true);
    expect(await state(w)).toEqual({ request: 'completed', signatures: 1, counter: 3, oldSignConsumed: true });
  }, 40_000);

  it('proof first: completion waits on the signer anchor, then is refused without a signature; request stays open, no deadlock', async () => {
    const w = await seed();
    const proof = await prepareProof(w.requestId, w.key, w.browserHash, 2);
    const before = await deadlocks();

    // The gate holds the proof ceremony row, so the proof parks holding the credential (and, once fixed, the anchor).
    await gate.query('BEGIN');
    await gate.query('SELECT id FROM passkey_ceremonies WHERE id = $1 FOR UPDATE', [proof.ceremonyId]);
    const p = settle(proof.run());
    const pWait = await waitBlocked();
    expect(pWait.query).toMatch(/passkey_ceremonies WHERE id/);

    const c = settle(completion(w, 3)());
    const cWait = await waitBlocked([pWait.pid]);
    await gate.query('COMMIT');
    const [cr, pr] = await Promise.all([c, p]);
    await new Promise((res) => setTimeout(res, 1700));

    for (const r of [cr, pr]) if (!r.ok) expect(isDeadlock(r.error), `a deadlock victim: ${String((r.error as Error)?.message)}`).toBe(false);
    expect(await deadlocks()).toBe(before);
    expect(cWait.query).toMatch(/pg_advisory_xact_lock/);
    expect(cWait.blockers).toEqual([pWait.pid]);
    // One lawful outcome: the proof retired the old ceremony and minted a new one; the completion is the typed refusal.
    expect(pr.ok && pr.value.outcome === 'open').toBe(true);
    expect(!cr.ok && cr.error instanceof CeremonyRefused).toBe(true);
    expect(await state(w)).toEqual({ request: 'open', signatures: 0, counter: 2, oldSignConsumed: true });
  }, 40_000);
  it('a signer id read before the anchor authorizes nothing: a ceremony spent while the completion waits is refused', async () => {
    const w = await seed();
    const before = await state(w);
    // The gate holds the SIGNER's user anchor (the same advisory key the proof and the completion take).
    await gate.query('BEGIN');
    await gate.query(`SELECT pg_advisory_xact_lock(hashtext('authorization:user'), hashtext($1))`, [w.userId]);
    const c = settle(completion(w, 3)());
    const cWait = await waitBlocked();
    expect(cWait.query).toMatch(/pg_advisory_xact_lock/);
    // While it waits, the ceremony it pre-read is spent (a binding to another user is blocked by the DB's bound-once
    // trigger, so the user-equality re-check after the lock is defense in depth that cannot be staged).
    await gate.query(`UPDATE passkey_ceremonies SET consumed_at = (clock_timestamp() AT TIME ZONE 'UTC') WHERE id = $1`, [w.signCeremonyId]);
    await gate.query('COMMIT');
    const cr = await c;
    expect(!cr.ok && cr.error instanceof CeremonyRefused, 'completion must re-judge the ceremony under the anchor').toBe(true);
    const after = await state(w);
    expect(after).toEqual({ ...before, oldSignConsumed: true });
    expect(after.signatures).toBe(0);
  }, 40_000);

  it('completion locks only the signer\'s own credential: another person\'s credential row is never waited on', async () => {
    const w = await seed();
    const { org } = { org: await db.orgMember.findFirstOrThrow({ where: { userId: w.userId } }) };
    const bob = await db.user.create({ data: { handle: 'lo-bob', roles: [] } });
    await db.orgMember.create({ data: { organizationId: org.organizationId, userId: bob.id, role: 'CONTRIBUTOR' } });
    const bobKey = softPasskey();
    await insertSoftPasskey(db, bob.id, bobKey, { label: 'bob key' });
    // Bob's proof is, in effect, holding his credential row.
    await gate.query('BEGIN');
    await gate.query('SELECT id FROM passkey_credentials WHERE owner_id = $1 FOR UPDATE', [bob.id]);
    const a = bobKey.assert({ payload: Buffer.alloc(0), rawChallenge: w.signingChallenge, origin: ORIGIN, rpId: RP, counter: 3 });
    const run = settle(completeSigning(db, {
      requestId: w.requestId, ceremonyId: w.signCeremonyId, browserNonceHash: w.browserHash, credentialId: bobKey.credentialId, assertion: a,
    }));
    const outcome = await Promise.race([run, new Promise<'waited'>((res) => setTimeout(() => res('waited'), 4000))]);
    await gate.query('COMMIT');
    expect(outcome, 'completion with a foreign credential waited on that credential\'s row lock').not.toBe('waited');
    const r = outcome as Awaited<typeof run>;
    expect(!r.ok && r.error instanceof SigningRefusal && r.error.code === 'SIGNATURE_NOT_VERIFIED').toBe(true);
    expect((await state(w)).signatures).toBe(0);
  }, 40_000);
});
