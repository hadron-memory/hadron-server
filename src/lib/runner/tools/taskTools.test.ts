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
const tasks = () => db.agentTask.findMany({ where: { appId } });

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
  anne = await db.worker.create({ data: { id: generateId(), appId, agentId, name: 'Anne', slug: 'anne' }, select: { id: true } });
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
    expect(t).toMatchObject({ appId, parentTaskId: null, title: 'Fix the failing build', createdByRunId: run.id, createdBy: null, createdByWorkerId: null, createdByAgentId: null });
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
    expect(await db.agentTask.count()).toBe(0);
    // Naming its own App is fine.
    await hadronTaskCreate.execute(toolCtx(run), { title: 'x', appRef: appId });
    expect(await tasks()).toHaveLength(1);
  });

  it('a run creates root tasks only: a parentTaskId is refused', async () => {
    const run = await mintRun({ userId: person.id });
    const { id } = (await hadronTaskCreate.execute(toolCtx(run), { title: 'root' })) as { id: string };
    expect(await code(hadronTaskCreate.execute(toolCtx(run), { title: 'child', parentTaskId: id }))).toBe('BAD_USER_INPUT');
    expect(await db.agentTask.count()).toBe(1);
  });

  it('the run row decides the App, not the object the tool was handed', async () => {
    const run = await mintRun({ userId: person.id }, otherAppId);
    // A stale or forged in-memory run claiming this App, while the stored run belongs to the other.
    expect(await code(hadronTaskCreate.execute(toolCtx({ ...run, appId }), { title: 'x', owner: { worker: anne.id } }))).toBe('APP_NOT_FOUND');
    expect(await db.agentTask.count()).toBe(0);
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
