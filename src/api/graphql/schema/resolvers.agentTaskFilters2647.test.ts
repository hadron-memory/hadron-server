import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let appId: string, userId: string, outsiderId: string;
const day = (n: number) => new Date(`2026-01-${String(n).padStart(2, '0')}T00:00:00Z`);
const ctx = (): Context => ({ db, userId, roles: ['READER'] });
const list = (args = {}, context = ctx()) => (resolvers.Query as any).agentTasks(null, { appRef: appId, ...args }, context);
const titles = (rows: any[]) => rows.map(row => row.title);
async function task(title: string, extra: Record<string, unknown> = {}) {
  return db.agentTask.create({ data: { appId, ownerUserId: userId, title, createdAt: day(1), ...extra } as any });
}
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Filters', urn: 'filters2647.example' } });
  userId = (await db.user.create({ data: { handle: 'filters2647-member' } })).id;
  outsiderId = (await db.user.create({ data: { handle: 'filters2647-outsider' } })).id;
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Filters', urn: 'filters2647.example:app' } })).id;
  await db.appMember.create({ data: { appId, userId, role: 'member' } });
  await task('both', { tags: ['red', 'blue'], source: 'issue:exact', createdAt: day(3) });
  await task('red', { tags: ['red'], source: 'issue:exact-more', createdAt: day(2) });
  await task('none');
});
it('applies any/all tags and exact opaque source together before paging', async () => {
  expect(titles(await list({ tagsAny: ['blue', 'green'] }))).toEqual(['both']);
  expect(titles(await list({ tagsAll: ['red', 'blue'] }))).toEqual(['both']);
  expect(titles(await list({ tagsAny: ['red'], tagsAll: ['blue'], source: 'issue:exact' }))).toEqual(['both']);
  expect(await list({ source: 'issue:' })).toEqual([]);
  expect(await list({ tagsAny: ['green'], tagsAll: ['blue'] })).toEqual([]);
  expect(titles(await list({ tagsAny: ['red'], limit: 1, offset: 1 }))).toEqual(['red']);
  expect(await list({ tagsAny: ['red'], offset: 9 })).toEqual([]);
  expect(await list({ tagsAny: [], tagsAll: [] })).toEqual(await list());
});
it.each(['created', 'started', 'finished'])('inclusive %s ranges exclude null dates and AND both bounds', async field => {
  if (field !== 'created') {
    for (const [title, n] of [['started-row', 4], ['finished-row', 5]] as const) await task(title, {
      status: field === 'finished' ? 'finished' : 'started', assigneeUserId: userId, assignedAt: day(n), startedAt: day(n),
      ...(field === 'finished' ? { finishedAt: day(n), resultOutcome: 'succeeded' } : {}),
    });
  }
  const n = field === 'created' ? 2 : 4;
  const rows = await list({ [`${field}After`]: day(n), [`${field}Before`]: day(n) });
  expect(titles(rows)).toEqual([field === 'created' ? 'red' : 'started-row']);
  expect(await list({ [`${field}After`]: day(8), [`${field}Before`]: day(9) })).toEqual([]);
});
it('overdue is strictly past database now, never backlog, started or ended', async () => {
  await db.$transaction(async tx => {
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds', CURRENT_TIMESTAMP) AS now`;
    await tx.agentTask.create({ data: { appId, ownerUserId: userId, title: 'already-started', status: 'started', assigneeUserId: userId, assignedAt: day(1), startedAt: day(1), startBy: day(1) } });
    await tx.agentTask.create({ data: { appId, ownerUserId: userId, title: 'ended', status: 'cancelled', cancelledAt: day(1), startBy: day(1) } });
    for (const [title, status, time] of [['past', 'pending', -1000], ['exact', 'pending', 0], ['future', 'pending', 1000], ['parked', 'backlog', -1000]] as const)
      await tx.agentTask.create({ data: { appId, ownerUserId: userId, title, status, startBy: new Date(now.getTime() + time) } });
    const c = { ...ctx(), db: tx } as unknown as Context;
    const appClock = vi.spyOn(Date, 'now').mockReturnValue(0);
    try { expect(titles(await list({ overdue: true }, c))).toEqual(['past']); }
    finally { appClock.mockRestore(); }
    const notOverdue = titles(await list({ overdue: false }, c));
    expect(notOverdue).toEqual(expect.arrayContaining(['exact', 'future', 'parked', 'none']));
    expect(notOverdue).not.toContain('past');
    expect(await list({ overdue: true, status: ['BACKLOG'] }, c)).toEqual([]);
  });
});
it('preserves APP_NOT_FOUND for every filter combination before validation', async () => {
  for (const args of [{}, { tagsAll: ['red'], source: 'issue:exact', overdue: true, createdAfter: day(1) }])
    await expect(list(args, { db, userId: outsiderId, roles: ['READER'] })).rejects.toMatchObject({ extensions: { code: 'APP_NOT_FOUND' } });
});
it('retains default order and the 200 cap after filtering', async () => {
  await db.agentTask.createMany({ data: Array.from({ length: 205 }, (_, i) => ({ appId, ownerUserId: userId, title: `cap-${i}`, tags: ['cap'] })) });
  expect(await list({ tagsAll: ['cap'], limit: 999 })).toHaveLength(200);
  expect(await list({ tagsAll: ['cap'] })).toHaveLength(20);
  expect(await list({ tagsAll: ['cap'], limit: 999, offset: 200 })).toHaveLength(5);
});
it('exposes the filters in executable GraphQL and the resolver', async () => {
  const api = new ApolloServer<Context>({ typeDefs, resolvers });
  try {
    const result = await api.executeOperation({ query: `query($app:ID!){agentTasks(appRef:$app,tagsAny:["red"],tagsAll:["blue"],source:"issue:exact",createdAfter:"2026-01-03T00:00:00Z",createdBefore:"2026-01-03T00:00:00Z"){title}}`, variables: { app: appId } }, { contextValue: ctx() });
    expect(result.body.kind).toBe('single');
    if (result.body.kind === 'single') { expect(result.body.singleResult.errors).toBeUndefined(); expect(result.body.singleResult.data).toEqual({ agentTasks: [{ title: 'both' }] }); }
    // #3082: the hadron_task_list MCP leg is gone with the tool; the resolver answers the same filters.
    expect(titles(await list({ tagsAny: ['red'], tagsAll: ['blue'], source: 'issue:exact', createdAfter: day(3), createdBefore: day(3) }))).toEqual(['both']);
    for (const args of [{ overdue: true }, { startedAfter: day(1) }, { startedBefore: day(9) }, { finishedAfter: day(1) }, { finishedBefore: day(9) }, { source: 'issue:' }]) {
      expect(await list(args)).toEqual([]);
    }
  } finally { await api.stop(); }
});

it('refuses invalid or reversed date ranges after the same read gate', async () => {
  for (const args of [{ createdAfter: 'not-a-date' }, { finishedAfter: day(3), finishedBefore: day(2) }]) {
    await expect(list(args)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await expect(list(args, { db, userId: outsiderId, roles: ['READER'] })).rejects.toMatchObject({ extensions: { code: 'APP_NOT_FOUND' } });
  }
});

it('rejects lenient date strings on the resolver and GraphQL paths', async () => {
  const api = new ApolloServer<Context>({ typeDefs, resolvers });
  await api.start();
  try {
    for (const field of ['createdAfter', 'createdBefore', 'startedAfter', 'startedBefore', 'finishedAfter', 'finishedBefore']) {
      for (const value of ['1', '2026', 'Jan 3 2026', '2026-01-03T00:00:00', '2026-02-30T00:00:00Z']) {
        await expect(list({ [field]: value })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
        await expect(list({ [field]: value }, { db, userId: outsiderId, roles: ['READER'] })).rejects.toMatchObject({ extensions: { code: 'APP_NOT_FOUND' } });
        const gql = await api.executeOperation({ query: `query($app:ID!,$date:DateTime!){agentTasks(appRef:$app,${field}:$date){id}}`, variables: { app: appId, date: value } }, { contextValue: ctx() });
        expect(gql.body.kind).toBe('single');
        if (gql.body.kind === 'single') expect(gql.body.singleResult.errors?.length).toBeGreaterThan(0);
      }
    }
    const equivalent = '2026-01-03T02:00:00+02:00';
    expect(titles(await list({ createdAfter: equivalent, createdBefore: equivalent }))).toEqual(['both']);
  } finally { await api.stop(); }
});

// #2696: tagsAny/tagsAll obey the same bounds a task's own tags do (32 elements, 64 characters each).
it.each(['tagsAny', 'tagsAll'])('%s accepts 32 tags and a 64-character tag, refuses 33 and 65, on resolver and GraphQL', async field => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
  const api = new ApolloServer<Context>({ typeDefs, resolvers });
  await api.start();
  const gql = async (value: string[]) => {
    const r = await api.executeOperation({ query: `query($app:ID!,$v:[String!]){agentTasks(appRef:$app,${field}:$v){id}}`, variables: { app: appId, v: value } }, { contextValue: ctx() });
    if (r.body.kind !== 'single') throw new Error('unexpected body');
    return r.body.singleResult.errors?.[0]?.extensions?.code;
  };
  try {
    const ok = [many(32), ['x'.repeat(64)]];
    const refused = [many(33), ['x'.repeat(65)]];
    for (const value of ok) {
      await expect(list({ [field]: value })).resolves.toBeDefined();
      expect(await gql(value)).toBeUndefined();
    }
    for (const value of refused) {
      await expect(list({ [field]: value })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
      // After the read gate: an outsider is told the App is not found, never the bound.
      await expect(list({ [field]: value }, { db, userId: outsiderId, roles: ['READER'] })).rejects.toMatchObject({ extensions: { code: 'APP_NOT_FOUND' } });
      expect(await gql(value)).toBe('BAD_USER_INPUT');
    }
    expect(await list({ [field]: [] })).toEqual(await list());
  } finally { await api.stop(); }
});
