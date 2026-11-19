/** #3998 S3 (cor:sec:060, R5): the person holder's reveal runs only on the server-hosted passkey page, over real HTTP and a software passkey. */
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { insertSoftPasskey, softPasskey, type SoftPasskey } from '../test/softPasskey.js';
import { upsertPlatformActions } from '../lib/grants/actions.js';
import { resolvers, type Context } from './graphql/schema/resolvers.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';
let server: Server | undefined; let base: string;
let ownerId: string; let key: SoftPasskey; let secretId: string; let clientId: string; let grantId: string;
const ctxOf = (userId: string): Context => ({ db, userId, roles: [] } as unknown as Context);

async function activate(id: string) {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
    await tx.$executeRawUnsafe(`UPDATE grants SET activated_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 minute', verification_kind = 'passkey', verified_by = $2, issuer_user_id = $2 WHERE id = $1`, id, ownerId);
    await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
  });
}

beforeEach(async () => {
  process.env.HADRON_ENCRYPTION_KEY = '11'.repeat(32);
  process.env.SECRET_ROOT_KEY = '22'.repeat(32);
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true'); vi.stubEnv('PASSKEY_RP_ID', RP); vi.stubEnv('SIGNING_CEREMONY_ORIGINS', ORIGIN);
  await cleanDb(db); await upsertPlatformActions(db);
  ownerId = (await db.user.create({ data: { email: `${generateId()}@s3.test`, roles: [] } })).id;
  key = softPasskey();
  await insertSoftPasskey(db, ownerId, key, { label: 'k' });
  const app = await db.app.create({ data: { name: 'S3p', ownerUserId: ownerId, urn: `${generateId().toLowerCase()}:pv` } });
  secretId = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: app.id, name: 'tok', kind: 'generic', value: 'hunter2' }, ctxOf(ownerId))).id;
  const r: any = await resolvers.Mutation.issueSecretReadClient({}, { input: { secretRef: secretId, holderKind: 'USER', autoDelete: false, maxReads: 2, reason: 'need it' } }, ctxOf(ownerId));
  clientId = r.clientId; grantId = r.grantId;
  server = httpServer(await createServer());
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
  server = undefined; vi.unstubAllEnvs();
});

const post = (id: string, path: string, body: unknown, cookie?: string) => fetch(`${base}/secret-reveal/${id}/${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body ?? {}),
});

async function attempt(id: string, counter: number, signId = id) {
  const c = await post(id, 'challenge', {});
  const cookie = (c.headers.get('set-cookie') ?? '').split(';')[0];
  const { ceremonyId, challenge } = await c.json() as { ceremonyId: string; challenge: string };
  const a = key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(challenge, 'base64url'), origin: ORIGIN, rpId: RP, counter });
  const r = await post(signId, 'reveal', {
    ceremonyId, credentialId: key.credentialId.toString('base64url'), authenticatorData: a.authenticatorData.toString('base64url'),
    clientDataJson: a.clientDataJson.toString('base64url'), signature: a.signature.toString('base64url'),
  }, cookie);
  return { status: r.status, cache: r.headers.get('cache-control'), text: await r.text() };
}
const uses = () => db.grant.findUniqueOrThrow({ where: { id: grantId } }).then((g) => g.useCount);

describe('#3998 person reveal page', () => {
  it('serves the same no-store shell for every id', async () => {
    const a = await fetch(`${base}/secret-reveal/${clientId}`); const b = await fetch(`${base}/secret-reveal/nope`);
    expect(a.status).toBe(200); expect(a.headers.get('cache-control')).toBe('no-store');
    expect(await a.text()).toBe(await b.text());
  });

  it('a live grant reveals once per passkey assertion, spending one use each, no-store; the budget ends it', async () => {
    await activate(grantId);
    const a = await attempt(clientId, 1);
    expect(a.status).toBe(200); expect(a.cache).toBe('no-store');
    expect(JSON.parse(a.text)).toMatchObject({ secretName: 'tok', value: JSON.stringify('hunter2'), readsLeft: 1 });
    expect(await uses()).toBe(1);
    await attempt(clientId, 2);
    const c = await attempt(clientId, 3);
    expect(c.status).toBe(409); expect(JSON.parse(c.text)).toEqual({ error: 'SECRET_READ_CLIENT_SPENT' });
    expect(c.text).not.toContain('hunter2'); expect(await uses()).toBe(2);
    expect(await db.grantEvent.count({ where: { grantId, action: 'USE', actorUserId: ownerId } })).toBe(2);
  });

  it('a pending grant reveals nothing and spends nothing', async () => {
    const a = await attempt(clientId, 1);
    expect(a.status).toBe(409); expect(a.text).not.toContain('hunter2'); expect(await uses()).toBe(0);
  });

  it('an assertion made for another client id, or replayed, is the uniform refusal', async () => {
    await activate(grantId);
    expect((await attempt('other', 1, clientId)).text).toBe('{"error":"forbidden"}');
    expect(await uses()).toBe(0);
  });

  it('another person (a passkey that is not the holder) is the uniform refusal and spends nothing', async () => {
    await activate(grantId);
    const other = (await db.user.create({ data: { email: `${generateId()}@s3.test`, roles: [] } })).id;
    const ok = key; key = softPasskey(); await insertSoftPasskey(db, other, key, { label: 'o' });
    const r = await attempt(clientId, 1);
    key = ok;
    expect(r.status).toBe(403); expect(r.text).toBe('{"error":"forbidden"}'); expect(await uses()).toBe(0);
  });

  it('a bound worker driving the person cannot use the page', async () => {
    await activate(grantId);
    const { runAsActor } = await import('../lib/requestActor.js');
    // The page is HTTP: no request actor is ever bound there. The door itself refuses a bound worker (uniform).
    const { revealForPersonHolder } = await import('../lib/secrets/readClientReveal.js');
    const e = await runAsActor({ workerId: 'w', agentId: null }, () => revealForPersonHolder(ctxOf(ownerId), clientId)).catch((x) => x);
    expect(e.extensions.code).toBe('SECRET_READ_CLIENT_NOT_FOUND'); expect(await uses()).toBe(0);
  });
});
