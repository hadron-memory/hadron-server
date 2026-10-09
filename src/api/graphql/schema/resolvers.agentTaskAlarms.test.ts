/**
 * #1706 — availability for work and stall windows: the setter gates
 * (cor:agt:060:08 / :09), the record shapes (060:02 / :03), the derived
 * "available for work" predicate (060:01), and the read gate. One case per
 * principal shape for each act. The alarm rules and acknowledgement are
 * pinned in src/lib/agentTasks/stall.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';
import { isAvailableForWork, loadAvailableForWork } from '../../../lib/agentTasks/availability.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const F = resolvers as any;

function ctx(userId?: string, extra: Partial<Context> = {}): Context {
  return { db, userId, roles: ['READER'], ...extra };
}

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    expect.fail(`expected rejection with extensions.code=${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    expect((e as GraphQLError).extensions?.code).toBe(code);
  }
}

let app: { id: string; urn: string };
let otherApp: { id: string };
let agentId: string;
let admin: { id: string };
let holder: { id: string };
let member: { id: string };
let outsider: { id: string };
let liam: { id: string };
let rook: { id: string };
let zed: { id: string };

const asWorker = (w: { id: string }, fn: () => Promise<any>): Promise<any> => runAsActor({ workerId: w.id, agentId }, fn);
const future = () => new Date(Date.now() + 3_600_000);

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Avail', urn: `avail-${n}.example` } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `av-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  admin = await u(61, 'admin');
  holder = await u(62, 'holder');
  member = await u(63, 'member');
  outsider = await u(64, 'outsider');
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  agentId = agent.id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `avail-${n}.example:team` }, select: { id: true, urn: true } });
  otherApp = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `avail-${n}.example:other` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'member' } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  const worker = (appId: string, name: string) =>
    db.worker.create({ data: { appId, agentId, name, slug: name.toLowerCase(), heldByUserId: holder.id }, select: { id: true } });
  liam = await worker(app.id, 'Liam');
  rook = await worker(app.id, 'Rook');
  zed = await worker(otherApp.id, 'Zed');
});

const setWorker = (c: Context, input: Record<string, unknown>) =>
  M.setWorkerAvailability({}, { input: { worker: liam.id, state: 'UNAVAILABLE', reason: 'OUT_OF_TOKENS', ...input } }, c);
const setFamily = (c: Context, input: Record<string, unknown>) =>
  M.setModelFamilyAvailability({}, { input: { appRef: app.id, family: 'claude', state: 'UNAVAILABLE', reason: 'OTHER', ...input } }, c);

describe('cor:agt:060:08 — who may set a worker\'s availability', () => {
  it('the worker itself, through its session, may mark itself unavailable — and never available', async () => {
    const row = await asWorker(liam, () => setWorker(ctx(holder.id), { until: future() }));
    expect(row).toMatchObject({ workerId: liam.id, state: 'unavailable', reason: 'out-of-tokens', setBy: 'worker', setByWorkerId: liam.id });
    await expectCode(asWorker(liam, () => setWorker(ctx(holder.id), { state: 'AVAILABLE', reason: null })), 'AVAILABILITY_NOT_PERMITTED');
  });

  it('S2: another worker may not set it, either way (Rook cannot mark Liam available)', async () => {
    await setWorker(ctx(holder.id), {});
    await expectCode(asWorker(rook, () => setWorker(ctx(holder.id), { state: 'AVAILABLE', reason: null })), 'AVAILABILITY_NOT_PERMITTED');
    await expectCode(asWorker(rook, () => setWorker(ctx(holder.id), {})), 'AVAILABILITY_NOT_PERMITTED');
    expect(await db.workerAvailability.findUnique({ where: { workerId: liam.id } })).toMatchObject({ state: 'unavailable', setBy: 'holder' });
  });

  it('the person holding the worker\'s name may set either', async () => {
    await expect(setWorker(ctx(holder.id), {})).resolves.toMatchObject({ setBy: 'holder', setByUserId: holder.id, setByWorkerId: null });
    await expect(setWorker(ctx(holder.id), { state: 'AVAILABLE', reason: null })).resolves.toMatchObject({ state: 'available', reason: null });
  });

  it('whoever manages the App may set either; another App participant may not', async () => {
    await expect(setWorker(ctx(admin.id), {})).resolves.toMatchObject({ setBy: 'app-manager', setByUserId: admin.id });
    await expectCode(setWorker(ctx(member.id), { state: 'AVAILABLE', reason: null }), 'AVAILABILITY_NOT_PERMITTED');
  });

  it('a manager acting through a worker session is that worker, not a manager (interim, #7508)', async () => {
    await expectCode(asWorker(rook, () => setWorker(ctx(admin.id), {})), 'AVAILABILITY_NOT_PERMITTED');
  });

  it('a caller outside the App, or naming a worker of another App, learns nothing: WORKER_NOT_FOUND', async () => {
    await expectCode(setWorker(ctx(outsider.id), {}), 'WORKER_NOT_FOUND');
    await expectCode(setWorker(ctx(admin.id), { worker: 'Zed', appRef: app.id }), 'WORKER_NOT_FOUND');
    await expectCode(setWorker(ctx(member.id), { worker: zed.id }), 'WORKER_NOT_FOUND');
    await expectCode(setWorker(ctx(admin.id), { worker: generateId() }), 'WORKER_NOT_FOUND');
  });

  it('a worker named within its App resolves; a bare name without the App is refused', async () => {
    await expect(setWorker(ctx(admin.id), { worker: 'Liam', appRef: app.id })).resolves.toMatchObject({ workerId: liam.id });
    await expectCode(setWorker(ctx(admin.id), { worker: 'Liam' }), 'BAD_USER_INPUT');
  });

  it('a retired worker is refused', async () => {
    await db.worker.update({ where: { id: liam.id }, data: { retiredAt: new Date() } });
    await expectCode(setWorker(ctx(admin.id), {}), 'WORKER_RETIRED');
  });

  it('writes availability.changed with the actor, never free text', async () => {
    const until = future();
    await setWorker(ctx(holder.id), { until });
    const [e] = await db.agentTeamEvent.findMany({ where: { type: 'availability.changed' } });
    expect(e).toMatchObject({
      appId: app.id, taskId: null, subjectWorkerId: liam.id, actorUserId: holder.id, severity: null,
      payload: { state: 'unavailable', reason: 'out-of-tokens', until: until.toISOString(), setBy: 'holder' },
    });
  });

  it('060:02 shape: a reason exactly when unavailable, an until only then and in the future', async () => {
    await expectCode(setWorker(ctx(admin.id), { reason: null }), 'BAD_USER_INPUT');
    await expectCode(setWorker(ctx(admin.id), { state: 'AVAILABLE' }), 'BAD_USER_INPUT');
    await expectCode(setWorker(ctx(admin.id), { state: 'AVAILABLE', reason: null, until: future() }), 'BAD_USER_INPUT');
    await expectCode(setWorker(ctx(admin.id), { until: new Date(Date.now() - 1000) }), 'BAD_USER_INPUT');
    await expectCode(setWorker(ctx(admin.id), { reason: 'HELD' }), 'BAD_USER_INPUT');
    expect(await db.workerAvailability.count()).toBe(0);
  });

  it('060:02: at most one record per worker — a later set replaces it', async () => {
    await setWorker(ctx(admin.id), {});
    await setWorker(ctx(admin.id), { reason: 'HOST_DOWN' });
    expect(await db.workerAvailability.findMany()).toEqual([expect.objectContaining({ workerId: liam.id, reason: 'host-down' })]);
  });

  it('a session the request named but that did not bind is refused, writing nothing', async () => {
    await expectCode(setWorker(ctx(admin.id, { sessionBindingRefused: true } as Partial<Context>), {}), 'SESSION_NOT_BOUND');
    expect(await db.workerAvailability.count()).toBe(0);
  });
});

describe('cor:agt:060:09 — who may set a model family\'s availability', () => {
  it('S1: whoever manages the App pauses the claude family', async () => {
    await expect(setFamily(ctx(admin.id), {})).resolves.toMatchObject({ appId: app.id, family: 'claude', state: 'unavailable', setByUserId: admin.id });
    const [e] = await db.agentTeamEvent.findMany({ where: { type: 'availability.changed' } });
    expect(e).toMatchObject({ subjectWorkerId: null, payload: { family: 'claude', state: 'unavailable', reason: 'other', until: null } });
  });

  it('S2: a worker (even driven by the manager), a holder, and a member are refused', async () => {
    await expectCode(asWorker(rook, () => setFamily(ctx(admin.id), { family: 'codex' })), 'AVAILABILITY_NOT_PERMITTED');
    await expectCode(setFamily(ctx(holder.id), {}), 'AVAILABILITY_NOT_PERMITTED');
    await expectCode(setFamily(ctx(member.id), {}), 'AVAILABILITY_NOT_PERMITTED');
    await expectCode(setFamily(ctx(outsider.id), {}), 'APP_NOT_FOUND');
    expect(await db.modelFamilyAvailability.count()).toBe(0);
  });

  it('a family is a lowercase token; one record per App and family', async () => {
    await expectCode(setFamily(ctx(admin.id), { family: 'has space' }), 'BAD_USER_INPUT');
    await setFamily(ctx(admin.id), { family: 'Claude' });
    await setFamily(ctx(admin.id), { family: 'claude', state: 'AVAILABLE', reason: null });
    expect(await db.modelFamilyAvailability.findMany()).toEqual([expect.objectContaining({ family: 'claude', state: 'available' })]);
  });
});

describe('cor:agt:060:01 — available for work', () => {
  const rec = (r: Partial<{ state: string; reason: string | null; until: Date | null; setAt: Date }>) =>
    ({ state: 'unavailable', reason: 'other', until: null, setAt: new Date('2026-10-09T09:00:00Z'), ...r });
  const now = new Date('2026-10-09T12:00:00Z');

  it('no record, an available record, and a lapsed until all read as available (lapse: interim)', () => {
    expect(isAvailableForWork({ worker: null, family: null, lastActivityAt: null }, now)).toBe(true);
    expect(isAvailableForWork({ worker: rec({ state: 'available', reason: null }), family: null, lastActivityAt: null }, now)).toBe(true);
    expect(isAvailableForWork({ worker: rec({ until: new Date('2026-10-09T11:59:59Z') }), family: null, lastActivityAt: null }, now)).toBe(true);
    expect(isAvailableForWork({ worker: rec({ until: new Date('2026-10-09T18:00:00Z') }), family: null, lastActivityAt: null }, now)).toBe(false);
  });

  it('the worker\'s own record, or its family\'s, makes it unavailable; a stall mark ends at its next activity', () => {
    expect(isAvailableForWork({ worker: rec({}), family: null, lastActivityAt: now }, now)).toBe(false);
    expect(isAvailableForWork({ worker: null, family: rec({}), lastActivityAt: null }, now)).toBe(false);
    const stalled = rec({ reason: 'stalled' });
    expect(isAvailableForWork({ worker: stalled, family: null, lastActivityAt: new Date('2026-10-09T08:59:00Z') }, now)).toBe(false);
    expect(isAvailableForWork({ worker: stalled, family: null, lastActivityAt: new Date('2026-10-09T09:01:00Z') }, now)).toBe(true);
    // Only a stall mark is ended by activity.
    expect(isAvailableForWork({ worker: rec({}), family: null, lastActivityAt: new Date('2026-10-09T09:01:00Z') }, now)).toBe(false);
  });

  it('the example: Liam out of tokens; Rook with no record but his family paused', async () => {
    await setWorker(ctx(admin.id), { until: future() });
    await setFamily(ctx(admin.id), {});
    const out = await loadAvailableForWork(db, [
      { id: liam.id, appId: app.id, family: 'codex' },
      { id: rook.id, appId: app.id, family: 'claude' },
      { id: zed.id, appId: otherApp.id, family: 'claude' },
    ]);
    expect(Object.fromEntries(out)).toEqual({ [liam.id]: false, [rook.id]: false, [zed.id]: true });
  });
});

describe('reading availability and stall windows (the App\'s task audience)', () => {
  it('teamAvailability lists both kinds with whether each is in effect; outsiders get APP_NOT_FOUND', async () => {
    await setWorker(ctx(admin.id), {});
    await setFamily(ctx(admin.id), { family: 'codex', state: 'AVAILABLE', reason: null });
    const r = await asWorker(rook, () => Q.teamAvailability({}, { appRef: app.id }, ctx(member.id)));
    expect(r.workers).toHaveLength(1);
    expect(r.families).toHaveLength(1);
    expect(await F.WorkerAvailability.inEffect(r.workers[0], {}, ctx(member.id))).toBe(true);
    expect(F.WorkerAvailability.reason(r.workers[0])).toBe('OUT_OF_TOKENS');
    expect(F.WorkerAvailability.setBy(r.workers[0])).toBe('APP_MANAGER');
    expect(await F.ModelFamilyAvailability.inEffect(r.families[0])).toBe(false);
    await expectCode(Q.teamAvailability({}, { appRef: app.id }, ctx(outsider.id)), 'APP_NOT_FOUND');
  });

  it('stall windows: defaults, a manager\'s override, an omitted field kept, a member refused', async () => {
    expect(await Q.agentTaskStallSchedule({}, { appRef: app.id }, ctx(member.id))).toMatchObject({
      notStartedMinutes: 15, noProgressMinutes: 60, ownerReactionMinutes: 20, assignmentMinutes: 30, updatedAt: null,
    });
    await M.setAgentTaskStallSchedule({}, { appRef: app.id, input: { noProgressMinutes: 90 } }, ctx(admin.id));
    const after = await M.setAgentTaskStallSchedule({}, { appRef: app.id, input: { assignmentMinutes: 45 } }, ctx(admin.id));
    expect(after).toMatchObject({ noProgressMinutes: 90, assignmentMinutes: 45, notStartedMinutes: 15 });
    await expectCode(M.setAgentTaskStallSchedule({}, { appRef: app.id, input: { noProgressMinutes: 5 } }, ctx(member.id)), 'APP_MANAGER_REQUIRED');
    await expectCode(M.setAgentTaskStallSchedule({}, { appRef: app.id, input: { noProgressMinutes: 0 } }, ctx(admin.id)), 'BAD_USER_INPUT');
    await expectCode(M.setAgentTaskStallSchedule({}, { appRef: app.id, input: { noProgressMinutes: 10_081 } }, ctx(admin.id)), 'BAD_USER_INPUT');
    await expectCode(Q.agentTaskStallSchedule({}, { appRef: app.id }, ctx(outsider.id)), 'APP_NOT_FOUND');
  });

  it('an uninstalled App\'s availability and windows are read-only', async () => {
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    await expectCode(setWorker(ctx(admin.id), {}), 'APP_UNINSTALLED');
    await expectCode(setFamily(ctx(admin.id), {}), 'APP_UNINSTALLED');
  });
});
