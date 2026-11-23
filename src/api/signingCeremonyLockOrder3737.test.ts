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
import { createHash } from 'node:crypto';
import { backendPid, deadline, waitBlocked as observeBlocked, within, type Deadline } from '../test/lockObserver.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';

let server: Server | undefined;
let base: string;
let observer: Client;
let gate: Client;
/** The gate connection's backend pid: the holder the first request is expected to wait on (#3748 item 3). */
let gatePid: number;
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

/** #3748 items 2 and 3: the expected waiter only (statement and blocker), on the pin's one deadline. */
const waitBlocked = (dl: Deadline, query: RegExp, blockedBy: number[]) => observeBlocked(observer, dl, { query, blockedBy });
const sha256Hex = (v: string) => createHash('sha256').update(v).digest('hex');
/** #3748 item 1: the live (unconsumed) SIGN ceremonies. */
const liveSignCeremonies = () => db.$queryRaw<Array<{ id: string; browser_nonce_hash: string }>>`
  SELECT id, browser_nonce_hash FROM passkey_ceremonies WHERE purpose = 'SIGN' AND consumed_at IS NULL`;
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
  gatePid = await backendPid(gate);
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
    const dl = deadline(20_000);
    await gate.query('BEGIN');
    await gate.query('SELECT id FROM nodes WHERE id = $1 FOR UPDATE', [nodeId]);
    const c = w.complete();
    const cWait = await waitBlocked(dl, /FROM "?nodes"? WHERE/, [gatePid]);
    const p = w.second.send();
    const pWait = await waitBlocked(dl, /pg_advisory_xact_lock/, [cWait.pid]);
    await gate.query('COMMIT');
    const [cr, pr] = await within(dl, 'proof/completion', Promise.all([c, p]));
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
    const dl = deadline(20_000);
    await gate.query('BEGIN');
    await gate.query('SELECT id FROM passkey_ceremonies WHERE id = $1 FOR UPDATE', [w.second.ceremonyId]);
    const p = w.second.send();
    const pWait = await waitBlocked(dl, /passkey_ceremonies/, [gatePid]);
    const c = w.complete();
    const cWait = await waitBlocked(dl, /pg_advisory_xact_lock/, [pWait.pid]);
    await gate.query('COMMIT');
    const [cr, pr] = await within(dl, 'proof/completion', Promise.all([c, p]));
    await new Promise((res) => setTimeout(res, 1700));
    expect(await deadlocks()).toBe(before);
    expect(cWait.blockers).toEqual([pWait.pid]);
    expect([pr.status, cr.status]).toEqual([200, 403]);
    expect(await cr.text()).toBe('{"error":"forbidden"}');
    expect(((await pr.json()) as { outcome: string }).outcome).toBe('open');
    expect(await state()).toEqual({ request: 'open', signatures: 0 });
    // #3748 item 1: exactly ONE fresh, unconsumed SIGN ceremony afterwards, not the retired one, under the cookie the
    // winning proof just set (its value is the new browser nonce; the ceremony stores its hash).
    const rotated = cookieOf(pr).split('=').slice(1).join('=');
    expect(rotated).not.toBe('');
    const live = await liveSignCeremonies();
    expect(live).toHaveLength(1);
    expect(live[0]!.id).not.toBe(w.signing.ceremonyId);
    expect(live[0]!.browser_nonce_hash).toBe(sha256Hex(decodeURIComponent(rotated)));
  }, 40_000);
});
