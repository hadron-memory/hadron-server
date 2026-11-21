/**
 * #4429 (Questions S5): a decider approves a question through the existing `approveNode`.
 * Specs: cor:dmo:140:05 (a decider, one decision at a time; bulk approval skips), :07 (the state), :08 (tiers),
 * cor:dmo:120 (approval and its hash). Every pin drives the resolvers, as the portal and CLI do.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbWorkerAttribution } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { questionDataSchema } from '../../../lib/questions/codec.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let admin: { id: string };
let writer: { id: string };
let holger: { id: string };
let second: { id: string };
let orgId: string;
let memory: { id: string };

const as = (userId = admin.id, extra: Partial<Context> = {}): Context => ({ db, userId, roles: [], ...extra });
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const D = (resolvers as unknown as { Question: Record<string, (v: any, a: unknown, ctx: Context) => any> }).Question;

const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) { return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message; }
};

const createLog = (deciders: string[] = [holger.id]) =>
  M.createQuestionLog(null, { memoryRef: memory.id, loc: 'questions', defaultDeciders: deciders }, as());
const ask = (logRef: string, extra: Record<string, unknown> = {}) =>
  M.askQuestion(null, { logRef, input: { title: 'Ship the codec?', yesno: true, recommendation: { key: 'yes', reason: 'ready' }, ...extra } }, as(writer.id));
const rowOf = (id: string) => db.node.findUniqueOrThrow({ where: { id } });
const dataOf = async (id: string) => questionDataSchema.parse((await rowOf(id)).data);
const answer = (id: string, optionKey: string, revision: number, ctx = as(holger.id)) =>
  M.answerQuestion(null, { ref: id, input: { optionKey }, expectedRevision: revision }, ctx);
const retract = (id: string, revision: number, ctx = as(holger.id)) =>
  M.retractQuestionAnswer(null, { ref: id, expectedRevision: revision }, ctx);
const approve = (id: string, revision?: number, ctx = as(holger.id)) =>
  M.approveNode(null, { nodeRef: id, ...(revision === undefined ? {} : { revision }) }, ctx);
const view = (id: string) => Q.question(null, { ref: id }, as());
const stateOf = async (id: string) => D.state(await view(id), {}, as());

/** A question asked, and answered once by the decider: the starting point of most pins. */
async function answered(extra: Record<string, unknown> = {}) {
  const log = await createLog();
  const q = await ask(log.row.id, extra);
  await answer(q.row.id, 'yes', q.row.revSeq);
  return { log, id: q.row.id as string };
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Approval Org', urn: 'approval.example' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 442901, githubUsername: 'ap-admin', handle: 'ap-admin', roles: [] } });
  writer = await db.user.create({ data: { githubId: 442902, githubUsername: 'ap-writer', handle: 'ap-writer', roles: [] } });
  holger = await db.user.create({ data: { githubId: 442903, githubUsername: 'ap-holger', handle: 'ap-holger', roles: [] } });
  second = await db.user.create({ data: { githubId: 442904, githubUsername: 'ap-second', handle: 'ap-second', roles: [] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: writer.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: holger.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: second.id, role: 'CONTRIBUTOR' },
  ] });
  memory = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'team-shared' }, as());
});

describe('approveNode on a question: a decider approves (#4429 acceptance 1, 2, 4, 5)', () => {
  it('an answered tier-APPROVED question is DECIDED by its decider, with the approval on the current revision and no new revision', async () => {
    const { id } = await answered({ tier: 'APPROVED' });
    expect(await stateOf(id)).toBe('ANSWERED_UNCONFIRMED');
    const rev = (await rowOf(id)).revSeq;
    await approve(id, rev);
    const row = await rowOf(id);
    expect(row.revSeq).toBe(rev);
    expect(row.approvedRevNo).toBe(rev);
    expect(row.approvedBy).toBe(holger.id);
    const v = await view(id);
    expect(D.state(v, {}, as())).toBe('DECIDED');
    const evidence = await D.evidence(v, {}, as());
    expect(evidence.approval).toMatchObject({ byUserId: holger.id, revision: rev, integrity: 'INTACT', byDecider: true });
  });

  it('a re-answer makes it STALE, a new approval DECIDED again, and a take-back OPEN', async () => {
    const { id } = await answered({ tier: 'APPROVED' });
    await approve(id, (await rowOf(id)).revSeq);
    expect(await stateOf(id)).toBe('DECIDED');
    await answer(id, 'no', (await rowOf(id)).revSeq);
    expect(await stateOf(id)).toBe('STALE');
    await approve(id, (await rowOf(id)).revSeq);
    expect(await stateOf(id)).toBe('DECIDED');
    await retract(id, (await rowOf(id)).revSeq);
    expect(await stateOf(id)).toBe('OPEN');
  });

  it('the default tier: approving an answered question succeeds, stays DECIDED, and shows as evidence', async () => {
    const { id } = await answered();
    expect(await stateOf(id)).toBe('DECIDED');
    await approve(id);
    expect(await stateOf(id)).toBe('DECIDED');
    expect((await D.evidence(await view(id), {}, as())).approval).toMatchObject({ byDecider: true, integrity: 'INTACT' });
  });

  it('the signed tier: an approval is recorded but never makes the question DECIDED', async () => {
    const { id } = await answered({ tier: 'SIGNED' });
    await approve(id);
    expect((await rowOf(id)).approvedRevNo).not.toBeNull();
    expect(await stateOf(id)).toBe('ANSWERED_UNCONFIRMED');
  });
});

describe('approveNode on a question: the refusals stamp nothing (#4429 acceptance 3)', () => {
  const unstamped = async (id: string) => expect((await rowOf(id)).approvedRevNo).toBeNull();

  it('an unanswered question is QUESTION_NOT_ANSWERED, also after a take-back', async () => {
    const q = await ask((await createLog()).row.id, { tier: 'APPROVED' });
    expect(await codeOf(approve(q.row.id))).toBe('QUESTION_NOT_ANSWERED');
    await unstamped(q.row.id);
    await answer(q.row.id, 'yes', q.row.revSeq);
    await retract(q.row.id, (await rowOf(q.row.id)).revSeq);
    expect(await codeOf(approve(q.row.id))).toBe('QUESTION_NOT_ANSWERED');
    await unstamped(q.row.id);
  });

  it('a memory writer who is not a decider is QUESTION_NOT_DECIDER', async () => {
    const { id } = await answered({ tier: 'APPROVED' });
    expect(await codeOf(approve(id, undefined, as(writer.id)))).toBe('QUESTION_NOT_DECIDER');
    expect(await codeOf(approve(id, undefined, as(admin.id)))).toBe('QUESTION_NOT_DECIDER');
    await unstamped(id);
  });

  it('a decider in a worker-bound session, and an App-key caller, are QUESTION_NOT_DECIDER', async () => {
    const { id } = await answered({ tier: 'APPROVED' });
    await createDbWorkerAttribution(db, holger.id, 'worker-bot');
    const asWorker = <T>(fn: () => Promise<T>) => runAsActor({ workerId: 'worker-bot', agentId: null, userId: holger.id }, fn);
    expect(await codeOf(asWorker(() => approve(id)))).toBe('QUESTION_NOT_DECIDER');
    expect(await codeOf(approve(id, undefined, as(holger.id, { appKeyId: generateId(), appId: generateId() } as never)))).toBe('QUESTION_NOT_DECIDER');
    await unstamped(id);
  });

  it('a decider under impersonation is refused', async () => {
    const { id } = await answered({ tier: 'APPROVED' });
    expect(await codeOf(approve(id, undefined, as(holger.id, { impersonation: { actorUserId: admin.id } } as never)))).toBe('QUESTION_IMPERSONATION_REFUSED');
    await unstamped(id);
  });

  it('a decider who lost write access is FORBIDDEN, from the generic approval gate (mayApproveNodes) that runs before the question gate', async () => {
    const { id } = await answered({ tier: 'APPROVED' });
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: holger.id } }, data: { role: 'READER' } });
    expect(await codeOf(approve(id))).toBe('FORBIDDEN');
    await unstamped(id);
  });

  it('a decider the log no longer names is QUESTION_NOT_DECIDER', async () => {
    const { log, id } = await answered({ tier: 'APPROVED' });
    await M.setQuestionLogDeciders(null, { logRef: log.row.id, defaultDeciders: [second.id], expectedRevision: (await rowOf(log.row.id)).revSeq, reason: 'rota' }, as());
    expect(await codeOf(approve(id))).toBe('QUESTION_NOT_DECIDER');
    await unstamped(id);
  });

  it('a withdrawn question is QUESTION_WITHDRAWN', async () => {
    const { id } = await answered({ tier: 'APPROVED' });
    await M.withdrawQuestion(null, { ref: id, reason: 'moot', expectedRevision: (await rowOf(id)).revSeq }, as(holger.id));
    expect(await codeOf(approve(id))).toBe('QUESTION_WITHDRAWN');
    await unstamped(id);
  });

  it('a tampered question is QUESTION_INVALID', async () => {
    const { id } = await answered({ tier: 'APPROVED' });
    await db.node.update({ where: { id }, data: { content: 'edited outside the doors' } });
    expect(await codeOf(approve(id))).toBe('QUESTION_INVALID');
    await unstamped(id);
  });

  it('an unverifiable question (another codec) is QUESTION_INVALID', async () => {
    const { id } = await answered({ tier: 'APPROVED' });
    await db.node.update({ where: { id }, data: { data: { ...((await rowOf(id)).data as object), codec: 'question@0' } as never } });
    expect(await codeOf(approve(id))).toBe('QUESTION_INVALID');
    await unstamped(id);
  });

  it('a stale revision is REVISION_MISMATCH, and a log is QUESTION_LOG_NOT_APPROVABLE', async () => {
    const { log, id } = await answered({ tier: 'APPROVED' });
    const rev = (await rowOf(id)).revSeq;
    expect(await codeOf(approve(id, rev - 1))).toBe('REVISION_MISMATCH');
    await unstamped(id);
    expect(await codeOf(approve(log.row.id))).toBe('QUESTION_LOG_NOT_APPROVABLE');
    expect((await rowOf(log.row.id)).approvedRevNo).toBeNull();
  });

  it('an already approved revision still checks the caller first: a non-decider is refused, the decider is idempotent', async () => {
    const { id } = await answered({ tier: 'APPROVED' });
    await approve(id);
    const stamped = await rowOf(id);
    expect(await codeOf(approve(id, undefined, as(writer.id)))).toBe('QUESTION_NOT_DECIDER');
    await approve(id);
    const again = await rowOf(id);
    expect(again.approvedAt?.getTime()).toBe(stamped.approvedAt?.getTime());
    expect(again.revSeq).toBe(stamped.revSeq);
  });
});

describe('bulk approval still skips every question (#4429 acceptance 6)', () => {
  it('approveMemoryNodes approves the ordinary nodes only and reports the question and its log', async () => {
    const { id } = await answered({ tier: 'APPROVED' });
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'ordinary', name: 'Ordinary', content: 'x' } });
    const bulk = await M.approveMemoryNodes(null, { memoryRef: memory.id }, as());
    expect(bulk).toMatchObject({ skippedQuestionCount: 2 });
    expect(bulk.approved.map((r: { loc: string }) => r.loc)).toContain('ordinary');
    expect((await rowOf(id)).approvedRevNo).toBeNull();
    expect(await stateOf(id)).toBe('ANSWERED_UNCONFIRMED');
  });
});
