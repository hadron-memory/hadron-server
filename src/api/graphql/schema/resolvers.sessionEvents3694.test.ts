/**
 * #3694 — Session.events discloses other principals' VOLUMES only. Ruling 0249 (Holger, 2026-11-07, "Yes, volumes
 * only"): a session read is a usage read, so hrn:node:hadronmemory.com:specs:cor:acl:090:01 and ruling 0246 reach it.
 *
 *   - Another principal's event in a session the caller can read shows volume only: never actionArgs, and never
 *     identity beyond what the session read itself already shows (its own id).
 *   - The caller's own sessions are own activity and stay whole, whoever recorded the row.
 *   - No admin exception (ruling 0246).
 *   - The session gate and the memory scope of the rows are unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ApolloServer } from '@apollo/server';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const FIELDS = 'id type userId sessionId appId organizationId actionArgs tokensIn nodeLoc memoryId';
const Q = `query($id: ID!){ session(id: $id){ id events { ${FIELDS} } } }`;

let me: { id: string };
let other: { id: string };
let orgId: string, appId: string, appKeyId: string;
let mem: { id: string };
let unreadable: { id: string };
let theirSession: string, mySession: string;
// Rows in theirSession: recorded by them, by the App (no user), by me, and one in a memory I can't read.
let theirsByThem: string, theirsByApp: string, theirsByMe: string, theirsHidden: string;
// Rows in mySession: recorded by them and by the App.
let mineByThem: string, mineByApp: string;

const ctx = (o: Partial<Context>): Context => ({ db, ...o }) as Context;

async function gql(variables: Record<string, unknown>, contextValue: Context) {
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  const r = await server.executeOperation({ query: Q, variables }, { contextValue });
  if (r.body.kind !== 'single') throw new Error('incremental response');
  return r.body.singleResult;
}

async function events(sessionId: string, c: Context) {
  const res = await gql({ id: sessionId }, c);
  expect(res.errors).toBeUndefined();
  const session = (res.data as any).session;
  return session ? (session.events as Array<Record<string, unknown>>) : null;
}

const byId = (rows: Array<Record<string, unknown>>, id: string) => rows.find(r => r.id === id);

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 's3694', urn: `s3694-${generateId()}` } });
  const orgB = await db.organization.create({ data: { id: generateId(), name: 's3694-b', urn: `s3694-b-${generateId()}` } });
  orgId = org.id;
  me = await db.user.create({ data: { githubId: 369401, githubUsername: 's3694-me', roles: ['READER'] } });
  other = await db.user.create({ data: { githubId: 369402, githubUsername: 's3694-other', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: me.id, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: other.id, role: 'READER' } });
  mem = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:k`, name: 'k', class: 'knowledge' } });
  unreadable = await db.memory.create({ data: { id: generateId(), organizationId: orgB.id, urn: `${orgB.urn}:x`, name: 'x', class: 'knowledge' } });
  const app = await createDbAppWithKey(db, 's3694-app', org.id);
  appId = app.app.id;
  appKeyId = app.appKey.id;
  theirSession = (await db.session.create({ data: { id: generateId(), userId: other.id, appId } })).id;
  mySession = (await db.session.create({ data: { id: generateId(), userId: me.id, appId } })).id;
  [theirsByThem, theirsByApp, theirsByMe, theirsHidden, mineByThem, mineByApp] = Array.from({ length: 6 }, () => generateId());
  const base = { type: 'read', nodeLoc: 'shared', memoryId: mem.id, organizationId: org.id, appId };
  await db.usageEvent.createMany({ data: [
    { ...base, id: theirsByThem, sessionId: theirSession, userId: other.id, actionArgs: { q: 'their-query' }, tokensIn: 5 },
    { ...base, id: theirsByApp, sessionId: theirSession, userId: null, actionArgs: { q: 'app-query' }, tokensIn: 7 },
    { ...base, id: theirsByMe, sessionId: theirSession, userId: me.id, actionArgs: { q: 'my-query' }, tokensIn: 3 },
    { ...base, id: theirsHidden, sessionId: theirSession, userId: other.id, memoryId: unreadable.id, tokensIn: 9 },
    { ...base, id: mineByThem, sessionId: mySession, userId: other.id, actionArgs: { q: 'their-query-in-mine' }, tokensIn: 11 },
    { ...base, id: mineByApp, sessionId: mySession, userId: null, actionArgs: { q: 'app-query-in-mine' }, tokensIn: 13 },
  ] });
});

/** Volume only; sessionId is the parent session's own id, which the session read already shows. */
const volumeOnly = (id: string, sessionId: string, tokensIn: number, keptAppId: string | null = null) => ({
  id, type: 'read', userId: null, sessionId, appId: keptAppId, organizationId: null, actionArgs: null, tokensIn, nodeLoc: 'shared', memoryId: mem.id,
});

describe('#3694 — another principal\'s events in a readable session are volume only (ruling 0249)', () => {
  it('an org READER reading a colleague\'s App session gets their rows and the App\'s rows volume only', async () => {
    const rows = (await events(theirSession, ctx({ userId: me.id, roles: ['READER'] })))!;
    expect(byId(rows, theirsByThem)).toEqual(volumeOnly(theirsByThem, theirSession, 5));
    expect(byId(rows, theirsByApp)).toEqual(volumeOnly(theirsByApp, theirSession, 7));
  });

  it('an ADMIN gets the same: there is no admin exception (ruling 0246)', async () => {
    const rows = (await events(theirSession, ctx({ userId: me.id, roles: ['ADMIN'] })))!;
    expect(byId(rows, theirsByThem)).toEqual(volumeOnly(theirsByThem, theirSession, 5));
    expect(byId(rows, theirsByApp)).toEqual(volumeOnly(theirsByApp, theirSession, 7));
  });

  it('the caller\'s own row inside someone else\'s session stays whole', async () => {
    const rows = (await events(theirSession, ctx({ userId: me.id, roles: ['READER'] })))!;
    expect(byId(rows, theirsByMe)).toEqual({
      id: theirsByMe, type: 'read', userId: me.id, sessionId: theirSession, appId, organizationId: orgId,
      actionArgs: { q: 'my-query' }, tokensIn: 3, nodeLoc: 'shared', memoryId: mem.id,
    });
  });

  it('an App key reading its own App\'s session keeps its own appId and nothing else of identity', async () => {
    // The App key reads no org memory, so this row carries none (memoryId null passes the memory scope).
    const unscoped = generateId();
    await db.usageEvent.create({ data: { id: unscoped, type: 'read', nodeLoc: 'shared', memoryId: null, sessionId: theirSession, userId: other.id, organizationId: orgId, appId, actionArgs: { q: 'their-unscoped' }, tokensIn: 17 } });
    const rows = (await events(theirSession, ctx({ appId, appKeyId })))!;
    expect(byId(rows, unscoped)).toEqual({ ...volumeOnly(unscoped, theirSession, 17, appId), memoryId: null });
  });
});

describe('#3694 — the caller\'s own session is own activity and stays whole (ruling 0249)', () => {
  it('rows another user and the App recorded in my session keep identity and actionArgs', async () => {
    const rows = (await events(mySession, ctx({ userId: me.id, roles: ['READER'] })))!;
    expect(byId(rows, mineByThem)).toMatchObject({ userId: other.id, sessionId: mySession, organizationId: orgId, appId, actionArgs: { q: 'their-query-in-mine' } });
    expect(byId(rows, mineByApp)).toMatchObject({ userId: null, sessionId: mySession, organizationId: orgId, appId, actionArgs: { q: 'app-query-in-mine' } });
  });

  it('a session with no user is nobody\'s own: an App key with a null userId still gets volume only', async () => {
    const userless = (await db.session.create({ data: { id: generateId(), userId: null, appId } })).id;
    const row = generateId();
    await db.usageEvent.create({ data: { id: row, type: 'read', nodeLoc: 'shared', memoryId: null, sessionId: userless, userId: other.id, organizationId: orgId, appId, actionArgs: { q: 'userless' }, tokensIn: 19 } });
    const rows = (await events(userless, ctx({ appId, appKeyId, userId: null } as Partial<Context>)))!;
    expect(byId(rows, row)).toEqual({ ...volumeOnly(row, userless, 19, appId), memoryId: null });
  });

  it('an ADMIN reading my session is not me: the rows are volume only', async () => {
    const rows = (await events(mySession, ctx({ userId: other.id, roles: ['ADMIN'] })))!;
    expect(byId(rows, mineByApp)).toEqual(volumeOnly(mineByApp, mySession, 13));
  });

  it('impersonation is not ownership: an impersonated read of the target\'s session masks the App\'s rows', async () => {
    const impersonation = { orgId, sessionId: generateId(), actorUserId: other.id, expiresAt: new Date(Date.now() + 60_000) };
    const rows = (await events(mySession, ctx({ userId: me.id, roles: [], impersonation } as Partial<Context>)))!;
    expect(byId(rows, mineByApp)).toEqual(volumeOnly(mineByApp, mySession, 13));
  });
});

describe('#3694 — the session gate and the rows\' memory scope are unchanged', () => {
  it('a row in a memory the caller cannot read is still absent', async () => {
    const rows = (await events(theirSession, ctx({ userId: me.id, roles: ['READER'] })))!;
    expect(byId(rows, theirsHidden)).toBeUndefined();
    expect(rows).toHaveLength(3);
  });

  it('a session outside the caller\'s audience is still not readable', async () => {
    const outsider = await db.user.create({ data: { githubId: 369403, githubUsername: 's3694-out', roles: ['READER'] } });
    expect(await events(theirSession, ctx({ userId: outsider.id, roles: ['READER'] }))).toBeNull();
  });
});
