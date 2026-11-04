/**
 * #3246 (cor:agt:060:10, "A crash before the one attempt", ruling 0085 A): a task created with match now is held back
 * (`matchPending`) from every other run until its own attempt ends. If the platform dies between the create commit and
 * that attempt, the sweep releases the task after a fixed, tunable time and makes the one attempt then. Every instant is
 * passed explicitly, so the controllable clock is the `now` argument.
 */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import { recoverInterruptedMatches, matchRecoverySeconds, matchQueuedTasks, matchTaskNow } from './matcher.js';
import { taskMatcherTick } from '../../jobs/taskMatcher.js';

const M = resolvers.Mutation as any;
const MIN = 60_000;
const T0 = new Date('2026-11-04T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
let app: any, owner: any, agent: any, ctx: any;

beforeEach(async () => {
  await cleanDb(db);
  delete process.env.MATCH_AT_CREATE_RECOVERY_SECONDS;
  process.env.DISABLE_TASK_MATCHER = 'true';
  const n = generateId();
  owner = await db.user.create({ data: { handle: `mr-${n}` } });
  const org = await db.organization.create({ data: { name: 'Match recovery', urn: `mr-${n}.example` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'ADMIN' } });
  ctx = { db, userId: owner.id, roles: ['READER'] };
  agent = await M.createAgent({}, { orgId: org.id, name: 'Team' }, ctx);
  app = await db.app.create({ data: { organizationId: org.id, name: 'Match', urn: `${org.urn}:app` } });
});
afterEach(() => { delete process.env.DISABLE_TASK_MATCHER; delete process.env.MATCH_AT_CREATE_RECOVERY_SECONDS; });

async function worker(name = 'Reviewer', role = 'reviewer') {
  const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), role } });
  await db.session.create({ data: { id: generateId(), appId: app.id, workerId: w.id, agentId: agent.id, role, family: 'claude', llmModel: 'claude-sonnet-5-5', startedAt: T0, updatedAt: T0 } });
  return w;
}
/** The interrupted attempt: the create committed with its reservation, and the attempt never ran. */
const interrupted = (extra: Record<string, unknown> = {}, createdAt = T0) =>
  db.agentTask.create({ data: { appId: app.id, title: 'Interrupted', ownerUserId: owner.id, status: 'pending', matchPending: true, createdAt, ...extra } });
const row = (id: string) => db.agentTask.findUniqueOrThrow({ where: { id } });
const BOUND = 300 * 1000;

it('releases a reservation older than the bound and makes the one attempt: assigned when a worker is free', async () => {
  const w = await worker();
  const t = await interrupted({ requirements: { role: 'reviewer' } });
  expect(await recoverInterruptedMatches(db, at(BOUND))).toBe(1);
  expect(await row(t.id)).toMatchObject({ assigneeWorkerId: w.id, matchPending: false, matchFailedAt: null, matchFailedReason: null });
  expect(await db.agentTeamEvent.count({ where: { taskId: t.id, type: 'assignment.matched' } })).toBe(1);
});

it('or marks it match-failed with one of the five existing reasons, and never retries it', async () => {
  const t = await interrupted({ requirements: { role: 'reviewer' } }); // nobody has the role
  expect(await recoverInterruptedMatches(db, at(BOUND))).toBe(1);
  const failed = await row(t.id);
  expect(failed).toMatchObject({ assigneeWorkerId: null, matchPending: false, matchFailedReason: 'NO_ROLE' });
  expect(failed.matchFailedAt).toBeInstanceOf(Date);
  await worker(); // a worker appears afterwards: still never retried, by the sweep or the matcher
  expect(await recoverInterruptedMatches(db, at(BOUND * 3))).toBe(0);
  expect(await matchQueuedTasks(db, at(BOUND * 3), { appId: app.id })).toEqual([]);
  expect((await row(t.id)).assigneeWorkerId).toBeNull();
});

it('a reservation younger than the bound is never touched, and is attempted at the bound (controllable clock)', async () => {
  const w = await worker();
  const t = await interrupted();
  expect(await recoverInterruptedMatches(db, at(BOUND - 1))).toBe(0);
  expect(await row(t.id)).toMatchObject({ matchPending: true, assigneeWorkerId: null, matchFailedAt: null });
  expect(await recoverInterruptedMatches(db, at(BOUND))).toBe(1);
  expect((await row(t.id)).assigneeWorkerId).toBe(w.id);
});

it('concurrent sweeps make exactly one attempt between them (guarded claim on the reservation)', async () => {
  await interrupted({ requirements: { role: 'nobody' } }); // a failing attempt: the guarded mark alone could not tell one attempt from two
  const counts = await Promise.all([recoverInterruptedMatches(db, at(BOUND)), recoverInterruptedMatches(db, at(BOUND)), recoverInterruptedMatches(db, at(BOUND))]);
  expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
});

it('a claim whose attempt itself died is reclaimable only after the bound again; a fresh claim is not', async () => {
  const t = await interrupted({ requirements: { role: 'nobody' }, matchClaimedAt: at(BOUND) });
  expect(await recoverInterruptedMatches(db, at(BOUND + 1000))).toBe(0);
  expect(await recoverInterruptedMatches(db, at(BOUND * 2))).toBe(1);
  expect((await row(t.id)).matchFailedReason).toBe('NO_ROLE');
});

it('a task that was never reserved is byte-identical: queued stays queued, and ordinary matching still assigns it', async () => {
  const w = await worker();
  const ordinary = await db.agentTask.create({ data: { appId: app.id, title: 'Ordinary', ownerUserId: owner.id, status: 'pending', createdAt: T0 } });
  const before = await row(ordinary.id);
  expect(await recoverInterruptedMatches(db, at(BOUND * 10))).toBe(0);
  expect(await row(ordinary.id)).toEqual(before);
  expect((await matchQueuedTasks(db, at(BOUND * 10), { appId: app.id })).length).toBe(1);
  expect((await row(ordinary.id)).assigneeWorkerId).toBe(w.id);
});

it('a cleared reservation is never swept: parked then ready, assigned by hand, or cancelled', async () => {
  const w = await worker();
  const parked = await interrupted({}, T0);
  await M.parkAgentTask({}, { taskId: parked.id }, ctx);
  expect(await recoverInterruptedMatches(db, at(BOUND * 2))).toBe(0); // backlog: not pending
  await M.makeAgentTaskReady({}, { taskId: parked.id }, ctx);
  expect((await row(parked.id)).matchPending).toBe(false); // ready clears it
  const manual = await interrupted();
  await M.assignAgentTask({}, { taskId: manual.id, assignee: { worker: w.id } }, ctx);
  const cancelled = await interrupted();
  await M.cancelAgentTask({}, { taskId: cancelled.id }, ctx);
  expect(await recoverInterruptedMatches(db, at(BOUND * 2))).toBe(0);
  expect((await row(manual.id)).assigneeWorkerId).toBe(w.id);
  expect((await row(cancelled.id)).status).toBe('cancelled');
});

it('the bound is a per-call-read setting with a safe default, and invalid values fall back', async () => {
  expect(matchRecoverySeconds()).toBe(300);
  process.env.MATCH_AT_CREATE_RECOVERY_SECONDS = '120';
  expect(matchRecoverySeconds()).toBe(120);
  for (const bad of ['0', '-5', '59', '86401', '1.5', 'abc', '']) {
    process.env.MATCH_AT_CREATE_RECOVERY_SECONDS = bad;
    expect(matchRecoverySeconds(), bad).toBe(300);
  }
  const t = await interrupted();
  process.env.MATCH_AT_CREATE_RECOVERY_SECONDS = '120';
  expect(await recoverInterruptedMatches(db, at(120 * 1000))).toBe(1); // read at the call, not at boot
  expect((await row(t.id)).matchPending).toBe(false);
});

it('the matcher tick runs the recovery and reports it', async () => {
  await worker();
  await interrupted();
  expect((await taskMatcherTick(db, at(BOUND))).recovered).toBe(1);
});

// ── the claim is a token: a superseded attempt neither starts nor writes (Beckett's blind P2 on #3417) ──
/** A client whose first task read is followed by a later sweep's reclaim: the claim is superseded MID-ATTEMPT. */
const supersededMidAttempt = (taskId: string, current: Date) => db.$extends({ query: { agentTask: {
  async findUniqueOrThrow({ args, query }: any) {
    const read = await query(args);
    await db.agentTask.update({ where: { id: taskId }, data: { matchClaimedAt: current } });
    return read;
  },
} } }) as unknown as typeof db;

it('a claimant superseded before it starts neither starts nor writes', async () => {
  const w = await worker();
  const stale = at(BOUND), current = at(BOUND * 2);
  const t = await interrupted({ requirements: { role: 'reviewer' }, matchClaimedAt: current }); // a later sweep reclaimed it
  await matchTaskNow(db, t.id, at(BOUND * 2 + 1000), stale);
  expect(await row(t.id)).toMatchObject({ assigneeWorkerId: null, matchPending: true, matchFailedAt: null, matchClaimedAt: current });
  expect(await db.agentTeamEvent.count({ where: { taskId: t.id, type: 'assignment.matched' } })).toBe(0);
  await matchTaskNow(db, t.id, at(BOUND * 2 + 1000), current); // the current holder is the one attempt
  expect(await row(t.id)).toMatchObject({ assigneeWorkerId: w.id, matchPending: false });
  expect(await db.agentTeamEvent.count({ where: { taskId: t.id, type: 'assignment.matched' } })).toBe(1);
});

it('a claimant superseded mid-attempt cannot assign: the guarded write holds the token', async () => {
  await worker();
  const stale = at(BOUND), current = at(BOUND * 2);
  const t = await interrupted({ requirements: { role: 'reviewer' }, matchClaimedAt: stale });
  await matchTaskNow(supersededMidAttempt(t.id, current), t.id, at(BOUND * 2 + 1000), stale);
  expect(await row(t.id)).toMatchObject({ assigneeWorkerId: null, matchPending: true, matchClaimedAt: current });
  expect(await db.agentTeamEvent.count({ where: { taskId: t.id, type: 'assignment.matched' } })).toBe(0);
});

it('a claimant superseded mid-attempt cannot record a failure either', async () => {
  const stale = at(BOUND), current = at(BOUND * 2);
  const t = await interrupted({ requirements: { role: 'nobody' }, matchClaimedAt: stale });
  await matchTaskNow(supersededMidAttempt(t.id, current), t.id, at(BOUND * 2 + 1000), stale);
  expect(await row(t.id)).toMatchObject({ matchPending: true, matchFailedAt: null, matchFailedReason: null, matchClaimedAt: current });
  await matchTaskNow(db, t.id, at(BOUND * 2 + 1000), current);
  expect(await row(t.id)).toMatchObject({ matchPending: false, matchFailedReason: 'NO_ROLE' });
});

// ── the create-time attempt holds the UNCLAIMED state (Atilla's local P2 on #3417) ──
it('the create-time attempt (no claim) does not start once a sweep has claimed the task', async () => {
  await worker();
  const t = await interrupted({ requirements: { role: 'reviewer' }, matchClaimedAt: at(BOUND) });
  await matchTaskNow(db, t.id, at(BOUND + 1000)); // the original three-argument call
  expect(await row(t.id)).toMatchObject({ assigneeWorkerId: null, matchPending: true, matchFailedAt: null, matchClaimedAt: at(BOUND) });
  expect(await db.agentTeamEvent.count({ where: { taskId: t.id, type: 'assignment.matched' } })).toBe(0);
});

it('a create-time attempt that a sweep claims mid-attempt cannot assign', async () => {
  await worker();
  const t = await interrupted({ requirements: { role: 'reviewer' } });
  await matchTaskNow(supersededMidAttempt(t.id, at(BOUND)), t.id, at(BOUND + 1000));
  expect(await row(t.id)).toMatchObject({ assigneeWorkerId: null, matchPending: true, matchClaimedAt: at(BOUND) });
  expect(await db.agentTeamEvent.count({ where: { taskId: t.id, type: 'assignment.matched' } })).toBe(0);
});

it('a create-time attempt that a sweep claims mid-attempt cannot record a failure', async () => {
  const t = await interrupted({ requirements: { role: 'nobody' } });
  await matchTaskNow(supersededMidAttempt(t.id, at(BOUND)), t.id, at(BOUND + 1000));
  expect(await row(t.id)).toMatchObject({ matchPending: true, matchFailedAt: null, matchFailedReason: null, matchClaimedAt: at(BOUND) });
});

it('and the create-time attempt still wins an unclaimed reservation, as before', async () => {
  const w = await worker();
  const t = await interrupted({ requirements: { role: 'reviewer' } });
  await matchTaskNow(db, t.id, at(1000));
  expect(await row(t.id)).toMatchObject({ assigneeWorkerId: w.id, matchPending: false });
});

it('the sweep itself carries its claim: a reclaim landing mid-attempt stops the sweep\'s attempt from writing', async () => {
  await worker();
  const t = await interrupted({ requirements: { role: 'reviewer' } });
  const later = at(BOUND * 3);
  expect(await recoverInterruptedMatches(supersededMidAttempt(t.id, later), at(BOUND))).toBe(1);
  expect(await row(t.id)).toMatchObject({ assigneeWorkerId: null, matchPending: true, matchClaimedAt: later });
});

it('an attempt that throws leaves its claim; nothing retries it inside the bound, and one reclaim finishes it after', async () => {
  const w = await worker();
  const t = await interrupted({ requirements: { role: 'reviewer' } });
  const boom = db.$extends({ query: { agentTask: { async findUniqueOrThrow() { throw new Error('boom'); } } } }) as unknown as typeof db;
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await recoverInterruptedMatches(boom, at(BOUND))).toBe(1); // claimed, then the attempt died
  } finally { quiet.mockRestore(); }
  expect(await row(t.id)).toMatchObject({ matchPending: true, assigneeWorkerId: null, matchClaimedAt: at(BOUND) });
  expect(await recoverInterruptedMatches(db, at(BOUND * 2 - 1))).toBe(0); // inside the bound: no second attempt
  expect(await recoverInterruptedMatches(db, at(BOUND * 2))).toBe(1); // after it: exactly one reclaim, which completes
  expect((await row(t.id)).assigneeWorkerId).toBe(w.id);
  expect(await recoverInterruptedMatches(db, at(BOUND * 3))).toBe(0);
});
