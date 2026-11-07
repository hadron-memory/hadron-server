/**
 * #2944: usage events record the App key that authenticated their request, and usageEvents / usageEventsPage
 * filter by it. hrn:node:hadronmemory.com:specs:cor:acl:090:01 rev 7 ("Filtering by App key"), rulings 0244
 * (items 3, 4, 5) and 0245. Gate: Xan 6706942145 (CHECKED T2 Standard+§10).
 *
 * Gate acceptance:
 *   1. An event made by a request an App key authenticated carries that key; every other event carries none and
 *      is never returned by a key filter.
 *   2. Who may filter by K: whoever manages K's App (cor:dmo:050:12) and K itself. Not a non-owner App member,
 *      not another key of the same App.
 *   3. A key the caller may not filter by answers exactly as a nonexistent key.
 *   4. A manager sees K's events only in memories they can read; naming a memory still needs READ
 *      (MEMORY_NOT_FOUND). It does not restore the broad unfiltered feed.
 *   5. K filtering by itself sees its own events.
 * Not pinned (open for Holger): K's events in a memory K can no longer read.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { drainNodeUsage, recordNodeUsage, usageAppKeyOf } from '../../../lib/usageRecorder.js';
import { requestActorStorage } from '../../../lib/requestActor.js';
import { ApolloServer } from '@apollo/server';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: Record<string, unknown>, c: Context) => Promise<any>>;
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: Record<string, unknown>, c: Context) => Promise<any>>;
const list = (args: Record<string, unknown>, c: Context) => Q.usageEvents(null, args, c);
const page = (args: Record<string, unknown>, c: Context) => Q.usageEventsPage(null, args, c);

const ctx = (o: Partial<Context>): Context => ({ db, ...o }) as Context;
const ids = (rows: Array<{ id: string }>) => rows.map(r => r.id).sort();

let orgA: { id: string; urn: string };
let app: { id: string };
let keyK: string;
let keyK2: string;
let foreignKey: string;
let mgr: { id: string };
let ownerMember: { id: string };
let plainMember: { id: string };
let foreignMgr: { id: string };
let memA: { id: string; urn: string };
let appMem: { id: string; urn: string };
let memB: { id: string; urn: string };

const asKey = (appKeyId: string, appId = app.id) => ctx({ appId, appKeyId, roles: [] });
const asUser = (u: { id: string }) => ctx({ userId: u.id, roles: ['READER'] });

async function mintKey(appId: string): Promise<string> {
  const raw = `hdr_app_${generateId()}`;
  const k = await db.appKey.create({ data: { appId, keyHash: createHash('sha256').update(raw).digest('hex'), keyPreview: raw.slice(-4) } });
  return k.id;
}

const ev = (o: { appKeyId?: string | null; userId?: string | null; memoryId?: string | null; createdAt?: Date; id?: string }) => ({
  id: o.id ?? generateId(), type: 'read', nodeLoc: 'x', memoryId: o.memoryId ?? null,
  userId: o.userId ?? null, appId: o.appKeyId ? app.id : null, appKeyId: o.appKeyId ?? null,
  ...(o.createdAt ? { createdAt: o.createdAt } : {}),
});

/** The one answer for a key the caller may not filter by and a key that does not exist (gate item 3). */
async function unknownKeyAnswer(p: Promise<unknown>): Promise<{ message: string; extensions: unknown }> {
  try {
    await p;
  } catch (e) {
    const err = e as { message: string; extensions: unknown };
    return { message: err.message, extensions: err.extensions };
  }
  throw new Error('expected the key filter to be refused');
}

beforeEach(async () => {
  await cleanDb(db);
  const a = await db.organization.create({ data: { id: generateId(), name: 'u2944-a', urn: `u2944-a-${generateId()}` } });
  const b = await db.organization.create({ data: { id: generateId(), name: 'u2944-b', urn: `u2944-b-${generateId()}` } });
  orgA = a;
  mgr = await db.user.create({ data: { githubId: 294401, githubUsername: 'u2944-mgr', roles: ['READER'] } });
  ownerMember = await db.user.create({ data: { githubId: 294402, githubUsername: 'u2944-owner', roles: ['READER'] } });
  plainMember = await db.user.create({ data: { githubId: 294403, githubUsername: 'u2944-bo', roles: ['READER'] } });
  foreignMgr = await db.user.create({ data: { githubId: 294404, githubUsername: 'u2944-foreign', roles: ['READER'] } });
  // mgr manages the org-owned App as an org ADMIN; the two members are org READERs.
  await db.orgMember.create({ data: { organizationId: a.id, userId: mgr.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: a.id, userId: ownerMember.id, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: a.id, userId: plainMember.id, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: b.id, userId: foreignMgr.id, role: 'ADMIN' } });

  const k = await createDbAppWithKey(db, 'u2944-app', a.id);
  app = k.app; keyK = k.appKey.id;
  keyK2 = await mintKey(app.id);
  await db.appMember.create({ data: { appId: app.id, userId: ownerMember.id, role: 'owner' } });
  await db.appMember.create({ data: { appId: app.id, userId: plainMember.id, role: 'member' } });
  foreignKey = (await createDbAppWithKey(db, 'u2944-foreign', b.id)).appKey.id;

  memA = await db.memory.create({ data: { id: generateId(), organizationId: a.id, urn: `${a.urn}:a`, name: 'a', class: 'knowledge' } });
  appMem = await db.memory.create({ data: { id: generateId(), organizationId: a.id, appId: app.id, urn: `${a.urn}:app`, name: 'app', class: 'app' } });
  // mgr cannot read memB (another org).
  memB = await db.memory.create({ data: { id: generateId(), organizationId: b.id, urn: `${b.urn}:b`, name: 'b', class: 'knowledge' } });
});

describe('#2944 item 1: an App-key request records its key; nothing else does', () => {
  it('a node read recorded for an App-key principal carries the key; for a user it carries none', async () => {
    const node = { id: null, loc: 'rec-key', memoryId: appMem.id } as never;
    recordNodeUsage(db, 'read', node, asKey(keyK));
    recordNodeUsage(db, 'read', { id: null, loc: 'rec-user', memoryId: memA.id } as never, asUser(mgr));
    await drainNodeUsage(db);
    const rows = await db.usageEvent.findMany({ where: { nodeLoc: { in: ['rec-key', 'rec-user'] } }, select: { nodeLoc: true, appKeyId: true } });
    expect(Object.fromEntries(rows.map(r => [r.nodeLoc, r.appKeyId]))).toEqual({ 'rec-key': keyK, 'rec-user': null });
  });

  it('a task run (action-run) by an App key carries the key; by a user, none', async () => {
    const task = await db.node.create({ data: { id: generateId(), memoryId: appMem.id, loc: 'tasks:k2944', name: 'k2944', content: 'run me' } });
    await M.runTask(null, { nodeRef: task.id }, asKey(keyK));
    await M.runTask(null, { nodeRef: task.id }, ctx({ userId: mgr.id, roles: ['READER'] }));
    await drainNodeUsage(db);
    const runs = await db.usageEvent.findMany({ where: { type: 'action-run', nodeId: task.id }, select: { appId: true, appKeyId: true } });
    expect(runs.map(r => r.appKeyId).sort()).toEqual([keyK, null].sort());
  });

  it('MCP hadron_run_action by an App key: its action-run and its node read both carry the key', async () => {
    const { createTestableMcpServer } = await import('../../../mcp/server.js');
    const task = await db.node.create({ data: { id: generateId(), memoryId: appMem.id, loc: 'tasks:m2944', name: 'm2944', content: 'run me' } });
    const server = createTestableMcpServer({ appId: app.id, appKeyId: keyK, roles: [], clientId: `app:${app.id}` } as never);
    const out = await server.callToolText('hadron_run_action', { urn: `hrn:node:${appMem.urn}:tasks:m2944` });
    expect(out).toContain('run me');
    await drainNodeUsage(db);
    const rows = await db.usageEvent.findMany({ where: { nodeId: task.id }, select: { type: true, appKeyId: true } });
    expect(rows.map(r => r.type).sort()).toEqual(['action-run', 'read']);
    expect(rows.every(r => r.appKeyId === keyK)).toBe(true);
  });

  it('only a pure App-key principal is attributed: a key id beside a user or under impersonation records none', () => {
    expect(usageAppKeyOf({ appId: 'a', appKeyId: 'k' })).toBe('k');
    expect(usageAppKeyOf({ appId: 'a', appKeyId: 'k', userId: 'u' })).toBeNull();
    expect(usageAppKeyOf({ appId: 'a', appKeyId: 'k', impersonation: { orgId: 'o' } })).toBeNull();
    expect(usageAppKeyOf({ appId: 'a', userId: 'u' })).toBeNull();
  });

  it('a keyless event in the same App and memory is never returned by a key filter', async () => {
    const kRow = generateId();
    await db.usageEvent.createMany({ data: [
      ev({ id: kRow, appKeyId: keyK, memoryId: appMem.id }),
      { ...ev({ memoryId: appMem.id }), appId: app.id }, // same App, no key: history, or a run
      ev({ userId: mgr.id, memoryId: appMem.id }),
    ] });
    expect(ids(await list({ appKey: keyK }, asUser(mgr)))).toEqual([kRow]);
  });
});

describe('#2944 items 2 and 4: whoever manages the App sees K in the memories they can read', () => {
  let kInApp: string, kInA: string, kInB: string, k2InA: string;
  beforeEach(async () => {
    kInApp = generateId(); kInA = generateId(); kInB = generateId(); k2InA = generateId();
    await db.usageEvent.createMany({ data: [
      ev({ id: kInApp, appKeyId: keyK, memoryId: appMem.id }),
      ev({ id: kInA, appKeyId: keyK, memoryId: memA.id }),
      ev({ id: kInB, appKeyId: keyK, memoryId: memB.id }),
      ev({ id: k2InA, appKeyId: keyK2, memoryId: memA.id }),
      ev({ userId: mgr.id, memoryId: memA.id }),
    ] });
  });

  it('an org ADMIN of the owning org, naming no memory, gets K in every memory they can read, and only K', async () => {
    expect(ids(await list({ appKey: keyK }, asUser(mgr)))).toEqual([kInA, kInApp].sort());
    const p = await page({ appKey: keyK }, asUser(mgr));
    expect(ids(p.items)).toEqual([kInA, kInApp].sort());
    expect(p.total).toBe(2);
  });

  it('an owner-role App member manages the App too', async () => {
    const seen = ids(await list({ appKey: keyK }, asUser(ownerMember)));
    expect(seen).toContain(kInApp);
    expect(seen).not.toContain(kInB);
    expect(seen).not.toContain(k2InA);
  });

  it('naming a memory narrows; an unreadable one answers MEMORY_NOT_FOUND exactly as a missing one', async () => {
    expect(ids(await list({ appKey: keyK, memoryId: memA.id }, asUser(mgr)))).toEqual([kInA]);
    const missing = generateId();
    await expect(list({ appKey: keyK, memoryId: memB.id }, asUser(mgr))).rejects.toThrow(`MEMORY_NOT_FOUND: ${memB.id}`);
    await expect(list({ appKey: keyK, memoryId: missing }, asUser(mgr))).rejects.toThrow(`MEMORY_NOT_FOUND: ${missing}`);
  });

  it('the window composes with the key filter', async () => {
    const old = generateId();
    await db.usageEvent.create({ data: ev({ id: old, appKeyId: keyK, memoryId: memA.id, createdAt: new Date('2026-01-01T00:00:00Z') }) });
    expect(ids(await list({ appKey: keyK, until: '2026-02-01T00:00:00Z' }, asUser(mgr)))).toEqual([old]);
    expect(ids(await list({ appKey: keyK, since: '2026-02-01T00:00:00Z' }, asUser(mgr)))).toEqual([kInA, kInApp].sort());
  });

  it('over GraphQL: both fields take appKey, and a refused key is APP_KEY_NOT_FOUND on the wire', async () => {
    const server = new ApolloServer<Context>({ typeDefs, resolvers });
    const q = `query($k: ID!){ a: usageEvents(appKey: $k){ id } b: usageEventsPage(appKey: $k){ total items { id } } }`;
    const ok = await server.executeOperation({ query: q, variables: { k: keyK } }, { contextValue: asUser(mgr) });
    if (ok.body.kind !== 'single') throw new Error('incremental response');
    expect(ok.body.singleResult.errors).toBeUndefined();
    const data = ok.body.singleResult.data as { a: Array<{ id: string }>; b: { total: number; items: Array<{ id: string }> } };
    expect(ids(data.a)).toEqual([kInA, kInApp].sort());
    expect(data.b.total).toBe(2);
    const denied = await server.executeOperation({ query: q, variables: { k: keyK } }, { contextValue: asUser(plainMember) });
    if (denied.body.kind !== 'single') throw new Error('incremental response');
    expect(denied.body.singleResult.errors?.[0]).toMatchObject({ message: 'App key not found.', extensions: { code: 'APP_KEY_NOT_FOUND', id: keyK } });
  });

  it('without the key filter the manager still reads own activity only (no broad feed restored)', async () => {
    expect(await list({}, asUser(mgr))).toHaveLength(1);
  });
});

describe('#2944 item 5: K filtering by itself sees its own events', () => {
  it('naming no resource, the key gets its events and no other key\'s', async () => {
    const mine = generateId(), mineNoMem = generateId(), sibling = generateId();
    await db.usageEvent.createMany({ data: [
      ev({ id: mine, appKeyId: keyK, memoryId: appMem.id }),
      ev({ id: mineNoMem, appKeyId: keyK, memoryId: null }),
      ev({ id: sibling, appKeyId: keyK2, memoryId: appMem.id }),
    ] });
    expect(ids(await list({ appKey: keyK }, asKey(keyK)))).toEqual([mine, mineNoMem].sort());
    expect((await page({ appKey: keyK }, asKey(keyK))).total).toBe(2);
    // With no key and no resource named, the key still gets the empty own-activity result (#2817).
    expect(await list({}, asKey(keyK))).toEqual([]);
  });
});

describe('#2944 item 3: a key the caller may not filter by answers exactly as a nonexistent key', () => {
  it('a nonexistent key answers APP_KEY_NOT_FOUND naming the caller\'s reference', async () => {
    const missing = generateId();
    await expect(list({ appKey: missing }, asUser(mgr))).rejects.toMatchObject({
      message: 'App key not found.', extensions: { code: 'APP_KEY_NOT_FOUND', id: missing },
    });
  });

  it('a non-owner App member, another key of the same App, another tenant\'s manager and another tenant\'s key all get that answer', async () => {
    const missing = generateId();
    const expected = (ref: string) => ({ message: 'App key not found.', extensions: { code: 'APP_KEY_NOT_FOUND', id: ref } });
    expect(await unknownKeyAnswer(list({ appKey: missing }, asUser(plainMember)))).toEqual(expected(missing));
    expect(await unknownKeyAnswer(list({ appKey: keyK }, asUser(plainMember)))).toEqual(expected(keyK));
    expect(await unknownKeyAnswer(list({ appKey: keyK }, asKey(keyK2)))).toEqual(expected(keyK));
    expect(await unknownKeyAnswer(page({ appKey: keyK }, asUser(foreignMgr)))).toEqual(expected(keyK));
    expect(await unknownKeyAnswer(list({ appKey: foreignKey }, asUser(mgr)))).toEqual(expected(foreignKey));
  });

  it('a bound worker session whose holder manages the App gets the unknown-key answer (person-only gate)', async () => {
    const asWorker = requestActorStorage.run({ workerId: generateId(), agentId: null }, () => list({ appKey: keyK }, asUser(mgr)));
    expect(await unknownKeyAnswer(asWorker)).toEqual({ message: 'App key not found.', extensions: { code: 'APP_KEY_NOT_FOUND', id: keyK } });
  });

  it('the key is judged before any memory is resolved, so a refused key never reveals a memory', async () => {
    const expected = { message: 'App key not found.', extensions: { code: 'APP_KEY_NOT_FOUND', id: keyK } };
    expect(await unknownKeyAnswer(list({ appKey: keyK, memoryId: memA.id }, asUser(plainMember)))).toEqual(expected);
    expect(await unknownKeyAnswer(list({ appKey: keyK, memoryId: generateId() }, asUser(plainMember)))).toEqual(expected);
  });

  it('an impersonation session stays refused as today (Forbidden), before the key is looked at', async () => {
    const imp = ctx({ userId: mgr.id, roles: [], impersonation: { orgId: orgA.id } as Context['impersonation'] });
    await expect(list({ appKey: keyK }, imp)).rejects.toThrow('Forbidden');
  });
});
