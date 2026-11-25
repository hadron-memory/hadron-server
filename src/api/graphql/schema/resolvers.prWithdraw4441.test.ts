/**
 * #4441 (Holger's ruling, team chat #138478, option "WITHDRAW VERB"; gate issuecomment-7078665958): the seat holder who
 * recorded a negative verdict, or the coordinator, withdraws it on a FINISHED review seat at the same frozen head,
 * recorded as an event. A withdrawn negative stops blocking: readiness's head block, the refreeze guard, the
 * schedule-drop guard and the seat replace / supersede guards all treat it as not negative. It never counts as a
 * positive verdict: its slot counts only through a superseding seat's APPROVE, PASS or CARRY at that head. Every
 * REVIEW_SEAT_NOT_SUPERSEDABLE guard is unchanged for a negative that was NOT withdrawn, and TASK_ENDED still forbids
 * re-recording a verdict on the finished seat. The verdict event and its withdrawal both stay in the trail.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { settledTeamEventQueries, useTeamEventHorizonTimeout } from '../../../test/teamEventHorizon.js';
import { resolvers, type Context } from './resolvers.js';

useTeamEventHorizonTimeout();
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));

const M = resolvers.Mutation as Record<string, (...args: any[]) => Promise<any>>;
const Q = settledTeamEventQueries(resolvers.Query, db) as Record<string, (...args: any[]) => Promise<any>>;
const H = 'a'.repeat(40), H2 = 'b'.repeat(40);
const RECEIPT = 'https://example.test/pull/1#issuecomment-1';
let owner: any, author: any, reviewer: any, other: any, manager: any, outsider: any, app: any, build: any, peter: any, sam: any, mo: any, agentId: string;
const live = { kind: 'LIVE_CHAT', ref: 'client-chat:turn-4441' };
const ctx = (userId: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra }) as Context;
const code = async (p: Promise<unknown>) => { try { await p; return 'RESOLVED'; } catch (e: any) { return e.extensions?.code ?? String(e); } };
/** A worker acting through its bound session: the request user is its holder and the request actor is the worker. */
const asWorker = <T>(w: any, fn: (c: Context) => Promise<T>) =>
  runAsActor({ workerId: w.id, agentId, userId: w.heldByUserId }, () => fn(ctx(w.heldByUserId, { sessionId: w.session.id })));

const schedule = (slots = ['local', 'blind'], who = owner.id) => M.setReviewSchedule!({}, { taskRef: build.id, slots }, ctx(who));
const freeze = (head = H) => M.freezePullRequestHead!({}, { taskRef: build.id, head }, ctx(author.id));
const readiness = (head = H) => Q.pullRequestReadiness!({}, { taskRef: build.id, head }, ctx(owner.id));
async function seat(slot: string, head = H, who = reviewer.id, supersedes?: string) {
  const t = await M.createAgentTask!({}, { input: { parentTaskRef: build.id, title: slot, assignee: { user: who }, source: 'synthetic' } }, ctx(author.id));
  await M.assignReviewSeat!({}, { taskRef: t.id, slot, head, supersedes }, ctx(author.id));
  return t;
}
async function verdict(t: any, value: string, head = H, who = reviewer.id) {
  await M.startAgentTask!({}, { taskRef: t.id }, ctx(who));
  return M.recordReviewVerdict!({}, { taskRef: t.id, head, verdict: value, receipt: RECEIPT }, ctx(who));
}
const finish = (t: any, who = reviewer.id) => M.finishAgentTask!({}, { taskRef: t.id, result: { outcome: 'reviewed' } }, ctx(who));
const withdraw = (t: any, c: Context, head = H, extra: Record<string, unknown> = {}) =>
  M.withdrawReviewVerdict!({}, { taskRef: t.id, head, receipt: RECEIPT, ...extra }, c);
const withdrawals = (t: any) => db.agentTeamEvent.findMany({ where: { taskId: t.id, type: 'review.verdict.withdrawn' }, orderBy: { createdAt: 'asc' } });
const verdicts = (t: any) => db.agentTeamEvent.findMany({ where: { taskId: t.id, type: 'review.verdict' }, orderBy: { createdAt: 'asc' } });

/** Schedule local+blind, freeze H, local APPROVE (finished), blind CHANGES_REQUESTED (finished). */
async function negativeBlind() {
  await schedule(); await freeze();
  const local = await seat('local'); await verdict(local, 'APPROVE'); await finish(local);
  const blind = await seat('blind', H, other.id); await verdict(blind, 'CHANGES_REQUESTED', H, other.id); await finish(blind, other.id);
  return { local, blind };
}

beforeEach(async () => {
  await cleanDb(db);
  [owner, author, reviewer, other, manager, outsider] = await Promise.all(['owner', 'author', 'reviewer', 'other', 'manager', 'outsider']
    .map((h) => db.user.create({ data: { handle: `${h}-${generateId().slice(-6)}`, roles: ['READER'] } })));
  const org = await db.organization.create({ data: { name: 'Withdraw', urn: `withdraw-${generateId()}.test` } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Withdraw', urn: `${org.urn}:app` } });
  for (const u of [owner, author, reviewer, other]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
  await db.appMember.create({ data: { appId: app.id, userId: manager.id, role: 'owner' } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:agent`, name: 'Agent' } });
  agentId = agent.id;
  await db.appAgent.create({ data: { appId: app.id, agentId } });
  const worker = async (name: string, role: string, holderId: string) => {
    const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(), role, heldByUserId: holderId } });
    const session = await db.session.create({ data: { id: generateId(), appId: app.id, agentId, workerId: w.id, userId: holderId, tool: 'vitest', role } });
    return { ...w, session };
  };
  peter = await worker('Peter', 'coordinator', owner.id);
  sam = await worker('Sam', 'server-engineer', owner.id);
  mo = await worker('Mo', 'server-engineer', manager.id); // a worker whose holder manages the App
  build = await M.createAgentTask!({}, { input: { appRef: app.id, title: 'Build', source: 'synthetic', assignee: { user: author.id }, references: [{ kind: 'PULL_REQUEST', target: 'https://github.com/example/project/pull/1' }] } }, ctx(owner.id));
});

describe('#4441 the withdraw verb: who, on what, and the record', () => {
  it('today a finished negative seat blocks the head and cannot be superseded (the reported state)', async () => {
    const { blind } = await negativeBlind();
    const r = await readiness();
    expect(r.ready).toBe(false);
    expect(r.slots.find((s: any) => s.slot === 'local').counts).toBe(false); // the head block reaches every slot
    expect(await code(seat('blind', H, reviewer.id, blind.id))).toBe('REVIEW_SEAT_NOT_SUPERSEDABLE');
  });

  it('the holder withdraws: one review.verdict.withdrawn event naming the verdict; the verdict stays; the finished task row is untouched', async () => {
    const { blind } = await negativeBlind();
    const before = await db.agentTask.findUniqueOrThrow({ where: { id: blind.id } });
    const [negative] = await verdicts(blind);
    await withdraw(blind, ctx(other.id));
    const [w] = await withdrawals(blind);
    expect(w).toMatchObject({ actorUserId: other.id, payload: { head: H, slot: 'blind', verdictEventId: negative.id, verdict: 'CHANGES_REQUESTED', receipt: RECEIPT } });
    expect(await verdicts(blind)).toHaveLength(1);
    expect(await db.agentTask.findUniqueOrThrow({ where: { id: blind.id } })).toEqual(before);
  });

  it('a withdrawn negative stops blocking; it never counts itself; a superseding seat\'s APPROVE makes the PR ready', async () => {
    const { blind } = await negativeBlind();
    await withdraw(blind, ctx(other.id));
    const mid = await readiness();
    expect(mid.slots.find((s: any) => s.slot === 'local').counts).toBe(true);
    expect(mid.slots.find((s: any) => s.slot === 'blind')).toMatchObject({ verdict: 'CHANGES_REQUESTED', counts: false });
    expect(mid.ready).toBe(false);
    const again = await seat('blind', H, reviewer.id, blind.id);
    await verdict(again, 'APPROVE'); await finish(again);
    expect((await readiness()).ready).toBe(true);
  });

  it('the coordinator (a worker whose role is coordinator) withdraws another reviewer\'s negative', async () => {
    const { blind } = await negativeBlind();
    expect(await code(asWorker(peter, (c) => withdraw(blind, c)))).toBe('RESOLVED');
    expect(await withdrawals(blind)).toHaveLength(1);
  });

  it('whoever manages the App withdraws as the coordinator would', async () => {
    const { blind } = await negativeBlind();
    expect(await code(withdraw(blind, ctx(manager.id)))).toBe('RESOLVED');
  });

  it.each([
    ['another reviewer of the PR', () => ctx(reviewer.id)],
    ['the build task\'s assignee', () => ctx(author.id)],
    ['the build task\'s owner (not a coordinator worker, not a manager)', () => ctx(owner.id)],
  ])('%s is refused REVIEW_WITHDRAW_FORBIDDEN, with nothing written', async (_label, who) => {
    const { blind } = await negativeBlind();
    expect(await code(withdraw(blind, who()))).toBe('REVIEW_WITHDRAW_FORBIDDEN');
    expect(await withdrawals(blind)).toHaveLength(0);
  });

  it('a non-coordinator worker is refused, though its holder could not withdraw either', async () => {
    const { blind } = await negativeBlind();
    expect(await code(asWorker(sam, (c) => withdraw(blind, c)))).toBe('REVIEW_WITHDRAW_FORBIDDEN');
  });

  it('a caller who cannot read the App is answered as for a task that does not exist', async () => {
    const { blind } = await negativeBlind();
    expect(await code(withdraw(blind, ctx(outsider.id)))).toBe('TASK_NOT_FOUND');
  });

  it('only a FINISHED seat: a STARTED seat\'s holder re-rates instead', async () => {
    await schedule(); await freeze();
    const blind = await seat('blind', H, other.id); await verdict(blind, 'CHANGES_REQUESTED', H, other.id);
    expect(await code(withdraw(blind, ctx(other.id)))).toBe('TASK_INVALID_TRANSITION');
  });

  it('only a negative verdict, at the head it was recorded at, and only once', async () => {
    const { local, blind } = await negativeBlind();
    expect(await code(withdraw(local, ctx(reviewer.id)))).toBe('REVIEW_VERDICT_NOT_NEGATIVE');
    expect(await code(withdraw(blind, ctx(other.id), H2))).toBe('REVIEW_HEAD_MISMATCH');
    await withdraw(blind, ctx(other.id));
    expect(await code(withdraw(blind, ctx(other.id)))).toBe('REVIEW_VERDICT_ALREADY_WITHDRAWN');
    expect(await withdrawals(blind)).toHaveLength(1);
  });

  it('a seat with no verdict, and a task that is not a bound seat, are refused', async () => {
    await schedule(); await freeze();
    const blind = await seat('blind', H, other.id); await M.startAgentTask!({}, { taskRef: blind.id }, ctx(other.id)); await finish(blind, other.id);
    expect(await code(withdraw(blind, ctx(other.id)))).toBe('REVIEW_VERDICT_NOT_NEGATIVE');
    expect(await code(withdraw(build, ctx(manager.id)))).toBe('REVIEW_SEAT_UNASSIGNED');
  });
});

/** A seat assigned to worker `w`, whose verdict `w` records through its own session, then finishes. */
async function workerNegative(w: any, slot = 'blind') {
  const t = await M.createAgentTask!({}, { input: { parentTaskRef: build.id, title: slot, assignee: { worker: w.id }, source: 'synthetic' } }, ctx(author.id));
  await M.assignReviewSeat!({}, { taskRef: t.id, slot, head: H }, ctx(author.id));
  await asWorker(w, (c) => M.startAgentTask!({}, { taskRef: t.id }, c));
  await asWorker(w, (c) => M.recordReviewVerdict!({}, { taskRef: t.id, head: H, verdict: 'CHANGES_REQUESTED', receipt: RECEIPT }, c));
  await asWorker(w, (c) => M.finishAgentTask!({}, { taskRef: t.id, result: { outcome: 'reviewed' } }, c));
  return t;
}

describe('#4441 worker reviewers, the instructed manager arm, and who the record names (Gloria BLIND F1, F2, F7)', () => {
  it('a worker that recorded the negative withdraws it through its own session; the event names the worker', async () => {
    await schedule(['blind']); await freeze();
    const t = await workerNegative(sam);
    expect(await code(asWorker(sam, (c) => withdraw(t, c)))).toBe('RESOLVED');
    const [w] = await withdrawals(t);
    expect(w).toMatchObject({ actorWorkerId: sam.id });
  });

  it('the worker\'s holder acting as themselves is not the verdict\'s actor, and is refused', async () => {
    await schedule(['blind']); await freeze();
    const t = await workerNegative(sam);
    expect(await code(withdraw(t, ctx(owner.id)))).toBe('REVIEW_WITHDRAW_FORBIDDEN');
    expect(await withdrawals(t)).toHaveLength(0);
  });

  it('a worker whose holder manages the App withdraws only with an instruction, and that writes one app.manager-act row', async () => {
    const { blind } = await negativeBlind();
    expect(await code(asWorker(mo, (c) => withdraw(blind, c)))).toBe('REVIEW_WITHDRAW_FORBIDDEN');
    expect(await withdrawals(blind)).toHaveLength(0);
    expect(await code(asWorker(mo, (c) => withdraw(blind, c, H, { instruction: live })))).toBe('RESOLVED');
    expect((await withdrawals(blind))[0]).toMatchObject({ actorWorkerId: mo.id });
    const acts = await db.agentTeamEvent.findMany({ where: { appId: app.id, type: 'app.manager-act' } });
    expect(acts).toHaveLength(1);
    expect(acts[0].payload).toMatchObject({ act: 'review.verdict-withdraw' });
  });

  it('the record names who withdrew: the coordinator worker, or the managing person (no worker)', async () => {
    const { blind } = await negativeBlind();
    await asWorker(peter, (c) => withdraw(blind, c));
    expect((await withdrawals(blind))[0]).toMatchObject({ actorWorkerId: peter.id });
    await schedule(['local', 'blind', 'qa']);
    const qa = await seat('qa', H, other.id); await verdict(qa, 'FAIL', H, other.id); await finish(qa, other.id);
    await withdraw(qa, ctx(manager.id));
    expect((await withdrawals(qa))[0]).toMatchObject({ actorUserId: manager.id, actorWorkerId: null });
    expect(await db.agentTeamEvent.count({ where: { appId: app.id, type: 'app.manager-act' } })).toBe(0); // a person acting directly: no instructed-act record
  });

  it.each([
    ['a malformed head', { head: 'abc' }],
    ['a receipt with a control character', { receipt: 'bad\u0007receipt' }],
  ])('%s is BAD_USER_INPUT, with nothing written', async (_label, extra) => {
    const { blind } = await negativeBlind();
    const { head, ...rest } = extra as { head?: string };
    expect(await code(withdraw(blind, ctx(other.id), head ?? H, rest))).toBe('BAD_USER_INPUT');
    expect(await withdrawals(blind)).toHaveLength(0);
  });
});

describe('#4441 the guards that stay', () => {
  it('TASK_ENDED still refuses re-recording a verdict on the finished seat, withdrawn or not', async () => {
    const { blind } = await negativeBlind();
    await withdraw(blind, ctx(other.id));
    expect(await code(M.recordReviewVerdict!({}, { taskRef: blind.id, head: H, verdict: 'APPROVE' }, ctx(other.id)))).toBe('TASK_ENDED');
  });

  it('a schedule drops a slot whose negative was withdrawn, and still refuses one whose negative was not', async () => {
    const { blind } = await negativeBlind();
    expect(await code(schedule(['local']))).toBe('REVIEW_SEAT_NOT_SUPERSEDABLE');
    await withdraw(blind, ctx(other.id));
    expect(await code(schedule(['local']))).toBe('RESOLVED');
  });

  it('the head can be frozen again once its only negative is withdrawn', async () => {
    const { blind } = await negativeBlind();
    await freeze(H2);
    expect(await code(freeze(H))).toBe('REVIEW_SEAT_NOT_SUPERSEDABLE');
    await withdraw(blind, ctx(other.id));
    expect(await code(freeze(H))).toBe('RESOLVED');
  });

  it('a second, unwithdrawn negative at the same head still blocks it', async () => {
    await schedule(['local', 'blind', 'qa']); await freeze();
    const blind = await seat('blind', H, other.id); await verdict(blind, 'CHANGES_REQUESTED', H, other.id); await finish(blind, other.id);
    const qa = await seat('qa'); await verdict(qa, 'FAIL'); await finish(qa);
    await withdraw(blind, ctx(other.id));
    const r = await readiness();
    expect(r.ready).toBe(false);
    expect(await code(seat('blind', H, reviewer.id, blind.id))).toBe('RESOLVED');
    expect(await code(seat('qa', H, other.id, qa.id))).toBe('REVIEW_SEAT_NOT_SUPERSEDABLE');
  });

  it('a withdrawal at H changes nothing at another head', async () => {
    await schedule(['blind']); await freeze(H2);
    const atH2 = await seat('blind', H2, other.id); await verdict(atH2, 'CHANGES_REQUESTED', H2, other.id); await finish(atH2, other.id);
    expect(await code(withdraw(atH2, ctx(other.id), H))).toBe('REVIEW_HEAD_MISMATCH');
    expect(await code(seat('blind', H2, reviewer.id, atH2.id))).toBe('REVIEW_SEAT_NOT_SUPERSEDABLE');
  });
});
