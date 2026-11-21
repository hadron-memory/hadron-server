/**
 * #4635 (follow-up to #4001 S6): SECRET_AUTO_DELETE_NEEDS_LIMIT through the signing HTTP transport.
 *
 * A historical pending `secret.reveal` mark with auto-delete 'delete' and neither an expiry nor a use budget (written
 * before the trigger's guard existed) is refused at completion by `completeGrantSigning` with the typed
 * SECRET_AUTO_DELETE_NEEDS_LIMIT (pinned at the library door in resolvers.secretAutoDelete4001.test.ts). The ceremony's
 * completion route types only four refusals (SIGNING_REQUEST_ENDED, SIGNATURE_NOT_VERIFIED, SIGNER_NOT_ELIGIBLE,
 * PASSKEY_COOLING_OFF); every other refusal is the uniform bare 403. This file pins what the person's browser actually
 * receives TODAY, so a later recovery message (the reload-wording item of #4635, waiting on a product ruling) changes
 * these lines on purpose instead of by accident.
 *
 * WHAT THIS DOES NOT PROVE: which layer refused. With the library check removed (mutant: the NEEDS_LIMIT throw in
 * completeGrantSigning), the activating UPDATE still hits the database trigger and rolls back, and the route answers the
 * same bare 403 with nothing written, so this file survives that mutant by design. The TYPED refusal is proved at the
 * library door (resolvers.secretAutoDelete4001.test.ts, 'rechecks a historical unbounded pending mark at signing'); this
 * file pins only the outward answer and the nothing-written state.
 *
 * The signing request has no GraphQL completion door (GraphQL only creates and withdraws requests), so the HTTP route is
 * the one external mapping of this refusal.
 */
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { insertSoftPasskey, softPasskey, type SoftPasskey } from '../test/softPasskey.js';
import { upsertPlatformActions } from '../lib/grants/actions.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { createGrantSigningRequestInTransaction } from '../lib/signing/grantRequests.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';
const FORBIDDEN = '{"error":"forbidden"}';

let server: Server | undefined;
let base: string;
let appId: string;
let workerId: string;
let secretId: string;
let requester: { id: string };
let admin: { id: string; key: SoftPasskey };

beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', RP);
  vi.stubEnv('SIGNING_CEREMONY_ORIGINS', ORIGIN);
  await upsertPlatformActions(db);
  const { org } = await createDbOrgAndGraph(db, { orgName: 'nl-org', graphName: 'nl' });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'nl-app', urn: `${org.urn}:nl-app` } });
  appId = app.id;
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'nl-agent', urn: `${org.urn}:nl-agent` } });
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name: 'nl-worker', slug: 'nl-worker' } })).id;
  secretId = (await db.secret.create({ data: { ownerType: 'app', ownerId: appId, name: 'nl-token', kind: 'revealable' } as never })).id;
  requester = await db.user.create({ data: { handle: 'nl-requester', roles: [] } });
  const u = await db.user.create({ data: { handle: 'nl-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: u.id, role: 'ADMIN' } });
  const key = softPasskey();
  await insertSoftPasskey(db, u.id, key, { label: 'nl-admin key' });
  admin = { id: u.id, key };
  server = httpServer(await createServer());
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
  server = undefined;
  vi.unstubAllEnvs();
});

/** A pending mark written the way the old generic door wrote it: the limit trigger is disabled for the insert and enabled again (the migration's own definition stays in place). */
async function historicalMark(terms: { expiresInSeconds: number | null }): Promise<string> {
  const id = generateId();
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER secret_auto_delete_limit');
    await tx.$executeRawUnsafe(
      `INSERT INTO grants (id, app_id, worker_id, action, action_values, reason, max_uses, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'secret.reveal', $4::jsonb, 'historical mark', NULL,
         CASE WHEN $5::int IS NULL THEN NULL ELSE (clock_timestamp() AT TIME ZONE 'UTC') + make_interval(secs => $5::int) END,
         (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'))`,
      id, appId, workerId, JSON.stringify({ secret: secretId, 'auto-delete': 'delete' }), terms.expiresInSeconds,
    );
    await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER secret_auto_delete_limit');
  });
  return id;
}
const openRequest = (grantId: string) => db.$transaction((tx) => createGrantSigningRequestInTransaction(tx, grantId, {
  appId, requester: { userId: requester.id, appId: null, workerId: null, sessionId: null },
}));
const post = (id: string, path: string, body: unknown, cookie?: string) =>
  fetch(`${base}/grant-signing/${id}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });
const assertionBody = (ceremonyId: string, key: SoftPasskey, a: ReturnType<SoftPasskey['assert']>) => ({
  ceremonyId, credentialId: key.credentialId.toString('base64url'),
  authenticatorData: a.authenticatorData.toString('base64url'),
  clientDataJson: a.clientDataJson.toString('base64url'), signature: a.signature.toString('base64url'),
});

/** Proof then the signing challenge, returning the body of the completion the browser would post. */
async function readyToComplete(requestId: string) {
  const c = await post(requestId, 'proof/challenge', {});
  const preCookie = (c.headers.get('set-cookie') ?? '').split(';')[0];
  const { ceremonyId, challenge } = await c.json() as { ceremonyId: string; challenge: string };
  const a = admin.key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(challenge, 'base64url'), origin: ORIGIN, rpId: RP, counter: 1 });
  const r = await post(requestId, 'proof', assertionBody(ceremonyId, admin.key, a), preCookie);
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0] || preCookie;
  const proof = await r.json() as { outcome?: string; canSign?: boolean };
  expect(proof).toMatchObject({ outcome: 'open', canSign: true });
  const s = await (await post(requestId, 'challenge', {}, cookie)).json() as { ceremonyId: string; challenge: string };
  const sa = admin.key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(s.challenge, 'base64url'), origin: ORIGIN, rpId: RP, counter: 2 });
  return { cookie, body: assertionBody(s.ceremonyId, admin.key, sa) };
}
const grantRow = (id: string) => db.grant.findUniqueOrThrow({ where: { id } });

describe('#4635 SECRET_AUTO_DELETE_NEEDS_LIMIT over the signing HTTP transport', () => {
  it('a historical unbounded delete mark: completion answers the uniform bare 403, and nothing is written', async () => {
    const g = await historicalMark({ expiresInSeconds: null });
    const req = await openRequest(g);
    const { cookie, body } = await readyToComplete(req.id);
    const r = await post(req.id, 'complete', body, cookie);
    // Today's mapping: the typed refusal is not one of the four the route names, so the person gets the uniform
    // refusal (no code, no hint). A recovery message would change exactly these two lines.
    expect(r.status).toBe(403);
    expect(await r.text()).toBe(FORBIDDEN);
    expect((await grantRow(g)).activatedAt).toBeNull();
    expect(await db.grantSignature.count({ where: { grantId: g } })).toBe(0);
    expect(await db.secretReadClient.count({ where: { grantId: g } })).toBe(0);
    expect(await db.grantEvent.count({ where: { grantId: g, action: 'ACTIVATE' } })).toBe(0);
    // The refusal is judged before the request is touched: the request stays open (a reload re-offers the same dead end).
    expect((await db.grantSigningRequest.findUniqueOrThrow({ where: { id: req.id } })).state).toBe('open');
  });

  it('negative control: the same mark with a finite end completes and activates', async () => {
    const g = await historicalMark({ expiresInSeconds: 3600 });
    const req = await openRequest(g);
    const { cookie, body } = await readyToComplete(req.id);
    const r = await post(req.id, 'complete', body, cookie);
    expect(r.status).toBe(200);
    expect((await grantRow(g)).activatedAt).toBeInstanceOf(Date);
  });
});
