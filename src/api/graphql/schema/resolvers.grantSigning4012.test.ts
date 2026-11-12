/**
 * #4012 (cor:acl:140:07 as built; the manager arm of cor:acl:140:05 List): a person acting as themselves who manages the
 * grant's live installed App may ask for, read and (as the requester) withdraw a grant signing request, beside the bound worker.
 * The positives are red on main; the refusals pin behaviour main already has and are carried by the mutants named in the PR.
 * Every refusal snapshots requests, grants and writers: nothing is written. Real GraphQL POSTs, the deployed error formatter.
 */
import { ApolloServer } from '@apollo/server';
import { randomBytes } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { USER_API_KEY_PREFIX, hashUserApiKey } from '../../../middleware/auth.js';
import { dropTestActions, insertGrant, seedWorld, type World } from '../../../lib/grants/grantFixtures3668.js';
import type { Context } from './resolvers.js';
import { deploymentSchema } from './deploymentSchema.js';
import { formatGraphQLError } from '../formatError.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let http: Server;
let base: string;
let direct: ApolloServer<Context>;
beforeAll(async () => {
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  const { createServer } = await import('../../../server.js');
  http = httpServer(await createServer());
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const schema = deploymentSchema();
  direct = new ApolloServer<Context>({ typeDefs: schema.typeDefs, resolvers: schema.resolvers, formatError: formatGraphQLError, includeStacktraceInErrorResponses: false });
  await direct.start();
});
afterAll(async () => { await new Promise<void>((r) => http.close(() => r())); await direct.stop(); await cleanDb(db); await dropTestActions(); vi.unstubAllEnvs(); });

let w: World;
let workerKey: string; let sessionId: string;
let mgrId: string; let mgrKey: string;
let outsiderKey: string; // a live Org ADMIN of ANOTHER org: manages no App here
let memberKey: string; // a CONTRIBUTOR of this org: reads no grant here

async function keyFor(userId: string): Promise<string> {
  const k = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { userId, oauthScopes: [], keyHash: hashUserApiKey(k), keyPreview: k.slice(-4) } });
  return k;
}
async function post(key: string, session: string | null, query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(session ? { 'x-hadron-session': session } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}
const REQUEST = 'mutation($g:ID!){requestGrantSignature(grantRef:$g){id grantId version state ceremonyUrl requestedBy{userId appId workerId sessionId}}}';
const WITHDRAW = 'mutation($id:ID!){withdrawGrantSigningRequest(id:$id){id state endedAt}}';
const READ = 'query($id:ID!){grantSigningRequest(id:$id){id grantId state requestedBy{userId workerId}}}';
const asWorker = (q: string, v: Record<string, unknown> = {}) => post(workerKey, sessionId, q, v);
const asManager = (q: string, v: Record<string, unknown> = {}) => post(mgrKey, null, q, v);
const code = (r: any): string | undefined => r.errors?.[0]?.extensions?.code;
const held = (over: Record<string, unknown> = {}) => insertGrant(w, { user_id: null, worker_id: w.workerId, ...over } as never);

/** Requests, grants and the rows a signing write could touch, as one comparable string. */
async function snapshot(): Promise<string> {
  const [requests, grants, writers] = await Promise.all([
    db.$queryRawUnsafe(`SELECT * FROM grant_signing_requests ORDER BY id`),
    db.$queryRawUnsafe(`SELECT * FROM grants ORDER BY id`),
    db.$queryRawUnsafe(`SELECT id, updated_at FROM workers ORDER BY id`),
  ]);
  return JSON.stringify([requests, grants, writers], (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: w.userId, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: w.user2Id, role: 'CONTRIBUTOR' } });
  await db.worker.update({ where: { id: w.workerId }, data: { heldByUserId: w.userId } });
  sessionId = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: w.userId, workerId: w.workerId, agentId: w.agentId } })).id;
  workerKey = await keyFor(w.userId);
  memberKey = await keyFor(w.user2Id);
  const tag = generateId().slice(0, 8);
  const mgr = await db.user.create({ data: { handle: `m-${tag}` } });
  mgrId = mgr.id;
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: mgrId, role: 'ADMIN' } });
  mgrKey = await keyFor(mgrId);
  const org2 = await db.organization.create({ data: { name: `o2-${tag}`, urn: `o2-${tag}.test` } });
  const out = await db.user.create({ data: { handle: `x-${tag}` } });
  await db.orgMember.create({ data: { organizationId: org2.id, userId: out.id, role: 'ADMIN' } });
  outsiderKey = await keyFor(out.id);
});

describe('the manager arm: a person who manages the grant\'s App asks, reads and withdraws', () => {
  it('requests a pending grant held by a worker, recorded as the person, with the exact ceremony URL', async () => {
    vi.stubEnv('BASE_URL', 'https://hadron.example.test');
    try {
      const g = await held();
      const r = await asManager(REQUEST, { g });
      expect(r.errors).toBeUndefined();
      const q = r.data.requestGrantSignature;
      expect(q).toMatchObject({ grantId: g, state: 'OPEN', requestedBy: { userId: mgrId, appId: null, workerId: null, sessionId: null } });
      expect(q.ceremonyUrl).toBe(`https://hadron.example.test/grant-signing/${q.id}`);
      expect(await db.grantSigningRequest.count()).toBe(1);
    } finally { vi.unstubAllEnvs(); vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true'); }
  });

  it('also asks for a pending grant a worker requested, and while a worker\'s request on the grant is open (both rows stay open)', async () => {
    const requested = await insertGrant(w, { requested_by_worker_id: w.workerId });
    expect((await asManager(REQUEST, { g: requested })).data.requestGrantSignature.grantId).toBe(requested);
    const g = await held();
    const workerAsked = (await asWorker(REQUEST, { g })).data.requestGrantSignature.id;
    const managerAsked = (await asManager(REQUEST, { g })).data.requestGrantSignature.id;
    expect(managerAsked).not.toBe(workerAsked);
    const open = await db.grantSigningRequest.findMany({ where: { grantId: g } });
    expect(open.map((x) => x.state)).toEqual(['open', 'open']);
  });

  it('reads a worker\'s request by id, and its own', async () => {
    const g = await held();
    const id = (await asWorker(REQUEST, { g })).data.requestGrantSignature.id;
    expect((await asManager(READ, { id })).data.grantSigningRequest).toMatchObject({ id, grantId: g, state: 'OPEN', requestedBy: { userId: w.userId, workerId: w.workerId } });
    const own = (await asManager(REQUEST, { g })).data.requestGrantSignature.id;
    expect((await asManager(READ, { id: own })).data.grantSigningRequest).toMatchObject({ id: own, requestedBy: { userId: mgrId, workerId: null } });
  });

  it('withdraws its own request; refuses SIGNING_REQUEST_NOT_REQUESTER on a worker\'s, and the worker on the manager\'s', async () => {
    const g = await held();
    const workerId = (await asWorker(REQUEST, { g })).data.requestGrantSignature.id;
    const mine = (await asManager(REQUEST, { g })).data.requestGrantSignature.id;
    const before = await snapshot();
    expect(code(await asManager(WITHDRAW, { id: workerId }))).toBe('SIGNING_REQUEST_NOT_REQUESTER');
    expect(code(await asWorker(WITHDRAW, { id: mine }))).toBe('SIGNING_REQUEST_NOT_REQUESTER');
    expect(await snapshot()).toBe(before);
    const r = await asManager(WITHDRAW, { id: mine });
    expect(r.errors).toBeUndefined();
    expect(r.data.withdrawGrantSigningRequest.state).toBe('WITHDRAWN');
    expect((await db.grantSigningRequest.findUniqueOrThrow({ where: { id: workerId } })).state).toBe('open');
  });

  it('an App-owner member who is not an Org admin manages the App too (the shared managesApp arms)', async () => {
    const tag = generateId().slice(0, 8);
    const u = await db.user.create({ data: { handle: `o-${tag}` } });
    await db.orgMember.create({ data: { organizationId: w.orgId, userId: u.id, role: 'CONTRIBUTOR' } });
    await db.appMember.create({ data: { appId: w.appId, userId: u.id, role: 'owner' } });
    const g = await held();
    expect((await post(await keyFor(u.id), null, REQUEST, { g })).data.requestGrantSignature.grantId).toBe(g);
  });
});

describe('concealment: one miss, byte for byte, and nothing written', () => {
  const NONE = 'AAAAAAAAAAAAAAAAAAAAAA';
  async function expectMisses(key: string, session: string | null, g: string, id: string): Promise<void> {
    const before = await snapshot();
    const norm = (r: any, v: string, o: string) => JSON.stringify(r).replaceAll(v, 'X').replaceAll(o, 'X');
    const req = await post(key, session, REQUEST, { g });
    const wd = await post(key, session, WITHDRAW, { id });
    const rd = await post(key, session, READ, { id });
    expect(code(req)).toBe('GRANT_NOT_FOUND');
    expect(code(wd)).toBe('SIGNING_REQUEST_NOT_FOUND');
    expect(rd.data.grantSigningRequest).toBeNull();
    expect(norm(req, g, 'no-such-grant')).toBe(norm(await post(key, session, REQUEST, { g: 'no-such-grant' }), g, 'no-such-grant'));
    expect(norm(wd, id, NONE)).toBe(norm(await post(key, session, WITHDRAW, { id: NONE }), id, NONE));
    expect(await snapshot()).toBe(before);
  }

  it('a non-manager member and a manager of ANOTHER org', async () => {
    const g = await held();
    const id = (await asWorker(REQUEST, { g })).data.requestGrantSignature.id;
    await expectMisses(memberKey, null, g, id);
    await expectMisses(outsiderKey, null, g, id);
  });

  it('a grant of another App the manager does not manage, a missing grant and a malformed ref', async () => {
    const tag = generateId().slice(0, 8);
    const org2 = await db.organization.create({ data: { name: `o3-${tag}`, urn: `o3-${tag}.test` } });
    const app2 = await db.app.create({ data: { organizationId: org2.id, name: 'foreign', urn: `${org2.urn}:app` } });
    const foreignWorker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app2.id, agentId: w.agentId, name: 'f', slug: `f-${tag}` } });
    const foreign = await insertGrant({ ...w, appId: app2.id }, { app_id: app2.id, user_id: null, worker_id: foreignWorker.id } as never);
    const g = await held();
    const id = (await asWorker(REQUEST, { g })).data.requestGrantSignature.id;
    const before = await snapshot();
    expect(code(await asManager(REQUEST, { g: 'no-such-grant' }))).toBe('GRANT_NOT_FOUND');
    expect(code(await asManager(REQUEST, { g: '' }))).toBe('GRANT_NOT_FOUND');
    expect(code(await asManager(REQUEST, { g: foreign }))).toBe('GRANT_NOT_FOUND');
    expect((await asManager(READ, { id: 'x'.repeat(3000) })).data.grantSigningRequest).toBeNull();
    expect(await snapshot()).toBe(before);
    expect(id).toBeTruthy();
  });

  it('an uninstalled App: request, read and withdraw all miss for the manager and for the worker (the query path has no write anchor)', async () => {
    const g = await held();
    const id = (await asWorker(REQUEST, { g })).data.requestGrantSignature.id;
    await db.app.update({ where: { id: w.appId }, data: { uninstalledAt: new Date() } });
    await expectMisses(mgrKey, null, g, id);
    const before = await snapshot();
    expect((await asWorker(READ, { id })).data.grantSigningRequest).toBeNull();
    expect(code(await asWorker(REQUEST, { g }))).toBe('GRANT_NOT_FOUND');
    expect(await snapshot()).toBe(before);
  });

  it('a deleted App misses the same way', async () => {
    const g = await held();
    const id = (await asWorker(REQUEST, { g })).data.requestGrantSignature.id;
    await db.app.update({ where: { id: w.appId }, data: { deletedAt: new Date() } });
    await expectMisses(mgrKey, null, g, id);
  });
});

describe('one arm per session: a worker binding never falls to the person arm', () => {
  it('a manager driving a RETIRED worker\'s session reads nothing, though the same person with no session reads the grant', async () => {
    const tag = generateId().slice(0, 8);
    const retired = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.appId, agentId: w.agentId, name: 'r', slug: `r-${tag}`, heldByUserId: mgrId, retiredAt: new Date() } });
    const s = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: mgrId, workerId: retired.id, agentId: w.agentId } })).id;
    const g = await held();
    const id = (await asWorker(REQUEST, { g })).data.requestGrantSignature.id;
    const before = await snapshot();
    expect(code(await post(mgrKey, s, REQUEST, { g }))).toBe('GRANT_NOT_FOUND');
    expect(code(await post(mgrKey, s, WITHDRAW, { id }))).toBe('SIGNING_REQUEST_NOT_FOUND');
    expect((await post(mgrKey, s, READ, { id })).data.grantSigningRequest).toBeNull();
    expect(await snapshot()).toBe(before);
    expect((await asManager(READ, { id })).data.grantSigningRequest.id).toBe(id);
  });

  it('a manager driving a LIVE worker of the App is the worker (exclusive): a grant that worker may not read is a miss', async () => {
    const tag = generateId().slice(0, 8);
    const live = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.appId, agentId: w.agentId, name: 'l', slug: `l-${tag}`, heldByUserId: mgrId } });
    const s = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: mgrId, workerId: live.id, agentId: w.agentId } })).id;
    const g = await held(); // another worker's grant
    expect(code(await post(mgrKey, s, REQUEST, { g }))).toBe('GRANT_NOT_FOUND');
    expect(await db.grantSigningRequest.count()).toBe(0);
  });
});

describe('ceilings: an App key, a run and an impersonated manager reach nothing', () => {
  it('an App key is GRANT_NOT_FOUND; an impersonated manager FORBIDDEN; nothing written', async () => {
    const g = await held();
    const before = await snapshot();
    const key = await direct.executeOperation({ query: REQUEST, variables: { g } }, { contextValue: { db, appId: w.appId, appKeyId: generateId(), roles: [] } as Context });
    if (key.body.kind !== 'single') throw new Error('incremental');
    expect(key.body.singleResult.errors?.[0]?.extensions?.code).toBe('GRANT_NOT_FOUND');
    const ctx = { db, userId: mgrId, roles: [], impersonation: { sessionId: generateId(), actorUserId: w.user2Id, orgId: w.orgId, expiresAt: new Date(Date.now() + 60_000) } } as Context;
    const imp = await direct.executeOperation({ query: REQUEST, variables: { g } }, { contextValue: ctx });
    if (imp.body.kind !== 'single') throw new Error('incremental');
    expect(imp.body.singleResult.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(await snapshot()).toBe(before);
  });

  it('a headless run acting for a manager (clientId run:*) is the miss on all three, and writes nothing', async () => {
    const g = await held();
    const id = (await asWorker(REQUEST, { g })).data.requestGrantSignature.id;
    const before = await snapshot();
    const ctx = { db, userId: mgrId, appId: w.appId, clientId: 'run:r1', roles: [] } as Context;
    for (const [query, variables, expected] of [[REQUEST, { g }, 'GRANT_NOT_FOUND'], [WITHDRAW, { id }, 'SIGNING_REQUEST_NOT_FOUND']] as const) {
      const r = await direct.executeOperation({ query, variables }, { contextValue: ctx });
      if (r.body.kind !== 'single') throw new Error('incremental');
      expect(r.body.singleResult.errors?.[0]?.extensions?.code).toBe(expected);
    }
    const read = await direct.executeOperation({ query: READ, variables: { id } }, { contextValue: ctx });
    if (read.body.kind !== 'single') throw new Error('incremental');
    expect((read.body.singleResult.data as any).grantSigningRequest).toBeNull();
    expect(await snapshot()).toBe(before);
  });

  it('a plain App member (not owner) who is only a CONTRIBUTOR of the org is the miss', async () => {
    const g = await held();
    const id = (await asWorker(REQUEST, { g })).data.requestGrantSignature.id;
    await db.appMember.create({ data: { appId: w.appId, userId: w.user2Id, role: 'member' } });
    const before = await snapshot();
    expect(code(await post(memberKey, null, REQUEST, { g }))).toBe('GRANT_NOT_FOUND');
    expect(code(await post(memberKey, null, WITHDRAW, { id }))).toBe('SIGNING_REQUEST_NOT_FOUND');
    expect((await post(memberKey, null, READ, { id })).data.grantSigningRequest).toBeNull();
    expect(await snapshot()).toBe(before);
  });
});

describe('the demotion fence: the manager is judged under the membership lock, on the transaction', () => {
  /** Demote the manager on a second connection and hold it uncommitted; commit once the request is waiting on that row. */
  async function demoteWhileRequestWaits<T>(run: () => Promise<T>, demotion = `UPDATE org_members SET role = 'CONTRIBUTOR' WHERE organization_id = $1 AND user_id = $2`, params: string[] = [w.orgId, mgrId]): Promise<T> {
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(demotion, params);
      const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid');
      const pending = run();
      let waited = false;
      for (let i = 0; i < 200 && !waited; i++) {
        await new Promise((res) => setTimeout(res, 25));
        const { rows: [{ n }] } = await blocker.query(`SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))`, [pid]);
        waited = Number(n) > 0;
      }
      expect(waited, 'the request waited on the manager\'s membership row, after its anchors').toBe(true);
      await blocker.query('COMMIT');
      return await pending;
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end();
    }
  }

  it('a request whose manager is demoted while it holds the anchors is the miss, and writes nothing', async () => {
    const g = await held();
    const before = await snapshot();
    const r = await demoteWhileRequestWaits(() => asManager(REQUEST, { g }));
    expect(code(r)).toBe('GRANT_NOT_FOUND');
    expect(await snapshot()).toBe(before);
  });

  it('a withdrawal by the same demoted manager is the miss, and the request stays open', async () => {
    const g = await held();
    const id = (await asManager(REQUEST, { g })).data.requestGrantSignature.id;
    const r = await demoteWhileRequestWaits(() => asManager(WITHDRAW, { id }));
    expect(code(r)).toBe('SIGNING_REQUEST_NOT_FOUND');
    expect((await db.grantSigningRequest.findUniqueOrThrow({ where: { id } })).state).toBe('open');
  });
});

describe('the demotion fence covers the app-owner arm too (app_members), not only the org role', () => {
  it('an App-owner member whose ownership is revoked while the request waits is the miss, and writes nothing', async () => {
    const tag = generateId().slice(0, 8);
    const u = await db.user.create({ data: { handle: `ow-${tag}` } });
    await db.orgMember.create({ data: { organizationId: w.orgId, userId: u.id, role: 'CONTRIBUTOR' } });
    await db.appMember.create({ data: { appId: w.appId, userId: u.id, role: 'owner' } });
    const key = await keyFor(u.id);
    const g = await held();
    const before = await snapshot();
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`UPDATE app_members SET role = 'member' WHERE app_id = $1 AND user_id = $2`, [w.appId, u.id]);
      const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid');
      const pending = post(key, null, REQUEST, { g });
      let waited = false;
      for (let i = 0; i < 200 && !waited; i++) {
        await new Promise((res) => setTimeout(res, 25));
        const { rows: [{ n }] } = await blocker.query(`SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))`, [pid]);
        waited = Number(n) > 0;
      }
      expect(waited, 'the request waited on the owner membership row').toBe(true);
      await blocker.query('COMMIT');
      expect(code(await pending)).toBe('GRANT_NOT_FOUND');
    } finally { await blocker.query('ROLLBACK').catch(() => undefined); await blocker.end(); }
    expect(await snapshot()).toBe(before);
  });
});

describe('the SDL and the file header name the two readers', () => {
  it('no description says the reader is "as grant(ref:) reads it"', () => {
    const { typeDefs } = deploymentSchema();
    const at = (field: string) => typeDefs.slice(typeDefs.indexOf(field) - 900, typeDefs.indexOf(field));
    for (const field of ['requestGrantSignature(grantRef', 'withdrawGrantSigningRequest(id', 'grantSigningRequest(id']) {
      expect(at(field), field).toMatch(/manages the (grant's live, installed )?App/);
      expect(at(field), field).not.toMatch(/as grant\(ref:\) reads it/);
    }
  });
});
