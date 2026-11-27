import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #5325 (cor:agt:090:01, :02, :06; Holger 2026-11-27, decisions:2026-11-27-holger-answer-5325-app-stop-scope): a fourth stop-signal
 * scope, APP: every live worker of the App, worked out at each check, set and lifted by whoever manages the App, never by a host
 * key, and naming no target. The three older scopes behave as before (stopSignals2022.test.ts is their pin and runs unchanged).
 *
 * Cast (as stopSignals2022.test.ts): Ada heads a team, Liam and Dan report to her, Kit is outside every team; orca1 lists Ada and
 * Dan, orca2 lists Kit. Max manages the App; Mia is a member who holds the workers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { randomBytes } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbAppAgent } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { runAsActor } from '../requestActor.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../middleware/auth.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { taskMatcherTick } from '../../jobs/taskMatcher.js';
import { coveringSignals, lockStopFence } from './state.js';
import { declareAllStopLanes } from '../../test/stopLanes.js';
import { serveEveryAgent } from '../../test/servedBootPrompt.js';
import { joinHostForKey } from '../../test/agentTeamHost.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
async function refusal(p: Promise<unknown>): Promise<GraphQLError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(GraphQLError); return e as GraphQLError; }
  throw new Error('expected a refusal');
}
const code = async (p: Promise<unknown>) => (await refusal(p)).extensions?.code;

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

async function mkKey(label: string) {
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  return db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label }, select: { id: true } });
}
const keyCtx = (k: { id: string }): Context => ({ db, appId: app.id, appKeyId: k.id, organizationId: org.id, roles: [] }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  delete process.env.DISABLE_TASK_MATCHER;
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Stop', urn: `stop5325-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `s53-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  max = await u(81, 'max');
  mia = await u(82, 'mia');
  await db.orgMember.create({ data: { organizationId: org.id, userId: max.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgRef: org.id, name: 'Team Agent' }, ctx(max.id));
  agentId = agent.id;
  await serveEveryAgent(db);
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
  const orca2 = await mkKey('orca2');
  await joinHostForKey(db, orca1.id, 'orca1');
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(max.id));
  await joinHostForKey(db, orca2.id, 'orca2');
  await M.grantAppKeyScope({}, { id: orca2.id, scope: 'host:operate', hostId: 'orca2' }, ctx(max.id));
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 1', pollIntervalSeconds: 600, workers: [{ worker: ada.id, family: 'claude' }, { worker: dan.id, family: 'claude' }] } }, keyCtx(orca1));
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 2', pollIntervalSeconds: 600, workers: [{ worker: kit.id, family: 'claude' }] } }, keyCtx(orca2));
  await declareAllStopLanes(db, app.id);
});

const set = (c: Context, input: Record<string, unknown>) => M.setTeamStopSignal({}, { input: { appRef: app.id, ...input } }, c);
const lift = (c: Context, id: string) => M.liftTeamStopSignal({}, { appRef: app.id, id }, c);
const covered = async () => [...(await coveringSignals(db, app.id, null, new Date())).keys()].sort();
const ids = (...ws: { id: string }[]) => ws.map((w) => w.id).sort();
async function notices(w: { id: string }): Promise<string[]> {
  const rows = await db.agentTeamEvent.findMany({ where: { appId: app.id, type: 'stop.notice', subjectWorkerId: w.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return rows.map((r) => { const p = r.payload as { level: string; notice: string }; return `${p.level}:${p.notice}`; });
}
async function asWorker<T>(w: { id: string }, fn: () => Promise<T>): Promise<T> {
  await db.session.create({ data: { id: generateId(), appId: app.id, userId: mia.id, workerId: w.id, agentId, tool: 'vitest' } });
  return runAsActor({ workerId: w.id, agentId }, fn);
}

describe('cor:agt:090:01 / :06 — setting and lifting an APP signal', () => {
  it('A1: whoever manages the App sets one at any level: scope APP, no target, recorded with its setter; lift returns changed', async () => {
    for (const level of ['PAUSE_DISPATCH', 'PAUSE', 'HALT']) {
      const s = await set(ctx(max.id), { level, scope: 'APP' });
      expect(s).toMatchObject({ level, scope: 'APP', targetWorkerId: null, targetHostId: null, setByUserId: max.id, setByHostKey: false, live: true });
      const r = await lift(ctx(max.id), s.id);
      expect(r.changed).toBe(true);
      expect(r.signal).toMatchObject({ live: false, endKind: 'LIFTED', endedByUserId: max.id });
      expect((await lift(ctx(max.id), s.id)).changed).toBe(false);
    }
  });

  it('A2: it names no target: a worker or a host named with APP is BAD_USER_INPUT, and nothing is written', async () => {
    expect(await code(set(ctx(max.id), { level: 'PAUSE', scope: 'APP', worker: 'Kit' }))).toBe('BAD_USER_INPUT');
    expect(await code(set(ctx(max.id), { level: 'PAUSE', scope: 'APP', host: 'orca1' }))).toBe('BAD_USER_INPUT');
    expect(await db.teamStopSignal.count({ where: { appId: app.id } })).toBe(0);
  });

  it('A3: a host key never sets it: every shape of the call is STOP_SIGNAL_SCOPE_FORBIDDEN, recorded as a refused host-key use, nothing written', async () => {
    const shapes: Record<string, unknown>[] = [
      { level: 'HALT', scope: 'APP' },
      { level: 'HALT', scope: 'APP', worker: 'Dan' },
      { level: 'HALT', scope: 'APP', host: 'orca1' },
      { level: 'PAUSE', scope: 'APP' },
    ];
    for (const shape of shapes) {
      const e = await refusal(set(keyCtx(orca1), shape));
      expect(e.extensions).toMatchObject({ code: 'STOP_SIGNAL_SCOPE_FORBIDDEN', right: 'host-halt-only' });
      expect(e.message).toMatch(/no WORKER, TEAM or APP scope/);
    }
    expect(await db.teamStopSignal.count({ where: { appId: app.id } })).toBe(0);
    expect(await db.hostKeyUse.count({ where: { appKeyId: orca1.id, action: 'stop', refusedCode: 'STOP_SIGNAL_SCOPE_FORBIDDEN' } })).toBe(shapes.length);
    // ... and its own-host halt still works: the refusal is about the scope, not the key.
    expect((await set(keyCtx(orca1), { level: 'HALT', scope: 'HOST' })).scope).toBe('HOST');
  });

  it('A4: a host key cannot lift a manager\'s APP signal, which is not its to see; a member who does not manage the App sets and lifts nothing', async () => {
    const s = await set(ctx(max.id), { level: 'PAUSE', scope: 'APP' });
    expect(await code(lift(keyCtx(orca1), s.id))).toBe('STOP_SIGNAL_NOT_FOUND');
    expect(await code(lift(ctx(mia.id), s.id))).toBe('APP_MANAGER_REQUIRED');
    expect(await code(set(ctx(mia.id), { level: 'PAUSE', scope: 'APP' }))).toBe('APP_MANAGER_REQUIRED');
    expect((await Q.teamStopSignals({}, { appRef: app.id }, ctx(max.id))).signals.map((x: { id: string }) => x.id)).toEqual([s.id]);
  });

  it('A5: a worker in its own session is refused, even when the person holding it could manage the App', async () => {
    await db.appMember.update({ where: { appId_userId: { appId: app.id, userId: mia.id } }, data: { role: 'owner' } });
    const e = await refusal(asWorker(ada, () => set(ctx(mia.id), { level: 'PAUSE_DISPATCH', scope: 'APP' })));
    expect(e.extensions).toMatchObject({ code: 'APP_MANAGER_REQUIRED', right: 'manage-app' });
    expect((await set(ctx(mia.id), { level: 'PAUSE_DISPATCH', scope: 'APP' })).setByUserId).toBe(mia.id);
  });

  it('A6: the scope list is stated: a bad scope names APP among the four', async () => {
    const e = await refusal(set(ctx(max.id), { level: 'PAUSE', scope: 'ORG' }));
    expect(e.extensions?.code).toBe('BAD_USER_INPUT');
    expect(e.message).toBe('scope is one of WORKER, TEAM, APP, HOST.');
  });
});

describe('cor:agt:090:02 — the workers an APP signal covers, live (no roster, no snapshot)', () => {
  it('C1: every live worker of the App, in or out of a team, listed on a host or not; no worker of another App', async () => {
    const foreign = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: otherApp.id, agentId, name: 'Zed', slug: 'zed' }, select: { id: true } });
    await set(ctx(max.id), { level: 'PAUSE', scope: 'APP' });
    expect(await covered()).toEqual(ids(ada, liam, dan, kit));
    expect((await coveringSignals(db, otherApp.id, null, new Date())).has(foreign.id)).toBe(false);
  });

  it('C2: a signal set in another App covers nothing here', async () => {
    await M.setTeamStopSignal({}, { input: { appRef: otherApp.id, level: 'PAUSE', scope: 'APP' } }, ctx(max.id)).catch(() => undefined);
    expect(await covered()).toEqual([]);
    expect(await db.teamStopSignal.count({ where: { appId: app.id } })).toBe(0);
  });

  it('C3: a worker retired after the signal is no longer covered; one never retired still is (computed at each check)', async () => {
    await set(ctx(max.id), { level: 'PAUSE', scope: 'APP' });
    await db.worker.update({ where: { id: kit.id }, data: { retiredAt: new Date() } });
    expect(await covered()).toEqual(ids(ada, liam, dan));
  });

  it('C4: a worker cast AFTER the signal is covered from its birth, with no reporting line, and is told', async () => {
    const caster = await M.createAgent({}, { orgRef: org.id, name: 'Caster', personaRole: 'engineer' }, ctx(max.id));
    await serveEveryAgent(db);
    await createDbAppAgent(db, app.id, caster.id);
    const s = await set(ctx(max.id), { level: 'PAUSE', scope: 'APP' });
    const made = await M.castWorker({}, { appRef: app.id, agentRef: caster.id, name: 'Newbie' }, ctx(max.id));
    expect(made?.id ?? made?.worker?.id).toBeTruthy();
    const newbie = await db.worker.findFirstOrThrow({ where: { appId: app.id, name: 'Newbie' }, select: { id: true, reportsToWorkerId: true } });
    expect(newbie.reportsToWorkerId).toBeNull();
    expect(await covered()).toEqual(ids(ada, liam, dan, kit, newbie));
    expect(await notices(newbie)).toEqual(['pause:stop']);
    expect((await lift(ctx(max.id), s.id)).changed).toBe(true);
    expect(await notices(newbie)).toEqual(['pause:stop', 'pause:resume']);
  });

  it('C6: a cast with no reporting line takes the App\'s stop fence, so it is ordered with a signal being set (it waits behind a held fence)', async () => {
    const caster = await M.createAgent({}, { orgRef: org.id, name: 'Caster', personaRole: 'engineer' }, ctx(max.id));
    await serveEveryAgent(db);
    await createDbAppAgent(db, app.id, caster.id);
    let settled = false;
    let cast: Promise<unknown> | undefined;
    await db.$transaction(async (tx) => {
      await lockStopFence(tx, app.id, 'exclusive');
      cast = M.castWorker({}, { appRef: app.id, agentRef: caster.id, name: 'Waiter' }, ctx(max.id)).finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 700));
      expect(settled).toBe(false); // queued on the fence: a cast no longer slips past a signal being set
    });
    await cast;
    expect(await db.worker.count({ where: { appId: app.id, name: 'Waiter' } })).toBe(1);
  });

  it('C5: every live signal applies: lifting the APP signal leaves a team pause and a host halt where they were', async () => {
    await set(ctx(max.id), { level: 'PAUSE', scope: 'TEAM', worker: 'Ada' });
    const halt = await set(keyCtx(orca1), { level: 'HALT', scope: 'HOST' });
    const appSig = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'APP' });
    const map = await coveringSignals(db, app.id, null, new Date());
    expect(map.get(kit.id)!.map((x) => x.level)).toEqual(['pause-dispatch']);
    expect(map.get(dan.id)!.map((x) => x.level).sort()).toEqual(['halt', 'pause', 'pause-dispatch']);
    await lift(ctx(max.id), appSig.id);
    expect(await covered()).toEqual(ids(ada, liam, dan));
    await lift(keyCtx(orca1), halt.id);
    expect(await covered()).toEqual(ids(ada, liam, dan));
  });
});

describe('cor:agt:090:03, :04 — what an APP signal stops, and the notices', () => {
  const queued = (extra: Record<string, unknown> = {}) =>
    db.agentTask.create({ data: { appId: app.id, title: 'Work', ownerUserId: max.id, requirements: { role: 'engineer' } as Prisma.InputJsonObject, ...extra }, select: { id: true } });
  const assigneeOf = async (taskId: string) =>
    (await db.agentTask.findUniqueOrThrow({ where: { id: taskId }, select: { assigneeWorkerId: true } })).assigneeWorkerId;
  const bindAll = async () => {
    for (const w of [ada, liam, dan, kit]) await db.session.create({ data: { id: generateId(), appId: app.id, workerId: w.id, agentId, family: 'claude' } });
  };

  it('D1: under an APP pause-dispatch the matcher assigns nobody, and a hand assignment to any worker is refused naming scope APP', async () => {
    await bindAll();
    const s = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'APP' });
    const t = await queued();
    await taskMatcherTick(db, new Date());
    expect(await assigneeOf(t.id)).toBeNull();
    for (const w of ['Kit', 'Liam']) {
      const e = await refusal(M.assignAgentTask({}, { taskRef: t.id, assignee: { worker: w } }, ctx(max.id)));
      expect(e.extensions).toMatchObject({ code: 'TASK_STOPPED', blockers: [{ id: s.id, level: 'PAUSE_DISPATCH', scope: 'APP' }] });
      expect(e.message).toMatch(/a PAUSE_DISPATCH stop signal \(APP, set by /);
    }
    // Lifting resumes matching.
    await lift(ctx(max.id), s.id);
    await taskMatcherTick(db, new Date());
    expect(await assigneeOf(t.id)).not.toBeNull();
  });

  it('D2: a task is matched to an uncovered worker only: the APP signal covers all of them, so a task created while it is live waits', async () => {
    await bindAll();
    await set(ctx(max.id), { level: 'PAUSE', scope: 'APP' });
    const t = await queued();
    await taskMatcherTick(db, new Date());
    expect(await assigneeOf(t.id)).toBeNull();
  });

  it('D3: each covered worker is told by its effective level once, and told to resume once when it is lifted', async () => {
    const s = await set(ctx(max.id), { level: 'PAUSE', scope: 'APP' });
    for (const w of [ada, liam, dan, kit]) expect(await notices(w)).toEqual(['pause:stop']);
    await lift(ctx(max.id), s.id);
    for (const w of [ada, liam, dan, kit]) expect(await notices(w)).toEqual(['pause:stop', 'pause:resume']);
    expect((await lift(ctx(max.id), s.id)).changed).toBe(false);
    for (const w of [ada, liam, dan, kit]) expect(await notices(w)).toEqual(['pause:stop', 'pause:resume']);
  });

  it('D4: a worker\'s own session reads the live APP signal that covers it, and a person lists it with scope APP', async () => {
    const s = await set(ctx(max.id), { level: 'PAUSE', scope: 'APP' });
    const own = await asWorker<{ signals: Array<{ id: string; scope: string }> }>(kit, () => Q.teamStopSignals({}, { appRef: app.id }, ctx(mia.id)));
    expect(own.signals.map((x) => [x.id, x.scope])).toEqual([[s.id, 'APP']]);
    const all = await Q.teamStopSignals({}, { appRef: app.id }, ctx(max.id));
    expect(all.signals.map((x: { id: string; scope: string; targetWorkerId: string | null }) => [x.id, x.scope, x.targetWorkerId])).toEqual([[s.id, 'APP', null]]);
    const covering = await Q.teamStopSignals({}, { appRef: app.id, worker: 'Dan' }, ctx(max.id));
    expect(covering.signals.map((x: { id: string }) => x.id)).toEqual([s.id]);
  });
});

describe('the three older scopes are byte-identical beside an APP signal', () => {
  it('E1: worker, team and host coverage are what they were, with no APP signal live', async () => {
    const w = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Liam' });
    expect(await covered()).toEqual(ids(liam));
    await lift(ctx(max.id), w.id);
    await set(ctx(max.id), { level: 'PAUSE', scope: 'TEAM', worker: 'Ada' });
    expect(await covered()).toEqual(ids(ada, liam, dan));
    await set(keyCtx(orca1), { level: 'HALT', scope: 'HOST' });
    expect((await coveringSignals(db, app.id, null, new Date())).has(kit.id)).toBe(false);
  });

  it('E2: a host key still refuses WORKER and TEAM scope with the same code', async () => {
    expect(await code(set(keyCtx(orca1), { level: 'HALT', scope: 'WORKER', worker: 'Dan' }))).toBe('STOP_SIGNAL_SCOPE_FORBIDDEN');
    expect(await code(set(keyCtx(orca1), { level: 'HALT', scope: 'TEAM', worker: 'Ada' }))).toBe('STOP_SIGNAL_SCOPE_FORBIDDEN');
  });
});
