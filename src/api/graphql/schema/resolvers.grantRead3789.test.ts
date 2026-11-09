/**
 * #3789 (Grants S2a-read, cor:acl:140:05 List, :03 live, :01): a bound worker reads the grants naming it DIRECTLY as holder,
 * plus the pending rows it requested itself, in its own App. Everything else is an empty page / null, never an error and
 * never a different answer from a missing row. Rows come from the S1a fixtures (no production writer exists). Pins go over
 * real GraphQL POSTs; callers a request cannot reach (App key, run principal, impersonation) go through the resolver.
 */
import { ApolloServer } from '@apollo/server';
import { randomBytes } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../../../server.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { USER_API_KEY_PREFIX, hashUserApiKey } from '../../../middleware/auth.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { DB_NOW, dbNowPlus, dropTestActions, insertGrant, insertGrantUnguarded, raw, seedWorld, type World } from '../../../lib/grants/grantFixtures3668.js';
import { isGrantLive } from '../../../lib/grants/live.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { formatGraphQLError } from '../formatError.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let http: Server;
let base: string;
const direct = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError, includeStacktraceInErrorResponses: false });
beforeAll(async () => {
  http = httpServer(await createServer());
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  await direct.start();
});
afterAll(async () => { await new Promise<void>((r) => http.close(() => r())); await direct.stop(); await cleanDb(db); await dropTestActions(); });

let w: World;
let rawKey: string;
let sessionId: string;
let otherAppWorkerId: string;
let otherSessionId: string;
let otherWorkerId: string;
let personKey: string;

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
const LIST = 'query($l:Int,$o:Int){grants(limit:$l,offset:$o){total items{id allows}}}';
const ONE = 'query($r:ID!){grant(ref:$r){id allows}}';
const asWorker = (q: string, v: Record<string, unknown> = {}) => post(rawKey, sessionId, q, v);
const ids = (r: any): string[] => (r.data.grants.items as Array<{ id: string }>).map((i) => i.id).sort();
const activated = { activated_at: raw(DB_NOW), verification_kind: 'TEST', verified_by: 'test' };
const live = (over: Record<string, unknown> = {}) => insertGrantUnguarded(w, { user_id: null, worker_id: w.workerId, ...activated, ...over } as never);

beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  const org = await db.organization.findUniqueOrThrow({ where: { id: w.orgId } });
  for (const userId of [w.userId, w.user2Id]) await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'CONTRIBUTOR' } });
  await db.worker.update({ where: { id: w.workerId }, data: { heldByUserId: w.userId } });
  sessionId = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: w.userId, workerId: w.workerId, agentId: w.agentId } })).id;
  rawKey = await keyFor(w.userId);
  // A worker of the OTHER App (same org, same person drives both), and a second worker in this App.
  otherAppWorkerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.app2Id, agentId: w.agentId, name: 'o', slug: `o-${generateId().slice(0, 6)}`, heldByUserId: w.userId } })).id;
  otherSessionId = (await db.session.create({ data: { id: generateId(), appId: w.app2Id, userId: w.userId, workerId: otherAppWorkerId, agentId: w.agentId } })).id;
  otherWorkerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.appId, agentId: w.agentId, name: 'p', slug: `p-${generateId().slice(0, 6)}` } })).id;
  personKey = await keyFor(w.user2Id);
});

describe('who sees which rows', () => {
  it('a bound worker lists its direct-holder rows and its own pending requests, with total; nothing else', async () => {
    const mine = await live();
    const requested = await insertGrant(w, { requested_by_worker_id: w.workerId }); // holder: a person; pending; requested by me
    // Absent: requested by me but already active (the requester arm is PENDING only), withdrawn before activation, role agent,
    // another worker, a person, an App. Each is also null by id: the same answer a missing id gets.
    const hidden = [
      await insertGrantUnguarded(w, { requested_by_worker_id: w.workerId, ...activated }),
      await insertGrantUnguarded(w, { requested_by_worker_id: w.workerId, revoked_at: raw(DB_NOW), revoked_by: 'someone' }),
      await insertGrant(w, { user_id: null, agent_id: w.agentId }),
      await insertGrant(w, { user_id: null, worker_id: otherWorkerId }),
      await insertGrant(w, { user_id: w.user2Id }),
      await insertGrant(w, { user_id: null, grantee_app_id: w.app2Id }),
    ];
    const r = await asWorker(LIST);
    expect(r.errors).toBeUndefined();
    expect(ids(r)).toEqual([mine, requested].sort());
    expect(r.data.grants.total).toBe(2);
    expect((await asWorker(ONE, { r: mine })).data.grant.id).toBe(mine);
    expect((await asWorker(ONE, { r: requested })).data.grant.id).toBe(requested);
    for (const id of hidden) expect((await asWorker(ONE, { r: id })).data.grant, id).toBeNull();
  });

  it('every other caller gets an empty page and null for an existing id: the answer a missing id gets', async () => {
    const mine = await live();
    const pending = await insertGrant(w, { requested_by_worker_id: w.workerId });
    const empty = { grants: { total: 0, items: [] } };
    expect((await asWorker(ONE, { r: generateId() })).data.grant).toBeNull();
    // A worker of another App (it even drives the same org), and a person with no session, the App's member.
    for (const [key, session] of [[rawKey, otherSessionId], [personKey, null], [rawKey, null]] as const) {
      const l = await post(key, session, LIST);
      expect(l.errors, `${key.slice(-4)} ${session}`).toBeUndefined();
      expect(l.data).toEqual(empty);
      for (const id of [mine, pending]) expect(await post(key, session, ONE, { r: id })).toMatchObject({ data: { grant: null } });
    }
    // A pure App key, a run principal and an impersonated session, even if a worker were published for them.
    const ctxs: Context[] = [
      { db, appId: w.appId, appKeyId: generateId(), roles: [] } as Context,
      { db, userId: w.userId, appId: w.appId, clientId: `run:${generateId()}`, roles: [] } as Context,
      { db, userId: w.userId, roles: [], impersonation: { sessionId: generateId(), actorUserId: w.user2Id, orgId: w.orgId, expiresAt: new Date(Date.now() + 60_000) } } as Context,
    ];
    for (const contextValue of ctxs) {
      const run = async (query: string, variables: Record<string, unknown>) => runAsActor({ workerId: w.workerId, agentId: w.agentId, userId: w.userId }, async () => {
        const a = await direct.executeOperation({ query, variables }, { contextValue });
        if (a.body.kind !== 'single') throw new Error('incremental');
        return JSON.parse(JSON.stringify(a.body.singleResult));
      });
      const l = await run(LIST, {});
      expect(l.errors).toBeUndefined();
      expect(l.data).toEqual(empty);
      for (const id of [mine, pending]) expect(await run(ONE, { r: id })).toMatchObject({ data: { grant: null } });
    }
  });

  it('a grant in a soft-deleted App is concealed: the worker reads nothing', async () => {
    const mine = await live();
    expect((await asWorker(LIST)).data.grants.total).toBe(1);
    await db.app.update({ where: { id: w.appId }, data: { deletedAt: new Date() } });
    expect((await asWorker(LIST)).data).toEqual({ grants: { total: 0, items: [] } });
    expect((await asWorker(ONE, { r: mine })).data.grant).toBeNull();
  });

  it('a retired worker, or a driver who lost their membership, reads nothing (the gate re-judges the worker and its driver)', async () => {
    const mine = await live();
    expect((await asWorker(LIST)).data.grants.total).toBe(1);
    // The driver's org membership is revoked: the credential can no longer drive this App's workers.
    await db.orgMember.updateMany({ where: { organizationId: w.orgId, userId: w.userId }, data: { deletedAt: new Date() } });
    expect((await asWorker(LIST)).data).toEqual({ grants: { total: 0, items: [] } });
    expect((await asWorker(ONE, { r: mine })).data.grant).toBeNull();
    await db.orgMember.updateMany({ where: { organizationId: w.orgId, userId: w.userId }, data: { deletedAt: null } });
    expect((await asWorker(LIST)).data.grants.total).toBe(1);
    // The worker is retired.
    await db.worker.update({ where: { id: w.workerId }, data: { retiredAt: new Date() } });
    expect((await asWorker(LIST)).data).toEqual({ grants: { total: 0, items: [] } });
    expect((await asWorker(ONE, { r: mine })).data.grant).toBeNull();
  });

  it('a request withdrawn before activation is not pending: it is absent for its requester', async () => {
    const pending = await insertGrant(w, { requested_by_worker_id: w.workerId });
    await insertGrantUnguarded(w, { requested_by_worker_id: w.workerId, revoked_at: raw(DB_NOW), revoked_by: 'someone' });
    expect(ids(await asWorker(LIST))).toEqual([pending]);
  });

  it('limit 0 is count-only, and a negative or oversized limit is clamped', async () => {
    for (let i = 0; i < 3; i++) await live();
    expect((await asWorker(LIST, { l: 0 })).data.grants).toEqual({ total: 3, items: [] });
    expect((await asWorker(LIST, { l: -5 })).data.grants).toEqual({ total: 3, items: [] });
    expect((await asWorker(LIST, { l: 1000 })).data.grants.items).toHaveLength(3);
    expect((await asWorker(LIST, { l: 2 })).data.grants.items).toHaveLength(2);
    expect((await asWorker(LIST, { l: 2, o: 2 })).data.grants.items).toHaveLength(1);
  });

  it('serves at most 200 rows however large the limit', async () => {
    for (let i = 0; i < 202; i++) await live();
    const r = await asWorker(LIST, { l: 1000 });
    expect(r.errors).toBeUndefined();
    expect(r.data.grants.total).toBe(202);
    expect(r.data.grants.items).toHaveLength(200);
  });
});

describe('allows', () => {
  const CASES: Array<[string, Record<string, unknown>, boolean]> = [
    ['active', {}, true],
    ['pending', { activated_at: null, verification_kind: null, verified_by: null }, false],
    ['revoked', { revoked_at: raw(DB_NOW), revoked_by: 'someone' }, false],
    ['expired', { expires_at: raw(`${DB_NOW} - interval '1 hour'`) }, false],
    ['before its start', { starts_at: dbNowPlus('1 hour'), expires_at: dbNowPlus('2 hours') }, false],
    ['spent', { max_uses: 1, use_count: 1 }, false],
  ];
  it('agrees with the shared live function for pending, active, revoked, expired, not-started and spent rows', async () => {
    const byId = new Map<string, [string, boolean]>();
    for (const [name, over, allows] of CASES) {
      const id = name === 'pending' ? await insertGrant(w, { user_id: null, worker_id: w.workerId }) : await live(over);
      byId.set(id, [name, allows]);
    }
    const r = await asWorker(LIST);
    expect(r.data.grants.total).toBe(CASES.length);
    for (const item of r.data.grants.items as Array<{ id: string; allows: boolean }>) {
      const [name, allows] = byId.get(item.id)!;
      expect(item.allows, name).toBe(allows);
      const row = await db.grant.findUniqueOrThrow({ where: { id: item.id } });
      // Fixed JS instants cannot judge a DB-clock row; the stored facts decide the same way at the DB's own instant.
      const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now`;
      expect(isGrantLive(row, now), `isGrantLive ${name}`).toBe(allows);
    }
  });

  it('is judged on the database clock, never the JS clock', async () => {
    const future = await live({ starts_at: dbNowPlus('1 hour'), expires_at: dbNowPlus('2 hours') });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 90 * 60_000 });
    try {
      const r = await asWorker(ONE, { r: future });
      expect(r.data.grant.allows).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});

describe('the projection', () => {
  const type = async (name: string) => {
    const a = await direct.executeOperation({ query: 'query($n:String!){__type(name:$n){fields{name type{kind name ofType{kind name ofType{kind name ofType{kind name}}}}}}}', variables: { n: name } }, { contextValue: { db, roles: [] } as Context });
    if (a.body.kind !== 'single') throw new Error('incremental');
    return (a.body.singleResult.data as any).__type as { fields: Array<{ name: string; type: any }> } | null;
  };
  const leaf = (t: any): { kind: string; name: string } => (t.ofType ? leaf(t.ofType) : t);

  it('Grant has ids and scalars only: no state label and no nested object', async () => {
    const grant = await type('Grant');
    expect(grant).not.toBeNull();
    const names = grant!.fields.map((f) => f.name);
    expect(names).toContain('allows');
    expect(names).not.toContain('state');
    for (const f of grant!.fields) expect(['SCALAR', 'ENUM'], `${f.name}`).toContain(leaf(f.type).kind);
    for (const banned of ['app', 'user', 'organization', 'worker', 'agent', 'issuer']) expect(names).not.toContain(banned);
  });

  it('reads exist and no grant writer exists on any surface', async () => {
    const q = await type('Query');
    const names = q!.fields.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['grant', 'grants']));
    const m = await type('Mutation');
    expect(m!.fields.map((f) => f.name).filter((n) => /grant/i.test(n) && /^(create|request|revoke|activate|sign)Grant$/.test(n))).toEqual([]);
  });

  it('returns the stored facts', async () => {
    const id = await live({ max_uses: 5, use_count: 2, reason: 'because', requested_by_worker_id: w.workerId });
    const r = await asWorker('query($r:ID!){grant(ref:$r){id appId action values holderKind holderId requestedByWorkerId reason maxUses useCount activatedAt revokedAt allows}}', { r: id });
    expect(r.errors).toBeUndefined();
    expect(r.data.grant).toMatchObject({ id, appId: w.appId, holderKind: 'WORKER', holderId: w.workerId, requestedByWorkerId: w.workerId, reason: 'because', maxUses: 5, useCount: 2, revokedAt: null, allows: true });
  });
});
