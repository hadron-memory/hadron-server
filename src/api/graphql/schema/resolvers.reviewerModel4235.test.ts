/**
 * #4235 S12a (Team on Orca S12, epic #4229) — a review verdict records which model reviewed.
 *
 * cor:agt:130:02 r8 (Proposed; Peter on the issue, team chat #110352): the `review.verdict` event also carries
 * `reviewerFamily`, `reviewerModel` and `modelReportedAt`, copied at record time from the session the reviewing worker
 * is bound through (`Session.family`, `Session.llmModel`, `Session.modelReportedAt`). They are a self-report, never
 * anything the verdict call supplies, null (never 'unknown') wherever nothing is recorded, a snapshot, and never read
 * for readiness (cor:agt:130:03).
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
const REPORTED = new Date('2026-11-16T04:00:00.000Z');
let owner: any, author: any, holder: any, app: any, build: any, agentId: string, ada: any;
const ctx = (userId: string, extra: Record<string, unknown> = {}) => ({ db, userId, roles: ['READER' as const], ...extra });
const asAda = <T>(fn: () => Promise<T>): Promise<T> => runAsActor({ workerId: ada.id, agentId }, fn);

type SessionFacts = { llmModel?: string | null; family?: string | null; modelReportedAt?: Date | null; startedAt?: Date; endedAt?: Date | null; workerId?: string | null };
/** A session row; Ada's unless `workerId` says otherwise (null: a person's own session, bound to no worker). */
const session = (facts: SessionFacts = {}) => {
  const startedAt = facts.startedAt ?? new Date(Date.now() - 60_000);
  return db.session.create({ data: {
    id: generateId(), appId: app.id, agentId, userId: holder.id, startedAt, updatedAt: startedAt,
    workerId: facts.workerId === undefined ? ada.id : facts.workerId,
    llmModel: facts.llmModel === undefined ? 'model-m' : facts.llmModel,
    family: facts.family === undefined ? 'family-f' : facts.family,
    modelReportedAt: facts.modelReportedAt === undefined ? REPORTED : facts.modelReportedAt,
    endedAt: facts.endedAt ?? null,
  }, select: { id: true } });
};
/** A seat on `slot` at H, assigned to Ada (or to a person) and started by its assignee. */
async function seat(slot: string, who: 'ada' | { user: string } = 'ada') {
  const person = who === 'ada' ? holder.id : who.user;
  const t = await M.createAgentTask!({}, { input: { parentTaskId: build.id, title: slot, assignee: { user: person }, source: 'synthetic' } }, ctx(author.id));
  await M.assignReviewSeat!({}, { taskRef: t.id, slot, head: H }, ctx(author.id));
  if (who === 'ada') {
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeUserId: null, assigneeWorkerId: ada.id } });
    await asAda(() => M.startAgentTask!({}, { taskRef: t.id }, ctx(holder.id)));
  } else await M.startAgentTask!({}, { taskRef: t.id }, ctx(person));
  return t;
}
const adaVerdict = (t: any, extra: Record<string, unknown> = {}, c: Record<string, unknown> = {}, verdict = 'APPROVE') =>
  asAda(() => M.recordReviewVerdict!({}, { taskRef: t.id, head: H, verdict, ...extra }, ctx(holder.id, c)));
const verdicts = async (taskId: string) =>
  (await db.agentTeamEvent.findMany({ where: { taskId, type: 'review.verdict' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(e => e.payload as Record<string, unknown>);
const only = async (taskId: string) => { const all = await verdicts(taskId); expect(all).toHaveLength(1); return all[0]!; };

beforeEach(async () => {
  await cleanDb(db);
  [owner, author, holder] = await Promise.all(['owner', 'author', 'holder'].map(handle => db.user.create({ data: { handle } })));
  const org = await db.organization.create({ data: { name: 'Review', urn: `review-${generateId()}.test` } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Review', urn: `${org.urn}:app` } });
  for (const u of [owner, author, holder]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
  const memory = await db.memory.create({ data: { name: 'Reviewer system', urn: `${app.urn}:reviewer-system`, class: 'system', ownerUserId: holder.id } });
  agentId = (await db.agent.create({ data: { name: 'Reviewer', urn: `${app.urn}:reviewer-agent`, systemMemoryId: memory.id, ownerUserId: holder.id } })).id;
  ada = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Ada', slug: 'ada', heldByUserId: holder.id } });
  build = await M.createAgentTask!({}, { input: { appRef: app.id, title: 'Build', source: 'synthetic', assignee: { user: author.id }, references: [{ kind: 'PULL_REQUEST', target: 'https://github.com/example/project/pull/1' }] } }, ctx(owner.id));
  await M.setReviewSchedule!({}, { taskRef: build.id, slots: ['local', 'blind'] }, ctx(owner.id));
  await M.freezePullRequestHead!({}, { taskRef: build.id, head: H }, ctx(author.id));
});

describe('a verdict records the reviewing session\'s family and model (cor:agt:130:02 r8, #4235 S12a)', () => {
  it('Ada\'s verdict carries her bound session\'s family, model and report time, beside the existing facts', async () => {
    await session();
    const t = await seat('local');
    await adaVerdict(t, { node: 'hrn:node:example.test:reviews:one', receipt: 'https://example.test/receipt' });
    expect(await only(t.id)).toEqual({
      slot: 'local', head: H, verdict: 'APPROVE', node: 'hrn:node:example.test:reviews:one', receipt: 'https://example.test/receipt',
      reviewerFamily: 'family-f', reviewerModel: 'model-m', modelReportedAt: REPORTED.toISOString(),
    });
  });

  it('the reviewer cannot set them: values supplied with the verdict are ignored, and the API takes no such argument', async () => {
    await session();
    const t = await seat('local');
    await adaVerdict(t, { reviewerFamily: 'supplied-family', reviewerModel: 'supplied-model', modelReportedAt: '2020-01-01T00:00:00.000Z', family: 'supplied-family', llmModel: 'supplied-model', model: 'supplied-model' });
    expect(await only(t.id)).toMatchObject({ reviewerFamily: 'family-f', reviewerModel: 'model-m', modelReportedAt: REPORTED.toISOString() });
    const api = new ApolloServer({ typeDefs, resolvers });
    const r = await api.executeOperation({ query: '{__type(name:"Mutation"){fields{name args{name}}}}' });
    const field = (r.body as any).singleResult.data.__type.fields.find((f: any) => f.name === 'recordReviewVerdict');
    expect(field.args.map((a: any) => a.name)).toEqual(['taskRef', 'head', 'verdict', 'node', 'receipt']);
    await api.stop();
  });

  it('the session is the one the request is bound through, not another open session of the same worker', async () => {
    const bound = await session({ llmModel: 'model-bound', family: 'family-bound', startedAt: new Date(Date.now() - 3_600_000) });
    await session({ llmModel: 'model-newer', family: 'family-newer' });
    const t = await seat('local');
    await adaVerdict(t, {}, { sessionId: bound.id });
    expect(await only(t.id)).toMatchObject({ reviewerFamily: 'family-bound', reviewerModel: 'model-bound' });
  });

  it('a request that names no session reads the worker\'s binding: its newest open session, never an ended one', async () => {
    await session({ llmModel: 'model-old', family: 'family-old', startedAt: new Date(Date.now() - 3_600_000) });
    await session({ llmModel: 'model-ended', family: 'family-ended', endedAt: new Date() });
    await session({ llmModel: 'model-open', family: 'family-open', startedAt: new Date(Date.now() - 120_000) });
    const t = await seat('local');
    await adaVerdict(t);
    expect(await only(t.id)).toMatchObject({ reviewerFamily: 'family-open', reviewerModel: 'model-open' });
  });

  it('another worker\'s session is never read, even when the request names it', async () => {
    const bea = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Bea', slug: 'bea', heldByUserId: holder.id } });
    const hers = await session({ workerId: bea.id, llmModel: 'model-bea', family: 'family-bea' });
    const t = await seat('local');
    await adaVerdict(t, {}, { sessionId: hers.id });
    expect(await only(t.id)).toMatchObject({ reviewerFamily: null, reviewerModel: null, modelReportedAt: null });
  });

  it('it is a snapshot: a later change to the session, or its end, changes no recorded verdict; a re-rating reads the session again', async () => {
    const s = await session();
    const t = await seat('local');
    await adaVerdict(t, {}, {}, 'CHANGES_REQUESTED');
    await db.session.update({ where: { id: s.id }, data: { llmModel: 'model-n', family: 'family-g', modelReportedAt: new Date('2026-11-16T05:00:00.000Z') } });
    expect(await only(t.id)).toMatchObject({ reviewerFamily: 'family-f', reviewerModel: 'model-m', modelReportedAt: REPORTED.toISOString() });
    await adaVerdict(t);
    await db.session.update({ where: { id: s.id }, data: { endedAt: new Date() } });
    expect((await verdicts(t.id)).map(v => [v.verdict, v.reviewerFamily, v.reviewerModel, v.modelReportedAt])).toEqual([
      ['CHANGES_REQUESTED', 'family-f', 'model-m', REPORTED.toISOString()],
      ['APPROVE', 'family-g', 'model-n', '2026-11-16T05:00:00.000Z'],
    ]);
  });
});

describe('null, never \'unknown\', where nothing is recorded', () => {
  it('a person\'s verdict (no worker session) carries null for all three, even from a session of their own that names a model', async () => {
    const own = await session({ workerId: null });
    const t = await seat('local', { user: holder.id });
    await M.recordReviewVerdict!({}, { taskRef: t.id, head: H, verdict: 'APPROVE' }, ctx(holder.id, { sessionId: own.id }));
    const v = await only(t.id);
    expect(v).toMatchObject({ verdict: 'APPROVE', reviewerFamily: null, reviewerModel: null, modelReportedAt: null });
    expect(Object.keys(v).sort()).toEqual(['head', 'modelReportedAt', 'node', 'receipt', 'reviewerFamily', 'reviewerModel', 'slot', 'verdict']);
  });

  it('an App key records no verdict at all, so it records no family or model (unchanged: TASK_NOT_FOUND)', async () => {
    await session();
    const t = await seat('local');
    const key = await db.appKey.create({ data: { appId: app.id, keyHash: generateId(), keyPreview: 'test' } });
    await expect(M.recordReviewVerdict!({}, { taskRef: t.id, head: H, verdict: 'PASS' }, { db, appId: app.id, appKeyId: key.id, roles: [] })).rejects.toMatchObject({ extensions: { code: 'TASK_NOT_FOUND' } });
    expect(await verdicts(t.id)).toEqual([]);
  });

  it('a session with no recorded model: the model is null, the family stays', async () => {
    await session({ llmModel: null, modelReportedAt: null });
    const t = await seat('local');
    await adaVerdict(t);
    expect(await only(t.id)).toMatchObject({ reviewerFamily: 'family-f', reviewerModel: null, modelReportedAt: null });
  });

  it('a session with no recorded family: the family is null, never derived from the model at verdict time', async () => {
    await session({ llmModel: 'claude-opus-4-6', family: null });
    const t = await seat('local');
    await adaVerdict(t);
    expect(await only(t.id)).toMatchObject({ reviewerFamily: null, reviewerModel: 'claude-opus-4-6', modelReportedAt: REPORTED.toISOString() });
  });

  it('a session that never reported its model: the report time is null, the recorded model and family stay', async () => {
    await session({ modelReportedAt: null });
    const t = await seat('local');
    await adaVerdict(t);
    expect(await only(t.id)).toMatchObject({ reviewerFamily: 'family-f', reviewerModel: 'model-m', modelReportedAt: null });
  });

  it('a worker with no open session: null for all three', async () => {
    await session({ endedAt: new Date() });
    const t = await seat('local');
    await adaVerdict(t);
    expect(await only(t.id)).toMatchObject({ reviewerFamily: null, reviewerModel: null, modelReportedAt: null });
  });
});

describe('readiness never reads them (cor:agt:130:03)', () => {
  it('a seat counts the same whether its verdict carries a family and model or null: two such seats make the head ready', async () => {
    await session();
    const local = await seat('local');
    await adaVerdict(local);
    await asAda(() => M.finishAgentTask!({}, { taskRef: local.id, result: { outcome: 'approved' } }, ctx(holder.id)));
    const blind = await seat('blind', { user: owner.id });
    await M.recordReviewVerdict!({}, { taskRef: blind.id, head: H, verdict: 'PASS' }, ctx(owner.id));
    await M.finishAgentTask!({}, { taskRef: blind.id, result: { outcome: 'approved' } }, ctx(owner.id));
    expect((await only(local.id)).reviewerModel).toBe('model-m');
    expect((await only(blind.id)).reviewerModel).toBeNull();
    const answer = await Q.pullRequestReadiness!({}, { taskRef: build.id, head: H }, ctx(owner.id));
    expect(answer).toMatchObject({ ready: true });
    expect(answer.slots.map((s: any) => [s.slot, s.verdict, s.counts])).toEqual([['local', 'APPROVE', true], ['blind', 'PASS', true]]);
    // The readiness answer exposes neither value.
    expect(JSON.stringify(answer)).not.toMatch(/model-m|family-f|reviewerModel|reviewerFamily|modelReportedAt/);
  });
});
