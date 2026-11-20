/**
 * hadron-server#4545 (hrn:node:hadronmemory.com:specs:cor:sec:060:02) — SecretReadClient.revealUrl: the server-built link to the
 * person reveal page, mirroring GrantSigningRequest.ceremonyUrl. Red-first pins:
 *  1. a person holder reads the URL from one field: the server origin plus /secret-reveal/<clientId>;
 *  2. it widens nobody's reach: an outsider, an impersonation and a run still see no client; a worker session, an App key and
 *     the issuer of another holder's client get null;
 *  3. it is null (not an error) for a client whose holder is not a person.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema, type GraphQLObjectType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

const BASE = 'https://hadron.example.test';
let ownerId: string; let workerId: string; let personClientId: string; let workerClientId: string; let secretId: string; let appId: string;
const ENV_KEYS = ['BASE_URL', 'HADRON_ENCRYPTION_KEY', 'SECRET_ROOT_KEY'] as const;
let savedEnv: Record<string, string | undefined> = {};
let agentId: string;
const ctxOf = (userId: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: [], ...extra } as unknown as Context);
const asWorker = <T>(id: string | null, p: () => Promise<T>) => runAsActor({ workerId: id, agentId: null }, p);
type Row = { clientId: string; revealUrl?: string | null };
const list = (ctx: Context, worker: string | null = null): Promise<Row[]> =>
  asWorker(worker, () => resolvers.Query.mySecretReadClients({}, {}, ctx) as Promise<Row[]>);
const byId = (rows: Row[], id: string) => rows.find((r) => r.clientId === id);

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.BASE_URL = BASE;
  process.env.HADRON_ENCRYPTION_KEY = '11'.repeat(32);
  process.env.SECRET_ROOT_KEY = '22'.repeat(32);
  await cleanDb(db); await upsertPlatformActions(db);
  ownerId = (await db.user.create({ data: { email: `${generateId()}@4545.test` } })).id;
  const app = await db.app.create({ data: { name: 'R4545', ownerUserId: ownerId, urn: `${generateId().toLowerCase()}:rv` } });
  appId = app.id;
  const agent = await db.agent.create({ data: { ownerUserId: ownerId, name: 'a', urn: `${generateId().toLowerCase()}:ag` } as never });
  agentId = agent.id;
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'w1', slug: 'w1' } })).id;
  secretId = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: app.id, name: 'tok', kind: 'generic', value: 'hunter2' }, ctxOf(ownerId))).id;
  const issue = async (holderKind: 'USER' | 'WORKER', holderRef?: string) =>
    ((await resolvers.Mutation.issueSecretReadClient({}, { input: { secretRef: secretId, holderKind, holderRef, autoDelete: false, maxReads: 2, reason: 'need it' } }, ctxOf(ownerId))) as { clientId: string }).clientId;
  personClientId = await issue('USER');
  workerClientId = await issue('WORKER', workerId);
});

afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

describe('#4545 SecretReadClient.revealUrl', () => {
  it('the SDL carries a nullable revealUrl on SecretReadClient', () => {
    const field = (buildSchema(typeDefs).getType('SecretReadClient') as GraphQLObjectType).getFields().revealUrl;
    expect(field).toBeDefined();
    expect(String(field?.type)).toBe('String');
  });

  it('a person holder gets the server origin plus /secret-reveal/<clientId>, built by the server', async () => {
    const row = byId(await list(ctxOf(ownerId)), personClientId);
    expect(row).toBeDefined();
    expect(row?.revealUrl).toBe(`${BASE}/secret-reveal/${personClientId}`);
  });

  it('null, not an error, for a client whose holder is not a person (the issuer sees the row, not a URL)', async () => {
    const row = byId(await list(ctxOf(ownerId)), workerClientId);
    expect(row).toBeDefined();
    expect(row?.revealUrl).toBeNull();
  });

  it('a worker session never gets the URL: the worker holder sees its row with null, and the person\'s client is not listed', async () => {
    const rows = await list(ctxOf(ownerId), workerId);
    expect(byId(rows, workerClientId)).toHaveProperty('revealUrl', null);
    expect(byId(rows, personClientId)).toBeUndefined();
  });

  it('Secret.readClients (the manager view) follows the same rule: the holder gets the URL, a worker-held row null', async () => {
    const page = (ctx: Context) => asWorker(null, () =>
      (resolvers as any).Secret.readClients({ id: secretId, ownerType: 'app', ownerId: appId }, {}, ctx) as Promise<{ items: Row[] }>);
    const items = (await page(ctxOf(ownerId))).items;
    expect(byId(items, personClientId)?.revealUrl).toBe(`${BASE}/secret-reveal/${personClientId}`);
    expect(byId(items, workerClientId)).toHaveProperty('revealUrl', null);
  });

  it('the manager view in a worker session hands over no URL, even for the driving person\'s own client', async () => {
    const managed = await asWorker(workerId, () =>
      (resolvers as any).Secret.readClients({ id: secretId, ownerType: 'app', ownerId: appId }, {}, ctxOf(ownerId)) as Promise<{ items: Array<Row & { clientPrefix: string }> }>);
    const own = managed.items.find((r) => r.clientPrefix === personClientId.slice(0, 8));
    expect(own).toBeDefined();
    expect(own).toHaveProperty('revealUrl', null);
    for (const r of managed.items) expect(r).toHaveProperty('revealUrl', null);
  });

  it('an agent-bound session gets no URL, in either list, even for the person\'s own client', async () => {
    const asAgent = <T>(p: () => Promise<T>) => runAsActor({ workerId: null, agentId }, p);
    const mine = await asAgent(() => resolvers.Query.mySecretReadClients({}, {}, ctxOf(ownerId)) as Promise<Row[]>);
    expect(byId(mine, personClientId)).toHaveProperty('revealUrl', null);
    const managed = await asAgent(() =>
      (resolvers as any).Secret.readClients({ id: secretId, ownerType: 'app', ownerId: appId }, {}, ctxOf(ownerId)) as Promise<{ items: Row[] }>);
    expect(byId(managed.items, personClientId)).toHaveProperty('revealUrl', null);
  });

  it('an App key session gets no URL even if a user rides along', async () => {
    const rows = await list(ctxOf(ownerId, { appKeyId: 'k1', appId: 'a1' } as Partial<Context>));
    for (const r of rows) expect(r).toHaveProperty('revealUrl', null);
    expect(byId(rows, personClientId)?.revealUrl ?? null).toBeNull();
  });

  it('another person holder\'s client: its issuer sees the row with null, only that holder gets the URL', async () => {
    // Today a USER client is always self-issued, so plant the shape directly: a person-held client whose holder is not the issuer
    // (as an account merge or a later issuance rule could leave it). The issuer still lists it, and must not receive the link.
    const other = (await db.user.create({ data: { email: `${generateId()}@4545.test` } })).id;
    const { grantId } = await db.secretReadClient.findUniqueOrThrow({ where: { id: personClientId } });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
      await tx.$executeRawUnsafe('UPDATE grants SET user_id = $2 WHERE id = $1', grantId, other);
      await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
    });
    expect(byId(await list(ctxOf(ownerId)), personClientId)).toHaveProperty('revealUrl', null);
    expect(byId(await list(ctxOf(other)), personClientId)?.revealUrl).toBe(`${BASE}/secret-reveal/${personClientId}`);
    // The manager view (the App owner manages it) lists the row too, and still hands over no link it does not hold.
    const managed = await asWorker(null, () =>
      (resolvers as any).Secret.readClients({ id: secretId, ownerType: 'app', ownerId: appId }, {}, ctxOf(ownerId)) as Promise<{ items: Row[] }>);
    expect(byId(managed.items, personClientId)).toHaveProperty('revealUrl', null);
  });

  it('the no-worker and no-agent holder tests stand on chk_grants_exactly_one_holder: a person grant cannot also name either', async () => {
    const { grantId } = await db.secretReadClient.findUniqueOrThrow({ where: { id: personClientId } });
    // The transaction ALWAYS rolls back: if the update ever succeeds, the sentinel throw undoes it together with the disabled
    // trigger, so a regression in the constraint cannot leak a disabled guard or a malformed grant into later tests (Diego P2).
    const ROLLBACK = 'rollback-4545';
    const plant = (col: 'worker_id' | 'agent_id', id: string) => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
      await tx.$executeRawUnsafe(`UPDATE grants SET ${col} = $2 WHERE id = $1`, grantId, id);
      throw new Error(ROLLBACK);
    }).then(() => 'COMMITTED', (e: Error) => e.message);
    expect(await plant('worker_id', workerId)).toContain('chk_grants_exactly_one_holder');
    expect(await plant('agent_id', agentId)).toContain('chk_grants_exactly_one_holder');
    // Nothing leaked: the grant is unchanged and the guard trigger is still enabled.
    expect(await db.grant.findUniqueOrThrow({ where: { id: grantId }, select: { userId: true, workerId: true, agentId: true } }))
      .toEqual({ userId: ownerId, workerId: null, agentId: null });
    const [{ tgenabled }] = await db.$queryRawUnsafe<Array<{ tgenabled: string }>>(
      `SELECT tgenabled FROM pg_trigger WHERE tgname = 'grants_guard' AND tgrelid = 'grants'::regclass`);
    expect(tgenabled).not.toBe('D');
  });

  it('the manager view widens nobody either: an App key, an impersonation and a run get an empty page', async () => {
    const page = (ctx: Context) => asWorker(null, () =>
      (resolvers as any).Secret.readClients({ id: secretId, ownerType: 'app', ownerId: appId }, {}, ctx) as Promise<{ items: Row[] }>);
    for (const extra of [{ appKeyId: 'k1', appId }, { impersonation: { by: 'x' } }, { clientId: 'run:r1', appId }] as Array<Partial<Context>>) {
      expect((await page(ctxOf(ownerId, extra))).items).toEqual([]);
    }
  });

  it('widens nobody: an outsider, an impersonation and a run see no client at all, unchanged', async () => {
    const outsider = (await db.user.create({ data: { email: `${generateId()}@4545.test` } })).id;
    expect(await list(ctxOf(outsider))).toEqual([]);
    expect(await list(ctxOf(ownerId, { impersonation: { by: 'x' } } as never))).toEqual([]);
    expect(await list(ctxOf(ownerId, { clientId: 'run:r1', appId: 'a1' } as Partial<Context>))).toEqual([]);
  });
});
