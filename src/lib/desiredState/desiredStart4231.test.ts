/**
 * #4231 (S8 of #4229) — the platform starts a long-lived worker that should run and has no session (cor:agt:070:05
 * S7 and :08, Proposed; G2 OK'd by Holger). The step runs in the one-minute matcher tick; tests drive it directly.
 *
 * Cast: an org admin manages the App; Bo holds Kit (LONG_LIVED, reports to Ada) and Sam (SHORT_LIVED). orca1
 * registers both with a worktree. Unless a test says otherwise the App's sweep mode is APPLY.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { declareAllStopLanes } from '../../test/stopLanes.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { startDesiredWorker, startDesiredWorkers, START_FAILING_EVENT_TYPE } from './desiredStart.js';
import { loadHostDesiredState } from './desiredState.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('./desiredState.js', async (orig) => {
  const m = await orig<typeof import('./desiredState.js')>();
  return { ...m, loadHostDesiredState: vi.fn(m.loadHostDesiredState) };
});

const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
const keyCtx = (k: { id: string }): Context => ({ db, appId: app.id, appKeyId: k.id, roles: [] }) as Context;

let org: { id: string; urn: string };
let admin: { id: string };
let bo: { id: string };
let app: { id: string };
let ada: { id: string };
let kit: { id: string };
let sam: { id: string };
let orca1: { id: string };

/** A second host, orca2, registering Kit in its own worktree. */
async function registerOrca2() {
  const k = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: `h-${generateId()}`, keyPreview: 'efgh', label: 'orca2' }, select: { id: true } });
  await M.grantAppKeyScope({}, { id: k.id, scope: 'host:operate', hostId: 'orca2' }, ctx(admin.id));
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 2', pollIntervalSeconds: 600, workers: [
    { worker: kit.id, family: 'claude', worktrees: ['hadron-server/kit2'] },
  ] } }, keyCtx(k));
}

const starts = (workerId = kit.id) => db.hostOperation.findMany({ where: { workerId, type: 'worker.start' }, orderBy: { issuedAt: 'asc' } });
const tick = (now = new Date()) => startDesiredWorkers(db, now);
const sweep = (mode: 'OFF' | 'OBSERVE' | 'APPLY') => M.setAppSweepMode({}, { appRef: app.id, mode }, ctx(admin.id));
const alarms = () => db.agentTeamEvent.findMany({ where: { appId: app.id, type: START_FAILING_EVENT_TYPE }, orderBy: { createdAt: 'asc' } });

/** A platform start of Kit that its host reported failed `minutesAgo` minutes ago. */
async function failedStart(minutesAgo: number) {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  await db.hostOperation.create({
    data: {
      id: generateId(), appId: app.id, hostId: 'orca1', type: 'worker.start', workerId: kit.id,
      args: { workerId: kit.id, worktree: 'hadron-server/kit', family: 'claude' },
      status: 'failed', issuedBy: 'platform', issuedAt: at, collectedAt: at, finishedAt: at, failureReason: 'launcher exited 1',
      holdUserId: bo.id,
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { id: generateId(), name: 'S8', urn: `s8-4231-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { id: generateId(), githubId: 42_310_000 + k * 1000 + (n % 1000), githubUsername: `s8-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  admin = await u(1, 'admin');
  bo = await u(2, 'bo');
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const longAgent = (await M.createAgent({}, { orgId: org.id, name: 'Coordinator' }, ctx(admin.id))).id;
  const shortAgent = (await M.createAgent({}, { orgId: org.id, name: 'Builder', lifecycle: 'SHORT_LIVED' }, ctx(admin.id))).id;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: bo.id, role: 'member' } });
  const w = (agentId: string, name: string, extra: Record<string, unknown> = {}) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name, slug: name.toLowerCase(), ...extra }, select: { id: true } });
  ada = await w(longAgent, 'Ada');
  kit = await w(longAgent, 'Kit', { heldByUserId: bo.id, heldAt: new Date(), reportsToWorkerId: ada.id });
  sam = await w(shortAgent, 'Sam', { heldByUserId: bo.id, heldAt: new Date(), reportsToWorkerId: ada.id });
  orca1 = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd', label: 'orca1' }, select: { id: true } });
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(admin.id));
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 1', pollIntervalSeconds: 600, workers: [
    { worker: kit.id, family: 'claude', worktrees: ['hadron-server/kit'] },
    { worker: sam.id, family: 'claude', worktrees: ['hadron-server/sam'] },
  ] } }, keyCtx(orca1));
  await declareAllStopLanes(db, app.id);
  await sweep('APPLY');
});

describe('#4231: a long-lived worker that should run and has no session is started', () => {
  it('one start, no task, issued by the platform for DESIRED_RUNNING, in its registered worktree', async () => {
    await tick();
    const ops = await starts();
    expect(ops, 'the sweep did not start a long-lived worker that should run').toHaveLength(1);
    expect(ops[0]).toMatchObject({ hostId: 'orca1', issuedBy: 'platform', issuedReason: 'DESIRED_RUNNING', status: 'issued', holdUserId: bo.id });
    expect(ops[0]!.args).toEqual({ workerId: kit.id, worktree: 'hadron-server/kit', family: 'claude' });
  });

  it('at most one start per loop, and none while one is in flight', async () => {
    await tick();
    await tick();
    expect(await starts()).toHaveLength(1);
  });

  it('a short-lived worker is never started by this loop, even while it holds a task (its task\'s own start covers it)', async () => {
    await tick();
    expect(await starts(sam.id)).toHaveLength(0);
    // Written straight to the table, so no assignment start runs: only this loop could start Sam now.
    await db.agentTask.create({ data: { appId: app.id, title: 'T', ownerUserId: admin.id, assigneeWorkerId: sam.id, assignedAt: new Date(), closeSessionWhenDone: false } });
    await tick();
    expect(await starts(sam.id), 'the desired-state loop started a short-lived worker').toHaveLength(0);
  });

  it('a worker with an open session, however quiet, is not started', async () => {
    const quiet = new Date(Date.now() - 60 * 86_400_000);
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: kit.id, userId: bo.id, startedAt: quiet, updatedAt: quiet } });
    await tick();
    expect(await starts()).toHaveLength(0);
  });

  it('a worker nobody holds is not started', async () => {
    await db.worker.update({ where: { id: kit.id }, data: { heldByUserId: null, heldAt: null } });
    await tick();
    expect(await starts()).toHaveLength(0);
  });
});

describe('#4231: one host failing does not stop the pass (#4257 blind F1, F2)', () => {
  it('an App whose host list throws is skipped; the next App still starts its worker', async () => {
    // A second App, Team 2, with its own long-lived worker Kai on its own host orca9.
    const app2 = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team 2', urn: `${org.urn}:team2` }, select: { id: true } });
    await db.appMember.create({ data: { appId: app2.id, userId: bo.id, role: 'member' } });
    const agentId = (await db.worker.findUniqueOrThrow({ where: { id: kit.id }, select: { agentId: true } })).agentId;
    const kai = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app2.id, agentId, name: 'Kai', slug: 'kai', heldByUserId: bo.id, heldAt: new Date() }, select: { id: true } });
    const k = await db.appKey.create({ data: { id: generateId(), appId: app2.id, keyHash: `h-${generateId()}`, keyPreview: 'ijkl', label: 'orca9' }, select: { id: true } });
    await M.grantAppKeyScope({}, { id: k.id, scope: 'host:operate', hostId: 'orca9' }, ctx(admin.id));
    await M.registerHost({}, { input: { appRef: app2.id, label: 'Orca 9', pollIntervalSeconds: 600, workers: [
      { worker: kai.id, family: 'claude', worktrees: ['hadron-server/kai'] },
    ] } }, { db, appId: app2.id, appKeyId: k.id, roles: [] } as Context);
    await declareAllStopLanes(db, app2.id);
    await M.setAppSweepMode({}, { appRef: app2.id, mode: 'APPLY' }, ctx(admin.id));
    // The first App by id fails to list its hosts (the pass's first raw read).
    const spy = vi.spyOn(db, '$queryRaw').mockRejectedValueOnce(new Error('host list failed'));
    try {
      await tick();
    } finally {
      spy.mockRestore();
    }
    const started = [...await starts(kit.id), ...await starts(kai.id)];
    expect(started, 'one App\'s failed host list aborted the pass for every App after it').toHaveLength(1);
  });

  it('a host whose desired-state read throws is skipped; the worker still starts through the next host', async () => {
    await registerOrca2();
    vi.mocked(loadHostDesiredState).mockRejectedValueOnce(new Error('orca1 read failed'));
    await tick();
    const ops = await starts();
    expect(ops, 'one host\'s failed read aborted the whole pass').toHaveLength(1);
    expect(ops[0]).toMatchObject({ hostId: 'orca2' });
  });

  it('the first host by id has lapsed: the start goes through the next live host', async () => {
    await registerOrca2();
    await db.hostRegistration.updateMany({ where: { appId: app.id, hostId: 'orca1' }, data: { refreshedAt: new Date(Date.now() - 30 * 86_400_000) } });
    await tick();
    const ops = await starts();
    expect(ops, 'a lapsed first host stopped the start').toHaveLength(1);
    expect(ops[0]).toMatchObject({ hostId: 'orca2', args: { worktree: 'hadron-server/kit2' } });
  });
});

describe('#4231 under hostSetupSource SERVER: only through a live host the worker is assigned to (S1a)', () => {
  const assign = (worker: string, hostId: string, workdir: string) =>
    M.assignHostWorker({}, { input: { appRef: app.id, hostId, worker, workdir, family: 'claude' } }, ctx(admin.id));
  const server = () => M.setHostSetupSource({}, { appRef: app.id, source: 'SERVER' }, ctx(admin.id));

  it('assigned to orca1, whose registration lists the workdir: started there, in the assigned workdir', async () => {
    await assign('Kit', 'orca1', 'hadron-server/kit');
    await server();
    await tick();
    const ops = await starts();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ hostId: 'orca1', issuedReason: 'DESIRED_RUNNING' });
    expect(ops[0]!.args).toMatchObject({ worktree: 'hadron-server/kit' });
  });

  it('not assigned anywhere: not started, though orca1 registers it', async () => {
    await server();
    await tick();
    expect(await starts()).toHaveLength(0);
  });

  it('assigned to a host with no live registration: not started', async () => {
    await assign('Kit', 'orca3', 'hadron-server/kit');
    await server();
    await tick();
    expect(await starts()).toHaveLength(0);
  });
});

describe('#4231: nothing is started unless the App applies its sweep, or when an override holds', () => {
  it('sweep OFF or OBSERVE starts nothing', async () => {
    await sweep('OBSERVE');
    await tick();
    await sweep('OFF');
    await tick();
    expect(await starts()).toHaveLength(0);
  });

  it('halted by a stop signal: nothing', async () => {
    await M.setTeamStopSignal({}, { input: { appRef: app.id, level: 'HALT', scope: 'WORKER', worker: kit.id } }, ctx(admin.id));
    await tick();
    expect(await starts()).toHaveLength(0);
  });

  it('team paused: nothing', async () => {
    await M.setTeamPause({}, { appRef: app.id, paused: true }, ctx(admin.id));
    await tick();
    expect(await starts()).toHaveLength(0);
  });

  it('leave-alone: nothing', async () => {
    await M.setWorkerLeaveAlone({}, { input: { worker: kit.id, leaveAlone: true } }, ctx(admin.id));
    await tick();
    expect(await starts()).toHaveLength(0);
  });

  it('an uninstalled App: nothing', async () => {
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    await tick();
    expect(await starts()).toHaveLength(0);
  });
});

describe('#4231: three failed starts in an hour stop further starts and raise one alarm', () => {
  it('after three failures in the hour: no start, one alarm to Kit\'s reporting line; the next pass raises no second one', async () => {
    for (const m of [50, 30, 10]) await failedStart(m);
    await tick();
    expect((await starts()).filter((o) => o.status === 'issued'), 'a fourth start was issued after three failures in the hour').toHaveLength(0);
    const raised = await alarms();
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ subjectWorkerId: kit.id, severity: 'alarm', taskId: null });
    expect(raised[0]!.chain).toEqual([{ workerId: ada.id }]);
    await tick();
    expect(await alarms()).toHaveLength(1);
  });

  it('an hour after its alarm, a worker still failing is alarmed again; once the failures age out, starts resume', async () => {
    for (const m of [58, 57, 56]) await failedStart(m);
    await tick();
    expect(await alarms()).toHaveLength(1);
    // The episode opened 61 minutes ago and the worker is still failing: it rolls over, with exactly one new alarm.
    await db.startFailingEpisode.updateMany({ where: { workerId: kit.id }, data: { openedAt: new Date(Date.now() - 61 * 60_000) } });
    await tick();
    await tick();
    expect(await alarms(), 'the rolled-over episode raised no new alarm, or more than one').toHaveLength(2);
    expect((await starts()).filter((o) => o.status === 'issued')).toHaveLength(0);
    // Five minutes on, the failures have aged out of the hour: the start resumes with no further alarm.
    await tick(new Date(Date.now() + 5 * 60_000));
    expect((await starts()).filter((o) => o.status === 'issued'), 'starts did not resume once the failures aged out').toHaveLength(1);
    expect(await alarms()).toHaveLength(2);
  });

  it('two concurrent passes issue one start', async () => {
    await Promise.all([tick(), tick()]);
    expect(await starts()).toHaveLength(1);
  });

  it('two concurrent passes under the trip raise one alarm', async () => {
    for (const m of [50, 30, 10]) await failedStart(m);
    await Promise.all([tick(), tick()]);
    expect(await alarms()).toHaveLength(1);
  });

  it('two failures in the hour, or three of which one is older than the hour, do not stop the start', async () => {
    await failedStart(70);
    await failedStart(30);
    await failedStart(10);
    await tick();
    expect((await starts()).filter((o) => o.status === 'issued')).toHaveLength(1);
    expect(await alarms()).toHaveLength(0);
  });
});

describe('#4231: the fences re-decide under the locks what changed since the pass read it (#4257 §10 P3)', () => {
  // Calling the per-worker start directly models a change between the pass's read and its transaction.
  const direct = () => startDesiredWorker(db, { appId: app.id, workerId: kit.id, hostId: 'orca1' }, new Date());

  it('the App stopped applying its sweep (OBSERVE, then OFF): skipped', async () => {
    await sweep('OBSERVE');
    expect(await direct()).toBe('skipped');
    await sweep('OFF');
    expect(await direct()).toBe('skipped');
    expect(await starts()).toHaveLength(0);
  });

  it('leave-alone, a halt or a team pause set since the read: skipped', async () => {
    await M.setWorkerLeaveAlone({}, { input: { worker: kit.id, leaveAlone: true } }, ctx(admin.id));
    expect(await direct()).toBe('skipped');
    await M.setWorkerLeaveAlone({}, { input: { worker: kit.id, leaveAlone: false } }, ctx(admin.id));
    await M.setTeamStopSignal({}, { input: { appRef: app.id, level: 'HALT', scope: 'WORKER', worker: kit.id } }, ctx(admin.id));
    expect(await direct()).toBe('skipped');
    await M.setTeamPause({}, { appRef: app.id, paused: true }, ctx(admin.id));
    expect(await direct()).toBe('skipped');
    expect(await starts()).toHaveLength(0);
  });

  it('a short-lived worker: skipped', async () => {
    expect(await startDesiredWorker(db, { appId: app.id, workerId: sam.id, hostId: 'orca1' }, new Date())).toBe('skipped');
    expect(await starts(sam.id)).toHaveLength(0);
  });

  it('a session opened since the read: skipped', async () => {
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: kit.id, userId: bo.id } });
    expect(await direct()).toBe('skipped');
    expect(await starts()).toHaveLength(0);
  });
});

describe('#4231: the migration carries the invariants file verbatim (#4257 local P3)', () => {
  it('migration.sql ends with prisma/desired-start-invariants.sql', () => {
    const read = (f: string) => readFileSync(new URL(`../../../prisma/${f}`, import.meta.url), 'utf8').trimEnd();
    expect(read('migrations/20261115210000_desired_start/migration.sql').endsWith(read('desired-start-invariants.sql'))).toBe(true);
  });
});
