/**
 * #5036 (option A; rule in the team memory coordination:pr-finishing, "Finishing a review seat"): finishing a task that is
 * a PR review seat with no verdict recorded at its ASSIGNED head is refused with SEAT_VERDICT_REQUIRED, before any write.
 * Exempt, finishing unchanged: a seat never assigned, a superseded seat, a failed or cancelled outcome.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { settledTeamEventQueries, useTeamEventHorizonTimeout } from '../../../test/teamEventHorizon.js';
import { resolvers, type Context } from './resolvers.js';

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


beforeEach(async () => {
  await cleanDb(db);
  [owner, author, reviewer, other, manager, outsider] = await Promise.all(['owner', 'author', 'reviewer', 'other', 'manager', 'outsider']
    .map((h) => db.user.create({ data: { handle: `${h}-${generateId().slice(-6)}`, roles: ['READER'] } })));
  const org = await db.organization.create({ data: { name: 'SeatVerdict5036', urn: `seatverdict-${generateId()}.test` } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'SeatVerdict5036', urn: `${org.urn}:app` } });
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


const finishWith = (t: any, outcome: string, who = reviewer.id) => M.finishAgentTask!({}, { taskRef: t.id, result: { outcome } }, ctx(who));
const status = async (t: any) => (await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).status;

describe('#5036 a review seat is not finished with no verdict at its assigned head', () => {
  beforeEach(async () => { await schedule(); await freeze(); });

  it('refuses with SEAT_VERDICT_REQUIRED, names `pr verdict` and the head, and leaves the seat started', async () => {
    const t = await seat('local');
    await M.startAgentTask!({}, { taskRef: t.id }, ctx(reviewer.id));
    const e: any = await finishWith(t, 'reviewed').catch((x) => x);
    expect(e.extensions.code).toBe('SEAT_VERDICT_REQUIRED');
    expect(e.message).toContain('hadron team pr verdict');
    expect(e.message).toContain(H);
    expect(await status(t)).toBe('started');
    expect(await db.agentTeamEvent.count({ where: { taskId: t.id, type: 'task.finished' } })).toBe(0);
  });

  it('a seat with a verdict at its assigned head finishes as before', async () => {
    const t = await seat('local'); await verdict(t, 'APPROVE');
    await finishWith(t, 'reviewed');
    expect(await status(t)).toBe('finished');
  });

  it('judges the ASSIGNED head, not the frozen one: a seat on an old head with its verdict finishes after a re-freeze; one without is refused', async () => {
    const withV = await seat('local'); await verdict(withV, 'APPROVE');
    const without = await seat('blind', H, other.id); await M.startAgentTask!({}, { taskRef: without.id }, ctx(other.id));
    await freeze(H2);
    await finishWith(withV, 'reviewed');
    expect(await status(withV)).toBe('finished');
    expect(await code(finishWith(without, 'reviewed', other.id))).toBe('SEAT_VERDICT_REQUIRED');
  });

  it('a verdict at another head than the assigned one does not count', async () => {
    const t = await seat('local'); await M.startAgentTask!({}, { taskRef: t.id }, ctx(reviewer.id));
    await db.agentTeamEvent.create({ data: { appId: app.id, taskId: t.id, type: 'review.verdict', payload: { slot: 'local', head: H2, verdict: 'APPROVE' } } });
    expect(await code(finishWith(t, 'reviewed'))).toBe('SEAT_VERDICT_REQUIRED');
  });

  it('exempt: a failed or cancelled outcome finishes with no verdict (any case)', async () => {
    await schedule(['s1', 's2', 's3']);
    for (const [slot, outcome] of [['s1', 'failed'], ['s2', 'cancelled'], ['s3', 'FAILED']]) {
      const t = await seat(slot); await M.startAgentTask!({}, { taskRef: t.id }, ctx(reviewer.id));
      expect(await code(finishWith(t, outcome))).toBe('RESOLVED');
      expect(await status(t)).toBe('finished');
    }
  });

  it('exempt: a superseded seat finishes with no verdict; its replacement is held to the rule', async () => {
    const old = await seat('local'); await M.startAgentTask!({}, { taskRef: old.id }, ctx(reviewer.id));
    const next = await seat('local', H, other.id, old.id); await M.startAgentTask!({}, { taskRef: next.id }, ctx(other.id));
    expect(await code(finishWith(old, 'reviewed'))).toBe('RESOLVED');
    expect(await code(finishWith(next, 'reviewed', other.id))).toBe('SEAT_VERDICT_REQUIRED');
  });

  it('exempt: a task never bound as a seat finishes unchanged', async () => {
    const t = await M.createAgentTask!({}, { input: { parentTaskRef: build.id, title: 'plain', assignee: { user: reviewer.id }, source: 'synthetic' } }, ctx(author.id));
    await M.startAgentTask!({}, { taskRef: t.id }, ctx(reviewer.id));
    expect(await code(finishWith(t, 'reviewed'))).toBe('RESOLVED');
  });

  it('the recorded verdict then lets the same seat finish (refuse, record, finish)', async () => {
    const t = await seat('local'); await M.startAgentTask!({}, { taskRef: t.id }, ctx(reviewer.id));
    expect(await code(finishWith(t, 'reviewed'))).toBe('SEAT_VERDICT_REQUIRED');
    await M.recordReviewVerdict!({}, { taskRef: t.id, head: H, verdict: 'APPROVE', receipt: RECEIPT }, ctx(reviewer.id));
    expect(await code(finishWith(t, 'reviewed'))).toBe('RESOLVED');
  });
});

describe('#5036 blind-review pins (Gaby P2s, Georgia P3)', () => {
  beforeEach(async () => { await schedule(['local']); await freeze(); });

  it('a seat finished failed or cancelled with no verdict never counts: its slot is not ready', async () => {
    const t = await seat('local'); await M.startAgentTask!({}, { taskRef: t.id }, ctx(reviewer.id));
    await finishWith(t, 'failed');
    const r = await readiness();
    expect(r.ready).toBe(false);
    expect(r.slots.find((x: any) => x.slot === 'local')).toMatchObject({ state: 'FINISHED', verdict: null, counts: false });
  });

  it('only a supersede event of the same App exempts a seat: another App naming this task id does not', async () => {
    const t = await seat('local'); await M.startAgentTask!({}, { taskRef: t.id }, ctx(reviewer.id));
    const org2 = await db.organization.create({ data: { name: 'Other', urn: `other-${generateId()}.test` } });
    const app2 = await db.app.create({ data: { organizationId: org2.id, name: 'Other', urn: `${org2.urn}:app` } });
    await db.agentTeamEvent.create({ data: { appId: app2.id, taskId: generateId(), type: 'review.seat.assigned', payload: { slot: 'local', head: H, supersedes: t.id } } });
    expect(await code(finishWith(t, 'reviewed'))).toBe('SEAT_VERDICT_REQUIRED');
  });
});
