/**
 * #4281 S12c (Team on Orca S12, epic #4229) — the monthly review-quality report per reviewer family and model.
 *
 * cor:agt:130:06 (Definition: review quality measures; Proposed, drafted on the issue, not minted) and the reader line of
 * cor:agt:050:21 r19 (Proposed; Peter, team chat #110352):
 *  - a review is one FINISHED seat task carrying at least one `review.verdict`; its verdict is the seat's LATEST;
 *  - its row is that verdict's (family, model) snapshot (cor:agt:130:02), split on whether the model was reported; a
 *    snapshot with no family or no model goes in ONE "not recorded" row, never into a family;
 *  - its month is the UTC calendar month of the latest verdict's createdAt; findings and dispositions recorded later
 *    still count there, so every report states when it was worked out;
 *  - findings are the seat task's resultFindings; confirmed = fixed, accepted or deferred; rejected is not confirmed and
 *    undisposed is its own count; approving = APPROVE, PASS or CARRY;
 *  - defects missed (#4287) is an integer from S12b's defect links (#4280), 0 with none; its per-approving share is null
 *    only with no approving review;
 *  - readers are exactly the readers of the App's tasks and events.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));

const M = resolvers.Mutation as Record<string, (...args: any[]) => Promise<any>>;
const Q = resolvers.Query as Record<string, (...args: any[]) => Promise<any>>;
const H = 'a'.repeat(40);
const SLOTS = Array.from({ length: 16 }, (_, i) => `s${i + 1}`);
const NOV = '2026-11';
const at = (iso: string) => new Date(iso);
const MID_NOV = at('2026-11-10T12:00:00.000Z');
const REPORTED = '2026-11-10T08:00:00.000Z';
let owner: any, author: any, holder: any, outsider: any, app: any, build: any, nextSlot = 0;
const ctx = (userId: string, extra: Record<string, unknown> = {}) => ({ db, userId, roles: ['READER' as const], ...extra });

type Snapshot = { family?: string | null; model?: string | null; reportedAt?: string | null; legacy?: boolean };
type Verdict = Snapshot & { verdict?: string; at?: Date; head?: string };
type Disposition = 'fixed' | 'accepted' | 'deferred' | 'rejected';
type Review = Verdict & { verdicts?: Verdict[]; findings?: number; dispositions?: Disposition[]; end?: 'finish' | 'cancel' | 'none'; inApp?: any; inBuild?: any };

/** One `review.verdict` written at a chosen time: the same payload recordReviewVerdict writes (`legacy`: before S12a, no snapshot keys). */
const verdictEvent = (appId: string, taskId: string, slot: string, v: Verdict) =>
  db.agentTeamEvent.create({ data: {
    appId, taskId, type: 'review.verdict', actorUserId: holder.id, createdAt: v.at ?? MID_NOV,
    payload: { slot, head: v.head ?? H, verdict: v.verdict ?? 'APPROVE', node: null, receipt: null,
      ...(v.legacy ? {} : {
        reviewerFamily: v.family === undefined ? 'family-f' : v.family,
        reviewerModel: v.model === undefined ? 'model-m' : v.model,
        modelReportedAt: v.reportedAt === undefined ? REPORTED : v.reportedAt,
      }) },
  } });

/**
 * A seat through the real doors (create, assign the seat, start, finish with findings, dispose), with its verdict
 * events written at chosen times. `dispositions[i]` disposes finding F(i+1); the rest stay undisposed.
 */
async function review(r: Review = {}) {
  const parent = r.inBuild ?? build;
  const slot = SLOTS[nextSlot++]!;
  const t = await M.createAgentTask!({}, { input: { parentTaskId: parent.id, title: slot, assignee: { user: holder.id }, source: 'synthetic' } }, ctx(author.id));
  // A seat binds the build's CURRENT frozen head; re-freezing an earlier head keeps its first-freeze position (#4280).
  if (r.head) await M.freezePullRequestHead!({}, { taskRef: parent.id, head: r.head }, ctx(author.id));
  await M.assignReviewSeat!({}, { taskRef: t.id, slot, head: r.head ?? H }, ctx(author.id));
  await M.startAgentTask!({}, { taskId: t.id }, ctx(holder.id));
  for (const v of r.verdicts ?? [r]) await verdictEvent((r.inApp ?? app).id, t.id, slot, v);
  if ((r.end ?? 'finish') === 'finish') {
    const findings = Array.from({ length: r.findings ?? 0 }, (_, i) => ({ severity: 'P2', text: `finding ${i + 1}` }));
    await M.finishAgentTask!({}, { taskId: t.id, result: { outcome: 'approved', ...(r.findings == null ? {} : { findings }) } }, ctx(holder.id));
    for (const [i, disposition] of (r.dispositions ?? []).entries()) {
      await M.disposeAgentTaskFinding!({}, { taskRef: t.id, findingId: `F${i + 1}`, disposition }, ctx(author.id));
    }
  } else if (r.end === 'cancel') await M.cancelAgentTask!({}, { taskId: t.id }, ctx(author.id));
  return t;
}
const report = (month = NOV, who = owner.id, appRef: string = app.id) => Q.reviewQualityReport!({}, { appRef, month }, ctx(who));
const rows = async (month = NOV) => (await report(month)).rows as any[];
const refusal = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return { message: e.message, extensions: e.extensions }; } throw new Error('expected a refusal'); };
/** A build task with every slot scheduled and H frozen, in `inApp`. */
async function buildIn(inApp: any) {
  const b = await M.createAgentTask!({}, { input: { appRef: inApp.id, title: 'Build', source: 'synthetic', assignee: { user: author.id }, references: [{ kind: 'PULL_REQUEST', target: 'https://github.com/example/project/pull/1' }] } }, ctx(owner.id));
  await M.setReviewSchedule!({}, { taskRef: b.id, slots: SLOTS }, ctx(owner.id));
  await M.freezePullRequestHead!({}, { taskRef: b.id, head: H }, ctx(author.id));
  return b;
}
async function appWithMembers(name: string) {
  const org = await db.organization.create({ data: { name, urn: `${name}-${generateId()}.test` } });
  const a = await db.app.create({ data: { organizationId: org.id, name, urn: `${org.urn}:app` } });
  for (const u of [owner, author, holder]) await db.appMember.create({ data: { appId: a.id, userId: u.id, role: 'member' } });
  return a;
}

beforeEach(async () => {
  await cleanDb(db);
  nextSlot = 0;
  [owner, author, holder, outsider] = await Promise.all(['owner', 'author', 'holder', 'outsider'].map(handle => db.user.create({ data: { handle } })));
  app = await appWithMembers('review');
  build = await buildIn(app);
});

describe('the four measures match a hand count (cor:agt:130:06, #4281)', () => {
  it('the definition\'s own example: three seats, two approving, findings 0, 1 and 3, two fixed, one rejected, one undisposed', async () => {
    await review({ verdict: 'APPROVE', findings: 0 });
    await review({ verdict: 'APPROVE', findings: 1, dispositions: ['fixed'] });
    await review({ verdict: 'CHANGES_REQUESTED', findings: 3, dispositions: ['fixed', 'rejected'] });
    const r = await report();
    expect(r.month).toBe(NOV);
    expect(r.rows).toEqual([{
      recorded: true, family: 'family-f', model: 'model-m', modelReported: true,
      reviews: 3, findings: 4, findingsPerReview: 4 / 3,
      confirmedFindings: 2, rejectedFindings: 1, undisposedFindings: 1, shareConfirmed: 2 / 4,
      approvingReviews: 2, defectsMissed: 0, defectsMissedPerApprovingReview: 0,
    }]);
  });

  it('accepted and deferred are confirmed like fixed; rejected is not; a seat finished with no findings list has none', async () => {
    await review({ findings: 4, dispositions: ['accepted', 'deferred', 'rejected', 'fixed'] });
    await review({});
    expect(await rows()).toMatchObject([{ reviews: 2, findings: 4, findingsPerReview: 2, confirmedFindings: 3, rejectedFindings: 1, undisposedFindings: 0, shareConfirmed: 3 / 4 }]);
  });

  it('with no findings there is no share to state: null, never 0', async () => {
    await review({ findings: 0 });
    expect(await rows()).toMatchObject([{ reviews: 1, findings: 0, findingsPerReview: 0, confirmedFindings: 0, undisposedFindings: 0, shareConfirmed: null }]);
  });

  it('approving is APPROVE, PASS and CARRY; CHANGES_REQUESTED, FAIL and REFUSED are reviews that do not approve', async () => {
    for (const verdict of ['APPROVE', 'PASS', 'CARRY', 'CHANGES_REQUESTED', 'FAIL', 'REFUSED']) await review({ verdict });
    expect(await rows()).toMatchObject([{ reviews: 6, approvingReviews: 3 }]);
  });

  it('#4287: with no defect links, defects missed is 0, not null, and the report carries no unavailable reason', async () => {
    await review({ verdict: 'APPROVE' });
    const r = await report();
    expect(r.rows[0]).toMatchObject({ approvingReviews: 1, defectsMissed: 0, defectsMissedPerApprovingReview: 0 });
    expect(r).not.toHaveProperty('defectsMissedUnavailableReason');
  });
});

describe('what a review is, and which verdict decides', () => {
  it('only a finished seat is a review: a started or cancelled seat with a verdict is none, nor a finished task with no verdict', async () => {
    await review({ end: 'none' });
    await review({ end: 'cancel' });
    await review({ verdicts: [], findings: 2 });
    expect(await rows()).toEqual([]);
    await review({ findings: 1 });
    expect(await rows()).toMatchObject([{ reviews: 1, findings: 1 }]);
  });

  it('a re-rated seat is one review, counted by its latest verdict: its value, its snapshot and its month', async () => {
    await review({ findings: 2, verdicts: [
      { verdict: 'CHANGES_REQUESTED', family: 'family-old', model: 'model-old', at: at('2026-11-03T00:00:00.000Z') },
      { verdict: 'APPROVE', family: 'family-new', model: 'model-new', at: at('2026-11-04T00:00:00.000Z') },
    ] });
    expect(await rows()).toMatchObject([{ family: 'family-new', model: 'model-new', reviews: 1, findings: 2, approvingReviews: 1 }]);
  });

  it('the latest verdict is the latest by time, whatever order the events were written in', async () => {
    await review({ verdicts: [
      { verdict: 'APPROVE', family: 'family-new', at: at('2026-11-04T00:00:00.000Z') },
      { verdict: 'FAIL', family: 'family-old', at: at('2026-11-03T00:00:00.000Z') },
    ] });
    expect(await rows()).toMatchObject([{ family: 'family-new', reviews: 1, approvingReviews: 1 }]);
  });

  it('a seat re-rated across a month end belongs to the later month only', async () => {
    await review({ verdicts: [{ verdict: 'FAIL', at: at('2026-10-31T23:59:59.999Z') }, { verdict: 'PASS', at: at('2026-11-01T00:00:00.000Z') }] });
    expect(await rows('2026-10')).toEqual([]);
    expect(await rows('2026-11')).toMatchObject([{ reviews: 1, approvingReviews: 1 }]);
    expect(await rows('2026-12')).toEqual([]);
  });
});

describe('the month is the UTC calendar month of the latest verdict', () => {
  it('the first and last millisecond of the month are in it; the millisecond before and after are not', async () => {
    await review({ family: 'before', at: at('2026-10-31T23:59:59.999Z') });
    await review({ family: 'first', at: at('2026-11-01T00:00:00.000Z') });
    await review({ family: 'last', at: at('2026-11-30T23:59:59.999Z') });
    await review({ family: 'after', at: at('2026-12-01T00:00:00.000Z') });
    expect((await rows('2026-10')).map(r => r.family)).toEqual(['before']);
    expect((await rows('2026-11')).map(r => r.family)).toEqual(['first', 'last']);
    expect((await rows('2026-12')).map(r => r.family)).toEqual(['after']);
  });

  it('a disposition recorded after the month still counts in the review\'s month, and the report says when it was worked out', async () => {
    const t = await review({ at: at('2026-09-15T00:00:00.000Z'), findings: 2 });
    expect(await rows('2026-09')).toMatchObject([{ findings: 2, confirmedFindings: 0, undisposedFindings: 2, shareConfirmed: 0 }]);
    await M.disposeAgentTaskFinding!({}, { taskRef: t.id, findingId: 'F2', disposition: 'deferred' }, ctx(author.id));
    const before = Date.now();
    const r = await report('2026-09');
    expect(r.rows).toMatchObject([{ findings: 2, confirmedFindings: 1, undisposedFindings: 1, shareConfirmed: 1 / 2 }]);
    expect(r.asOf).toBeInstanceOf(Date);
    expect(r.asOf.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(r.asOf.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('a month with no reviews has no rows, and still says when it was worked out', async () => {
    const r = await report('2031-02');
    expect(r).toMatchObject({ month: '2031-02', rows: [] });
    expect(r.asOf).toBeInstanceOf(Date);
  });

  it('a month is YYYY-MM: anything else is bad input', async () => {
    for (const month of ['2026-13', '2026-00', '2026-1', '26-11', '2026-11-01', '2026/11', ' 2026-11', '', 'november']) {
      expect(await refusal(report(month)), month).toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    }
  });
});

describe('rows: one per family and model, reported apart from unreported, and one "not recorded" row', () => {
  it('each (family, model) is its own row, a reported model apart from an unreported one, in a stable order', async () => {
    await review({ family: 'family-g', model: 'model-a' });
    await review({ family: 'family-f', model: 'model-n', findings: 1 });
    await review({ family: 'family-f', model: 'model-m', reportedAt: null });
    await review({ family: 'family-f', model: 'model-m' });
    await review({ family: 'family-f', model: 'model-m' });
    expect((await rows()).map(r => [r.recorded, r.family, r.model, r.modelReported, r.reviews, r.findings])).toEqual([
      [true, 'family-f', 'model-m', true, 2, 0],
      [true, 'family-f', 'model-m', false, 1, 0],
      [true, 'family-f', 'model-n', true, 1, 1],
      [true, 'family-g', 'model-a', true, 1, 0],
    ]);
  });

  it('a snapshot with no family (null or empty), no model or neither, and a verdict from before snapshots, all go in the one "not recorded" row, last', async () => {
    await review({ family: 'family-f', model: 'model-m', findings: 1, dispositions: ['fixed'] });
    await review({ family: null, model: 'model-m', findings: 2, dispositions: ['rejected'] });
    await review({ family: 'family-f', model: null, reportedAt: null, verdict: 'FAIL' });
    await review({ family: null, model: null, reportedAt: null });
    await review({ legacy: true, findings: 1 });
    await review({ family: '', model: 'model-m' });
    expect(await rows()).toEqual([
      expect.objectContaining({ recorded: true, family: 'family-f', model: 'model-m', modelReported: true, reviews: 1, findings: 1, confirmedFindings: 1 }),
      { recorded: false, family: null, model: null, modelReported: null,
        reviews: 5, findings: 3, findingsPerReview: 3 / 5, confirmedFindings: 0, rejectedFindings: 1, undisposedFindings: 2, shareConfirmed: 0,
        approvingReviews: 4, defectsMissed: 0, defectsMissedPerApprovingReview: 0 },
    ]);
  });

  it('with no null snapshots there is no "not recorded" row', async () => {
    await review({});
    expect((await rows()).map(r => r.recorded)).toEqual([true]);
  });
});

describe('readers are the readers of the App\'s tasks and events (cor:agt:050:21 r19)', () => {
  it('a member reads it, and so does a worker of the App through its session', async () => {
    await review({});
    expect((await report(NOV, holder.id)).rows).toHaveLength(1);
    const memory = await db.memory.create({ data: { name: 'Reviewer system', urn: `${app.urn}:reviewer-system`, class: 'system', ownerUserId: holder.id } });
    const agent = await db.agent.create({ data: { name: 'Reviewer', urn: `${app.urn}:reviewer-agent`, systemMemoryId: memory.id, ownerUserId: holder.id } });
    const ada = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Ada', slug: 'ada', heldByUserId: holder.id } });
    const asAda = await runAsActor({ workerId: ada.id, agentId: agent.id }, () => report(NOV, holder.id));
    expect(asAda.rows).toHaveLength(1);
  });

  it('someone who may not read the App\'s events is refused exactly as the event read refuses, and as for an App that does not exist', async () => {
    await review({});
    const mine = await refusal(report(NOV, outsider.id));
    expect(mine).toEqual(await refusal(Q.agentTeamEvents!({}, { appRef: app.id }, ctx(outsider.id))));
    expect(mine).toMatchObject({ message: 'App not found.', extensions: { code: 'APP_NOT_FOUND' } });
    const missing = await refusal(report(NOV, outsider.id, generateId()));
    expect({ ...mine, extensions: { ...mine.extensions, appRef: null } }).toEqual({ ...missing, extensions: { ...missing.extensions, appRef: null } });
    // A malformed month tells an outsider nothing more: the gate answers first.
    expect(await refusal(report('not-a-month', outsider.id))).toEqual(mine);
    // No signed-in caller at all.
    await expect(Q.reviewQualityReport!({}, { appRef: app.id, month: NOV }, { db, roles: ['READER'] })).rejects.toBeTruthy();
  });

  it('the App\'s own live key reads its App\'s report as it reads the events (cor:agt:050:23); another App\'s, or a revoked key, is refused the same way', async () => {
    await review({ findings: 1 });
    const other = await appWithMembers('other');
    const key = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd' }, select: { id: true } });
    const keyCtx = () => ({ db, appId: app.id, appKeyId: key.id, roles: [] });
    const asKey = (appRef: string) => Q.reviewQualityReport!({}, { appRef, month: NOV }, keyCtx());
    const r = await asKey(app.id);
    expect(r.rows).toMatchObject([{ reviews: 1, findings: 1 }]);
    expect(r.asOf).toBeInstanceOf(Date);
    expect(await refusal(asKey(other.id))).toEqual(await refusal(Q.agentTeamEvents!({}, { appRef: other.id }, keyCtx())));
    await db.appKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    expect(await refusal(asKey(app.id))).toEqual(await refusal(Q.agentTeamEvents!({}, { appRef: app.id }, keyCtx())));
  });

  it('another App\'s reviews are never counted, even for someone who reads both', async () => {
    const other = await appWithMembers('other');
    const otherBuild = await buildIn(other);
    await review({ family: 'theirs', inApp: other, inBuild: otherBuild, findings: 3 });
    await review({ family: 'ours', findings: 1 });
    expect((await rows()).map(r => [r.family, r.reviews, r.findings])).toEqual([['ours', 1, 1]]);
    expect(((await report(NOV, owner.id, other.id)).rows as any[]).map(r => [r.family, r.reviews, r.findings])).toEqual([['theirs', 1, 3]]);
  });
});

describe('the surface', () => {
  it('a verdict recorded through recordReviewVerdict by a worker session is counted under that session\'s family and model, this month', async () => {
    const memory = await db.memory.create({ data: { name: 'Reviewer system', urn: `${app.urn}:reviewer-system`, class: 'system', ownerUserId: holder.id } });
    const agentId = (await db.agent.create({ data: { name: 'Reviewer', urn: `${app.urn}:reviewer-agent`, systemMemoryId: memory.id, ownerUserId: holder.id } })).id;
    const ada = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Ada', slug: 'ada', heldByUserId: holder.id } });
    const started = new Date(Date.now() - 60_000);
    await db.session.create({ data: { id: generateId(), appId: app.id, agentId, userId: holder.id, workerId: ada.id, startedAt: started, updatedAt: started, llmModel: 'model-live', family: 'family-live', modelReportedAt: started } });
    const asAda = <T>(fn: () => Promise<T>) => runAsActor({ workerId: ada.id, agentId }, fn);
    const t = await M.createAgentTask!({}, { input: { parentTaskId: build.id, title: 'live', assignee: { user: holder.id }, source: 'synthetic' } }, ctx(author.id));
    await M.assignReviewSeat!({}, { taskRef: t.id, slot: 's16', head: H }, ctx(author.id));
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeUserId: null, assigneeWorkerId: ada.id } });
    await asAda(() => M.startAgentTask!({}, { taskId: t.id }, ctx(holder.id)));
    await asAda(() => M.recordReviewVerdict!({}, { taskRef: t.id, head: H, verdict: 'CHANGES_REQUESTED' }, ctx(holder.id)));
    await asAda(() => M.finishAgentTask!({}, { taskId: t.id, result: { outcome: 'changes', findings: [{ severity: 'P1', text: 'a' }, { severity: 'note', text: 'b' }] } }, ctx(holder.id)));
    await M.disposeAgentTaskFinding!({}, { taskRef: t.id, findingId: 'F1', disposition: 'fixed' }, ctx(author.id));
    const event = await db.agentTeamEvent.findFirstOrThrow({ where: { taskId: t.id, type: 'review.verdict' } });
    expect(await rows(event.createdAt.toISOString().slice(0, 7))).toEqual([{
      recorded: true, family: 'family-live', model: 'model-live', modelReported: true,
      reviews: 1, findings: 2, findingsPerReview: 2, confirmedFindings: 1, rejectedFindings: 0, undisposedFindings: 1, shareConfirmed: 1 / 2,
      approvingReviews: 0, defectsMissed: 0, defectsMissedPerApprovingReview: null,
    }]);
  });

  it('the GraphQL query serves every number with its numerator and denominator', async () => {
    await review({ findings: 3, dispositions: ['fixed'] });
    await review({ family: null });
    const api = new ApolloServer({ typeDefs, resolvers });
    const res = await api.executeOperation({
      query: `query($appRef: ID!, $month: String!) { reviewQualityReport(appRef: $appRef, month: $month) {
        month asOf
        rows { recorded family model modelReported reviews findings findingsPerReview confirmedFindings rejectedFindings undisposedFindings shareConfirmed approvingReviews defectsMissed defectsMissedPerApprovingReview }
      } }`,
      variables: { appRef: app.id, month: NOV },
    }, { contextValue: ctx(owner.id) as any });
    await api.stop();
    const body = (res.body as any).singleResult;
    expect(body.errors).toBeUndefined();
    const r = body.data.reviewQualityReport;
    expect(Number.isNaN(Date.parse(r.asOf))).toBe(false);
    expect(r).toMatchObject({ month: NOV });
    expect(r.rows).toEqual([
      { recorded: true, family: 'family-f', model: 'model-m', modelReported: true, reviews: 1, findings: 3, findingsPerReview: 3, confirmedFindings: 1, rejectedFindings: 0, undisposedFindings: 2, shareConfirmed: 1 / 3, approvingReviews: 1, defectsMissed: 0, defectsMissedPerApprovingReview: 0 },
      { recorded: false, family: null, model: null, modelReported: null, reviews: 1, findings: 0, findingsPerReview: 0, confirmedFindings: 0, rejectedFindings: 0, undisposedFindings: 0, shareConfirmed: null, approvingReviews: 1, defectsMissed: 0, defectsMissedPerApprovingReview: 0 },
    ]);
  });
});

describe('#4287: defects missed, from the defect links (#4280; cor:agt:130:05, :06)', () => {
  const [H1, H2, H3] = ['1', '2', '3'].map((d) => d.repeat(40));
  let pr: any;
  /** A build with H1, H2 and H3 frozen in that order (S12b's "later head" order). */
  beforeEach(async () => {
    pr = await M.createAgentTask!({}, { input: { appRef: app.id, title: 'PR 8000', source: 'synthetic', assignee: { user: author.id }, references: [{ kind: 'PULL_REQUEST', target: 'https://github.com/example/project/pull/8000' }] } }, ctx(owner.id));
    await M.setReviewSchedule!({}, { taskRef: pr.id, slots: SLOTS }, ctx(owner.id));
    for (const head of [H1, H2, H3]) await M.freezePullRequestHead!({}, { taskRef: pr.id, head }, ctx(author.id));
  });
  /** One review.defect-linked event on the PR's build task, the payload linkDefectToPullRequest writes. */
  const link = (defect: string, introducedAtHead: string | null, task = pr) =>
    db.agentTeamEvent.create({ data: { appId: app.id, taskId: task.id, type: 'review.defect-linked', actorUserId: owner.id, payload: { defect, introducedAtHead } } });
  const D = (n: number) => `https://github.com/example/project/issues/${9000 + n}`;
  const byFamily = async () => Object.fromEntries((await rows()).map((r: any) => [r.family, r]));

  it('Victor\'s 130:05 scenario: Ada\'s APPROVE at the introducing head H2 counts; Rico\'s APPROVE at H1 does not', async () => {
    await review({ inBuild: pr, head: H2, family: 'ada' });
    await review({ inBuild: pr, head: H1, family: 'rico' });
    await link(D(1), H2);
    const f = await byFamily();
    expect(f.ada).toMatchObject({ approvingReviews: 1, defectsMissed: 1, defectsMissedPerApprovingReview: 1 });
    expect(f.rico, 'a head approved before the defect was introduced counted it').toMatchObject({ defectsMissed: 0 });
  });

  it('an approval at a head after the introducing head counts; a non-approving verdict at the introducing head does not', async () => {
    await review({ inBuild: pr, head: H3, family: 'later' });
    await review({ inBuild: pr, head: H2, family: 'changes', verdict: 'CHANGES_REQUESTED' });
    await link(D(1), H2);
    const f = await byFamily();
    expect(f.later).toMatchObject({ defectsMissed: 1 });
    expect(f.changes).toMatchObject({ approvingReviews: 0, defectsMissed: 0, defectsMissedPerApprovingReview: null });
  });

  it('a link with no introducedAtHead counts against every approving review of the PR', async () => {
    await review({ inBuild: pr, head: H1, family: 'first' });
    await review({ inBuild: pr, head: H3, family: 'last' });
    await link(D(1), null);
    const f = await byFamily();
    expect(f.first).toMatchObject({ defectsMissed: 1 });
    expect(f.last).toMatchObject({ defectsMissed: 1 });
  });

  it('two defects introduced at one head count 2 for a seat that approved it; a defect on another PR counts nothing here', async () => {
    await review({ inBuild: pr, head: H2, family: 'ada' });
    await link(D(1), H2);
    await link(D(2), H2);
    // Another PR's defects (one with no head, which would count against every approving review of THAT PR) count nothing here.
    await link(D(3), H, build);
    await link(D(4), null, build);
    expect((await byFamily()).ada).toMatchObject({ approvingReviews: 1, defectsMissed: 2, defectsMissedPerApprovingReview: 2 });
  });

  it('a family row sums its seats, and the share divides by its approving reviews', async () => {
    await review({ inBuild: pr, head: H2, family: 'ada' });
    await review({ inBuild: pr, head: H1, family: 'ada' });
    await review({ inBuild: pr, head: H2, family: 'ada', verdict: 'FAIL' });
    await link(D(1), H2);
    expect((await byFamily()).ada).toMatchObject({ reviews: 3, approvingReviews: 2, defectsMissed: 1, defectsMissedPerApprovingReview: 1 / 2 });
  });

  it('#4289 blind F1: two heads first frozen at the same instant in one transaction are ordered by event id, not tied', async () => {
    const [HA, HB] = ['a', 'b'].map((d) => d.repeat(40));
    const tied = await M.createAgentTask!({}, { input: { appRef: app.id, title: 'PR 8002', source: 'synthetic', assignee: { user: author.id }, references: [{ kind: 'PULL_REQUEST', target: 'https://github.com/example/project/pull/8002' }] } }, ctx(owner.id));
    await M.setReviewSchedule!({}, { taskRef: tied.id, slots: SLOTS }, ctx(owner.id));
    // One transaction (one tx_id), one created_at: only the ids order these two first freezes, HA's before HB's.
    const same = new Date();
    await db.$transaction(async (tx) => {
      for (const [id, head] of [['0'.repeat(31) + 'a', HA], ['0'.repeat(31) + 'b', HB]] as const) {
        await tx.agentTeamEvent.create({ data: { id, appId: app.id, taskId: tied.id, type: 'pr.frozen', actorUserId: author.id, createdAt: same,
          payload: { head, pullRequest: 'https://github.com/example/project/pull/8002' } } });
      }
    });
    await review({ inBuild: tied, head: HA, family: 'earlier' });
    await link(D(7), HB, tied);
    expect((await byFamily()).earlier, 'a tie on (created_at, tx_id) counted a defect introduced after the approved head').toMatchObject({ defectsMissed: 0 });
  });

  it('the SDL has no defectsMissedUnavailableReason, and defectsMissed is a non-null Int', async () => {
    const { buildASTSchema, parse } = await import('graphql');
    const schema = buildASTSchema(parse(typeDefs));
    const report = (schema.getType('ReviewQualityReport') as any).getFields();
    expect(report.defectsMissedUnavailableReason).toBeUndefined();
    const row = (schema.getType('ReviewQualityRow') as any).getFields();
    expect(String(row.defectsMissed.type)).toBe('Int!');
  });
});
