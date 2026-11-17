/**
 * #3825 follow-up (6773996134, Gizelle's blind finding on #3861): `failingSince` under out-of-order arrival.
 * cor:agt:060:13: "when the current run of no-worker outcomes began, cleared by a match", judged by DECISION time,
 * which is what `decided_at` carries, not by when the write landed.
 */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import { matchTaskNow } from './matcher.js';
import { decisionClock, latestMatchOutcomes, recordMatchOutcome } from './matchOutcomes.js';
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
let app: any, ctx: any;
beforeEach(async () => {
  await cleanDb(db);
  process.env.DISABLE_TASK_MATCHER = 'true';
  const n = generateId();
  const owner = await db.user.create({ data: { handle: `mso-${n}` } });
  const org = await db.organization.create({ data: { name: 'Order', urn: `mso-${n}.example` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'ADMIN' } });
  ctx = { db, userId: owner.id, roles: ['READER'] };
  app = await db.app.create({ data: { organizationId: org.id, name: 'A', urn: `${org.urn}:a` } });
});
afterEach(() => { delete process.env.DISABLE_TASK_MATCHER; });
const tick = () => new Promise(r => setTimeout(r, 5));
const row = async () => (await latestMatchOutcomes(db, app.id, { windowHours: 24, role: 'x' }))[0];
const asDate = (i: string) => new Date(`${i.replace(' ', 'T')}Z`);

it('a success decided between two failures but written after both ends the streak: it restarts at the later failure', async () => {
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'NO_WORKER', 'NOBODY_FREE'); // F at t1
  await tick();
  const t2 = await decisionClock(db); // S decided at t2, its write delayed
  await tick();
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'NO_WORKER', 'NOBODY_FREE'); // F at t3
  const t3 = (await row()).decidedAt;
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'MATCHED', null, t2); // S lands last
  const r = await row();
  expect(r.outcome).toBe('NO_WORKER'); // the latest decision is still t3's failure
  expect(r.failingSince!.getTime()).toBeGreaterThan(asDate(t2).getTime()); // the streak began after the success
  expect(r.failingSince!.getTime()).toBe(t3.getTime());
});

it('an earlier failure written after a later one establishes the true streak start', async () => {
  const t1 = await decisionClock(db); // F decided at t1, its write delayed
  await tick();
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'NO_WORKER', 'NOBODY_FREE'); // F at t3 lands first
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'NO_WORKER', 'NOBODY_FREE', t1); // F at t1 lands last
  const r = await row();
  expect(r.outcome).toBe('NO_WORKER');
  expect(r.failingSince!.getTime()).toBe(asDate(t1).getTime());
});

it('reachable through matchTaskNow: its failure, decided at the snapshot, lands after a sweep failure judged later', async () => {
  const t = await M.createAgentTask({}, { input: { appRef: app.id, title: 'T', requirements: { role: 'x' } } }, ctx);
  await db.agentTask.update({ where: { id: t.id }, data: { matchPending: true } });
  const spy = vi.spyOn(db.agentTask, 'updateMany').mockImplementationOnce((async () => {
    await tick();
    await recordMatchOutcome(db, app.id, { role: 'x' }, 'NO_WORKER', 'NOBODY_FREE'); // the sweep's failure, judged later, lands first
    return { count: 1 };
  }) as any);
  const before = new Date();
  await matchTaskNow(db, t.id, new Date());
  spy.mockRestore();
  const r = await row();
  expect(r.outcome).toBe('NO_WORKER');
  // matchTaskNow decided before the sweep did; the streak began at its decision, not at the sweep's.
  expect(r.failingSince!.getTime()).toBeLessThan(r.decidedAt.getTime());
  expect(r.failingSince!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
});

it('a late failure decided before the last known match is not part of the current streak', async () => {
  const t1 = await decisionClock(db); // F decided at t1, written last
  await tick();
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'MATCHED'); // S at t2
  await tick();
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'NO_WORKER', 'NOBODY_FREE'); // F at t3: streak starts here
  const start = (await row()).failingSince!.getTime();
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'NO_WORKER', 'NOBODY_FREE', t1);
  const r = await row();
  expect(r.failingSince!.getTime()).toBe(start);
  expect(r.failingSince!.getTime()).toBeGreaterThan(asDate(t1).getTime());
});

it('a late success decided before the streak began leaves the streak alone', async () => {
  const t0 = await decisionClock(db); // S decided at t0, written last
  await tick();
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'NO_WORKER', 'NOBODY_FREE'); // F at t1
  await tick();
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'NO_WORKER', 'NOBODY_FREE'); // F at t2
  const before = await row();
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'MATCHED', null, t0);
  const r = await row();
  expect(r).toMatchObject({ outcome: 'NO_WORKER', reason: 'NOBODY_FREE' });
  expect(r.failingSince!.getTime()).toBe(before.failingSince!.getTime());
  expect(r.decidedAt.getTime()).toBe(before.decidedAt.getTime());
});

it('the documented bound: failures folded before a late success are not recoverable, so the restart is the latest one', async () => {
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'NO_WORKER', 'NOBODY_FREE'); // F at t1
  await tick();
  const t2 = await decisionClock(db); // S decided at t2, written last
  await tick();
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'NO_WORKER', 'NOBODY_FREE'); // F at t3 (the true restart), folded
  await tick();
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'NO_WORKER', 'NOBODY_FREE'); // F at t4
  const t4 = (await row()).decidedAt;
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'MATCHED', null, t2);
  const r = await row();
  // Latest-only keeps no per-decision history (gate ruling 1, V22), so t3 is gone: the streak is under-stated, never over-.
  expect(r.failingSince!.getTime()).toBe(t4.getTime());
  expect(r.failingSince!.getTime()).toBeGreaterThan(asDate(t2).getTime());
});

it('a late write never moves the latest outcome, its reason or its time, and a MATCHED row keeps no streak', async () => {
  const t0 = await decisionClock(db);
  await tick();
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'MATCHED');
  const before = await row();
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'NO_WORKER', 'NO_ROLE', t0);
  expect(await row()).toEqual(before);
});

it('the newest known match never moves back: an older late success does not let an older late failure into the streak', async () => {
  const t2 = await decisionClock(db); // S decided at t2, written late
  await tick();
  const t3 = await decisionClock(db); // F decided at t3, written late
  await tick();
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'MATCHED'); // S at t5
  await tick();
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'NO_WORKER', 'NOBODY_FREE'); // F at t6: streak starts here
  const start = (await row()).failingSince!.getTime();
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'MATCHED', null, t2);
  await recordMatchOutcome(db, app.id, { role: 'x' }, 'NO_WORKER', 'NOBODY_FREE', t3); // before t5's match: not this streak
  expect((await row()).failingSince!.getTime()).toBe(start);
});
