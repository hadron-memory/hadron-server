/**
 * #1632 S2b-2 (cor:dmo:130:08, :02, :03; cor:aut:040:06) — the server-hosted signing ceremony, over the real HTTP
 * transport against a real database and a software passkey.
 *
 *   GET  /signing/:id                a static shell, the same for every id; nothing about any node
 *   POST /signing/:id/proof/challenge opens a SIGN_PROOF ceremony for this browser; the same answer for every id
 *   POST /signing/:id/proof          a passkey assertion over it: read access + named-signer match, THEN the content;
 *                                    mints the ONE signing ceremony for a proven writer
 *   POST /signing/:id/challenge      reads that ceremony's bound challenge (SHA-256 of the v3 payload); mints nothing
 *   POST /signing/:id/complete       the signing assertion; one transaction (ceremony, counter, record, end)
 *   POST /signing/:id/decline        the proven signer turns the request down
 *
 * Mounted only through signingSurfacePolicy(); off is an ordinary 404.
 */
import { createHash } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbNode, createDbOrgAndGraph } from '../test/helpers.js';
import { insertSoftPasskey, softPasskey, type SoftPasskey } from '../test/softPasskey.js';
import { createSigningRequestInTransaction, withdrawSigningRequestInTransaction } from '../lib/signing/requests.js';
import { loadSignatureStatuses } from '../lib/signing/status.js';
import { signatureChallenge, signaturePayloadBytes } from '../lib/signing/payload.js';
import { clearSignatureVerifyCache } from '../lib/signing/verify.js';
import { resolvers } from './graphql/schema/resolvers.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';
const TITLE = 'Retention policy';
const ABSTRACT = 'How long we keep records.';
const CONTENT = 'Records are kept 30 days.\n\nSee {{> policies:conduct}} for conduct.\n';

let server: Server | undefined;
let base: string;
let memoryId: string;
let nodeId: string;
let requester: { id: string };
let signer: { id: string; key: SoftPasskey };
let reader: { id: string; key: SoftPasskey };
let outsider: { id: string; key: SoftPasskey };
let otherWriter: { id: string; key: SoftPasskey };

async function person(handle: string, role: 'CONTRIBUTOR' | 'READER' | null, orgId: string) {
  const u = await db.user.create({ data: { handle, roles: [] } });
  if (role) await db.orgMember.create({ data: { organizationId: orgId, userId: u.id, role } });
  const key = softPasskey();
  await insertSoftPasskey(db, u.id, key, { label: `${handle} key` });
  return { id: u.id, key };
}

beforeEach(async () => {
  await cleanDb(db);
  clearSignatureVerifyCache();
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', RP);
  vi.stubEnv('SIGNING_CEREMONY_ORIGINS', ORIGIN);
  const { org, graph } = await createDbOrgAndGraph(db, { orgName: 'cer-org', graphName: 'cer' });
  memoryId = graph.id;
  requester = await db.user.create({ data: { handle: 'ceremony-requester', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: requester.id, role: 'CONTRIBUTOR' } });
  signer = await person('cer-signer', 'CONTRIBUTOR', org.id);
  reader = await person('cer-reader', 'READER', org.id);
  otherWriter = await person('cer-other-writer', 'CONTRIBUTOR', org.id);
  outsider = await person('cer-outsider', null, org.id);
  nodeId = (await createDbNode(db, { loc: 'policies:retention', memoryId, name: TITLE, content: CONTENT })).id;
  await db.node.update({ where: { id: nodeId }, data: { abstract: ABSTRACT } });
  server = httpServer(await createServer());
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
  server = undefined;
  vi.unstubAllEnvs();
});

const mayWrite = async () => true;
const openRequest = (opts: { namedSignerId?: string } = {}) => db.$transaction((tx) => createSigningRequestInTransaction(tx, nodeId, {
  memoryId, requester: { userId: requester.id, appId: null, workerId: null, sessionId: null }, mayWrite, ...opts,
}));
type Req = Awaited<ReturnType<typeof openRequest>>;

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();
const post = (id: string, path: string, body: unknown, cookie?: string, origin: string | null = ORIGIN) =>
  fetch(`${base}/signing/${id}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });

interface Proved { cookie: string; ceremonyId: string; json: any; status: number }

/** Open a proof ceremony and answer it with `who`'s passkey (counter 1). */
async function prove(id: string, who: { key: SoftPasskey }, over: { uv?: boolean; origin?: string; counter?: number } = {}): Promise<Proved> {
  const c = await post(id, 'proof/challenge', {});
  expect(c.status).toBe(200);
  const cookie = (c.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const { ceremonyId, challenge } = await c.json() as { ceremonyId: string; challenge: string };
  const a = who.key.assert({
    payload: Buffer.alloc(0), rawChallenge: Buffer.from(challenge, 'base64url'),
    origin: over.origin ?? ORIGIN, rpId: RP, counter: over.counter ?? 1, uv: over.uv,
  });
  const r = await post(id, 'proof', assertionBody(ceremonyId, who.key, a), cookie);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (await r.json().catch(() => null)) as any;
  // After a proof that opened a signing ceremony, `/challenge` hands over its bound challenge (it mints nothing).
  if (json?.outcome === 'open') {
    const s = await post(id, 'challenge', {}, cookie);
    json.signing = s.status === 200 ? await s.json() : null;
  }
  return { cookie, ceremonyId, status: r.status, json };
}

function assertionBody(ceremonyId: string, key: SoftPasskey, a: ReturnType<SoftPasskey['assert']>) {
  return {
    ceremonyId, credentialId: key.credentialId.toString('base64url'),
    authenticatorData: a.authenticatorData.toString('base64url'),
    clientDataJson: a.clientDataJson.toString('base64url'), signature: a.signature.toString('base64url'),
  };
}

/** The signing assertion over the challenge the server handed over with the content. */
function signingBody(p: Proved, key: SoftPasskey, over: { uv?: boolean; origin?: string; counter?: number } = {}) {
  const s = p.json.signing as { ceremonyId: string; challenge: string };
  const a = key.assert({
    payload: Buffer.alloc(0), rawChallenge: Buffer.from(s.challenge, 'base64url'),
    origin: over.origin ?? ORIGIN, rpId: RP, counter: over.counter ?? 2, uv: over.uv,
  });
  return assertionBody(s.ceremonyId, key, a);
}

const FORBIDDEN = '{"error":"forbidden"}';

describe('the surface is mounted only through signingSurfacePolicy()', () => {
  it('is an ordinary 404 while the switch is off, byte-identical to a path that never existed', async () => {
    const req = await openRequest();
    await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'false');
    server = httpServer(await createServer());
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const never = await fetch(`${base}/nothing-here/${req.id}`);
    const neverPost = await fetch(`${base}/nothing-here/${req.id}/proof`, { method: 'POST' });
    for (const [method, path, ref] of [['GET', '', never], ['POST', '/proof/challenge', neverPost], ['POST', '/proof', neverPost],
      ['POST', '/challenge', neverPost], ['POST', '/complete', neverPost], ['POST', '/decline', neverPost]] as const) {
      const r = await fetch(`${base}/signing/${req.id}${path}`, { method, headers: { origin: ORIGIN } });
      expect(r.status, `${method} ${path}`).toBe(ref.status);
      // Express's default 404 names the path it was asked for: compare with each request's own path masked.
      expect((await r.text()).replaceAll(`/signing/${req.id}${path}`, '<path>'), `${method} ${path}`)
        .toBe((await ref.clone().text()).replaceAll(ref === never ? `/nothing-here/${req.id}` : `/nothing-here/${req.id}/proof`, '<path>'));
    }
    expect((await fetch(`${base}/signing/ceremony.js`)).status).toBe(404);
  });
});

describe('a link alone reveals nothing (cor:dmo:130:08)', () => {
  it('the page is the same shell for a real request and an unknown one, with no node text, and cannot be framed or cached', async () => {
    const req = await openRequest();
    const real = await fetch(`${base}/signing/${req.id}`);
    const unknown = await fetch(`${base}/signing/${'A'.repeat(22)}`);
    expect(real.status).toBe(200);
    expect(unknown.status).toBe(200);
    const body = await real.text();
    expect(body).toBe(await unknown.text());
    for (const secret of [TITLE, ABSTRACT, 'Records are kept', 'ceremony-requester', 'policies:retention', nodeId]) expect(body).not.toContain(secret);
    expect(real.headers.get('cache-control')).toBe('no-store');
    expect(real.headers.get('x-frame-options')).toBe('DENY');
    expect(real.headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'/);
    expect(real.headers.get('content-security-policy')).toMatch(/script-src 'self'/);
    expect(real.headers.get('content-security-policy')).not.toMatch(/unsafe-inline'?[^;]*script|script-src[^;]*unsafe-inline/);
    expect(real.headers.get('referrer-policy')).toBe('same-origin');
  });

  it('serves its script from the same origin', async () => {
    const js = await fetch(`${base}/signing/ceremony.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    const text = await js.text();
    expect(text).toContain('navigator.credentials.get');
    // The script never builds a link or touches an assertion it was not handed by this server.
    expect(text).not.toMatch(/innerHTML|document\.write|eval\(/);
  });

  it('the challenge answer is the same shape for a real request and an unknown one, and needs an allowed Origin', async () => {
    const req = await openRequest();
    const a = await post(req.id, 'proof/challenge', {});
    const b = await post('B'.repeat(22), 'proof/challenge', {});
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(Object.keys((await a.json()) as object).sort()).toEqual(Object.keys((await b.json()) as object).sort());
    for (const origin of ['https://evil.example', null]) {
      const r = await post(req.id, 'proof/challenge', {}, undefined, origin);
      expect(r.status).toBe(403);
      expect(await r.text()).toBe(FORBIDDEN);
    }
  });

  it('sets a strict HttpOnly browser cookie scoped to the ceremony path', async () => {
    const req = await openRequest();
    const c = await post(req.id, 'proof/challenge', {});
    const cookie = c.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/signing/i);
  });
});

describe('passkey-proven read access and the named-signer match come BEFORE any content (S5, S6, 130:02 S4)', () => {
  it('a proven writer sees exactly what is signed, the revision, who asked, and the includes marked not covered', async () => {
    const req = await openRequest();
    const p = await prove(req.id, signer);
    expect(p.status).toBe(200);
    expect(p.json.outcome).toBe('open');
    expect(p.json.canSign).toBe(true);
    const v = p.json.view;
    expect(v.node.title).toBe(TITLE);
    expect(v.node.abstract).toBe(ABSTRACT);
    // The content exactly as stored/hashed, reassembled from its segments; the include tag stays a literal tag.
    expect(v.node.contentSegments.map((s: { text: string }) => s.text).join('')).toBe(CONTENT);
    expect(v.node.contentSegments.filter((s: { include: boolean }) => s.include).map((s: { text: string }) => s.text)).toEqual(['{{> policies:conduct}}']);
    expect(v.revision).toBe(req.revision);
    expect(v.requester.name).toBe('ceremony-requester');
    expect(v.previous).toBeNull(); // no earlier signature on this node
    expect(JSON.stringify(p.json)).not.toContain('Included text'); // never expanded
  });

  it('the signing challenge is SHA-256 of the v3 payload bytes, bound to this request', async () => {
    const req = await openRequest();
    const p = await prove(req.id, signer);
    const bytes = Buffer.from(`hadron-signature-v3\nnode ${nodeId}\napproval-hash ${req.approvalHash}\nrequest ${req.id}\n`, 'utf8');
    expect(p.json.signing.challenge).toBe(sha256(bytes).toString('base64url'));
    expect(p.json.signing.challenge).toBe(signatureChallenge(signaturePayloadBytes('hadron-signature-v3', { nodeId, approvalHash: req.approvalHash, requestId: req.id })).toString('base64url'));
    expect(p.json.signing.rpId).toBe(RP);
    expect(p.json.signing.allowCredentials).toEqual([signer.key.credentialId.toString('base64url')]);
  });

  it('a reader who may not write sees the node but can never complete it', async () => {
    const req = await openRequest();
    const p = await prove(req.id, reader);
    expect(p.status).toBe(200);
    expect(p.json.view.node.title).toBe(TITLE);
    expect(p.json.canSign).toBe(false);
    expect(p.json.signing).toBeNull();
    const r = await post(req.id, 'complete', { ...signingBody({ ...p, json: { signing: { ceremonyId: p.ceremonyId, challenge: signatureChallenge(signaturePayloadBytes('hadron-signature-v3', { nodeId, approvalHash: req.approvalHash, requestId: req.id })).toString('base64url') } } }, reader.key) }, p.cookie);
    expect(r.status).toBe(403);
    expect(await db.nodeSignature.count()).toBe(0);
  });

  it('someone who cannot read the node gets the uniform refusal, byte-identical to an unknown request, with no content', async () => {
    const req = await openRequest();
    const denied = await prove(req.id, outsider);
    const unknown = await prove('C'.repeat(22), signer);
    expect(denied.status).toBe(403);
    expect(unknown.status).toBe(403);
    expect(denied.json).toEqual({ error: 'forbidden' });
    expect(unknown.json).toEqual(denied.json);
  });

  it('a request that names someone is shown only to them: another writer gets the uniform refusal and the request stays open', async () => {
    const req = await openRequest({ namedSignerId: signer.id });
    const other = await prove(req.id, otherWriter);
    expect(other.status).toBe(403);
    expect(other.json).toEqual({ error: 'forbidden' });
    expect((await prove(req.id, signer)).status).toBe(200);
    expect((await db.signingRequest.findUniqueOrThrow({ where: { id: req.id } })).state).toBe('open');
  });

  it('refuses a proof by another browser, a forged cookie, an unlisted Origin, no user verification, and a replay', async () => {
    const req = await openRequest();
    const c = await post(req.id, 'proof/challenge', {});
    const cookie = (c.headers.get('set-cookie') ?? '').split(';')[0]!;
    const { ceremonyId, challenge } = await c.json() as { ceremonyId: string; challenge: string };
    const answer = (over: { uv?: boolean; origin?: string } = {}) => assertionBody(ceremonyId, signer.key, signer.key.assert({
      payload: Buffer.alloc(0), rawChallenge: Buffer.from(challenge, 'base64url'), origin: over.origin ?? ORIGIN, rpId: RP, counter: 1, uv: over.uv,
    }));
    for (const [what, ck, origin, body] of [
      ['no cookie', undefined, ORIGIN, answer()],
      ['a forged cookie', 'hadron_signing=forged', ORIGIN, answer()],
      ['an unlisted Origin', cookie, 'https://evil.example', answer()],
      ['no user verification', cookie, ORIGIN, answer({ uv: false })],
      ['a wrong assertion origin', cookie, ORIGIN, answer({ origin: 'https://evil.example' })],
    ] as const) {
      const r = await post(req.id, 'proof', body, ck, origin);
      expect(r.status, what).toBe(403);
      expect(await r.text(), what).toBe(FORBIDDEN);
    }
    expect((await post(req.id, 'proof', answer(), cookie)).status).toBe(200);
    // Consumed: the same proof, replayed, is refused, and so is any later one on that ceremony.
    expect((await post(req.id, 'proof', answer(), cookie)).status).toBe(403);
  });

  it('a proof ceremony is bound to its request: one opened for request A proves nothing at request B', async () => {
    const a = await openRequest();
    const b = await openRequest();
    const c = await post(a.id, 'proof/challenge', {});
    const cookie = (c.headers.get('set-cookie') ?? '').split(';')[0]!;
    const { ceremonyId, challenge } = await c.json() as { ceremonyId: string; challenge: string };
    const assertion = signer.key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(challenge, 'base64url'), origin: ORIGIN, rpId: RP, counter: 1 });
    const atB = await post(b.id, 'proof', assertionBody(ceremonyId, signer.key, assertion), cookie);
    expect(atB.status).toBe(403);
    expect(await atB.text()).toBe(FORBIDDEN);
    // Refusal did not spend it: it still proves at its own request.
    expect((await post(a.id, 'proof', assertionBody(ceremonyId, signer.key, assertion), cookie)).status).toBe(200);
  });

  it('only /proof mints a signing ceremony: /proof/challenge opens one that can never sign, /challenge only reads the minted one back, and a new proof retires the old', async () => {
    const req = await openRequest();
    const c = await post(req.id, 'proof/challenge', {});
    const proofOpen = await c.json() as Record<string, unknown>;
    expect(Object.keys(proofOpen).sort()).toEqual(['ceremonyId', 'challenge', 'rpId']);
    expect(await db.passkeyCeremony.count({ where: { purpose: 'SIGN' } })).toBe(0);
    const cookie = (c.headers.get('set-cookie') ?? '').split(';')[0]!;
    // Before a proof there is nothing to read back, and a proof ceremony's own challenge, answered at /complete, signs nothing.
    expect((await post(req.id, 'challenge', {}, cookie)).status).toBe(403);
    const a = signer.key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(String(proofOpen.challenge), 'base64url'), origin: ORIGIN, rpId: RP, counter: 1 });
    expect((await post(req.id, 'complete', assertionBody(String(proofOpen.ceremonyId), signer.key, a), cookie)).status).toBe(403);
    expect(await db.nodeSignature.count()).toBe(0);
    // /proof mints exactly one; /challenge, called twice, returns that same one and mints no other.
    const first = await prove(req.id, signer);
    expect(await db.passkeyCeremony.count({ where: { purpose: 'SIGN' } })).toBe(1);
    const again = await (await post(req.id, 'challenge', {}, first.cookie)).json() as { ceremonyId: string };
    expect(again.ceremonyId).toBe(first.json.signing.ceremonyId);
    expect(await db.passkeyCeremony.count({ where: { purpose: 'SIGN' } })).toBe(1);
    // Another browser holds no signing ceremony: /challenge refuses it uniformly.
    const other = await post(req.id, 'proof/challenge', {});
    expect((await post(req.id, 'challenge', {}, (other.headers.get('set-cookie') ?? '').split(';')[0]!)).status).toBe(403);
    // A newer proof in the SAME browser retires the earlier signing ceremony; only the newest is live.
    const c2 = await post(req.id, 'proof/challenge', {}, first.cookie);
    const ck2 = (c2.headers.get('set-cookie') ?? '').split(';')[0] || first.cookie;
    const { ceremonyId: id2, challenge: ch2 } = await c2.json() as { ceremonyId: string; challenge: string };
    const proof2 = await post(req.id, 'proof', assertionBody(id2, signer.key, signer.key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(ch2, 'base64url'), origin: ORIGIN, rpId: RP, counter: 2 })), ck2);
    expect(proof2.status).toBe(200);
    expect(await db.passkeyCeremony.count({ where: { purpose: 'SIGN', consumedAt: null } })).toBe(1);
    const staleTry = await post(req.id, 'complete', signingBody(first, signer.key, { counter: 3 }), ck2);
    expect(staleTry.status).toBe(403);
    expect(await db.nodeSignature.count()).toBe(0);
  });

  it('an ended request is shown only to a proven eligible person, as ended, with no sign option', async () => {
    const req = await openRequest();
    await db.$transaction((tx) => withdrawSigningRequestInTransaction(tx, req.id, { memoryId, caller: { userId: requester.id, appId: null } }));
    const p = await prove(req.id, signer);
    expect(p.status).toBe(200);
    expect(p.json.outcome).toBe('ended');
    expect(p.json.state).toBe('WITHDRAWN');
    expect(p.json.signing).toBeUndefined();
    expect(p.json.view).toBeUndefined();
    expect((await prove(req.id, outsider)).json).toEqual({ error: 'forbidden' });
  });

  it('the diff is against the last signed revision, and says so when that earlier text is no longer kept', async () => {
    const first = await openRequest();
    const p1 = await prove(first.id, signer);
    expect((await post(first.id, 'complete', signingBody(p1, signer.key), p1.cookie)).status).toBe(200);
    // A real edit (it snapshots the signed text and bumps the revision), not a raw column write.
    await resolvers.Mutation.updateNode(null, { input: { id: nodeId, content: 'Records are kept 90 days.\n' } }, { db, userId: requester.id, roles: [] } as never);
    const second = await openRequest();
    const p2 = await prove(second.id, signer, { counter: 3 });
    const prev = p2.json.view.previous;
    expect(prev.revision).toBe(first.revision);
    expect(prev.kept).toBe(true);
    const lines = prev.diff.content as Array<{ kind: string; text: string }>;
    expect(lines.filter((l) => l.kind === 'del').map((l) => l.text)).toContain('Records are kept 30 days.');
    expect(lines.filter((l) => l.kind === 'add').map((l) => l.text)).toContain('Records are kept 90 days.');
    // The earlier revision's text deleted (history cleared): the diff says it is no longer kept.
    await db.nodeRevision.deleteMany({ where: { nodeId, revNo: first.revision } });
    const p3 = await prove(second.id, signer, { counter: 4 });
    expect(p3.json.view.previous).toEqual({ revision: first.revision, kept: false });
  });
});

describe('completing: one transaction, every refusal rolls back all of it', () => {
  it('records the signature, completes the request, advances the counter, and spends the ceremony', async () => {
    const req = await openRequest();
    const p = await prove(req.id, signer);
    const done = await post(req.id, 'complete', signingBody(p, signer.key), p.cookie);
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual(expect.objectContaining({ ok: true }));
    const row = await db.signingRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.state).toBe('completed');
    const sigs = await db.nodeSignature.findMany();
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toEqual(expect.objectContaining({ signerId: signer.id, signingRequestId: req.id, payloadVersion: 'hadron-signature-v3', rpId: RP }));
    expect((await db.passkeyCredential.findFirstOrThrow({ where: { ownerId: signer.id } })).counter).toBe(2n);
    const status = (await loadSignatureStatuses(db, [nodeId])).get(nodeId)!;
    expect(status.state).toBe('CURRENT');
    expect(status.integrityProblems).toBe(0);
    // Spent: completing again, or re-using the signing ceremony, is refused and records nothing more.
    const again = await post(req.id, 'complete', signingBody(p, signer.key, { counter: 3 }), p.cookie);
    expect(again.status).not.toBe(200);
    expect(await db.nodeSignature.count()).toBe(1);
  });

  it('a bad assertion records nothing, leaves the request open and the ceremony usable for the real one', async () => {
    const req = await openRequest();
    const p = await prove(req.id, signer);
    for (const over of [{ uv: false }, { origin: 'https://evil.example' }]) {
      const r = await post(req.id, 'complete', signingBody(p, signer.key, over), p.cookie);
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'SIGNATURE_NOT_VERIFIED' });
    }
    expect(await db.nodeSignature.count()).toBe(0);
    expect((await db.signingRequest.findUniqueOrThrow({ where: { id: req.id } })).state).toBe('open');
    expect((await db.passkeyCredential.findFirstOrThrow({ where: { ownerId: signer.id } })).counter).toBe(1n);
    expect((await post(req.id, 'complete', signingBody(p, signer.key), p.cookie)).status).toBe(200);
  });

  it('refuses an assertion over ANOTHER request\'s payload (no cross-request replay), recording nothing', async () => {
    const a = await openRequest();
    const b = await openRequest();
    const p = await prove(a.id, signer);
    const foreign = signer.key.assert({
      payload: signaturePayloadBytes('hadron-signature-v3', { nodeId, approvalHash: b.approvalHash, requestId: b.id }),
      origin: ORIGIN, rpId: RP, counter: 2,
    });
    const r = await post(a.id, 'complete', assertionBody(p.json.signing.ceremonyId, signer.key, foreign), p.cookie);
    expect(r.status).toBe(403);
    expect(await db.nodeSignature.count()).toBe(0);
  });

  it('a signing ceremony opened for one request never completes another', async () => {
    const a = await openRequest();
    const b = await openRequest();
    const pa = await prove(a.id, signer);
    const pb = await prove(b.id, signer, { counter: 3 });
    // A's ceremony and A's challenge, replayed at B's endpoint.
    const r = await post(b.id, 'complete', signingBody(pa, signer.key), pb.cookie);
    expect(r.status).toBe(403);
    expect(await db.nodeSignature.count()).toBe(0);
    expect((await db.signingRequest.findUniqueOrThrow({ where: { id: b.id } })).state).toBe('open');
  });

  it('refuses a complete with another browser\'s cookie, and one with no Origin', async () => {
    const req = await openRequest();
    const p = await prove(req.id, signer);
    const other = await post(req.id, 'proof/challenge', {});
    const otherCookie = (other.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect((await post(req.id, 'complete', signingBody(p, signer.key), otherCookie)).status).toBe(403);
    expect((await post(req.id, 'complete', signingBody(p, signer.key), p.cookie, null)).status).toBe(403);
    expect(await db.nodeSignature.count()).toBe(0);
  });

  it('a different person\'s passkey cannot complete the proven person\'s ceremony', async () => {
    const req = await openRequest();
    const p = await prove(req.id, signer);
    const r = await post(req.id, 'complete', signingBody(p, otherWriter.key), p.cookie);
    expect(r.status).toBe(403);
    expect(await db.nodeSignature.count()).toBe(0);
  });

  describe('between display and completion', () => {
    const attempt = async (mutate: (req: Req) => Promise<void>) => {
      const req = await openRequest();
      const p = await prove(req.id, signer);
      await mutate(req);
      const r = await post(req.id, 'complete', signingBody(p, signer.key), p.cookie);
      return { r, body: await r.json() as { error?: string; state?: string }, req };
    };
    const expectNothing = async () => {
      expect(await db.nodeSignature.count()).toBe(0);
      expect((await db.passkeyCredential.findFirstOrThrow({ where: { ownerId: signer.id } })).counter).toBe(1n);
    };

    it('a content change ends it stale: refused, nothing recorded', async () => {
      const { r, body } = await attempt(async () => { await db.node.update({ where: { id: nodeId }, data: { content: 'Changed.' } }); });
      expect(r.status).toBe(409);
      expect(body).toEqual({ error: 'SIGNING_REQUEST_ENDED', state: 'STALE' });
      await expectNothing();
    });

    it('a withdrawal: refused, nothing recorded', async () => {
      const { r, body } = await attempt(async (req) => {
        await db.$transaction((tx) => withdrawSigningRequestInTransaction(tx, req.id, { memoryId, caller: { userId: requester.id, appId: null } }));
      });
      expect(r.status).toBe(409);
      expect(body).toEqual({ error: 'SIGNING_REQUEST_ENDED', state: 'WITHDRAWN' });
      await expectNothing();
    });

    it('expiry: refused, nothing recorded', async () => {
      const { r, body } = await attempt(async (req) => {
        await db.$transaction(async (tx) => {
          await tx.$executeRaw`ALTER TABLE signing_requests DISABLE TRIGGER signing_request_guard`;
          await tx.$executeRaw`UPDATE signing_requests SET created_at = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '2 hours', expires_at = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '1 second' WHERE id = ${req.id}`;
          await tx.$executeRaw`ALTER TABLE signing_requests ENABLE TRIGGER signing_request_guard`;
        });
      });
      expect(r.status).toBe(409);
      expect(body.error).toBe('SIGNING_REQUEST_ENDED');
      expect(body.state).toBe('EXPIRED');
      await expectNothing();
    });

    it('the passkey revoked: refused, nothing recorded', async () => {
      const { r, body } = await attempt(async () => {
        await db.$executeRaw`UPDATE passkey_credentials SET revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE owner_id = ${signer.id}`;
      });
      expect(r.status).toBe(403);
      expect(body).toEqual({ error: 'SIGNATURE_NOT_VERIFIED' });
      expect(await db.nodeSignature.count()).toBe(0);
    });

    it('writer eligibility lost: refused, nothing recorded', async () => {
      const { r } = await attempt(async () => {
        await db.orgMember.deleteMany({ where: { userId: signer.id } });
      });
      expect(r.status).toBe(403);
      await expectNothing();
    });

    it('the memory encrypted: refused with ENCRYPTED_MEMORY_NOT_APPLICABLE, nothing recorded', async () => {
      const { r, body } = await attempt(async () => { await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true } }); });
      expect([403, 409]).toContain(r.status);
      expect(['ENCRYPTED_MEMORY_NOT_APPLICABLE', 'SIGNING_REQUEST_ENDED']).toContain(body.error);
      await expectNothing();
    });
  });

  it('two completes racing on one request: exactly one wins', async () => {
    const req = await openRequest();
    const p = await prove(req.id, signer);
    const q = await prove(req.id, signer, { counter: 2 });
    const results = await Promise.all([
      post(req.id, 'complete', signingBody(p, signer.key, { counter: 3 }), p.cookie),
      post(req.id, 'complete', signingBody(q, signer.key, { counter: 4 }), q.cookie),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db.nodeSignature.count()).toBe(1);
    expect((await db.signingRequest.findUniqueOrThrow({ where: { id: req.id } })).state).toBe('completed');
  });
});

describe('declining', () => {
  it('the proven signer declines: the request ends declined, once', async () => {
    const req = await openRequest();
    const p = await prove(req.id, signer);
    const r = await post(req.id, 'decline', { ceremonyId: p.json.signing.ceremonyId }, p.cookie);
    expect(r.status).toBe(200);
    expect((await db.signingRequest.findUniqueOrThrow({ where: { id: req.id } })).state).toBe('declined');
    expect(await db.nodeSignature.count()).toBe(0);
    const again = await post(req.id, 'decline', { ceremonyId: p.json.signing.ceremonyId }, p.cookie);
    expect(again.status).not.toBe(200);
  });

  it('refuses a decline with no proof: another browser, no ceremony, a ceremony of another request', async () => {
    const a = await openRequest();
    const b = await openRequest();
    const pa = await prove(a.id, signer);
    const stranger = await post(a.id, 'proof/challenge', {});
    const strangerCookie = (stranger.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect((await post(a.id, 'decline', { ceremonyId: pa.json.signing.ceremonyId }, strangerCookie)).status).toBe(403);
    expect((await post(a.id, 'decline', {}, pa.cookie)).status).toBe(403);
    expect((await post(b.id, 'decline', { ceremonyId: pa.json.signing.ceremonyId }, pa.cookie)).status).toBe(403);
    expect((await db.signingRequest.findUniqueOrThrow({ where: { id: a.id } })).state).toBe('open');
    expect((await db.signingRequest.findUniqueOrThrow({ where: { id: b.id } })).state).toBe('open');
  });
});

describe('the signing ceremony binding (database)', () => {
  it('a SIGN ceremony binds a user once and carries no other registration field', async () => {
    const insert = (purpose: string, extra = '') => db.$executeRawUnsafe(
      `INSERT INTO passkey_ceremonies (id, purpose, browser_nonce_hash, challenge_hash, expires_at, user_id, kind ${extra ? ', ' + extra.split('=')[0] : ''})
       VALUES ($1, $2, $3, $4, now() + interval '5 minutes', $5, $6 ${extra ? ', ' + extra.split('=')[1] : ''})`,
      `ceremony-${purpose}-${extra.length}-${Math.random().toString(36).slice(2, 10)}`.padEnd(24, 'x'), purpose, 'a'.repeat(64), 'b'.repeat(64), signer.id, 'sign');
    await expect(insert('SIGN')).resolves.toBeDefined();
    // Not a SIGN ceremony: user_id with kind 'sign' is still refused for every other purpose.
    await expect(insert('SIGN_IN')).rejects.toThrow();
    await expect(insert('SIGN_PROOF')).rejects.toThrow();
    // A SIGN ceremony with a WebAuthn user handle (a registration field) is refused.
    await expect(insert('SIGN', `user_handle='\\x${'00'.repeat(32)}'::bytea`)).rejects.toThrow();
  });
});
