/**
 * #2817 — usageEvents / usageEventsPage scope and paging, per
 * hrn:node:hadronmemory.com:specs:cor:acl:090:01 (rev 7; ruling 0244 items 1 and 2) and
 * hrn:node:hadronmemory.com:specs:cor:api:120:04.
 *
 * Gate items (Xan, CHECKED 6706977753):
 *   1. An App key is admitted. Naming no resource it gets an EMPTY result, never an error; naming a
 *      memory it gets that memory's resource scope through the memory's own READ gate, and an
 *      unreadable memory answers MEMORY_NOT_FOUND like a missing one.
 *   2. Missing and unreadable memories answer MEMORY_NOT_FOUND identically (regression pin only).
 *   3. With no resource named (memoryId, nodeId or loc), a user reads its OWN activity
 *      (UsageEvent.userId = caller), never the accessible-memories feed. A named resource keeps the
 *      resource scope, and an empty resource scope never falls back to own activity.
 *   4. The legacy list's limit is capped like the paged sibling; the id tiebreak holds.
 *   5. Parity: both fields share one `where`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ApolloServer } from '@apollo/server';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: Record<string, unknown>, c: Context) => Promise<any>>;
const list = (args: Record<string, unknown>, c: Context) => Q.usageEvents(null, args, c);
const page = (args: Record<string, unknown>, c: Context) => Q.usageEventsPage(null, args, c);

let me: { id: string };
let other: { id: string };
let memA: { id: string; urn: string };
let memB: { id: string; urn: string };
let appMem: { id: string; urn: string };
let app: { id: string };
let appKeyId: string;
let foreignApp: { id: string };
let orgAId: string;
let pubMem: { id: string; urn: string };
let sessionId: string;

const ctx = (o: Partial<Context>): Context => ({ db, ...o }) as Context;
const asMe = () => ctx({ userId: me.id, roles: ['READER'] });
// The real hdr_app_ key context (middleware/auth.ts resolveAppKey): appId + appKeyId, roles [], no userId.
const asKey = () => ctx({ appId: app.id, appKeyId, organizationId: undefined, roles: [] });

const ev = (o: { userId?: string | null; memoryId?: string | null; nodeLoc?: string; type?: string; createdAt?: Date; id?: string }) => ({
  id: o.id ?? generateId(), type: o.type ?? 'read', nodeLoc: o.nodeLoc ?? 'x', memoryId: o.memoryId ?? null, userId: o.userId ?? null,
  ...(o.createdAt ? { createdAt: o.createdAt } : {}),
});
const ids = (rows: Array<{ id: string }>) => rows.map(r => r.id).sort();

let mineInA: string, mineInB: string, mineNoMem: string, otherInA: string, otherInApp: string;

beforeEach(async () => {
  await cleanDb(db);
  const orgA = await db.organization.create({ data: { id: generateId(), name: 'u2817-a', urn: `u2817-a-${generateId()}` } });
  const orgB = await db.organization.create({ data: { id: generateId(), name: 'u2817-b', urn: `u2817-b-${generateId()}` } });
  me = await db.user.create({ data: { githubId: 281701, githubUsername: 'u2817-me', roles: ['READER'] } });
  other = await db.user.create({ data: { githubId: 281702, githubUsername: 'u2817-other', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: orgA.id, userId: me.id, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: orgA.id, userId: other.id, role: 'READER' } });
  memA = await db.memory.create({ data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:a`, name: 'a', class: 'knowledge' } });
  // `me` cannot read memB (another org): its own past event there is still its own activity.
  memB = await db.memory.create({ data: { id: generateId(), organizationId: orgB.id, urn: `${orgB.urn}:b`, name: 'b', class: 'knowledge' } });
  const k = await createDbAppWithKey(db, 'u2817-app', orgA.id);
  app = k.app; appKeyId = k.appKey.id;
  orgAId = orgA.id;
  foreignApp = (await createDbAppWithKey(db, 'u2817-foreign', orgA.id)).app;
  // PUBLIC knowledge in another org, with no App and no owner (lib/auth/publicKnowledgeRead.ts).
  pubMem = await db.memory.create({ data: { id: generateId(), organizationId: orgB.id, urn: `${orgB.urn}:pub`, name: 'pub', class: 'knowledge', visibility: 'PUBLIC' } });
  sessionId = (await db.session.create({ data: { id: generateId(), userId: other.id } })).id;
  appMem = await db.memory.create({ data: { id: generateId(), organizationId: orgA.id, appId: app.id, urn: `${orgA.urn}:app`, name: 'app', class: 'app' } });

  mineInA = generateId(); mineInB = generateId(); mineNoMem = generateId(); otherInA = generateId(); otherInApp = generateId();
  await db.usageEvent.createMany({ data: [
    ev({ id: mineInA, userId: me.id, memoryId: memA.id, nodeLoc: 'shared' }),
    ev({ id: mineInB, userId: me.id, memoryId: memB.id, nodeLoc: 'b-only', type: 'write' }),
    ev({ id: mineNoMem, userId: me.id, memoryId: null, nodeLoc: 'nowhere' }),
    ev({ id: otherInA, userId: other.id, memoryId: memA.id, nodeLoc: 'shared' }),
    ev({ id: otherInApp, userId: other.id, memoryId: appMem.id, nodeLoc: 'app-loc' }),
  ] });
});

describe('#2817 item 1 — an App key is admitted', () => {
  it('naming no resource answers empty, not an error, on both fields', async () => {
    expect(await list({}, asKey())).toEqual([]);
    expect(await page({}, asKey())).toEqual({ items: [], total: 0, hasMore: false });
    // A non-resource filter is still no resource named.
    expect(await list({ type: 'read' }, asKey())).toEqual([]);
  });

  it('naming a memory it can read answers that memory\'s resource scope (every principal\'s events)', async () => {
    expect(ids(await list({ memoryId: appMem.id }, asKey()))).toEqual([otherInApp]);
    expect(ids((await page({ memoryId: appMem.urn }, asKey())).items)).toEqual([otherInApp]);
  });

  it('an invalid window is still BAD_USER_INPUT for an App key, checked before any resource (Gloria P3-7)', async () => {
    const bad = { since: '2026-01-02T00:00:00Z', until: '2026-01-01T00:00:00Z' };
    await expect(list(bad, asKey())).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await expect(page({ ...bad, memoryId: memB.id }, asKey())).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('naming a memory it cannot read answers MEMORY_NOT_FOUND, exactly like a missing one', async () => {
    const missingId = generateId();
    await expect(list({ memoryId: memB.id }, asKey())).rejects.toThrow(`MEMORY_NOT_FOUND: ${memB.id}`);
    await expect(list({ memoryId: missingId }, asKey())).rejects.toThrow(`MEMORY_NOT_FOUND: ${missingId}`);
  });

  it('a bare loc names a resource: the key gets that loc in its readable memories, never own activity', async () => {
    expect(ids(await list({ loc: 'app-loc' }, asKey()))).toEqual([otherInApp]);
    expect(await list({ loc: 'shared' }, asKey())).toEqual([]);
  });
});

// Dorian LOCAL P2-1, Gloria BLIND P2-1, Rico §10 P3-1/P3-2 at a8ff08e0. cor:acl:090:01: the resource scope
// discloses VOLUME, never another principal's identity and never the content they touched.
describe('#2817 review — what an App key\'s resource read discloses', () => {
  let identified: string, ownApp: string;
  beforeEach(async () => {
    identified = generateId(); ownApp = generateId();
    await db.usageEvent.createMany({ data: [
      { ...ev({ id: identified, userId: other.id, memoryId: appMem.id, nodeLoc: 'who' }), sessionId, appId: foreignApp.id, organizationId: orgAId, actionArgs: { q: 'secret' }, tokensIn: 7 },
      { ...ev({ id: ownApp, userId: other.id, memoryId: appMem.id, nodeLoc: 'mine-app' }), appId: app.id },
    ] });
  });

  it('masks other principals\' identity and the content they touched, keeping the volumes, on both fields', async () => {
    const fromList = (await list({ memoryId: appMem.id }, asKey())).find((r: { id: string }) => r.id === identified);
    const fromPage = (await page({ memoryId: appMem.id }, asKey())).items.find((r: { id: string }) => r.id === identified);
    for (const row of [fromList, fromPage]) {
      expect(row).toMatchObject({ userId: null, sessionId: null, appId: null, organizationId: null, actionArgs: null, tokensIn: 7, nodeLoc: 'who', memoryId: appMem.id });
    }
  });

  it('keeps the App\'s own appId: that is the caller\'s own identity, not another principal\'s', async () => {
    const row = (await list({ memoryId: appMem.id }, asKey())).find((r: { id: string }) => r.id === ownApp);
    expect(row).toMatchObject({ appId: app.id, userId: null });
  });

  it('through the real schema: usageEvents and usageEventsPage answer userId null to an App key', async () => {
    const server = new ApolloServer<Context>({ typeDefs, resolvers });
    const r = await server.executeOperation(
      { query: `query($m: ID!){ a: usageEvents(memoryId: $m){ id userId sessionId appId organizationId actionArgs } b: usageEventsPage(memoryId: $m){ items { id userId sessionId appId organizationId actionArgs } } }`, variables: { m: appMem.id } },
      { contextValue: asKey() },
    );
    if (r.body.kind !== 'single') throw new Error('incremental response');
    expect(r.body.singleResult.errors).toBeUndefined();
    const data = r.body.singleResult.data as any;
    for (const row of [...data.a, ...data.b.items].filter((x: { id: string }) => x.id === identified)) {
      expect(row).toEqual({ id: identified, userId: null, sessionId: null, appId: null, organizationId: null, actionArgs: null });
    }
    expect([...data.a, ...data.b.items].filter((x: { id: string }) => x.id === identified)).toHaveLength(2);
  });

  it('a user principal\'s resource read is unchanged by this PR (raw rows; tracked separately)', async () => {
    const row = (await list({ memoryId: appMem.id }, ctx({ userId: me.id, roles: ['ADMIN'] }))).find((r: { id: string }) => r.id === identified);
    expect(row?.userId).toBe(other.id);
  });

  it('own scope stays empty for an App key even when events carry its appId (Rico P3-1)', async () => {
    await db.usageEvent.create({ data: { ...ev({ userId: other.id, memoryId: memB.id }), appId: app.id } });
    expect(await list({}, asKey())).toEqual([]);
    expect(await page({}, asKey())).toEqual({ items: [], total: 0, hasMore: false });
  });

  it('naming PUBLIC knowledge answers its resource scope to an App key, as its READ gate admits (Rico P3-2)', async () => {
    const pub = generateId();
    await db.usageEvent.create({ data: ev({ id: pub, userId: other.id, memoryId: pubMem.id }) });
    const rows = await list({ memoryId: pubMem.id }, asKey());
    expect(ids(rows)).toEqual([pub]);
    expect(rows[0].userId).toBeNull();
    expect(ids((await page({ memoryId: pubMem.urn }, asKey())).items)).toEqual([pub]);
  });

  it('naming an exact node in PUBLIC knowledge answers it like naming the memory, on both fields (Dorian P2-2)', async () => {
    const n = await db.node.create({ data: { id: generateId(), memoryId: pubMem.id, loc: 'pub-node', name: 'Pub node' } });
    const pub = generateId();
    await db.usageEvent.create({ data: { ...ev({ id: pub, userId: other.id, memoryId: pubMem.id, nodeLoc: n.loc }), nodeId: n.id } });
    expect(ids(await list({ memoryId: pubMem.id }, asKey()))).toEqual([pub]);
    const rows = await list({ nodeId: n.id }, asKey());
    expect(ids(rows)).toEqual([pub]);
    expect(rows[0].userId).toBeNull();
    expect(ids((await page({ nodeId: `${pubMem.urn}:${n.loc}` }, asKey())).items)).toEqual([pub]);
  });

  it('naming an exact node in a memory the key cannot read still answers nothing (no widening)', async () => {
    const n = await db.node.create({ data: { id: generateId(), memoryId: memB.id, loc: 'b-node', name: 'B node' } });
    await db.usageEvent.create({ data: { ...ev({ userId: other.id, memoryId: memB.id, nodeLoc: n.loc }), nodeId: n.id } });
    expect(await list({ nodeId: n.id }, asKey())).toEqual([]);
    expect(await page({ nodeId: n.id }, asKey())).toEqual({ items: [], total: 0, hasMore: false });
  });
});

describe('#2817 item 2 — missing and unreadable memories answer alike (regression)', () => {
  it('a user naming an unreadable memory and a missing one both get MEMORY_NOT_FOUND', async () => {
    for (const memoryId of [memB.id, memB.urn, generateId()]) {
      await expect(page({ memoryId }, asMe())).rejects.toThrow(`MEMORY_NOT_FOUND: ${memoryId}`);
    }
  });
});

describe('#2817 item 3 — no resource named is the caller\'s own activity', () => {
  it('returns every event attributed to the caller, in any memory or none, and no one else\'s', async () => {
    expect(ids(await list({}, asMe()))).toEqual([mineInA, mineInB, mineNoMem].sort());
    const p = await page({}, asMe());
    expect(ids(p.items)).toEqual([mineInA, mineInB, mineNoMem].sort());
    expect(p.total).toBe(3);
  });

  it('a type filter or a window narrows own activity; it does not name a resource', async () => {
    expect(ids(await list({ type: 'write' }, asMe()))).toEqual([mineInB]);
    expect(ids(await list({ since: '2000-01-01T00:00:00Z' }, asMe()))).toEqual([mineInA, mineInB, mineNoMem].sort());
  });

  it('a named memory keeps the resource scope: other principals\' events, not just mine', async () => {
    expect(ids(await list({ memoryId: memA.id }, asMe()))).toEqual([mineInA, otherInA].sort());
    expect(ids(await list({ loc: 'shared' }, asMe()))).toEqual([mineInA, otherInA].sort());
  });

  it('an empty resource scope never falls back to own activity', async () => {
    // `b-only` exists only in memB, which `me` cannot read — even though the one event there is mine.
    expect(await list({ loc: 'b-only' }, asMe())).toEqual([]);
    expect(await list({ nodeId: 'b-only' }, asMe())).toEqual([]);
  });
});

describe('#2817 — principals the change must not admit', () => {
  it('an unauthenticated caller and an impersonation session stay refused', async () => {
    await expect(list({}, ctx({}))).rejects.toThrow('Forbidden');
    await expect(page({}, ctx({ userId: me.id, roles: [], impersonation: { orgId: 'x' } as Context['impersonation'] }))).rejects.toThrow('Forbidden');
  });

  it('only a USERLESS App principal is admitted: an App context that carries a user identity keeps the READER gate', async () => {
    // An impersonation session can carry an appId (resolvers.helpers.ts getAccessibleMemoryIds), and its roles are [].
    const c = ctx({ appId: app.id, userId: me.id, roles: [], impersonation: { orgId: 'x' } as Context['impersonation'] });
    await expect(list({}, c)).rejects.toThrow('Forbidden');
    await expect(page({ memoryId: appMem.id }, c)).rejects.toThrow('Forbidden');
  });
});

describe('#2817 review — the App-key admission keys on the key itself (Gloria P2-1)', () => {
  it('an App context with no user but no hdr_app_ key keeps the READER gate', async () => {
    const c = ctx({ appId: app.id, roles: [] });
    await expect(list({}, c)).rejects.toThrow('Forbidden');
    await expect(page({ memoryId: appMem.id }, c)).rejects.toThrow('Forbidden');
  });
});

describe('#2817 item 4 — the legacy list is bounded and ordered', () => {
  it('caps limit at the page maximum and treats a negative limit as 0', async () => {
    await db.usageEvent.createMany({ data: Array.from({ length: 205 }, () => ev({ userId: me.id, memoryId: memA.id })) });
    expect(await list({ limit: 1000 }, asMe())).toHaveLength(200);
    expect(await list({ limit: -1 }, asMe())).toHaveLength(0);
    expect(await list({}, asMe())).toHaveLength(20);
  });

  it('breaks createdAt ties by id descending, the same order as the page', async () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const tied = ['0aaa', '0ccc', '0bbb'].map(p => p + generateId().slice(4));
    await db.usageEvent.deleteMany({});
    await db.usageEvent.createMany({ data: tied.map(id => ev({ id, userId: me.id, memoryId: memA.id, createdAt: at })) });
    const desc = [...tied].sort().reverse();
    expect((await list({}, asMe())).map((r: { id: string }) => r.id)).toEqual(desc);
    expect((await page({}, asMe())).items.map((r: { id: string }) => r.id)).toEqual(desc);
  });
});
