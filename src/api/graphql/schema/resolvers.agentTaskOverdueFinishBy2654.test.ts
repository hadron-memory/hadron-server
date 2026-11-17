/** #2654 (ruling 0269, cor:agt:050:14 "Overdue, the list filter"): the overdue listing also covers a passed finish-by. */
import { beforeEach, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { isTaskOverdue } from './resolvers.agentTask.js';
import { typeDefs } from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let appId: string, otherAppId: string, userId: string, now: Date;
const ctx = (): Context => ({ db, userId, roles: ['READER'] });
const list = (args = {}, app = appId) => (resolvers.Query as any).agentTasks(null, { appRef: app, limit: 200, ...args }, ctx());
const titles = (rows: any[]) => rows.map((r) => r.title).sort();
const at = (ms: number) => new Date(now.getTime() + ms);
const PAST = -3600_000, FUTURE = 3600_000;
async function task(title: string, extra: Record<string, unknown> = {}, app = appId) {
  return db.agentTask.create({ data: { appId: app, ownerUserId: userId, title, ...extra } as any });
}
const started = (extra: Record<string, unknown>) => ({ status: 'started', assigneeUserId: userId, assignedAt: at(PAST), startedAt: at(PAST), ...extra });
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Overdue', urn: 'overdue2654.example' } });
  userId = (await db.user.create({ data: { handle: 'overdue2654-member' } })).id;
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Overdue', urn: 'overdue2654.example:app' } })).id;
  otherAppId = (await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: 'overdue2654.example:other' } })).id;
  await db.appMember.create({ data: { appId, userId, role: 'member' } });
  now = ((await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds', CURRENT_TIMESTAMP) AS now`))[0].now;
});

it('R1: a started, unfinished task past its finish-by is listed', async () => {
  await task('r1', started({ finishBy: at(PAST) }));
  expect(titles(await list({ overdue: true }))).toEqual(['r1']);
});
it('R2: a pending task with no start-by past its finish-by is listed, queued or assigned', async () => {
  await task('r2-queued', { finishBy: at(PAST) });
  await task('r2-assigned', { assigneeUserId: userId, assignedAt: at(PAST), finishBy: at(PAST) });
  expect(titles(await list({ overdue: true }))).toEqual(['r2-assigned', 'r2-queued']);
});
it('R3 (Proposed): a blocked task past its finish-by is listed', async () => {
  const blocker = await task('blocker');
  const t = await task('r3', { finishBy: at(PAST) });
  await db.agentTaskBlocker.create({ data: { taskId: t.id, blockerTaskId: blocker.id } });
  expect(titles(await list({ overdue: true }))).toContain('r3');
});
it('arm (a) unchanged; ended, backlog, no-time and future tasks are not listed; started past start-by only is not', async () => {
  await task('a', { startBy: at(PAST) });
  await task('finished', { status: 'finished', assigneeUserId: userId, assignedAt: at(PAST), startedAt: at(PAST), finishedAt: at(PAST), finishBy: at(PAST), startBy: at(PAST), resultOutcome: 'succeeded' });
  await task('cancelled', { status: 'cancelled', cancelledAt: at(PAST), finishBy: at(PAST), startBy: at(PAST) });
  await task('backlog', { status: 'backlog', finishBy: at(PAST), startBy: at(PAST) });
  await task('none');
  await task('future', { startBy: at(FUTURE), finishBy: at(FUTURE) });
  await task('started-start-by-only', started({ startBy: at(PAST) }));
  await task('started-future-finish', started({ startBy: at(PAST), finishBy: at(FUTURE) }));
  await task('person-assignee', { assigneeUserId: userId, assignedAt: at(PAST), finishBy: at(PAST) });
  expect(titles(await list({ overdue: true }))).toEqual(['a', 'person-assignee']);
  const rest = titles(await list({ overdue: false }));
  expect(rest).toEqual(['backlog', 'cancelled', 'finished', 'future', 'none', 'started-future-finish', 'started-start-by-only']);
});
it('strictly earlier: a finish-by or a start-by exactly at the server clock is not overdue', async () => {
  const fixed = await db.$transaction(async (tx) => {
    const [{ now: n }] = await tx.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds', CURRENT_TIMESTAMP) AS now`;
    await tx.agentTask.create({ data: { appId, ownerUserId: userId, title: 'edge', finishBy: n } as any });
    // Arm (a) has its own boundary: a pending, not-started task whose start-by equals the clock is in `false`, never in neither.
    await tx.agentTask.create({ data: { appId, ownerUserId: userId, title: 'edge-start', startBy: n } as any });
    const c = { ...ctx(), db: tx };
    const q = (overdue: boolean) => (resolvers.Query as any).agentTasks(null, { appRef: appId, overdue }, c);
    return [titles(await q(true)), titles(await q(false))];
  });
  expect(fixed).toEqual([[], ['edge', 'edge-start']]);
  // The field reads the same rule: equal to the clock is not overdue, a millisecond earlier is.
  const row = { status: 'started', startBy: null, finishBy: now, startedAt: now, finishedAt: null, cancelledAt: null } as any;
  expect(isTaskOverdue(row, now)).toBe(false);
  expect(isTaskOverdue({ ...row, finishBy: at(-1) }, now)).toBe(true);
  const pending = { status: 'pending', startBy: now, finishBy: null, startedAt: null, finishedAt: null, cancelledAt: null } as any;
  expect(isTaskOverdue(pending, now)).toBe(false);
  expect(isTaskOverdue({ ...pending, startBy: at(-1) }, now)).toBe(true);
});
it('listing records no event and no alarm', async () => {
  await task('quiet', started({ finishBy: at(PAST) }));
  const before = await db.agentTeamEvent.count();
  await list({ overdue: true }); await list({ overdue: false });
  expect(await db.agentTeamEvent.count()).toBe(before);
});
it('stays inside the App read scope', async () => {
  await task('theirs', { finishBy: at(PAST) }, otherAppId);
  expect(await list({ overdue: true })).toEqual([]);
});
it('differential: AgentTask.overdue is true iff the overdue filter lists the task', async () => {
  await task('a', { startBy: at(PAST) });
  await task('r1', started({ finishBy: at(PAST) }));
  await task('r2', { finishBy: at(PAST) });
  await task('finished', { status: 'finished', assigneeUserId: userId, assignedAt: at(PAST), startedAt: at(PAST), finishedAt: at(PAST), finishBy: at(PAST), resultOutcome: 'succeeded' });
  await task('backlog', { status: 'backlog', finishBy: at(PAST) });
  await task('none');
  await task('future', { startBy: at(FUTURE), finishBy: at(FUTURE) });
  await task('started-start-by-only', started({ startBy: at(PAST) }));
  const api = new ApolloServer<Context>({ typeDefs, resolvers });
  const run = async (overdue: boolean) => {
    const r = await api.executeOperation({ query: `query($app:ID!,$o:Boolean){agentTasks(appRef:$app,overdue:$o,limit:200){title overdue}}`, variables: { app: appId, o: overdue } }, { contextValue: ctx() });
    if (r.body.kind !== 'single' || r.body.singleResult.errors) throw new Error(JSON.stringify(r.body));
    return (r.body.singleResult.data as any).agentTasks as { title: string; overdue: boolean }[];
  };
  const yes = await run(true), no = await run(false);
  expect(yes.length).toBeGreaterThan(0); expect(no.length).toBeGreaterThan(0);
  expect(yes.every((t) => t.overdue)).toBe(true);
  expect(no.every((t) => !t.overdue)).toBe(true);
  expect(titles(yes).concat(titles(no)).sort()).toEqual(['a', 'backlog', 'finished', 'future', 'none', 'r1', 'r2', 'started-start-by-only']);
});
it('one request reads the clock once: a deadline crossed between the filter and the field cannot split them', async () => {
  const t0 = now;
  await task('crossing', { finishBy: new Date(t0.getTime() + 5_000) });
  let reads = 0;
  // Each clock read is 10s later than the last; two reads would put the deadline between them.
  const ticking = new Proxy(db as any, {
    get(target, prop, recv) {
      if (prop !== '$queryRaw') return Reflect.get(target, prop, recv);
      return (strings: TemplateStringsArray, ...rest: unknown[]) =>
        strings.join('?').includes('date_trunc')
          ? Promise.resolve([{ now: new Date(t0.getTime() + 10_000 * reads++) }])
          : target.$queryRaw(strings, ...rest);
    },
  });
  const api = new ApolloServer<Context>({ typeDefs, resolvers });
  const r = await api.executeOperation(
    { query: `query($app:ID!){agentTasks(appRef:$app,overdue:false,limit:200){title overdue}}`, variables: { app: appId } },
    { contextValue: { ...ctx(), db: ticking } },
  );
  if (r.body.kind !== 'single' || r.body.singleResult.errors) throw new Error(JSON.stringify(r.body));
  const rows = (r.body.singleResult.data as any).agentTasks as { title: string; overdue: boolean }[];
  expect(reads).toBe(1);
  expect(rows).toEqual([{ title: 'crossing', overdue: false }]);
});
