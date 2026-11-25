/**
 * #5001 slice 3 (cor:acl:140:07, :09, :04; ruling 0255 item 19; ruling 0257): the grant SELECTION signing ceremony over the real HTTP
 * transport, a real database and a software passkey. P4 one touch activates every offered grant (one touch record, the counter
 * advanced once, one ACTIVATE event per grant); P6 a grant the prover may not issue never appears (compare shapes); P7 eligibility
 * lost between proof and completion fails that item alone; P8 a grant that ends after the request ends only its own item; P9/R9 every
 * offered item failing is a whole-call refusal with the ceremony unspent; P10 replay is refused each way; P11 cooling-off; P18 the
 * one-grant routes refuse a selection item; R8 an item with an unreadable node is shown without a sentence and not signed; R10 decline.
 */
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { loadGrantSignatureStatuses } from '../lib/signing/grantStatus.js';
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
