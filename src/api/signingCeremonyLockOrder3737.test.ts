/**
 * #3737 — the same proof-vs-completion lock-order race, through the real HTTP routes (`POST /signing/:id/proof` and
 * `POST /signing/:id/complete`) against a real database and a software passkey. The assertion verification is the
 * real WebAuthn verifier over a SOFTWARE authenticator (`softPasskey`): no hardware or production authenticator is
 * claimed. Each interleave is staged exactly as in `src/lib/signing/ceremonyLockOrder3737.test.ts`: a raw "gate"
 * connection holds one row, the second request is observed blocked through `pg_blocking_pids`, then the gate releases.
 *
 * Contract: the loser gets the route's existing handled refusal (403 `{"error":"forbidden"}`), never a 5xx; the winner
 * answers 200; the database records no deadlock.
 */
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbNode, createDbOrgAndGraph } from '../test/helpers.js';
import { insertSoftPasskey, softPasskey, type SoftPasskey } from '../test/softPasskey.js';
import { createSigningRequestInTransaction } from '../lib/signing/requests.js';
import { clearSignatureVerifyCache } from '../lib/signing/verify.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';

let server: Server | undefined;
let base: string;
let observer: Client;
let gate: Client;
let requestId: string;
let nodeId: string;
let key: SoftPasskey;

const post = (path: string, body: unknown, cookie?: string) => fetch(`${base}/signing/${requestId}/${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body ?? {}),
});
const bodyOf = (ceremonyId: string, a: ReturnType<SoftPasskey['assert']>) => ({
  ceremonyId, credentialId: key.credentialId.toString('base64url'),
  authenticatorData: a.authenticatorData.toString('base64url'),
  clientDataJson: a.clientDataJson.toString('base64url'), signature: a.signature.toString('base64url'),
});
const cookieOf = (r: Response, fallback = '') => (r.headers.get('set-cookie') ?? '').split(';')[0] || fallback;

/** Open a proof ceremony (for the browser holding `cookie`) and build, but do not send, the proof request. */
async function prepareProof(cookie: string | undefined, counter: number) {
  const c = await post('proof/challenge', {}, cookie);
  expect(c.status).toBe(200);
  const pre = cookieOf(c);
  const { ceremonyId, challenge } = await c.json() as { ceremonyId: string; challenge: string };
  const a = key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(challenge, 'base64url'), origin: ORIGIN, rpId: RP, counter });
  return { ceremonyId, pre, send: () => post('proof', bodyOf(ceremonyId, a), pre) };
}

async function seed() {
  // First proof (counter 1): mints the one signing ceremony and rotates the browser cookie.
  const first = await prepareProof(undefined, 1);
  const r = await first.send();
  expect(r.status).toBe(200);
  const cookie = cookieOf(r, first.pre);
  const ch = await post('challenge', {}, cookie);
  expect(ch.status).toBe(200);
  const signing = await ch.json() as { ceremonyId: string; challenge: string };
  const second = await prepareProof(cookie, 2);
  const a = key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(signing.challenge, 'base64url'), origin: ORIGIN, rpId: RP, counter: 3 });
  return { cookie, signing, second, complete: () => post('complete', bodyOf(signing.ceremonyId, a), cookie) };
}

async function waitBlocked(exclude: number[] = []) {
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
async function state() {
  const [req] = await db.$queryRaw<Array<{ state: string }>>`SELECT state FROM signing_requests WHERE id = ${requestId}`;
  return { request: req.state, signatures: await db.nodeSignature.count({ where: { nodeId } }) };
}

beforeEach(async () => {
  await cleanDb(db);
  clearSignatureVerifyCache();
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', RP);
  vi.stubEnv('SIGNING_CEREMONY_ORIGINS', ORIGIN);
  const { org, graph } = await createDbOrgAndGraph(db, { orgName: 'lor-org', graphName: 'lor' });
  const requester = await db.user.create({ data: { handle: 'lor-requester', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: requester.id, role: 'CONTRIBUTOR' } });
  const user = await db.user.create({ data: { handle: 'lor-signer', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'CONTRIBUTOR' } });
  key = softPasskey();
  await insertSoftPasskey(db, user.id, key, { label: 'lor key' });
  nodeId = (await createDbNode(db, { loc: 'policies:lor', memoryId: graph.id, name: 'Lock order route', content: 'Body.\n' })).id;
  requestId = (await db.$transaction((tx) => createSigningRequestInTransaction(tx, nodeId, {
    memoryId: graph.id, requester: { userId: requester.id, appId: null, workerId: null, sessionId: null }, mayWrite: async () => true,
  }))).id;
  server = httpServer(await createServer());
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
  if (server) await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
  server = undefined;
  vi.unstubAllEnvs();
});

describe('#3737 proof vs completion over the real routes (software passkey; no hardware authenticator claimed)', () => {
  it('completion first: /complete answers 200, the racing /proof is the handled 403 refusal, one signature, no deadlock', async () => {
    const w = await seed();
    const before = await deadlocks();
    await gate.query('BEGIN');
    await gate.query('SELECT id FROM nodes WHERE id = $1 FOR UPDATE', [nodeId]);
    const c = w.complete();
    const cWait = await waitBlocked();
    const p = w.second.send();
    const pWait = await waitBlocked([cWait.pid]);
    await gate.query('COMMIT');
    const [cr, pr] = await Promise.all([c, p]);
    await new Promise((res) => setTimeout(res, 1700));
    expect(await deadlocks()).toBe(before);
    expect(pWait.blockers).toEqual([cWait.pid]);
    expect([cr.status, pr.status]).toEqual([200, 403]);
    expect(await pr.text()).toBe('{"error":"forbidden"}');
    expect(await state()).toEqual({ request: 'completed', signatures: 1 });
  }, 40_000);

  it('proof first: /proof answers 200 with a new ceremony, the racing /complete is the handled 403 refusal, request stays open, no deadlock', async () => {
    const w = await seed();
    const before = await deadlocks();
    await gate.query('BEGIN');
    await gate.query('SELECT id FROM passkey_ceremonies WHERE id = $1 FOR UPDATE', [w.second.ceremonyId]);
    const p = w.second.send();
    const pWait = await waitBlocked();
    const c = w.complete();
    const cWait = await waitBlocked([pWait.pid]);
    await gate.query('COMMIT');
    const [cr, pr] = await Promise.all([c, p]);
    await new Promise((res) => setTimeout(res, 1700));
    expect(await deadlocks()).toBe(before);
    expect(cWait.blockers).toEqual([pWait.pid]);
    expect([pr.status, cr.status]).toEqual([200, 403]);
    expect(await cr.text()).toBe('{"error":"forbidden"}');
    expect(((await pr.json()) as { outcome: string }).outcome).toBe('open');
    expect(await state()).toEqual({ request: 'open', signatures: 0 });
  }, 40_000);
});
