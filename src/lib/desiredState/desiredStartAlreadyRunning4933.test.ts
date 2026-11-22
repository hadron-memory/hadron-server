/**
 * #4933 — the platform issues no `worker.start` for a worker whose Agent its host already runs (cor:agt:070:08 rev 21,
 * cor:agt:070:01). Pilot hadron-cli#2058 finding 10: clearing the leave-alone marker made the platform start the
 * worker every minute, and every start FAILED host-side ("an agent this host launched is still running").
 *
 * The host's report decides: the worker's stored terminal report names THIS host, is fresh, and shows an agent. The
 * "fake host" here fails every start it is issued, as the real one did, so a start issued on a pass shows as a failed
 * start before the next.
 *
 * Cast as in desiredStart4231.test.ts (Kit, LONG_LIVED, held by Bo, registered on orca1 with a worktree; sweep APPLY).
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { declareAllStopLanes } from '../../test/stopLanes.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { hostRunsAgent, resetDesiredStartStateLog, startDesiredWorker, startDesiredWorkers, START_FAILING_EVENT_TYPE, TERMINAL_FRESH_MS } from './desiredStart.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

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
  resetDesiredStartStateLog();
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { id: generateId(), name: 'S8', urn: `s8-4231-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { id: generateId(), githubId: 42_310_000 + k * 1000 + (n % 1000), githubUsername: `s8-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  admin = await u(1, 'admin');
  bo = await u(2, 'bo');
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const longAgent = (await M.createAgent({}, { orgRef: org.id, name: 'Coordinator' }, ctx(admin.id))).id;
  const shortAgent = (await M.createAgent({}, { orgRef: org.id, name: 'Builder', lifecycle: 'SHORT_LIVED' }, ctx(admin.id))).id;
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

/** The terminal report a host stores for Kit (the stored shape; chk_workers_terminal_shape allows exactly these keys). */
async function report(o: { host?: string; status?: 'busy' | 'idle' | 'locked' | 'dark'; reason?: string | null; ageMs?: number } = {}) {
  const status = o.status ?? 'idle';
  const checkedAt = new Date(Date.now() - (o.ageMs ?? 30_000)).toISOString();
  const reason = o.reason !== undefined ? o.reason : status === 'locked' || status === 'dark' ? 'unrecognized' : null;
  await db.worker.update({
    where: { id: kit.id },
    data: { terminal: { host: { id: o.host ?? 'orca1', label: 'Orca 1' }, status, prompt: 'empty', reason, lastTurnAt: null, checkedAt, reportedAt: checkedAt } },
  });
}

/** The fake host: it fails every start it was issued, saying what the real host said. */
async function hostFailsIssuedStarts() {
  await db.hostOperation.updateMany({
    where: { workerId: kit.id, type: 'worker.start', status: 'issued' },
    data: { status: 'failed', finishedAt: new Date(), failureReason: 'an agent this host launched is still running' },
  });
}

describe('#4933: a cleared-marker worker whose agent the host already runs is not started every minute', () => {
  it('RED ON MAIN: leave-alone cleared, agent running, no open session: five passes, no start, no failed start, no alarm', async () => {
    await M.setWorkerLeaveAlone({}, { input: { worker: kit.id, leaveAlone: true } }, ctx(admin.id));
    await M.setWorkerLeaveAlone({}, { input: { worker: kit.id, leaveAlone: false } }, ctx(admin.id));
    await report({ status: 'idle' });
    for (let i = 0; i < 5; i++) {
      await tick();
      await hostFailsIssuedStarts();
    }
    expect(await starts(), 'the platform issued a start for a worker whose agent its host already runs').toHaveLength(0);
    expect(await alarms()).toHaveLength(0);
  });

  it('the pass reports `running` for it, and counts no start', async () => {
    await report({ status: 'busy' });
    expect(await tick()).toBe(0);
    expect(await startDesiredWorker(db, { appId: app.id, workerId: kit.id, hostId: 'orca1' }, new Date())).toBe('running');
  });

  it('already running with three failed starts on record: still no start, and no failure alarm (it does not trip)', async () => {
    for (const m of [10, 20, 30]) await failedStart(m);
    await report({ status: 'idle' });
    await tick();
    expect(await starts()).toHaveLength(3);
    expect(await alarms(), 'an already-running worker was alarmed as a failing start').toHaveLength(0);
  });

  it('a locked agent (a usage limit, say) is still an agent the host runs: no start', async () => {
    await report({ status: 'locked', reason: 'rate_limited' });
    await tick();
    expect(await starts()).toHaveLength(0);
  });
});

describe('#4933: when the host does not run the agent, the worker is started as before', () => {
  const startsWith = async () => {
    await tick();
    return (await starts()).length;
  };
  it('no terminal report yet', async () => {
    expect(await startsWith()).toBe(1);
  });
  it('dark', async () => {
    await report({ status: 'dark', reason: 'no_terminal' });
    expect(await startsWith()).toBe(1);
  });
  it.each(['no_terminal', 'bare_shell', 'no_agent'])('locked with the agent-absent reason %s', async (reason) => {
    await report({ status: 'locked', reason });
    expect(await startsWith()).toBe(1);
  });
  it('a report older than the freshness window decides nothing', async () => {
    await report({ status: 'idle', ageMs: TERMINAL_FRESH_MS + 60_000 });
    expect(await startsWith()).toBe(1);
  });
  it('a report from another host: the agent is not on this one', async () => {
    await report({ status: 'idle', host: 'orca2' });
    expect(await startsWith()).toBe(1);
  });
  it('three failed starts still trip a worker the host does not run (the trip is unchanged)', async () => {
    for (const m of [10, 20, 30]) await failedStart(m);
    await tick();
    expect(await alarms()).toHaveLength(1);
  });
});

describe('#4933: hostRunsAgent, directly', () => {
  const now = new Date('2026-11-23T00:00:00Z');
  const t = (o: Record<string, unknown>) => ({ host: { id: 'h' }, status: 'idle', reason: null, checkedAt: new Date(now.getTime() - 1000).toISOString(), ...o });
  it('says yes for a fresh busy, idle or locked report on the same host', () => {
    for (const status of ['busy', 'idle', 'locked']) expect(hostRunsAgent(t({ status }), 'h', now)).toBe(true);
  });
  it('says no for null, another host, dark, an unknown status, a missing, junk, stale or future checkedAt', () => {
    expect(hostRunsAgent(null, 'h', now)).toBe(false);
    expect(hostRunsAgent(t({}), 'other', now)).toBe(false);
    expect(hostRunsAgent(t({ status: 'dark' }), 'h', now)).toBe(false);
    expect(hostRunsAgent(t({ status: 'asleep' }), 'h', now)).toBe(false);
    expect(hostRunsAgent(t({ checkedAt: undefined }), 'h', now)).toBe(false);
    expect(hostRunsAgent(t({ checkedAt: 'junk' }), 'h', now)).toBe(false);
    expect(hostRunsAgent(t({ checkedAt: new Date(now.getTime() - TERMINAL_FRESH_MS - 1).toISOString() }), 'h', now)).toBe(false);
    expect(hostRunsAgent(t({ checkedAt: new Date(now.getTime() + 10 * 60_000).toISOString() }), 'h', now)).toBe(false);
  });
  it('the freshness boundary is inclusive', () => {
    expect(hostRunsAgent(t({ checkedAt: new Date(now.getTime() - TERMINAL_FRESH_MS).toISOString() }), 'h', now)).toBe(true);
  });
});

describe('#4933: the state is logged once when first seen and again when it changes', () => {
  it('three passes while it runs: one `already running` line; the agent goes away: one `starting` line', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await report({ status: 'idle' });
      await tick();
      await tick();
      await tick();
      const lines = () => info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[desired-start]'));
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toContain('already running');
      await report({ status: 'dark', reason: 'bare_shell' });
      await tick();
      await tick();
      expect(lines()).toHaveLength(2);
      expect(lines()[1]).toContain('starting');
      expect(await starts()).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });
});
