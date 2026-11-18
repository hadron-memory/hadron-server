import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/** #2178 — authorized pause and selected-task display, shared by GraphQL and MCP. */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from './typeDefs.js';
import { loadRosterTaskSummaries } from '../../../lib/agentTasks/rosterSummary.js';
import * as taskReadPolicy from './resolvers.agentTask.js';
import { declareAllStopLanes } from '../../../test/stopLanes.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { renderRosterEntry } from '../../../mcp/agentTaskTools.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const server = new ApolloServer<Context>({ typeDefs, resolvers });
beforeAll(() => server.start());
afterAll(() => server.stop());
const MIN = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN);

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

let app: { id: string };
let appUrn: string;
let agentId: string;
let admin: { id: string };
let mia: { id: string };
let outsider: { id: string };
const w: Record<string, { id: string }> = {};

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Roster', urn: `roster-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 610_000 + n, githubUsername: `ro-admin-${n}`, roles: ['READER'] } });
  mia = await db.user.create({ data: { githubId: 620_000 + n, githubUsername: `ro-mia-${n}`, roles: ['READER'] } });
  outsider = await db.user.create({ data: { githubId: 630_000 + n, githubUsername: `ro-out-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  agentId = agent.id;
  appUrn = `roster-${n}.example:team`;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: appUrn }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
  for (const name of ['Anne', 'Rook', 'Kit']) {
    w[name] = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(), role: 'engineer', heldByUserId: mia.id },
      select: { id: true },
    });
  }
});

const task = (data: Record<string, unknown>) =>
  db.agentTask.create({ data: { appId: app.id, title: 'T', ownerUserId: mia.id, assignedAt: ago(5), ...(data.status === 'started' ? {startedAt: ago(1)} : {}), ...data }, select: { id: true } });

async function roster(userId = mia.id) {
  return Q.teamRoster({}, { appRef: app.id }, ctx(userId));
}
async function entry(name: string) {
  const r = await roster();
  return r.workers.find((e: { name: string }) => e.name === name);
}

describe('#2178 safe roster enrichment — red first', () => {
  it('returns explicit null for no task/own pause without inventing a status', async () => {
    const e = await entry('Kit');
    expect(e.currentTask).toBeNull();
    expect(e.pausedUntil).toBeNull();
    expect(e.state).toBe('NOT_LAUNCHABLE');
  });

  it('preserves an expired own pause timestamp separately from a team pause', async () => {
    const expired=ago(10);
    await db.workerWakeSettings.create({data:{workerId:w.Kit.id,pausedUntil:expired}});
    await db.app.update({where:{id:app.id},data:{teamPausedAt:new Date()}});
    expect((await entry('Kit')).pausedUntil).toEqual(expired);
  });

  it('keeps own pause history separate from current own, team and S6 stop reasons', async () => {
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: w.Kit.id, agentId, userId: mia.id, tool: 'vitest' } });
    await task({ title: 'open assignment', status: 'pending', assigneeWorkerId: w.Kit.id });
    const future = new Date(Date.now() + 60_000);
    await db.workerWakeSettings.create({ data: { workerId: w.Kit.id, pausedUntil: future } });
    expect(await entry('Kit')).toMatchObject({ pausedUntil: future, checkStatus: { status: 'PENDING', pendingReason: 'PAUSED' } });
    await db.app.update({ where: { id: app.id }, data: { teamPausedAt: new Date() } });
    expect(await entry('Kit')).toMatchObject({ pausedUntil: future, checkStatus: { pendingReason: 'TEAM_PAUSED' } });
    await db.app.update({ where: { id: app.id }, data: { teamPausedAt: null } });
    const expired = ago(1);
    await db.workerWakeSettings.update({ where: { workerId: w.Kit.id }, data: { pausedUntil: expired } });
    expect((await entry('Kit')).checkStatus.pendingReason).toBeNull();
    await declareAllStopLanes(db, app.id);
    await M.setTeamStopSignal({}, { input: { appRef: app.id, level: 'PAUSE', scope: 'WORKER', worker: w.Kit.id } }, ctx(admin.id));
    expect(await entry('Kit')).toMatchObject({ pausedUntil: expired, checkStatus: { status: 'PENDING', pendingReason: 'STOPPED' } });
  });

  it('selects STARTED ahead of PENDING, oldest assigned first, even without a session', async () => {
    await task({title:'pending older',status:'pending',assigneeWorkerId:w.Kit.id,assignedAt:ago(30)});
    const expected=await task({title:'started oldest',status:'started',assigneeWorkerId:w.Kit.id,assignedAt:ago(20)});
    await task({title:'started newer',status:'started',assigneeWorkerId:w.Kit.id,assignedAt:ago(5)});
    const e=await entry('Kit');
    expect(e.liveSession).toBe(false);
    expect(e.currentTask).toEqual({id:expected.id,title:'started oldest',status:'started'});
  });

  it('uses createdAt then id for equal assignment times', async () => {
    const time=ago(15);
    const a=await task({id:'a2178task000000000000000001',title:'first tie',status:'pending',assigneeWorkerId:w.Kit.id,assignedAt:time,createdAt:time});
    await task({id:'z2178task000000000000000001',title:'last tie',status:'pending',assigneeWorkerId:w.Kit.id,assignedAt:time,createdAt:time});
    expect((await entry('Kit')).currentTask).toEqual({id:a.id,title:'first tie',status:'pending'});
  });

  it('drops cancelled/reassigned tasks on the next read without matching side effects', async () => {
    const first=await task({title:'cancelled',status:'started',assigneeWorkerId:w.Kit.id,assignedAt:ago(30)});
    await db.agentTask.update({where:{id:first.id},data:{status:'cancelled',cancelledAt:new Date()}});
    const moved=await task({title:'elsewhere',status:'started',assigneeWorkerId:w.Rook.id,assignedAt:ago(20)});
    const expected=await task({title:'remaining pending',status:'pending',assigneeWorkerId:w.Kit.id,assignedAt:ago(10)});
    expect((await entry('Kit')).currentTask).toEqual({id:expected.id,title:'remaining pending',status:'pending'});
    expect((await entry('Rook')).currentTask.id).toBe(moved.id);
  });

  it('prints the same authorized selected title through the roster renderer (hadron_team_roster is off over MCP, #3082)', async () => {
    await task({title:'selected title 2178',status:'started',assigneeWorkerId:w.Kit.id,assignedAt:ago(1)});
    expect(renderRosterEntry(await entry('Kit'), new Date())).toContain('selected title 2178');
  });

  it('renders stored pause tense against the roster snapshot, including equality, rather than the host clock', async () => {
    const r = await entry('Kit');
    const asOf = new Date('2030-01-01T00:00:00.000Z');
    const ended = new Date(asOf.getTime() - 1);
    const future = new Date(asOf.getTime() + 1);
    expect(renderRosterEntry({ ...r, pausedUntil: ended }, asOf)).toContain(`own pause ended ${ended.toISOString()}`);
    expect(renderRosterEntry({ ...r, pausedUntil: asOf }, asOf)).toContain(`own pause ended ${asOf.toISOString()}`);
    expect(renderRosterEntry({ ...r, pausedUntil: future }, asOf)).toContain(`own pause until ${future.toISOString()}`);
  });

  it('labels the selected task as an assignment and expired pause as ended in the roster renderer', async () => {
    await task({ title: 'pending display only', status: 'pending', assigneeWorkerId: w.Kit.id });
    const expired = ago(10);
    await db.workerWakeSettings.create({ data: { workerId: w.Kit.id, pausedUntil: expired } });
    const text = renderRosterEntry(await entry('Kit'), new Date());
    expect(text).toContain('top assignment');
    expect(text).toContain(`own pause ended ${expired.toISOString()}`);
    expect(text).not.toContain('current task');
  });

  it('orders a defensive null assignment after a dated one without relaxing production task constraints', async () => {
    // Assigned tasks currently require assignedAt. A transaction-local synthetic relation exercises the real
    // read SQL's defensive ordering without weakening that CHECK or creating an invalid production-shaped row.
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`CREATE TEMP TABLE agent_tasks (
        id text, title text, status text, app_id text, assignee_worker_id text,
        assigned_at timestamp, created_at timestamp
      ) ON COMMIT DROP`;
      await tx.$executeRaw`INSERT INTO agent_tasks VALUES
        ('null-task', 'undated', 'pending', 'synthetic-app', 'synthetic-worker', NULL, '2000-01-01'),
        ('dated-task', 'dated', 'pending', 'synthetic-app', 'synthetic-worker', '2001-01-01', '2001-01-01')`;
      expect(await loadRosterTaskSummaries(tx, 'synthetic-app', ['synthetic-worker'])).toEqual(new Map([
        ['synthetic-worker', { id: 'dated-task', title: 'dated', status: 'pending' }],
      ]));
    });
  });

  it('projects the nullable leaf and enum through the actual GraphQL schema', async () => {
    const t = await task({ title: 'GraphQL selected', status: 'pending', assigneeWorkerId: w.Kit.id });
    const response = await server.executeOperation({
      query: 'query($app: ID!) { teamRoster(appRef: $app) { workers { worker { name } pausedUntil currentTask { id title status } } } }',
      variables: { app: app.id },
    }, { contextValue: ctx(mia.id) });
    expect(response.body.kind).toBe('single');
    if (response.body.kind !== 'single') throw new Error('Expected single result');
    expect(response.body.singleResult.errors).toBeUndefined();
    const workers = (response.body.singleResult.data as any).teamRoster.workers;
    expect(workers.find((e: any) => e.worker.name === 'Kit')).toEqual({ worker: { name: 'Kit' }, pausedUntil: null,
      currentTask: { id: t.id, title: 'GraphQL selected', status: 'PENDING' } });
  });

  it('conceals the roster after membership revocation and for an outsider', async () => {
    await task({ title: 'private assignment', status: 'pending', assigneeWorkerId: w.Kit.id });
    await expect(roster(outsider.id)).rejects.toMatchObject({ extensions: { code: 'APP_NOT_FOUND' } });
    await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: mia.id } } });
    await expect(roster()).rejects.toMatchObject({ extensions: { code: 'APP_NOT_FOUND' } });
  });

  it('scopes summary candidates to both App and returned worker ids', async () => {
    const foreign = await db.app.create({ data: { name: 'Foreign', urn: `${appUrn}-foreign`, ownerUserId: outsider.id } });
    const other = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: foreign.id, agentId,
      name: 'Other', slug: 'other', role: 'engineer' } });
    await task({ appId: foreign.id, title: 'foreign title', status: 'started', assigneeWorkerId: other.id });
    await task({ title: 'excluded worker title', status: 'started', assigneeWorkerId: w.Rook.id });
    const selected = await task({ title: 'permitted', status: 'pending', assigneeWorkerId: w.Kit.id });
    const summaries = await loadRosterTaskSummaries(db, app.id, [w.Kit.id, other.id]);
    expect([...summaries]).toEqual([[w.Kit.id, { id: selected.id, title: 'permitted', status: 'pending' }]]);
  });

  it('does not query titles when the shared task-read policy denies enrichment', async () => {
    await task({ title: 'withheld title', status: 'started', assigneeWorkerId: w.Kit.id });
    // The current policy is App-wide. This pins delegation on a denial, without inventing a per-task ACL.
    const policy = vi.spyOn(taskReadPolicy, 'mayReadAppTasks').mockResolvedValueOnce(false);
    let titleQueries = 0;
    const traced = db.$extends({ query: { $allOperations: async ({ args, operation, query }) => {
      if (operation === '$queryRaw' && JSON.stringify(args).includes('SELECT DISTINCT ON (assignee_worker_id)')) titleQueries++;
      return query(args);
    } } });
    try {
      const result = await Q.teamRoster({}, { appRef: app.id }, { ...ctx(mia.id), db: traced });
      expect(policy).toHaveBeenCalledOnce();
      expect(result.workers.every((e: any) => e.currentTask === null)).toBe(true);
      expect(titleQueries).toBe(0);
    } finally { policy.mockRestore(); }
  });

  it('selects createdAt before id when assignment time ties', async () => {
    const assignedAt = ago(20);
    const expected = await task({ title: 'older creation', status: 'pending', assigneeWorkerId: w.Kit.id,
      assignedAt, createdAt: ago(30), id: 'z2178created00000000000001' });
    await task({ title: 'newer creation', status: 'pending', assigneeWorkerId: w.Kit.id,
      assignedAt, createdAt: ago(25), id: 'a2178created00000000000001' });
    expect((await entry('Kit')).currentTask.id).toBe(expected.id);
  });

  it('keeps assignment title and roster state in the same snapshot across a concurrent finish', async () => {
    const t = await task({ title: 'snapshot title', status: 'started', assigneeWorkerId: w.Kit.id });
    let reached!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((r) => { reached = r; });
    const barrier = new Promise<void>((r) => { release = r; });
    const traced = db.$extends({ query: { $allOperations: async ({ args, query, operation }) => {
      if (operation === '$queryRaw' && JSON.stringify(args).includes('SELECT DISTINCT ON (assignee_worker_id)')) {
        reached();
        await barrier;
      }
      return query(args);
    } } });
    const pending = Q.teamRoster({}, { appRef: app.id }, { ...ctx(mia.id), db: traced });
    await ready;
    try {
      await db.agentTask.update({ where: { id: t.id }, data: { status: 'cancelled', cancelledAt: new Date() } });
    } finally { release(); }
    const result = await pending;
    const kit = result.workers.find((e: any) => e.workerId === w.Kit.id);
    expect(kit.state).toBe('WORKING');
    expect(kit.currentTask).toEqual({ id: t.id, title: 'snapshot title', status: 'started' });
    expect((await entry('Kit')).currentTask).toBeNull();
  });

  it('keeps summary and pause reads constant for 1 or 100 workers', async () => {
    await db.worker.deleteMany({ where: { appId: app.id } });
    const counts: number[][] = [];
    for (const size of [1, 100]) {
      await db.worker.deleteMany({ where: { appId: app.id } });
      await db.worker.createMany({ data: Array.from({ length: size }, (_, i) => ({ ...WORKER_SIGNATURE_DEFAULTS,
        id: generateId(), appId: app.id, agentId, name: `Bounded ${i}`, slug: `bounded-${i}`, role: 'engineer' })) });
      let summaries = 0;
      let pauses = 0;
      const traced = db.$extends({ query: { $allOperations: async ({ args, query, operation, model }) => {
        if (operation === '$queryRaw' && JSON.stringify(args).includes('SELECT DISTINCT ON (assignee_worker_id)')) summaries++;
        if (model === 'WorkerWakeSettings' && operation === 'findMany') pauses++;
        return query(args);
      } } });
      const result = await Q.teamRoster({}, { appRef: app.id }, { ...ctx(mia.id), db: traced });
      expect(result.workers).toHaveLength(size);
      expect(result.workers.every((e: any) => e.currentTask === null && e.pausedUntil === null)).toBe(true);
      counts.push([summaries, pauses]);
    }
    // Counts, not the select shape, are what must not grow with the roster (#2755 widened the check-status select).
    expect(counts[1]).toEqual(counts[0]);
    expect(counts[0][0]).toBe(1);
    expect(counts[0][1]).toBeGreaterThan(0);
  });
});
