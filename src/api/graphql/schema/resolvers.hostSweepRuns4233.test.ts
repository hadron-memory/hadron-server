/**
 * #4233 (S10 of #4229) — the sweep run record, its one summary post, and the stale-sweep alarm.
 * Pins: each fails on main (the mutation, the query and the alarm type do not exist there).
 */
import { settleSweepSummaries, evaluateStaleSweeps, postSweepSummary, postPendingSweepSummaries, insertSweepRun, validateSweepRun } from '../../../lib/agentTasks/sweepRuns.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { typeDefs } from './typeDefs.js';
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
  const agent = await M.createAgent({}, { orgRef: org.id, name: 'Team Agent' }, ctx(manager.id));
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

  it('the real GraphQL path accepts ISO DateTime strings (the scalar hands the resolver a string, #4255 Cloe P1)', async () => {
    const schema = buildSchema(typeDefs);
    const fieldResolver = (p: any, a: any, c: any, i: any) =>
      typeof (resolvers as any)[i.parentType.name]?.[i.fieldName] === 'function' ? (resolvers as any)[i.parentType.name][i.fieldName](p, a, c, i) : defaultFieldResolver(p, a, c, i);
    const source = 'mutation($input: RecordHostSweepRunInput!){ recordHostSweepRun(input: $input){ runId endedAt applied } }';
    const input = { ...run({ planned: 1, applied: 1, lines: [{ worker: 'Kit', outcome: 'APPLIED', reason: 'DIED' }] }), startedAt: ago(1).toISOString(), endedAt: ago(0.5).toISOString() };
    const out = await graphql({ schema, source, variableValues: { input }, contextValue: hostCtx(), fieldResolver });
    expect(out.errors).toBeUndefined();
    expect(out.data!.recordHostSweepRun).toMatchObject({ applied: 1 });
    await settleSweepSummaries();
    expect(validateSweepRun({ ...input, mode: 'APPLY' } as any, new Date()).ok).toBe(true);
    expect(await db.hostSweepRun.count()).toBe(1);
  });

  it('a host key reads its own host only; another host answers HOST_NOT_FOUND like a missing one', async () => {
    await record();
    expect(await Q.hostSweepRuns({}, { appRef: app.id, hostId: 'orca1' }, hostCtx())).toHaveLength(1);
    await expect(Q.hostSweepRuns({}, { appRef: app.id, hostId: 'orca2' }, hostCtx())).rejects.toMatchObject({ extensions: { code: 'HOST_NOT_FOUND' } });
    await expect(Q.hostSweepRuns({}, { appRef: app.id, hostId: 'nowhere' }, hostCtx())).rejects.toMatchObject({ extensions: { code: 'HOST_NOT_FOUND' } });
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
    expect(await postSweepSummary(db, app.id, row.id)).toBe(false);
    expect(await posts()).toHaveLength(1);
  });
  it('a host cannot flood the chat: 30 runs with fixes, back to back, post once (the host gap, #4255 Braxton P2-2)', async () => {
    for (let i = 0; i < 30; i++) await record({ planned: 1, applied: 1, lines: lines(1) });
    expect(await posts()).toHaveLength(1);
    expect(await db.hostSweepRun.count()).toBe(30);
  });
  it('a summary lost after the commit is posted from the persisted run by the next tick, once (#4255 Clark F1)', async () => {
    const checked = validateSweepRun(run({ planned: 2, applied: 2, lines: lines(2) }) as any, new Date());
    if (!checked.ok) throw new Error(checked.message);
    // The commit happened and the deferred post never ran (a restart): the row exists with its marker unclaimed.
    await db.$transaction((tx) => insertSweepRun(tx, app.id, 'orca1', checked.run));
    expect(await posts()).toHaveLength(0);
    expect(await postPendingSweepSummaries(db, new Date())).toBe(0); // inside the grace: the request's own post may still be in flight
    expect(await postPendingSweepSummaries(db, new Date(Date.now() + 60_000))).toBe(1);
    expect(await postPendingSweepSummaries(db, new Date(Date.now() + 61_000))).toBe(0);
    const [p] = await posts();
    expect(p.content).toContain('2 fixed');
  });
  it('runs that cannot post do not starve another App\'s recovery, however many hosts they name (#4255 Clark F4)', async () => {
    const x = Math.floor(Math.random() * 1_000_000);
    const dark = await db.app.create({ data: { organizationId: org.id, name: 'NoChat', urn: `${org.urn}:nochat${x}` }, select: { id: true } });
    // 600 distinct hosts, older than the normal App's run: more than one scan's worth, all unpostable.
    await db.$executeRaw`
      INSERT INTO host_sweep_runs (id, app_id, host_id, run_key, started_at, ended_at, mode, planned, applied, skipped, failed, lines, recorded_at)
      SELECT 'nochat' || g, ${dark.id}, 'h' || g, 'r' || g, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC', 'APPLY', 1, 1, 0, 0, '[]'::jsonb,
             (now() AT TIME ZONE 'UTC') - interval '5 minutes' + g * interval '1 millisecond'
      FROM generate_series(1, 600) g`;
    const ok = validateSweepRun(run({ planned: 1, applied: 1, lines: lines(1) }) as any, new Date());
    if (!ok.ok) throw new Error(ok.message);
    await db.$transaction((tx) => insertSweepRun(tx, app.id, 'orca1', ok.run));
    expect(await postPendingSweepSummaries(db, new Date(Date.now() + 60_000))).toBe(1);
    expect(await posts()).toHaveLength(1);
  });
  it('520 unpostable Apps sharing the cap do not starve one deliverable run across ticks (#4255 Clark F4, multi-App)', async () => {
    const x = Math.floor(Math.random() * 1_000_000);
    await db.app.createMany({ data: Array.from({ length: 520 }, (_, i) => ({ organizationId: org.id, name: `NoChat${i}`, urn: `${org.urn}:nc${x}-${i}` })) });
    const dark = await db.app.findMany({ where: { urn: { startsWith: `${org.urn}:nc${x}-` } }, select: { id: true } });
    await db.$executeRaw`
      INSERT INTO host_sweep_runs (id, app_id, host_id, run_key, started_at, ended_at, mode, planned, applied, skipped, failed, lines, recorded_at)
      SELECT 'multi' || row_number() OVER (), a, 'h', 'r', now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC', 'APPLY', 1, 1, 0, 0, '[]'::jsonb,
             (now() AT TIME ZONE 'UTC') - interval '5 minutes'
      FROM unnest(${dark.map((d) => d.id)}::text[]) AS a`;
    const ok = validateSweepRun(run({ planned: 1, applied: 1, lines: lines(1) }) as any, new Date());
    if (!ok.ok) throw new Error(ok.message);
    await db.$transaction((tx) => insertSweepRun(tx, app.id, 'orca1', ok.run));
    // Each tick is a minute apart; the unpostable Apps fill the scan on the first, and must not on the next.
    let total = 0;
    for (let tick = 1; tick <= 3; tick++) total += await postPendingSweepSummaries(db, new Date(Date.now() + (tick + 0.5) * 60_000));
    expect(total).toBe(1);
    expect(await posts()).toHaveLength(1);
  }, 60_000);
  it('a run recorded long ago is not posted late: the retry window is ten minutes', async () => {
    const checked = validateSweepRun(run({ planned: 1, applied: 1, lines: lines(1) }) as any, new Date());
    if (!checked.ok) throw new Error(checked.message);
    await db.$transaction((tx) => insertSweepRun(tx, app.id, 'orca1', checked.run));
    expect(await postPendingSweepSummaries(db, new Date(Date.now() + 11 * 60_000))).toBe(0);
  });
  it('the host label (host-supplied text) reaches the post without markdown syntax (#4255 Braxton P3-1)', async () => {
    await db.hostRegistration.updateMany({ where: { appId: app.id, hostId: 'orca1' }, data: { label: '[x](https://e.example) `code`' } });
    await record({ planned: 1, applied: 1, lines: lines(1) });
    const [p] = await posts();
    expect(p.content.split(' (')[0]).not.toMatch(/[\[\]()`]/);
    expect(p.content).toContain('x https://e.example code');
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

  it('fires once per episode for a host whose last run was recorded over five minutes ago, to the managers', async () => {
    await setMode('OBSERVE');
    await record({ runId: 'old' });
    expect(await evaluateStaleSweeps(db, later(3))).toHaveLength(0);
    expect(await evaluateStaleSweeps(db, later(6))).toHaveLength(2); // orca1, and orca2 which never ran and registered over five minutes before
    expect(await evaluateStaleSweeps(db, later(6))).toHaveLength(0);
    expect(await evaluateStaleSweeps(db, later(9))).toHaveLength(0);
    const all = await alarms();
    expect(all).toHaveLength(2);
    const a = all.find((e) => (e.payload as any).hostId === 'orca1')!;
    expect(a).toMatchObject({ severity: 'alarm', taskId: null, subjectWorkerId: null });
    expect(a.payload).toMatchObject({ reason: 'stale-sweep', hostId: 'orca1', windowMinutes: 5 });
    expect(a.chain).toEqual([{ userId: manager.id, via: 'manager' }]);
  });

  it('clears on the next run, and a later silence is a new episode', async () => {
    await setMode('APPLY');
    await evaluateStaleSweeps(db, later(6));
    expect((await episodes()).every((e) => e.endedAt === null)).toBe(true);
    await record({ runId: 'fresh' }, hostCtx());
    const byHost = new Map((await episodes()).map((e) => [e.hostId, e]));
    expect(byHost.get('orca1')!.endedAt).not.toBeNull();
    expect(byHost.get('orca2')!.endedAt).toBeNull();
    expect(await evaluateStaleSweeps(db, later(4))).toHaveLength(0);
    expect(await evaluateStaleSweeps(db, later(13))).toHaveLength(1); // orca1 silent again: a new episode
    expect(await alarms()).toHaveLength(3);
  });

  it('a host whose clock runs slow does not re-alarm after every run: staleness is the server\'s recorded time (#4255 Braxton P2-1)', async () => {
    await setMode('OBSERVE');
    for (let i = 0; i < 4; i++) {
      await record({ runId: `slow${i}`, startedAt: ago(8), endedAt: ago(7) });
      expect(await evaluateStaleSweeps(db, new Date())).toHaveLength(0);
    }
    expect(await alarms()).toHaveLength(0);
  });

  it('a run that commits while the raise waits on the registration lock is seen, so no alarm follows it (#4255 Braxton P3-2)', async () => {
    await setMode('OBSERVE');
    // orca1 registered long ago and never ran: stale until the in-flight run below commits.
    await db.hostRegistration.updateMany({ where: { appId: app.id, hostId: 'orca1' }, data: { registeredAt: ago(10) } });
    const c = validateSweepRun(run({ runId: 'inflight' }) as any, new Date());
    if (!c.ok) throw new Error(c.message);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let inserted!: () => void;
    const insertedP = new Promise<void>((r) => { inserted = r; });
    const writer = db.$transaction(async (tx) => { await insertSweepRun(tx, app.id, 'orca1', c.run); inserted(); await gate; });
    await insertedP;
    const pass = evaluateStaleSweeps(db, new Date());
    await new Promise((r) => setTimeout(r, 800)); // the raise for orca1 is now waiting on the registration row
    release();
    await Promise.all([writer, pass]);
    expect(await alarms()).toHaveLength(0);
  });

  it('a host that ran long ago gets the grace of a fresh switch-on: no alarm in the minute the mode comes back on (#4255 Diego)', async () => {
    await record({ runId: 'yesterday' });
    await db.$executeRaw`UPDATE host_sweep_runs SET recorded_at = recorded_at - interval '1 day'`;
    await setMode('OBSERVE');
    await db.agentTeamEvent.create({ data: { appId: app.id, type: 'team.sweep-mode-changed', payload: { from: 'OFF', to: 'OBSERVE' } } });
    expect(await evaluateStaleSweeps(db, new Date())).toHaveLength(0);
    expect((await alarms()).filter((e) => (e.payload as any).hostId === 'orca1')).toHaveLength(0);
    expect(await evaluateStaleSweeps(db, later(6))).toHaveLength(2);
  });

  it('raises nothing inside five minutes or with the sweep mode OFF', async () => {
    await record({ runId: 'recent' });
    await setMode('OBSERVE');
    expect(await evaluateStaleSweeps(db, later(4))).toHaveLength(0);
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

  it('the alarm\'s end is read from its episode', async () => {
    await setMode('OBSERVE');
    await evaluateStaleSweeps(db, later(6));
    await record({ runId: 'fresh' });
    const { alarmEpisodeEnds } = await import('../../../lib/agentTasks/stall.js');
    const a = (await alarms()).find((e) => (e.payload as any).hostId === 'orca1')!;
    const ends = await alarmEpisodeEnds(db, [{ id: a.id, appId: a.appId, taskId: null, type: a.type, episodeStart: null, raisedAt: a.createdAt }], new Date());
    expect(ends.get(a.id)).toBeInstanceOf(Date);
  });
});
