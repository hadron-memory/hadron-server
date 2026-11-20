/**
 * hadron-server#2212 slice A3 remainder (hrn:node:hadronmemory.com:specs:cor:api:120:04, cor:agt:050:21):
 * agentTasksPage, the `<field>Page` sibling of agentTasks. Red-first pins:
 *  1. 25 tasks paged at 7 cover every task once, in the old order; each filter's total is the filtered count.
 *  2. A non-participant gets the old field's refusal (APP_NOT_FOUND), exactly like an absent App.
 *  3. Tasks with an identical createdAt page without repeats or gaps (the id tiebreak).
 *  4. total never counts what the caller cannot read: another App's tasks, and AT0.
 *  5. limit 0 is count-only; a past-the-end offset is an empty page that still states the real total.
 *  6. items equal the old field's rows for the same arguments.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, parse } from 'graphql';
import { getComplexity, simpleEstimator } from 'graphql-query-complexity';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { pageArgs } from './resolvers.helpers.js';
import { hadronListEstimator } from '../admissionComplexity.js';
import { generateId } from '../../../lib/id.js';
import { ensureProjectZero } from '../../../lib/agentTasks/projectZero.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let appId: string; let otherAppId: string; let userId: string; let outsiderId: string;
const ctx = (): Context => ({ db, userId, roles: ['READER'] });
const outsider = (): Context => ({ db, userId: outsiderId, roles: ['READER'] });
type Page = { items: Array<{ id: string; title: string }>; total: number; hasMore: boolean };
const page = (args: Record<string, unknown> = {}, context = ctx()): Promise<Page> =>
  (resolvers.Query as any).agentTasksPage(null, { appRef: appId, ...args }, context);
const list = (args: Record<string, unknown> = {}, context = ctx()): Promise<Array<{ id: string }>> =>
  (resolvers.Query as any).agentTasks(null, { appRef: appId, ...args }, context);
async function task(title: string, extra: Record<string, unknown> = {}, app = appId) {
  return db.agentTask.create({ data: { appId: app, ownerUserId: userId, title, ...extra } as any });
}
async function walk(args: Record<string, unknown>, size: number) {
  const seen: string[] = []; let offset = 0; let pages = 0; let total = -1;
  for (;;) {
    const p = await page({ ...args, limit: size, offset });
    total = p.total; seen.push(...p.items.map((i) => i.id)); pages += 1;
    if (!p.hasMore) break;
    offset += p.items.length;
    if (pages > 50) throw new Error('runaway paging');
  }
  return { seen, total };
}

afterEach(() => { vi.restoreAllMocks(); });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Page', urn: 'page2212.example' } });
  userId = (await db.user.create({ data: { handle: 'page2212-member' } })).id;
  outsiderId = (await db.user.create({ data: { handle: 'page2212-outsider' } })).id;
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Page', urn: 'page2212.example:app' } })).id;
  otherAppId = (await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: 'page2212.example:other' } })).id;
  await db.appMember.create({ data: { appId, userId, role: 'member' } });
  await db.appMember.create({ data: { appId: otherAppId, userId, role: 'member' } });
});

describe('#2212 A3 agentTasksPage', () => {
  it('the SDL carries agentTasksPage returning AgentTaskPage { items, total, hasMore }', async () => {
    const api = new ApolloServer<Context>({ typeDefs, resolvers });
    await api.start();
    try {
      await task('one');
      const r = await api.executeOperation(
        { query: 'query($a:ID!){agentTasksPage(appRef:$a,limit:5){items{id title} total hasMore}}', variables: { a: appId } },
        { contextValue: ctx() });
      if (r.body.kind !== 'single') throw new Error('unexpected body');
      expect(r.body.singleResult.errors).toBeUndefined();
      expect(r.body.singleResult.data).toMatchObject({ agentTasksPage: { total: 1, hasMore: false, items: [{ title: 'one' }] } });
    } finally { await api.stop(); }
  });

  it('25 tasks paged at 7 cover every task once, in the old field\'s order; each filter\'s total is the filtered count', async () => {
    for (let i = 0; i < 25; i++) {
      await task(`t${i}`, { tags: i % 2 ? ['odd'] : ['even'], status: i % 5 === 0 ? 'backlog' : 'pending' });
    }
    const all = await walk({}, 7);
    expect(all.total).toBe(25);
    expect(all.seen).toEqual((await list({ limit: 200 })).map((r) => r.id));
    expect(new Set(all.seen).size).toBe(25);
    for (const [args, n] of [[{ tag: 'odd' }, 12], [{ status: ['BACKLOG'] }, 5], [{ queued: true }, 20], [{ rootsOnly: true }, 25]] as const) {
      const w = await walk(args, 7);
      expect(w.total).toBe(n);
      expect(w.seen).toEqual((await list({ ...args, limit: 200 })).map((r) => r.id));
    }
  });

  it('tasks with an identical createdAt page without repeats or gaps', async () => {
    const at = new Date('2026-11-20T12:00:00Z');
    for (let i = 0; i < 9; i++) await task(`same${i}`, { createdAt: at });
    const w = await walk({}, 4);
    expect(w.total).toBe(9);
    expect(new Set(w.seen).size).toBe(9);
    expect(w.seen).toEqual((await list({ limit: 200 })).map((r) => r.id));
  });

  it('a non-participant gets the old field\'s APP_NOT_FOUND, exactly like an absent App', async () => {
    await task('secret');
    const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { extensions?: { code?: string }; message?: string }) => `${e.extensions?.code}|${e.message}`);
    const pageOutsider = await code(page({}, outsider()));
    expect(pageOutsider).toMatch(/^APP_NOT_FOUND\|/);
    expect(await code(page({ appRef: generateId() }))).toBe(pageOutsider);
    expect(await code(list({}, outsider()))).toBe(pageOutsider);
  });

  it('total never counts what the caller cannot read: another App\'s tasks, or the AT0 bookkeeping row', async () => {
    await ensureProjectZero(db as never, appId, { userId });
    expect(await db.agentTask.count({ where: { appId, handle: 'AT0' } })).toBe(1);
    await task('mine-1'); await task('mine-2');
    for (let i = 0; i < 4; i++) await task(`theirs-${i}`, {}, otherAppId);
    const p = await page();
    expect(p.total).toBe((await list({ limit: 200 })).length);
    expect(p.total).toBe(p.items.length);
    expect(p.items.map((i) => i.title).sort()).toEqual(['mine-1', 'mine-2']);
  });

  it('an externalIds batch with no limit pages at 20 like any filter, and hasMore carries the rest (no widening to 200)', async () => {
    for (let i = 0; i < 23; i++) await task(`x${i}`, { externalId: `ext-${i}` });
    const ids = Array.from({ length: 23 }, (_, i) => `ext-${i}`);
    const first = await page({ externalIds: ids });
    expect(first.items).toHaveLength(20);
    expect(first).toMatchObject({ total: 23, hasMore: true });
    const rest = await page({ externalIds: ids, offset: 20 });
    expect(rest.items).toHaveLength(3);
    expect(rest.hasMore).toBe(false);
    // The legacy list keeps its own rule: the whole batch at once.
    expect(await list({ externalIds: ids })).toHaveLength(23);
  });

  it('limit 0 is count-only; a past-the-end offset is an empty page with the real total', async () => {
    for (let i = 0; i < 3; i++) await task(`c${i}`);
    expect(await page({ limit: 0 })).toEqual({ items: [], total: 3, hasMore: true });
    expect(await page({ limit: 5, offset: 10 })).toEqual({ items: [], total: 3, hasMore: false });
    expect(await page({ tag: 'none' })).toEqual({ items: [], total: 0, hasMore: false });
  });

  it('items and total come from ONE snapshot: a task deleted between the two reads changes neither (Beckett P2)', async () => {
    for (let i = 0; i < 6; i++) await task(`s${i}`, { createdAt: new Date(Date.UTC(2026, 10, 20, 12, i)) });
    const oldest = (await db.agentTask.findFirstOrThrow({ where: { appId, title: 's0' } })).id;
    let fired = false;
    // Deleted from the OUTER pool, a different connection from any transaction the read holds, just before the count runs.
    const deleteOldest = async () => { if (!fired) { fired = true; await db.$executeRawUnsafe('DELETE FROM agent_tasks WHERE id = $1', oldest); } };
    // Path 1 (the coherent read): its transaction client, wrapped so its count deletes first.
    const realTx = db.$transaction.bind(db);
    vi.spyOn(db, '$transaction').mockImplementation(((fn: unknown, opts: unknown) => {
      if (typeof fn !== 'function') return (realTx as any)(fn, opts);
      return (realTx as any)((tx: any) => {
        const agentTask = new Proxy(tx.agentTask, { get(t, k) {
          if (k === 'count') return async (a: unknown) => { await deleteOldest(); return t.count(a); };
          const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v;
        } });
        return fn(new Proxy(tx, { get(t, k) { if (k === 'agentTask') return agentTask; const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v; } }));
      }, opts);
    }) as never);
    // Path 2 (a read with no shared snapshot): the plain client's count deletes first too.
    const realCount = db.agentTask.count.bind(db.agentTask);
    vi.spyOn(db.agentTask, 'count').mockImplementation((async (a: unknown) => { await deleteOldest(); return (realCount as any)(a); }) as never);
    const p = await page({ limit: 5 });
    expect(fired).toBe(true);
    expect(p.items.map((i) => i.title)).toEqual(['s5', 's4', 's3', 's2', 's1']);
    expect(p).toMatchObject({ total: 6, hasMore: true });
  });

  it('the App\'s own live key reads the page; another App\'s key gets APP_NOT_FOUND like an absent App', async () => {
    await task('k1'); await task('k2');
    const mk = async (app: string) => (await db.appKey.create({ data: { id: generateId(), appId: app, keyHash: `h-${generateId()}`, keyPreview: 'abcd' }, select: { id: true } })).id;
    const keyCtx = (app: string, keyId: string): Context => ({ db, appId: app, appKeyId: keyId, roles: [] } as Context);
    const own = await page({}, keyCtx(appId, await mk(appId)));
    expect(own).toMatchObject({ total: 2, hasMore: false });
    expect(own.items.map((i) => i.title).sort()).toEqual(['k1', 'k2']);
    const code = (q: Promise<unknown>) => q.then(() => 'OK', (e: { extensions?: { code?: string }; message?: string }) => `${e.extensions?.code}|${e.message}`);
    const foreign = await code(page({}, keyCtx(otherAppId, await mk(otherAppId))));
    expect(foreign).toMatch(/^APP_NOT_FOUND\|/);
    expect(await code(page({ appRef: generateId() }))).toBe(foreign);
  });
});

describe('admission drift guard: agentTasksPage is charged for the page pageArgs reads (Beckett P3)', () => {
  const schema = buildSchema(typeDefs);
  const est = hadronListEstimator({ maxCost: 200000, listFactor: 10 });
  const cost = (extra: string) => getComplexity({
    schema, query: parse(`{ agentTasksPage(appRef: "a"${extra}) { items { id } } }`), variables: {},
    estimators: [est, simpleEstimator({ defaultComplexity: 1 })],
  });
  // wrapper = 1 + max(1, size / listFactor) x items; items = 1 + listFactor x id (the myChatsPage guard's formula)
  const expected = (take: number) => 1 + Math.max(1, Math.max(1, take) / 10) * 11;
  it.each([undefined, null, 0, -5, 1, 20, 200, 201, 1000000])('limit %s costs what its pageArgs take costs', (v) => {
    const take = pageArgs({ limit: v as number | null | undefined }).take;
    expect(cost(v === undefined ? '' : `, limit: ${v}`)).toBe(expected(take));
  });
  it('an externalIds batch with no limit is charged like any omitted limit (no widening to 200)', () => {
    expect(cost(', externalIds: ["a", "b"]')).toBe(expected(pageArgs({}).take));
  });
});
