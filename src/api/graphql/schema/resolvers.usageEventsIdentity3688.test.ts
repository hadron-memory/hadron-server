/**
 * #3688 — a named-memory usage read discloses other principals' VOLUMES only, for every reader, per
 * hrn:node:hadronmemory.com:specs:cor:acl:090:01 ("never another principal's identity, and never the content
 * they touched") and ruling 0246 (no admin exception). Also the deprecated-but-live nodeUsage(loc).
 *
 * Acceptance (Charles, after Xabat's gate 6708954316):
 *   1. Other principals' rows carry userId, sessionId, organizationId and actionArgs as null; volumes stay.
 *      Admins and owners get the same.
 *   2. Own-activity rows (no resource named) are unchanged; the caller's own rows keep their identity.
 *   3. MEMORY_NOT_FOUND is unchanged.
 *   4. The #2817 pin that kept a user principal's resource read raw flips to the masked expectation
 *      (resolvers.usageEventsScope2817.test.ts).
 *   5. A READER-member pin (the issue's repro) and a nodeUsage pin, both through the real schema.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ApolloServer } from '@apollo/server';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { projectUsageRowsFor, USAGE_VOLUME_FIELDS, USAGE_IDENTITY_FIELDS } from './resolvers.usageProjection.js';

const IDENTITY = 'id userId sessionId appId organizationId actionArgs tokensIn nodeLoc memoryId';
let me: { id: string };
let other: { id: string };
let orgId: string;
let mem: { id: string };
let unreadable: { id: string };
let theirs: string, mine: string;
let mySession: string, theirSession: string, appId: string;

const ctx = (o: Partial<Context>): Context => ({ db, ...o }) as Context;

async function gql(query: string, variables: Record<string, unknown>, contextValue: Context) {
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  const r = await server.executeOperation({ query, variables }, { contextValue });
  if (r.body.kind !== 'single') throw new Error('incremental response');
  return r.body.singleResult;
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'u3688', urn: `u3688-${generateId()}` } });
  const orgB = await db.organization.create({ data: { id: generateId(), name: 'u3688-b', urn: `u3688-b-${generateId()}` } });
  orgId = org.id;
  me = await db.user.create({ data: { githubId: 368801, githubUsername: 'u3688-me', roles: ['READER'] } });
  other = await db.user.create({ data: { githubId: 368802, githubUsername: 'u3688-other', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: me.id, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: other.id, role: 'READER' } });
  mem = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:k`, name: 'k', class: 'knowledge' } });
  unreadable = await db.memory.create({ data: { id: generateId(), organizationId: orgB.id, urn: `${orgB.urn}:x`, name: 'x', class: 'knowledge' } });
  appId = (await createDbAppWithKey(db, 'u3688-app', org.id)).app.id;
  mySession = (await db.session.create({ data: { id: generateId(), userId: me.id } })).id;
  theirSession = (await db.session.create({ data: { id: generateId(), userId: other.id } })).id;
  theirs = generateId(); mine = generateId();
  await db.usageEvent.createMany({ data: [
    { id: theirs, type: 'read', nodeLoc: 'shared', memoryId: mem.id, userId: other.id, sessionId: theirSession, organizationId: org.id, appId, actionArgs: { q: 'other-users-query' }, tokensIn: 5 },
    { id: mine, type: 'read', nodeLoc: 'shared', memoryId: mem.id, userId: me.id, sessionId: mySession, organizationId: org.id, appId, actionArgs: { q: 'my-query' }, tokensIn: 3 },
  ] });
});

const masked = (id: string, tokensIn: number) => ({ id, userId: null, sessionId: null, appId: null, organizationId: null, actionArgs: null, tokensIn, nodeLoc: 'shared', memoryId: mem.id });
const raw = () => ({ id: mine, userId: me.id, sessionId: mySession, appId, organizationId: orgId, actionArgs: { q: 'my-query' }, tokensIn: 3, nodeLoc: 'shared', memoryId: mem.id });
const byId = (rows: Array<{ id: string }>, id: string) => rows.find(r => r.id === id);

describe('#3688 — a named memory discloses other principals\' volumes only, through the real schema', () => {
  it('a READER member naming a memory gets another user\'s row masked on both fields (the issue\'s repro)', async () => {
    const res = await gql(`query($m: ID!){ a: usageEvents(memoryId: $m){ ${IDENTITY} } b: usageEventsPage(memoryId: $m){ items { ${IDENTITY} } } }`, { m: mem.id }, ctx({ userId: me.id, roles: ['READER'] }));
    expect(res.errors).toBeUndefined();
    const data = res.data as any;
    expect(byId(data.a, theirs)).toEqual(masked(theirs, 5));
    expect(byId(data.b.items, theirs)).toEqual(masked(theirs, 5));
  });

  it('an ADMIN gets the same masking: there is no admin exception (ruling 0246)', async () => {
    const res = await gql(`query($m: ID!){ a: usageEvents(memoryId: $m){ ${IDENTITY} } b: usageEventsPage(memoryId: $m){ items { ${IDENTITY} } } }`, { m: mem.id }, ctx({ userId: me.id, roles: ['ADMIN'] }));
    expect(res.errors).toBeUndefined();
    const data = res.data as any;
    expect(byId(data.a, theirs)).toEqual(masked(theirs, 5));
    expect(byId(data.b.items, theirs)).toEqual(masked(theirs, 5));
  });

  it('the caller\'s own row inside the named memory keeps its identity: it is the caller\'s own activity', async () => {
    const res = await gql(`query($m: ID!){ a: usageEvents(memoryId: $m){ ${IDENTITY} } b: usageEventsPage(memoryId: $m){ items { ${IDENTITY} } } }`, { m: mem.id }, ctx({ userId: me.id, roles: ['READER'] }));
    expect(res.errors).toBeUndefined();
    const data = res.data as any;
    expect(byId(data.a, mine)).toEqual(raw());
    expect(byId(data.b.items, mine)).toEqual(raw());
  });

  it('own activity (no resource named) is unchanged: the caller\'s rows, raw', async () => {
    const res = await gql(`{ a: usageEvents { ${IDENTITY} } b: usageEventsPage { items { ${IDENTITY} } } }`, {}, ctx({ userId: me.id, roles: ['READER'] }));
    expect(res.errors).toBeUndefined();
    const data = res.data as any;
    expect(data.a).toEqual([raw()]);
    expect(data.b.items).toEqual([raw()]);
  });

  it('a loc or an exact node names a resource too, and is masked the same way', async () => {
    const n = await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'shared', name: 'Shared' } });
    await db.usageEvent.update({ where: { id: theirs }, data: { nodeId: n.id } });
    const res = await gql(`query($n: ID!){ a: usageEvents(loc: "shared"){ ${IDENTITY} } b: usageEventsPage(nodeId: $n){ items { ${IDENTITY} } } }`, { n: n.id }, ctx({ userId: me.id, roles: ['READER'] }));
    expect(res.errors).toBeUndefined();
    const data = res.data as any;
    expect(byId(data.a, theirs)).toEqual(masked(theirs, 5));
    expect(byId(data.b.items, theirs)).toEqual(masked(theirs, 5));
  });

  it('an unreadable memory still answers MEMORY_NOT_FOUND, exactly like a missing one', async () => {
    const missing = generateId();
    for (const m of [unreadable.id, missing]) {
      const res = await gql(`query($m: ID!){ usageEvents(memoryId: $m){ id } }`, { m }, ctx({ userId: me.id, roles: ['READER'] }));
      expect(res.errors?.[0]?.message).toContain(`MEMORY_NOT_FOUND: ${m}`);
    }
  });
});

describe('#3688 — nodeUsage(loc), deprecated but live, masks the same way', () => {
  it('another user\'s row is volumes only; the caller\'s own row keeps its identity', async () => {
    const res = await gql(`{ nodeUsage(loc: "shared"){ ${IDENTITY} } }`, {}, ctx({ userId: me.id, roles: ['READER'] }));
    expect(res.errors).toBeUndefined();
    const rows = (res.data as any).nodeUsage;
    expect(byId(rows, theirs)).toEqual(masked(theirs, 5));
    expect(byId(rows, mine)).toEqual(raw());
  });

  it('an ADMIN gets the same masking', async () => {
    const res = await gql(`{ nodeUsage(loc: "shared"){ ${IDENTITY} } }`, {}, ctx({ userId: me.id, roles: ['ADMIN'] }));
    expect(res.errors).toBeUndefined();
    expect(byId((res.data as any).nodeUsage, theirs)).toEqual(masked(theirs, 5));
  });
});

describe('#3688 — the projection is an allowlist, and every SDL field is classified (cor:acl:090:01)', () => {
  it('every UsageEvent field in the SDL is either a volume field or an identity field, and no field is both', async () => {
    const res = await gql('{ __type(name: "UsageEvent") { fields(includeDeprecated: true) { name } } }', {}, ctx({ userId: me.id, roles: ['READER'] }));
    expect(res.errors).toBeUndefined();
    const sdl = ((res.data as any).__type.fields as Array<{ name: string }>).map(f => f.name).sort();
    const volume: readonly string[] = USAGE_VOLUME_FIELDS;
    const identity: readonly string[] = USAGE_IDENTITY_FIELDS;
    expect(volume.filter(f => identity.includes(f))).toEqual([]);
    expect([...volume, ...identity].sort()).toEqual(sdl);
  });

  it('a column the projection does not know is dropped from another principal\'s row, not passed through', () => {
    const row = { id: 'e1', type: 'read', userId: other.id, appId: null, ipAddress: '203.0.113.7', tokensIn: 4 };
    const [out] = projectUsageRowsFor(ctx({ userId: me.id, roles: ['READER'] }), [row]) as any[];
    expect(out.ipAddress).toBeUndefined();
    expect(out).toMatchObject({ id: 'e1', type: 'read', tokensIn: 4, userId: null });
  });

  it('the caller\'s own row is passed whole, including columns the projection does not know', () => {
    const row = { id: 'e2', type: 'read', userId: me.id, appId: null, ipAddress: '203.0.113.8' };
    expect(projectUsageRowsFor(ctx({ userId: me.id, roles: ['READER'] }), [row])).toEqual([row]);
  });

  it('an App key through the unified projection keeps its own appId and masks the rest, on its own App\'s rows too', () => {
    const key = ctx({ appId, appKeyId: 'k1', roles: [] });
    const rows = [
      { id: 'own', type: 'read', userId: other.id, sessionId: theirSession, organizationId: orgId, appId, actionArgs: { q: 'x' }, tokensIn: 2 },
      { id: 'foreign', type: 'read', userId: null, sessionId: null, organizationId: orgId, appId: 'some-other-app', actionArgs: null, tokensIn: 1 },
    ];
    const [own, foreign] = projectUsageRowsFor(key, rows) as any[];
    expect(own).toMatchObject({ id: 'own', appId, userId: null, sessionId: null, organizationId: null, actionArgs: null, tokensIn: 2 });
    expect(foreign).toMatchObject({ id: 'foreign', appId: null, organizationId: null, tokensIn: 1 });
  });
});
