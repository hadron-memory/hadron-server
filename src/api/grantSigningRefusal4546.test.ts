/** #4546: verified ineligible proof records only its time; request remains open and the existing read gate stays exclusive. */
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbNode, createDbOrgAndGraph, createDbPersonalMemory } from '../test/helpers.js';
import { randomBytes } from 'node:crypto';
import { USER_API_KEY_PREFIX, hashUserApiKey } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { insertSoftPasskey, softPasskey, type SoftPasskey } from '../test/softPasskey.js';
import { upsertPlatformActions } from '../lib/grants/actions.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { createGrantSigningRequestInTransaction } from '../lib/signing/grantRequests.js';
import { createSigningRequestInTransaction } from '../lib/signing/requests.js';
import { switchCapabilities } from '../lib/signing/surface.js';
import * as grantLocks from '../lib/signing/grantActivationLocks.js';
import * as issuers from '../lib/grants/issuers.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';
const REASON = 'Run the nightly <b>report</b> & mail it';

let server: Server | undefined;
let base: string;
let orgId: string;
let appId: string;
let appUrn: string;
let memoryId: string;
let entryNodeId: string;
let entryNodeUrn: string;
let workerId: string;
let requester: { id: string };
let admin: { id: string; key: SoftPasskey; passkeyId: string };
let member: { id: string; key: SoftPasskey };
let fresh: { id: string; key: SoftPasskey; passkeyId: string };

async function person(handle: string, role: 'ADMIN' | 'CONTRIBUTOR' | null, opts: { firstWindow?: boolean } = {}) {
  const u = await db.user.create({ data: { handle, roles: [] } });
  if (role) await db.orgMember.create({ data: { organizationId: orgId, userId: u.id, role } });
  const key = softPasskey();
  const passkeyId = await insertSoftPasskey(db, u.id, key, { label: `${handle} key`, firstWindow: opts.firstWindow });
  return { id: u.id, key, passkeyId };
}

beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', RP);
  vi.stubEnv('SIGNING_CEREMONY_ORIGINS', ORIGIN);
  await upsertPlatformActions(db);
  const { org, graph } = await createDbOrgAndGraph(db, { orgName: 'gs-org', graphName: 'gs' });
  orgId = org.id;
  memoryId = graph.id;
  const app = await db.app.create({ data: { organizationId: orgId, name: 'gs-app', urn: `${org.urn}:gs-app` } });
  appId = app.id;
  appUrn = `hrn:app:${app.urn}`;
  const node = await createDbNode(db, { loc: 'flows:nightly', memoryId, name: 'Nightly', content: 'x' });
  entryNodeId = node.id;
  const mem = await db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { urn: true } });
  entryNodeUrn = `hrn:node:${mem.urn}:flows:nightly`;
  const agent = await db.agent.create({ data: { organizationId: orgId, name: 'gs-agent', urn: `${org.urn}:gs-agent` } });
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name: 'gs-worker', slug: 'gs-worker' } });
  workerId = worker.id;
  requester = await db.user.create({ data: { handle: 'gs-requester', roles: [] } });
  admin = await person('gs-admin', 'ADMIN');
  member = await person('gs-member', 'CONTRIBUTOR');
  fresh = await person('gs-fresh', 'ADMIN', { firstWindow: true });
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
  return insertGrantFor(appId, { workerId });
}
/** #3730: the same pending grant shape, for an App and holder the default fixture does not cover (a user-owned App, a user holder). */
async function insertGrantFor(aId: string, holder: { workerId: string; userId?: never } | { userId: string; workerId?: never }): Promise<string> {
  const id = generateId();
  await db.$executeRawUnsafe(`INSERT INTO grants (id, app_id, ${holder.userId !== undefined ? 'user_id' : 'worker_id'}, action, action_values, reason, max_uses, created_at, updated_at)
    VALUES ($1, $2, $3, 'schedule.create', $4::jsonb, $5, 3, (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'))`,
  id, aId, holder.userId ?? holder.workerId, JSON.stringify({ entryNode: entryNodeId }), REASON);
  return id;
}
const openRequest = (grantId: string) => openRequestFor(grantId, appId);
const openRequestFor = (grantId: string, aId: string) => db.$transaction((tx) => createGrantSigningRequestInTransaction(tx, grantId, {
  appId: aId, requester: { userId: requester.id, appId: null, workerId: null, sessionId: null },
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface Proved { cookie: string; status: number; json: any; text: string }

async function prove(id: string, who: { key: SoftPasskey }, opts: { cookie?: string; counter?: number } = {}): Promise<Proved> {
  const c = await post(id, 'proof/challenge', {}, opts.cookie);
  expect(c.status).toBe(200);
  const preCookie = (c.headers.get('set-cookie') ?? '').split(';')[0] || (opts.cookie ?? '');
  const { ceremonyId, challenge } = await c.json() as { ceremonyId: string; challenge: string };
  const a = who.key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(challenge, 'base64url'), origin: ORIGIN, rpId: RP, counter: opts.counter ?? 1 });
  const r = await post(id, 'proof', assertionBody(ceremonyId, who.key, a), preCookie);
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0] || preCookie;
  const text = await r.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  if (json?.outcome === 'open' && json.canSign) {
    const s = await post(id, 'challenge', {}, cookie);
    json.signing = s.status === 200 ? await s.json() : null;
  }
  return { cookie, status: r.status, json, text };
}


async function read(id: string, userId: string) {
  const key = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { userId, oauthScopes: [], keyHash: hashUserApiKey(key), keyPreview: key.slice(-4) } });
  const r = await fetch(`${base}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: 'query($id:ID!){grantSigningRequest(id:$id){id state endedAt lastRefusedAt}}', variables: { id } }) });
  return r.json() as Promise<{ data?: { grantSigningRequest: { id: string; state: string; endedAt: string | null; lastRefusedAt: string | null } | null }; errors?: unknown[] }>;
}
const lastRefused = async (id: string) => (await db.grantSigningRequest.findUniqueOrThrow({ where: { id } }) as unknown as { lastRefusedAt?: Date | null }).lastRefusedAt ?? null;

describe('#4546 anonymous refused-proof observation', () => {
  it('records the refused proof time for existing readers, keeps OPEN, and preserves the exact bare 403', async () => {
    const req = await openRequest(await insertGrant());
    const p = await prove(req.id, member);
    expect(p.status).toBe(403);
    expect(p.text).toBe('{"error":"forbidden"}');
    expect(await lastRefused(req.id)).toBeInstanceOf(Date);
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

  it('a lawful proof records no refusal and still opens signing', async () => {
    const req = await openRequest(await insertGrant());
    const p = await prove(req.id, admin);
    expect(p.status).toBe(200);
    expect(p.json.canSign).toBe(true);
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

  it('a refused proof on an ended request cannot alter its history or state', async () => {
    const req = await openRequest(await insertGrant());
    await db.$executeRaw`UPDATE grant_signing_requests SET state = 'withdrawn' WHERE id = ${req.id}`;
    const before = await db.grantSigningRequest.findUniqueOrThrow({ where: { id: req.id } });
    const p = await prove(req.id, member);
    expect(p.status).toBe(403);
    expect(p.text).toBe('{"error":"forbidden"}');
    expect(await db.grantSigningRequest.findUniqueOrThrow({ where: { id: req.id } })).toEqual(before);
    expect(await lastRefused(req.id)).toBeNull();
  });
});
