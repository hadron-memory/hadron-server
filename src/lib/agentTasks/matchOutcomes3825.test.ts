/** #3825: the latest decided match outcome per App and combination (cor:agt:060:13, V37/V44). */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import { __matcherTesting, matchQueuedTasks, matchTaskNow } from './matcher.js';
import { lockWorkersForAssignment } from './workerLock.js';
import { declareAllStopLanes } from '../../test/stopLanes.js';
import { combinationsOf, decisionClock, latestMatchOutcomes, purgeMatchOutcomes, recordMatchOutcome } from './matchOutcomes.js';
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
let app: any, other: any, owner: any, agent: any, ctx: any;
beforeEach(async () => {
  await cleanDb(db);
  process.env.DISABLE_TASK_MATCHER = 'true';
  const n = generateId();
  owner = await db.user.create({ data: { handle: `mo-${n}` } });
  const org = await db.organization.create({ data: { name: 'Outcomes', urn: `mo-${n}.example` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'ADMIN' } });
  ctx = { db, userId: owner.id, roles: ['READER'] };
  agent = await M.createAgent({}, { orgId: org.id, name: 'Team' }, ctx);
  app = await db.app.create({ data: { organizationId: org.id, name: 'A', urn: `${org.urn}:a` } });
  other = await db.app.create({ data: { organizationId: org.id, name: 'B', urn: `${org.urn}:b` } });
});
afterEach(() => { delete process.env.DISABLE_TASK_MATCHER; });
async function worker(role = 'reviewer', family = 'claude') {
  const name = `W${generateId().slice(-6)}`;
  const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), role } });
  await db.session.create({ data: { id: generateId(), appId: app.id, workerId: w.id, agentId: agent.id, role, family, llmModel: 'claude-sonnet-5-5', startedAt: new Date(), updatedAt: new Date() } });
  return w;
}
const create = (input: any = {}, appId = app.id) => M.createAgentTask({}, { input: { appRef: appId, title: 'T', ...input } }, ctx);
const latest = (opts: any = { windowHours: 24 }, appId = app.id) => latestMatchOutcomes(db, appId, opts);

it('a match that finds nobody records NO_WORKER with the coarse reason and the DB time', async () => {
  const t = await create({ match: true, requirements: { role: 'reviewer' } });
  expect(t.matchFailedReason).toBe('NO_ROLE');
  const rows = await latest();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ family: null, tier: null, role: 'reviewer', outcome: 'NO_WORKER', reason: 'NO_ROLE' });
  expect(rows[0].failingSince).toBeInstanceOf(Date);
  expect(Math.abs(rows[0].decidedAt.getTime() - Date.now())).toBeLessThan(60_000);
});

it('a later success clears the streak: the latest is MATCHED against each named combination, none included', async () => {
  await create({ match: true, requirements: { role: 'reviewer', familyIn: ['claude', 'codex'] } });
  expect((await latest()).map(r => [r.family, r.outcome])).toEqual([['claude', 'NO_WORKER'], ['codex', 'NO_WORKER']]);
  await worker('reviewer', 'claude');
  const t = await create({ match: true, requirements: { role: 'reviewer', familyIn: ['claude', 'codex'] } });
  expect(t.assigneeWorkerId).not.toBeNull();
  const rows = await latest();
  expect(rows.map(r => [r.family, r.role, r.outcome, r.failingSince])).toEqual([['claude', 'reviewer', 'MATCHED', null], ['claude', 'reviewer', 'MATCHED', null], ['codex', 'reviewer', 'MATCHED', null]]); // the middle one is the chosen worker's own (claude, mid, reviewer), V37
});

it('the open-tier case: a failing open-tier task, then a same-shape match: the tier-null row is MATCHED, streak cleared', async () => {
  await create({ match: true, requirements: { role: 'reviewer' } });
  expect((await latest({ windowHours: 24, tier: null }))[0]).toMatchObject({ outcome: 'NO_WORKER' });
  await worker('reviewer');
  await create({ match: true, requirements: { role: 'reviewer' } });
  const [r] = await latest({ windowHours: 24, tier: null });
  expect(r).toMatchObject({ role: 'reviewer', tier: null, outcome: 'MATCHED', failingSince: null, reason: null });
});

it('requirements naming two roles, nobody free: each combination records NO_WORKER', async () => {
  await create({ match: true, requirements: { roles: ['engineer', 'reviewer'] } });
  expect((await latest()).map(r => [r.role, r.outcome])).toEqual([['engineer', 'NO_WORKER'], ['reviewer', 'NO_WORKER']]);
});

it('combinations do not shadow each other, and an App never reads another App\'s rows', async () => {
  await create({ match: true, requirements: { role: 'engineer' } });
  await worker('reviewer');
  await create({ match: true, requirements: { role: 'reviewer' } });
  expect((await latest()).map(r => [r.role, r.outcome])).toEqual([['engineer', 'NO_WORKER'], ['reviewer', 'MATCHED'], ['reviewer', 'MATCHED']]); // the second reviewer row is the chosen worker's own combination
  expect(await latest({ windowHours: 24 }, other.id)).toEqual([]);
  expect(await latest({ windowHours: 24, role: 'engineer' })).toHaveLength(1);
});

it('a failing streak keeps its first failure time across further failures', async () => {
  await create({ match: true, requirements: { role: 'engineer' } });
  const [first] = await latest();
  await create({ match: true, requirements: { role: 'engineer' } });
  const [second] = await latest();
  expect(second.failingSince?.getTime()).toBe(first.failingSince?.getTime());
  expect(second.decidedAt.getTime()).toBeGreaterThanOrEqual(first.decidedAt.getTime());
});

it('the queued sweep records nobody-free and, on assignment, MATCHED', async () => {
  const t = await create({ requirements: { role: 'reviewer' } });
  await matchQueuedTasks(db, new Date(), { appId: app.id });
  expect((await latest())[0]).toMatchObject({ role: 'reviewer', outcome: 'NO_WORKER', reason: 'NOBODY_FREE' });
  const w = await worker('reviewer');
  await matchQueuedTasks(db, new Date(), { appId: app.id });
  expect((await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).assigneeWorkerId).toBe(w.id);
  expect((await latest())[0]).toMatchObject({ outcome: 'MATCHED', failingSince: null });
});

it('the sweep records nobody-free when a free worker exists but fits no requirement', async () => {
  await worker('reviewer');
  await create({ requirements: { role: 'engineer' } });
  await matchQueuedTasks(db, new Date(), { appId: app.id });
  expect((await latest())[0]).toMatchObject({ role: 'engineer', outcome: 'NO_WORKER', reason: 'NOBODY_FREE' });
});

it('a failure whose guarded mark lost the reservation records nothing', async () => {
  const t = await create({ requirements: { role: 'engineer' } });
  await db.agentTask.update({ where: { id: t.id }, data: { matchPending: true } });
  const spy = vi.spyOn(db.agentTask, 'updateMany').mockResolvedValueOnce({ count: 0 });
  await matchTaskNow(db, t.id, new Date());
  spy.mockRestore();
  expect(await latest()).toEqual([]);
});

it('a match whose claim moved, or an interrupted one not yet recovered, records nothing', async () => {
  const t = await create({ requirements: { role: 'engineer' } });
  await db.agentTask.update({ where: { id: t.id }, data: { matchPending: true, createdAt: new Date(Date.now() - 3600_000) } });
  // not recovered yet: nothing
  expect(await latest()).toEqual([]);
  // an attempt whose claim state moved (a sweep took the task) neither starts nor writes
  await db.agentTask.update({ where: { id: t.id }, data: { matchClaimedAt: new Date(Date.now() - 1000) } });
  await matchTaskNow(db, t.id, new Date(), new Date(Date.now() - 5000));
  expect(await latest()).toEqual([]);
  // the same attempt with the right claim does decide
  await matchTaskNow(db, t.id, new Date(), (await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).matchClaimedAt!);
  expect((await latest())[0]).toMatchObject({ role: 'engineer', outcome: 'NO_WORKER' });
});

it('the stored per-task mark is unchanged and nothing per candidate is kept', async () => {
  const t = await create({ match: true, requirements: { role: 'engineer' } });
  expect(await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ matchFailedReason: 'NO_ROLE' });
  const cols = await db.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_match_outcomes'`;
  expect(cols.map(c => c.column_name).sort()).toEqual(['app_id', 'decided_at', 'failing_since', 'family', 'outcome', 'reason', 'role', 'tier']);
});

it('rows past 168 h are purged; a 24 h window ignores older rows', async () => {
  await create({ match: true, requirements: { role: 'engineer' } });
  await create({ match: true, requirements: { role: 'designer' } });
  await db.$executeRaw`UPDATE agent_match_outcomes SET decided_at = decided_at - interval '30 hours' WHERE role = 'engineer'`;
  expect((await latest()).map(r => r.role)).toEqual(['designer']);
  expect((await latest({ windowHours: 48 })).map(r => r.role)).toEqual(['designer', 'engineer']);
  await db.$executeRaw`UPDATE agent_match_outcomes SET decided_at = decided_at - interval '170 hours' WHERE role = 'engineer'`;
  expect(await purgeMatchOutcomes(db)).toBe(1);
  expect(await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM agent_match_outcomes`).toEqual([{ n: 1n }]);
});

// ── George's blind review of 34fc668f (P2-1..4, P3-5/6) ───────────────────────────────────────────────────────────────
afterEach(() => { __matcherTesting.setQueuePage(500); });

it('P2-1: a task whose creator is under a pause records no outcome, even with no free candidate', async () => {
  const creator = await worker('reviewer');
  await declareAllStopLanes(db, app.id);
  await M.setTeamStopSignal({}, { input: { appRef: app.id, level: 'PAUSE', scope: 'WORKER', worker: creator.id } }, ctx);
  const t = await create({ requirements: { role: 'engineer' } });
  await db.agentTask.update({ where: { id: t.id }, data: { createdByWorkerId: creator.id } });
  await matchQueuedTasks(db, new Date(), { appId: app.id });
  expect(await latest()).toEqual([]);
  // control: the same task of a creator under no signal is a decided failure
  await M.liftTeamStopSignal({}, { appRef: app.id, id: (await (resolvers.Query as any).teamStopSignals({}, { appRef: app.id }, ctx)).signals[0].id }, ctx);
  await matchQueuedTasks(db, new Date(), { appId: app.id });
  expect((await latest())[0]).toMatchObject({ role: 'engineer', outcome: 'NO_WORKER' });
});

it('P2-2: a combination only a later page names is recorded when candidates are exhausted', async () => {
  __matcherTesting.setQueuePage(2);
  await create({ requirements: { role: 'a' } });
  await create({ requirements: { role: 'b' } });
  await create({ requirements: { role: 'c' } });
  await create({ requirements: { role: 'd' } });
  await matchQueuedTasks(db, new Date(), { appId: app.id });
  expect((await latest()).map(r => r.role)).toEqual(['a', 'b', 'c', 'd']);
});

it('P2-3: a purge that waited on a row a matcher refreshed does not delete it', async () => {
  await create({ match: true, requirements: { role: 'engineer' } });
  await db.$executeRaw`UPDATE agent_match_outcomes SET decided_at = decided_at - interval '170 hours'`;
  let purged = -1;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE agent_match_outcomes SET decided_at = (clock_timestamp() AT TIME ZONE 'UTC') WHERE role = 'engineer'`;
    const p = purgeMatchOutcomes(db).then(n => { purged = n; });
    await new Promise(r => setTimeout(r, 400));
    expect(purged).toBe(-1); // still waiting on the lock
    void p;
  });
  await new Promise(r => setTimeout(r, 400));
  expect(purged).toBe(0);
  expect(await latest()).toHaveLength(1);
});

it('P2-4: a failure decided before a success that landed first does not overwrite it', async () => {
  const t = await create({ requirements: { role: 'engineer' } });
  await db.agentTask.update({ where: { id: t.id }, data: { matchPending: true } });
  const spy = vi.spyOn(db.agentTask, 'updateMany').mockImplementationOnce((async () => {
    await new Promise(r => setTimeout(r, 10));
    await recordMatchOutcome(db, app.id, { role: 'engineer' }, 'MATCHED'); // another attempt succeeds meanwhile
    return { count: 1 };
  }) as any);
  await matchTaskNow(db, t.id, new Date());
  spy.mockRestore();
  expect((await latest())[0]).toMatchObject({ role: 'engineer', outcome: 'MATCHED', failingSince: null });
});

it('P2-4: the decision clock is what a late record carries', async () => {
  const t0 = await decisionClock(db);
  await new Promise(r => setTimeout(r, 10)); // distinct milliseconds: the column keeps ms and the later writer wins a tie
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'MATCHED');
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'NO_WORKER', 'NOBODY_FREE', t0);
  expect((await latest())[0]).toMatchObject({ role: 'x', outcome: 'MATCHED' });
});

it('P3-5: every named combination is recorded, not the first 64', () => {
  const roles = Array.from({ length: 70 }, (_, i) => `r${i}`);
  expect(combinationsOf({ roles })).toHaveLength(70);
});

it('P3-6: unusable requirements name no combination and record nothing', async () => {
  expect(combinationsOf({ invalid: true })).toEqual([]);
  const t = await create({ requirements: { role: 'engineer' } });
  await db.agentTask.update({ where: { id: t.id }, data: { matchPending: true, requirements: { maxTier: 'x' } } });
  await matchTaskNow(db, t.id, new Date());
  expect(await latest()).toEqual([]);
});

it('V37/V44: a match also counts against the chosen worker\'s own combination, clearing its saturated row', async () => {
  const w = await worker('reviewer', 'claude');
  // a real (claude, mid, reviewer) row saturated by an earlier no-worker answer
  await recordMatchOutcome(db, app.id, { role: 'reviewer', familyIn: ['claude'], minTier: 'mid' }, 'NO_WORKER', 'NOBODY_FREE');
  expect((await latest({ windowHours: 24, family: 'claude' }))[0]).toMatchObject({ tier: 'mid', outcome: 'NO_WORKER' });
  const t = await create({ match: true }); // unconstrained: names no combination
  expect(t.assigneeWorkerId).toBe(w.id);
  expect(await latest({ windowHours: 24, family: 'claude' })).toEqual([expect.objectContaining({ family: 'claude', tier: 'mid', role: 'reviewer', outcome: 'MATCHED', failingSince: null })]);
  expect(await latest({ windowHours: 24, family: null })).toEqual([expect.objectContaining({ family: null, tier: null, role: null, outcome: 'MATCHED' })]);
});

it('Rico P2-1: a MATCHED is not recorded when the guarded assignment lost the task', async () => {
  const w = await worker('reviewer');
  const t = await create({ requirements: { role: 'reviewer' } });
  const out = await __matcherTesting.tryAssign(db, { id: t.id, appId: app.id, requirements: { role: 'reviewer' }, closeSessionWhenDone: false } as any, w.id, 'claude', new Date(), {
    // the guarded update's own predicate (matchFailedAt: null) no longer holds when it runs
    afterWorkerCheck: async () => { await db.agentTask.update({ where: { id: t.id }, data: { matchFailedAt: new Date(), matchFailedReason: 'NOBODY_FREE' } }); },
  });
  expect(out).toBe('task-gone');
  expect(await latest()).toEqual([]);
});

it('Rico P3-1: an older MATCHED never overwrites a newer outcome', async () => {
  const t0 = await decisionClock(db);
  await new Promise(r => setTimeout(r, 10));
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'NO_WORKER', 'NOBODY_FREE');
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'MATCHED', null, t0);
  expect((await latest())[0]).toMatchObject({ role: 'x', outcome: 'NO_WORKER' });
});

it('Anne: an attempt that waited on the worker lock and then re-read nobody free is stamped AFTER the success that committed meanwhile', async () => {
  const w = await worker('reviewer');
  const t = await create({ requirements: { role: 'reviewer' } });
  await db.agentTask.update({ where: { id: t.id }, data: { matchPending: true } });
  let attempt: Promise<void> | null = null;
  await db.$transaction(async (tx) => {
    await lockWorkersForAssignment(tx, [w.id]);
    attempt = matchTaskNow(db, t.id, new Date()); // judges the snapshot (worker free), then waits on the lock
    await new Promise(r => setTimeout(r, 500));
    // meanwhile another attempt took the worker's place: its session ended and a MATCHED was recorded
    await tx.$executeRaw`UPDATE sessions SET ended_at = now() WHERE worker_id = ${w.id}`;
    await recordMatchOutcome(tx, app.id, { role: 'reviewer' }, 'MATCHED');
  });
  await attempt;
  expect((await latest({ windowHours: 24, family: null, role: 'reviewer' }))[0]).toMatchObject({ outcome: 'NO_WORKER', reason: 'NOBODY_FREE' });
});

it('George post-attempt gap: the stamp of a not-free re-read is taken inside the attempt, under the worker lock', async () => {
  const w = await worker('reviewer');
  const t = await create({ requirements: { role: 'reviewer' } });
  await db.$executeRaw`UPDATE sessions SET ended_at = now() WHERE worker_id = ${w.id}`; // not free any more
  const readAt: { at?: string } = {};
  const before = await decisionClock(db);
  const out = await __matcherTesting.tryAssign(db, { id: t.id, appId: app.id, requirements: { role: 'reviewer' }, closeSessionWhenDone: false } as any, w.id, 'claude', new Date(), {}, undefined, false, undefined, readAt);
  const after = await decisionClock(db);
  expect(out).toBe('worker-not-free');
  expect(readAt.at! >= before).toBe(true);
  expect(readAt.at! <= after).toBe(true);
});

it('Anne: roles are keyed case-insensitively and a write orders its rows globally', async () => {
  const w = await worker('REVIEWER', 'claude');
  await recordMatchOutcome(db, app.id, { role: 'reviewer', familyIn: ['claude'], minTier: 'mid' }, 'NO_WORKER', 'NOBODY_FREE');
  const t = await create({ match: true }); // the worker's role is spelled REVIEWER
  expect(t.assigneeWorkerId).toBe(w.id);
  const rows = await latest({ windowHours: 24, family: 'claude' });
  expect(rows).toHaveLength(1); // one row, not a reviewer and a REVIEWER
  expect(rows[0]).toMatchObject({ role: 'reviewer', outcome: 'MATCHED', failingSince: null });
  expect(combinationsOf({ roles: ['B', 'a', 'A'], familyIn: ['codex', 'claude'] }).map(c => [c.family, c.role])).toEqual([['claude', 'a'], ['claude', 'b'], ['codex', 'a'], ['codex', 'b']]);
});

it('Anne: role null selects the open-role row, undefined does not narrow, a role is matched case-insensitively', async () => {
  await create({ match: true, requirements: { role: 'engineer' } });
  await create({ match: true, requirements: {} });
  expect((await latest({ windowHours: 24 })).map(r => r.role)).toEqual([null, 'engineer']);
  expect((await latest({ windowHours: 24, role: null })).map(r => r.role)).toEqual([null]);
  expect((await latest({ windowHours: 24, role: 'ENGINEER' })).map(r => r.role)).toEqual(['engineer']);
});

it('Anne: a queued-sweep failure is stamped when it was judged, so a success that landed before its write stands', async () => {
  await worker('reviewer'); // a free candidate that fits no requirement: the loop path, no assignment
  await create({ requirements: { role: 'engineer' } });
  const original = db.$executeRaw.bind(db);
  const spy = vi.spyOn(db, '$executeRaw').mockImplementationOnce(((...args: any[]) =>
    // the sweep's failure write is delayed past another attempt's success for the same combination
    new Promise(r => setTimeout(r, 10)).then(() => recordMatchOutcome(db, app.id, { role: 'engineer' }, 'MATCHED')).then(() => (original as any)(...args))) as any);
  await matchQueuedTasks(db, new Date(), { appId: app.id });
  spy.mockRestore();
  expect((await latest({ windowHours: 24, role: 'engineer' }))[0]).toMatchObject({ outcome: 'MATCHED', failingSince: null });
});

it('George/Anne: an assignment reports its in-transaction time too, so the sweep basis never uses a post-return clock', async () => {
  const w = await worker('reviewer');
  const t = await create({ requirements: { role: 'reviewer' } });
  const readAt: { at?: string } = {};
  const before = await decisionClock(db);
  const out = await __matcherTesting.tryAssign(db, { id: t.id, appId: app.id, requirements: { role: 'reviewer' }, closeSessionWhenDone: false } as any, w.id, 'claude', new Date(), {}, undefined, false, undefined, readAt);
  const after = await decisionClock(db);
  expect(out).toBe('assigned');
  expect(readAt.at! >= before).toBe(true);
  expect(readAt.at! <= after).toBe(true);
});

it('George/Anne: after the pass assigned one worker, an exhausted later task\'s failure still lands after that assignment\'s MATCHED', async () => {
  await worker('reviewer');
  await create({ requirements: { role: 'reviewer' } });
  await create({ requirements: { role: 'reviewer' } });
  await matchQueuedTasks(db, new Date(), { appId: app.id });
  const [r] = await latest({ windowHours: 24, role: 'reviewer', family: null });
  expect(r).toMatchObject({ outcome: 'NO_WORKER', reason: 'NOBODY_FREE' }); // the second task was judged after the first took the worker
});

it('George P2 (same ms): stamps carry microseconds, so equal-millisecond decisions are still ordered, both directions', async () => {
  const base = (await decisionClock(db)).slice(0, -1);
  const [t1, t2] = [`${base}1`, `${base}2`]; // one millisecond, two microseconds
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'MATCHED', null, t2);
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'NO_WORKER', 'NOBODY_FREE', t1); // older decision, written later
  expect((await latest())[0]).toMatchObject({ role: 'x', outcome: 'MATCHED' });
  await recordMatchOutcome(db, app.id, { role: 'y' }, 'NO_WORKER', 'NOBODY_FREE', t2);
  await recordMatchOutcome(db, app.id, { role: 'y' }, 'MATCHED', null, t1);
  expect((await latest({ windowHours: 24, role: 'y' }))[0]).toMatchObject({ role: 'y', outcome: 'NO_WORKER' });
  const [row] = await db.$queryRaw<{ s: string }[]>`SELECT to_char(decided_at, 'US') AS s FROM agent_match_outcomes WHERE role = 'x'`;
  expect(row.s).toBe(t2.slice(-6)); // stored to the microsecond
});

it('Anne 94656: another role\'s assignment in the pass does not make an engineer failure newer than a success that landed meanwhile', async () => {
  await worker('reviewer');
  await create({ requirements: { role: 'reviewer' } }); // first in the queue: takes the only worker
  await create({ requirements: { role: 'engineer' } }); // then judged: nobody free for engineer, on the pass's snapshot
  await matchQueuedTasks(db, new Date(), {
    appId: app.id,
    hooks: { // while the reviewer assignment is paused before its in-transaction stamp, an engineer success commits elsewhere
      afterWorkerCheck: async () => { await new Promise(r => setTimeout(r, 5)); await recordMatchOutcome(db, app.id, { role: 'engineer' }, 'MATCHED'); },
    },
  });
  expect((await latest({ windowHours: 24, role: 'engineer' }))[0]).toMatchObject({ role: 'engineer', outcome: 'MATCHED', failingSince: null });
});
