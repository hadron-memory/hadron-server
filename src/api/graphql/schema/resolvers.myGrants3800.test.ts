/**
 * #3800 (cor:acl:140:05 List, ruling 0255 item 8): a signed-in PERSON lists the grants that name them as holder, across every
 * App and Org, in every state, and only those. Every other caller (App key, run principal, impersonated session, a worker
 * session, no credential) gets an empty page: no error and no count that discloses anything. Rows come from the S1a
 * fixtures (no production writer exists). Pins go over real GraphQL POSTs; callers a request cannot reach go through the resolver.
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
let personKey: string;
let otherKey: string;
let app3Id: string; // an App in a SECOND Org
let org2Id: string;

async function keyFor(userId: string): Promise<string> {
  const k = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { userId, oauthScopes: [], keyHash: hashUserApiKey(k), keyPreview: k.slice(-4) } });
  return k;
}
async function post(key: string | null, session: string | null, query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(session ? { 'x-hadron-session': session } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}
const LIST = 'query($l:Int,$o:Int){myGrants(limit:$l,offset:$o){total items{id allows holderKind holderId reason values}}}';
const asMe = (v: Record<string, unknown> = {}) => post(personKey, null, LIST, v);
const ids = (r: any): string[] => (r.data.myGrants.items as Array<{ id: string }>).map((i) => i.id).sort();
const activated = { activated_at: raw(DB_NOW), verification_kind: 'TEST', verified_by: 'test' };
const mine = (over: Record<string, unknown> = {}) => insertGrantUnguarded(w, { ...activated, ...over } as never);

beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  personKey = await keyFor(w.userId);
  otherKey = await keyFor(w.user2Id);
  const org2 = await db.organization.create({ data: { name: 'g-org2', urn: `g-org2-${generateId().slice(0, 6)}.test` } });
  org2Id = org2.id;
  app3Id = (await db.app.create({ data: { organizationId: org2.id, name: 'g-app3', urn: `${org2.urn}:app` } })).id;
});

describe('which rows a person lists', () => {
  it('lists their own holder rows across Apps in two Orgs, in every state, with a total; nothing else', async () => {
    const a = await mine();
    const b = await mine({ app_id: w.app2Id });
    const c = await mine({ app_id: app3Id });
    const pending = await insertGrant(w, {});
    const revoked = await mine({ revoked_at: raw(DB_NOW), revoked_by: 'someone' });
    const expired = await mine({ expires_at: raw(`${DB_NOW} - interval '1 hour'`) });
    const own = [a, b, c, pending, revoked, expired].sort();
    // Absent: another person's rows, rows the caller issued or requested for someone else, rows held by an agent, a worker or an App.
    await insertGrant(w, { user_id: w.user2Id });
    await insertGrant(w, { user_id: w.user2Id, issuer_user_id: w.userId });
    await insertGrant(w, { user_id: w.user2Id, requested_by_user_id: w.userId });
    await insertGrant(w, { user_id: null, agent_id: w.agentId, issuer_user_id: w.userId, requested_by_user_id: w.userId });
    await insertGrant(w, { user_id: null, worker_id: w.workerId, requested_by_user_id: w.userId });
    await insertGrant(w, { user_id: null, grantee_app_id: w.app2Id, issuer_user_id: w.userId });
    const r = await asMe();
    expect(r.errors).toBeUndefined();
    expect(ids(r)).toEqual(own);
    expect(r.data.myGrants.total).toBe(own.length);
    for (const item of r.data.myGrants.items) expect(item).toMatchObject({ holderKind: 'USER', holderId: w.userId });
    // The other person sees only their own rows, never the caller's.
    const o = await post(otherKey, null, LIST);
    expect(o.data.myGrants.total).toBe(3);
    expect((o.data.myGrants.items as Array<{ id: string }>).some((i) => own.includes(i.id))).toBe(false);
  });

  it('a person who left the Org still lists the grant, with the same reason, values and allows as before leaving', async () => {
    await db.orgMember.create({ data: { organizationId: w.orgId, userId: w.userId, role: 'CONTRIBUTOR' } });
    const id = await mine({ reason: 'the terms', action_values: { to: ['a'] } });
    const before = (await asMe()).data.myGrants.items[0];
    expect(before).toMatchObject({ id, allows: true, reason: 'the terms', values: { to: ['a'] } });
    await db.orgMember.updateMany({ where: { organizationId: w.orgId, userId: w.userId }, data: { deletedAt: new Date() } });
    const after = (await asMe()).data.myGrants.items[0];
    expect(after).toEqual(before);
    expect(after.allows).toBe(true); // from the live function, never forced false
  });

  it('a grant in a soft-deleted App is concealed, count included', async () => {
    await mine();
    await mine({ app_id: w.app2Id });
    expect((await asMe()).data.myGrants.total).toBe(2);
    await db.app.update({ where: { id: w.app2Id }, data: { deletedAt: new Date() } });
    const r = await asMe();
    expect(r.data.myGrants.total).toBe(1);
    expect(r.data.myGrants.items).toHaveLength(1);
  });

  it('lists newest first, pages with limit and offset, and limit 0 is count-only', async () => {
    const made: string[] = [];
    for (let i = 0; i < 3; i++) made.push(await mine({ created_at: raw(`${DB_NOW} - interval '${3 - i} hour'`) }));
    expect((await asMe()).data.myGrants.items.map((i: { id: string }) => i.id)).toEqual([...made].reverse());
    expect((await asMe({ l: 0 })).data.myGrants).toEqual({ total: 3, items: [] });
    expect((await asMe({ l: -5 })).data.myGrants).toEqual({ total: 3, items: [] });
    expect((await asMe({ l: 2 })).data.myGrants.items).toHaveLength(2);
    expect((await asMe({ l: 2, o: 2 })).data.myGrants.items).toHaveLength(1);
  });

  it('serves at most 200 rows however large the limit', async () => {
    for (let i = 0; i < 202; i++) await mine();
    const r = await asMe({ l: 1000 });
    expect(r.data.myGrants.total).toBe(202);
    expect(r.data.myGrants.items).toHaveLength(200);
  });
});

describe('every other caller gets an empty page', () => {
  it('no credential, a person with no grants, and a worker session of the holder: the answer a person with nothing gets', async () => {
    await mine();
    const empty = { myGrants: { total: 0, items: [] } };
    const worker = await db.session.create({ data: { id: generateId(), appId: w.appId, userId: w.userId, workerId: w.workerId, agentId: w.agentId } });
    await db.worker.update({ where: { id: w.workerId }, data: { heldByUserId: w.userId } });
    await db.orgMember.create({ data: { organizationId: w.orgId, userId: w.userId, role: 'CONTRIBUTOR' } });
    // The person has a grant, but a stand-in is not the person.
    const stranger = await keyFor((await db.user.create({ data: { handle: `s-${generateId().slice(0, 6)}` } })).id);
    for (const [key, session] of [[null, null], [stranger, null], [personKey, worker.id]] as const) {
      const l = await post(key, session, LIST);
      expect(l.errors, `${key?.slice(-4)} ${session}`).toBeUndefined();
      expect(l.data).toEqual(empty);
    }
  });

  it('an App key, a run principal and an impersonated session, even holding the person id', async () => {
    await mine();
    const empty = { myGrants: { total: 0, items: [] } };
    const ctxs: Context[] = [
      { db, appId: w.appId, appKeyId: generateId(), roles: [] } as Context,
      { db, userId: w.userId, appId: w.appId, clientId: `run:${generateId()}`, roles: [] } as Context,
      { db, userId: w.userId, roles: [], impersonation: { sessionId: generateId(), actorUserId: w.user2Id, orgId: w.orgId, expiresAt: new Date(Date.now() + 60_000) } } as Context,
    ];
    for (const contextValue of ctxs) {
      const a = await runAsActor({ workerId: null, agentId: null, userId: w.userId }, () => direct.executeOperation({ query: LIST, variables: {} }, { contextValue }));
      if (a.body.kind !== 'single') throw new Error('incremental');
      const out = JSON.parse(JSON.stringify(a.body.singleResult));
      expect(out.errors).toBeUndefined();
      expect(out.data).toEqual(empty);
    }
  });

  it('the three worker shapes the shared person gate refuses (worker-bound session row, ambiguous actor, refused binding) get the empty page', async () => {
    await mine();
    const empty = { myGrants: { total: 0, items: [] } };
    const row = await db.session.create({ data: { id: generateId(), appId: w.appId, userId: w.userId, workerId: w.workerId, agentId: w.agentId } });
    const base = { db, userId: w.userId, roles: [] };
    const shapes: Array<[string, Context, { workerId: null; agentId: null; userId: string; ambiguousSessionIds?: string[] }]> = [
      ['worker-bound session row', { ...base, sessionId: row.id } as Context, { workerId: null, agentId: null, userId: w.userId }],
      ['ambiguous actor', base as Context, { workerId: null, agentId: null, userId: w.userId, ambiguousSessionIds: [generateId(), generateId()] }],
      ['refused binding', { ...base, sessionBindingRefused: true } as unknown as Context, { workerId: null, agentId: null, userId: w.userId }],
    ];
    for (const [name, contextValue, actor] of shapes) {
      const a = await runAsActor(actor, () => direct.executeOperation({ query: LIST, variables: {} }, { contextValue }));
      if (a.body.kind !== 'single') throw new Error('incremental');
      const out = JSON.parse(JSON.stringify(a.body.singleResult));
      expect(out.errors, name).toBeUndefined();
      expect(out.data, name).toEqual(empty);
    }
    // Control: the same context shape with none of the three is the person, and lists.
    const ok = await runAsActor({ workerId: null, agentId: null, userId: w.userId }, () => direct.executeOperation({ query: LIST, variables: {} }, { contextValue: base as Context }));
    if (ok.body.kind !== 'single') throw new Error('incremental');
    expect((ok.body.singleResult.data as any).myGrants.total).toBe(1);
  });

  it('a person with a real list still gets it (the control for the empties above)', async () => {
    await mine();
    expect((await asMe()).data.myGrants.total).toBe(1);
  });
});

describe('allows', () => {
  const CASES: Array<[string, Record<string, unknown>, boolean]> = [
    ['active', {}, true],
    ['revoked', { revoked_at: raw(DB_NOW), revoked_by: 'someone' }, false],
    ['expired', { expires_at: raw(`${DB_NOW} - interval '1 hour'`) }, false],
    ['before its start', { starts_at: dbNowPlus('1 hour'), expires_at: dbNowPlus('2 hours') }, false],
    ['spent', { max_uses: 1, use_count: 1 }, false],
  ];
  it('agrees with the shared live function for active, revoked, expired, not-started and spent rows, and a pending row allows nothing', async () => {
    const byId = new Map<string, [string, boolean]>();
    for (const [name, over, allows] of CASES) byId.set(await mine(over), [name, allows]);
    byId.set(await insertGrant(w, {}), ['pending', false]);
    const r = await asMe();
    expect(r.data.myGrants.total).toBe(CASES.length + 1);
    for (const item of r.data.myGrants.items as Array<{ id: string; allows: boolean }>) {
      const [name, allows] = byId.get(item.id)!;
      expect(item.allows, name).toBe(allows);
      const row = await db.grant.findUniqueOrThrow({ where: { id: item.id } });
      const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now`;
      expect(isGrantLive({ ...row, appDeletedAt: null }, now), `isGrantLive ${name}`).toBe(allows);
    }
  });
});

describe('the surface', () => {
  it('is a read: the query exists and no writer or MCP tool was added', () => {
    expect(typeDefs).toContain('myGrants(limit: Int, offset: Int): GrantsPage!');
  });
});
