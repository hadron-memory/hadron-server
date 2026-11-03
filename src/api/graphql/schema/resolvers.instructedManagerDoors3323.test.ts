/**
 * #3323 (S4a of #2483), hrn:node:hadronmemory.com:specs:cor:dmo:050:12: a worker session acts with its holder's
 * App-manager right, on a clear instruction, at the task, alarm, availability, model-group and App-properties doors.
 *
 * The one change is at the choke point, `actorManagesApp`: it admits a worker actor only when the door passed the
 * instruction it was called with, through #3307's shared check judged on the holder. A door (or a caller not wired in
 * this slice) that passes no instruction refuses a worker exactly as on main.
 *
 * Record: an admitted instructed act writes exactly one `app.manager-act` AgentTeamEvent in its own transaction, ids
 * only (cor:agt:050:11); a refusal, a no-op, a direct person and a worker admitted on its own arm write none.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
let f: any;
const live = { kind: 'LIVE_CHAT', ref: 'client-chat:turn-3323' };
const ctx = (extra: Partial<Context> = {}): Context => ({ db, userId: f.holder.id, roles: ['READER'], ...extra });
const bound = (extra: Partial<Context> = {}) => ctx({ sessionId: f.session.id, ...extra });
/** The call as the holder's worker, bound by the transport (the X-Hadron-Session shape) and on the session row. */
const asWorker = <T>(fn: () => Promise<T>, worker = f.worker) => runAsActor({ workerId: worker.id, agentId: f.agent.id }, fn);
const answer = async (p: () => Promise<unknown>) => {
  try { await p(); return { code: 'RESOLVED' }; } catch (e: any) { return { code: e.extensions?.code, message: e.message, ext: e.extensions }; }
};
const managerActs = () => db.agentTeamEvent.findMany({ where: { type: 'app.manager-act' }, orderBy: { id: 'asc' } });
const snapshot = async () => ({
  tasks: await db.agentTask.findMany({ orderBy: { id: 'asc' } }),
  blockers: await db.agentTaskBlocker.findMany({ orderBy: [{ taskId: 'asc' }, { blockerTaskId: 'asc' }] }),
  events: await db.agentTeamEvent.findMany({ orderBy: { id: 'asc' } }),
  availability: await db.workerAvailability.findMany({ orderBy: { workerId: 'asc' } }),
  families: await db.modelFamilyAvailability.findMany({ orderBy: { family: 'asc' } }),
  stall: await db.agentTaskStallSchedule.findMany(),
  groups: await db.modelGroup.findMany({ orderBy: { id: 'asc' } }),
  app: await db.app.findUniqueOrThrow({ where: { id: f.app.id }, select: { properties: true, propertiesRevision: true } }),
});

type Door = {
  /** The act name the record carries. */
  act: string;
  call: (instruction: unknown, c: Context) => Promise<unknown>;
  /** The admitted call's effect, read back. */
  took: () => Promise<boolean>;
};
const doors: Record<string, Door> = {
  assignAgentTask: {
    act: 'task.assign',
    call: (instruction, c) => M.assignAgentTask({}, { taskId: f.task.id, assignee: { user: f.boss.id }, instruction }, c),
    took: async () => (await db.agentTask.findUniqueOrThrow({ where: { id: f.task.id } })).assigneeUserId === f.boss.id,
  },
  reassignAgentTask: {
    act: 'task.reassign',
    call: (instruction, c) => M.reassignAgentTask({}, { taskId: f.assigned.id, assignee: { user: f.holder.id }, instruction }, c),
    took: async () => (await db.agentTask.findUniqueOrThrow({ where: { id: f.assigned.id } })).assigneeUserId === f.holder.id,
  },
  cancelAgentTask: {
    act: 'task.cancel',
    call: (instruction, c) => M.cancelAgentTask({}, { taskId: f.task.id, instruction }, c),
    took: async () => (await db.agentTask.findUniqueOrThrow({ where: { id: f.task.id } })).status === 'cancelled',
  },
  parkAgentTask: {
    act: 'task.park',
    call: (instruction, c) => M.parkAgentTask({}, { taskId: f.task.id, instruction }, c),
    took: async () => (await db.agentTask.findUniqueOrThrow({ where: { id: f.task.id } })).status === 'backlog',
  },
  makeAgentTaskReady: {
    act: 'task.ready',
    call: (instruction, c) => M.makeAgentTaskReady({}, { taskId: f.backlog.id, instruction }, c),
    took: async () => (await db.agentTask.findUniqueOrThrow({ where: { id: f.backlog.id } })).status === 'pending',
  },
  updateAgentTask: {
    act: 'task.update',
    call: (instruction, c) => M.updateAgentTask({}, { taskId: f.task.id, input: { title: 'Renamed', properties: { k: 1 } }, instruction }, c),
    took: async () => {
      const t = await db.agentTask.findUniqueOrThrow({ where: { id: f.task.id } });
      return t.title === 'Renamed' && (t.properties as any)?.k === 1;
    },
  },
  disposeAgentTaskFinding: {
    act: 'task.finding-dispose',
    call: (instruction, c) => M.disposeAgentTaskFinding({}, { taskRef: f.finished.id, findingId: 'F1', disposition: 'fixed', instruction }, c),
    took: async () => (await db.agentTeamEvent.count({ where: { taskId: f.finished.id, type: 'task.finding-disposed' } })) === 1,
  },
  setAgentTaskPriority: {
    act: 'task.priority',
    call: (instruction, c) => M.setAgentTaskPriority({}, { taskRef: f.task.id, priority: 4, instruction }, c),
    took: async () => (await db.agentTask.findUniqueOrThrow({ where: { id: f.task.id } })).priority === 4,
  },
  addAgentTaskBlocker: {
    act: 'task.blocker-add',
    call: (instruction, c) => M.addAgentTaskBlocker({}, { taskRef: f.task.id, blockerTaskRef: f.blocker.id, instruction }, c),
    took: async () => (await db.agentTaskBlocker.count({ where: { taskId: f.task.id, blockerTaskId: f.blocker.id } })) === 1,
  },
  removeAgentTaskBlocker: {
    act: 'task.blocker-remove',
    call: (instruction, c) => M.removeAgentTaskBlocker({}, { taskRef: f.blocked.id, blockerTaskRef: f.blocker.id, instruction }, c),
    took: async () => (await db.agentTaskBlocker.count({ where: { taskId: f.blocked.id } })) === 0,
  },
  createAgentTask: {
    act: 'task.create',
    // Naming another owner is open to any participant (050:01); naming its priority and properties is the direction arm.
    call: (instruction, c) => M.createAgentTask({}, { input: { appRef: f.app.id, title: 'On behalf', owner: { user: f.boss.id }, priority: 3, properties: { k: 2 } }, instruction }, c),
    took: async () => {
      const t = await db.agentTask.findFirst({ where: { title: 'On behalf' } });
      return t?.priority === 3 && (t?.properties as any)?.k === 2;
    },
  },
  acknowledgeAlarm: {
    act: 'alarm.acknowledge',
    call: (instruction, c) => M.acknowledgeAlarm({}, { eventId: f.alarm.id, instruction }, c),
    took: async () => (await db.agentTeamEvent.findUniqueOrThrow({ where: { id: f.alarm.id } })).acknowledgedAt !== null,
  },
  setWorkerAvailability: {
    act: 'worker.availability',
    call: (instruction, c) => M.setWorkerAvailability({}, { input: { worker: f.target.id, state: 'UNAVAILABLE', reason: 'OUT_OF_TOKENS' }, instruction }, c),
    took: async () => (await db.workerAvailability.findUnique({ where: { workerId: f.target.id } }))?.setBy === 'app-manager',
  },
  setModelFamilyAvailability: {
    act: 'model-family.availability',
    call: (instruction, c) => M.setModelFamilyAvailability({}, { input: { appRef: f.app.id, family: 'claude', state: 'UNAVAILABLE', reason: 'OTHER' }, instruction }, c),
    took: async () => (await db.modelFamilyAvailability.count({ where: { appId: f.app.id, family: 'claude' } })) === 1,
  },
  setAgentTaskStallSchedule: {
    act: 'app.stall-schedule',
    call: (instruction, c) => M.setAgentTaskStallSchedule({}, { appRef: f.app.id, input: { notStartedMinutes: 33 }, instruction }, c),
    took: async () => (await db.agentTaskStallSchedule.findUnique({ where: { appId: f.app.id } }))?.notStartedMinutes === 33,
  },
  setAppModelGroup: {
    act: 'app.model-group.set',
    call: (instruction, c) => M.setAppModelGroup({}, { appRef: f.app.id, name: 'fast', patterns: ['claude-*'], instruction }, c),
    took: async () => (await db.modelGroup.count({ where: { appId: f.app.id, name: 'fast' } })) === 1,
  },
  deleteAppModelGroup: {
    act: 'app.model-group.delete',
    call: (instruction, c) => M.deleteAppModelGroup({}, { appRef: f.app.id, name: 'slow', instruction }, c),
    took: async () => (await db.modelGroup.count({ where: { appId: f.app.id, name: 'slow' } })) === 0,
  },
  setAppProperties: {
    act: 'app.properties',
    call: (instruction, c) => M.setAppProperties({}, { appRef: f.app.id, properties: { team: 'x' }, instruction }, c),
    took: async () => ((await db.app.findUniqueOrThrow({ where: { id: f.app.id } })).properties as any)?.team === 'x',
  },
};

beforeEach(async () => {
  await cleanDb(db);
  const n = generateId().slice(-8).toLowerCase();
  const holder = await db.user.create({ data: { handle: `holder-${n}`, roles: ['READER'] } });
  const other = await db.user.create({ data: { handle: `other-${n}`, roles: ['READER'] } });
  const boss = await db.user.create({ data: { handle: `boss-${n}`, roles: ['READER'] } });
  const org = await db.organization.create({ data: { name: 'S4a', urn: `s4a-${n}.test` } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: holder.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: other.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: boss.id, role: 'CONTRIBUTOR' },
  ] });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `s4a-${n}.test:team` } });
  const otherApp = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `s4a-${n}.test:other` } });
  await db.appMember.createMany({ data: [
    { appId: app.id, userId: holder.id, role: 'owner' },
    { appId: app.id, userId: other.id, role: 'member' },
    { appId: app.id, userId: boss.id, role: 'member' },
    { appId: otherApp.id, userId: boss.id, role: 'owner' },
  ] });
  const memory = await db.memory.create({ data: { organizationId: org.id, name: 'System', urn: `s4a-${n}.test:system`, class: 'system' } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `s4a-${n}.test:agent`, name: 'Agent', systemMemoryId: memory.id } });
  await db.appAgent.createMany({ data: [{ appId: app.id, agentId: agent.id }, { appId: otherApp.id, agentId: agent.id }] });
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Caller', slug: 'caller', heldByUserId: holder.id } });
  const target = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Target', slug: 'target' } });
  const session = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, workerId: worker.id, userId: holder.id, tool: 'vitest' } });
  const asBoss = { db, userId: boss.id, roles: ['READER'] } as Context;
  const mk = (input: Record<string, unknown>, appId = app.id) => M.createAgentTask({}, { input: { appRef: appId, title: 'T', ...input } }, asBoss);
  const task = await mk({ title: 'Plain' });
  const backlog = await mk({ title: 'Backlog', status: 'backlog' });
  const assigned = await mk({ title: 'Assigned', assignee: { user: boss.id } });
  const blocker = await mk({ title: 'Blocker' });
  const blocked = await mk({ title: 'Blocked', blockedBy: [blocker.id] });
  const finished = await mk({ title: 'Finished', assignee: { user: boss.id } });
  await M.startAgentTask({}, { taskId: finished.id }, asBoss);
  await M.finishAgentTask({}, { taskId: finished.id, result: { outcome: 'done', summary: 's', findings: [{ id: 'F1', severity: 'P2', text: 'one' }] } }, asBoss);
  const foreignTask = await mk({ title: 'Foreign' }, otherApp.id);
  // An alarm with no owner in its chain: only the manager arm acknowledges it.
  const alarm = await db.agentTeamEvent.create({ data: {
    appId: app.id, taskId: task.id, type: 'stall.not-started', severity: 'alarm', chain: [] as never, episodeStart: new Date(),
  } });
  const foreignAlarm = await db.agentTeamEvent.create({ data: {
    appId: otherApp.id, taskId: foreignTask.id, type: 'stall.not-started', severity: 'alarm', chain: [] as never, episodeStart: new Date(),
  } });
  await db.modelGroup.create({ data: { appId: app.id, name: 'slow', patterns: ['glm-*'], createdBy: boss.id, updatedBy: boss.id } });
  f = { holder, other, boss, org, app, otherApp, agent, worker, target, session, task, backlog, assigned, blocker, blocked, finished, foreignTask, alarm, foreignAlarm };
});

describe('#3323 the S4a doors admit an instructed worker on its holder\'s App-manager right', () => {
  for (const [name, door] of Object.entries(doors)) {
    // Acceptance 1 (red on main): actorManagesApp refuses every worker actor.
    it(`${name}: an owner-role holder's worker with an instruction is admitted, with exactly one record`, async () => {
      const got = await answer(() => asWorker(() => door.call(live, bound())));
      expect(got).toEqual({ code: 'RESOLVED' });
      expect(await door.took()).toBe(true);
      const acts = await managerActs();
      expect(acts).toHaveLength(1);
      expect(acts[0]).toMatchObject({ appId: f.app.id, actorUserId: f.holder.id, actorWorkerId: f.worker.id, actorAgentId: f.agent.id, taskId: null });
      expect(acts[0]!.payload).toMatchObject({ act: door.act, instruction: live });
    });

    it(`${name}: an org ADMIN holder's worker with an instruction is admitted`, async () => {
      await db.appMember.update({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } }, data: { role: 'member' } });
      await db.orgMember.update({ where: { organizationId_userId: { organizationId: f.org.id, userId: f.holder.id } }, data: { role: 'ADMIN' } });
      expect(await answer(() => asWorker(() => door.call(live, bound())))).toEqual({ code: 'RESOLVED' });
      expect(await managerActs()).toHaveLength(1);
    });

    // Acceptance 2: no wider. The worker gets what it gets today with no instruction; nothing is written.
    it(`${name}: a holder who does not manage the App gets the same answer as with no instruction, nothing written`, async () => {
      await db.appMember.update({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } }, data: { role: 'member' } });
      const before = await snapshot();
      const instructed = await answer(() => asWorker(() => door.call(live, bound())));
      const plain = await answer(() => asWorker(() => door.call(undefined, bound())));
      expect(instructed.code).not.toBe('RESOLVED');
      // A create names the id it would have made in no refusal, but compare the whole answer except a fresh task id.
      const strip = (a: any) => ({ ...a, ext: a.ext && { ...a.ext, ...(name === 'createAgentTask' ? { taskId: undefined } : {}) } });
      expect(strip(instructed)).toEqual(strip(plain));
      expect(await snapshot()).toEqual(before);
    });

    // Acceptances 3, 4, 7: headless, unheld, held by someone else, the key and impersonation principals.
    for (const kind of ['no-instruction', 'host-launch', 'unheld', 'other-holder', 'ended-session', 'impersonation', 'app-key', 'bad-claim'] as const) {
      it(`${name}: ${kind} is refused and writes nothing`, async () => {
        let c = bound(); let claim: unknown = live;
        if (kind === 'no-instruction') claim = undefined;
        if (kind === 'bad-claim') claim = { kind: 'TASK', ref: 'hrn:agenttask:nowhere:AT404' };
        if (kind === 'host-launch') await db.session.update({ where: { id: f.session.id }, data: { launchOperationId: generateId(), launchHostId: generateId(), launchIssuedBy: 'manager' } });
        if (kind === 'unheld' || kind === 'other-holder') await db.worker.update({ where: { id: f.worker.id }, data: { heldByUserId: kind === 'unheld' ? null : f.other.id } });
        if (kind === 'ended-session') await db.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
        if (kind === 'impersonation') c = bound({ impersonation: { sessionId: generateId(), actorUserId: f.other.id, orgId: f.org.id, expiresAt: new Date('2099-01-01') } } as any);
        if (kind === 'app-key') c = { db, appId: f.app.id, roles: [] } as Context;
        const before = await snapshot();
        const got = await answer(() => asWorker(() => door.call(claim, c)));
        expect(got.code).not.toBe('RESOLVED');
        expect(got.code).toBeDefined();
        expect(await snapshot()).toEqual(before);
      });
    }

    // Acceptance 6: a direct person writes no record, with or without an instruction.
    it(`${name}: the holder acting as themselves is admitted and writes no instructed-act record`, async () => {
      expect(await answer(() => door.call(undefined, ctx()))).toEqual({ code: 'RESOLVED' });
      expect(await door.took()).toBe(true);
      expect(await managerActs()).toHaveLength(0);
    });

  }

  // Acceptance 6: the record comes after every refusal. Each act is admitted by the gate, then refused on its own state.
  const refusedAfterGate: Record<string, () => Promise<unknown>> = {
    'acknowledgeAlarm on an acknowledged alarm': async () => {
      await M.acknowledgeAlarm({}, { eventId: f.alarm.id }, ctx());
      return M.acknowledgeAlarm({}, { eventId: f.alarm.id, instruction: live }, bound());
    },
    'makeAgentTaskReady on a pending task': () => M.makeAgentTaskReady({}, { taskId: f.task.id, instruction: live }, bound()),
    'parkAgentTask on an assigned task': () => M.parkAgentTask({}, { taskId: f.assigned.id, instruction: live }, bound()),
    'deleteAppModelGroup of a missing group': () => M.deleteAppModelGroup({}, { appRef: f.app.id, name: 'none', instruction: live }, bound()),
    'setAppProperties at a stale revision': () => M.setAppProperties({}, { appRef: f.app.id, properties: { team: 'y' }, expectedRevision: 9, instruction: live }, bound()),
  };
  for (const [name, call] of Object.entries(refusedAfterGate)) {
    it(`${name}: refused after the gate, no record`, async () => {
      const got = await answer(() => asWorker(call));
      expect(got.code).not.toBe('RESOLVED');
      expect(got.code).not.toMatch(/NOT_OWNER|MANAGER_REQUIRED|FORBIDDEN|NOT_IN_CHAIN|NOT_PERMITTED/);
      expect(await managerActs()).toHaveLength(0);
    });
  }

  it('the record carries ids only: no title, description, properties or patterns', async () => {
    await asWorker(() => doors.updateAgentTask!.call(live, bound()));
    await asWorker(() => doors.setAppModelGroup!.call(live, bound()));
    await asWorker(() => doors.setAppProperties!.call(live, bound()));
    const text = JSON.stringify(await managerActs());
    for (const s of ['Renamed', 'claude-*', '"team"', '"k"']) expect(text).not.toContain(s);
  });

  it('a TASK instruction the holder can read is accepted; it names the App the act is in', async () => {
    const claim = { kind: 'TASK', ref: `hrn:agenttask:${f.app.urn}:${(await db.agentTask.findUniqueOrThrow({ where: { id: f.blocker.id } })).handle}` };
    expect(await answer(() => asWorker(() => doors.cancelAgentTask!.call(claim, bound())))).toEqual({ code: 'RESOLVED' });
    expect((await managerActs())[0]!.payload).toMatchObject({ instruction: claim });
  });

  it('a no-op writes no record: App properties set to what they already are', async () => {
    await doors.setAppProperties!.call(undefined, ctx());
    expect(await answer(() => asWorker(() => doors.setAppProperties!.call(live, bound())))).toEqual({ code: 'RESOLVED' });
    expect(await managerActs()).toHaveLength(0);
  });

  it('a no-op writes no record: adding a blocker the task already has', async () => {
    expect(await answer(() => asWorker(() => M.addAgentTaskBlocker({}, { taskRef: f.blocked.id, blockerTaskRef: f.blocker.id, instruction: live }, bound())))).toEqual({ code: 'RESOLVED' });
    expect(await managerActs()).toHaveLength(0);
  });
});

describe('#3323 other arms are unchanged and write no record (acceptance 5)', () => {
  it('the task owner\'s worker cancels its own task with no instruction', async () => {
    const own = await asWorker(() => M.createAgentTask({}, { input: { appRef: f.app.id, title: 'Mine' } }, bound()));
    expect(await answer(() => asWorker(() => M.cancelAgentTask({}, { taskId: own.id }, bound())))).toEqual({ code: 'RESOLVED' });
    expect(await managerActs()).toHaveLength(0);
  });

  it('the owner arm decides before the instructed manager arm: an instructed owner writes no record', async () => {
    const own = await asWorker(() => M.createAgentTask({}, { input: { appRef: f.app.id, title: 'Mine' } }, bound()));
    expect(await answer(() => asWorker(() => M.cancelAgentTask({}, { taskId: own.id, instruction: live }, bound())))).toEqual({ code: 'RESOLVED' });
    expect(await managerActs()).toHaveLength(0);
  });

  it('a worker the owner reports to directs the task with no instruction', async () => {
    await db.worker.update({ where: { id: f.target.id }, data: { reportsToWorkerId: f.worker.id } });
    const owned = await runAsActor({ workerId: f.target.id, agentId: f.agent.id }, () => M.createAgentTask({}, { input: { appRef: f.app.id, title: 'Theirs' } }, ctx({ userId: f.holder.id })));
    expect(await answer(() => asWorker(() => M.parkAgentTask({}, { taskId: owned.id }, bound())))).toEqual({ code: 'RESOLVED' });
    expect(await managerActs()).toHaveLength(0);
  });

  it('an owner in the alarm\'s chain acknowledges it with no instruction', async () => {
    const mine = await db.agentTeamEvent.create({ data: {
      appId: f.app.id, taskId: f.blocker.id, type: 'stall.not-started', severity: 'alarm', chain: [{ workerId: f.worker.id }] as never, episodeStart: new Date(),
    } });
    expect(await answer(() => asWorker(() => M.acknowledgeAlarm({}, { eventId: mine.id }, bound())))).toEqual({ code: 'RESOLVED' });
    expect(await managerActs()).toHaveLength(0);
  });

  it('a worker marks itself unavailable with no instruction', async () => {
    expect(await answer(() => asWorker(() => M.setWorkerAvailability({}, { input: { worker: f.worker.id, state: 'UNAVAILABLE', reason: 'OUT_OF_TOKENS' } }, bound())))).toEqual({ code: 'RESOLVED' });
    expect((await db.workerAvailability.findUniqueOrThrow({ where: { workerId: f.worker.id } })).setBy).toBe('worker');
    expect(await managerActs()).toHaveLength(0);
  });

  it('the task assignee writes properties with no instruction', async () => {
    await M.assignAgentTask({}, { taskId: f.task.id, assignee: { worker: f.worker.id } }, { db, userId: f.boss.id, roles: ['READER'] } as Context);
    expect(await answer(() => asWorker(() => M.updateAgentTask({}, { taskId: f.task.id, input: { properties: { k: 9 } } }, bound())))).toEqual({ code: 'RESOLVED' });
    expect(await managerActs()).toHaveLength(0);
  });
});

describe('#3323 refusal before oracle (acceptance 8)', () => {
  const refusedWorker = async (fn: () => Promise<unknown>) => {
    await db.appMember.update({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } }, data: { role: 'member' } });
    return answer(() => asWorker(fn));
  };
  it('a task in another App and a missing task answer alike', async () => {
    const foreign = await refusedWorker(() => M.cancelAgentTask({}, { taskId: f.foreignTask.id, instruction: live }, bound()));
    const missing = await refusedWorker(() => M.cancelAgentTask({}, { taskId: f.foreignTask.id.replace(/.$/, (c: string) => (c === 'a' ? 'b' : 'a')), instruction: live }, bound()));
    expect(foreign.code).toBe('TASK_NOT_FOUND');
    expect(missing.code).toBe(foreign.code);
  });
  it('an alarm in another App and a missing alarm answer alike', async () => {
    const foreign = await refusedWorker(() => M.acknowledgeAlarm({}, { eventId: f.foreignAlarm.id, instruction: live }, bound()));
    const missing = await refusedWorker(() => M.acknowledgeAlarm({}, { eventId: generateId(), instruction: live }, bound()));
    expect(foreign).toEqual({ ...missing, ext: { ...missing.ext as object, eventId: f.foreignAlarm.id } });
  });
});

describe('#3323 callers not wired in this slice keep refusing a worker (acceptance 10)', () => {
  // The holder manages the App, and each call carries an instruction; none of these doors passes it on.
  const unwired: Record<string, (c: Context) => Promise<unknown>> = {
    grantApp: (c) => M.grantApp({}, { appRef: f.app.id, workerRef: f.target.id, name: 'TICKER_SUBSCRIBE_WORKERS', instruction: live }, c),
    grantAppKeyScope: async (c) => {
      const key = await db.appKey.create({ data: { appId: f.app.id, keyHash: generateId(), keyPreview: 'abcd', label: 'K' } });
      return M.grantAppKeyScope({}, { id: key.id, scope: 'attention:deliver', instruction: live }, c);
    },
    setTeamStopSignal: (c) => M.setTeamStopSignal({}, { input: { appRef: f.app.id, level: 'PAUSE', scope: 'WORKER', worker: f.target.id }, instruction: live }, c),
    setAppTickerSettings: (c) => M.setAppTickerSettings({}, { appRef: f.app.id, input: { wakeDailyBudget: 5 }, instruction: live }, c),
  };
  for (const [name, call] of Object.entries(unwired)) {
    it(`${name}: a worker held by an App manager is refused, nothing written`, async () => {
      const before = await snapshot();
      const keysBefore = await db.appKeyScope.count();
      const got = await answer(() => asWorker(() => call(bound())));
      expect(got.code).not.toBe('RESOLVED');
      expect(got.code).toBeDefined();
      expect(await snapshot()).toEqual(before);
      expect(await db.appKeyScope.count()).toBe(keysBefore);
      expect(await db.appGrant.count()).toBe(0);
      expect(await db.teamStopSignal.count()).toBe(0);
    });
  }
});
