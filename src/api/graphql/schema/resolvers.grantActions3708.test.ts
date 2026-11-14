/**
 * #3708 (Grants S1c; hrn:node:hadronmemory.com:specs:cor:acl:140:02, ruling 0255 item 2, cor:api:120): `grantActions(appRef:)` and
 * `action(appRef:, ref:)` read the action registry for anyone IN the named App. "In the App" is the shared participation predicate
 * (`resolveTaskActor`: a participating person, or a bound worker of that App) AND two added guards, an impersonated session and a
 * headless run, each judged before the predicate. Every refusal is the same empty page / null (no error, no existence leak).
 * Pins go over real GraphQL POSTs; callers a request cannot reach (App key, run, impersonation) go through the resolver.
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
import { PLATFORM_ACTIONS, upsertPlatformActions } from '../../../lib/grants/actions.js';
import { dropTestActions, ensureTestAction, seedWorld, TEST_ACTION, type World } from '../../../lib/grants/grantFixtures3668.js';
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
let personKey: string; // a participant of the App (an Org member)
let outsiderKey: string; // a person in no Org
let workerKey: string;
let workerSession: string;
let otherAppSession: string;

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
const FIELDS = 'name source tool enforcement issuerRule parameters { name type refusesWildcard }';
const LIST = `query($a:String!,$l:Int,$o:Int){grantActions(appRef:$a,limit:$l,offset:$o){total items{${FIELDS}}}}`;
const ONE = `query($a:String!,$r:ID!){action(appRef:$a,ref:$r){${FIELDS}}}`;
const EMPTY = { grantActions: { total: 0, items: [] } };
const expected = () => [...PLATFORM_ACTIONS]
  .sort((a, b) => (a.name < b.name ? -1 : 1))
  .map((a) => ({ name: a.name, source: a.source, tool: a.tool, enforcement: a.enforcement, issuerRule: a.issuerRule, parameters: a.parameters }));

/** Run one operation through the resolver with a hand-built context (the callers a request cannot reach). */
async function viaResolver(contextValue: Context, query: string, variables: Record<string, unknown>): Promise<any> {
  const a = await runAsActor({ workerId: null, agentId: null, userId: contextValue.userId ?? null }, () => direct.executeOperation({ query, variables }, { contextValue }));
  if (a.body.kind !== 'single') throw new Error('incremental');
  return JSON.parse(JSON.stringify(a.body.singleResult));
}

beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  await dropTestActions();
  await upsertPlatformActions(db);
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: w.userId, role: 'CONTRIBUTOR' } });
  await db.worker.update({ where: { id: w.workerId }, data: { heldByUserId: w.userId } });
  workerSession = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: w.userId, workerId: w.workerId, agentId: w.agentId } })).id;
  const otherWorker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.app2Id, agentId: w.agentId, name: 'o', slug: `o-${generateId().slice(0, 6)}`, heldByUserId: w.userId } });
  otherAppSession = (await db.session.create({ data: { id: generateId(), appId: w.app2Id, userId: w.userId, workerId: otherWorker.id, agentId: w.agentId } })).id;
  personKey = await keyFor(w.userId);
  workerKey = personKey;
  outsiderKey = await keyFor(w.user2Id);
});

describe('admitted callers read exactly the registry', () => {
  it('a participating person lists exactly the rows PLATFORM_ACTIONS defines, with parameters, wildcard refusal, enforcement and issuer rule', async () => {
    expect(PLATFORM_ACTIONS.length).toBeGreaterThanOrEqual(4);
    const r = await post(personKey, null, LIST, { a: w.appId });
    expect(r.errors).toBeUndefined();
    expect(r.data.grantActions.total).toBe(PLATFORM_ACTIONS.length);
    expect(r.data.grantActions.items).toEqual(expected());
    // The App may be named by URN too.
    const app = await db.app.findUniqueOrThrow({ where: { id: w.appId } });
    expect((await post(personKey, null, LIST, { a: app.urn })).data.grantActions.items).toEqual(expected());
  });

  it('a bound worker of the App lists the same rows', async () => {
    const r = await post(workerKey, workerSession, LIST, { a: w.appId });
    expect(r.errors).toBeUndefined();
    expect(r.data.grantActions.items).toEqual(expected());
  });

  it('action(appRef:, ref:) reads one row by name for both admitted callers; an unknown name is null', async () => {
    for (const [key, session] of [[personKey, null], [workerKey, workerSession]] as const) {
      for (const a of expected()) {
        const r = await post(key, session, ONE, { a: w.appId, r: a.name });
        expect(r.errors).toBeUndefined();
        expect(r.data.action).toEqual(a);
      }
      const missing = await post(key, session, ONE, { a: w.appId, r: 'no.such.action' });
      expect(missing).toMatchObject({ data: { action: null } });
      expect(missing.errors).toBeUndefined();
    }
  });

  it('serves the registry table, not a copy of the constant: a registered row appears, and a name is matched exactly', async () => {
    await ensureTestAction();
    const r = await post(personKey, null, LIST, { a: w.appId });
    expect(r.data.grantActions.total).toBe(PLATFORM_ACTIONS.length + 1);
    expect((await post(personKey, null, ONE, { a: w.appId, r: TEST_ACTION })).data.action.name).toBe(TEST_ACTION);
    expect((await post(personKey, null, ONE, { a: w.appId, r: TEST_ACTION.toUpperCase() })).data.action).toBeNull();
  });

  it('pages with limit and offset; limit 0 is count-only; a negative limit is 0; the order is by name', async () => {
    const names = expected().map((a) => a.name);
    expect((await post(personKey, null, LIST, { a: w.appId, l: 0 })).data.grantActions).toEqual({ total: names.length, items: [] });
    expect((await post(personKey, null, LIST, { a: w.appId, l: -3 })).data.grantActions).toEqual({ total: names.length, items: [] });
    const first = await post(personKey, null, LIST, { a: w.appId, l: 2 });
    expect(first.data.grantActions.items.map((i: { name: string }) => i.name)).toEqual(names.slice(0, 2));
    const rest = await post(personKey, null, LIST, { a: w.appId, l: 2, o: 2 });
    expect(rest.data.grantActions.items.map((i: { name: string }) => i.name)).toEqual(names.slice(2, 4));
  });
});

describe('every refusal is the same empty page / null', () => {
  const nullOne = { data: { action: null } };

  it('no credential, a person who does not participate, and an unknown, malformed or soft-deleted App', async () => {
    const name = PLATFORM_ACTIONS[0]!.name;
    const gone = await db.app.create({ data: { organizationId: w.orgId, name: 'g-gone', urn: `${(await db.organization.findUniqueOrThrow({ where: { id: w.orgId } })).urn}:gone`, deletedAt: new Date() } });
    const cases: Array<[string, string | null, string | null, string]> = [
      ['no principal', null, null, w.appId],
      ['non-participant', outsiderKey, null, w.appId],
      ['unknown App', personKey, null, generateId()],
      ['malformed ref', personKey, null, 'not an app ref ::'],
      ['soft-deleted App', personKey, null, gone.id],
    ];
    for (const [label, key, session, appRef] of cases) {
      const l = await post(key, session, LIST, { a: appRef });
      expect(l.errors, label).toBeUndefined();
      expect(l.data, label).toEqual(EMPTY);
      expect(await post(key, session, ONE, { a: appRef, r: name }), label).toMatchObject(nullOne);
    }
  });

  it('the unknown-App and non-participant answers are byte-identical (no existence leak)', async () => {
    const name = PLATFORM_ACTIONS[0]!.name;
    for (const q of [[LIST, {}], [ONE, { r: name }]] as const) {
      const unknown = JSON.stringify(await post(outsiderKey, null, q[0], { a: generateId(), ...q[1] }));
      const nonParticipant = JSON.stringify(await post(outsiderKey, null, q[0], { a: w.appId, ...q[1] }));
      expect(nonParticipant).toBe(unknown);
    }
  });

  it('a worker of another App, and a retired worker', async () => {
    const name = PLATFORM_ACTIONS[0]!.name;
    // The other App's worker names THIS App: refused. (Control: it reads its own App.)
    expect((await post(workerKey, otherAppSession, LIST, { a: w.appId })).data).toEqual(EMPTY);
    expect(await post(workerKey, otherAppSession, ONE, { a: w.appId, r: name })).toMatchObject(nullOne);
    expect((await post(workerKey, otherAppSession, LIST, { a: w.app2Id })).data.grantActions.total).toBe(PLATFORM_ACTIONS.length);
    await db.worker.update({ where: { id: w.workerId }, data: { retiredAt: new Date() } });
    expect((await post(workerKey, workerSession, LIST, { a: w.appId })).data).toEqual(EMPTY);
    expect(await post(workerKey, workerSession, ONE, { a: w.appId, r: name })).toMatchObject(nullOne);
  });

  it('an App key (no actor here), a headless run, and an impersonated session of a PARTICIPANT (each guard, with the control that the person is admitted)', async () => {
    const name = PLATFORM_ACTIONS[0]!.name;
    // Control: the same participant, acting directly, is admitted through the same hand-built context shape.
    const person = { db, userId: w.userId, roles: [] } as unknown as Context;
    expect((await viaResolver(person, LIST, { a: w.appId })).data.grantActions.total).toBe(PLATFORM_ACTIONS.length);
    const ctxs: Array<[string, Context]> = [
      ['App key', { db, appId: w.appId, appKeyId: generateId(), roles: [] } as unknown as Context],
      ['run', { db, userId: w.userId, appId: w.appId, clientId: `run:${generateId()}`, roles: [] } as unknown as Context],
      ['impersonated participant', { db, userId: w.userId, roles: [], impersonation: { sessionId: generateId(), actorUserId: w.user2Id, orgId: w.orgId, expiresAt: new Date(Date.now() + 60_000) } } as unknown as Context],
    ];
    for (const [label, ctx] of ctxs) {
      const l = await viaResolver(ctx, LIST, { a: w.appId });
      expect(l.errors, label).toBeUndefined();
      expect(l.data, label).toEqual(EMPTY);
      const one = await viaResolver(ctx, ONE, { a: w.appId, r: name });
      expect(one.errors, label).toBeUndefined();
      expect(one, label).toMatchObject(nullOne);
    }
  });
});

describe('the participation edges (#4131, BLIND F2/F3)', () => {
  const nullOne = { data: { action: null } };
  const name = () => PLATFORM_ACTIONS[0]!.name;
  const refused = async (key: string | null, session: string | null, appRef: string, label: string) => {
    const l = await post(key, session, LIST, { a: appRef });
    expect(l.errors, label).toBeUndefined();
    expect(l.data, label).toEqual(EMPTY);
    const one = await post(key, session, ONE, { a: appRef, r: name() });
    expect(one.errors, label).toBeUndefined();
    expect(one, label).toMatchObject(nullOne);
  };

  it('a worker request carries its holder\'s credential: the session header alone, with no credential, is refused (a worker has no credential of its own)', async () => {
    // Control: the same session WITH the holder's credential is admitted (the worker arrival path).
    expect((await post(workerKey, workerSession, LIST, { a: w.appId })).data.grantActions.total).toBe(PLATFORM_ACTIONS.length);
    await refused(null, workerSession, w.appId, 'session header only');
    // The resolver's own guard, for a bound worker actor with no credential (a request cannot reach it: the session never binds
    // without a person): a hand-built context.
    const bare = { db, roles: [] } as unknown as Context;
    const run = async (query: string, variables: Record<string, unknown>) => {
      const a = await runAsActor({ workerId: w.workerId, agentId: w.agentId, userId: null }, () => direct.executeOperation({ query, variables }, { contextValue: bare }));
      if (a.body.kind !== 'single') throw new Error('incremental');
      return JSON.parse(JSON.stringify(a.body.singleResult));
    };
    const bareList = await run(LIST, { a: w.appId });
    expect(bareList.errors, 'bare worker list').toBeUndefined(); // a refusal, not a request that errored
    expect(bareList.data).toEqual(EMPTY);
    const bareOne = await run(ONE, { a: w.appId, r: name() });
    expect(bareOne.errors, 'bare worker one').toBeUndefined();
    expect(bareOne).toMatchObject(nullOne);
  });

  it('a member of a DIFFERENT org naming this App is refused; the same person reads their own org\'s App (control)', async () => {
    const other = await db.organization.create({ data: { name: 'g-other', urn: `other-${generateId().slice(0, 8)}.test` } });
    const otherApp = await db.app.create({ data: { organizationId: other.id, name: 'g-other-app', urn: `${other.urn}:app` } });
    await db.orgMember.create({ data: { organizationId: other.id, userId: w.user2Id, role: 'CONTRIBUTOR' } });
    expect((await post(outsiderKey, null, LIST, { a: otherApp.id })).data.grantActions.total).toBe(PLATFORM_ACTIONS.length);
    await refused(outsiderKey, null, w.appId, 'member of another org');
    // Byte-identical to a person in no org at all: membership elsewhere discloses nothing.
    const none = await keyFor((await db.user.create({ data: { handle: `n-${generateId().slice(0, 8)}` } })).id);
    expect(JSON.stringify(await post(outsiderKey, null, LIST, { a: w.appId }))).toBe(JSON.stringify(await post(none, null, LIST, { a: w.appId })));
    expect(JSON.stringify(await post(outsiderKey, null, ONE, { a: w.appId, r: name() }))).toBe(JSON.stringify(await post(none, null, ONE, { a: w.appId, r: name() })));
  });

  it('a former member (membership revoked) is refused, and so is their worker session; the same credential was admitted before (control)', async () => {
    expect((await post(personKey, null, LIST, { a: w.appId })).data.grantActions.total).toBe(PLATFORM_ACTIONS.length);
    expect((await post(workerKey, workerSession, LIST, { a: w.appId })).data.grantActions.total).toBe(PLATFORM_ACTIONS.length);
    const membership = { organizationId_userId: { organizationId: w.orgId, userId: w.userId } };
    await db.orgMember.update({ where: membership, data: { deletedAt: new Date() } });
    try {
      await refused(personKey, null, w.appId, 'revoked person');
      await refused(workerKey, workerSession, w.appId, 'revoked person\'s worker session');
    } finally {
      await db.orgMember.update({ where: membership, data: { deletedAt: null } }); // never leave the shared fixture revoked
    }
    expect((await post(personKey, null, LIST, { a: w.appId })).data.grantActions.total).toBe(PLATFORM_ACTIONS.length);
    expect((await post(workerKey, workerSession, LIST, { a: w.appId })).data.grantActions.total).toBe(PLATFORM_ACTIONS.length);
  });
});

describe('the shape of the surface', () => {
  it('no Mutation reads or writes an action, and no summary is exposed', async () => {
    const intro = await post(personKey, null, '{ __schema { mutationType { fields { name type { name ofType { name ofType { name } } } } } } __type(name:"GrantAction"){ fields { name description } } }');
    expect(intro.errors).toBeUndefined();
    const named = (t: any): string[] => (t ? [t.name, ...named(t.ofType)].filter(Boolean) : []);
    for (const f of intro.data.__schema.mutationType.fields as Array<{ name: string; type: unknown }>) {
      expect(f.name.toLowerCase()).not.toMatch(/^(create|set|update|delete|upsert|remove|register)(grant)?actions?$/);
      expect(named(f.type)).not.toContain('GrantAction');
    }
    const fields = (intro.data.__type.fields as Array<{ name: string; description: string | null }>);
    expect(fields.map((f) => f.name).sort()).toEqual(['enforcement', 'issuerRule', 'name', 'parameters', 'source', 'tool']);
    // A summary is its own slice (ask item 11): asking for it is a validation error, not a field.
    const asked = await post(personKey, null, `query($a:String!){grantActions(appRef:$a){items{name summaryTemplate summary}}}`, { a: w.appId });
    expect(asked.errors?.length).toBeGreaterThan(0);
  });

  it('the enforcement level is described as the declared promise, never as an active guarantee (#3730 item 6)', async () => {
    const intro = await post(personKey, null, '{ __type(name:"GrantAction"){ fields { name description } } }');
    const d = (intro.data.__type.fields as Array<{ name: string; description: string | null }>).find((f) => f.name === 'enforcement')!.description ?? '';
    expect(d).toMatch(/declared|promise/i);
    expect(d).toMatch(/not (an )?(active|enforced)|until|no guarantee|not a guarantee/i);
    expect(d).toMatch(/3483/);
  });
});
