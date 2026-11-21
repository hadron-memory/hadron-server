/** #4546: verified ineligible proof records only its time; request remains open and the existing read gate stays exclusive. */
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import type { Prisma } from '../generated/prisma/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbNode, createDbOrgAndGraph } from '../test/helpers.js';
import { randomBytes } from 'node:crypto';
import { USER_API_KEY_PREFIX, hashUserApiKey } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { insertSoftPasskey, softPasskey, type SoftPasskey } from '../test/softPasskey.js';
import { upsertPlatformActions } from '../lib/grants/actions.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { createGrantSigningRequestInTransaction } from '../lib/signing/grantRequests.js';
import { recordGrantRefusalObservation } from '../lib/signing/grantRefusalObservation.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';
const REASON = 'Test a refused grant proof';

let server: Server | undefined;
let base: string;
let orgId: string;
let appId: string;
let entryNodeId: string;
let workerId: string;
let requester: { id: string };
let admin: { id: string; key: SoftPasskey };
let member: { id: string; key: SoftPasskey };

async function person(handle: string, role: 'ADMIN' | 'CONTRIBUTOR' | null) {
  const u = await db.user.create({ data: { handle, roles: [] } });
  if (role) await db.orgMember.create({ data: { organizationId: orgId, userId: u.id, role } });
  const key = softPasskey();
  await insertSoftPasskey(db, u.id, key, { label: `${handle} key` });
  return { id: u.id, key };
}

beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', RP);
  vi.stubEnv('SIGNING_CEREMONY_ORIGINS', ORIGIN);
  await upsertPlatformActions(db);
  const { org, graph } = await createDbOrgAndGraph(db, { orgName: 'gs-org', graphName: 'gs' });
  orgId = org.id;
  const app = await db.app.create({ data: { organizationId: orgId, name: 'gs-app', urn: `${org.urn}:gs-app` } });
  appId = app.id;
  const node = await createDbNode(db, { loc: 'flows:nightly', memoryId: graph.id, name: 'Nightly', content: 'x' });
  entryNodeId = node.id;
  const agent = await db.agent.create({ data: { organizationId: orgId, name: 'gs-agent', urn: `${org.urn}:gs-agent` } });
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name: 'gs-worker', slug: 'gs-worker' } });
  workerId = worker.id;
  requester = await db.user.create({ data: { handle: 'gs-requester', roles: [] } });
  admin = await person('gs-admin', 'ADMIN');
  member = await person('gs-member', 'CONTRIBUTOR');
  server = httpServer(await createServer());
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
  server = undefined;
  vi.unstubAllEnvs();
});

async function insertGrant(): Promise<string> {
  const id = generateId();
  await db.$executeRaw`INSERT INTO grants (id, app_id, worker_id, action, action_values, reason, max_uses, created_at, updated_at)
    VALUES (${id}, ${appId}, ${workerId}, 'schedule.create', ${JSON.stringify({ entryNode: entryNodeId })}::jsonb, ${REASON}, 3,
      (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'))`;
  return id;
}
const openRequest = (grantId: string) => db.$transaction((tx) => createGrantSigningRequestInTransaction(tx, grantId, {
  appId, requester: { userId: requester.id, appId: null, workerId: null, sessionId: null },
}));

const post = (id: string, path: string, body: unknown, cookie?: string, origin: string | null = ORIGIN) =>
  fetch(`${base}/grant-signing/${id}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });

function assertionBody(ceremonyId: string, key: SoftPasskey, a: ReturnType<SoftPasskey['assert']>) {
  return {
    ceremonyId, credentialId: key.credentialId.toString('base64url'),
    authenticatorData: a.authenticatorData.toString('base64url'),
    clientDataJson: a.clientDataJson.toString('base64url'), signature: a.signature.toString('base64url'),
  };
}

interface Proved { status: number; json: { outcome?: string; canSign?: boolean } | null; text: string }

async function prove(id: string, who: { key: SoftPasskey }, opts: { counter?: number } = {}): Promise<Proved> {
  const c = await post(id, 'proof/challenge', {});
  expect(c.status).toBe(200);
  const preCookie = (c.headers.get('set-cookie') ?? '').split(';')[0];
  const { ceremonyId, challenge } = await c.json() as { ceremonyId: string; challenge: string };
  const a = who.key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(challenge, 'base64url'), origin: ORIGIN, rpId: RP, counter: opts.counter ?? 1 });
  const r = await post(id, 'proof', assertionBody(ceremonyId, who.key, a), preCookie);
  const text = await r.text();
    let json: Proved['json'] = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, json, text };
}


async function read(id: string, userId: string) {
  const key = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { userId, oauthScopes: [], keyHash: hashUserApiKey(key), keyPreview: key.slice(-4) } });
  const r = await fetch(`${base}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: 'query($id:ID!){grantSigningRequest(id:$id){id state endedAt lastRefusedAt}}', variables: { id } }) });
  return r.json() as Promise<{ data?: { grantSigningRequest: { id: string; state: string; endedAt: string | null; lastRefusedAt: string | null } | null }; errors?: unknown[] }>;
}
const lastRefused = async (id: string) => (await db.grantSigningRequest.findUniqueOrThrow({ where: { id } })).lastRefusedAt;

describe('#4546 anonymous refused-proof observation', () => {
  it('records the refused proof time for existing readers, keeps OPEN, and preserves the exact bare 403', async () => {
    const req = await openRequest(await insertGrant());
    const [before] = await db.$queryRaw<Array<{ now: Date }>>`SELECT hadron_signing_now() AS now`;
    const p = await prove(req.id, member);
    expect(p.status).toBe(403);
    expect(p.text).toBe('{"error":"forbidden"}');
    expect(await lastRefused(req.id)).toBeInstanceOf(Date);
    const [after] = await db.$queryRaw<Array<{ now: Date }>>`SELECT hadron_signing_now() AS now`;
    expect((await lastRefused(req.id))!.getTime()).toBeGreaterThanOrEqual(before.now.getTime());
    expect((await lastRefused(req.id))!.getTime()).toBeLessThanOrEqual(after.now.getTime());
    const out = await read(req.id, admin.id);
    expect(out.errors).toBeUndefined();
    expect(out.data?.grantSigningRequest).toEqual({ id: req.id, state: 'OPEN', endedAt: null, lastRefusedAt: (await lastRefused(req.id))!.toISOString() });
    expect(await db.grantSignature.count()).toBe(0);
    expect(await db.passkeyCeremony.count({ where: { purpose: 'GRANT_SIGN' } })).toBe(0);
    expect((await db.grantSigningRequest.findUniqueOrThrow({ where: { id: req.id } })).state).toBe('open');
  });

  it('conceals the record from the refused person and other tenants just like an unknown request', async () => {
    const req = await openRequest(await insertGrant());
    await prove(req.id, member);
    expect(await lastRefused(req.id)).toBeInstanceOf(Date);
    const outsider = await person('outside', null);
    for (const who of [member, outsider]) {
      const found = await read(req.id, who.id);
      const missing = await read('A'.repeat(22), who.id);
      expect(found.errors).toBeUndefined();
      expect(found).toEqual(missing);
      expect(found.data?.grantSigningRequest).toBeNull();
    }
  });

  it('consumes known and unknown proofs identically; replaying a consumed assertion cannot change the recorded observation', async () => {
    const req = await openRequest(await insertGrant());
    for (const id of [req.id, 'A'.repeat(22)]) {
      const c = await post(id, 'proof/challenge', {});
      const cookie = (c.headers.get('set-cookie') ?? '').split(';')[0];
      const { ceremonyId, challenge } = await c.json() as { ceremonyId: string; challenge: string };
      const counter = id === req.id ? 1 : 2;
      const assertion = member.key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(challenge, 'base64url'), origin: ORIGIN, rpId: RP, counter });
      const body = assertionBody(ceremonyId, member.key, assertion);
      const response = await post(id, 'proof', body, cookie);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe('{"error":"forbidden"}');
      const proof = await db.passkeyCeremony.findUniqueOrThrow({ where: { id: ceremonyId } });
      expect(proof.consumedAt).toBeInstanceOf(Date);
      const rows = await db.$queryRaw<Array<{ counter: bigint }>>`SELECT counter FROM passkey_credentials WHERE owner_id = ${member.id}`;
      expect(Number(rows[0].counter)).toBe(counter);
      const observed = await lastRefused(req.id);
      expect(observed).toBeInstanceOf(Date);
      const replay = await post(id, 'proof', body, cookie);
      expect(replay.status).toBe(403);
      expect(await replay.text()).toBe('{"error":"forbidden"}');
      expect(await lastRefused(req.id)).toEqual(observed);
    }
  });

  it('an observation SQL failure cannot roll back the already-consumed valid proof', async () => {
    const req = await openRequest(await insertGrant());
    const original = db.$transaction.bind(db);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(db, '$transaction').mockImplementation((async (
      work: (tx: Prisma.TransactionClient) => Promise<unknown>,
      opts?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
    ) => original(async (tx) => {
      const wrapped = new Proxy(tx, { get(target, key, receiver) {
        if (key === '$executeRaw') return async (sql: TemplateStringsArray, ...values: unknown[]) => {
          if (sql.join(' ').includes('UPDATE grant_signing_requests SET last_refused_at')) {
            return target.$executeRawUnsafe('SELECT 1 / 0'); // real PostgreSQL transaction failure
          }
          return target.$executeRaw(sql, ...values);
        };
        return Reflect.get(target, key, receiver);
      } });
      return work(wrapped);
    }, opts)) as never);
    const p = await prove(req.id, member);
    expect(p.status).toBe(403);
    expect(p.text).toBe('{"error":"forbidden"}');
    const rows = await db.$queryRaw<Array<{ counter: bigint }>>`SELECT counter FROM passkey_credentials WHERE owner_id = ${member.id}`;
    expect(Number(rows[0].counter)).toBe(1);
    expect(await lastRefused(req.id)).toBeNull();
    expect(warn).toHaveBeenCalledWith('grant.signing.refusal_observation_failed');
  });

  it('a real grant-lock timeout loses only the optional observation and preserves the proof spend', async () => {
    const req = await openRequest(await insertGrant());
    const gate = new Client({ connectionString: process.env.DATABASE_URL });
    await gate.connect();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT id FROM grants WHERE id = $1 FOR UPDATE', [req.grantId]);
      const p = await prove(req.id, member); // the bounded observer times out while this independent lock remains held
      expect(p.status).toBe(403);
      expect(p.text).toBe('{"error":"forbidden"}');
      const rows = await db.$queryRaw<Array<{ counter: bigint }>>`SELECT counter FROM passkey_credentials WHERE owner_id = ${member.id}`;
      expect(Number(rows[0].counter)).toBe(1);
      expect(await lastRefused(req.id)).toBeNull();
      expect(warn).toHaveBeenCalledWith('grant.signing.refusal_observation_failed');
    } finally {
      await gate.query('ROLLBACK');
      await gate.end();
    }
  }, 10_000);

  it('a withdrawal while the observation waits cannot undo proof consumption or record a late observation', async () => {
    const req = await openRequest(await insertGrant());
    const gate = new Client({ connectionString: process.env.DATABASE_URL });
    await gate.connect();
    let pending: Promise<Proved> | undefined;
    let settled = false;
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT id FROM grants WHERE id = $1 FOR UPDATE', [req.grantId]);
      const { rows: [self] } = await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      pending = prove(req.id, member).finally(() => { settled = true; });
      let blocked = false;
      for (let n = 0; n < 100 && !settled; n++) {
        const [r] = await db.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE ${self.pid} = ANY(pg_blocking_pids(pid))
        ) AS blocked`;
        if (r.blocked) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(blocked, 'observation must take grant before request').toBe(true);
      // The grant wait happens only AFTER the proof transaction committed, with no prover anchor held.
      const counters = await db.$queryRaw<Array<{ counter: bigint }>>`SELECT counter FROM passkey_credentials WHERE owner_id = ${member.id}`;
      expect(Number(counters[0].counter)).toBe(1);
      await gate.query('SELECT id FROM users WHERE id = $1 FOR UPDATE NOWAIT', [member.id]);
      await gate.query("UPDATE grant_signing_requests SET state = 'withdrawn' WHERE id = $1", [req.id]);
      await gate.query('COMMIT');
      const p = await pending;
      expect(p.status).toBe(403);
      expect(p.text).toBe('{"error":"forbidden"}');
      expect(await lastRefused(req.id)).toBeNull();
      expect((await read(req.id, admin.id)).data?.grantSigningRequest?.state).toBe('WITHDRAWN');
    } finally {
      await gate.query('ROLLBACK');
      await pending?.catch(() => {});
      await gate.end();
    }
  });

  it('a second fresh refused proof advances the latest time, including a stranger with no membership', async () => {
    const req = await openRequest(await insertGrant());
    const first = await prove(req.id, member);
    expect(first.status).toBe(403);
    const previous = await lastRefused(req.id);
    expect(previous).toBeInstanceOf(Date);
    const next = await prove(req.id, member, { counter: 2 });
    expect(next.status).toBe(403);
    const nextObserved = await lastRefused(req.id);
    expect(nextObserved!.getTime()).toBeGreaterThan(previous!.getTime());
    const outsider = await person('proving-outsider', null);
    const second = await prove(req.id, outsider);
    expect(second.status).toBe(403);
    expect(second.text).toBe(first.text);
    const latest = await lastRefused(req.id);
    expect(latest!.getTime()).toBeGreaterThan(nextObserved!.getTime());
    // Delayed delivery of an older verified observation must not move the latest proof time backward.
    await recordGrantRefusalObservation(db, { requestId: req.id, grantId: req.grantId, attemptedAt: previous! });
    expect(await lastRefused(req.id)).toEqual(latest);
    expect((await read(req.id, outsider.id)).data?.grantSigningRequest).toBeNull();
    expect((await read(req.id, admin.id)).data?.grantSigningRequest?.state).toBe('OPEN');
  });

  it('preserves the proof UTC time when the observation transaction has a non-UTC session timezone', async () => {
    const req = await openRequest(await insertGrant());
    const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT hadron_signing_now() AS now`;
    const original = db.$transaction.bind(db);
    vi.spyOn(db, '$transaction').mockImplementation((async (
      work: (tx: Prisma.TransactionClient) => Promise<unknown>,
      opts?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
    ) => original(async (tx) => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'Pacific/Auckland'`;
      return work(tx);
    }, opts)) as never);
    await recordGrantRefusalObservation(db, { requestId: req.id, grantId: req.grantId, attemptedAt: now });
    expect(await lastRefused(req.id)).toEqual(now);
  });

  it('a lawful proof records no refusal and still opens signing', async () => {
    const req = await openRequest(await insertGrant());
    const p = await prove(req.id, admin);
    expect(p.status).toBe(200);
    expect(p.json?.canSign).toBe(true);
    expect(await lastRefused(req.id)).toBeNull();
  });

  it('malformed and unknown-request proofs disclose nothing and do not create an observation', async () => {
    const req = await openRequest(await insertGrant());
    const bad = await post(req.id, 'proof', {});
    expect(bad.status).toBe(403);
    expect(await bad.text()).toBe('{"error":"forbidden"}');
    const unknown = await prove('A'.repeat(22), member);
    expect(unknown.status).toBe(403);
    expect(unknown.text).toBe('{"error":"forbidden"}');
    expect(await lastRefused(req.id)).toBeNull();
  });

  it('a well-shaped assertion from the wrong origin records no refusal time', async () => {
    const req = await openRequest(await insertGrant());
    const c = await post(req.id, 'proof/challenge', {});
    const cookie = (c.headers.get('set-cookie') ?? '').split(';')[0];
    const { ceremonyId, challenge } = await c.json() as { ceremonyId: string; challenge: string };
    const assertion = member.key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(challenge, 'base64url'), origin: 'https://other.example.test', rpId: RP });
    const r = await post(req.id, 'proof', assertionBody(ceremonyId, member.key, assertion), cookie);
    expect(r.status).toBe(403);
    expect(await r.text()).toBe('{"error":"forbidden"}');
    expect(await lastRefused(req.id)).toBeNull();
    expect((await db.passkeyCeremony.findUniqueOrThrow({ where: { id: ceremonyId } })).consumedAt).toBeNull();
  });

  it('an effectively expired but still stored-open request cannot gain a refusal observation', async () => {
    const req = await openRequest(await insertGrant());
    const id = randomBytes(16).toString('base64url');
    await db.$executeRaw`INSERT INTO grant_signing_requests
      (id, grant_id, version, terms_hash, payload_version, requester_user_id, created_at, expires_at)
      SELECT ${id}, grant_id, version, terms_hash, payload_version, requester_user_id,
        hadron_signing_now(), hadron_signing_now() + interval '0.05 second'
      FROM grant_signing_requests WHERE id = ${req.id}`;
    for (let n = 0; n < 100; n++) {
      const [r] = await db.$queryRaw<Array<{ expired: boolean }>>`SELECT expires_at <= hadron_signing_now() AS expired FROM grant_signing_requests WHERE id = ${id}`;
      if (r.expired) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const [deadline] = await db.$queryRaw<Array<{ expired: boolean }>>`SELECT expires_at <= hadron_signing_now() AS expired FROM grant_signing_requests WHERE id = ${id}`;
    expect(deadline.expired).toBe(true);
    const p = await prove(id, member);
    expect(p.status).toBe(403);
    expect(p.text).toBe('{"error":"forbidden"}');
    expect(await lastRefused(id)).toBeNull();
    expect((await read(id, admin.id)).data?.grantSigningRequest?.state).toBe('EXPIRED');
  });

  it('a refused proof on an ended request cannot alter its history or state', async () => {
    const req = await openRequest(await insertGrant());
    await db.$executeRaw`UPDATE grant_signing_requests SET state = 'withdrawn' WHERE id = ${req.id}`;
    const before = await db.grantSigningRequest.findUniqueOrThrow({ where: { id: req.id } });
    const p = await prove(req.id, member);
    expect(p.status).toBe(403);
    expect(p.text).toBe('{"error":"forbidden"}');
    expect(await db.grantSigningRequest.findUniqueOrThrow({ where: { id: req.id } })).toEqual(before);
    expect(await lastRefused(req.id)).toBeNull();
    const rows = await db.$queryRaw<Array<{ counter: bigint }>>`SELECT counter FROM passkey_credentials WHERE owner_id = ${member.id}`;
    expect(Number(rows[0].counter)).toBe(1); // Refusal consumption must match an unknown request even when ended.
  });
});
