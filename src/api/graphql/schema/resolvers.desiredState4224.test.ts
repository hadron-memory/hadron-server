/**
 * #4224 (S3 of #4229) — the Agent lifecycle, the per-worker desired state, the leave-alone marker and the App's
 * sweep mode.
 *
 * Cast: org admin (manages the App), member (a participant who holds the workers, not a manager), outsider. Ada is
 * cast from a LONG_LIVED Agent; Kit and Zoe from a SHORT_LIVED one. orca1 registers Ada and Kit, orca2 registers Zoe.
 * Unless a test says otherwise the App's sweep mode is OBSERVE (the default OFF masks every row as SWEEP_OFF).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from './typeDefs.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { declareAllStopLanes } from '../../../test/stopLanes.js';
import { decideDesiredState, type DesiredStateFacts } from '../../../lib/desiredState/desiredState.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
// #4242 blind P2-2: a pass-through that records the isolation level of the transaction the stop-signal fact is read on.
const isolationSeen: string[] = [];
vi.mock('../../../lib/stopSignals/state.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../lib/stopSignals/state.js')>();
  return {
    ...orig,
    coveringSignals: async (...args: Parameters<typeof orig.coveringSignals>) => {
      const [{ level }] = await (args[0] as any).$queryRaw`SELECT current_setting('transaction_isolation') AS level`;
      isolationSeen.push(level);
      return orig.coveringSignals(...args);
    },
  };
});

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const F = resolvers as any;

let org: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };
let outsider: { id: string };
let longAgentId: string;
let shortAgentId: string;
let app: { id: string; urn: string };
let ada: { id: string };
let kit: { id: string };
let zoe: { id: string };
let orca1: { id: string };
let orca2: { id: string };
let plainKey: { id: string };
let revokedScopeKey: { id: string };

const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra }) as Context;
const keyCtx = (k: { id: string }): Context => ({ db, appId: app.id, appKeyId: k.id, roles: [] }) as Context;

async function refusal(p: Promise<unknown>): Promise<{ message: string; extensions: Record<string, unknown> }> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    return { message: (e as GraphQLError).message, extensions: (e as GraphQLError).extensions as Record<string, unknown> };
  }
  throw new Error('expected a refusal');
}
const code = async (p: Promise<unknown>) => (await refusal(p)).extensions.code;

type Row = {
  workerId: string; name: string; lifecycle: string; desired: string | null; reason: string;
  wouldBe: string | null; wouldBeReason: string | null; openSessionId: string | null; family: string; worktrees: string[];
};
const state = (c: Context = ctx(admin.id), hostId = 'orca1') => Q.hostDesiredState({}, { appRef: app.id, hostId }, c) as Promise<{ hostId: string; sweepMode: string; workers: Row[] }>;
const rowOf = async (w: { id: string }, hostId = 'orca1', c: Context = ctx(admin.id)): Promise<Row> => {
  const r = (await state(c, hostId)).workers.find((x) => x.workerId === w.id);
  if (!r) throw new Error('worker not in the answer');
  return r;
};
const verdict = async (w: { id: string }, hostId = 'orca1') => {
  const r = await rowOf(w, hostId);
  return [r.desired, r.reason];
};

const sweep = (mode: string, c: Context = ctx(admin.id)) => M.setAppSweepMode({}, { appRef: app.id, mode }, c);
const leaveAlone = (w: { id: string }, on: boolean, c: Context = ctx(admin.id), reason?: string) =>
  M.setWorkerLeaveAlone({}, { input: { worker: w.id, leaveAlone: on, ...(reason !== undefined ? { reason } : {}) } }, c);
const task = (assignee: { id: string }, status: 'pending' | 'started' | 'finished' | 'cancelled' = 'pending', parentTaskId?: string) =>
  db.agentTask.create({
    data: {
      appId: app.id, title: 'A task', ownerUserId: admin.id, assigneeWorkerId: assignee.id, status, assignedAt: new Date(),
      ...(status !== 'pending' ? { startedAt: new Date() } : {}),
      ...(status === 'finished' ? { finishedAt: new Date(), resultOutcome: 'succeeded' } : {}),
      ...(status === 'cancelled' ? { cancelledAt: new Date() } : {}),
      ...(parentTaskId ? { parentTaskId } : {}),
    },
    select: { id: true },
  });
const stop = (level: 'HALT' | 'PAUSE' | 'PAUSE_DISPATCH', w: { id: string }) =>
  M.setTeamStopSignal({}, { input: { appRef: app.id, level, scope: 'WORKER', worker: w.id } }, ctx(admin.id));
const events = (type: string) => db.agentTeamEvent.findMany({ where: { appId: app.id, type }, orderBy: { createdAt: 'asc' } });

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { id: generateId(), name: 'ds', urn: `ds4224-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { id: generateId(), githubId: 42_240_000 + k * 1000 + (n % 1000), githubUsername: `ds-${name}-${n}`, handle: `ds-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  admin = await u(1, 'admin');
  member = await u(2, 'member');
  outsider = await u(3, 'outsider');
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  longAgentId = (await M.createAgent({}, { orgId: org.id, name: 'Coordinator' }, ctx(admin.id))).id;
  shortAgentId = (await M.createAgent({}, { orgId: org.id, name: 'Builder', lifecycle: 'SHORT_LIVED' }, ctx(admin.id))).id;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, urn: true } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  const w = (agentId: string, name: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name, slug: name.toLowerCase(), heldByUserId: member.id, heldAt: new Date() }, select: { id: true } });
  ada = await w(longAgentId, 'Ada');
  kit = await w(shortAgentId, 'Kit');
  zoe = await w(shortAgentId, 'Zoe');
  const mkKey = (label: string) =>
    db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd', label }, select: { id: true } });
  orca1 = await mkKey('orca1');
  orca2 = await mkKey('orca2');
  plainKey = await mkKey('plain');
  revokedScopeKey = await mkKey('revoked-scope');
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(admin.id));
  await M.grantAppKeyScope({}, { id: orca2.id, scope: 'host:operate', hostId: 'orca2' }, ctx(admin.id));
  await M.grantAppKeyScope({}, { id: revokedScopeKey.id, scope: 'host:operate', hostId: 'orca1' }, ctx(admin.id));
  await M.revokeAppKeyScope({}, { id: revokedScopeKey.id, scope: 'host:operate' }, ctx(admin.id));
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 1', pollIntervalSeconds: 600, workers: [
    { worker: ada.id, family: 'claude', worktrees: ['hadron-server/ada'] },
    { worker: kit.id, family: 'codex', worktrees: ['hadron-server/kit', 'hadron-cli/kit'] },
  ] } }, keyCtx(orca1));
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 2', pollIntervalSeconds: 600, workers: [{ worker: zoe.id, family: 'claude' }] } }, keyCtx(orca2));
  await declareAllStopLanes(db, app.id);
  await sweep('OBSERVE');
});

describe('#4224 Agent.lifecycle', () => {
  it('defaults to LONG_LIVED, is set at create, and is written by whoever manages the Agent', async () => {
    const read = async (id: string) => (await db.agent.findUniqueOrThrow({ where: { id } })).lifecycle;
    expect(await read(longAgentId)).toBe('LONG_LIVED');
    expect(await read(shortAgentId)).toBe('SHORT_LIVED');
    const updated = await M.updateAgent({}, { ref: longAgentId, lifecycle: 'SHORT_LIVED' }, ctx(admin.id));
    expect(updated.lifecycle).toBe('SHORT_LIVED');
    // Null and omitted change nothing (the usesTasks rule).
    await M.updateAgent({}, { ref: longAgentId, lifecycle: null }, ctx(admin.id));
    await M.updateAgent({}, { ref: longAgentId, description: 'x' }, ctx(admin.id));
    expect(await read(longAgentId)).toBe('SHORT_LIVED');
    // The same write gate as usesTasks: a participant who does not manage the Agent changes nothing.
    await expect(M.updateAgent({}, { ref: longAgentId, lifecycle: 'LONG_LIVED' }, ctx(member.id))).rejects.toBeInstanceOf(Error);
    expect(await read(longAgentId)).toBe('SHORT_LIVED');
  });
});

describe('#4224 hostDesiredState — long-lived', () => {
  it('Ada with nothing special is RUNNING, LONG_LIVED, with her setup fields', async () => {
    const r = await rowOf(ada);
    expect(r).toEqual({
      workerId: ada.id, name: 'Ada', lifecycle: 'LONG_LIVED', desired: 'RUNNING', reason: 'LONG_LIVED',
      wouldBe: null, wouldBeReason: null, openSessionId: null, family: 'claude', worktrees: ['hadron-server/ada'],
    });
    const s = await state();
    expect(s.hostId).toBe('orca1');
    expect(s.sweepMode).toBe('OBSERVE');
  });

  it('a long-lived worker with no task still runs; a task changes nothing', async () => {
    await task(ada, 'started');
    expect(await verdict(ada)).toEqual(['RUNNING', 'LONG_LIVED']);
  });

  it('halted: STOPPED, HALTED; lifted: RUNNING again', async () => {
    const sig = await stop('HALT', ada);
    expect(await verdict(ada)).toEqual(['STOPPED', 'HALTED']);
    await M.liftTeamStopSignal({}, { appRef: app.id, id: sig.id }, ctx(admin.id));
    expect(await verdict(ada)).toEqual(['RUNNING', 'LONG_LIVED']);
  });

  it('paused by a stop signal: STOPPED, PAUSED; pause-dispatch stops assignment only, so the worker still runs', async () => {
    await stop('PAUSE_DISPATCH', ada);
    expect(await verdict(ada)).toEqual(['RUNNING', 'LONG_LIVED']);
    await stop('PAUSE', ada);
    expect(await verdict(ada)).toEqual(['STOPPED', 'PAUSED']);
    // Every live signal applies: the strongest names the reason.
    await stop('HALT', ada);
    expect(await verdict(ada)).toEqual(['STOPPED', 'HALTED']);
  });

  it('team paused: STOPPED, TEAM_PAUSED, for every worker', async () => {
    await M.setTeamPause({}, { appRef: app.id, paused: true }, ctx(admin.id));
    expect(await verdict(ada)).toEqual(['STOPPED', 'TEAM_PAUSED']);
    expect(await verdict(kit)).toEqual(['STOPPED', 'TEAM_PAUSED']);
    await M.setTeamPause({}, { appRef: app.id, paused: false }, ctx(admin.id));
    expect(await verdict(ada)).toEqual(['RUNNING', 'LONG_LIVED']);
  });

  it('retired: STOPPED, RETIRED, ahead of every other override', async () => {
    await stop('HALT', ada);
    await db.worker.update({ where: { id: ada.id }, data: { retiredAt: new Date() } });
    expect(await verdict(ada)).toEqual(['STOPPED', 'RETIRED']);
  });

  it('resetting: STOPPED, RESETTING while the mark is in effect, and not after it lapsed', async () => {
    const mark = (until: Date | null) => db.workerAvailability.upsert({
      where: { workerId: ada.id },
      create: { workerId: ada.id, state: 'unavailable', reason: 'resetting', setAt: new Date(), setBy: 'context-reset', contextResetId: generateId(), until },
      update: { until },
    });
    await mark(null);
    expect(await verdict(ada)).toEqual(['STOPPED', 'RESETTING']);
    await mark(new Date(Date.now() - 1000));
    expect(await verdict(ada)).toEqual(['RUNNING', 'LONG_LIVED']);
    // Another reason is not a reset: an out-of-tokens worker is still wanted running.
    await db.workerAvailability.update({ where: { workerId: ada.id }, data: { reason: 'other', setBy: 'app-manager', contextResetId: null, until: null } });
    expect(await verdict(ada)).toEqual(['RUNNING', 'LONG_LIVED']);
  });
});

describe('#4224 hostDesiredState — short-lived', () => {
  it('Kit with no task: STOPPED, NO_OPEN_TASK; a finished or cancelled task, or another worker\'s, is not his', async () => {
    expect(await verdict(kit)).toEqual(['STOPPED', 'NO_OPEN_TASK']);
    await task(kit, 'finished');
    await task(kit, 'cancelled');
    await task(ada, 'started');
    expect(await verdict(kit)).toEqual(['STOPPED', 'NO_OPEN_TASK']);
  });

  it('assigned a task: RUNNING, HOLDS_TASK, pending or started', async () => {
    const t = await task(kit, 'pending');
    expect(await verdict(kit)).toEqual(['RUNNING', 'HOLDS_TASK']);
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'started', startedAt: new Date() } });
    expect(await verdict(kit)).toEqual(['RUNNING', 'HOLDS_TASK']);
  });

  it('a started task waiting on an open child: STOPPED, WAITING_ON_CHILDREN; the child ending makes it RUNNING again', async () => {
    const parent = await task(kit, 'started');
    const child = await task(zoe, 'pending', parent.id);
    expect(await verdict(kit)).toEqual(['STOPPED', 'WAITING_ON_CHILDREN']);
    // The child's assignee holds a task of her own.
    expect(await verdict(zoe, 'orca2')).toEqual(['RUNNING', 'HOLDS_TASK']);
    await db.agentTask.update({ where: { id: child.id }, data: { status: 'finished', startedAt: new Date(), finishedAt: new Date(), resultOutcome: 'succeeded' } });
    expect(await verdict(kit)).toEqual(['RUNNING', 'HOLDS_TASK']);
  });

  it('one task waiting and another not: RUNNING, HOLDS_TASK', async () => {
    const parent = await task(kit, 'started');
    await task(zoe, 'started', parent.id);
    expect(await verdict(kit)).toEqual(['STOPPED', 'WAITING_ON_CHILDREN']);
    await task(kit, 'pending');
    expect(await verdict(kit)).toEqual(['RUNNING', 'HOLDS_TASK']);
  });

  it('an override wins over a held task', async () => {
    await task(kit, 'started');
    await stop('HALT', kit);
    expect(await verdict(kit)).toEqual(['STOPPED', 'HALTED']);
  });
});

describe('#4224 open session and setup fields', () => {
  it('reports the open session id, and none once it ended', async () => {
    const s = await db.session.create({
      data: { id: generateId(), appId: app.id, workerId: kit.id, agentId: shortAgentId, userId: member.id, startedAt: new Date(), updatedAt: new Date() },
      select: { id: true },
    });
    const r = await rowOf(kit);
    expect(r.openSessionId).toBe(s.id);
    expect(r.family).toBe('codex');
    expect(r.worktrees).toEqual(['hadron-server/kit', 'hadron-cli/kit']);
    await db.session.update({ where: { id: s.id }, data: { endedAt: new Date() } });
    expect((await rowOf(kit)).openSessionId).toBeNull();
  });

  it('lists exactly the workers the host registers, by name', async () => {
    expect((await state()).workers.map((r) => r.name)).toEqual(['Ada', 'Kit']);
    expect((await state(ctx(admin.id), 'orca2')).workers.map((r) => r.name)).toEqual(['Zoe']);
  });
});

describe('#4224 leave-alone', () => {
  it('a marked worker reads LEAVE_ALONE with what it would be, and nothing desired', async () => {
    await task(kit, 'pending');
    const out = await leaveAlone(kit, true, ctx(admin.id), 'old team, not migrated');
    expect(out).toMatchObject({ workerId: kit.id, leaveAlone: true, reason: 'old team, not migrated', by: admin.id });
    expect(out.at).toBeInstanceOf(Date);
    const r = await rowOf(kit);
    expect([r.desired, r.reason, r.wouldBe, r.wouldBeReason]).toEqual([null, 'LEAVE_ALONE', 'RUNNING', 'HOLDS_TASK']);
    // Leave-alone wins over every override for acting, and still says what the state would be.
    await stop('HALT', kit);
    const halted = await rowOf(kit);
    expect([halted.desired, halted.reason, halted.wouldBe, halted.wouldBeReason]).toEqual([null, 'LEAVE_ALONE', 'STOPPED', 'HALTED']);
    // Unmarked workers are untouched.
    expect(await verdict(ada)).toEqual(['RUNNING', 'LONG_LIVED']);
  });

  it('each change is one worker.leave-alone-changed event; a repeat changes and records nothing', async () => {
    await leaveAlone(kit, true, ctx(admin.id), 'why');
    await leaveAlone(kit, true, ctx(admin.id), 'why');
    // A new reason on a marked worker replaces the reason; the marker did not change, so no event.
    expect((await leaveAlone(kit, true, ctx(admin.id), 'a better reason')).reason).toBe('a better reason');
    let ev = await events('worker.leave-alone-changed');
    expect(ev.map((e) => [e.subjectWorkerId, e.actorUserId, e.payload])).toEqual([[kit.id, admin.id, { leaveAlone: true }]]);
    const cleared = await leaveAlone(kit, false);
    expect(cleared).toMatchObject({ workerId: kit.id, leaveAlone: false, reason: null, by: null, at: null });
    await leaveAlone(kit, false);
    ev = await events('worker.leave-alone-changed');
    expect(ev.map((e) => e.payload)).toEqual([{ leaveAlone: true }, { leaveAlone: false }]);
    expect(await db.worker.findUniqueOrThrow({ where: { id: kit.id }, select: { leaveAlone: true, leaveAloneReason: true, leaveAloneBy: true, leaveAloneAt: true } }))
      .toEqual({ leaveAlone: false, leaveAloneReason: null, leaveAloneBy: null, leaveAloneAt: null });
    expect(await verdict(kit)).toEqual(['STOPPED', 'NO_OPEN_TASK']);
  });

  it('a participant who does not manage the App cannot set or clear it', async () => {
    expect(await code(leaveAlone(kit, true, ctx(member.id)))).toBe('WORKER_LEAVE_ALONE_NOT_PERMITTED');
    expect((await db.worker.findUniqueOrThrow({ where: { id: kit.id } })).leaveAlone).toBe(false);
    await leaveAlone(kit, true);
    expect(await code(leaveAlone(kit, false, ctx(member.id)))).toBe('WORKER_LEAVE_ALONE_NOT_PERMITTED');
    expect((await db.worker.findUniqueOrThrow({ where: { id: kit.id } })).leaveAlone).toBe(true);
    expect(await events('worker.leave-alone-changed')).toHaveLength(1);
  });

  it('a worker session cannot set it without an instruction, even its manager\'s own worker', async () => {
    const asKit = <T>(fn: () => Promise<T>) => runAsActor({ workerId: kit.id, agentId: shortAgentId }, fn);
    await db.worker.update({ where: { id: kit.id }, data: { heldByUserId: admin.id } });
    expect(await code(asKit(() => leaveAlone(ada, true, ctx(admin.id))))).toBe('WORKER_LEAVE_ALONE_NOT_PERMITTED');
    expect((await db.worker.findUniqueOrThrow({ where: { id: ada.id } })).leaveAlone).toBe(false);
  });

  it('an outsider gets the worker-not-found answer, and an impersonated manager is refused', async () => {
    expect(await code(leaveAlone(kit, true, ctx(outsider.id)))).toBe('WORKER_NOT_FOUND');
    const imp = ctx(admin.id, { impersonation: { sessionId: generateId(), actorUserId: outsider.id, orgId: org.id, expiresAt: new Date(Date.now() + 60_000) } } as unknown as Partial<Context>);
    await expect(leaveAlone(kit, true, imp)).rejects.toBeInstanceOf(GraphQLError);
    expect((await db.worker.findUniqueOrThrow({ where: { id: kit.id } })).leaveAlone).toBe(false);
  });

  it('refuses a reason on a clear, a blank-only reason is no reason, and a retired worker is refused', async () => {
    expect(await code(leaveAlone(kit, false, ctx(admin.id), 'x'))).toBe('BAD_USER_INPUT');
    expect(await code(leaveAlone(kit, true, ctx(admin.id), 'x'.repeat(501)))).toBe('BAD_USER_INPUT');
    expect((await leaveAlone(kit, true, ctx(admin.id), '   ')).reason).toBeNull();
    await db.worker.update({ where: { id: zoe.id }, data: { retiredAt: new Date() } });
    expect(await code(leaveAlone(zoe, true))).toBe('WORKER_RETIRED');
  });

  it('Worker.leaveAlone and its fields read for whoever may see the worker\'s internals', async () => {
    await leaveAlone(kit, true, ctx(admin.id), 'why');
    const row = await db.worker.findUniqueOrThrow({ where: { id: kit.id } });
    expect(row.leaveAlone).toBe(true);
    expect(await F.Worker.leaveAloneReason(row, {}, ctx(admin.id))).toBe('why');
    expect(await F.Worker.leaveAloneBy(row, {}, ctx(admin.id))).toBe(admin.id);
    expect(await F.Worker.leaveAloneAt(row, {}, ctx(admin.id))).toBeInstanceOf(Date);
    expect(await F.Worker.leaveAloneReason(row, {}, ctx(outsider.id))).toBeNull();
    expect(await F.Worker.leaveAloneBy(row, {}, ctx(outsider.id))).toBeNull();
    // #4242 blind P3 / local F1: the marker itself and when it was set are working state too.
    expect(await F.Worker.leaveAloneAt(row, {}, ctx(outsider.id))).toBeNull();
    expect(await F.Worker.leaveAlone(row, {}, ctx(admin.id))).toBe(true);
    expect(await F.Worker.leaveAlone(row, {}, ctx(member.id))).toBe(true);
    expect(await F.Worker.leaveAlone(row, {}, ctx(outsider.id))).toBeNull();
  });
});

describe('#4242 local F1: the marker over GraphQL', () => {
  it('a participant reads the marker and its fields; an outsider reading the worker sees none of them', async () => {
    await leaveAlone(kit, true, ctx(admin.id), 'why');
    const api = new ApolloServer<Context>({ typeDefs, resolvers });
    await api.start();
    try {
      const q = 'query($ref: ID!) { worker(ref: $ref) { name leaveAlone leaveAloneReason leaveAloneBy leaveAloneAt } }';
      const read = async (c: Context) => {
        const r = await api.executeOperation({ query: q, variables: { ref: kit.id } }, { contextValue: c });
        if (r.body.kind !== 'single') throw new Error('unexpected incremental response');
        return r.body.singleResult;
      };
      const mine = await read(ctx(member.id));
      expect(mine.errors).toBeUndefined();
      expect(mine.data?.worker).toMatchObject({ name: 'Kit', leaveAlone: true, leaveAloneReason: 'why', leaveAloneBy: admin.id });
      expect((mine.data?.worker as any).leaveAloneAt).not.toBeNull();
      const theirs = await read(ctx(outsider.id));
      expect(theirs.errors).toBeUndefined();
      expect(theirs.data?.worker).toEqual({ name: 'Kit', leaveAlone: null, leaveAloneReason: null, leaveAloneBy: null, leaveAloneAt: null });
    } finally {
      await api.stop();
    }
  });
});

describe('#4224 sweep mode', () => {
  it('defaults to OFF; with OFF every row says SWEEP_OFF, nothing is desired, and what it would be is still read', async () => {
    const fresh = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Fresh', urn: `${org.urn}:fresh` }, select: { sweepMode: true } });
    expect(fresh.sweepMode).toBe('OFF');
    await sweep('OFF');
    await task(kit, 'pending');
    await leaveAlone(ada, true);
    const s = await state();
    expect(s.sweepMode).toBe('OFF');
    expect(s.workers.map((r) => [r.name, r.desired, r.reason, r.wouldBe, r.wouldBeReason])).toEqual([
      ['Ada', null, 'SWEEP_OFF', 'RUNNING', 'LONG_LIVED'],
      ['Kit', null, 'SWEEP_OFF', 'RUNNING', 'HOLDS_TASK'],
    ]);
  });

  it('is set by whoever manages the App, recorded once per change, and read on the App', async () => {
    const setup = new Set((await events('team.sweep-mode-changed')).map((e) => e.id));
    expect((await sweep('APPLY')).sweepMode).toBe('APPLY');
    expect((await sweep('APPLY')).sweepMode).toBe('APPLY');
    expect((await db.app.findUniqueOrThrow({ where: { id: app.id } })).sweepMode).toBe('APPLY');
    expect((await state()).sweepMode).toBe('APPLY');
    // Only this test's own changes (the setup's mode change is excluded by id): one change, not two.
    const ev = (await events('team.sweep-mode-changed')).filter((e) => !setup.has(e.id));
    expect(ev.map((e) => [e.actorUserId, e.payload])).toEqual([[admin.id, { from: 'OBSERVE', to: 'APPLY' }]]);
  });

  it('a participant who does not manage the App, a key and an outsider cannot set it', async () => {
    expect(await code(sweep('APPLY', ctx(member.id)))).toBe('FORBIDDEN');
    await expect(sweep('APPLY', ctx(outsider.id))).rejects.toBeInstanceOf(GraphQLError);
    await expect(sweep('APPLY', keyCtx(orca1))).rejects.toBeInstanceOf(GraphQLError);
    await expect(sweep('APPLY', keyCtx(plainKey))).rejects.toBeInstanceOf(GraphQLError);
    expect((await db.app.findUniqueOrThrow({ where: { id: app.id } })).sweepMode).toBe('OBSERVE');
    expect(await code(sweep('SOMETIMES'))).toBe('BAD_USER_INPUT');
  });
});

describe('#4224 who reads a host\'s desired state', () => {
  it('a participant and a non-host App key read any host of the App', async () => {
    for (const c of [ctx(admin.id), ctx(member.id), keyCtx(plainKey)]) {
      expect((await state(c, 'orca1')).workers.map((r) => r.name)).toEqual(['Ada', 'Kit']);
      expect((await state(c, 'orca2')).workers.map((r) => r.name)).toEqual(['Zoe']);
    }
  });

  it('orca1\'s key reads orca1\'s rows only; another host answers exactly as a host that does not exist', async () => {
    expect((await state(keyCtx(orca1), 'orca1')).workers.map((r) => r.name)).toEqual(['Ada', 'Kit']);
    const other = await refusal(state(keyCtx(orca1), 'orca2'));
    const missing = await refusal(state(keyCtx(orca1), 'orca9'));
    expect(other.extensions.code).toBe('HOST_NOT_FOUND');
    expect({ ...other, extensions: { ...other.extensions, hostId: 'x' } }).toEqual({ ...missing, extensions: { ...missing.extensions, hostId: 'x' } });
    // The same answer a participant gets for a host that does not exist.
    const forPerson = await refusal(state(ctx(admin.id), 'orca9'));
    expect(forPerson).toEqual(missing);
    expect((await state(keyCtx(orca2), 'orca2')).workers.map((r) => r.name)).toEqual(['Zoe']);
    expect(await code(state(keyCtx(orca2), 'orca1'))).toBe('HOST_NOT_FOUND');
  });

  it('a key whose host:operate scope was revoked reads no host, its former one included', async () => {
    expect(await code(state(keyCtx(revokedScopeKey), 'orca1'))).toBe('HOST_NOT_FOUND');
    expect(await code(state(keyCtx(revokedScopeKey), 'orca2'))).toBe('HOST_NOT_FOUND');
  });

  it('an outsider and another App\'s key get the App-not-found answer', async () => {
    const mine = await refusal(state(ctx(outsider.id)));
    const registrations = await refusal(Q.hostRegistrations({}, { appRef: app.id }, ctx(outsider.id)));
    expect(mine).toEqual(registrations);
    const otherApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` }, select: { id: true } });
    const foreign = await db.appKey.create({ data: { id: generateId(), appId: otherApp.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd' }, select: { id: true } });
    expect(await code(state({ db, appId: otherApp.id, appKeyId: foreign.id, roles: [] } as Context))).toBe('APP_NOT_FOUND');
  });

  it('a host key\'s read is recorded as a use', async () => {
    const before = await db.hostKeyUse.count({ where: { appKeyId: orca1.id, action: 'read' } });
    await state(keyCtx(orca1), 'orca1');
    await refusal(state(keyCtx(orca1), 'orca2'));
    const uses = await db.hostKeyUse.findMany({ where: { appKeyId: orca1.id, action: 'read' }, orderBy: { usedAt: 'asc' } });
    expect(uses.length - before).toBe(2);
    expect(uses.slice(-2).map((x) => [x.hostId, x.count, x.refusedCode])).toEqual([['orca1', 2, null], ['orca1', null, 'HOST_NOT_FOUND']]);
  });
});

describe('#4242 blind P2-2: one snapshot per read', () => {
  it('a participant\'s and a host key\'s read compose their facts inside one repeatable-read transaction', async () => {
    isolationSeen.length = 0;
    await state(ctx(admin.id));
    await state(keyCtx(orca1));
    await state(keyCtx(plainKey), 'orca2');
    expect(isolationSeen).toEqual(['repeatable read', 'repeatable read', 'repeatable read']);
  });
});

describe('#4224 the decision table (pure)', () => {
  const base: DesiredStateFacts = {
    sweepMode: 'APPLY', leaveAlone: false, retired: false, stopLevel: null, teamPaused: false, resetting: false,
    lifecycle: 'LONG_LIVED', openTasks: 0, runnableTasks: 0,
  };
  const d = (f: Partial<DesiredStateFacts>) => {
    const r = decideDesiredState({ ...base, ...f });
    return [r.desired, r.reason, r.wouldBe, r.wouldBeReason];
  };

  it('orders the overrides: retired, halted, paused, team paused, resetting, then the lifecycle', () => {
    const all = { retired: true, stopLevel: 'halt' as const, teamPaused: true, resetting: true };
    expect(d(all)).toEqual(['STOPPED', 'RETIRED', null, null]);
    expect(d({ ...all, retired: false })).toEqual(['STOPPED', 'HALTED', null, null]);
    expect(d({ ...all, retired: false, stopLevel: 'pause' })).toEqual(['STOPPED', 'PAUSED', null, null]);
    expect(d({ ...all, retired: false, stopLevel: 'pause-dispatch' })).toEqual(['STOPPED', 'TEAM_PAUSED', null, null]);
    expect(d({ resetting: true })).toEqual(['STOPPED', 'RESETTING', null, null]);
    expect(d({})).toEqual(['RUNNING', 'LONG_LIVED', null, null]);
  });

  it('sweep OFF masks every row, leave-alone included; leave-alone masks every override', () => {
    expect(d({ sweepMode: 'OFF', leaveAlone: true, retired: true })).toEqual([null, 'SWEEP_OFF', 'STOPPED', 'RETIRED']);
    expect(d({ sweepMode: 'OBSERVE', leaveAlone: true, retired: true })).toEqual([null, 'LEAVE_ALONE', 'STOPPED', 'RETIRED']);
    expect(d({ sweepMode: 'OBSERVE' })).toEqual(['RUNNING', 'LONG_LIVED', null, null]);
  });

  it('short-lived: no task, a runnable task, only waiting tasks', () => {
    const s = { lifecycle: 'SHORT_LIVED' as const };
    expect(d(s)).toEqual(['STOPPED', 'NO_OPEN_TASK', null, null]);
    expect(d({ ...s, openTasks: 2, runnableTasks: 1 })).toEqual(['RUNNING', 'HOLDS_TASK', null, null]);
    expect(d({ ...s, openTasks: 2, runnableTasks: 0 })).toEqual(['STOPPED', 'WAITING_ON_CHILDREN', null, null]);
  });
});

describe('#4224 cost', () => {
  it('140 workers on one host answer in one call, well inside the budget', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 140; i++) {
      const id = generateId();
      ids.push(id);
      await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id, appId: app.id, agentId: i % 2 ? shortAgentId : longAgentId, name: `W${String(i).padStart(3, '0')}`, slug: `w${i}`, heldByUserId: member.id, heldAt: new Date() } });
      if (i % 3 === 0) await task({ id }, i % 2 ? 'started' : 'pending');
    }
    const big = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd' }, select: { id: true } });
    await M.grantAppKeyScope({}, { id: big.id, scope: 'host:operate', hostId: 'big' }, ctx(admin.id));
    await M.registerHost({}, { input: { appRef: app.id, label: 'Big', pollIntervalSeconds: 600, workers: ids.map((w) => ({ worker: w, family: 'claude', worktrees: ['wt'] })) } }, keyCtx(big));
    await state(keyCtx(big), 'big'); // warm
    const t0 = performance.now();
    const s = await state(keyCtx(big), 'big');
    const ms = performance.now() - t0;
    expect(s.workers).toHaveLength(140);
    // eslint-disable-next-line no-console
    console.log(`[#4224] hostDesiredState for 140 workers: ${ms.toFixed(1)} ms`);
    // The budget is 500 ms on the dev DB; the bound here is loose so a loaded CI shard cannot flake on it.
    expect(ms).toBeLessThan(2000);
  });
});
