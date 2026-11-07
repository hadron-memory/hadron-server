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
import { resolvers, type Context } from './resolvers.js';

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

const ctx = (o: Partial<Context>): Context => ({ db, ...o }) as Context;
const asMe = () => ctx({ userId: me.id, roles: ['READER'] });
// The real hdr_app_ key context (middleware/auth.ts resolveAppKey): appId + appKeyId, roles [], no userId.
const asKey = () => ctx({ appId: app.id, appKeyId, organizationId: undefined, roles: [] });

const ev = (o: { userId?: string | null; memoryId?: string | null; nodeLoc?: string; type?: string; createdAt?: Date; id?: string }) => ({
  id: o.id ?? generateId(), type: (o.type ?? 'read') as 'read', nodeLoc: o.nodeLoc ?? 'x', memoryId: o.memoryId ?? null, userId: o.userId ?? null,
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
