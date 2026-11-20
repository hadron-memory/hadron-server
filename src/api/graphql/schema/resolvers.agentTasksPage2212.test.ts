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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
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

  it('limit 0 is count-only; a past-the-end offset is an empty page with the real total', async () => {
    for (let i = 0; i < 3; i++) await task(`c${i}`);
    expect(await page({ limit: 0 })).toEqual({ items: [], total: 3, hasMore: true });
    expect(await page({ limit: 5, offset: 10 })).toEqual({ items: [], total: 3, hasMore: false });
    expect(await page({ tag: 'none' })).toEqual({ items: [], total: 0, hasMore: false });
  });
});
