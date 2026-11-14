/**
 * #3649 slice C (cor:acl:140:07, :04; cor:acl:140:03; ruling 0257): the grant signing ceremony and activation, over the real
 * HTTP transport against a real database and a software passkey.
 *
 *   GET  /grant-signing/:id                 a static shell, the same for every id
 *   POST /grant-signing/:id/proof/challenge opens a GRANT_SIGN_PROOF ceremony (the same answer for every id)
 *   POST /grant-signing/:id/proof           a passkey assertion: the prover must be able to ISSUE the grant; then the terms
 *   POST /grant-signing/:id/challenge       reads back the GRANT_SIGN ceremony's challenge (the grant payload's SHA-256)
 *   POST /grant-signing/:id/complete        the signing assertion; ONE transaction: record, request completed, grant ACTIVE
 *   POST /grant-signing/:id/decline         the proven issuer turns the request down
 */
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbNode, createDbOrgAndGraph, createDbPersonalMemory } from '../test/helpers.js';
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
  const id = generateId();
  await db.$executeRawUnsafe(`INSERT INTO grants (id, app_id, worker_id, action, action_values, reason, max_uses, created_at, updated_at)
    VALUES ($1, $2, $3, 'schedule.create', $4::jsonb, $5, 3, (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'))`,
  id, appId, workerId, JSON.stringify({ entryNode: entryNodeId }), REASON);
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

function signingBody(p: Proved, who: { key: SoftPasskey }, counter = 2) {
  const key = who.key;
  const s = p.json.signing as { ceremonyId: string; challenge: string };
  const a = key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(s.challenge, 'base64url'), origin: ORIGIN, rpId: RP, counter });
  return assertionBody(s.ceremonyId, key, a);
}

const FORBIDDEN = '{"error":"forbidden"}';
const grantRow = (id: string) => db.$queryRawUnsafe<Array<{
  activated_at: Date | null; verification_kind: string | null; verified_by: string | null; issuer_user_id: string | null; signature_id: string | null;
  revoked_at: Date | null; holder_departed_at: Date | null;
}>>('SELECT activated_at, verification_kind, verified_by, issuer_user_id, signature_id, revoked_at, holder_departed_at FROM grants WHERE id = $1', id).then((r) => r[0]);
const requestState = (id: string) => db.grantSigningRequest.findUniqueOrThrow({ where: { id }, select: { state: true } }).then((r) => r.state);
// The highest counter over the person's passkeys: one key reads as before, and with two (the RP ID pin) a write to either shows.
const counterOf = (userId: string) => db.$queryRawUnsafe<Array<{ counter: bigint }>>('SELECT max(counter) AS counter FROM passkey_credentials WHERE owner_id = $1', userId).then((r) => Number(r[0].counter));
const records = (grantId: string) => db.grantSignature.count({ where: { grantId } });
const activateEvents = (grantId: string) => db.grantEvent.count({ where: { grantId, action: 'ACTIVATE' } });
/**
 * Wait until the DATABASE clock is past the grant's expiry (Gloria P3, #3805 delta): the expiry tests give setup a wide margin
 * and then wait on the clock the completion reads, instead of a fixed 1.7 s sleep a slow runner could outrun.
 */
async function waitPastExpiry(grantId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [{ left }] = await db.$queryRawUnsafe<Array<{ left: number }>>(
      `SELECT (EXTRACT(EPOCH FROM (expires_at - (clock_timestamp() AT TIME ZONE 'UTC'))) * 1000)::float8 AS left FROM grants WHERE id = $1`, grantId);
    if (Number(left) < 0) return;
    await new Promise((res) => setTimeout(res, Math.min(Number(left) + 25, 1000)));
  }
  throw new Error('the grant never expired');
}
const unconsumedGrantSign = (userId: string) => db.$queryRawUnsafe<Array<{ n: bigint }>>(
  `SELECT count(*) AS n FROM passkey_ceremonies WHERE purpose = 'GRANT_SIGN' AND user_id = $1 AND consumed_at IS NULL`, userId).then((r) => Number(r[0].n));

describe('C10: behind the signing switch; the grant-signing capability token', () => {
  it('off: every route is an ordinary 404 and the token is absent', async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', '');
    server = httpServer(await createServer());
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await fetch(`${base}/grant-signing/abc`)).status).toBe(404);
    expect((await post('abc', 'proof/challenge', {})).status).toBe(404);
    expect(switchCapabilities({ signing: false, registration: false })).not.toContain('grant-signing');
  });

  it('on: the token is reported, and the shell is the same bytes for every id', async () => {
    expect(switchCapabilities({ signing: true, registration: false })).toContain('grant-signing');
    const a = await fetch(`${base}/grant-signing/aaaaaaaaaaaaaaaaaaaaaa`);
    const b = await fetch(`${base}/grant-signing/bbbbbbbbbbbbbbbbbbbbbb`);
    expect(a.status).toBe(200);
    expect(await a.text()).toBe(await b.text());
  });

  it('the page script builds the page with text nodes only (the terms and reason are escaped by construction)', async () => {
    const js = await (await fetch(`${base}/grant-signing/ceremony.js`)).text();
    expect(js.length).toBeGreaterThan(100);
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

describe('C9 + C5: the proof shows the server-built terms only to someone who may issue the grant', () => {
  it('an issuer sees the summary, the reason labelled as the requester\'s, and may sign', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, admin);
    expect(p.status).toBe(200);
    expect(p.json.outcome).toBe('open');
    expect(p.json.canSign).toBe(true);
    expect(p.json.view.summary).toBe(`Create a schedule in ${appUrn} that starts at the entry node ${entryNodeUrn}`);
    expect(p.json.view.requesterReason).toBe(REASON);
    expect(p.json.view.app.urn).toBe(appUrn);
    expect(p.json.view.maxUses).toBe(3);
    expect(p.json.signing.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  // The reason is the words of whoever asked for the GRANT. The account that later asks for its signature (a manager, from the
  // grants list) is a different one, and the page must not name it as the author of the reason.
  it('the reason is attributed to who asked for the grant, not to who asked for the signature', async () => {
    const author = await db.user.create({ data: { handle: 'gs-reason-author', roles: [] } });
    const g = generateId();
    await db.$executeRawUnsafe(`INSERT INTO grants (id, app_id, worker_id, requested_by_user_id, requested_by_worker_id, action, action_values, reason, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $3, 'schedule.create', $5::jsonb, $6, (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'))`,
    g, appId, workerId, author.id, JSON.stringify({ entryNode: entryNodeId }), REASON);
    const p = await prove((await openRequest(g)).id, admin);
    expect(p.json.outcome).toBe('open');
    expect(p.json.view.requesterReason).toBe(REASON);
    expect(p.json.view.reasonAuthor).toEqual({ name: 'gs-reason-author', via: 'gs-worker' });
    expect(p.json.view.requester).toEqual({ name: 'gs-requester', via: null });
  });

  it('a grant with no requester link (an erased requester) names no author', async () => {
    const p = await prove((await openRequest(await insertGrant())).id, admin);
    expect(p.json.view.reasonAuthor).toEqual({ name: null, via: null });
  });

  it('a grant naming several nodes shows each as its URN and may be signed', async () => {
    const second = await createDbNode(db, { loc: 'flows:weekly', memoryId, name: 'Weekly', content: 'x' });
    const g = generateId();
    await db.$executeRawUnsafe(`INSERT INTO grants (id, app_id, worker_id, action, action_values, reason, created_at, updated_at)
      VALUES ($1, $2, $3, 'schedule.create', $4::jsonb, $5, (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'))`,
    g, appId, workerId, JSON.stringify({ entryNode: [entryNodeId, second.id] }), REASON);
    const p = await prove((await openRequest(g)).id, admin);
    expect(p.json.outcome).toBe('open');
    expect(p.json.canSign).toBe(true);
    expect(p.json.view.summary).toBe(`Create a schedule in ${appUrn} that starts at the entry node ${entryNodeUrn}, ${entryNodeUrn.replace(/nightly$/, 'weekly')}`);
  });

  // Rodolfo §10 P3-1 (#3805): the proof's data-exposure guards. A grant naming a node the prover cannot read shows no summary,
  // offers no signing, names no URN of that node, and mints no GRANT_SIGN ceremony.
  async function grantOnUnreadableNode(): Promise<{ grantId: string; nodeId: string; nodeUrnPart: string }> {
    const agent = await db.agent.create({ data: { organizationId: orgId, name: 'gs-hidden-agent', urn: `${orgId}:gs-hidden-agent` } });
    const mem = await createDbPersonalMemory(db, { userId: requester.id, organizationId: orgId, agentId: agent.id, appId, name: 'gs-hidden' });
    const node = await createDbNode(db, { loc: 'flows:secret-flow', memoryId: mem.id, name: 'Secret', content: 'x' });
    const grantId = generateId();
    await db.$executeRawUnsafe(`INSERT INTO grants (id, app_id, worker_id, action, action_values, reason, max_uses, created_at, updated_at)
      VALUES ($1, $2, $3, 'schedule.create', $4::jsonb, $5, 3, (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'))`,
    grantId, appId, workerId, JSON.stringify({ entryNode: node.id }), REASON);
    return { grantId, nodeId: node.id, nodeUrnPart: 'secret-flow' };
  }

  it('Rodolfo P3-1: a node the issuer cannot read: summary null, canSign false, no URN, no signing ceremony minted', async () => {
    const { grantId, nodeId, nodeUrnPart } = await grantOnUnreadableNode();
    const req = await openRequest(grantId);
    const p = await prove(req.id, admin);
    expect(p.status).toBe(200);
    expect(p.json.outcome).toBe('open');
    expect(p.json.view.summary).toBeNull();
    expect(p.json.canSign).toBe(false);
    expect(p.text).not.toContain(nodeUrnPart);
    expect(p.text).not.toContain(nodeId);
    expect(p.text).not.toContain('gs-hidden');
    expect(await unconsumedGrantSign(admin.id)).toBe(0);
  });

  it('Rodolfo P3-2: a later proof that cannot sign retires this browser\'s earlier signing ceremony', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const first = await prove(req.id, admin);
    expect(first.json.canSign).toBe(true);
    expect(await unconsumedGrantSign(admin.id)).toBe(1);
    // The node the grant names is gone, so the next proof in the SAME browser cannot build the terms.
    await db.node.update({ where: { id: entryNodeId }, data: { deletedAt: new Date() } });
    const second = await prove(req.id, admin, { cookie: first.cookie, counter: 2 });
    expect(second.json.canSign).toBe(false);
    expect(await unconsumedGrantSign(admin.id)).toBe(0);
    // The earlier ceremony can no longer complete.
    const r = await post(req.id, 'complete', signingBody(first, admin, 3), first.cookie);
    expect(r.status).toBe(403);
    expect((await grantRow(g)).activated_at).toBeNull();
  });

  it('someone who may not issue it gets the one refusal: nothing about the grant', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, member);
    expect(p.status).toBe(403);
    expect(p.text).toBe(FORBIDDEN);
    expect(await unconsumedGrantSign(member.id)).toBe(0);
  });

  it('an unknown request id is the same refusal', async () => {
    const p = await prove('zzzzzzzzzzzzzzzzzzzzzz', admin);
    expect(p.status).toBe(403);
    expect(p.text).toBe(FORBIDDEN);
  });
});

describe('C1: one assertion activates the grant, in one transaction', () => {
  it('records the signature, completes the request, activates the grant (signer = issuer), one ACTIVATE event, ends the other open request', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const other = await openRequest(g);
    const p = await prove(req.id, admin);
    const r = await post(req.id, 'complete', signingBody(p, admin), p.cookie);
    expect(r.status).toBe(200);
    const row = await grantRow(g);
    expect(row.activated_at).not.toBeNull();
    expect(row).toMatchObject({ verification_kind: 'passkey', verified_by: admin.id, issuer_user_id: admin.id });
    const sig = await db.grantSignature.findFirstOrThrow({ where: { grantId: g } });
    expect(row.signature_id).toBe(sig.id);
    expect(sig).toMatchObject({ signerId: admin.id, signingRequestId: req.id, holderKind: 'worker', holderId: workerId });
    expect(await requestState(req.id)).toBe('completed');
    expect(await requestState(other.id)).toBe('stale');
    expect(await activateEvents(g)).toBe(1);
    const ev = await db.grantEvent.findFirstOrThrow({ where: { grantId: g, action: 'ACTIVATE' } });
    expect(ev.actorUserId).toBe(admin.id);
    // A second complete with the spent ceremony is the one refusal and changes nothing.
    const again = await post(req.id, 'complete', signingBody(p, admin, 3), p.cookie);
    expect(again.status).toBe(403);
    expect(await records(g)).toBe(1);
  });
});

describe('refusals at completion are judged before any write', () => {
  async function expectNothingWritten(g: string, reqId: string, userId: string, counterBefore: number) {
    expect((await grantRow(g)).activated_at).toBeNull();
    expect(await records(g)).toBe(0);
    expect(await activateEvents(g)).toBe(0);
    expect(await counterOf(userId)).toBe(counterBefore);
    expect(await unconsumedGrantSign(userId)).toBe(1);
    void reqId;
  }

  it('C3: a grant revoked after the proof ends the request STALE and nothing activates', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, admin);
    const counter = await counterOf(admin.id);
    await db.$executeRawUnsafe(`UPDATE grants SET revoked_at = (clock_timestamp() AT TIME ZONE 'UTC'), revoked_by = $2 WHERE id = $1`, g, admin.id);
    const r = await post(req.id, 'complete', signingBody(p, admin), p.cookie);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'SIGNING_REQUEST_ENDED', state: 'STALE' });
    await expectNothingWritten(g, req.id, admin.id, counter);
  });

  it('C4: a signer demoted after the proof may no longer issue it: SIGNER_NOT_ELIGIBLE', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, admin);
    const counter = await counterOf(admin.id);
    await db.orgMember.updateMany({ where: { organizationId: orgId, userId: admin.id }, data: { role: 'CONTRIBUTOR' } });
    const r = await post(req.id, 'complete', signingBody(p, admin), p.cookie);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'SIGNER_NOT_ELIGIBLE' });
    await expectNothingWritten(g, req.id, admin.id, counter);
    expect(await requestState(req.id)).toBe('open');
  });

  it('Gloria P3-2 (#3805): a failure inside the issuer gate that is not a refusal is never SIGNER_NOT_ELIGIBLE', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, admin);
    const counter = await counterOf(admin.id);
    vi.spyOn(issuers, 'requireActionIssuer').mockRejectedValueOnce(new Error('connection lost'));
    const r = await post(req.id, 'complete', signingBody(p, admin), p.cookie);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'forbidden' });
    await expectNothingWritten(g, req.id, admin.id, counter);
    expect(await requestState(req.id)).toBe('open');
  });

  it('C6 (ruling 0257): a first passkey in its cooling-off window is refused with nothing recorded; once the window ends it signs', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, fresh);
    expect(p.json.canSign).toBe(true);
    const counter = await counterOf(fresh.id);
    const r = await post(req.id, 'complete', signingBody(p, fresh), p.cookie);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'PASSKEY_COOLING_OFF' });
    await expectNothingWritten(g, req.id, fresh.id, counter);
    await db.$executeRawUnsafe(`UPDATE passkey_credentials SET window_outcome = 'ended-early', window_ended_at = (clock_timestamp() AT TIME ZONE 'UTC') WHERE id = $1`, fresh.passkeyId);
    const ok = await post(req.id, 'complete', signingBody(p, fresh, 3), p.cookie);
    expect(ok.status).toBe(200);
    expect((await grantRow(g)).verified_by).toBe(fresh.id);
  });

  it('a request past its deadline: SIGNING_REQUEST_ENDED / EXPIRED', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, admin);
    await db.$executeRawUnsafe('ALTER TABLE grant_signing_requests DISABLE TRIGGER grant_signing_request_guard');
    try {
      await db.$executeRawUnsafe(`UPDATE grant_signing_requests SET expires_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second', created_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 minute' WHERE id = $1`, req.id);
    } finally {
      await db.$executeRawUnsafe('ALTER TABLE grant_signing_requests ENABLE TRIGGER grant_signing_request_guard');
    }
    const r = await post(req.id, 'complete', signingBody(p, admin), p.cookie);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'SIGNING_REQUEST_ENDED', state: 'EXPIRED' });
    expect((await grantRow(g)).activated_at).toBeNull();
  });

  it('a grant past its expiry can no longer be signed (ruling 0255 item 16): judged on the clock, terms unchanged', async () => {
    const id = generateId();
    await db.$executeRawUnsafe(`INSERT INTO grants (id, app_id, worker_id, action, action_values, reason, max_uses, expires_at, created_at, updated_at)
      VALUES ($1, $2, $3, 'schedule.create', $4::jsonb, $5, 3, (clock_timestamp() AT TIME ZONE 'UTC') + interval '4 seconds',
              (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'))`,
    id, appId, workerId, JSON.stringify({ entryNode: entryNodeId }), REASON);
    const req = await openRequest(id);
    const p = await prove(req.id, admin);
    expect(p.json.canSign).toBe(true);
    await waitPastExpiry(id);
    const r = await post(req.id, 'complete', signingBody(p, admin), p.cookie);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'SIGNING_REQUEST_ENDED', state: 'EXPIRED' });
    expect((await grantRow(id)).activated_at).toBeNull();
  });

  it('Anne P2 (#3805): a grant that expires while the completion waits on the credential lock is EXPIRED, judged after the last lock', async () => {
    const id = generateId();
    await db.$executeRawUnsafe(`INSERT INTO grants (id, app_id, worker_id, action, action_values, reason, max_uses, expires_at, created_at, updated_at)
      VALUES ($1, $2, $3, 'schedule.create', $4::jsonb, $5, 3, (clock_timestamp() AT TIME ZONE 'UTC') + interval '4 seconds',
              (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'))`,
    id, appId, workerId, JSON.stringify({ entryNode: entryNodeId }), REASON);
    const req = await openRequest(id);
    const p = await prove(req.id, admin);
    expect(p.json.canSign).toBe(true);
    const b = await blocker();
    try {
      // The last lock the completion takes: the signer's credential. The grant is still live when the completion reaches it.
      await b.c.query('SELECT id FROM passkey_credentials WHERE owner_id = $1 FOR UPDATE', [admin.id]);
      const done = post(req.id, 'complete', signingBody(p, admin), p.cookie);
      expect(await waitingOn(b.pid)).toBe(true);
      await waitPastExpiry(id);
      await b.c.query('ROLLBACK');
      const r = await done;
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: 'SIGNING_REQUEST_ENDED', state: 'EXPIRED' });
    } finally { await b.c.query('ROLLBACK').catch(() => undefined); await b.c.end(); }
    const row = await grantRow(id);
    expect(row.activated_at).toBeNull();
    const [{ n }] = await db.$queryRawUnsafe<Array<{ n: bigint }>>('SELECT count(*) AS n FROM grant_signatures WHERE grant_id = $1', id);
    expect(Number(n)).toBe(0);
  });

  it('the completion judges the grant itself, not only its request: a revoked grant whose request stayed open is STALE', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, admin);
    // Keep the request open across the revocation, so only the completion's own grant check can refuse it.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grant_signing_stale');
      await tx.$executeRawUnsafe(`UPDATE grants SET revoked_at = (clock_timestamp() AT TIME ZONE 'UTC'), revoked_by = $2 WHERE id = $1`, g, admin.id);
      await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grant_signing_stale');
    });
    expect(await requestState(req.id)).toBe('open');
    const r = await post(req.id, 'complete', signingBody(p, admin), p.cookie);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'SIGNING_REQUEST_ENDED', state: 'STALE' });
    expect((await grantRow(g)).activated_at).toBeNull();
  });
});

describe('C7 + C8: a grant ceremony and a node ceremony never stand in for each other', () => {
  it('a grant signing ceremony for request A never completes request B', async () => {
    const g1 = await insertGrant();
    const g2 = await insertGrant();
    const a = await openRequest(g1);
    const b = await openRequest(g2);
    const p = await prove(a.id, admin);
    const r = await post(b.id, 'complete', signingBody(p, admin), p.cookie);
    expect(r.status).toBe(403);
    // The ceremony's challenge names request A: the one uniform refusal, judged before any signature is checked.
    expect(await r.text()).toBe(FORBIDDEN);
    expect(await records(g2)).toBe(0);
  });

  it('a node SIGN ceremony never completes a grant request, and a node proof never retires a grant ceremony', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, admin);
    const nodeReq = await db.$transaction((tx) => createSigningRequestInTransaction(tx, entryNodeId, {
      memoryId, requester: { userId: requester.id, appId: null, workerId: null, sessionId: null }, mayWrite: async () => true,
    }));
    // Prove at the NODE page with the grant page's browser value: its retire step must not touch the grant ceremony.
    const nodeCookieValue = p.cookie.split('=').slice(1).join('=');
    const c = await fetch(`${base}/signing/${nodeReq.id}/proof/challenge`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: `hadron_signing=${nodeCookieValue}` }, body: '{}',
    });
    const { ceremonyId, challenge } = await c.json() as { ceremonyId: string; challenge: string };
    const na = admin.key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(challenge, 'base64url'), origin: ORIGIN, rpId: RP, counter: 5 });
    await fetch(`${base}/signing/${nodeReq.id}/proof`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: `hadron_signing=${nodeCookieValue}` },
      body: JSON.stringify(assertionBody(ceremonyId, admin.key, na)),
    });
    expect(await unconsumedGrantSign(admin.id)).toBe(1);
    // A node SIGN ceremony id at the grant page is the one refusal.
    const [nodeSign] = await db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM passkey_ceremonies WHERE purpose = 'SIGN' AND user_id = $1`, admin.id);
    if (nodeSign) {
      const body = { ...signingBody(p, admin, 6), ceremonyId: nodeSign.id };
      expect((await post(req.id, 'complete', body, p.cookie)).status).toBe(403);
    }
    expect((await grantRow(g)).activated_at).toBeNull();
    // The grant ceremony still completes.
    expect((await post(req.id, 'complete', signingBody(p, admin, 7), p.cookie)).status).toBe(200);
  });
});

describe('decline', () => {
  it('the proven issuer declines: the request ends declined and the grant stays pending', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, admin);
    const r = await post(req.id, 'decline', { ceremonyId: p.json.signing.ceremonyId }, p.cookie);
    expect(r.status).toBe(200);
    expect(await requestState(req.id)).toBe('declined');
    expect((await grantRow(g)).activated_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Races, both orders (gate 6745791705; QA's unrun reverse timed race). A blocker connection holds a competing writer's
// lock; the completion is observed waiting on it. In the reverse order, the completion is paused after it locked the grant.

async function waitingOn(blockerPid: number): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    await new Promise((res) => setTimeout(res, 25));
    const [{ n }] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))`, blockerPid);
    if (Number(n) > 0) return true;
  }
  return false;
}

async function blocker(): Promise<{ c: Client; pid: number }> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('BEGIN');
  return { c, pid: (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number };
}

/** Pause the completion right after it locked the grant row; resolves `held` then waits for `release`. */
function pauseAfterGrantLock() {
  let release!: () => void;
  let held!: (pid: number) => void;
  const gate = new Promise<void>((r) => { release = r; });
  // Resolves with the paused completion's OWN backend pid (Gloria P3-4, #3805): read on its transaction, so no other
  // connection holding a lock on the same table can stand in for it.
  const heldP = new Promise<number>((r) => { held = r; });
  const real = grantLocks.lockGrantForSigning;
  vi.spyOn(grantLocks, 'lockGrantForSigning').mockImplementation(async (tx, id, appIdArg) => {
    const out = await real(tx, id, appIdArg);
    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    held(pid);
    await gate;
    return out;
  });
  return { held: heldP, release: () => release() };
}

describe('departure races (cor:acl:140:03, ruling 0259), both orders', () => {
  const retireSql = `UPDATE workers SET retired_at = (clock_timestamp() AT TIME ZONE 'UTC') WHERE id = $1`;
  const departSql = `UPDATE grants SET holder_departed_at = (clock_timestamp() AT TIME ZONE 'UTC') WHERE worker_id = $1 AND revoked_at IS NULL AND holder_departed_at IS NULL`;

  it('the holder goes first: the completion waits on the grant row, then is refused STALE; nothing activates', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, admin);
    const b = await blocker();
    try {
      await b.c.query(retireSql, [workerId]);
      await b.c.query(departSql, [workerId]);
      const done = post(req.id, 'complete', signingBody(p, admin), p.cookie);
      expect(await waitingOn(b.pid)).toBe(true);
      await b.c.query('COMMIT');
      const r = await done;
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: 'SIGNING_REQUEST_ENDED', state: 'STALE' });
    } finally { await b.c.query('ROLLBACK').catch(() => undefined); await b.c.end(); }
    const row = await grantRow(g);
    expect(row.activated_at).toBeNull();
    expect(row.holder_departed_at).not.toBeNull();
  });

  it('the completion goes first (the reverse timed race): the departure waits, then ends the ACTIVE grant', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, admin);
    const pause = pauseAfterGrantLock();
    const done = post(req.id, 'complete', signingBody(p, admin), p.cookie);
    const completionPid = await pause.held;
    const b = await blocker();
    try {
      await b.c.query(retireSql, [workerId]);
      const departed = b.c.query(departSql, [workerId]);
      departed.catch(() => undefined);
      expect(await waitingOn(completionPid)).toBe(true);
      pause.release();
      expect((await done).status).toBe(200);
      await departed;
      await b.c.query('COMMIT');
    } finally { pause.release(); await b.c.query('ROLLBACK').catch(() => undefined); await b.c.end(); }
    const row = await grantRow(g);
    expect(row.activated_at).not.toBeNull();
    expect(row.holder_departed_at).not.toBeNull();
  });
});

describe('revocation and demotion races, both orders', () => {
  it('revoked first: the completion waits on the grant row, then is refused STALE', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, admin);
    const b = await blocker();
    try {
      await b.c.query(`UPDATE grants SET revoked_at = (clock_timestamp() AT TIME ZONE 'UTC'), revoked_by = $2 WHERE id = $1`, [g, admin.id]);
      const done = post(req.id, 'complete', signingBody(p, admin), p.cookie);
      expect(await waitingOn(b.pid)).toBe(true);
      await b.c.query('COMMIT');
      expect((await done).status).toBe(409);
    } finally { await b.c.query('ROLLBACK').catch(() => undefined); await b.c.end(); }
    expect((await grantRow(g)).activated_at).toBeNull();
  });

  it('completion first: the revocation waits, then revokes the ACTIVE grant', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, admin);
    const pause = pauseAfterGrantLock();
    const done = post(req.id, 'complete', signingBody(p, admin), p.cookie);
    const completionPid = await pause.held;
    const b = await blocker();
    try {
      const revoked = b.c.query(`UPDATE grants SET revoked_at = (clock_timestamp() AT TIME ZONE 'UTC'), revoked_by = $2 WHERE id = $1`, [g, admin.id]);
      revoked.catch(() => undefined);
      expect(await waitingOn(completionPid)).toBe(true);
      pause.release();
      expect((await done).status).toBe(200);
      await revoked;
      await b.c.query('COMMIT');
    } finally { pause.release(); await b.c.query('ROLLBACK').catch(() => undefined); await b.c.end(); }
    const row = await grantRow(g);
    expect(row.activated_at).not.toBeNull();
    expect(row.revoked_at).not.toBeNull();
  });

  it('demoted first (org_members row held): the completion waits, then is refused SIGNER_NOT_ELIGIBLE', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, admin);
    const b = await blocker();
    try {
      await b.c.query(`UPDATE org_members SET role = 'CONTRIBUTOR' WHERE organization_id = $1 AND user_id = $2`, [orgId, admin.id]);
      const done = post(req.id, 'complete', signingBody(p, admin), p.cookie);
      expect(await waitingOn(b.pid)).toBe(true);
      await b.c.query('COMMIT');
      const r = await done;
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'SIGNER_NOT_ELIGIBLE' });
    } finally { await b.c.query('ROLLBACK').catch(() => undefined); await b.c.end(); }
    expect((await grantRow(g)).activated_at).toBeNull();
  });

  it('completion first: a demotion waits on the signer\'s org_members row until the activation commits', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, admin);
    const pause = pauseAfterGrantLock();
    const done = post(req.id, 'complete', signingBody(p, admin), p.cookie);
    const completionPid = await pause.held;
    const b = await blocker();
    try {
      const demoted = b.c.query(`UPDATE org_members SET role = 'CONTRIBUTOR' WHERE organization_id = $1 AND user_id = $2`, [orgId, admin.id]);
      demoted.catch(() => undefined);
      expect(await waitingOn(completionPid)).toBe(true);
      pause.release();
      expect((await done).status).toBe(200);
      await demoted;
      await b.c.query('COMMIT');
    } finally { pause.release(); await b.c.query('ROLLBACK').catch(() => undefined); await b.c.end(); }
    expect((await grantRow(g)).activated_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Carried from #3805 to slice D (Rodolfo §10 P3-3, P3-4): pins over guards that exist, each with a mutant.

describe('decline: its own guards (Rodolfo P3-3, #3805)', () => {
  it('a signer demoted after the proof may not decline: SIGNER_NOT_ELIGIBLE, the request stays open, the ceremony unspent', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, admin);
    await db.orgMember.updateMany({ where: { organizationId: orgId, userId: admin.id }, data: { role: 'CONTRIBUTOR' } });
    const r = await post(req.id, 'decline', { ceremonyId: p.json.signing.ceremonyId }, p.cookie);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'SIGNER_NOT_ELIGIBLE' });
    expect(await requestState(req.id)).toBe('open');
    expect(await unconsumedGrantSign(admin.id)).toBe(1);
  });

  it('a ceremony minted for request A never declines request B (the challenge binds the request)', async () => {
    const a = await openRequest(await insertGrant());
    const b = await openRequest(await insertGrant());
    const p = await prove(a.id, admin);
    const r = await post(b.id, 'decline', { ceremonyId: p.json.signing.ceremonyId }, p.cookie);
    expect(r.status).toBe(403);
    expect(await r.text()).toBe(FORBIDDEN);
    expect(await requestState(b.id)).toBe('open');
    expect(await requestState(a.id)).toBe('open');
    expect(await unconsumedGrantSign(admin.id)).toBe(1);
  });

  it('a request past its deadline cannot be declined: SIGNING_REQUEST_ENDED / EXPIRED, the ceremony unspent', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, admin);
    // The deadline moved into the past directly (the request guard keeps expires_at pinned); the same move the completion's
    // deadline pin above makes.
    await db.$executeRawUnsafe('ALTER TABLE grant_signing_requests DISABLE TRIGGER grant_signing_request_guard');
    try {
      await db.$executeRawUnsafe(`UPDATE grant_signing_requests SET expires_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second', created_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 minute' WHERE id = $1`, req.id);
    } finally {
      await db.$executeRawUnsafe('ALTER TABLE grant_signing_requests ENABLE TRIGGER grant_signing_request_guard');
    }
    const r = await post(req.id, 'decline', { ceremonyId: p.json.signing.ceremonyId }, p.cookie);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'SIGNING_REQUEST_ENDED', state: 'EXPIRED' });
    expect(await unconsumedGrantSign(admin.id)).toBe(1);
  });
});

describe('completion: the credential, App and context arms; the proof\'s grant check (Rodolfo P3-4, #3805)', () => {
  async function refusedWithNothing(g: string, reqId: string, body: unknown, cookie: string, expected: { status: number; body: string }) {
    const counter = await counterOf(admin.id);
    const r = await post(reqId, 'complete', body, cookie);
    expect(r.status).toBe(expected.status);
    expect(await r.text()).toBe(expected.body);
    expect((await grantRow(g)).activated_at).toBeNull();
    expect(await records(g)).toBe(0);
    expect(await activateEvents(g)).toBe(0);
    expect(await counterOf(admin.id)).toBe(counter);
    expect(await unconsumedGrantSign(admin.id)).toBe(1);
    expect(await requestState(reqId)).toBe('open');
  }
  const NOT_VERIFIED = { status: 403, body: '{"error":"SIGNATURE_NOT_VERIFIED"}' };

  it('the signer\'s passkey revoked after the proof: SIGNATURE_NOT_VERIFIED, nothing written', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, admin);
    await db.$executeRawUnsafe(`UPDATE passkey_credentials SET revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id = $1`, admin.passkeyId);
    await refusedWithNothing(g, req.id, signingBody(p, admin), p.cookie, NOT_VERIFIED);
  });

  it('another person\'s passkey on the signer\'s ceremony: SIGNATURE_NOT_VERIFIED, nothing written', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, admin);
    await refusedWithNothing(g, req.id, signingBody(p, member), p.cookie, NOT_VERIFIED);
  });

  it('a passkey enrolled under another RP ID: SIGNATURE_NOT_VERIFIED, nothing written', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, admin);
    // The signer's own second passkey, enrolled under another RP ID (the column is immutable, so it is enrolled that way), whose
    // assertion is made under THIS RP ID: verification alone would accept it, so only the enrollment check refuses it.
    const other = softPasskey();
    await insertSoftPasskey(db, admin.id, other, { label: 'gs-admin elsewhere', rpId: 'elsewhere.test' });
    await refusedWithNothing(g, req.id, signingBody(p, { key: other }), p.cookie, NOT_VERIFIED);
  });

  it('the App moved to another org while the completion waited on its anchor: the one refusal, nothing written', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, admin);
    const other = await db.organization.create({ data: { name: 'gs-org2', urn: `gs-org2-${generateId().slice(0, 6)}.test` } });
    const counter = await counterOf(admin.id);
    const b = await blocker();
    try {
      await b.c.query(`SELECT pg_advisory_xact_lock(hashtext('authorization:app'), hashtext($1))`, [appId]);
      const done = post(req.id, 'complete', signingBody(p, admin), p.cookie);
      expect(await waitingOn(b.pid)).toBe(true);
      await b.c.query('UPDATE apps SET organization_id = $2 WHERE id = $1', [appId, other.id]);
      await b.c.query('COMMIT');
      const r = await done;
      expect(r.status).toBe(403);
      expect(await r.text()).toBe(FORBIDDEN);
    } finally { await b.c.query('ROLLBACK').catch(() => undefined); await b.c.end(); }
    expect((await grantRow(g)).activated_at).toBeNull();
    expect(await records(g)).toBe(0);
    expect(await counterOf(admin.id)).toBe(counter);
  });

  it('the issuer gate runs on the transaction\'s context: a platform admin outside the org may issue, and signs', async () => {
    const u = await db.user.create({ data: { handle: 'gs-platform', roles: ['ADMIN'] } });
    const key = softPasskey();
    await insertSoftPasskey(db, u.id, key, { label: 'gs-platform key' });
    const g = await insertGrant();
    const req = await openRequest(g);
    const p = await prove(req.id, { key });
    expect(p.json.canSign).toBe(true);
    const r = await post(req.id, 'complete', signingBody(p, { key }), p.cookie);
    expect(r.status).toBe(200);
    expect(await grantRow(g)).toMatchObject({ verified_by: u.id, issuer_user_id: u.id });
  });

  it('the proof judges the grant itself: a revoked grant whose request stayed open reads ended STALE and mints nothing', async () => {
    const g = await insertGrant();
    const req = await openRequest(g);
    // Keep the request open across the revocation (as the completion's own grant-check pin above does), so only the proof's
    // grant check can answer.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grant_signing_stale');
      await tx.$executeRawUnsafe(`UPDATE grants SET revoked_at = (clock_timestamp() AT TIME ZONE 'UTC'), revoked_by = $2 WHERE id = $1`, g, admin.id);
      await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grant_signing_stale');
    });
    expect(await requestState(req.id)).toBe('open');
    const p = await prove(req.id, admin);
    expect(p.status).toBe(200);
    expect(p.json).toEqual({ outcome: 'ended', state: 'STALE' });
    expect(await unconsumedGrantSign(admin.id)).toBe(0);
  });
});
