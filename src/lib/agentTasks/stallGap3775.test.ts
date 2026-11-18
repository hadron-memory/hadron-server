/**
 * #3775 part A (cor:agt:050:32): server downtime does not count as silence. The first pass after a gap (a pass that
 * starts more than 5 minutes after the last recorded one) records the gap's end, and the not-started, no-progress,
 * owner-unreactive and unassignable windows count from no earlier than it; finish-by is not floored; an alarm already
 * raised keeps running; two concurrent passes record one gap end; the very first pass floors nothing.
 * Tests drive `taskStallPass` (the production pass: gap bookkeeping + the tick) with a controllable clock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { taskStallPass } from '../../jobs/taskStallEvaluator.js';
import { recordStallPass } from './stallGap.js';
import { currentAlarmEpisodes, endedAlarmEpisodes } from './stall.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';

const M = resolvers.Mutation as any;
const at = (hhmm: string): Date => new Date(`2026-10-09T${hhmm}:00Z`);
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

let app: { id: string };
let agentId: string;
let ada: { id: string };
let anne: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'StallGap', urn: `gap3775-${n}.example` } });
  const admin = await db.user.create({ data: { githubId: 900_000 + n, githubUsername: `gap-admin-${n}`, roles: ['READER'] } });
  const mia = await db.user.create({ data: { githubId: 1_000_000 + n, githubUsername: `gap-mia-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  agentId = agent.id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `gap3775-${n}.example:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
  const worker = (name: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(), heldByUserId: mia.id }, select: { id: true } });
  ada = await worker('Ada');
  anne = await worker('Anne');
});

type TaskData = Record<string, unknown>;
const task = (data: TaskData) =>
  db.agentTask.create({ data: { appId: app.id, title: 'T', createdAt: at('09:00'), ...data }, select: { id: true } });
const toAnne = (assignedAt: string, extra: TaskData = {}) =>
  task({ ownerWorkerId: ada.id, assigneeWorkerId: anne.id, assignedAt: at(assignedAt), createdAt: at(assignedAt), ...extra });
const startedByAnne = (extra: TaskData = {}) => toAnne('09:30', { status: 'started', startedAt: at('10:00'), ...extra });
const drive = (t: string) =>
  db.session.create({ data: { id: generateId(), appId: app.id, workerId: anne.id, agentId, startedAt: at(t), updatedAt: at(t) } });
const pass = (t: string) => taskStallPass(db, at(t));
/** Passes every 5 minutes (the threshold itself is jitter, cor:agt:050:32) from `from` to `to`, both included. */
const passes = async (from: string, to: string) => {
  for (let t = at(from).getTime(); t <= at(to).getTime(); t += 5 * 60_000) await taskStallPass(db, new Date(t));
};
const alarms = () => db.agentTeamEvent.findMany({ where: { severity: 'alarm', taskId: { not: null } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const state = () => db.stallEvaluatorState.findUnique({ where: { id: 'platform' } });
const queued = async () => {
  const t = await task({ ownerWorkerId: ada.id, createdAt: at('10:00') });
  await db.agentTeamEvent.create({ data: { appId: app.id, taskId: t.id, type: 'assignment.queued', createdAt: at('10:00') } });
  return t;
};

describe('#3775 A — a gap in the evaluator does not count as silence', () => {
  it('1. no-progress: a window that began before a 2h gap raises nothing in the first pass after it, then one window after the gap end', async () => {
    await startedByAnne();
    await drive('10:00');
    await passes('10:05', '10:30'); // the last passes before the outage; the no-progress window (60 min) began at 10:00
    await pass('12:30'); // first pass after a 2h gap: without the rule the window is long overdue
    expect(await alarms()).toEqual([]);
    await passes('12:35', '13:25');
    expect(await alarms()).toEqual([]);
    await passes('13:30', '13:30');
    expect(await alarms()).toEqual([expect.objectContaining({ type: 'stall.no-progress', episodeStart: at('12:30') })]);
  });

  it('2. the same for not-started, owner-unreactive and unassignable', async () => {
    const pending = await toAnne('10:00'); // not-started, 15 min
    const queuedTask = await queued(); // unassignable, 15 min
    const parent = await startedByAnne();
    await drive('10:00'); // before the child ends (10:10): Anne has not reacted since; the parent's own no-progress window also began before the gap
    await task({ parentTaskId: parent.id, ownerWorkerId: anne.id, assigneeWorkerId: ada.id, assignedAt: at('10:00'), status: 'finished', startedAt: at('10:00'), finishedAt: at('10:10'), resultOutcome: 'succeeded', createdAt: at('10:00') });
    await passes('10:05', '10:05');
    await pass('12:30'); // 2h25m gap
    expect((await alarms()).filter((a) => a.taskId === pending.id || a.taskId === queuedTask.id)).toEqual([]);
    expect((await alarms()).filter((a) => a.type === 'stall.owner-unreactive')).toEqual([]);
    await passes('12:35', '12:40');
    await pass('12:44');
    expect(await alarms()).toEqual([]);
    await pass('12:45'); // not-started: 15 min after the gap end
    expect((await alarms()).map((a) => a.type)).toEqual(['stall.not-started']);
    await passes('12:50', '12:55'); // owner-unreactive: 20 min after the gap end
    expect((await alarms()).map((a) => a.type).sort()).toEqual(['stall.not-started', 'stall.owner-unreactive']);
    await passes('13:00', '13:00'); // unassignable: 30 min after the gap end
    expect((await alarms()).map((a) => a.type).sort()).toEqual(['assignment.unassignable', 'stall.not-started', 'stall.owner-unreactive']);
  });

  it('3. a gap under the threshold (4 minutes) moves no window', async () => {
    await startedByAnne();
    await drive('10:00');
    await passes('10:00', '10:55');
    await pass('10:59'); // 4 minutes
    await pass('11:00');
    expect(await alarms()).toEqual([expect.objectContaining({ type: 'stall.no-progress', episodeStart: at('10:00') })]);
    expect((await state())?.lastGapEndedAt ?? null).toBeNull();
  });

  it('3b. exactly 5 minutes is jitter; 5 minutes and one second is a gap', async () => {
    await pass('10:00');
    await pass('10:05');
    expect((await state())?.lastGapEndedAt ?? null).toBeNull();
    await recordStallPass(db, new Date(at('10:05').getTime() + 5 * 60_000 + 1000));
    expect((await state())?.lastGapEndedAt).toEqual(new Date(at('10:05').getTime() + 5 * 60_000 + 1000));
  });

  it('4. a finish-by that passed during the gap raises in the first pass after it (not floored)', async () => {
    await startedByAnne({ finishBy: at('11:00') });
    await pass('10:30');
    await pass('12:30');
    expect(await alarms()).toEqual([expect.objectContaining({ type: 'stall.finish-by', episodeStart: at('11:00') })]); // the deadline's own episode, not the gap end
  });

  it('5. an alarm raised before the gap is still running after it, episode start unchanged', async () => {
    const t = await startedByAnne();
    await drive('10:00');
    await pass('11:00'); // no-progress raised, episode start 10:00
    const [first] = await alarms();
    expect(first).toMatchObject({ type: 'stall.no-progress', episodeStart: at('10:00') });
    await pass('13:00'); // 2h gap
    const key = `${t.id}|stall.no-progress|${at('10:00').getTime()}`;
    const ended = await endedAlarmEpisodes(db, [{ taskId: t.id, type: first.type, episodeStart: first.episodeStart, appId: app.id }], at('13:00'));
    expect(ended.has(key)).toBe(false);
    const current = await currentAlarmEpisodes(db, [{ taskId: t.id, type: first.type, episodeStart: first.episodeStart }], at('13:00'));
    expect(current.has(key)).toBe(true);
    expect((await alarms())[0]).toMatchObject({ id: first.id, episodeStart: at('10:00') });
  });

  it('6. two concurrent passes after a gap record one gap end', async () => {
    await recordStallPass(db, at('10:00'));
    const results = await Promise.all([recordStallPass(db, at('12:00')), recordStallPass(db, new Date(at('12:00').getTime() + 1000))]);
    expect(results.filter((r) => r.gapEnded).length).toBe(1);
    const row = await state();
    expect([at('12:00').getTime(), at('12:00').getTime() + 1000]).toContain(row!.lastGapEndedAt!.getTime());
    expect(await db.stallEvaluatorState.count()).toBe(1);
  });

  it('7. the first ever pass records its time and floors nothing', async () => {
    await startedByAnne();
    await drive('10:00');
    await pass('12:00'); // no earlier pass: the window (10:00 + 60) is overdue and alarms
    expect(await alarms()).toEqual([expect.objectContaining({ type: 'stall.no-progress', episodeStart: at('10:00') })]);
    const row = await state();
    expect(row).toMatchObject({ lastPassAt: at('12:00'), lastGapEndedAt: null });
  });

  it('8. a record failure on the first pass after a gap skips the pass; the next pass floors the gap (BLIND P2)', async () => {
    await startedByAnne();
    await drive('10:00');
    await passes('10:05', '10:30');
    const spy = vi.spyOn(db.stallEvaluatorState, 'findUnique').mockRejectedValueOnce(new Error('db blip'));
    await pass('12:30'); // record throws: no tick, so no un-floored alarm
    spy.mockRestore();
    expect(await alarms()).toEqual([]);
    await pass('12:31'); // records the same gap (lastPassAt still 10:30)
    expect(await alarms()).toEqual([]);
    expect((await state())!.lastGapEndedAt).toEqual(at('12:31'));
  });

  it('a pass whose clock is not later than the recorded one moves nothing back', async () => {
    await recordStallPass(db, at('12:00'));
    await recordStallPass(db, at('11:00'));
    expect((await state())!.lastPassAt).toEqual(at('12:00'));
  });
});
