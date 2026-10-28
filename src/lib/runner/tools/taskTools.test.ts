import { WORKER_SIGNATURE_DEFAULTS } from '../../workerSignature.js';
/**
 * hadron_task_create — a headless run creates root agent tasks in its own App
 * (#1756, cor:agt:050:06, Holger team chat #7799). The run is the creator: it
 * is recorded as such, never as a person or a worker, and it can reach only
 * its own App. Runs never become owners or assignees themselves.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../id.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { hadronTaskCreate, resolveRunTools } from './index.js';
import { createRootTaskForRun } from '../../../api/graphql/schema/resolvers.agentTask.js';
import { resolvers } from '../../../api/graphql/schema/resolvers.js';
import { typeDefs } from '../../../api/graphql/schema/typeDefs.js';
import { lockAuthorityAnchors } from '../../auth/authorityAnchors.js';
import type { AppRun } from '../../../generated/prisma/index.js';
import type { RunToolContext } from './types.js';

let orgId: string;
let appId: string;
let otherAppId: string;
let agentId: string;
let person: { id: string };
let outsider: { id: string };
let anne: { id: string };

async function mkUser(n: number) {
  return db.user.create({ data: { id: generateId(), githubId: 98_000 + n, githubUsername: `rt-${n}-${generateId().slice(-6)}`, roles: ['READER'] }, select: { id: true } });
}

async function mintRun(extra: Record<string, unknown> = {}, forApp = appId): Promise<AppRun> {
  return db.appRun.create({
    data: {
      id: generateId(), organizationId: orgId, appId: forApp, triggerKind: 'MANUAL',
      entryNodeUrn: 'rt-org::mem::flow:entry', status: 'RUNNING', ...extra,
    },
  });
}
const toolCtx = (run: AppRun): RunToolContext => ({ log: vi.fn(), db, run, principal: runContext(db, run) });
async function code(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; return undefined; } catch (e) { return e instanceof GraphQLError ? String(e.extensions?.code) : `non-graphql:${(e as Error).message}`; }
}
// #2553: AT0, the App's reserved "No project" row, is not a task a run made.
const tasks = () => db.agentTask.findMany({ where: { appId, handle: { not: 'AT0' } }, orderBy: { createdAt: 'asc' } });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'rt-org', urn: `rt-org-${generateId().slice(-6)}.com` } });
  orgId = org.id;
  person = await mkUser(1);
  outsider = await mkUser(2);
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId: person.id, role: 'CONTRIBUTOR' } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'Team Agent', urn: `${org.urn}:team-agent` } });
  agentId = agent.id;
  appId = (await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'Team', urn: `${org.urn}:team` } })).id;
  otherAppId = (await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'Other', urn: `${org.urn}:other` } })).id;
  anne = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId, name: 'Anne', slug: 'anne' }, select: { id: true } });
});

describe('registry', () => {
  it('hadron_task_create is a cost-1 run tool', () => {
    const { tools, unknown } = resolveRunTools(['hadron_task_create']);
    expect(unknown).toEqual([]);
    expect(tools.find((t) => t.name === 'hadron_task_create')?.cost).toBe(1);
  });
});

describe('hadron_task_create (#1756)', () => {
  it('creates a root task in the run\'s own App and records the run as its creator', async () => {
    const run = await mintRun({ userId: person.id });
    const out = (await hadronTaskCreate.execute(toolCtx(run), { title: 'Fix the failing build' })) as { id: string };
    const [t] = await tasks();
    expect(t!.id).toBe(out.id);
    const zero = await db.agentTask.findFirstOrThrow({ where: { appId, handle: 'AT0' } });
    // #2553: a run's root task has no project, so its parent is the App's AT0.
    expect(t).toMatchObject({ appId, parentTaskId: zero.id, handle: 'AT0.1', title: 'Fix the failing build', createdByRunId: run.id, createdBy: null, createdByWorkerId: null, createdByAgentId: null });
    const ev = await db.agentTeamEvent.findMany({ where: { taskId: t!.id }, orderBy: { createdAt: 'asc' } });
    expect(ev.map((e) => e.type)).toContain('task.created');
    expect(ev.every((e) => e.actorRunId === run.id && e.actorUserId === null && e.actorWorkerId === null)).toBe(true);
  });

  it('the owner defaults to the person the run acts for, and that person must participate', async () => {
    const run = await mintRun({ userId: person.id });
    await hadronTaskCreate.execute(toolCtx(run), { title: 'x' });
    expect((await tasks())[0]).toMatchObject({ ownerUserId: person.id, ownerWorkerId: null });
    const stranger = await mintRun({ userId: outsider.id });
    expect(await code(hadronTaskCreate.execute(toolCtx(stranger), { title: 'y' }))).toBe('TASK_OWNER_INVALID');
    expect(await tasks()).toHaveLength(1);
  });

  it('a pure App run (no person) must name an owner; a named worker of the App works', async () => {
    const run = await mintRun();
    expect(await code(hadronTaskCreate.execute(toolCtx(run), { title: 'x' }))).toBe('TASK_OWNER_REQUIRED');
    expect(await tasks()).toHaveLength(0);
    await hadronTaskCreate.execute(toolCtx(run), { title: 'x', owner: { worker: anne.id } });
    expect((await tasks())[0]).toMatchObject({ ownerWorkerId: anne.id, createdByRunId: run.id });
  });

  it('naming another App is refused, and nothing is written there or here', async () => {
    const run = await mintRun({ userId: person.id });
    const other = await db.app.findUniqueOrThrow({ where: { id: otherAppId } });
    expect(await code(hadronTaskCreate.execute(toolCtx(run), { title: 'x', appRef: otherAppId }))).toBe('APP_NOT_FOUND');
    expect(await code(hadronTaskCreate.execute(toolCtx(run), { title: 'x', appRef: other.urn }))).toBe('APP_NOT_FOUND');
    expect(await db.agentTask.count({ where: { handle: { not: 'AT0' } } })).toBe(0);
    // Naming its own App is fine.
    await hadronTaskCreate.execute(toolCtx(run), { title: 'x', appRef: appId });
    expect(await tasks()).toHaveLength(1);
  });

  it('a run creates root tasks only: a parentTaskId is refused', async () => {
    const run = await mintRun({ userId: person.id });
    const { id } = (await hadronTaskCreate.execute(toolCtx(run), { title: 'root' })) as { id: string };
    expect(await code(hadronTaskCreate.execute(toolCtx(run), { title: 'child', parentTaskId: id }))).toBe('BAD_USER_INPUT');
    expect(await db.agentTask.count({ where: { handle: { not: 'AT0' } } })).toBe(1);
  });

  it('the run row decides the App, not the object the tool was handed', async () => {
    const run = await mintRun({ userId: person.id }, otherAppId);
    // A stale or forged in-memory run claiming this App, while the stored run belongs to the other.
    expect(await code(hadronTaskCreate.execute(toolCtx({ ...run, appId }), { title: 'x', owner: { worker: anne.id } }))).toBe('APP_NOT_FOUND');
    expect(await db.agentTask.count({ where: { handle: { not: 'AT0' } } })).toBe(0);
  });

  it('a run that is no longer running creates nothing', async () => {
    for (const status of ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const) {
      const run = await mintRun({ userId: person.id, status });
      expect(await code(hadronTaskCreate.execute(toolCtx(run), { title: 'x' }))).toBe('APP_NOT_FOUND');
    }
    expect(await tasks()).toHaveLength(0);
  });

  it('an uninstalled or deleted App takes no task from a run', async () => {
    const run = await mintRun({ userId: person.id });
    await db.app.update({ where: { id: appId }, data: { uninstalledAt: new Date() } });
    expect(await code(hadronTaskCreate.execute(toolCtx(run), { title: 'x' }))).toBe('APP_UNINSTALLED');
    await db.app.update({ where: { id: appId }, data: { uninstalledAt: null, deletedAt: new Date() } });
    expect(await code(hadronTaskCreate.execute(toolCtx(run), { title: 'x' }))).toBe('APP_NOT_FOUND');
    expect(await tasks()).toHaveLength(0);
  });

  it('the run is never a party: it cannot be named owner or assignee, and a run tool cannot forge another creator', async () => {
    const run = await mintRun({ userId: person.id });
    expect(await code(hadronTaskCreate.execute(toolCtx(run), { title: 'x', owner: { worker: 'no-such' } }))).toBe('TASK_OWNER_INVALID');
    expect(await code(hadronTaskCreate.execute(toolCtx(run), { title: 'x', assignee: { user: outsider.id } }))).toBe('TASK_ASSIGNEE_INVALID');
    await hadronTaskCreate.execute(toolCtx(run), { title: 'x', createdByRunId: 'forged', createdBy: outsider.id } as any);
    expect((await tasks())[0]).toMatchObject({ createdByRunId: run.id, createdBy: null });
  });
});

// ── The commit-time guarantees under real interleaving (Xylon P2, #1815 cycle 1) ──────────────

/** Open a transaction, run `body` in it, and keep it open until `release()`. */
async function holding(body: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let ready!: () => void;
  const started = new Promise<void>((r) => { ready = r; });
  const done = db.$transaction(async (tx) => { await body(tx); ready(); await gate; }, { timeout: 30_000 });
  await started;
  return { release, done };
}
/** True while `p` has not settled after `ms`: the creator is blocked behind the held lock. */
async function stillPending(p: Promise<unknown>, ms = 400): Promise<boolean> {
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, ms));
  return !settled;
}

describe('commit-time guarantees under interleaving', () => {
  it('a run that finishes while its create is waiting creates nothing', async () => {
    const run = await mintRun({ userId: person.id });
    const finishing = await holding(async (tx) => { await tx.appRun.update({ where: { id: run.id }, data: { status: 'COMPLETED' } }); });
    const creating = hadronTaskCreate.execute(toolCtx(run), { title: 'late' });
    const outcome = creating.then(() => 'created', (e) => (e instanceof GraphQLError ? String(e.extensions?.code) : `other:${(e as Error).message}`));
    expect(await stillPending(creating.catch(() => undefined))).toBe(true);
    finishing.release();
    await finishing.done;
    expect(await outcome).toBe('APP_NOT_FOUND');
    expect(await tasks()).toHaveLength(0);
    expect(await db.agentTeamEvent.count()).toBe(0);
  });

  it('an App uninstalled while a create is waiting takes no task', async () => {
    const run = await mintRun({ userId: person.id });
    const uninstalling = await holding(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'app', id: appId }, { kind: 'org', id: orgId }], 'exclusive');
      await tx.app.update({ where: { id: appId }, data: { uninstalledAt: new Date() } });
    });
    const creating = hadronTaskCreate.execute(toolCtx(run), { title: 'late' });
    const outcome = creating.then(() => 'created', (e) => (e instanceof GraphQLError ? String(e.extensions?.code) : `other:${(e as Error).message}`));
    expect(await stillPending(creating.catch(() => undefined))).toBe(true);
    uninstalling.release();
    await uninstalling.done;
    expect(await outcome).toBe('APP_UNINSTALLED');
    expect(await tasks()).toHaveLength(0);
  });

  it('an App deleted while a create is waiting takes no task', async () => {
    const run = await mintRun({ userId: person.id });
    const deleting = await holding(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'app', id: appId }, { kind: 'org', id: orgId }], 'exclusive');
      await tx.app.update({ where: { id: appId }, data: { deletedAt: new Date() } });
    });
    const creating = hadronTaskCreate.execute(toolCtx(run), { title: 'late' });
    const outcome = creating.then(() => 'created', (e) => (e instanceof GraphQLError ? String(e.extensions?.code) : `other:${(e as Error).message}`));
    expect(await stillPending(creating.catch(() => undefined))).toBe(true);
    deleting.release();
    await deleting.done;
    expect(await outcome).toBe('APP_NOT_FOUND');
    expect(await tasks()).toHaveLength(0);
  });

  it('the person a run acts for leaving the org while a create waits: the owner default is refused', async () => {
    const run = await mintRun({ userId: person.id });
    const leaving = await holding(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'org', id: orgId }], 'exclusive');
      await tx.orgMember.updateMany({ where: { organizationId: orgId, userId: person.id }, data: { deletedAt: new Date() } });
    });
    const creating = hadronTaskCreate.execute(toolCtx(run), { title: 'late' });
    const outcome = creating.then(() => 'created', (e) => (e instanceof GraphQLError ? String(e.extensions?.code) : `other:${(e as Error).message}`));
    expect(await stillPending(creating.catch(() => undefined))).toBe(true);
    leaving.release();
    await leaving.done;
    expect(await outcome).toBe('TASK_OWNER_INVALID');
    expect(await tasks()).toHaveLength(0);
  });

  it('concurrent creates by one run, and by two runs, all land, each attributed to its own run', async () => {
    const a = await mintRun({ userId: person.id });
    const b = await mintRun({ userId: person.id });
    const made = await Promise.all([
      hadronTaskCreate.execute(toolCtx(a), { title: 'a1' }),
      hadronTaskCreate.execute(toolCtx(a), { title: 'a2' }),
      hadronTaskCreate.execute(toolCtx(b), { title: 'b1' }),
      hadronTaskCreate.execute(toolCtx(b), { title: 'b2' }),
    ]) as Array<{ id: string }>;
    expect(new Set(made.map((m) => m.id)).size).toBe(4);
    const rows = await tasks();
    expect(rows.map((r) => `${r.title}:${r.createdByRunId === a.id ? 'a' : r.createdByRunId === b.id ? 'b' : '?'}`).sort()).toEqual(['a1:a', 'a2:a', 'b1:b', 'b2:b']);
    for (const r of rows) {
      const ev = await db.agentTeamEvent.findMany({ where: { taskId: r.id } });
      expect(ev.map((e) => e.type).sort()).toEqual(['assignment.queued', 'task.created']);
      expect(ev.every((e) => e.actorRunId === r.createdByRunId)).toBe(true);
    }
  });

  it('a create racing the run\'s own completion is all-or-nothing: no task without a RUNNING run at commit', async () => {
    const run = await mintRun({ userId: person.id });
    const results = await Promise.allSettled([
      hadronTaskCreate.execute(toolCtx(run), { title: 'racing' }),
      db.appRun.update({ where: { id: run.id }, data: { status: 'COMPLETED' } }),
    ]);
    const created = (await tasks()).length;
    expect(created).toBe(results[0]!.status === 'fulfilled' ? 1 : 0);
    if (results[0]!.status === 'rejected') expect(String((results[0].reason as GraphQLError).extensions?.code)).toBe('APP_NOT_FOUND');
  });
});

describe('follow-ups to #1756 (#1832, #1833)', () => {
  it('#1832: a run-created root task takes no status: it is refused, not dropped', async () => {
    const run = await mintRun({ userId: person.id });
    for (const status of ['backlog', 'pending', 'BACKLOG', 'finished']) {
      expect(await code(createRootTaskForRun(runContext(db, run), run, { title: 'x', status } as any))).toBe('BAD_USER_INPUT');
    }
    expect(await db.agentTask.count({ where: { handle: { not: 'AT0' } } })).toBe(0);
    // A typed caller cannot pass a status at all (Colin P2): this line fails to compile if the type admits one.
    // @ts-expect-error status is `never` on the helper's input
    void (() => createRootTaskForRun(runContext(db, run), run, { title: 'x', status: 'backlog' }));
    // Absent or null is the ordinary case: pending and queued.
    await createRootTaskForRun(runContext(db, run), run, { title: 'x', status: null } as any);
    expect((await tasks())[0]).toMatchObject({ status: 'pending' });
  });

  it('#1832: the run tool forwards a status to the helper, so the refusal fires on the wire (Greta QA)', async () => {
    const run = await mintRun({ userId: person.id });
    for (const status of ['BACKLOG', 'backlog', 'pending', 'PENDING', 'finished', '']) {
      expect(await code(hadronTaskCreate.execute(toolCtx(run), { title: 'x', status }))).toBe('BAD_USER_INPUT');
    }
    expect(await db.agentTask.count({ where: { handle: { not: 'AT0' } } })).toBe(0);
  });

  it('#1833: a run-created event names its run on the event read; the SDL declares the field', async () => {
    const run = await mintRun({ userId: person.id });
    await hadronTaskCreate.execute(toolCtx(run), { title: 'x' });
    const Q = resolvers.Query as any;
    const events = await Q.agentTeamEvents({}, { appRef: appId }, { db, userId: person.id, roles: ['READER'] });
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((e: any) => e.actorRunId)).toEqual(events.map(() => run.id));
    expect(typeDefs).toMatch(/type AgentTeamEvent \{[^}]*\bactorRunId: ID\b/);
  });
});
