/**
 * #3321 (S4b of #2483), hrn:node:hadronmemory.com:specs:cor:dmo:050:12: a worker session acts with its holder's
 * App-manager right, on a clear instruction, at the host-operation, stop-signal, ticker, settings, isolation and wake
 * doors. Every door reaches #3323's choke point, `actorManagesApp`, with the instruction it was called with.
 *
 * Record: an admitted instructed act writes exactly one `app.manager-act` AgentTeamEvent in its own transaction, ids
 * only (cor:agt:050:11); a refusal, a no-op, a direct person and a worker admitted on its own arm write none. An
 * admitted instructed manager-scope wake read writes one record per call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { declareAllStopLanes } from '../../../test/stopLanes.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { setS7AvailableForTest } from '../../../lib/tickers/s7Availability.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../../middleware/auth.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
let f: any;
const live = { kind: 'LIVE_CHAT', ref: 'client-chat:turn-3321' };
const badClaim = { kind: 'TASK', ref: 'hrn:agenttask:nowhere:AT404' };
const ctx = (extra: Partial<Context> = {}): Context => ({ db, userId: f.holder.id, roles: ['READER'], ...extra });
const bound = (extra: Partial<Context> = {}) => ctx({ sessionId: f.session.id, ...extra });
const asBoss = () => ctx({ userId: f.boss.id });
/** The call as the holder's worker, bound by the transport (the X-Hadron-Session shape) and on the session row. */
const asWorker = <T>(fn: () => Promise<T>, worker = f.worker) => runAsActor({ workerId: worker.id, agentId: f.agent.id }, fn);
const answer = async (p: () => Promise<unknown>) => {
  try { await p(); return { code: 'RESOLVED' }; } catch (e: any) { return { code: e.extensions?.code, message: e.message, ext: e.extensions }; }
};
const managerActs = () => db.agentTeamEvent.findMany({ where: { type: 'app.manager-act' }, orderBy: { id: 'asc' } });
const demoteHolder = () => db.appMember.update({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } }, data: { role: 'member' } });
const snapshot = async () => ({
  operations: await db.hostOperation.findMany({ orderBy: { id: 'asc' } }),
  signals: await db.teamStopSignal.findMany({ orderBy: { id: 'asc' } }),
  tickers: await db.ticker.findMany({ orderBy: { id: 'asc' } }),
  subscriptions: await db.tickerSubscription.findMany({ orderBy: { id: 'asc' } }),
  wake: await db.workerWakeSettings.findMany({ orderBy: { workerId: 'asc' } }),
  events: await db.agentTeamEvent.findMany({ orderBy: { id: 'asc' } }),
  app: await db.app.findUniqueOrThrow({ where: { id: f.app.id } }),
});

type Door = {
  act: string;
  call: (instruction: unknown, c: Context) => Promise<unknown>;
  took: () => Promise<boolean>;
  /** The ids the record carries besides the act and the instruction. */
  subject?: () => Record<string, string>;
  /** Set when a person who does not manage the App is not refused here, so the worker is held to its no-instruction answer. */
  personNotRefused?: true;
};
const opCount = (type: string, workerId: string) => db.hostOperation.count({ where: { appId: f.app.id, type, workerId } });
const issue = (type: string, worker: string, args: Record<string, string>, instruction: unknown, c: Context) =>
  M.issueHostOperation({}, { input: { appRef: f.app.id, hostId: 'orca1', worker, type, args }, instruction }, c);
const doors: Record<string, Door> = {
  'issueHostOperation worker.start': {
    act: 'host-operation.worker.start',
    call: (i, c) => issue('worker.start', f.idle.id, { worktree: 'hadron-server/idle', family: 'claude' }, i, c),
    took: async () => (await opCount('worker.start', f.idle.id)) === 1,
    subject: () => ({ workerId: f.idle.id }),
  },
  'issueHostOperation worker.end': {
    act: 'host-operation.worker.end',
    call: (i, c) => issue('worker.end', f.target.id, { sessionId: f.targetSession.id }, i, c),
    took: async () => (await opCount('worker.end', f.target.id)) === 1,
    subject: () => ({ workerId: f.target.id }),
  },
  'issueHostOperation worktree.create': {
    act: 'host-operation.worktree.create',
    call: (i, c) => issue('worktree.create', f.target.id, { repo: 'hadron-server', baseBranch: 'main', branchName: 'target/1-x', label: 'target-1' }, i, c),
    took: async () => (await opCount('worktree.create', f.target.id)) === 1,
    subject: () => ({ workerId: f.target.id }),
  },
  'issueHostOperation worktree.remove': {
    act: 'host-operation.worktree.remove',
    call: (i, c) => issue('worktree.remove', f.target.id, { worktree: 'hadron-server/target' }, i, c),
    took: async () => (await opCount('worktree.remove', f.target.id)) === 1,
    subject: () => ({ workerId: f.target.id }),
  },
  setTeamStopSignal: {
    act: 'stop.set',
    call: (i, c) => M.setTeamStopSignal({}, { input: { appRef: f.app.id, level: 'PAUSE', scope: 'WORKER', worker: f.target.id }, instruction: i }, c),
    took: async () => (await db.teamStopSignal.count({ where: { appId: f.app.id, targetWorkerId: f.target.id } })) === 2,
  },
  liftTeamStopSignal: {
    act: 'stop.lift',
    call: (i, c) => M.liftTeamStopSignal({}, { appRef: f.app.id, id: f.signal.id, instruction: i }, c),
    took: async () => (await db.teamStopSignal.findUniqueOrThrow({ where: { id: f.signal.id } })).endedAt !== null,
    subject: () => ({ signalId: f.signal.id }),
  },
  updateTicker: {
    act: 'ticker.update',
    call: (i, c) => M.updateTicker({}, { ref: f.ticker.id, input: { name: 'Renamed' }, instruction: i }, c),
    took: async () => (await db.ticker.findUniqueOrThrow({ where: { id: f.ticker.id } })).name === 'Renamed',
    subject: () => ({ tickerId: f.ticker.id }),
  },
  deleteTicker: {
    act: 'ticker.delete',
    call: (i, c) => M.deleteTicker({}, { ref: f.ticker.id, instruction: i }, c),
    took: async () => (await db.ticker.findUniqueOrThrow({ where: { id: f.ticker.id } })).deletedAt !== null,
    subject: () => ({ tickerId: f.ticker.id }),
  },
  subscribeWorker: {
    act: 'ticker.subscribe',
    call: (i, c) => M.subscribeWorker({}, { tickerRef: f.ticker.id, workerRef: f.idle.id, instruction: i }, c),
    took: async () => (await db.tickerSubscription.count({ where: { tickerId: f.ticker.id, workerId: f.idle.id, endedAt: null } })) === 1,
    subject: () => ({ tickerId: f.ticker.id, workerId: f.idle.id }),
  },
  unsubscribeWorker: {
    act: 'ticker.unsubscribe',
    call: (i, c) => M.unsubscribeWorker({}, { tickerRef: f.ticker.id, workerRef: f.target.id, instruction: i }, c),
    took: async () => (await db.tickerSubscription.count({ where: { tickerId: f.ticker.id, workerId: f.target.id, endedAt: null } })) === 0,
    subject: () => ({ tickerId: f.ticker.id, workerId: f.target.id }),
  },
  applyAgentTickerTemplates: {
    act: 'ticker.templates-apply',
    call: (i, c) => M.applyAgentTickerTemplates({}, { workerRef: f.idle.id, instruction: i }, c),
    took: async () => (await db.ticker.count({ where: { appId: f.app.id, ownerWorkerId: f.idle.id, deletedAt: null } })) === 1,
    subject: () => ({ workerId: f.idle.id }),
  },
  setWorkerWakeSettings: {
    act: 'worker.wake-settings',
    call: (i, c) => M.setWorkerWakeSettings({}, { workerRef: f.target.id, input: { mentions: 'OFF' }, instruction: i }, c),
    took: async () => (await db.workerWakeSettings.findUnique({ where: { workerId: f.target.id } }))?.mentions === 'OFF',
    subject: () => ({ workerId: f.target.id }),
  },
  isolateWorker: {
    act: 'worker.isolate',
    call: (i, c) => M.isolateWorker({}, { workerRef: f.target.id, instruction: i }, c),
    took: async () => (await db.workerWakeSettings.findUnique({ where: { workerId: f.target.id } }))?.isolatedUntil != null,
    subject: () => ({ workerId: f.target.id }),
  },
  clearWorkerIsolation: {
    act: 'worker.isolation-clear',
    call: (i, c) => M.clearWorkerIsolation({}, { workerRef: f.isolated.id, instruction: i }, c),
    took: async () => (await db.workerWakeSettings.findUniqueOrThrow({ where: { workerId: f.isolated.id } })).isolatedUntil === null,
    subject: () => ({ workerId: f.isolated.id }),
  },
  setAppTickerSettings: {
    act: 'app.ticker-settings',
    call: (i, c) => M.setAppTickerSettings({}, { appRef: f.app.id, input: { liveCap: 7 }, instruction: i }, c),
    took: async () => (await db.app.findUniqueOrThrow({ where: { id: f.app.id } })).tickerLiveCap === 7,
  },
  setAppDeliverySettings: {
    act: 'app.delivery-settings',
    call: (i, c) => M.setAppDeliverySettings({}, { appRef: f.app.id, input: { failedChecksToOverdue: 7 }, instruction: i }, c),
    took: async () => (await db.app.findUniqueOrThrow({ where: { id: f.app.id } })).deliveryFailedChecksToOverdue === 7,
  },
  'setTeamPause on': {
    act: 'team.pause',
    call: (i, c) => M.setTeamPause({}, { appRef: f.app.id, paused: true, instruction: i }, c),
    took: async () => (await db.app.findUniqueOrThrow({ where: { id: f.app.id } })).teamPausedAt !== null,
  },
  dueWakes: {
    act: 'wake.read',
    call: (i, c) => Q.dueWakes({}, { appRef: f.app.id, instruction: i }, c),
    took: async () => true,
    personNotRefused: true,
  },
};

beforeEach(async () => {
  await cleanDb(db);
  setS7AvailableForTest(true); // isolation is inert until S7b; this file tests who may, not whether it is on yet
  const n = generateId().slice(-8).toLowerCase();
  const holder = await db.user.create({ data: { handle: `holder-${n}`, roles: ['READER'] } });
  const other = await db.user.create({ data: { handle: `other-${n}`, roles: ['READER'] } });
  const boss = await db.user.create({ data: { handle: `boss-${n}`, roles: ['READER'] } });
  const org = await db.organization.create({ data: { name: 'S4b', urn: `s4b-${n}.test` } });
  await db.orgMember.createMany({ data: [holder, other, boss].map(u => ({ organizationId: org.id, userId: u.id, role: 'CONTRIBUTOR' as const })) });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `s4b-${n}.test:team` } });
  const otherApp = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `s4b-${n}.test:other` } });
  await db.appMember.createMany({ data: [
    { appId: app.id, userId: holder.id, role: 'owner' },
    { appId: app.id, userId: other.id, role: 'member' },
    { appId: app.id, userId: boss.id, role: 'member' },
    { appId: otherApp.id, userId: boss.id, role: 'owner' },
  ] });
  const memory = await db.memory.create({ data: { organizationId: org.id, name: 'System', urn: `s4b-${n}.test:system`, class: 'system' } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `s4b-${n}.test:agent`, name: 'Agent', systemMemoryId: memory.id } });
  await db.appAgent.createMany({ data: [{ appId: app.id, agentId: agent.id }, { appId: otherApp.id, agentId: agent.id }] });
  const mkWorker = (name: string, heldByUserId: string | null, appId = app.id, extra: Record<string, unknown> = {}) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name, slug: name.toLowerCase(), heldByUserId, ...extra } });
  const worker = await mkWorker('Caller', holder.id);
  const target = await mkWorker('Target', boss.id);
  const idle = await mkWorker('Idle', boss.id);
  const isolated = await mkWorker('Isolated', boss.id);
  const foreign = await mkWorker('Foreign', boss.id, otherApp.id);
  const session = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, workerId: worker.id, userId: holder.id, tool: 'vitest' } });
  const targetSession = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, workerId: target.id, userId: boss.id, tool: 'vitest' } });
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  const key = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label: 'orca1' } });
  const asOwner = { db, userId: holder.id, roles: ['READER'] } as Context;
  await M.grantAppKeyScope({}, { id: key.id, scope: 'host:operate', hostId: 'orca1' }, asOwner);
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca', pollIntervalSeconds: 600, workers: [
    { worker: target.id, family: 'claude', worktrees: ['hadron-server/target'] },
    { worker: idle.id, family: 'claude', worktrees: ['hadron-server/idle'] },
    { worker: worker.id, family: 'claude', worktrees: [] },
    { worker: isolated.id, family: 'claude', worktrees: [] },
  ] } }, { db, appId: app.id, appKeyId: key.id, organizationId: org.id, roles: [] } as Context);
  await declareAllStopLanes(db, app.id);
  const signal = await M.setTeamStopSignal({}, { input: { appRef: app.id, level: 'PAUSE', scope: 'WORKER', worker: target.id } }, asOwner);
  const ticker = await M.createTicker({}, { appRef: app.id, input: { name: 'Boss tick', cadenceSeconds: 900 } }, { db, userId: boss.id, roles: ['READER'] } as Context);
  const foreignTicker = await M.createTicker({}, { appRef: otherApp.id, input: { name: 'Foreign tick', cadenceSeconds: 900 } }, { db, userId: boss.id, roles: ['READER'] } as Context);
  await M.subscribeWorker({}, { tickerRef: ticker.id, workerRef: target.id }, { db, userId: boss.id, roles: ['READER'] } as Context);
  const holderInOrg = { organizationId_userId: { organizationId: org.id, userId: holder.id } };
  await db.orgMember.update({ where: holderInOrg, data: { role: 'ADMIN' } });
  await M.createAgentTickerTemplate({}, { agentRef: agent.id, input: { name: 'Base', cadenceSeconds: 900 } }, asOwner);
  await db.orgMember.update({ where: holderInOrg, data: { role: 'CONTRIBUTOR' } });
  await M.isolateWorker({}, { workerRef: isolated.id }, asOwner);
  f = { holder, other, boss, org, app, otherApp, agent, worker, target, idle, isolated, foreign, session, targetSession, key, signal, ticker, foreignTicker };
});
afterEach(() => setS7AvailableForTest(false));

describe('#3321 the S4b doors admit an instructed worker on its holder\'s App-manager right', () => {
  for (const [name, door] of Object.entries(doors)) {
    // Acceptance 1 (red on main): no door takes an instruction, so every worker is refused.
    it(`${name}: an owner-role holder's worker with an instruction is admitted, with exactly one record`, async () => {
      expect(await answer(() => asWorker(() => door.call(live, bound())))).toEqual({ code: 'RESOLVED' });
      expect(await door.took()).toBe(true);
      const acts = await managerActs();
      expect(acts).toHaveLength(1);
      expect(acts[0]).toMatchObject({ appId: f.app.id, actorUserId: f.holder.id, actorWorkerId: f.worker.id, actorAgentId: f.agent.id, taskId: null });
      expect(acts[0]!.payload).toMatchObject({ act: door.act, ...door.subject?.(), instruction: live });
    });

    it(`${name}: an org ADMIN holder's worker with an instruction is admitted`, async () => {
      await demoteHolder();
      await db.orgMember.update({ where: { organizationId_userId: { organizationId: f.org.id, userId: f.holder.id } }, data: { role: 'ADMIN' } });
      expect(await answer(() => asWorker(() => door.call(live, bound())))).toEqual({ code: 'RESOLVED' });
      expect(await managerActs()).toHaveLength(1);
    });

    // Acceptance 2: no wider. The holder's own answer, byte-identical, nothing written.
    it(`${name}: a holder who does not manage the App: the holder's own refusal, nothing written`, async () => {
      await demoteHolder();
      const before = await snapshot();
      const instructed = await answer(() => asWorker(() => door.call(live, bound())));
      expect(instructed.code).not.toBe('RESOLVED');
      const reference = door.personNotRefused
        ? await answer(() => asWorker(() => door.call(undefined, bound())))
        : await answer(() => door.call(undefined, ctx()));
      expect(instructed).toEqual(reference);
      expect(await snapshot()).toEqual(before);
    });

    // Acceptances 3, 4, 7, 10.
    for (const kind of ['no-instruction', 'host-launch', 'unheld', 'other-holder', 'ended-session', 'impersonation', 'app-key', 'bad-claim'] as const) {
      it(`${name}: ${kind} is refused and writes nothing`, async () => {
        let c = bound(); let claim: unknown = live;
        if (kind === 'no-instruction') claim = undefined;
        if (kind === 'bad-claim') claim = badClaim;
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

    it(`${name}: the holder acting as themselves is admitted and writes no instructed-act record`, async () => {
      expect(await answer(() => door.call(undefined, ctx()))).toEqual({ code: 'RESOLVED' });
      expect(await door.took()).toBe(true);
      expect(await managerActs()).toHaveLength(0);
    });

    it(`${name}: the holder acting as themselves WITH an instruction writes no instructed-act record`, async () => {
      expect(await answer(() => door.call(live, ctx()))).toEqual({ code: 'RESOLVED' });
      expect(await managerActs()).toHaveLength(0);
    });
  }

  it('setTeamPause off: the resume is its own recorded act', async () => {
    await M.setTeamPause({}, { appRef: f.app.id, paused: true }, ctx());
    expect(await answer(() => asWorker(() => M.setTeamPause({}, { appRef: f.app.id, paused: false, instruction: live }, bound())))).toEqual({ code: 'RESOLVED' });
    expect((await managerActs())[0]!.payload).toMatchObject({ act: 'team.resume' });
  });

  it('the ids-only record carries no name, patch or settings value', async () => {
    await asWorker(() => doors.updateTicker!.call(live, bound()));
    await asWorker(() => doors.setAppTickerSettings!.call(live, bound()));
    const text = JSON.stringify(await managerActs());
    expect(text).not.toContain('Renamed');
    expect(text).not.toContain('liveCap');
  });
});

describe('#3321 worker.start names the worker that issued it', () => {
  it('the operation is issued by the worker, with its holder, not by a person', async () => {
    await asWorker(() => doors['issueHostOperation worker.start']!.call(live, bound()));
    const op = await db.hostOperation.findFirstOrThrow({ where: { type: 'worker.start', workerId: f.idle.id } });
    expect(op).toMatchObject({ issuedBy: 'worker', issuedByWorkerId: f.worker.id, issuedByUserId: f.holder.id });
  });
});

describe('#3321 the rows name the holder whose right was used', () => {
  it('a set and a lifted stop signal', async () => {
    await asWorker(() => doors.setTeamStopSignal!.call(live, bound()));
    const set = await db.teamStopSignal.findFirstOrThrow({ where: { appId: f.app.id, targetWorkerId: f.target.id, id: { not: f.signal.id } } });
    expect(set.setByUserId).toBe(f.holder.id);
    await asWorker(() => doors.liftTeamStopSignal!.call(live, bound()));
    expect((await db.teamStopSignal.findUniqueOrThrow({ where: { id: f.signal.id } })).endedByUserId).toBe(f.holder.id);
  });
  it('an isolation', async () => {
    await asWorker(() => doors.isolateWorker!.call(live, bound()));
    expect((await db.workerWakeSettings.findUniqueOrThrow({ where: { workerId: f.target.id } })).isolatedByUserId).toBe(f.holder.id);
  });
});

describe('#3321 the record comes after every refusal (acceptance 6)', () => {
  const refusedAfterGate: Record<string, () => Promise<unknown>> = {
    'worker.start on a worker that is not startable': () => issue('worker.start', f.target.id, { worktree: 'hadron-server/target', family: 'claude' }, live, bound()),
    'worker.end of a session it does not have': () => issue('worker.end', f.target.id, { sessionId: generateId() }, live, bound()),
    'worktree.remove of a worktree not registered': () => issue('worktree.remove', f.target.id, { worktree: 'hadron-server/none' }, live, bound()),
    'setTeamStopSignal on a missing worker': () => M.setTeamStopSignal({}, { input: { appRef: f.app.id, level: 'PAUSE', scope: 'WORKER', worker: generateId() }, instruction: live }, bound()),
    'updateTicker to a name in use': async () => {
      await M.createTicker({}, { appRef: f.app.id, input: { name: 'Taken', cadenceSeconds: 900 } }, asBoss());
      return M.updateTicker({}, { ref: f.ticker.id, input: { name: 'Taken' }, instruction: live }, bound());
    },
    'setAppTickerSettings out of range': () => M.setAppTickerSettings({}, { appRef: f.app.id, input: { liveCap: 0 }, instruction: live }, bound()),
    'isolateWorker with an end in the past': () => M.isolateWorker({}, { workerRef: f.target.id, until: new Date('2001-01-01'), instruction: live }, bound()),
  };
  for (const [name, call] of Object.entries(refusedAfterGate)) {
    it(`${name}: refused after the gate, no record`, async () => {
      const got = await answer(() => asWorker(call));
      expect(got.code).not.toBe('RESOLVED');
      expect(got.code).not.toMatch(/NOT_PERMITTED|MANAGER_REQUIRED|^FORBIDDEN|WORKER_SESSION/);
      expect(await managerActs()).toHaveLength(0);
    });
  }
});

describe('#3321 a no-op writes no record (acceptance 6)', () => {
  const again = (name: string) => ({ first: () => doors[name]!.call(undefined, ctx()), second: () => doors[name]!.call(live, bound()) });
  for (const name of ['setAppTickerSettings', 'setAppDeliverySettings', 'setTeamPause on', 'setWorkerWakeSettings', 'subscribeWorker', 'applyAgentTickerTemplates']) {
    it(`${name}: a repeat changes nothing and records nothing`, async () => {
      const { first, second } = again(name);
      await first();
      expect(await answer(() => asWorker(second))).toEqual({ code: 'RESOLVED' });
      expect(await managerActs()).toHaveLength(0);
    });
  }

  it('updateTicker to the values it already has', async () => {
    expect(await answer(() => asWorker(() => M.updateTicker({}, { ref: f.ticker.id, input: { name: 'Boss tick', cadenceSeconds: 900 }, instruction: live }, bound())))).toEqual({ code: 'RESOLVED' });
    expect(await managerActs()).toHaveLength(0);
  });

  it('liftTeamStopSignal of a signal already ended', async () => {
    await M.liftTeamStopSignal({}, { appRef: f.app.id, id: f.signal.id }, ctx());
    expect(await answer(() => asWorker(() => doors.liftTeamStopSignal!.call(live, bound())))).toEqual({ code: 'RESOLVED' });
    expect(await managerActs()).toHaveLength(0);
  });

  it('clearWorkerIsolation of a worker that is not isolated', async () => {
    expect(await answer(() => asWorker(() => M.clearWorkerIsolation({}, { workerRef: f.target.id, instruction: live }, bound())))).toEqual({ code: 'RESOLVED' });
    expect(await managerActs()).toHaveLength(0);
  });

  it('unsubscribeWorker of a worker not subscribed', async () => {
    const got = await answer(() => asWorker(() => M.unsubscribeWorker({}, { tickerRef: f.ticker.id, workerRef: f.idle.id, instruction: live }, bound())));
    expect(got.code).toBe('SUBSCRIPTION_NOT_FOUND');
    expect(await managerActs()).toHaveLength(0);
  });
});

describe('#3321 other arms are unchanged and write no record (acceptance 5)', () => {
  const noRecord = async (p: () => Promise<unknown>) => {
    expect(await answer(p)).toEqual({ code: 'RESOLVED' });
    expect(await managerActs()).toHaveLength(0);
  };
  const ownTicker = () => asWorker<any>(() => M.createTicker({}, { appRef: f.app.id, input: { name: 'Mine', cadenceSeconds: 7200 } }, bound()));

  it('a worker edits its own ticker with no instruction, and with one writes no record', async () => {
    const t = await ownTicker();
    await noRecord(() => asWorker(() => M.updateTicker({}, { ref: t.id, input: { name: 'Plain' } }, bound())));
    await noRecord(() => asWorker(() => M.updateTicker({}, { ref: t.id, input: { name: 'Told' }, instruction: live }, bound())));
    await noRecord(() => asWorker(() => M.deleteTicker({}, { ref: t.id, instruction: live }, bound())));
  });

  it('a worker subscribes and unsubscribes itself on its own arm, instruction or not, with no record', async () => {
    const t = await ownTicker();
    await noRecord(() => asWorker(() => M.subscribeWorker({}, { tickerRef: t.id, workerRef: f.worker.id, instruction: live }, bound())));
    await noRecord(() => asWorker(() => M.unsubscribeWorker({}, { tickerRef: t.id, workerRef: f.worker.id, instruction: live }, bound())));
    await noRecord(() => asWorker(() => M.subscribeWorker({}, { tickerRef: t.id, workerRef: f.worker.id }, bound())));
  });

  it('a worker past the self-subscribe cadence needs the manager arm: an instruction admits it, with one record', async () => {
    await db.app.update({ where: { id: f.app.id }, data: { tickerSelfSubscribeCadenceSeconds: 3600 } });
    const plain = await answer(() => asWorker(() => M.subscribeWorker({}, { tickerRef: f.ticker.id, workerRef: f.worker.id }, bound())));
    expect(plain.code).toBe('SUBSCRIBE_CADENCE_NEEDS_HOLDER');
    expect(await answer(() => asWorker(() => M.subscribeWorker({}, { tickerRef: f.ticker.id, workerRef: f.worker.id, instruction: live }, bound())))).toEqual({ code: 'RESOLVED' });
    expect((await managerActs())[0]!.payload).toMatchObject({ act: 'ticker.subscribe', workerId: f.worker.id });
  });

  it('a grant holder subscribes another worker on its grant, instruction or not, with no record', async () => {
    await M.grantApp({}, { appRef: f.app.id, workerRef: f.worker.id, name: 'TICKER_SUBSCRIBE_WORKERS' }, ctx());
    await demoteHolder();
    await noRecord(() => asWorker(() => M.subscribeWorker({}, { tickerRef: f.ticker.id, workerRef: f.idle.id }, bound())));
    await noRecord(() => asWorker(() => M.unsubscribeWorker({}, { tickerRef: f.ticker.id, workerRef: f.idle.id }, bound())));
  });

  it('a manager-held grant holder uses the grant, not the instruction, and writes no record', async () => {
    await M.grantApp({}, { appRef: f.app.id, workerRef: f.worker.id, name: 'TICKER_SUBSCRIBE_WORKERS' }, ctx());
    await noRecord(() => asWorker(() => M.subscribeWorker({}, { tickerRef: f.ticker.id, workerRef: f.idle.id, instruction: live }, bound())));
  });

  it('a worker changes its own wake settings, instruction or not, with no record', async () => {
    await noRecord(() => asWorker(() => M.setWorkerWakeSettings({}, { workerRef: f.worker.id, input: { mentions: 'OFF' }, instruction: live }, bound())));
    await noRecord(() => asWorker(() => M.setWorkerWakeSettings({}, { workerRef: f.worker.id, input: { mentions: 'IMMEDIATE' } }, bound())));
  });

  it('the worker a target reports to manages its worktrees, instruction or not, with no record', async () => {
    await db.worker.update({ where: { id: f.target.id }, data: { reportsToWorkerId: f.worker.id } });
    await demoteHolder();
    await noRecord(() => asWorker(() => doors['issueHostOperation worktree.create']!.call(undefined, bound())));
    await db.appMember.update({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } }, data: { role: 'owner' } });
    await noRecord(() => asWorker(() => doors['issueHostOperation worktree.remove']!.call(live, bound())));
  });

  it('a faster cadence on its own ticker needs the manager arm for a worker another person holds: one record for the edit', async () => {
    const t = await ownTicker();
    await M.subscribeWorker({}, { tickerRef: t.id, workerRef: f.target.id }, asBoss());
    const plain = await answer(() => asWorker(() => M.updateTicker({}, { ref: t.id, input: { cadenceSeconds: 900 } }, bound())));
    expect(plain.code).toBe('TICKER_CADENCE_NEEDS_CONSENT');
    expect(await answer(() => asWorker(() => M.updateTicker({}, { ref: t.id, input: { cadenceSeconds: 900 }, instruction: live }, bound())))).toEqual({ code: 'RESOLVED' });
    expect(await managerActs()).toHaveLength(1);
  });

  it('a person who holds the target isolates it as before, and writes no record', async () => {
    await noRecord(() => M.isolateWorker({}, { workerRef: f.target.id }, asBoss()));
  });

  // Ruling 0118 / Xanthos #72869: isolation is the one door where the target's holder's right also travels.
  it('isolation, holder arm: a worker whose holder holds the target, and does not manage, is admitted on an instruction, one record', async () => {
    await demoteHolder();
    await db.worker.update({ where: { id: f.target.id }, data: { heldByUserId: f.holder.id } });
    expect((await answer(() => asWorker(() => doors.isolateWorker!.call(undefined, bound())))).code).toBe('WORKER_ISOLATION_FORBIDDEN');
    expect(await answer(() => asWorker(() => doors.isolateWorker!.call(live, bound())))).toEqual({ code: 'RESOLVED' });
    const acts = await managerActs();
    expect(acts).toHaveLength(1);
    expect(acts[0]!.payload).toMatchObject({ act: 'worker.isolate', workerId: f.target.id, instruction: live });
    expect(await answer(() => asWorker(() => M.clearWorkerIsolation({}, { workerRef: f.target.id, instruction: live }, bound())))).toEqual({ code: 'RESOLVED' });
    expect((await managerActs())[1]!.payload).toMatchObject({ act: 'worker.isolation-clear' });
  });

  it('isolation: a worker refused both rights gets its holder\'s refusal, even for itself', async () => {
    await demoteHolder();
    await db.worker.update({ where: { id: f.worker.id }, data: { heldByUserId: f.holder.id } });
    const got = await answer(() => asWorker(() => doors.isolateWorker!.call(live, bound())));
    expect(got).toEqual(await answer(() => doors.isolateWorker!.call(undefined, ctx())));
    expect(await managerActs()).toHaveLength(0);
  });

  it('the other holder arms stay the person\'s: a held target gives a non-manager\'s worker nothing, instruction or not', async () => {
    await demoteHolder();
    await db.worker.update({ where: { id: f.target.id }, data: { heldByUserId: f.holder.id } });
    for (const door of ['setWorkerWakeSettings', 'issueHostOperation worktree.create', 'unsubscribeWorker']) {
      expect((await answer(() => asWorker(() => doors[door]!.call(live, bound())))).code).not.toBe('RESOLVED');
      expect((await answer(() => doors[door]!.call(undefined, ctx()))).code).toBe('RESOLVED'); // the person may
    }
    expect(await managerActs()).toHaveLength(0);
  });

  it('the stop-signal person path (H26 A): a worker with no instruction keeps its own refusal', async () => {
    const got = await answer(() => asWorker(() => doors.setTeamStopSignal!.call(undefined, bound())));
    expect(got.message).toContain("acts with the worker's own rights");
  });
});

describe('#3321 the wake read', () => {
  const read = (c: Context, instruction?: unknown) => Q.dueWakes({}, { appRef: f.app.id, instruction }, c);
  const shown = (page: any) => [...page.wakes.map((w: any) => w.worker.id), ...page.dormant.map((d: any) => d.worker.id)].sort();

  it('an instructed read shows the manager scope, and writes one record per call', async () => {
    // The target's stop notice: a worker this holder does not hold, so only the manager scope reaches it.
    const told = await asWorker<any>(() => Q.dueWakes({}, { appRef: f.app.id, accepts: ['STOP'], instruction: live }, bound()));
    expect(shown(told)).toContain(f.target.id);
    await asWorker(() => read(bound(), live));
    const acts = await managerActs();
    expect(acts).toHaveLength(2);
    expect(acts[0]).toMatchObject({ actorUserId: f.holder.id, actorWorkerId: f.worker.id });
    expect(acts[0]!.payload).toEqual({ act: 'wake.read', instruction: live });
  });

  it('a read that finds nothing is still a read: one record', async () => {
    await db.tickerSubscription.deleteMany({});
    await asWorker(() => Q.dueWakes({}, { appRef: f.app.id, workerRefs: [generateId()], instruction: live }, bound()));
    expect(await managerActs()).toHaveLength(1);
  });

  it('a read refused writes none, and a holder who does not manage never gets their personal scope through a worker', async () => {
    await demoteHolder();
    const got = await answer(() => asWorker(() => read(bound(), live)));
    expect(got.code).toBe('APP_NOT_FOUND');
    expect(await managerActs()).toHaveLength(0);
  });

  it('a person reads as before, with or without a claim, and writes none', async () => {
    await read(ctx()); await read(ctx(), live);
    expect(await managerActs()).toHaveLength(0);
  });

  it('a person\'s bad claim is refused: it never quietly narrows the read', async () => {
    expect((await answer(() => read(ctx(), badClaim))).code).toBe('APP_NOT_FOUND');
  });

  it('a worker on a run binding is refused, instruction or not', async () => {
    const run = bound({ clientId: `run:${generateId()}` });
    for (const claim of [live, undefined]) expect((await answer(() => asWorker(() => read(run, claim)))).code).toBe('APP_NOT_FOUND');
    expect(await managerActs()).toHaveLength(0);
  });

  it('an ending session is waited for, and the read is refused', async () => {
    let call!: Promise<unknown>;
    await db.$transaction(async (tx) => {
      await tx.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
      call = answer(() => asWorker(() => read(bound(), live)));
      await lockWaiterOn('sessions');
    }, { timeout: 15000 });
    expect(await call).toMatchObject({ code: 'APP_NOT_FOUND' });
    expect(await managerActs()).toHaveLength(0);
  });

  it('acknowledging stays the person\'s, whatever the read admitted (cor:agt:080:17)', async () => {
    const got = await answer(() => asWorker(() => M.acknowledgeWakes({}, { proofs: [] }, bound())));
    expect(got.code).toBe('WAKE_ACK_FORBIDDEN');
  });
});

/** Resolves once a backend really is blocked on this table's row lock, read outside the holding transaction. */
const lockWaiterOn = async (table: string) => {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const [row] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${`%FROM ${table} %FOR%`}`;
    if (row!.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no backend ever waited on ${table}`);
};

describe('#3321 the writes fence what the holder decision reads', () => {
  it('a hold released while a stop signal is judged is waited for, and the act is refused', async () => {
    let call!: Promise<unknown>;
    await db.$transaction(async (tx) => {
      await tx.worker.update({ where: { id: f.worker.id }, data: { heldByUserId: null, heldAt: null } });
      call = answer(() => asWorker(() => doors.setTeamStopSignal!.call(live, bound())));
      await lockWaiterOn('workers');
    }, { timeout: 15000 });
    expect(await call).toMatchObject({ code: 'APP_MANAGER_REQUIRED' });
    expect(await managerActs()).toHaveLength(0);
  });

  it('a session ending while a settings write is judged is waited for, and the act is refused', async () => {
    let call!: Promise<unknown>;
    await db.$transaction(async (tx) => {
      await tx.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
      call = answer(() => asWorker(() => doors['setTeamPause on']!.call(live, bound())));
      await lockWaiterOn('sessions');
    }, { timeout: 15000 });
    expect(await call).toMatchObject({ code: 'FORBIDDEN' });
    expect(await managerActs()).toHaveLength(0);
  });
});

describe('#3321 refusal before oracle (acceptance 8)', () => {
  const missing = () => generateId();
  const scrub = (a: any, ...ids: string[]) => JSON.parse(ids.reduce((s, id) => s.replaceAll(id, '<ref>'), JSON.stringify(a)));
  const refused = async (fn: () => Promise<unknown>) => { await demoteHolder(); return answer(() => asWorker(fn)); };
  const cases: Record<string, (ref: () => string) => (instruction: unknown) => Promise<unknown>> = {
    updateTicker: (ref) => (i) => M.updateTicker({}, { ref: ref(), input: { name: 'X' }, instruction: i }, bound()),
    deleteTicker: (ref) => (i) => M.deleteTicker({}, { ref: ref(), instruction: i }, bound()),
  };
  for (const [name, door] of Object.entries(cases)) {
    it(`${name}: a ticker in another App and a missing ticker answer alike, whatever the instruction`, async () => {
      for (const claim of [live, badClaim, undefined]) {
        const id = missing();
        const foreign = await refused(() => door(() => f.foreignTicker.id)(claim));
        const none = await refused(() => door(() => id)(claim));
        expect(scrub(foreign, f.foreignTicker.id)).toEqual(scrub(none, id));
      }
    });
  }
  const workerCases: Record<string, (ref: string, i: unknown) => Promise<unknown>> = {
    isolateWorker: (ref, i) => M.isolateWorker({}, { workerRef: ref, instruction: i }, bound()),
    clearWorkerIsolation: (ref, i) => M.clearWorkerIsolation({}, { workerRef: ref, instruction: i }, bound()),
    setWorkerWakeSettings: (ref, i) => M.setWorkerWakeSettings({}, { workerRef: ref, input: { mentions: 'OFF' }, instruction: i }, bound()),
    applyAgentTickerTemplates: (ref, i) => M.applyAgentTickerTemplates({}, { workerRef: ref, instruction: i }, bound()),
    setTeamStopSignal: (ref, i) => M.setTeamStopSignal({}, { input: { appRef: f.app.id, level: 'PAUSE', scope: 'WORKER', worker: ref }, instruction: i }, bound()),
    subscribeWorker: (ref, i) => M.subscribeWorker({}, { tickerRef: f.ticker.id, workerRef: ref, instruction: i }, bound()),
    issueHostOperation: (ref, i) => issue('worktree.create', ref, { repo: 'hadron-server', baseBranch: 'main', branchName: 'x/1-x', label: 'x-1' }, i, bound()),
  };
  for (const [name, call] of Object.entries(workerCases)) {
    it(`${name}: a worker in another App and a missing worker answer alike, whatever the instruction`, async () => {
      for (const claim of [live, badClaim, undefined]) {
        const id = missing();
        const foreign = await refused(() => call(f.foreign.id, claim));
        const none = await refused(() => call(id, claim));
        expect(scrub(foreign, f.foreign.id)).toEqual(scrub(none, id));
      }
    });
  }
  it('liftTeamStopSignal: a signal in another App and a missing one answer alike', async () => {
    const foreign = await db.teamStopSignal.create({ data: { id: generateId(), appId: f.otherApp.id, level: 'pause', scope: 'worker', targetWorkerId: f.foreign.id, setByUserId: f.boss.id, setAt: new Date() } });
    const a = await refused(() => M.liftTeamStopSignal({}, { appRef: f.app.id, id: foreign.id, instruction: live }, bound()));
    const b = await refused(() => M.liftTeamStopSignal({}, { appRef: f.app.id, id: generateId(), instruction: live }, bound()));
    expect(a).toEqual(b);
  });
  // Bruno, LOCAL #3398: a worker sees only the signals covering it (090:07), so another worker's signal in the SAME App
  // is concealed from it. The manager arm is judged before the signal is looked up, or the refusal says the signal exists.
  it('liftTeamStopSignal: a same-App signal the worker cannot read and a missing one answer alike, whatever the instruction', async () => {
    const lift = (id: string, claim: unknown) => () => M.liftTeamStopSignal({}, { appRef: f.app.id, id, instruction: claim }, bound());
    await demoteHolder();
    const list = await asWorker(() => Q.teamStopSignals({}, { appRef: f.app.id }, bound())) as { signals: { id: string }[] };
    expect(list.signals.map((s) => s.id)).not.toContain(f.signal.id);
    const before = await snapshot();
    for (const claim of [live, badClaim, undefined]) {
      const concealed = await answer(() => asWorker(lift(f.signal.id, claim)));
      const none = await answer(() => asWorker(lift(generateId(), claim)));
      expect(concealed.code).toBe('APP_MANAGER_REQUIRED');
      expect(concealed).toEqual(none);
    }
    expect(await snapshot()).toEqual(before);
  });
  it('liftTeamStopSignal: a worker held by a manager is told a missing signal is missing', async () => {
    expect((await answer(() => asWorker(() => M.liftTeamStopSignal({}, { appRef: f.app.id, id: generateId(), instruction: live }, bound())))).code).toBe('STOP_SIGNAL_NOT_FOUND');
    expect(await managerActs()).toEqual([]);
  });
  it('liftTeamStopSignal: a person in the App keeps their order, since they read every signal (090:07)', async () => {
    await demoteHolder();
    expect((await answer(() => M.liftTeamStopSignal({}, { appRef: f.app.id, id: generateId() }, ctx()))).code).toBe('STOP_SIGNAL_NOT_FOUND');
    expect((await answer(() => M.liftTeamStopSignal({}, { appRef: f.app.id, id: f.signal.id }, ctx()))).code).toBe('APP_MANAGER_REQUIRED');
  });
});

describe('#3321 callers not wired here keep refusing a worker (acceptance 10, ask 2)', () => {
  it('canManageIsolation stays false for a worker session: a read carries no instruction', async () => {
    const F = (resolvers as any).WorkerWakeSettings;
    expect(await asWorker(() => F.canManageIsolation({ workerId: f.target.id }, {}, bound()))).toBe(false);
    expect(await F.canManageIsolation({ workerId: f.target.id }, {}, ctx())).toBe(true);
    // The target's holder as well: the read never takes the holder arm for a worker.
    await db.worker.update({ where: { id: f.target.id }, data: { heldByUserId: f.holder.id } });
    expect(await asWorker(() => F.canManageIsolation({ workerId: f.target.id }, {}, bound()))).toBe(false);
  });

  it('with isolation off, a worker with no instruction is still refused first (the SDL\'s order)', async () => {
    setS7AvailableForTest(false);
    expect((await answer(() => asWorker(() => doors.isolateWorker!.call(undefined, bound())))).code).toBe('WORKER_ISOLATION_FORBIDDEN');
    expect((await answer(() => asWorker(() => doors.isolateWorker!.call(live, bound())))).code).toBe('WORKER_ISOLATION_UNAVAILABLE');
  });

  it('grantApp and grantAppKeyScope answer a worker held by an App manager as on main, instruction or not', async () => {
    const before = await snapshot();
    const grant = await answer(() => asWorker(() => M.grantApp({}, { appRef: f.app.id, workerRef: f.idle.id, name: 'TICKER_SUBSCRIBE_WORKERS', instruction: live }, bound())));
    expect(grant.code).toBe('APP_GRANT_FORBIDDEN');
    const scope = await answer(() => asWorker(() => M.grantAppKeyScope({}, { id: f.key.id, scope: 'attention:deliver', instruction: live }, bound())));
    expect(scope.code).toBeDefined();
    expect(scope.code).not.toBe('RESOLVED');
    expect(await snapshot()).toEqual(before);
    expect(await managerActs()).toHaveLength(0);
  });

  it('createTicker has no manager arm: a worker makes its own ticker and no instruction is taken', async () => {
    const t = await asWorker<any>(() => M.createTicker({}, { appRef: f.app.id, input: { name: 'Own', cadenceSeconds: 7200 }, instruction: live }, bound()));
    expect(t.ownerWorkerId).toBe(f.worker.id);
    expect(await managerActs()).toHaveLength(0);
  });
});
