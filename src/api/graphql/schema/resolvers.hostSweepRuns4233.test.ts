/**
 * #4233 (S10 of #4229) — the sweep run record, its one summary post, and the stale-sweep alarm.
 * Pins: each fails on main (the mutation, the query and the alarm type do not exist there).
 */
import { settleSweepSummaries, evaluateStaleSweeps, postSweepSummary } from '../../../lib/agentTasks/sweepRuns.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../../middleware/auth.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

let org: { id: string; urn: string };
let app: { id: string; urn: string };
let manager: { id: string };
let channel: { id: string };
let key: { id: string };
let otherKey: { id: string };

const hostCtx = (keyId = key.id): Context => ({ db, appId: app.id, appKeyId: keyId, organizationId: org.id, roles: [] }) as Context;
const ago = (min: number) => new Date(Date.now() - min * 60_000);
let n = 0;
const run = (over: Record<string, unknown> = {}) => ({
  appRef: app.id, runId: `run-${++n}`, startedAt: ago(1), endedAt: ago(0.5), mode: 'APPLY',
  planned: 0, applied: 0, skipped: 0, failed: 0, lines: [], ...over,
});
const record = async (over: Record<string, unknown> = {}, c = hostCtx()) => {
  const r = await M.recordHostSweepRun({}, { input: run(over) }, c);
  await settleSweepSummaries();
  return r;
};
const lines = (count: number, outcome = 'APPLIED') =>
  Array.from({ length: count }, (_, i) => ({ worker: `w${i}`, outcome, reason: 'DIED' }));
const posts = async () => (await db.node.findMany({ where: { messageChannelId: channel.id, nodeType: 'chat-message' }, orderBy: { seq: 'asc' } })) as any[];
const alarms = () => db.agentTeamEvent.findMany({ where: { appId: app.id, type: 'alarm.stale-sweep' }, orderBy: { createdAt: 'asc' } });
const setMode = (sweepMode: 'OFF' | 'OBSERVE' | 'APPLY') => db.app.update({ where: { id: app.id }, data: { sweepMode } });

beforeEach(async () => {
  await cleanDb(db);
  const x = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Sweep', urn: `sweep-${x}.example` }, select: { id: true, urn: true } });
  manager = await db.user.create({ data: { githubId: 92_000_000 + x, githubUsername: `sw-manager-${x}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(manager.id));
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, urn: true } });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id },
  });
  channel = (await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: manager.id, asDefaultOfAppId: app.id })).channel;
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Kit', slug: 'kit' }, select: { id: true } });
  const mk = async (label: string, hostId: string) => {
    const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
    const k = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label }, select: { id: true } });
    await M.grantAppKeyScope({}, { id: k.id, scope: 'host:operate', hostId }, ctx(manager.id));
    await M.registerHost({}, { input: { appRef: app.id, label: label, pollIntervalSeconds: 60, workers: [{ worker: worker.id, family: 'claude' }] } }, hostCtx(k.id));
    return k;
  };
  key = await mk('Orca One', 'orca1');
  otherKey = await mk('Orca Two', 'orca2');
});

describe('record and read (acceptance: readable as hostSweepRuns by App participants)', () => {
  it('stores a run and a participant reads it back newest first, with its lines', async () => {
    await record({ runId: 'a', planned: 1, applied: 1, lines: [{ worker: 'Kit', outcome: 'APPLIED', reason: 'DIED' }] });
    await record({ runId: 'b', planned: 2, skipped: 2, lines: lines(2, 'SKIPPED') });
    const out = await Q.hostSweepRuns({}, { appRef: app.id, hostId: 'orca1' }, ctx(manager.id));
    expect(out.map((r: any) => r.runId)).toEqual(['b', 'a']);
    expect(out[1]).toMatchObject({ hostId: 'orca1', mode: 'APPLY', planned: 1, applied: 1, skipped: 0, failed: 0 });
    expect(out[1].lines).toEqual([{ worker: 'Kit', outcome: 'APPLIED', reason: 'DIED' }]);
    expect(await Q.hostSweepRuns({}, { appRef: app.id, hostId: 'orca1', limit: 1 }, ctx(manager.id))).toHaveLength(1);
  });

  it('a replayed run token is the same run: one row, same id', async () => {
    const a = await record({ runId: 'same', applied: 1, planned: 1 });
    const b = await record({ runId: 'same', applied: 1, planned: 1 });
    expect(b.id).toBe(a.id);
    expect(await db.hostSweepRun.count({ where: { appId: app.id } })).toBe(1);
  });

  it('a host key reads its own host only; another host answers HOST_NOT_FOUND like a missing one', async () => {
    await record();
    expect(await Q.hostSweepRuns({}, { appRef: app.id, hostId: 'orca1' }, hostCtx())).toHaveLength(1);
    const foreign = Q.hostSweepRuns({}, { appRef: app.id, hostId: 'orca2' }, hostCtx());
    const missing = Q.hostSweepRuns({}, { appRef: app.id, hostId: 'nowhere' }, hostCtx());
    await expect(foreign).rejects.toMatchObject({ extensions: { code: 'HOST_NOT_FOUND' } });
    await expect(missing).rejects.toMatchObject({ extensions: { code: 'HOST_NOT_FOUND' } });
  });

  it('only a host key records: a person is refused, and a host records under its own host id', async () => {
    await expect(M.recordHostSweepRun({}, { input: run() }, ctx(manager.id))).rejects.toMatchObject({ extensions: { code: 'HOST_KEY_REQUIRED' } });
    await record({ runId: 'x' }, hostCtx(otherKey.id));
    expect(await db.hostSweepRun.findMany({ where: { runKey: 'x' } })).toMatchObject([{ hostId: 'orca2' }]);
    const use = await db.hostKeyUse.findFirst({ where: { appKeyId: otherKey.id, action: 'sweep' } });
    expect(use?.hostId).toBe('orca2');
  });
});

describe('a malformed report stores nothing', () => {
  it.each([
    ['mode OFF', { mode: 'OFF' }],
    ['51 lines', { lines: lines(51) }],
    ['free text as a reason', { lines: [{ worker: 'Kit', outcome: 'FAILED', reason: 'it died, ping @everyone' }] }],
    ['a negative count', { failed: -1 }],
    ['an end before the start', { startedAt: ago(1), endedAt: ago(2) }],
    ['an end in the future', { endedAt: new Date(Date.now() + 10 * 60_000) }],
    ['an unknown outcome', { lines: [{ worker: 'Kit', outcome: 'WON', reason: 'DIED' }] }],
  ])('%s', async (_label, over) => {
    await expect(M.recordHostSweepRun({}, { input: run(over) }, hostCtx())).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await db.hostSweepRun.count()).toBe(0);
  });
  it('50 lines are accepted', async () => {
    await record({ lines: lines(50, 'SKIPPED'), planned: 50, skipped: 50 });
    expect(await db.hostSweepRun.count()).toBe(1);
  });
});

describe('one summary post per run, only when something changed (cor:agt:020:14 cap)', () => {
  it('a run with 25 fixes is ONE post, from the platform, naming the counts', async () => {
    await record({ planned: 25, applied: 25, lines: lines(25) });
    const all = await posts();
    expect(all).toHaveLength(1);
    expect(all[0].data.authorSystem).toBe(true);
    expect(all[0].createdByWorkerId).toBeNull();
    expect(all[0].content).toContain('25 fixed');
    expect(all[0].content).toContain('Orca One');
    expect(all[0].content).toContain('and 15 more');
    expect((await db.hostSweepRun.findFirstOrThrow()).postedAt).not.toBeNull();
  });
  it('a run that changed nothing posts nothing', async () => {
    await record({ planned: 3, skipped: 3, lines: lines(3, 'SKIPPED') });
    expect(await posts()).toHaveLength(0);
  });
  it('a failure alone is posted', async () => {
    await record({ planned: 1, failed: 1, lines: [{ worker: 'Kit', outcome: 'FAILED', reason: 'START_REFUSED' }] });
    const [p] = await posts();
    expect(p.content).toContain('1 failed');
    expect(p.content).toContain('kit failed (START_REFUSED)'.replace('kit', 'Kit'));
  });
  it('a replay posts nothing a second time', async () => {
    await record({ runId: 'r', planned: 1, applied: 1 });
    await record({ runId: 'r', planned: 1, applied: 1 });
    expect(await posts()).toHaveLength(1);
  });
  it('the marker is claimed once: a second post of the same run writes nothing (the claim, not the row conflict, holds it)', async () => {
    await record({ runId: 'claim', planned: 1, applied: 1 });
    const row = await db.hostSweepRun.findFirstOrThrow({ where: { runKey: 'claim' } });
    expect(await postSweepSummary(db, app.id, row.id, 'again')).toBe(false);
    expect(await posts()).toHaveLength(1);
  });
  it('a host-supplied token cannot inject markup or a mention into the line', async () => {
    await record({ planned: 1, applied: 1, lines: [{ worker: 'Kit@all', outcome: 'APPLIED', reason: 'DIED' }] });
    const [p] = await posts();
    expect(p.content).not.toContain('@all');
  });
});

describe('the stale-sweep alarm', () => {
  const later = (min: number) => new Date(Date.now() + min * 60_000);
  const episodes = () => db.hostSweepEpisode.findMany({ where: { appId: app.id }, orderBy: { openedAt: 'asc' } });

  it('fires once per episode for a host whose last run ended over five minutes ago, to the managers', async () => {
    await setMode('OBSERVE');
    await record({ runId: 'old', startedAt: ago(8), endedAt: ago(7) });
    expect(await evaluateStaleSweeps(db, new Date())).toHaveLength(1);
    expect(await evaluateStaleSweeps(db, new Date())).toHaveLength(0);
    expect(await evaluateStaleSweeps(db, later(3))).toHaveLength(0);
    const [a, ...rest] = await alarms();
    expect(rest).toEqual([]);
    expect(a).toMatchObject({ severity: 'alarm', taskId: null, subjectWorkerId: null });
    expect(a!.payload).toMatchObject({ reason: 'stale-sweep', hostId: 'orca1', windowMinutes: 5 });
    expect(a!.chain).toEqual([{ userId: manager.id, via: 'manager' }]);
  });

  it('clears on the next run, and a later silence is a new episode', async () => {
    await setMode('APPLY');
    await record({ runId: 'old', startedAt: ago(8), endedAt: ago(7) });
    await evaluateStaleSweeps(db, new Date());
    expect((await episodes())[0]!.endedAt).toBeNull();
    await record({ runId: 'fresh' });
    expect((await episodes())[0]!.endedAt).not.toBeNull();
    expect(await evaluateStaleSweeps(db, new Date())).toHaveLength(0);
    expect(await evaluateStaleSweeps(db, later(6))).toHaveLength(2); // orca1 again; orca2 never ran and registered 6+ minutes ago
    expect(await alarms()).toHaveLength(3);
  });

  it('raises nothing inside five minutes, with the sweep mode OFF, or for a host that has not been silent that long', async () => {
    await record({ runId: 'recent', startedAt: ago(5), endedAt: ago(4) });
    await setMode('OBSERVE');
    expect(await evaluateStaleSweeps(db, new Date())).toHaveLength(0);
    await setMode('OFF');
    expect(await evaluateStaleSweeps(db, later(30))).toHaveLength(0);
    expect(await alarms()).toHaveLength(0);
  });

  it('switching the mode off ends the open episode', async () => {
    await setMode('OBSERVE');
    await evaluateStaleSweeps(db, later(6));
    expect((await episodes()).every((e) => e.endedAt === null)).toBe(true);
    await setMode('OFF');
    await evaluateStaleSweeps(db, later(7));
    expect((await episodes()).every((e) => e.endedAt !== null)).toBe(true);
  });

  it('the alarm is in the open alarm list until acknowledged, and its end is read from the episode', async () => {
    await setMode('OBSERVE');
    await record({ runId: 'old', startedAt: ago(8), endedAt: ago(7) });
    await evaluateStaleSweeps(db, new Date());
    await record({ runId: 'fresh' });
    const { alarmEpisodeEnds } = await import('../../../lib/agentTasks/stall.js');
    const [a] = await alarms();
    const ends = await alarmEpisodeEnds(db, [{ id: a!.id, taskId: null, type: a!.type, episodeStart: null }], new Date());
    expect(ends.get(a!.id)).toBeInstanceOf(Date);
  });
});
