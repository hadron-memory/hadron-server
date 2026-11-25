/**
 * #5001 slice 3 (cor:acl:140:07, :09, :04; ruling 0255 item 19; ruling 0257): the grant SELECTION signing ceremony over the real HTTP
 * transport, a real database and a software passkey. P4 one touch activates every offered grant (one touch record, the counter
 * advanced once, one ACTIVATE event per grant); P6 a grant the prover may not issue never appears (compare shapes); P7 eligibility
 * lost between proof and completion fails that item alone; P8 a grant that ends after the request ends only its own item; P9/R9 every
 * offered item failing is a whole-call refusal with the ceremony unspent; P10 replay is refused each way; P11 cooling-off; P18 the
 * one-grant routes refuse a selection item; R8 an item with an unreadable node is shown without a sentence and not signed; R10 decline.
 */
import { createHash } from 'node:crypto';
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
import { createGrantSelectionInTransaction } from '../lib/signing/grantSelectionRequests.js';
import { createGrantSigningRequestInTransaction } from '../lib/signing/grantRequests.js';
import { grantSelectionPayloadBytes, sortedSelectionItems } from '../lib/signing/grantSelectionPayload.js';
import { signatureChallenge } from '../lib/signing/payload.js';
import { loadGrantSignatureStatuses } from '../lib/signing/grantStatus.js';
import * as grantLocks from '../lib/signing/grantActivationLocks.js';
import { waitForLockWaitersBlockedBy } from '../test/lockWait.js';
import { clearSignatureVerifyCache, grantSignatureRecordVerifies } from '../lib/signing/verify.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';
const REASON = 'Run the nightly <b>report</b> & mail it';
const PATH = 'grant-selection-signing';

let server: Server | undefined;
let base: string;
let orgId: string;
let appId: string;
let appUrn: string;
let memoryId: string;
let entryNodeId: string;
let workerId: string;
let agentId: string;
let requester: { id: string };
let admin: { id: string; key: SoftPasskey; passkeyId: string };
let member: { id: string; key: SoftPasskey };
let fresh: { id: string; key: SoftPasskey; passkeyId: string };
/** A CONTRIBUTOR of the org who owns the App as an App member: may issue worker.session.restart, not schedule.create. */
let appOwner: { id: string; key: SoftPasskey };

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
  const { org, graph } = await createDbOrgAndGraph(db, { orgName: 'sel-org', graphName: 'sel' });
  orgId = org.id;
  memoryId = graph.id;
  const app = await db.app.create({ data: { organizationId: orgId, name: 'sel-app', urn: `${org.urn}:sel-app` } });
  appId = app.id;
  appUrn = `hrn:app:${app.urn}`;
  entryNodeId = (await createDbNode(db, { loc: 'flows:nightly', memoryId, name: 'Nightly', content: 'x' })).id;
  const agent = await db.agent.create({ data: { organizationId: orgId, name: 'sel-agent', urn: `${org.urn}:sel-agent` } });
  agentId = agent.id;
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name: 'sel-worker', slug: 'sel-worker' } })).id;
  requester = await db.user.create({ data: { handle: 'sel-requester', roles: [] } });
  admin = await person('sel-admin', 'ADMIN');
  member = await person('sel-member', 'CONTRIBUTOR');
  fresh = await person('sel-fresh', 'ADMIN', { firstWindow: true });
  appOwner = await person('sel-appowner', 'CONTRIBUTOR');
  await db.appMember.create({ data: { appId, userId: appOwner.id, role: 'owner' } });
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

const now = `(clock_timestamp() AT TIME ZONE 'UTC')`;
async function scheduleGrant(entry: string | string[] = entryNodeId): Promise<string> {
  const id = generateId();
  await db.$executeRawUnsafe(`INSERT INTO grants (id, app_id, worker_id, action, action_values, reason, max_uses, created_at, updated_at)
    VALUES ($1, $2, $3, 'schedule.create', $4::jsonb, $5, 3, ${now}, ${now})`, id, appId, workerId, JSON.stringify({ entryNode: entry }), REASON);
  return id;
}
async function restartGrant(): Promise<string> {
  const id = generateId();
  await db.$executeRawUnsafe(`INSERT INTO grants (id, app_id, worker_id, action, action_values, reason, created_at, updated_at)
    VALUES ($1, $2, $3, 'worker.session.restart', $4::jsonb, 'keep the team running', ${now}, ${now})`, id, appId, workerId, JSON.stringify({ worker: workerId }));
  return id;
}
const openSelection = (grantIds: string[]) => db.$transaction((tx) => createGrantSelectionInTransaction(tx, grantIds, {
  appId, requester: { userId: requester.id, appId: null, workerId: null, sessionId: null },
}));

const post = (id: string, path: string, body: unknown, cookie?: string, origin: string | null = ORIGIN, prefix = PATH) =>
  fetch(`${base}/${prefix}/${id}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });
function assertionBody(ceremonyId: string, key: SoftPasskey, a: ReturnType<SoftPasskey['assert']>, extra: Record<string, unknown> = {}) {
  return {
    ceremonyId, credentialId: key.credentialId.toString('base64url'),
    authenticatorData: a.authenticatorData.toString('base64url'),
    clientDataJson: a.clientDataJson.toString('base64url'), signature: a.signature.toString('base64url'), ...extra,
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
    const s = await post(id, 'challenge', { grantIds: json.offered }, cookie);
    json.signing = s.status === 200 ? await s.json() : null;
  }
  return { cookie, status: r.status, json, text };
}
function signingBody(p: Proved, who: { key: SoftPasskey }, counter = 2) {
  const s = p.json.signing as { ceremonyId: string; challenge: string };
  const a = who.key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(s.challenge, 'base64url'), origin: ORIGIN, rpId: RP, counter });
  return assertionBody(s.ceremonyId, who.key, a, { grantIds: p.json.offered });
}

/** #5192: the request rows' pins, ascending by grant id (the order every payload builder uses). */
const pinsOf = (selectionId: string) => db.grantSigningRequest.findMany({
  where: { selectionId }, orderBy: { grantId: 'asc' }, select: { grantId: true, version: true, termsHash: true },
});

/**
 * #5192: an assertion that VERIFIES over an arbitrary named set — the exact bytes completion rebuilds for `named` (the payload
 * builders are the production ones, so the signature is honest for that set). Only the ceremony's minted challenge hash can refuse it.
 */
async function namedSetAssertion(selectionId: string, who: { key: SoftPasskey }, named: Array<{ grantId: string; version: number; termsHash: string }>, counter: number) {
  const [sel] = await db.$queryRawUnsafe<Array<{ payload_version: string }>>('SELECT payload_version FROM grant_signing_selections WHERE id = $1', selectionId);
  const challenge = signatureChallenge(grantSelectionPayloadBytes(sel!.payload_version, {
    selectionId,
    items: sortedSelectionItems(named.map((r) => ({ grantId: r.grantId, recordVersion: r.version, termsHash: r.termsHash }))),
  }));
  return who.key.assert({ payload: Buffer.alloc(0), rawChallenge: challenge, origin: ORIGIN, rpId: RP, counter });
}

const FORBIDDEN = '{"error":"forbidden"}';
const grantRow = (id: string) => db.$queryRawUnsafe<Array<{ activated_at: Date | null; verified_by: string | null; signature_id: string | null }>>(
  'SELECT activated_at, verified_by, signature_id FROM grants WHERE id = $1', id).then((r) => r[0]);
const counterOf = (userId: string) => db.$queryRawUnsafe<Array<{ counter: bigint }>>('SELECT max(counter) AS counter FROM passkey_credentials WHERE owner_id = $1', userId).then((r) => Number(r[0].counter));
const activateEvents = (grantId: string) => db.grantEvent.count({ where: { grantId, action: 'ACTIVATE' } });
const selState = (id: string) => db.grantSigningSelection.findUniqueOrThrow({ where: { id }, select: { state: true } }).then((r) => r.state);
const itemStates = (selectionId: string) => db.grantSigningRequest.findMany({ where: { selectionId }, orderBy: { grantId: 'asc' }, select: { grantId: true, state: true } });
const unconsumed = (userId: string) => db.$queryRawUnsafe<Array<{ n: bigint }>>(
  `SELECT count(*) AS n FROM passkey_ceremonies WHERE purpose = 'GRANT_SELECTION_SIGN' AND user_id = $1 AND consumed_at IS NULL`, userId).then((r) => Number(r[0].n));
const revoke = (g: string) => db.$executeRawUnsafe(`UPDATE grants SET revoked_at = ${now}, revoked_by = $2 WHERE id = $1`, g, admin.id);

async function nothingWritten(sel: string, gs: string[], userId: string, counterBefore: number) {
  for (const g of gs) { expect((await grantRow(g)).activated_at).toBeNull(); expect(await activateEvents(g)).toBe(0); }
  expect(await db.grantSelectionSignature.count({ where: { selectionId: sel } })).toBe(0);
  expect(await db.grantSignature.count({ where: { grantId: { in: gs } } })).toBe(0);
  expect(await counterOf(userId)).toBe(counterBefore);
  expect(await selState(sel)).toBe('open');
}

describe('the selection ceremony is behind the signing switch and its shell is the same for every id', () => {
  it('off: an ordinary 404', async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', '');
    server = httpServer(await createServer());
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await fetch(`${base}/${PATH}/abc`)).status).toBe(404);
    expect((await post('abc', 'proof/challenge', {})).status).toBe(404);
  });
  it('on: the shell is byte-identical for every id, and the script is syntactically valid and builds text nodes only', async () => {
    const a = await fetch(`${base}/${PATH}/aaaaaaaaaaaaaaaaaaaaaa`);
    const b = await fetch(`${base}/${PATH}/bbbbbbbbbbbbbbbbbbbbbb`);
    expect(a.status).toBe(200);
    expect(await a.text()).toBe(await b.text());
    const js = await (await fetch(`${base}/${PATH}/ceremony.js`)).text();
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(() => new Function(js)).not.toThrow();
  });
});

describe('P4: one touch activates every offered grant, each with its own record', () => {
  it('three grants: three ACTIVE, three signature records naming ONE touch record, the counter advanced once, one ACTIVATE event each', async () => {
    const gs = [await scheduleGrant(), await scheduleGrant(), await restartGrant()];
    const sel = await openSelection(gs);
    const p = await prove(sel.id, admin);
    expect(p.status).toBe(200);
    expect(p.json.outcome).toBe('open');
    expect(p.json.canSign).toBe(true);
    expect(p.json.offered).toEqual([...gs].sort());
    expect(p.json.view.app.urn).toBe(appUrn);
    expect(p.json.view.items.map((i: { status: string }) => i.status)).toEqual(['OFFERED', 'OFFERED', 'OFFERED']);
    expect(p.json.view.items.every((i: { summary: string }) => typeof i.summary === 'string')).toBe(true);
    expect(p.json.signing.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const before = await counterOf(admin.id);
    const r = await post(sel.id, 'complete', signingBody(p, admin), p.cookie);
    expect(r.status).toBe(200);
    const body = await r.json() as { outcomes: unknown };
    expect(body.outcomes).toEqual([...gs].sort().map((grantId) => ({ grantId, outcome: 'ACTIVATED' })));
    const touches = await db.grantSelectionSignature.findMany({ where: { selectionId: sel.id } });
    expect(touches).toHaveLength(1);
    expect((touches[0]!.items as Array<{ grantId: string }>).map((i) => i.grantId)).toEqual([...gs].sort());
    for (const g of gs) {
      const row = await grantRow(g);
      expect(row.activated_at).not.toBeNull();
      expect(row.verified_by).toBe(admin.id);
      expect(await activateEvents(g)).toBe(1);
      const rec = await db.grantSignature.findMany({ where: { grantId: g } });
      expect(rec).toHaveLength(1);
      expect(rec[0]!.selectionSignatureId).toBe(touches[0]!.id);
      expect(rec[0]!.payloadVersion).toBe('hadron-grant-selection-signature-v1');
    }
    expect(await counterOf(admin.id)).toBe(before + 1);
    expect(await selState(sel.id)).toBe('completed');
    expect((await itemStates(sel.id)).map((i) => i.state)).toEqual(['completed', 'completed', 'completed']);
  });

  it('the ceremony is single-use: a replay of the same completion is refused and writes nothing more', async () => {
    const gs = [await scheduleGrant(), await scheduleGrant()];
    const sel = await openSelection(gs);
    const p = await prove(sel.id, admin);
    const body = signingBody(p, admin);
    expect((await post(sel.id, 'complete', body, p.cookie)).status).toBe(200);
    expect((await post(sel.id, 'complete', body, p.cookie)).status).toBeGreaterThanOrEqual(400);
    expect(await db.grantSelectionSignature.count()).toBe(1);
    expect(await activateEvents(gs[0]!)).toBe(1);
  });
});

describe('P6 + R8: the prover sees, and signs, only the grants they may issue and read', () => {
  it('a grant the prover may not issue never appears: the view is the same shape as a selection that never held it', async () => {
    const sched = await scheduleGrant();
    const restart = await restartGrant();
    const mixed = await openSelection([sched, restart]);
    const alone = await openSelection([restart]);
    const m = await prove(mixed.id, appOwner);
    const a = await prove(alone.id, appOwner, { counter: 3 });
    expect(m.status).toBe(200);
    expect(m.json.canSign).toBe(true);
    expect(m.json.offered).toEqual([restart]);
    // No field, count or position for the grant the prover may not issue: the two views differ only in what names the selection.
    const strip = (j: { view: { items: Array<Record<string, unknown>>; requestExpiresAt: string } }) => ({ ...j.view, requestExpiresAt: undefined });
    expect(Object.keys(m.json).sort()).toEqual(Object.keys(a.json).sort());
    expect(strip(m.json)).toEqual(strip(a.json));
    expect(m.text).not.toContain(sched);
    expect(m.json.view.items).toHaveLength(1);
    const r = await post(mixed.id, 'complete', signingBody(m, appOwner, 4), m.cookie);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { outcomes: unknown }).outcomes).toEqual([{ grantId: restart, outcome: 'ACTIVATED' }]);
    expect((await grantRow(restart)).activated_at).not.toBeNull();
    expect((await grantRow(sched)).activated_at).toBeNull();
    // The selection is completed; the grant nobody signed ends with it (R6): a new request is needed.
    expect(await selState(mixed.id)).toBe('completed');
    expect(Object.fromEntries((await itemStates(mixed.id)).map((i) => [i.grantId, i.state]))).toEqual({ [restart]: 'completed', [sched]: 'stale' });
  });

  it('someone who may issue none gets the one refusal, the proof is spent, and the selection records an anonymous refusal time', async () => {
    const sel = await openSelection([await scheduleGrant(), await scheduleGrant()]);
    const p = await prove(sel.id, member);
    expect(p.status).toBe(403);
    expect(p.text).toBe(FORBIDDEN);
    expect(await unconsumed(member.id)).toBe(0);
    expect((await db.grantSigningSelection.findUniqueOrThrow({ where: { id: sel.id } })).lastRefusedAt).not.toBeNull();
    // An unknown selection is the same refusal, with the same observable counter spend.
    const unknown = await prove('AAAAAAAAAAAAAAAAAAAAAA', member);
    expect(unknown.status).toBe(403);
    expect(unknown.text).toBe(FORBIDDEN);
  });

  it('R8: a grant naming a node the prover cannot read is shown without a sentence, not offered, and not in the signed bytes', async () => {
    const hiddenAgent = await db.agent.create({ data: { organizationId: orgId, name: 'sel-hidden-agent', urn: `${orgId}:sel-hidden-agent` } });
    const mem = await createDbPersonalMemory(db, { userId: requester.id, organizationId: orgId, agentId: hiddenAgent.id, appId, name: 'sel-hidden' });
    const hidden = (await createDbNode(db, { loc: 'flows:secret-flow', memoryId: mem.id, name: 'Secret', content: 'x' })).id;
    const ok = await scheduleGrant();
    const blocked = await scheduleGrant(hidden);
    const sel = await openSelection([ok, blocked]);
    const p = await prove(sel.id, admin);
    expect(p.json.canSign).toBe(true);
    expect(p.json.offered).toEqual([ok]);
    const view = p.json.view.items.find((i: { grantId: string }) => i.grantId === blocked);
    expect(view).toMatchObject({ status: 'UNREADABLE', summary: null });
    expect(p.text).not.toContain('secret-flow');
    expect(p.text).not.toContain(hidden);
    const r = await post(sel.id, 'complete', signingBody(p, admin), p.cookie);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { outcomes: unknown }).outcomes).toEqual([{ grantId: ok, outcome: 'ACTIVATED' }]);
    expect((await grantRow(blocked)).activated_at).toBeNull();
    const touch = (await db.grantSelectionSignature.findFirstOrThrow({ where: { selectionId: sel.id } })).items as Array<{ grantId: string }>;
    expect(touch.map((i) => i.grantId)).toEqual([ok]);
  });
});

describe('P7 + P8 + R9: items fail alone; all failing is a whole-call refusal', () => {
  it('P7: eligibility for one grant lost between proof and completion: that item is SIGNER_NOT_ELIGIBLE, the others activate', async () => {
    const sched = await scheduleGrant();
    const restart = await restartGrant();
    const sel = await openSelection([sched, restart]);
    const p = await prove(sel.id, admin);
    expect(p.json.offered).toEqual([restart, sched].sort());
    // Demoted to a plain member, still an App owner: may issue the restart grant, no longer the schedule grant.
    await db.orgMember.updateMany({ where: { organizationId: orgId, userId: admin.id }, data: { role: 'CONTRIBUTOR' } });
    await db.appMember.create({ data: { appId, userId: admin.id, role: 'owner' } });
    const r = await post(sel.id, 'complete', signingBody(p, admin), p.cookie);
    expect(r.status).toBe(200);
    const outcomes = Object.fromEntries(((await r.json()) as { outcomes: Array<{ grantId: string; outcome: string }> }).outcomes.map((o) => [o.grantId, o.outcome]));
    expect(outcomes).toEqual({ [sched]: 'SIGNER_NOT_ELIGIBLE', [restart]: 'ACTIVATED' });
    expect((await grantRow(restart)).activated_at).not.toBeNull();
    expect((await grantRow(sched)).activated_at).toBeNull();
    expect(await activateEvents(sched)).toBe(0);
  });

  it('P8: one grant revoked after the request ends only its own item; the selection stays open and the others activate', async () => {
    const gs = [await scheduleGrant(), await scheduleGrant(), await scheduleGrant()];
    const sel = await openSelection(gs);
    const [a, b, c] = [...gs].sort() as [string, string, string];
    await revoke(b);
    expect(await selState(sel.id)).toBe('open');
    expect(Object.fromEntries((await itemStates(sel.id)).map((i) => [i.grantId, i.state]))).toEqual({ [a]: 'open', [b]: 'stale', [c]: 'open' });
    const p = await prove(sel.id, admin);
    expect(p.json.offered).toEqual([a, c]);
    expect(p.json.view.items.find((i: { grantId: string }) => i.grantId === b)).toMatchObject({ status: 'ENDED', endedState: 'STALE' });
    const r = await post(sel.id, 'complete', signingBody(p, admin), p.cookie);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { outcomes: unknown }).outcomes).toEqual([{ grantId: a, outcome: 'ACTIVATED' }, { grantId: c, outcome: 'ACTIVATED' }]);
  });

  it('P8 (after the proof): a grant revoked between proof and completion reads STALE for it alone', async () => {
    const gs = [await scheduleGrant(), await scheduleGrant()];
    const sel = await openSelection(gs);
    const [a, b] = [...gs].sort() as [string, string];
    const p = await prove(sel.id, admin);
    await revoke(a);
    const r = await post(sel.id, 'complete', signingBody(p, admin), p.cookie);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { outcomes: unknown }).outcomes).toEqual([{ grantId: a, outcome: 'STALE' }, { grantId: b, outcome: 'ACTIVATED' }]);
    expect((await grantRow(a)).activated_at).toBeNull();
    expect(await selState(sel.id)).toBe('completed');
  });

  it('P8 (departure): a holder that departs between proof and completion reads STALE for that grant alone, judged on the locked row', async () => {
    const w2 = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name: 'sel-worker2', slug: 'sel-worker2' } });
    const departing = generateId();
    await db.$executeRawUnsafe(`INSERT INTO grants (id, app_id, worker_id, action, action_values, reason, max_uses, created_at, updated_at)
      VALUES ($1, $2, $3, 'schedule.create', $4::jsonb, $5, 3, ${now}, ${now})`, departing, appId, w2.id, JSON.stringify({ entryNode: entryNodeId }), REASON);
    const staying = await scheduleGrant();
    const sel = await openSelection([departing, staying]);
    const p = await prove(sel.id, admin);
    await db.$executeRawUnsafe(`UPDATE workers SET retired_at = ${now} WHERE id = $1`, w2.id);
    await db.$executeRawUnsafe(`UPDATE grants SET holder_departed_at = ${now} WHERE worker_id = $1`, w2.id);
    const r = await post(sel.id, 'complete', signingBody(p, admin), p.cookie);
    expect(r.status).toBe(200);
    expect(await outcomesOf(r)).toEqual({ [departing]: 'STALE', [staying]: 'ACTIVATED' });
    expect((await grantRow(departing)).activated_at).toBeNull();
    expect(await activateEvents(departing)).toBe(0);
  });

  it('P8 (expiry): a grant that expires between proof and completion reads EXPIRED for it alone (no trigger ends an item for the passing of time)', async () => {
    const expiring = generateId();
    await db.$executeRawUnsafe(`INSERT INTO grants (id, app_id, worker_id, action, action_values, reason, max_uses, expires_at, created_at, updated_at)
      VALUES ($1, $2, $3, 'schedule.create', $4::jsonb, $5, 3, ${now} + interval '4 seconds', ${now}, ${now})`, expiring, appId, workerId, JSON.stringify({ entryNode: entryNodeId }), REASON);
    const staying = await scheduleGrant();
    const sel = await openSelection([expiring, staying]);
    const p = await prove(sel.id, admin);
    expect(p.json.offered).toEqual([expiring, staying].sort());
    for (let i = 0; i < 100; i++) {
      const [{ over }] = await db.$queryRawUnsafe<Array<{ over: boolean }>>(`SELECT clock_timestamp() AT TIME ZONE 'UTC' > expires_at AS over FROM grants WHERE id = $1`, expiring);
      if (over) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const r = await post(sel.id, 'complete', signingBody(p, admin), p.cookie);
    expect(r.status).toBe(200);
    expect(await outcomesOf(r)).toEqual({ [expiring]: 'EXPIRED', [staying]: 'ACTIVATED' });
    expect((await grantRow(expiring)).activated_at).toBeNull();
    expect(await activateEvents(expiring)).toBe(0);
  }, 30_000);

  it('R9: every offered grant failing refuses the whole call: nothing recorded, the ceremony unspent', async () => {
    const gs = [await scheduleGrant(), await scheduleGrant()];
    const sel = await openSelection(gs);
    const p = await prove(sel.id, admin);
    const counter = await counterOf(admin.id);
    for (const g of gs) await revoke(g);
    const r = await post(sel.id, 'complete', signingBody(p, admin), p.cookie);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe('SIGNING_REQUEST_ENDED');
    expect(await db.grantSelectionSignature.count({ where: { selectionId: sel.id } })).toBe(0);
    expect(await counterOf(admin.id)).toBe(counter);
    expect(await unconsumed(admin.id)).toBe(1);
  });
});

describe('P11: a first passkey in its cooling-off window cannot sign a selection', () => {
  it('refused PASSKEY_COOLING_OFF, nothing recorded, every grant pending and the selection open; signs once the window ends', async () => {
    const gs = [await scheduleGrant(), await scheduleGrant()];
    const sel = await openSelection(gs);
    const p = await prove(sel.id, fresh);
    expect(p.json.canSign).toBe(true);
    const counter = await counterOf(fresh.id);
    const r = await post(sel.id, 'complete', signingBody(p, fresh), p.cookie);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'PASSKEY_COOLING_OFF' });
    await nothingWritten(sel.id, gs, fresh.id, counter);
    await db.$executeRawUnsafe(`UPDATE passkey_credentials SET window_outcome = 'ended-early', window_ended_at = ${now} WHERE id = $1`, fresh.passkeyId);
    const ok = await post(sel.id, 'complete', signingBody(p, fresh, 3), p.cookie);
    expect(ok.status).toBe(200);
  });
});

describe('P10: a signature made for one ceremony never completes another', () => {
  it('selection A\'s assertion presented to selection B, with B\'s own offered set, is refused with nothing written', async () => {
    const a = await openSelection([await scheduleGrant(), await scheduleGrant()]);
    const bGrants = [await scheduleGrant(), await scheduleGrant()];
    const b = await openSelection(bGrants);
    const pa = await prove(a.id, admin);
    const pb = await prove(b.id, admin, { cookie: pa.cookie, counter: 3 });
    const counter = await counterOf(admin.id);
    // A's signing assertion (over A's bytes) sent to B's complete route under B's ceremony.
    const body = { ...signingBody(pa, admin), ceremonyId: pb.json.signing.ceremonyId, grantIds: pb.json.offered };
    const r = await post(b.id, 'complete', body, pb.cookie);
    // B's ceremony, A's bytes: the assertion does not verify over B's challenge.
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'SIGNATURE_NOT_VERIFIED' });
    for (const g of bGrants) expect((await grantRow(g)).activated_at).toBeNull();
    expect(await counterOf(admin.id)).toBe(counter);
    // A ceremony for A never completes B: the selection id is bound in the bytes and the challenge.
    const r2 = await post(b.id, 'complete', signingBody(pa, admin), pa.cookie);
    expect(r2.status).toBe(403);
    expect(await db.grantSelectionSignature.count()).toBe(0);
  });

  it('a different offered set than the one signed (a subset) is refused at the challenge and at completion', async () => {
    const gs = [await scheduleGrant(), await scheduleGrant()];
    const sel = await openSelection(gs);
    const p = await prove(sel.id, admin);
    expect((await post(sel.id, 'challenge', { grantIds: [p.json.offered[0]] }, p.cookie)).status).toBe(403);
    const forged = { ...signingBody(p, admin), grantIds: [p.json.offered[0]] };
    expect((await post(sel.id, 'complete', forged, p.cookie)).status).toBe(403);
    expect((await post(sel.id, 'challenge', { grantIds: [...p.json.offered, 'zzzz'] }, p.cookie)).status).toBe(403);
    expect(await db.grantSelectionSignature.count()).toBe(0);
  });
});

// #5192 item 1 (Riana's SECURITY P3-1): the completion-time `cer.challenge_hash !== sha256Hex(challenge)` leg. The existing P10 pins
// above are satisfied by signature verification alone (their assertion was signed over the MINTED set), so dropping the hash check
// survived. Each pin below completes with a set whose challenge was never minted while the assertion HONESTLY verifies over that
// named set's own bytes — only the ceremony's bound hash can refuse it.
describe('#5192 item 1: the completion-time offered-set challenge hash', () => {
  it('a SUBSET named at completion, signed over that subset\'s own bytes, is the uniform refusal: nothing written, the ceremony unspent', async () => {
    const gs = [await scheduleGrant(), await scheduleGrant()];
    const sel = await openSelection(gs);
    const p = await prove(sel.id, admin);
    const rows = await pinsOf(sel.id);
    const counter = await counterOf(admin.id);
    const sub = rows.slice(0, 1); // a set whose challenge was never minted
    const a = await namedSetAssertion(sel.id, admin, sub, counter + 2);
    const r = await post(sel.id, 'complete', assertionBody(p.json.signing.ceremonyId, admin.key, a, { grantIds: sub.map((x) => x.grantId) }), p.cookie);
    expect(r.status).toBe(403);
    expect(await r.text()).toBe(FORBIDDEN);
    await nothingWritten(sel.id, gs, admin.id, counter);
    expect(await unconsumed(admin.id)).toBe(1); // the minted ceremony is still live: the refusal came before consumeCeremony
  });

  it('a SUPERSET naming an item the proof never offered (revoked before the proof) is refused the same way', async () => {
    const gs = [await scheduleGrant(), await scheduleGrant(), await scheduleGrant()];
    const sel = await openSelection(gs);
    const sorted = [...gs].sort();
    await revoke(sorted[2]!); // ENDED at the proof: never offered, never in the minted challenge
    const p = await prove(sel.id, admin);
    expect(p.json.offered).toEqual(sorted.slice(0, 2));
    const rows = await pinsOf(sel.id);
    expect(rows.map((x) => x.grantId)).toEqual(sorted);
    const counter = await counterOf(admin.id);
    const a = await namedSetAssertion(sel.id, admin, rows, counter + 2);
    const r = await post(sel.id, 'complete', assertionBody(p.json.signing.ceremonyId, admin.key, a, { grantIds: rows.map((x) => x.grantId) }), p.cookie);
    expect(r.status).toBe(403);
    expect(await r.text()).toBe(FORBIDDEN);
    await nothingWritten(sel.id, gs, admin.id, counter);
    expect(await unconsumed(admin.id)).toBe(1);
  });

  it('a REORDER of the same set completes: the offered set is canonical (ascending), so the guard is set equality, not list equality', async () => {
    const gs = [await scheduleGrant(), await scheduleGrant(), await scheduleGrant()];
    const sel = await openSelection(gs);
    const p = await prove(sel.id, admin);
    expect(p.json.offered).toEqual([...gs].sort());
    const r = await post(sel.id, 'complete', { ...signingBody(p, admin), grantIds: [...p.json.offered].reverse() }, p.cookie);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ outcomes: [...gs].sort().map((grantId) => ({ grantId, outcome: 'ACTIVATED' })) });
    expect(await selState(sel.id)).toBe('completed');
  });
});

// #5192 item 3 (Antonio's LOCAL F1): the in-lock `cer.consumed_at || cer.expires_at <= now` pre-check. consumeCeremony raises the
// same refusal later, so the pins below compose a ceremony problem with a request-state problem: the pre-check fires FIRST, so the
// guard answers the uniform ceremony refusal (403) where the mutant without it answers the request-state one (409).
describe('#5192 item 3: the in-lock ceremony consumed/expired pre-check fires before the request-state refusals', () => {
  it('CONSUMED: a replay after a successful completion is the uniform ceremony refusal (403), not SIGNING_REQUEST_ENDED (409)', async () => {
    const gs = [await scheduleGrant(), await scheduleGrant()];
    const sel = await openSelection(gs);
    const p = await prove(sel.id, admin);
    expect((await post(sel.id, 'complete', signingBody(p, admin), p.cookie)).status).toBe(200);
    const r = await post(sel.id, 'complete', signingBody(p, admin, 3), p.cookie);
    expect(r.status).toBe(403);
    expect(await r.text()).toBe(FORBIDDEN);
    expect(await db.grantSelectionSignature.count()).toBe(1);
    expect(await activateEvents(gs[0]!)).toBe(1);
  });

  it('EXPIRED: a ceremony expired between proof and completion, with the selection ended, is the ceremony refusal — not the selection-state one', async () => {
    const gs = [await scheduleGrant(), await scheduleGrant()];
    const sel = await openSelection(gs);
    const p = await prove(sel.id, admin);
    await db.$executeRawUnsafe(`UPDATE passkey_ceremonies SET expires_at = ${now} - interval '1 second' WHERE id = $1`, p.json.signing.ceremonyId);
    await db.$executeRawUnsafe(`UPDATE grant_signing_selections SET state = 'declined' WHERE id = $1`, sel.id);
    const r = await post(sel.id, 'complete', signingBody(p, admin), p.cookie);
    expect(r.status).toBe(403);
    expect(await r.text()).toBe(FORBIDDEN);
    expect(await db.grantSelectionSignature.count()).toBe(0);
  });
});

// #5192 (Brooks, deferred from the stale SECURITY seat): the proof challenge's ceremony-id binding. An assertion over the
// challenge a ceremony-id-less `selectionProofChallenge` would build (the selection line only) must be refused; the same
// ceremony still proves with the honest challenge, so the refusal is the binding, not the fixture.
describe('#5192: the proof challenge binds the ceremony id', () => {
  it('an assertion over the selection-only challenge (the ceremony line dropped) is the uniform refusal, and the same ceremony still proves afterwards', async () => {
    const gs = [await scheduleGrant(), await scheduleGrant()];
    const sel = await openSelection(gs);
    const c = await post(sel.id, 'proof/challenge', {});
    expect(c.status).toBe(200);
    const cookie = (c.headers.get('set-cookie') ?? '').split(';')[0]!;
    const { ceremonyId, challenge } = await c.json() as { ceremonyId: string; challenge: string };
    const forged = createHash('sha256').update(`hadron-grant-selection-signing-proof\nselection ${sel.id}\n`).digest();
    const bad = admin.key.assert({ payload: Buffer.alloc(0), rawChallenge: forged, origin: ORIGIN, rpId: RP, counter: 1 });
    const r = await post(sel.id, 'proof', assertionBody(ceremonyId, admin.key, bad), cookie);
    expect(r.status).toBe(403);
    expect(await r.text()).toBe(FORBIDDEN);
    const honest = admin.key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(challenge, 'base64url'), origin: ORIGIN, rpId: RP, counter: 2 });
    const ok = await post(sel.id, 'proof', assertionBody(ceremonyId, admin.key, honest), cookie);
    expect(ok.status).toBe(200);
  });
});

describe('P18: the one-grant ceremony refuses a selection item, on every route', () => {
  it('proof, challenge, complete and decline of an item id answer the uniform refusal', async () => {
    const gs = [await scheduleGrant(), await scheduleGrant()];
    const sel = await openSelection(gs);
    const [item] = await db.grantSigningRequest.findMany({ where: { selectionId: sel.id } });
    const p = await prove(sel.id, admin);
    // proof through the ONE-GRANT page with an item id: the same bare refusal as an unknown id.
    const c = await post(item!.id, 'proof/challenge', {}, undefined, ORIGIN, 'grant-signing');
    const { ceremonyId, challenge } = await c.json() as { ceremonyId: string; challenge: string };
    const cookie = (c.headers.get('set-cookie') ?? '').split(';')[0]!;
    const a = admin.key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(challenge, 'base64url'), origin: ORIGIN, rpId: RP, counter: 5 });
    const proof = await post(item!.id, 'proof', assertionBody(ceremonyId, admin.key, a), cookie, ORIGIN, 'grant-signing');
    expect(proof.status).toBe(403);
    expect(await proof.text()).toBe(FORBIDDEN);
    expect((await post(item!.id, 'challenge', {}, p.cookie, ORIGIN, 'grant-signing')).status).toBe(403);
    const body = signingBody(p, admin);
    expect((await post(item!.id, 'complete', body, p.cookie, ORIGIN, 'grant-signing')).status).toBe(403);
    expect((await post(item!.id, 'decline', { ceremonyId: body.ceremonyId }, p.cookie, ORIGIN, 'grant-signing')).status).toBe(403);
    expect(await db.grantSelectionSignature.count()).toBe(0);
    expect(await selState(sel.id)).toBe('open');
  });

  it('the one-grant request path still works beside a selection item of the same grant', async () => {
    const g = await scheduleGrant();
    await openSelection([g]);
    const single = await db.$transaction((tx) => createGrantSigningRequestInTransaction(tx, g, { appId, requester: { userId: requester.id, appId: null, workerId: null, sessionId: null } }));
    expect(single.selectionId).toBeNull();
  });
});

describe('R10: decline turns the whole selection down', () => {
  it('the proven issuer declines: selection and every item end declined, every grant stays pending', async () => {
    const gs = [await scheduleGrant(), await scheduleGrant()];
    const sel = await openSelection(gs);
    const p = await prove(sel.id, admin);
    const r = await post(sel.id, 'decline', { ceremonyId: p.json.signing.ceremonyId, grantIds: p.json.offered }, p.cookie);
    expect(r.status).toBe(200);
    expect(await selState(sel.id)).toBe('declined');
    expect((await itemStates(sel.id)).map((i) => i.state)).toEqual(['declined', 'declined']);
    for (const g of gs) expect((await grantRow(g)).activated_at).toBeNull();
  });
});

/** Change a stored record the way only someone outside the platform could: the table's user triggers are off for this one statement. */
async function forge(table: 'grant_signatures' | 'grant_selection_signatures', set: string, where: string, ...params: unknown[]): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    await tx.$executeRawUnsafe(`UPDATE ${table} SET ${set} WHERE ${where}`, ...params);
    await tx.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
  });
}

describe('P3 + P5 + P12: each record re-verifies alone, from the touch record\'s kept item list', () => {
  async function signed(n = 3) {
    const gs: string[] = [];
    for (let i = 0; i < n; i++) gs.push(await scheduleGrant());
    const sel = await openSelection(gs);
    const p = await prove(sel.id, admin);
    expect((await post(sel.id, 'complete', signingBody(p, admin), p.cookie)).status).toBe(200);
    clearSignatureVerifyCache();
    return { gs: [...gs].sort(), sel };
  }

  it('P5: every record of the selection reads CURRENT through the shared status loader', async () => {
    const { gs } = await signed();
    const statuses = await loadGrantSignatureStatuses(db, gs);
    for (const g of gs) {
      const st = statuses.get(g)!;
      expect(st.integrityProblems, g).toBe(0);
      expect(st.state, g).toBe('CURRENT');
      expect(st.signatures).toHaveLength(1);
      expect(st.signatures[0]!.payloadVersion).toBe('hadron-grant-selection-signature-v1');
    }
  });

  it('P5: a record altered to claim other terms than the touch record signed counts ONE integrity problem, for that grant alone', async () => {
    const { gs } = await signed();
    await forge('grant_signatures', `terms_hash = $2`, `grant_id = $1`, gs[1], '0'.repeat(64));
    clearSignatureVerifyCache();
    const statuses = await loadGrantSignatureStatuses(db, gs);
    expect(statuses.get(gs[1]!)!.integrityProblems).toBe(1);
    expect(statuses.get(gs[0]!)).toMatchObject({ integrityProblems: 0, state: 'CURRENT' });
    expect(statuses.get(gs[2]!)).toMatchObject({ integrityProblems: 0, state: 'CURRENT' });
  });

  it('P5: the kept item list is the signed bytes: altering it invalidates every record that rests on it', async () => {
    const { gs, sel } = await signed(2);
    const touch = await db.grantSelectionSignature.findFirstOrThrow({ where: { selectionId: sel.id } });
    const items = (touch.items as Array<{ grantId: string; version: number; termsHash: string }>).map((i, k) => (k === 0 ? { ...i, termsHash: '1'.repeat(64) } : i));
    await forge('grant_selection_signatures', `items = $2::jsonb`, `id = $1`, touch.id, JSON.stringify(items));
    clearSignatureVerifyCache();
    const statuses = await loadGrantSignatureStatuses(db, gs);
    for (const g of gs) expect(statuses.get(g)!.integrityProblems, g).toBe(1);
  });

  it('P3: a selection record never verifies as a one-grant record, and a one-grant record never as a selection record', async () => {
    const { gs, sel } = await signed(2);
    const rec = await db.grantSignature.findFirstOrThrow({ where: { grantId: gs[0]! }, include: { passkey: true, selectionSignature: true } });
    const base = {
      id: rec.id, grantId: rec.grantId, recordVersion: rec.version, termsHash: rec.termsHash, requestId: rec.signingRequestId,
      authenticatorData: Buffer.from(rec.authenticatorData), clientDataJson: Buffer.from(rec.clientDataJson), signature: Buffer.from(rec.signature),
    };
    const cred = { credentialId: Buffer.from(rec.passkey.credentialId), publicKey: Buffer.from(rec.passkey.publicKey), counter: 0n };
    const items = (rec.selectionSignature!.items as Array<{ grantId: string; version: number; termsHash: string }>);
    const selection = { selectionId: sel.id, items };
    expect(await grantSignatureRecordVerifies({ ...base, payloadVersion: 'hadron-grant-selection-signature-v1', selection }, cred, rec.rpId)).toBe(true);
    // No kept item list: it cannot be judged, and it is never judged as v1.
    expect(await grantSignatureRecordVerifies({ ...base, payloadVersion: 'hadron-grant-selection-signature-v1' }, cred, rec.rpId)).toBe(false);
    expect(await grantSignatureRecordVerifies({ ...base, payloadVersion: 'hadron-grant-signature-v1' }, cred, rec.rpId)).toBe(false);
    // A one-grant record that names a selection is refused; the selection builder is never reached by a v1 version.
    expect(await grantSignatureRecordVerifies({ ...base, payloadVersion: 'hadron-grant-signature-v1', selection }, cred, rec.rpId)).toBe(false);
    // A kept list that does not hold the record's own pins is refused.
    expect(await grantSignatureRecordVerifies({ ...base, payloadVersion: 'hadron-grant-selection-signature-v1', selection: { selectionId: sel.id, items: items.filter((i) => i.grantId !== gs[0]) } }, cred, rec.rpId)).toBe(false);
  });

  it('P12: an activated grant\'s terms cannot change (append-only), and a later end of one grant leaves every record verifying from what was signed', async () => {
    const { gs } = await signed(2);
    await expect(db.$executeRawUnsafe(`UPDATE grants SET reason = 'a different reason', version = version + 1 WHERE id = $1`, gs[0])).rejects.toThrow(/append-only/);
    await revoke(gs[0]!);
    clearSignatureVerifyCache();
    const statuses = await loadGrantSignatureStatuses(db, gs);
    for (const g of gs) expect(statuses.get(g), g).toMatchObject({ state: 'CURRENT', integrityProblems: 0 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// P13: the lock order. Every completion locks its grants in ascending id; a race pin pauses each completion right after its
// FIRST grant lock (through the grantActivationLocks module export), so the second lock is taken with the first held.

/** Pause every completion transaction after the first grant lock it takes; `nextHeld` resolves with that backend's pid, `release` frees all. */
function pauseEachAfterFirstGrantLock(only?: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const seen = new Set<number>();
  const order: Array<{ pid: number; id: string }> = [];
  const waiters: Array<(pid: number) => void> = [];
  const real = grantLocks.lockGrantForSigning;
  vi.spyOn(grantLocks, 'lockGrantForSigning').mockImplementation(async (tx, id, appIdArg) => {
    const out = await real(tx, id, appIdArg);
    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    order.push({ pid, id });
    if (!seen.has(pid) && (only === undefined || id === only)) {
      seen.add(pid);
      waiters.shift()?.(pid);
      await gate;
    }
    return out;
  });
  return { nextHeld: () => new Promise<number>((r) => waiters.push(r)), release: () => release(), order };
}
async function blockerConn(): Promise<{ c: Client; pid: number }> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('BEGIN');
  return { c, pid: (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number };
}
const outcomesOf = async (r: Response) => Object.fromEntries(((await r.json()) as { outcomes: Array<{ grantId: string; outcome: string }> }).outcomes.map((o) => [o.grantId, o.outcome]));
const sortedGrants = async (n: number) => (await Promise.all(Array.from({ length: n }, () => scheduleGrant()))).sort();

describe('P13: completions lock their grants in ascending id, so overlapping ones neither deadlock nor double-activate', () => {
  it('{G1,G2} and {G2,G3}, each paused after its first lock: both finish, no 40P01, G2 activated exactly once', async () => {
    const [g1, g2, g3] = await sortedGrants(3) as [string, string, string];
    const admin2 = await person('sel-admin2', 'ADMIN');
    const selA = await openSelection([g1, g2]);
    const selB = await openSelection([g2, g3]);
    const pA = await prove(selA.id, admin);
    const pB = await prove(selB.id, admin2);
    const pause = pauseEachAfterFirstGrantLock();
    const heldA = pause.nextHeld();
    const doneA = post(selA.id, 'complete', signingBody(pA, admin), pA.cookie);
    const pidA = await heldA;
    const heldB = pause.nextHeld();
    const doneB = post(selB.id, 'complete', signingBody(pB, admin2), pB.cookie);
    const pidB = await heldB;
    expect(pidA).not.toBe(pidB);
    pause.release();
    const [rA, rB] = await Promise.all([doneA, doneB]);
    expect(rA.status).toBe(200);
    expect(rB.status).toBe(200);
    const oA = await outcomesOf(rA);
    const oB = await outcomesOf(rB);
    expect(oA[g1]).toBe('ACTIVATED');
    expect(oB[g3]).toBe('ACTIVATED');
    expect([oA[g2], oB[g2]].filter((o) => o === 'ACTIVATED')).toHaveLength(1);
    for (const g of [g1, g2, g3]) { expect((await grantRow(g)).activated_at).not.toBeNull(); expect(await activateEvents(g)).toBe(1); }
    expect(await selState(selA.id)).toBe('completed');
    expect(await selState(selB.id)).toBe('completed');
    // The order itself: each completion took its grant locks in ascending id (a consistent descending or random order would
    // deadlock two selections that share two grants, and a count of outcomes cannot tell).
    for (const pid of [pidA, pidB]) {
      const ids = pause.order.filter((o) => o.pid === pid).map((o) => o.id);
      expect(ids.length).toBeGreaterThanOrEqual(2);
      expect(ids).toEqual([...ids].sort());
    }
  });

  it('the same two grants in two selections: the second completion waits on the first; one activation and one record each', async () => {
    const [g1, g2] = await sortedGrants(2) as [string, string];
    const admin2 = await person('sel-admin2', 'ADMIN');
    const selA = await openSelection([g1, g2]);
    const selB = await openSelection([g1, g2]);
    const pA = await prove(selA.id, admin);
    const pB = await prove(selB.id, admin2);
    const pause = pauseEachAfterFirstGrantLock();
    const heldA = pause.nextHeld();
    const doneA = post(selA.id, 'complete', signingBody(pA, admin), pA.cookie);
    const pidA = await heldA;
    const doneB = post(selB.id, 'complete', signingBody(pB, admin2), pB.cookie);
    await waitForLockWaitersBlockedBy(db, pidA, 1);
    pause.release();
    const rA = await doneA;
    const rB = await doneB;
    expect(rA.status).toBe(200);
    expect([200, 409]).toContain(rB.status);
    for (const g of [g1, g2]) {
      expect((await grantRow(g)).activated_at).not.toBeNull();
      expect(await activateEvents(g)).toBe(1);
      expect(await db.grantSignature.count({ where: { grantId: g } })).toBe(1);
    }
  });

  it('against a concurrent revocation of G2: the completion waits on the revoker, then reads G2 ended; G1 activates', async () => {
    const [g1, g2] = await sortedGrants(2) as [string, string];
    const sel = await openSelection([g1, g2]);
    const p = await prove(sel.id, admin);
    const pause = pauseEachAfterFirstGrantLock();
    const held = pause.nextHeld();
    const done = post(sel.id, 'complete', signingBody(p, admin), p.cookie);
    await held;
    const b = await blockerConn();
    try {
      await b.c.query(`UPDATE grants SET revoked_at = (clock_timestamp() AT TIME ZONE 'UTC'), revoked_by = $2 WHERE id = $1`, [g2, admin.id]);
      pause.release();
      await waitForLockWaitersBlockedBy(db, b.pid, 1);
      await b.c.query('COMMIT');
      const r = await done;
      expect(r.status).toBe(200);
      const o = await outcomesOf(r);
      expect(o[g1]).toBe('ACTIVATED');
      expect(['STALE', 'EXPIRED']).toContain(o[g2]);
    } finally { pause.release(); await b.c.query('ROLLBACK').catch(() => undefined); await b.c.end(); }
    expect((await grantRow(g2)).activated_at).toBeNull();
    expect(await activateEvents(g2)).toBe(0);
    expect(await activateEvents(g1)).toBe(1);
  });

  // Both orders: the selection holds G1 (paused) while the single path takes G2 whole; and the single path holds G2 (paused)
  // while the selection, past G1, waits on it. The pause applies only to the transaction that locks `only` first.
  for (const order of ['selection first', 'single path first'] as const) {
    it(`against a single-path completion of G2 (${order}): exactly one activation of G2`, async () => {
      const [g1, g2] = await sortedGrants(2) as [string, string];
      const admin2 = await person('sel-admin2', 'ADMIN');
      const sel = await openSelection([g1, g2]);
      const single = await db.$transaction((tx) => createGrantSigningRequestInTransaction(tx, g2, { appId, requester: { userId: requester.id, appId: null, workerId: null, sessionId: null } }));
      const p = await prove(sel.id, admin);
      // The one-grant ceremony, driven by hand on its own routes.
      const c = await post(single.id, 'proof/challenge', {}, undefined, ORIGIN, 'grant-signing');
      const { ceremonyId, challenge } = await c.json() as { ceremonyId: string; challenge: string };
      const sCookie = (c.headers.get('set-cookie') ?? '').split(';')[0]!;
      const pa = admin2.key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(challenge, 'base64url'), origin: ORIGIN, rpId: RP, counter: 1 });
      const pr = await post(single.id, 'proof', assertionBody(ceremonyId, admin2.key, pa), sCookie, ORIGIN, 'grant-signing');
      expect(pr.status).toBe(200);
      const sCookie2 = (pr.headers.get('set-cookie') ?? '').split(';')[0] || sCookie;
      const sc = await (await post(single.id, 'challenge', {}, sCookie2, ORIGIN, 'grant-signing')).json() as { ceremonyId: string; challenge: string };
      const sa = admin2.key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(sc.challenge, 'base64url'), origin: ORIGIN, rpId: RP, counter: 2 });
      const startSingle = () => post(single.id, 'complete', assertionBody(sc.ceremonyId, admin2.key, sa), sCookie2, ORIGIN, 'grant-signing');
      const startSel = () => post(sel.id, 'complete', signingBody(p, admin), p.cookie);
      let rSel: Response; let rSingle: Response;
      if (order === 'selection first') {
        const pause = pauseEachAfterFirstGrantLock(g1);
        const held = pause.nextHeld();
        const doneSel = startSel();
        await held;
        rSingle = await startSingle();
        pause.release();
        rSel = await doneSel;
      } else {
        const pause = pauseEachAfterFirstGrantLock(g2);
        const held = pause.nextHeld();
        const doneSingle = startSingle();
        const pid = await held;
        const doneSel = startSel();
        await waitForLockWaitersBlockedBy(db, pid, 1);
        pause.release();
        [rSel, rSingle] = await Promise.all([doneSel, doneSingle]);
      }
      expect(rSel.status).toBe(200);
      expect(rSingle.status).toBe(200);
      expect((await grantRow(g2)).activated_at).not.toBeNull();
      expect(await activateEvents(g2)).toBe(1);
      expect(await db.grantSignature.count({ where: { grantId: g2 } })).toBe(1);
      expect(await activateEvents(g1)).toBe(1);
    }, 30_000);
  }
});
