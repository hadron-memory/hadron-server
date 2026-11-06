import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #2022 (S6) — stop signals (cor:agt:090): who may set, lift and see them; which workers they cover, live; what each
 * level stops (matching, manual assignment, launches, stall time); and the notices they leave.
 *
 * Cast (the specs' own): Ada heads a team, Liam and Dan report to her, Ada reports to nobody. orca1's registration lists
 * Ada and Dan. Max manages the App (org ADMIN); Mia is a member who holds the workers. Kit is outside every team.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { randomBytes } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { runAsActor } from '../requestActor.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../middleware/auth.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { taskMatcherTick } from '../../jobs/taskMatcher.js';
import { taskStallTick } from '../../jobs/taskStallEvaluator.js';
import { anchorNow, coveringSignals, lockStopFence } from './state.js';
import { liftStopSignal, setStopSignal } from './lifecycle.js';
import { countedDueAt } from '../agentTasks/stall.js';
import { __matcherTesting } from '../agentTasks/matcher.js';
import { loadPendingReasons } from '../tickers/checkPending.js';
import { launchForAssignment } from '../hostOperations/launch.js';
import { declareAllStopLanes } from '../../test/stopLanes.js';
import { serveEveryAgent } from '../../test/servedBootPrompt.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
async function code(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(GraphQLError); return (e as GraphQLError).extensions?.code as string; }
  return undefined;
}
async function refusal(p: Promise<unknown>): Promise<GraphQLError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(GraphQLError); return e as GraphQLError; }
  throw new Error('expected a refusal');
}

let org: { id: string; urn: string };
let app: { id: string };
let otherApp: { id: string };
let agentId: string;
let max: { id: string };
let mia: { id: string };
let ada: { id: string };
let liam: { id: string };
let dan: { id: string };
let kit: { id: string };
let orca1: { id: string };
let orca2: { id: string };
let plainKey: { id: string };

async function mkKey(label: string) {
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  return db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label }, select: { id: true } });
}
const keyCtx = (k: { id: string }): Context => ({ db, appId: app.id, appKeyId: k.id, organizationId: org.id, roles: [] }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  delete process.env.DISABLE_TASK_MATCHER;
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Stop', urn: `stop2022-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `s22-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  max = await u(71, 'max');
  mia = await u(72, 'mia');
  await db.orgMember.create({ data: { organizationId: org.id, userId: max.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(max.id));
  agentId = agent.id;
  await serveEveryAgent(db); // #2712: binds are served
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  otherApp = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
  const w = (name: string, role: string, extra: Record<string, unknown> = {}) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(), role, heldByUserId: mia.id, heldAt: new Date(), ...extra }, select: { id: true } });
  ada = await w('Ada', 'coordinator');
  liam = await w('Liam', 'engineer', { reportsToWorkerId: ada.id });
  dan = await w('Dan', 'engineer', { reportsToWorkerId: ada.id });
  kit = await w('Kit', 'engineer');
  orca1 = await mkKey('orca1');
  orca2 = await mkKey('orca2');
  plainKey = await mkKey('plain');
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(max.id));
  await M.grantAppKeyScope({}, { id: orca2.id, scope: 'host:operate', hostId: 'orca2' }, ctx(max.id));
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 1', pollIntervalSeconds: 600, workers: [{ worker: ada.id, family: 'claude' }, { worker: dan.id, family: 'claude' }] } }, keyCtx(orca1));
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 2', pollIntervalSeconds: 600, workers: [{ worker: kit.id, family: 'claude' }] } }, keyCtx(orca2));
  // #2173/#2169: setting a signal is refused while a lane has no fresh stop-consumer declaration. This file tests signals
  // themselves, so every lane is declared here; consumerLane2169.test.ts tests the refusal.
  await declareAllStopLanes(db, app.id);
});

const set = (c: Context, input: Record<string, unknown>) => M.setTeamStopSignal({}, { input: { appRef: app.id, ...input } }, c);
const lift = (c: Context, id: string) => M.liftTeamStopSignal({}, { appRef: app.id, id }, c);
const covered = async () => [...(await coveringSignals(db, app.id, null, new Date())).keys()].sort();
const ids = (...ws: { id: string }[]) => ws.map((w) => w.id).sort();
/** The stop notices each worker has been sent, oldest first, as `level:notice[:interrupt]`. */
async function notices(w: { id: string }): Promise<string[]> {
  const rows = await db.agentTeamEvent.findMany({ where: { appId: app.id, type: 'stop.notice', subjectWorkerId: w.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return rows.map((r) => {
    const p = r.payload as { level: string; notice: string; interrupt: boolean };
    return `${p.level}:${p.notice}${p.interrupt ? ':interrupt' : ''}`;
  });
}
/** A worker session for `w`, held by Mia: the actor a worker's own calls carry. */
async function asWorker<T>(w: { id: string }, fn: () => Promise<T>): Promise<T> {
  await db.session.create({ data: { id: generateId(), appId: app.id, userId: mia.id, workerId: w.id, agentId, tool: 'vitest' } });
  return runAsActor({ workerId: w.id, agentId }, fn);
}

describe('cor:agt:090:06 — who may set and lift a stop signal', () => {
  it('S1: whoever manages the App sets a team pause, recorded as its setter; lift returns changed', async () => {
    const s = await set(ctx(max.id), { level: 'PAUSE', scope: 'TEAM', worker: 'Ada' });
    expect(s).toMatchObject({ level: 'PAUSE', scope: 'TEAM', targetWorkerId: ada.id, setByUserId: max.id, setByHostKey: false, live: true });
    const r = await lift(ctx(max.id), s.id);
    expect(r.changed).toBe(true);
    expect(r.signal).toMatchObject({ live: false, endKind: 'LIFTED', endedByUserId: max.id });
  });

  it('S2: a host key sets a halt on its own host, recorded as set by a host key, and the use is recorded', async () => {
    const s = await set(keyCtx(orca1), { level: 'HALT', scope: 'HOST' });
    expect(s).toMatchObject({ level: 'HALT', scope: 'HOST', targetHostId: 'orca1', setByUserId: null, setByHostKey: true });
    expect(await db.hostKeyUse.count({ where: { appKeyId: orca1.id, action: 'stop', refusedCode: null } })).toBe(1);
    expect((await lift(keyCtx(orca1), s.id)).changed).toBe(true);
  });

  it('S3: a host key naming another host is refused; a halt on another host is not its to see', async () => {
    expect(await code(set(keyCtx(orca1), { level: 'HALT', scope: 'HOST', host: 'orca2' }))).toBe('HOST_SCOPE_REQUIRED');
    const theirs = await set(keyCtx(orca2), { level: 'HALT', scope: 'HOST' });
    expect(await code(lift(keyCtx(orca1), theirs.id))).toBe('STOP_SIGNAL_NOT_FOUND');
    // Refusals are recorded too (cor:agt:070:07).
    expect(await db.hostKeyUse.count({ where: { appKeyId: orca1.id, action: 'stop', refusedCode: { not: null } } })).toBe(2);
  });

  it('S4: a host key sets no pause and no worker or team scope', async () => {
    expect(await code(set(keyCtx(orca1), { level: 'PAUSE', scope: 'HOST' }))).toBe('STOP_SIGNAL_SCOPE_FORBIDDEN');
    expect(await code(set(keyCtx(orca1), { level: 'HALT', scope: 'WORKER', worker: 'Dan' }))).toBe('STOP_SIGNAL_SCOPE_FORBIDDEN');
  });

  it('S5: a worker in its own session is refused, even though the person holding it could manage the App', async () => {
    await db.appMember.update({ where: { appId_userId: { appId: app.id, userId: mia.id } }, data: { role: 'owner' } });
    const e = await refusal(asWorker(ada, () => set(ctx(mia.id), { level: 'PAUSE_DISPATCH', scope: 'TEAM', worker: 'Ada' })));
    expect(e.extensions).toMatchObject({ code: 'APP_MANAGER_REQUIRED', right: 'manage-app' });
    expect(e.message).toMatch(/Retry with a plain session \(hadron_start_session with no worker\)/);
    // The same person, as themselves, may.
    expect((await set(ctx(mia.id), { level: 'PAUSE_DISPATCH', scope: 'TEAM', worker: 'Ada' })).setByUserId).toBe(mia.id);
  });

  it('S6: a host key cannot lift a manager\'s team pause; a member who does not manage the App sets and lifts nothing', async () => {
    const s = await set(ctx(max.id), { level: 'PAUSE', scope: 'TEAM', worker: 'Ada' });
    expect(await code(lift(keyCtx(orca1), s.id))).toBe('STOP_SIGNAL_NOT_FOUND');
    expect(await code(lift(ctx(mia.id), s.id))).toBe('APP_MANAGER_REQUIRED');
    expect(await code(set(ctx(mia.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Kit' }))).toBe('APP_MANAGER_REQUIRED');
  });

  it('an App key without host:operate, an outsider, and a target outside the App are refused, absence alike', async () => {
    expect(await code(set(keyCtx(plainKey), { level: 'HALT', scope: 'HOST' }))).toBe('APP_KEY_SCOPE_REQUIRED');
    const outsider = await db.user.create({ data: { githubId: 99_000_000 + Math.floor(Math.random() * 1e6), githubUsername: `s22-out-${generateId()}`, roles: ['READER'] }, select: { id: true } });
    expect(await code(set(ctx(outsider.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Kit' }))).toBe('APP_NOT_FOUND');
    const foreign = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: otherApp.id, agentId, name: 'Zed', slug: 'zed' }, select: { id: true } });
    expect(await code(set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: foreign.id }))).toBe('STOP_SIGNAL_NOT_FOUND');
    expect(await code(set(ctx(max.id), { level: 'PAUSE', scope: 'HOST', host: 'nowhere' }))).toBe('STOP_SIGNAL_NOT_FOUND');
    expect(await code(lift(ctx(max.id), generateId()))).toBe('STOP_SIGNAL_NOT_FOUND');
  });

  it('malformed input is BAD_USER_INPUT: a past until, a host on a worker signal, a worker on a host signal', async () => {
    expect(await code(set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Kit', until: new Date(Date.now() - 1000) }))).toBe('BAD_USER_INPUT');
    expect(await code(set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Kit', host: 'orca1' }))).toBe('BAD_USER_INPUT');
    expect(await code(set(ctx(max.id), { level: 'PAUSE', scope: 'HOST', worker: 'Kit', host: 'orca1' }))).toBe('BAD_USER_INPUT');
    expect(await code(set(ctx(max.id), { level: 'STOP', scope: 'WORKER', worker: 'Kit' }))).toBe('BAD_USER_INPUT');
  });
});

describe('cor:agt:090:02 — the workers a signal covers, live (R95)', () => {
  it('worker, team and host scope; a team never covers the worker its head reports to; R84 a registration with no live session', async () => {
    const w = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Liam' });
    expect(await covered()).toEqual(ids(liam));
    await lift(ctx(max.id), w.id);
    const team = await set(ctx(max.id), { level: 'PAUSE', scope: 'TEAM', worker: 'Liam' });
    expect(await covered()).toEqual(ids(liam)); // Liam heads nobody; Ada, whom he reports to, is not covered
    await lift(ctx(max.id), team.id);
    await set(ctx(max.id), { level: 'PAUSE', scope: 'TEAM', worker: 'Ada' });
    expect(await covered()).toEqual(ids(ada, liam, dan));
    await set(keyCtx(orca1), { level: 'HALT', scope: 'HOST' });
    const map = await coveringSignals(db, app.id, null, new Date());
    expect(map.get(dan.id)!.map((s) => s.level).sort()).toEqual(['halt', 'pause']);
    expect(map.get(liam.id)!.map((s) => s.level)).toEqual(['pause']);
  });

  it('moving a worker out of a paused team uncovers it and sends one resume; placing a new one under it covers it', async () => {
    await set(ctx(max.id), { level: 'PAUSE', scope: 'TEAM', worker: 'Ada' });
    expect(await notices(dan)).toEqual(['pause:stop']);
    await M.setWorkerReportsTo({}, { workerRef: dan.id, reportsTo: null }, ctx(max.id));
    expect(await covered()).toEqual(ids(ada, liam));
    expect(await notices(dan)).toEqual(['pause:stop', 'pause:resume']);
    await M.setWorkerReportsTo({}, { workerRef: kit.id, reportsTo: liam.id }, ctx(max.id));
    expect(await covered()).toEqual(ids(ada, liam, kit));
    expect(await notices(kit)).toEqual(['pause:stop']);
  });

  it('a host registration that starts listing a worker covers it under a live halt; retiring a covered worker uncovers it', async () => {
    await set(keyCtx(orca1), { level: 'HALT', scope: 'HOST' });
    expect(await covered()).toEqual(ids(ada, dan));
    await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 1', pollIntervalSeconds: 600, workers: [{ worker: ada.id, family: 'claude' }, { worker: dan.id, family: 'claude' }, { worker: liam.id, family: 'claude' }] } }, keyCtx(orca1));
    expect(await covered()).toEqual(ids(ada, liam, dan));
    expect(await notices(liam)).toEqual(['halt:stop:interrupt']);
    await M.retireWorker({}, { workerRef: dan.id }, ctx(max.id));
    expect(await covered()).toEqual(ids(ada, liam));
    expect(await notices(dan)).toEqual(['halt:stop:interrupt']); // a retired worker is told nothing more
  });
});

describe('cor:agt:090:03 — every level stops assignment', () => {
  const queued = (extra: Record<string, unknown> = {}) =>
    db.agentTask.create({ data: { appId: app.id, title: 'Work', ownerUserId: max.id, requirements: { role: 'engineer' } as Prisma.InputJsonObject, ...extra }, select: { id: true } });
  const assigneeOf = async (taskId: string) =>
    (await db.agentTask.findUniqueOrThrow({ where: { id: taskId }, select: { assigneeWorkerId: true } })).assigneeWorkerId;
  const bindAll = async () => {
    for (const w of [ada, liam, dan, kit]) await db.session.create({ data: { id: generateId(), appId: app.id, workerId: w.id, agentId, family: 'claude' } });
  };

  for (const level of ['PAUSE_DISPATCH', 'PAUSE', 'HALT'] as const) {
    it(`${level}: matching skips the covered worker and takes an uncovered one`, async () => {
      await bindAll();
      await set(ctx(max.id), { level, scope: 'WORKER', worker: 'Liam' });
      await set(ctx(max.id), { level, scope: 'WORKER', worker: 'Dan' });
      const t = await queued();
      await taskMatcherTick(db, new Date());
      expect(await assigneeOf(t.id)).toBe(kit.id);
    });
  }

  it('S1/S2: under a team pause-dispatch nothing is assigned to the team; a reassign into it is refused naming the setter and until', async () => {
    await bindAll();
    const until = new Date(Date.now() + 3600_000);
    const s = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'TEAM', worker: 'Ada', until });
    await db.session.deleteMany({ where: { workerId: kit.id } }); // Kit can't take it either: unbound and not launchable
    const t = await queued();
    await taskMatcherTick(db, new Date());
    expect(await assigneeOf(t.id)).toBeNull();
    const assigned = await M.createAgentTask({}, { input: { appRef: app.id, title: 'X', assignee: { worker: 'Kit' } } }, ctx(max.id));
    const e = await refusal(M.reassignAgentTask({}, { taskId: assigned.id, assignee: { worker: 'Liam' } }, ctx(max.id)));
    const handle = (await db.user.findUniqueOrThrow({ where: { id: max.id }, select: { handle: true } })).handle;
    const setter = handle ? `@${handle}` : `user ${max.id}`;
    expect(e.message).toBe(`Can't assign to Liam: a PAUSE_DISPATCH stop signal (TEAM, set by ${setter}, until ${until.toISOString()}) covers them. Assign someone else, or whoever manages the App lifts it (\`hadron team stop lift\`, signal id ${s.id}).`);
    expect(e.extensions).toMatchObject({
      code: 'TASK_STOPPED', workerId: liam.id, workerUrn: expect.stringMatching(/^hrn:worker:.*:liam$/), moreBlockers: false,
      blockers: [{ id: s.id, level: 'PAUSE_DISPATCH', scope: 'TEAM', setByUserId: max.id, setByHandle: handle, setByHostKey: false, until: until.toISOString() }],
    });
    expect(await assigneeOf(assigned.id)).toBe(kit.id);
  });

  it('S6: under a host halt, an assignment by hand (assign, and create with an assignee) to a covered worker is refused', async () => {
    await set(keyCtx(orca1), { level: 'HALT', scope: 'HOST' });
    const t = await queued();
    expect(await code(M.assignAgentTask({}, { taskId: t.id, assignee: { worker: 'Ada' } }, ctx(max.id)))).toBe('TASK_STOPPED');
    expect(await code(M.createAgentTask({}, { input: { appRef: app.id, title: 'Y', assignee: { worker: 'Dan' } } }, ctx(max.id)))).toBe('TASK_STOPPED');
    expect(await db.agentTask.count({ where: { title: 'Y' } })).toBe(0);
    // Liam isn't on orca1: assigning him is fine.
    expect((await M.assignAgentTask({}, { taskId: t.id, assignee: { worker: 'Liam' } }, ctx(max.id))).assigneeWorkerId).toBe(liam.id);
  });

  it('moving a task AWAY from a covered worker, and cancelling it, are not refused', async () => {
    const t = await M.createAgentTask({}, { input: { appRef: app.id, title: 'Z', assignee: { worker: 'Dan' } } }, ctx(max.id));
    await set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Dan' });
    expect((await M.reassignAgentTask({}, { taskId: t.id, assignee: { worker: 'Kit' } }, ctx(max.id))).assigneeWorkerId).toBe(kit.id);
    expect((await M.cancelAgentTask({}, { taskId: t.id }, ctx(max.id))).status).toBe('cancelled');
  });

  it('S4 (R71): a task Liam creates under his pause is not matched to Dan while the pause covers Liam', async () => {
    await bindAll();
    await set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Liam' });
    const t = await queued({ createdByWorkerId: liam.id, requirements: { role: 'engineer', excludeWorkerIds: [kit.id] } });
    await taskMatcherTick(db, new Date());
    expect(await assigneeOf(t.id)).toBeNull();
    const hold = await db.agentTaskStopHold.findFirst({ where: { taskId: t.id, endedAt: null } });
    expect(hold).not.toBeNull();
    const [s] = (await Q.teamStopSignals({}, { appRef: app.id }, ctx(max.id))).signals;
    await lift(ctx(max.id), s.id);
    await taskMatcherTick(db, new Date());
    expect(await assigneeOf(t.id)).toBe(dan.id);
    expect(await db.agentTaskStopHold.count({ where: { taskId: t.id, endedAt: null } })).toBe(0);
  });

  it('a pause-dispatch does not make its creator\'s tasks wait (R71 is pause and halt only)', async () => {
    await bindAll();
    await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Liam' });
    const t = await queued({ createdByWorkerId: liam.id, requirements: { role: 'engineer', excludeWorkerIds: [kit.id] } });
    await taskMatcherTick(db, new Date());
    expect(await assigneeOf(t.id)).toBe(dan.id);
  });
});

describe('cor:agt:090:05 — when a signal ends; R69 every live signal applies', () => {
  it('S2: lifting a team pause leaves a host halt in force; only Liam resumes', async () => {
    const p = await set(ctx(max.id), { level: 'PAUSE', scope: 'TEAM', worker: 'Ada' });
    await set(keyCtx(orca1), { level: 'HALT', scope: 'HOST' });
    await lift(ctx(max.id), p.id);
    expect(await covered()).toEqual(ids(ada, dan));
    expect(await notices(liam)).toEqual(['pause:stop', 'pause:resume']);
    expect(await notices(dan)).toEqual(['pause:stop', 'halt:stop:interrupt']);
  });

  it('a halt ending while a pause still covers the worker sends the pause notice again', async () => {
    await set(ctx(max.id), { level: 'PAUSE', scope: 'TEAM', worker: 'Ada' });
    const h = await set(keyCtx(orca1), { level: 'HALT', scope: 'HOST' });
    await lift(keyCtx(orca1), h.id);
    expect(await notices(dan)).toEqual(['pause:stop', 'halt:stop:interrupt', 'pause:stop']);
    expect(await notices(liam)).toEqual(['pause:stop']);
  });

  it('Vera pin 1: two pauses on one target are independent; the second, and lifting one, send nothing; lifting the other, one resume', async () => {
    const a = await set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Kit' });
    const b = await set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Kit' });
    expect(await notices(kit)).toEqual(['pause:stop']);
    await lift(ctx(max.id), a.id);
    expect(await covered()).toEqual(ids(kit));
    expect(await notices(kit)).toEqual(['pause:stop']);
    await lift(ctx(max.id), b.id);
    expect(await notices(kit)).toEqual(['pause:stop', 'pause:resume']);
  });

  it('a pause entering under a live halt sends no notice; the halt ending sends the pause notice', async () => {
    const h = await set(keyCtx(orca2), { level: 'HALT', scope: 'HOST' });
    await set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Kit' });
    expect(await notices(kit)).toEqual(['halt:stop:interrupt']);
    await lift(keyCtx(orca2), h.id);
    expect(await notices(kit)).toEqual(['halt:stop:interrupt', 'pause:stop']);
  });

  it('S1/S3: an expiry ends the signal at its until, recorded by the sweep; a lift after it changes nothing and tells nobody again', async () => {
    const now = new Date();
    const s = await db.$transaction(async (tx) => {
      await lockStopFence(tx, app.id, 'exclusive');
      return setStopSignal(tx, { appId: app.id, level: 'pause', scope: 'team', targetWorkerId: ada.id, targetHostRegistrationId: null, until: new Date(now.getTime() + 60_000), by: { userId: max.id, actor: { userId: max.id, workerId: null, agentId: null } } }, now);
    });
    expect(await covered()).toEqual(ids(ada, liam, dan));
    const later = new Date(now.getTime() + 120_000);
    // In effect at its until even before the sweep records it.
    expect([...(await coveringSignals(db, app.id, null, later)).keys()]).toEqual([]);
    const tick = await taskMatcherTick(db, later);
    expect(tick.expired).toBe(1);
    const row = await db.teamStopSignal.findUniqueOrThrow({ where: { id: s.id } });
    expect(row).toMatchObject({ endKind: 'expired', endedAt: s.until });
    expect(await notices(liam)).toEqual(['pause:stop', 'pause:resume']);
    expect((await taskMatcherTick(db, later)).expired).toBe(0);
    const r = await lift(ctx(max.id), s.id);
    expect(r).toMatchObject({ changed: false, signal: { endKind: 'EXPIRED' } });
    expect(await notices(liam)).toEqual(['pause:stop', 'pause:resume']);
    // The coverage intervals were closed at the until, not at the late sweep.
    const iv = await db.teamStopCoverage.findMany({ where: { signalId: s.id } });
    expect(iv.every((i) => i.leftAt?.getTime() === s.until!.getTime())).toBe(true);
  });

  it('lifting twice: the second changes nothing', async () => {
    const s = await set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Kit' });
    expect((await lift(ctx(max.id), s.id)).changed).toBe(true);
    expect((await lift(ctx(max.id), s.id)).changed).toBe(false);
    expect(await notices(kit)).toEqual(['pause:stop', 'pause:resume']);
    expect(await db.agentTeamEvent.count({ where: { appId: app.id, type: 'stop.lifted' } })).toBe(1);
  });
});

describe('cor:agt:090:04 — notices', () => {
  const coordinatorNotices = async () => {
    const rows = await db.agentTeamEvent.findMany({ where: { appId: app.id, type: 'stop.notice' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map((r) => {
      const p = r.payload as { notice: string; recipientUserId?: string };
      return `${r.subjectWorkerId ?? `user:${p.recipientUserId}`}:${p.notice}`;
    });
  };

  it('S1: a worker pause-dispatch on Liam tells Ada (the worker he reports to) once, and Liam nothing; its end, once more', async () => {
    const s = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Liam' });
    expect(await coordinatorNotices()).toEqual([`${ada.id}:stop`]);
    await lift(ctx(max.id), s.id);
    expect(await coordinatorNotices()).toEqual([`${ada.id}:stop`, `${ada.id}:resume`]);
  });

  it('S2: a team pause-dispatch on Ada tells Ada once, Liam and Dan nothing', async () => {
    await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'TEAM', worker: 'Ada' });
    expect(await coordinatorNotices()).toEqual([`${ada.id}:stop`]);
  });

  it('a pause-dispatch on a worker with no team and nobody above it tells whoever manages the App', async () => {
    await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Kit' });
    expect(await coordinatorNotices()).toEqual([`user:${max.id}:stop`]);
  });

  it('S3/S4: a team pause tells each covered worker once, none interrupted; a halt interrupts', async () => {
    await set(ctx(max.id), { level: 'PAUSE', scope: 'TEAM', worker: 'Ada' });
    for (const w of [ada, liam, dan]) expect(await notices(w)).toEqual(['pause:stop']);
    expect(await notices(kit)).toEqual([]);
    await set(keyCtx(orca2), { level: 'HALT', scope: 'HOST' });
    expect(await notices(kit)).toEqual(['halt:stop:interrupt']);
  });
});

describe('cor:agt:090:07 — who may see stop signals', () => {
  it('a person in the App sees all; a worker sees what covers it; a host key sees its own host\'s', async () => {
    const team = await set(ctx(max.id), { level: 'PAUSE', scope: 'TEAM', worker: 'Ada' });
    const halt1 = await set(keyCtx(orca1), { level: 'HALT', scope: 'HOST' });
    const workerPause = await set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Kit' });
    const list = async (c: Context, extra = {}) => (await Q.teamStopSignals({}, { appRef: app.id, ...extra }, c)).signals.map((s: any) => s.id).sort();
    expect(await list(ctx(mia.id))).toEqual([team.id, halt1.id, workerPause.id].sort());
    expect(await asWorker(liam, () => list(ctx(mia.id)))).toEqual([team.id]);
    expect(await list(keyCtx(orca1))).toEqual([halt1.id]);
    expect(await list(keyCtx(orca2))).toEqual([]);
    await lift(ctx(max.id), workerPause.id);
    expect(await list(ctx(mia.id))).toEqual([team.id, halt1.id].sort());
    expect(await list(ctx(mia.id), { includeEnded: true })).toEqual([team.id, halt1.id, workerPause.id].sort());
    expect(await list(ctx(mia.id), { worker: 'Dan' })).toEqual([team.id, halt1.id].sort());
  });

  it('pages in (setAt, id) order with a cursor', async () => {
    const made = [];
    for (let i = 0; i < 3; i++) made.push((await set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Kit' })).id);
    const p1 = await Q.teamStopSignals({}, { appRef: app.id, first: 2 }, ctx(max.id));
    expect(p1.signals.map((s: any) => s.id)).toEqual(made.slice(0, 2));
    expect(p1.pageInfo.hasNextPage).toBe(true);
    const p2 = await Q.teamStopSignals({}, { appRef: app.id, first: 2, after: p1.pageInfo.endCursor }, ctx(max.id));
    expect(p2.signals.map((s: any) => s.id)).toEqual(made.slice(2));
    expect(await code(Q.teamStopSignals({}, { appRef: app.id, after: 'garbage!' }, ctx(max.id)))).toBe('BAD_USER_INPUT');
  });
});

describe('R68 — stall time under a stop signal (the Proposed cor:agt:050:13-:17 exceptions)', () => {
  const T = (min: number) => new Date(Date.UTC(2026, 9, 20, 10, 0) + min * 60_000);
  async function setAt(level: 'pause-dispatch' | 'pause' | 'halt', worker: { id: string }, at: Date) {
    return db.$transaction(async (tx) => {
      await lockStopFence(tx, app.id, 'exclusive');
      return setStopSignal(tx, { appId: app.id, level, scope: 'worker', targetWorkerId: worker.id, targetHostRegistrationId: null, until: null, by: { userId: max.id, actor: { userId: max.id, workerId: null, agentId: null } } }, at);
    });
  }
  async function liftAt(id: string, at: Date) {
    return db.$transaction(async (tx) => {
      await lockStopFence(tx, app.id, 'exclusive');
      return liftStopSignal(tx, id, { userId: max.id, actor: { userId: max.id, workerId: null, agentId: null } }, at);
    });
  }
  const started = (w: { id: string }) =>
    db.agentTask.create({ data: { appId: app.id, title: 'Long', ownerUserId: max.id, assigneeWorkerId: w.id, status: 'started', assignedAt: T(0), startedAt: T(0), createdAt: T(0) }, select: { id: true } });
  const alarms = (taskId: string, type = 'stall.no-progress') => db.agentTeamEvent.count({ where: { taskId, type } });

  it('countedDueAt: overlapping spans counted once; an open span holds forever; none is start + window', () => {
    const iv = (a: number, b: number | null) => ({ start: T(a), end: b === null ? null : T(b) });
    expect(countedDueAt(T(0), 60 * 60_000)).toEqual(T(60));
    expect(countedDueAt(T(0), 60 * 60_000, [iv(10, 30), iv(20, 40)])).toEqual(T(90));
    expect(countedDueAt(T(0), 60 * 60_000, [iv(70, 80)])).toEqual(T(60));
    expect(countedDueAt(T(0), 60 * 60_000, [iv(-10, 10)])).toEqual(T(70));
    expect(countedDueAt(T(0), 60 * 60_000, [iv(30, null)]).getTime()).toBeGreaterThan(T(100_000).getTime());
  });

  it('S3: no no-progress alarm while Liam is paused; after the lift it counts on from where it stopped', async () => {
    const t = await started(liam);
    const s = await setAt('pause', liam, T(30));
    await taskStallTick(db, T(90));
    expect(await alarms(t.id)).toBe(0);
    await liftAt(s.id, T(100)); // 70 minutes paused: 30 counted before, so due at 100 + 30 = 130
    await taskStallTick(db, T(120));
    expect(await alarms(t.id)).toBe(0);
    await taskStallTick(db, T(131));
    expect(await alarms(t.id)).toBe(1);
  });

  it('a window already reached when the pause began raises nothing while it holds', async () => {
    const t = await started(liam);
    await setAt('halt', liam, T(70));
    await taskStallTick(db, T(75));
    expect(await alarms(t.id)).toBe(0);
  });

  it('a pause-dispatch does not stop the no-progress clock', async () => {
    const t = await started(liam);
    await setAt('pause-dispatch', liam, T(30));
    await taskStallTick(db, T(61));
    expect(await alarms(t.id)).toBe(1);
  });

  it('couldn\'t-be-assigned: a stop hold\'s time is not counted; time nobody could take it for another reason is', async () => {
    const t = await db.agentTask.create({ data: { appId: app.id, title: 'Q', ownerUserId: max.id, createdAt: T(0), requirements: { role: 'engineer' } as Prisma.InputJsonObject }, select: { id: true } });
    await db.agentTaskStopHold.create({ data: { id: generateId(), appId: app.id, taskId: t.id, startedAt: T(5), endedAt: T(25) } });
    await taskStallTick(db, T(31));
    expect(await alarms(t.id, 'assignment.unassignable')).toBe(0);
    await taskStallTick(db, T(51));
    expect(await alarms(t.id, 'assignment.unassignable')).toBe(1);
  });
});

describe('the fence and the final re-check (Dara\'s attach, acceptance 4)', () => {
  const bindDan = () => db.session.create({ data: { id: generateId(), appId: app.id, workerId: dan.id, agentId, family: 'claude' } });
  const task = () => db.agentTask.create({ data: { appId: app.id, title: 'Race', ownerUserId: max.id }, select: { id: true, appId: true, requirements: true, closeSessionWhenDone: true, createdByWorkerId: true } });

  it('a signal set after the candidates were loaded is seen by the assignment\'s own re-check', async () => {
    await bindDan();
    const t = await task();
    await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Dan' });
    expect(await __matcherTesting.tryAssign(db, t, dan.id, 'claude', new Date(), {})).toBe('worker-not-free');
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).assigneeWorkerId).toBeNull();
  });

  it('a signal set while an assignment is in flight waits for it: the assignment commits first, then the signal', async () => {
    await bindDan();
    const t = await task();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const assigning = __matcherTesting.tryAssign(db, t, dan.id, 'claude', new Date(), { afterWorkerCheck: async () => { entered(); await held; } });
    await inside;
    let setDone = false;
    const setting = set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Dan' }).then((v: unknown) => { setDone = true; return v; });
    await new Promise((r) => setTimeout(r, 300));
    expect(setDone).toBe(false);
    release();
    expect(await assigning).toBe('assigned');
    await setting;
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).assigneeWorkerId).toBe(dan.id);
    expect(await covered()).toEqual(ids(dan));
  });
});

describe('#2138 check status under a stop signal', () => {
  it('a pause or halt makes the worker PENDING (STOPPED), since it is not ticked; a pause-dispatch does not', async () => {
    const reason = async (w: { id: string }) => (await loadPendingReasons(db, app.id, [w.id], new Date())).get(w.id);
    await db.agentTask.create({ data: { appId: app.id, title: 'Held', ownerUserId: max.id, assigneeWorkerId: kit.id, assignedAt: new Date() } });
    expect(await reason(kit)).toBeNull();
    const d = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Kit' });
    expect(await reason(kit)).toBeNull();
    await lift(ctx(max.id), d.id);
    await set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Kit' });
    expect(await reason(kit)).toBe('STOPPED');
  });
});

describe('fix head of #2166: the findings\' pins', () => {
  it('Diego P2-2: a reportsTo bind and setTeamPause holding the fence shared do not deadlock (the real resolvers)', async () => {
    let writerReady!: () => void, releaseWriter!: () => void;
    const writerHasFence = new Promise<void>((r) => { writerReady = r; });
    const goWriter = new Promise<void>((r) => { releaseWriter = r; });
    // setTeamPause, held right after it takes the App's stop fence shared (before it updates the App row).
    const hookedDb = new Proxy(db, { get(target, prop) {
      if (prop === '$transaction') return (fn: any, opts: any) => (target as any).$transaction((tx: any) => fn(new Proxy(tx, { get(t, key) {
        if (key === '$executeRaw') return async (...args: any[]) => {
          const out = await t.$executeRaw(...args);
          if (String(args[0]).includes('pg_advisory_xact_lock_shared') && args[1] === 'stop-signals:' + app.id) { writerReady(); await goWriter; }
          return out;
        };
        const v = t[key]; return typeof v === 'function' ? v.bind(t) : v;
      } })), opts);
      const v = (target as any)[prop]; return typeof v === 'function' ? v.bind(target) : v;
    } });
    const writing = M.setTeamPause({}, { appRef: app.id, paused: true }, { ...ctx(max.id), db: hookedDb }).then(() => null, (e: any) => e);
    await writerHasFence;
    // The bind sets reportsTo: it waits on the fence before it locks the App row, so the writer can finish.
    const binding = M.startSession({}, { input: { id: generateId(), workerRef: kit.id, reportsTo: ada.id } }, ctx(mia.id)).then(() => null, (e: any) => e);
    await new Promise((r) => setTimeout(r, 300));
    releaseWriter();
    expect(await Promise.all([writing, binding])).toEqual([null, null]);
    expect((await db.worker.findUniqueOrThrow({ where: { id: kit.id } })).reportsToWorkerId).toBe(ada.id);
    expect((await db.app.findUniqueOrThrow({ where: { id: app.id } })).teamPausedAt).not.toBeNull();
  });

  it('Xan LOCAL-1: an until that passes while the assignment waits on the fence is ended for it; a later one still holds', async () => {
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: dan.id, agentId, family: 'claude' } });
    const run = async (untilMs: number) => {
      const start = new Date();
      const s = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Dan', until: new Date(start.getTime() + untilMs) });
      const t = await db.agentTask.create({ data: { appId: app.id, title: 'Cross', ownerUserId: max.id }, select: { id: true, appId: true, requirements: true, closeSessionWhenDone: true, createdByWorkerId: true } });
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      let locked!: () => void;
      const hasLock = new Promise<void>((r) => { locked = r; });
      // Another connection holds the fence exclusive across the until.
      const holder = db.$transaction(async (tx) => { await lockStopFence(tx, app.id, 'exclusive'); locked(); await held; }, { timeout: 10_000 });
      await hasLock;
      const outcome = __matcherTesting.tryAssign(db, t, dan.id, 'claude', new Date(), {});
      await new Promise((r) => setTimeout(r, 800));
      release();
      await holder;
      const r = await outcome;
      await lift(ctx(max.id), s.id);
      await db.agentTask.update({ where: { id: t.id }, data: { status: 'cancelled', cancelledAt: new Date() } });
      return r;
    };
    expect(await run(400)).toBe('assigned'); // its until passed during the wait
    expect(await run(60_000)).toBe('worker-not-free'); // still live after the wait
  });

  it('Xan LOCAL-1 delta: the pass\'s own latency counts too: `now` and its monotonic anchor are one sample, taken at the pass', async () => {
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: dan.id, agentId, family: 'claude' } });
    const run = async (untilMs: number) => {
      const passNow = new Date();
      const passAnchor = anchorNow();
      const s = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Dan', until: new Date(passNow.getTime() + untilMs) });
      const t = await db.agentTask.create({ data: { appId: app.id, title: 'Late', ownerUserId: max.id }, select: { id: true, appId: true, requirements: true, closeSessionWhenDone: true, createdByWorkerId: true } });
      await new Promise((r) => setTimeout(r, 800)); // earlier work of the pass, before this decider is entered
      const r = await __matcherTesting.tryAssign(db, t, dan.id, 'claude', passNow, {}, passAnchor);
      await lift(ctx(max.id), s.id);
      await db.agentTask.update({ where: { id: t.id }, data: { status: 'cancelled', cancelledAt: new Date() } });
      return r;
    };
    expect(await run(400)).toBe('assigned');
    expect(await run(60_000)).toBe('worker-not-free');
  });
});

describe('fix head of #2166 cycle 2 (Ralion §10)', () => {
  const uses = (key: { id: string }) => db.hostKeyUse.findMany({ where: { appKeyId: key.id }, orderBy: { id: 'asc' }, select: { action: true, count: true, refusedCode: true } });

  it('P2-1: a host key\'s list is a recorded use (read, with its count), and its refusal is recorded', async () => {
    await set(keyCtx(orca1), { level: 'HALT', scope: 'HOST' });
    const before = (await uses(orca1)).length;
    await Q.teamStopSignals({}, { appRef: app.id }, keyCtx(orca1));
    expect((await uses(orca1)).slice(before)).toEqual([{ action: 'read', count: 1, refusedCode: null }]);
    expect(await code(Q.teamStopSignals({}, { appRef: app.id, after: 'garbage!' }, keyCtx(orca1)))).toBe('BAD_USER_INPUT');
    expect((await uses(orca1)).slice(before + 1)).toEqual([{ action: 'read', count: null, refusedCode: 'BAD_USER_INPUT' }]);
  });

  it('P2-1: a host key\'s malformed set and lift are recorded refusals', async () => {
    expect(await code(set(keyCtx(orca1), { level: 'STOP', scope: 'HOST' }))).toBe('BAD_USER_INPUT');
    expect(await code(set(keyCtx(orca1), { level: 'HALT', scope: 'HOST', worker: 'Dan' }))).toBe('BAD_USER_INPUT');
    expect(await code(lift(keyCtx(orca1), ''))).toBe('BAD_USER_INPUT');
    expect(await uses(orca1)).toEqual(expect.arrayContaining([{ action: 'stop', count: null, refusedCode: 'BAD_USER_INPUT' }]));
    expect((await uses(orca1)).filter((u) => u.action === 'stop' && u.refusedCode === 'BAD_USER_INPUT')).toHaveLength(3);
  });

  it('P3: a host key cannot lift a manager\'s host-scope PAUSE on its own host', async () => {
    const p = await set(ctx(max.id), { level: 'PAUSE', scope: 'HOST', host: 'orca1' });
    expect(await code(lift(keyCtx(orca1), p.id))).toBe('STOP_SIGNAL_SCOPE_FORBIDDEN');
    expect((await Q.teamStopSignals({}, { appRef: app.id }, ctx(max.id))).signals.map((x: any) => x.id)).toEqual([p.id]);
  });

  it('P3: a stop set between an assignment\'s commit and its launch starts nothing; without it the worker is started', async () => {
    await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 1', pollIntervalSeconds: 600, workers: [{ worker: ada.id, family: 'claude' }, { worker: dan.id, family: 'claude', worktrees: ['hadron-server/dan'] }] } }, keyCtx(orca1));
    const assigned = () => db.agentTask.create({ data: { appId: app.id, title: 'Launch', ownerUserId: max.id, assigneeWorkerId: dan.id, assignedAt: new Date() }, select: { id: true } });
    const t1 = await assigned();
    const s = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Dan' });
    expect(await launchForAssignment(db, { appId: app.id, taskId: t1.id, workerId: dan.id })).toBeNull();
    expect(await db.hostOperation.count({ where: { workerId: dan.id, type: 'worker.start' } })).toBe(0);
    await lift(ctx(max.id), s.id);
    expect(await launchForAssignment(db, { appId: app.id, taskId: t1.id, workerId: dan.id })).toEqual(expect.any(String));
  });
});
