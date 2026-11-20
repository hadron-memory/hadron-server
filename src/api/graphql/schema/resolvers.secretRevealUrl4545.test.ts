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
let ownerId: string; let workerId: string; let personClientId: string; let workerClientId: string;
let savedBase: string | undefined;
const ctxOf = (userId: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: [], ...extra } as unknown as Context);
const asWorker = <T>(id: string | null, p: () => Promise<T>) => runAsActor({ workerId: id, agentId: null }, p);
type Row = { clientId: string; revealUrl?: string | null };
const list = (ctx: Context, worker: string | null = null): Promise<Row[]> =>
  asWorker(worker, () => resolvers.Query.mySecretReadClients({}, {}, ctx) as Promise<Row[]>);
const byId = (rows: Row[], id: string) => rows.find((r) => r.clientId === id);

beforeEach(async () => {
  savedBase = process.env.BASE_URL;
  process.env.BASE_URL = BASE;
  process.env.HADRON_ENCRYPTION_KEY = '11'.repeat(32);
  process.env.SECRET_ROOT_KEY = '22'.repeat(32);
  await cleanDb(db); await upsertPlatformActions(db);
  ownerId = (await db.user.create({ data: { email: `${generateId()}@4545.test` } })).id;
  const app = await db.app.create({ data: { name: 'R4545', ownerUserId: ownerId, urn: `${generateId().toLowerCase()}:rv` } });
  const agent = await db.agent.create({ data: { ownerUserId: ownerId, name: 'a', urn: `${generateId().toLowerCase()}:ag` } as never });
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'w1', slug: 'w1' } })).id;
  const secretId = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: app.id, name: 'tok', kind: 'generic', value: 'hunter2' }, ctxOf(ownerId))).id;
  const issue = async (holderKind: 'USER' | 'WORKER', holderRef?: string) =>
    ((await resolvers.Mutation.issueSecretReadClient({}, { input: { secretRef: secretId, holderKind, holderRef, autoDelete: false, maxReads: 2, reason: 'need it' } }, ctxOf(ownerId))) as { clientId: string }).clientId;
  personClientId = await issue('USER');
  workerClientId = await issue('WORKER', workerId);
});

afterEach(() => {
  if (savedBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = savedBase;
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

  it('a worker session never gets the URL: neither the worker holder nor the person holder driving a worker', async () => {
    const rows = await list(ctxOf(ownerId), workerId);
    expect(byId(rows, workerClientId)).toHaveProperty('revealUrl', null);
    // The person's own client may show in the list, but its URL is not handed to the worker session.
    const own = byId(rows, personClientId);
    expect(own).toBeDefined();
    expect(own).toHaveProperty('revealUrl', null);
  });

  it('an App key session gets no URL even if a user rides along', async () => {
    const rows = await list(ctxOf(ownerId, { appKeyId: 'k1', appId: 'a1' } as Partial<Context>));
    expect(byId(rows, personClientId)).toHaveProperty('revealUrl', null);
  });

  it('widens nobody: an outsider, an impersonation and a run see no client at all, unchanged', async () => {
    const outsider = (await db.user.create({ data: { email: `${generateId()}@4545.test` } })).id;
    expect(await list(ctxOf(outsider))).toEqual([]);
    expect(await list(ctxOf(ownerId, { impersonation: { by: 'x' } } as never))).toEqual([]);
    expect(await list(ctxOf(ownerId, { clientId: 'run:r1', appId: 'a1' } as Partial<Context>))).toEqual([]);
  });
});
