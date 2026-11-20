/**
 * #4427 (Questions S3): the answer door, the take-back door, the one decider gate, and
 * `viewerMayAnswer`. Spec: cor:dmo:140:05 (who may act on a question), cor:dmo:140:09 (how
 * questions show: refusals typed). Every pin drives the resolvers, as the portal, CLI and MCP do.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbWorkerAttribution } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { questionDataSchema, MAX_ANSWERS, type AnswerEntry, type QuestionData } from '../../../lib/questions/codec.js';
import { questionName, renderQuestion, renderQuestionAbstract } from '../../../lib/questions/render.js';
import { computeApprovalHash } from '../../../lib/approvalHash.js';
import { approvedMergeProof } from '../../../test/mergeConsent.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let admin: { id: string };
let writer: { id: string };
let holger: { id: string };
let second: { id: string };
let reader: { id: string };
let platformAdmin: { id: string };
let orgId: string;
let memory: { id: string };

const as = (userId = admin.id, extra: Partial<Context> = {}): Context => ({ db, userId, roles: [], ...extra });
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const D = (resolvers as unknown as { Question: Record<string, (v: any, a: unknown, ctx: Context) => any> }).Question;

const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) { return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message; }
};
const errorOf = async (p: Promise<unknown>): Promise<GraphQLError> => {
  try { await p; } catch (e) { return e as GraphQLError; }
  throw new Error('expected a refusal');
};

const createLog = (deciders: string[] = [holger.id]) =>
  M.createQuestionLog(null, { memoryRef: memory.id, loc: 'questions', defaultDeciders: deciders }, as());
const ask = (logRef: string, input: Record<string, unknown> = { title: 'Ship the codec?', yesno: true, recommendation: { key: 'yes', reason: 'ready' } }, userId = writer.id) =>
  M.askQuestion(null, { logRef, input }, as(userId));
const freeText = (logRef: string) => ask(logRef, { title: 'What should we call it?' });
const rowOf = (id: string) => db.node.findUniqueOrThrow({ where: { id } });
const dataOf = async (id: string) => questionDataSchema.parse((await rowOf(id)).data);

const answer = (id: string, input: Record<string, unknown>, revision: number, ctx = as(holger.id)) =>
  M.answerQuestion(null, { ref: id, input, expectedRevision: revision }, ctx);
const retract = (id: string, revision: number, extra: Record<string, unknown> = {}, ctx = as(holger.id)) =>
  M.retractQuestionAnswer(null, { ref: id, expectedRevision: revision, ...extra }, ctx);

/** Seed answer entries straight into the stored question, consistently (a fixture for the entry limit). */
async function seedEntries(id: string, entries: AnswerEntry[]): Promise<void> {
  const d = await dataOf(id);
  const next: QuestionData = { ...d, answers: entries, status: entries[entries.length - 1]?.kind === 'answer' ? 'answered' : 'open' };
  await db.node.update({ where: { id }, data: {
    name: questionName(next), abstract: renderQuestionAbstract(next), content: renderQuestion(next), data: next as never, revisionContentHash: 'refresh',
  } });
}

/** Stands in for the approval door, which questions do not have yet (approveNode answers QUESTION_NOT_APPROVABLE): holger approved the standing revision. */
async function approveAsHolger(id: string): Promise<void> {
  const r = await rowOf(id);
  await db.node.update({ where: { id }, data: {
    approvedBy: holger.id, approvedRevNo: r.revSeq, approvedAt: new Date(),
    approvalHash: computeApprovalHash({ title: r.name, abstract: r.abstract, content: r.content }),
  } });
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Answer Org', urn: 'answer.example' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 442701, githubUsername: 'qa-admin', handle: 'qa-admin', roles: [] } });
  writer = await db.user.create({ data: { githubId: 442702, githubUsername: 'qa-writer', handle: 'qa-writer', roles: [] } });
  holger = await db.user.create({ data: { githubId: 442703, githubUsername: 'qa-holger', handle: 'qa-holger', roles: [] } });
  second = await db.user.create({ data: { githubId: 442704, githubUsername: 'qa-second', handle: 'qa-second', roles: [] } });
  reader = await db.user.create({ data: { githubId: 442705, githubUsername: 'qa-reader', handle: 'qa-reader', roles: [] } });
  platformAdmin = await db.user.create({ data: { githubId: 442706, githubUsername: 'qa-platform', handle: 'qa-platform', roles: ['ADMIN'] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: writer.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: holger.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: second.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: reader.id, role: 'READER' },
    { organizationId: org.id, userId: platformAdmin.id, role: 'CONTRIBUTOR' },
  ] });
  memory = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'team-shared' }, as());
});

describe('answerQuestion: a decider answers, again, and takes it back', () => {
  it('one decider answer settles an ordinary question and records who, when and how', async () => {
    const q = await ask((await createLog()).row.id);
    const view = await answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq);
    const d = await dataOf(q.row.id);
    expect(d.answers).toHaveLength(1);
    expect(d.answers[0]).toMatchObject({ kind: 'answer', key: 'yes', text: null, reason: null, by: holger.id, via: 'api' });
    expect(D.state(view, {}, as())).toBe('DECIDED');
    expect(D.answered(view, {}, as())).toBe(true);
    expect((await rowOf(q.row.id)).revSeq).toBe(q.row.revSeq + 1);
  });

  it('free text alone, or beside an option, is an answer; the client states where it was given', async () => {
    const log = await createLog();
    const a = await freeText(log.row.id);
    await answer(a.row.id, { text: 'Call it Hadron.', via: 'CLI' }, a.row.revSeq);
    expect((await dataOf(a.row.id)).answers[0]).toMatchObject({ key: null, text: 'Call it Hadron.', via: 'cli' });
    const b = await ask(log.row.id);
    await answer(b.row.id, { optionKey: 'no', text: 'Not before Friday.', via: 'MCP' }, b.row.revSeq);
    expect((await dataOf(b.row.id)).answers[0]).toMatchObject({ key: 'no', text: 'Not before Friday.', via: 'mcp' });
  });

  it('an answer names an option or gives text: neither is QUESTION_INVALID at /input, and blank text is not text', async () => {
    const q = await ask((await createLog()).row.id);
    for (const input of [{}, { text: '   ' }, { text: '\n\t' }]) {
      const e = await errorOf(answer(q.row.id, input, q.row.revSeq));
      expect(e.extensions.code).toBe('QUESTION_INVALID');
      expect((e.extensions.pointers as Array<{ pointer: string }>)[0].pointer).toBe('/input');
    }
    expect((await dataOf(q.row.id)).answers).toHaveLength(0);
  });

  it('input is validated: an option key of the wrong shape, over-long text and an over-long reason are QUESTION_INVALID', async () => {
    const q = await ask((await createLog()).row.id);
    expect(await codeOf(answer(q.row.id, { optionKey: 'not a key!' }, q.row.revSeq))).toBe('QUESTION_INVALID');
    expect(await codeOf(answer(q.row.id, { text: 'x'.repeat(20_001) }, q.row.revSeq))).toBe('QUESTION_INVALID');
    expect(await codeOf(answer(q.row.id, { optionKey: 'yes', reason: 'r'.repeat(2_001) }, q.row.revSeq))).toBe('QUESTION_INVALID');
  });

  it('an option the question does not have is QUESTION_UNKNOWN_OPTION, and so is any option on a free-text question', async () => {
    const log = await createLog();
    const q = await ask(log.row.id);
    const e = await errorOf(answer(q.row.id, { optionKey: 'maybe' }, q.row.revSeq));
    expect(e.extensions.code).toBe('QUESTION_UNKNOWN_OPTION');
    expect(e.extensions).toMatchObject({ optionKey: 'maybe' });
    const f = await freeText(log.row.id);
    expect(await codeOf(answer(f.row.id, { optionKey: 'yes' }, f.row.revSeq))).toBe('QUESTION_UNKNOWN_OPTION');
    expect((await dataOf(q.row.id)).answers).toHaveLength(0);
  });

  it('answering again appends a new entry on the same node; the earlier answer stays, in order', async () => {
    const q = await ask((await createLog()).row.id);
    await answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq);
    const r1 = (await rowOf(q.row.id)).revSeq;
    const view = await answer(q.row.id, { optionKey: 'no', reason: 'new facts' }, r1);
    const d = await dataOf(q.row.id);
    expect(d.answers.map((a) => [a.kind, a.key, a.reason])).toEqual([['answer', 'yes', null], ['answer', 'no', 'new facts']]);
    expect((await D.answer(view, {}, as()))?.key).toBe('no');
    expect(await db.node.count({ where: { memoryId: memory.id, role: 'question' } })).toBe(1);
  });

  it('the identical answer again, with no reason, writes nothing: no entry and no revision', async () => {
    const q = await ask((await createLog()).row.id);
    await answer(q.row.id, { optionKey: 'yes', text: 'go' }, q.row.revSeq);
    const before = await rowOf(q.row.id);
    const view = await answer(q.row.id, { optionKey: 'yes', text: 'go' }, before.revSeq);
    expect(view.row.revSeq).toBe(before.revSeq);
    expect((await dataOf(q.row.id)).answers).toHaveLength(1);
    // with a reason it is an entry: the reason is the new information
    await answer(q.row.id, { optionKey: 'yes', text: 'go', reason: 'confirming' }, before.revSeq);
    expect((await dataOf(q.row.id)).answers).toHaveLength(2);
  });

  it('taking the answer back leaves the question open again, the answer in its history, then it can be answered again', async () => {
    const q = await ask((await createLog()).row.id);
    await answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq);
    const r1 = (await rowOf(q.row.id)).revSeq;
    const view = await retract(q.row.id, r1, { reason: 'misread it', via: 'PORTAL' });
    const d = await dataOf(q.row.id);
    expect(d.answers.map((a) => a.kind)).toEqual(['answer', 'retraction']);
    expect(d.answers[1]).toMatchObject({ key: null, text: null, reason: 'misread it', by: holger.id, via: 'portal' });
    expect(D.state(view, {}, as())).toBe('OPEN');
    expect(D.answered(view, {}, as())).toBe(false);
    expect(d.status).toBe('open');
    await answer(q.row.id, { optionKey: 'no' }, (await rowOf(q.row.id)).revSeq);
    expect((await dataOf(q.row.id)).answers.map((a) => a.kind)).toEqual(['answer', 'retraction', 'answer']);
  });

  it('there is nothing to take back on an open question, or after a take-back: QUESTION_NOT_ANSWERED', async () => {
    const q = await ask((await createLog()).row.id);
    expect(await codeOf(retract(q.row.id, q.row.revSeq))).toBe('QUESTION_NOT_ANSWERED');
    await answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq);
    await retract(q.row.id, (await rowOf(q.row.id)).revSeq);
    expect(await codeOf(retract(q.row.id, (await rowOf(q.row.id)).revSeq))).toBe('QUESTION_NOT_ANSWERED');
  });

  it('the answer covers exactly the revision the decider saw: a stale revision is NODE_WRITE_CONFLICT, for both doors', async () => {
    const q = await ask((await createLog()).row.id);
    expect(await codeOf(answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq + 5))).toBe('NODE_WRITE_CONFLICT');
    await answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq);
    expect(await codeOf(answer(q.row.id, { optionKey: 'no' }, q.row.revSeq))).toBe('NODE_WRITE_CONFLICT');
    expect(await codeOf(retract(q.row.id, q.row.revSeq))).toBe('NODE_WRITE_CONFLICT');
    expect((await dataOf(q.row.id)).answers).toHaveLength(1);
  });

  it('two deciders answering the same revision at once: one answer is recorded, the other is NODE_WRITE_CONFLICT', async () => {
    const q = await ask((await createLog([holger.id, second.id])).row.id);
    const results = await Promise.all([
      codeOf(answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq, as(holger.id))),
      codeOf(answer(q.row.id, { optionKey: 'no' }, q.row.revSeq, as(second.id))),
    ]);
    expect(results.sort()).toEqual(['NODE_WRITE_CONFLICT', 'NO_ERROR']);
    expect((await dataOf(q.row.id)).answers).toHaveLength(1);
  });

  it('a withdrawn question is not answered or taken back: QUESTION_WITHDRAWN; an unknown ref is QUESTION_NOT_FOUND', async () => {
    const log = await createLog();
    const q = await ask(log.row.id);
    await M.withdrawQuestion(null, { ref: q.row.id, reason: 'moot', expectedRevision: q.row.revSeq }, as(writer.id));
    const r = (await rowOf(q.row.id)).revSeq;
    expect(await codeOf(answer(q.row.id, { optionKey: 'yes' }, r))).toBe('QUESTION_WITHDRAWN');
    expect(await codeOf(retract(q.row.id, r))).toBe('QUESTION_WITHDRAWN');
    expect(await codeOf(answer(generateId(), { optionKey: 'yes' }, 1))).toBe('QUESTION_NOT_FOUND');
  });

  it('the entry limit is refused at /input rather than truncating history', async () => {
    const q = await ask((await createLog()).row.id);
    const entry: AnswerEntry = { kind: 'answer', key: 'yes', text: null, reason: null, by: holger.id, at: '2026-11-01T00:00:00.000Z', via: 'api' };
    await seedEntries(q.row.id, Array.from({ length: MAX_ANSWERS }, (_, i) => ({ ...entry, key: i % 2 ? 'no' : 'yes' })));
    const r = (await rowOf(q.row.id)).revSeq;
    const e = await errorOf(answer(q.row.id, { optionKey: 'no', reason: 'one more' }, r));
    expect(e.extensions.code).toBe('QUESTION_INVALID');
    expect((e.extensions.pointers as Array<{ pointer: string }>)[0].pointer).toBe('/input');
    expect((await dataOf(q.row.id)).answers).toHaveLength(MAX_ANSWERS);
  });

  it('the revision label carries the option and the reason, never the free text', async () => {
    const log = await createLog();
    const a = await freeText(log.row.id);
    await answer(a.row.id, { text: 'a very private sentence' , reason: 'because'}, a.row.revSeq);
    const rev = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: a.row.id }, orderBy: { revNo: 'desc' } });
    expect(rev.revLabel).toBe('answer (text): because');
    const b = await ask(log.row.id);
    await answer(b.row.id, { optionKey: 'yes' }, b.row.revSeq);
    const rev2 = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: b.row.id }, orderBy: { revNo: 'desc' } });
    expect(rev2.revLabel).toBe('answer yes');
  });
});

describe('the one decider gate: who may act as a decider', () => {
  it('a writer who is not a decider is QUESTION_NOT_DECIDER; a user with no write access is QUESTION_FORBIDDEN; nothing is recorded', async () => {
    const q = await ask((await createLog()).row.id);
    expect(await codeOf(answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq, as(writer.id)))).toBe('QUESTION_NOT_DECIDER');
    expect(await codeOf(answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq, as(admin.id)))).toBe('QUESTION_NOT_DECIDER');
    expect(await codeOf(answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq, as(reader.id)))).toBe('QUESTION_FORBIDDEN');
    expect((await dataOf(q.row.id)).answers).toHaveLength(0);
  });

  it('a worker session whose holder is a decider cannot answer or take back as that decider', async () => {
    const q = await ask((await createLog()).row.id);
    await createDbWorkerAttribution(db, holger.id, 'worker-bot');
    const asWorker = <T>(fn: () => Promise<T>) => runAsActor({ workerId: 'worker-bot', agentId: null, userId: holger.id }, fn);
    const e = await errorOf(asWorker(() => answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq)));
    expect(e.extensions.code).toBe('QUESTION_NOT_DECIDER');
    expect(e.message).toMatch(/worker or agent session cannot answer/i);
    await seedEntries(q.row.id, [{ kind: 'answer', key: 'yes', text: null, reason: null, by: holger.id, at: '2026-11-01T00:00:00.000Z', via: 'api' }]);
    const seeded = (await rowOf(q.row.id)).revSeq;
    expect(await codeOf(asWorker(() => retract(q.row.id, seeded)))).toBe('QUESTION_NOT_DECIDER');
    expect((await dataOf(q.row.id)).answers).toHaveLength(1);
  });

  it('the decider arms of amend and withdraw use the same gate: a worker session on a decider\'s account is refused, a person is not', async () => {
    const q = await ask((await createLog()).row.id);
    await seedEntries(q.row.id, [{ kind: 'answer', key: 'yes', text: null, reason: null, by: holger.id, at: '2026-11-01T00:00:00.000Z', via: 'api' }]);
    const r = (await rowOf(q.row.id)).revSeq;
    await createDbWorkerAttribution(db, holger.id, 'worker-bot');
    const asWorker = <T>(fn: () => Promise<T>) => runAsActor({ workerId: 'worker-bot', agentId: null, userId: holger.id }, fn);
    const amend = (ctx: Context) => M.amendQuestion(null, { ref: q.row.id, input: { priority: 'HIGH' }, expectedRevision: r, reason: 'x' }, ctx);
    expect(await codeOf(asWorker(() => amend(as(holger.id))))).toBe('QUESTION_NOT_DECIDER');
    expect(await codeOf(asWorker(() => M.withdrawQuestion(null, { ref: q.row.id, reason: 'x', expectedRevision: r }, as(holger.id))))).toBe('QUESTION_NOT_DECIDER');
    expect(await codeOf(amend(as(holger.id)))).toBe('NO_ERROR'); // the person, as themselves, still amends
  });

  it('an agent session, and a connection bound to several actors with none named, are refused like a worker', async () => {
    const q = await ask((await createLog()).row.id);
    const agent = await runAsActor({ workerId: null, agentId: 'agent-bot', userId: holger.id }, () => codeOf(answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq)));
    expect(agent).toBe('QUESTION_NOT_DECIDER');
    const ambiguous = await runAsActor({ workerId: null, agentId: null, userId: holger.id, ambiguousSessionIds: ['s1', 's2'] }, () => codeOf(answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq)));
    expect(ambiguous).toBe('QUESTION_NOT_DECIDER');
    expect((await dataOf(q.row.id)).answers).toHaveLength(0);
  });

  it('a worker that asked still withdraws its own unanswered question through the asker arm, but not as a decider', async () => {
    const log = await createLog([holger.id]);
    await createDbWorkerAttribution(db, writer.id, 'worker-bot');
    await createDbWorkerAttribution(db, holger.id, 'worker-other');
    const asked = await runAsActor({ workerId: 'worker-bot', agentId: null, userId: writer.id }, () => ask(log.row.id));
    // the worker is on holger's token: it is the asker's worker, not a decider
    const e = await codeOf(runAsActor({ workerId: 'worker-other', agentId: null, userId: holger.id }, () =>
      M.withdrawQuestion(null, { ref: asked.row.id, reason: 'x', expectedRevision: asked.row.revSeq }, as(holger.id))));
    expect(e).toBe('QUESTION_NOT_ASKER');
    const ok = await codeOf(runAsActor({ workerId: 'worker-bot', agentId: null, userId: writer.id }, () =>
      M.withdrawQuestion(null, { ref: asked.row.id, reason: 'moot', expectedRevision: asked.row.revSeq }, as(writer.id))));
    expect(ok).toBe('NO_ERROR');
  });

  it('an impersonated session and an App-key caller never answer', async () => {
    const q = await ask((await createLog()).row.id);
    const imp = answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq, as(holger.id, { impersonation: { actorUserId: admin.id } } as never));
    expect(await codeOf(imp)).toBe('QUESTION_IMPERSONATION_REFUSED');
    const withKey = answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq, as(holger.id, { appKeyId: generateId(), appId: generateId() } as never));
    expect(await codeOf(withKey)).toBe('QUESTION_NOT_DECIDER');
    const keyOnly: Context = { db, roles: [], appKeyId: generateId(), appId: generateId() } as never;
    expect(await codeOf(answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq, keyOnly))).not.toBe('NO_ERROR');
    expect((await dataOf(q.row.id)).answers).toHaveLength(0);
  });

  it('a headless run is not a person: a run principal on a decider\'s account cannot answer', async () => {
    const q = await ask((await createLog()).row.id);
    expect(await codeOf(answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq, as(holger.id, { clientId: 'run:abc' } as never)))).toBe('QUESTION_NOT_DECIDER');
  });

  it('a person with an active App selected still answers as themselves', async () => {
    const q = await ask((await createLog()).row.id);
    await answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq, as(holger.id, { appId: generateId() } as never));
    expect((await dataOf(q.row.id)).answers).toHaveLength(1);
  });

  it('a log decider the asker did not name on this question cannot answer it, though they can write the memory and sit on the log', async () => {
    const log = await createLog([holger.id, second.id]);
    const q = await ask(log.row.id, { title: 'Ship it?', yesno: true, recommendation: { key: 'yes', reason: 'ready' }, deciders: [holger.id] });
    expect(await codeOf(answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq, as(second.id)))).toBe('QUESTION_NOT_DECIDER');
    expect((await dataOf(q.row.id)).answers).toHaveLength(0);
    await answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq, as(holger.id));
  });

  it('a stored decider the log no longer names is refused, with the same message as any other failed identity check', async () => {
    const log = await createLog([holger.id, second.id]);
    const q = await ask(log.row.id, undefined, writer.id);
    await M.setQuestionLogDeciders(null, { logRef: log.row.id, defaultDeciders: [second.id], expectedRevision: log.row.revSeq, reason: 'rotate' }, as());
    const gone = await errorOf(answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq, as(holger.id)));
    const never = await errorOf(answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq, as(writer.id)));
    expect(gone.extensions.code).toBe('QUESTION_NOT_DECIDER');
    expect(gone.message).toBe(never.message); // no oracle on which of the three checks failed
    await answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq, as(second.id)); // the surviving decider still answers
  });

  it('a decider who can write only through a platform role, not as themselves, is refused', async () => {
    const log = await createLog([platformAdmin.id]);
    const q = await ask(log.row.id);
    await db.orgMember.updateMany({ where: { organizationId: orgId, userId: platformAdmin.id }, data: { deletedAt: new Date() } });
    const ctx = as(platformAdmin.id, { roles: ['ADMIN'] });
    expect(await codeOf(answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq, ctx))).toBe('QUESTION_NOT_DECIDER');
    expect((await dataOf(q.row.id)).answers).toHaveLength(0);
  });
});

describe('viewerMayAnswer: the same gate, read side', () => {
  it('is true for an eligible decider acting as themselves, and false for everyone else and in every blocked state', async () => {
    const q = await ask((await createLog()).row.id);
    const view = async (ctx: Context) => D.viewerMayAnswer({ ...q, shown: await dataOf(q.row.id), row: await rowOf(q.row.id), evaluation: { state: 'OPEN', question: await dataOf(q.row.id) } }, {}, ctx);
    expect(await view(as(holger.id))).toBe(true);
    expect(await view(as(writer.id))).toBe(false);
    expect(await view(as(reader.id))).toBe(false);
    expect(await runAsActor({ workerId: 'worker-bot', agentId: null, userId: holger.id }, () => view(as(holger.id)))).toBe(false); // a read: no worker row needed
    expect(await view(as(holger.id, { impersonation: { actorUserId: admin.id } } as never))).toBe(false);
    for (const state of ['WITHDRAWN', 'TAMPERED', 'UNVERIFIABLE']) {
      expect(await D.viewerMayAnswer({ row: await rowOf(q.row.id), shown: await dataOf(q.row.id), evaluation: { state, question: null } }, {}, as(holger.id))).toBe(false);
    }
    // viewerIsDecider keeps its meaning: the stored list, so a worker session still shows "you are a decider"
    expect(await D.viewerIsDecider({ shown: await dataOf(q.row.id) }, {}, as(holger.id))).toBe(true);
  });
});

describe('#4532 blind review: approved re-answer, merged decider, a missing log', () => {
  it('a question whose answer was approved is answered again on the same node, as a new revision', async () => {
    const q = await ask((await createLog()).row.id);
    await answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq);
    const r = await rowOf(q.row.id);
    // Stands in for the approval door: holger approved the standing revision.
    await approveAsHolger(q.row.id);
    await answer(q.row.id, { optionKey: 'no', reason: 'after approval' }, r.revSeq);
    expect((await rowOf(q.row.id)).revSeq).toBeGreaterThan(r.revSeq);
    const d = await dataOf(q.row.id);
    expect(d.answers.map((a) => [a.kind, a.key])).toEqual([['answer', 'yes'], ['answer', 'no']]);
    expect(await db.node.count({ where: { memoryId: memory.id, role: 'question' } })).toBe(1);
  });

  it('the survivor of a merge answers as the decider the merged account was; the stored list is not rewritten', async () => {
    const q = await ask((await createLog()).row.id);
    const survivor = await db.user.create({ data: { githubId: 442799, githubUsername: 'qa-survivor', handle: 'qa-survivor', roles: [] } });
    await db.orgMember.create({ data: { organizationId: orgId, userId: survivor.id, role: 'CONTRIBUTOR' } });
    await M.mergeUsers(null, { input: { source: holger.id, target: survivor.id, consentProof: await approvedMergeProof(db, holger.id, survivor.id, platformAdmin.id) } }, as(platformAdmin.id, { roles: ['ADMIN'] }));
    const view = await answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq, as(survivor.id));
    expect((await D.answer(view, {}, as()))?.key).toBe('yes');
    expect((await dataOf(q.row.id)).deciders).toEqual([holger.id]);
  });

  it('a question whose log is gone is a typed refusal on every act door, never INTERNAL, and not answerable on the read side', async () => {
    const log = await createLog();
    const q = await ask(log.row.id);
    await db.node.update({ where: { id: log.row.id }, data: { deletedAt: new Date() } });
    expect(await codeOf(answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq))).toBe('QUESTION_LOG_NOT_FOUND');
    expect(await codeOf(retract(q.row.id, q.row.revSeq))).toBe('QUESTION_LOG_NOT_FOUND');
    expect(await codeOf(M.amendQuestion(null, { ref: q.row.id, input: { priority: 'HIGH' }, expectedRevision: q.row.revSeq, reason: 'r' }, as(holger.id)))).toBe('QUESTION_LOG_NOT_FOUND');
    expect(await codeOf(M.withdrawQuestion(null, { ref: q.row.id, reason: 'r', expectedRevision: q.row.revSeq }, as(writer.id)))).toBe('QUESTION_LOG_NOT_FOUND');
    const row = await rowOf(q.row.id);
    expect(await D.viewerMayAnswer({ row, shown: await dataOf(q.row.id), evaluation: { state: 'OPEN', question: await dataOf(q.row.id) } }, {}, as(holger.id))).toBe(false);
  });
});


/**
 * Hold a row-level lock in a transaction on its own connection. `ready` resolves with that backend's pid once the lock is
 * held, and REJECTS if the transaction fails first; `finish()` releases it and resolves only if the transaction committed.
 */
type HeldTx = Pick<typeof db, '$queryRaw' | 'node'>;
function holdTx(work: (tx: HeldTx) => Promise<void>) {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let ready!: (pid: number) => void;
  let fail!: (e: unknown) => void;
  const readyP = new Promise<number>((res, rej) => { ready = res; fail = rej; });
  const done = db.$transaction(async (tx) => {
    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
    await work(tx);
    ready(pid);
    await held;
  }, { timeout: 30_000 });
  done.catch((e) => fail(e));
  return { ready: readyP, finish: async () => { release(); await done; } };
}

/** Wait (bounded) until some backend is blocked BY `holderPid`, i.e. the answer is truly waiting on the fixture's lock. */
async function waitBlockedBy(holderPid: number, isSettled: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !isSettled()) {
    const rows = await db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
    if ((rows[0]?.n ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe('#4427 acceptance 14: the log FOR SHARE fence, with two real connections', () => {
  it('an answer waits behind a concurrent change of the log deciders, then sees the new list and refuses', async () => {
    const log = await createLog();
    const q = await ask(log.row.id);
    // Connection 1: holds the log FOR NO KEY UPDATE (what setQuestionLogDeciders takes) and removes the decider.
    const changer = holdTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${log.row.id} FOR NO KEY UPDATE`;
      const row = await tx.node.findUniqueOrThrow({ where: { id: log.row.id } });
      const data = { ...(row.data as Record<string, unknown>), defaultDeciders: [admin.id], eligibleDeciders: [] };
      await tx.node.update({ where: { id: log.row.id }, data: { data: data as never } });
    });
    const holderPid = await changer.ready;
    // Connection 2: the answer. It must block on the log row, behind the changer's backend, not read the old list.
    let settled = false;
    const attempt = codeOf(answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq)).then((c) => { settled = true; return c; });
    let blocked = false;
    try {
      blocked = await waitBlockedBy(holderPid, () => settled);
    } finally {
      await changer.finish();
    }
    expect(blocked).toBe(true);
    expect(await attempt).toBe('QUESTION_NOT_DECIDER');
    expect((await dataOf(q.row.id)).answers).toHaveLength(0);
  });
});

describe('#4532 blind delta: a SIGNED-tier question, and the on-log arm after a merge', () => {
  it('a SIGNED-tier question that was answered and approved is answered again, as a new revision', async () => {
    const q = await ask((await createLog()).row.id, { title: 'Sign off?', yesno: true, recommendation: { key: 'yes', reason: 'ready' }, tier: 'SIGNED' });
    await answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq);
    const r = await rowOf(q.row.id);
    await approveAsHolger(q.row.id);
    await answer(q.row.id, { optionKey: 'no', reason: 'second thoughts' }, r.revSeq);
    expect((await rowOf(q.row.id)).revSeq).toBeGreaterThan(r.revSeq);
    expect((await dataOf(q.row.id)).answers.map((a) => a.key)).toEqual(['yes', 'no']);
  });

  // Both arms are merge-aware by design (callerIdentities for the named check, survivors for the log), so this pins the log
  // arm working; the controls that each arm is REQUIRED are 'a log decider the asker did not name on this question cannot
  // answer it' and 'a stored decider the log no longer names is refused', in the gate describe above.
  it('after a merge the survivor answers when the LOG names the survivor and the question still names the merged account', async () => {
    const log = await createLog();
    const q = await ask(log.row.id);
    const survivor = await db.user.create({ data: { githubId: 442798, githubUsername: 'qa-survivor2', handle: 'qa-survivor2', roles: [] } });
    await db.orgMember.create({ data: { organizationId: orgId, userId: survivor.id, role: 'CONTRIBUTOR' } });
    await M.mergeUsers(null, { input: { source: holger.id, target: survivor.id, consentProof: await approvedMergeProof(db, holger.id, survivor.id, platformAdmin.id) } }, as(platformAdmin.id, { roles: ['ADMIN'] }));
    await M.setQuestionLogDeciders(null, { logRef: log.row.id, defaultDeciders: [survivor.id], expectedRevision: (await rowOf(log.row.id)).revSeq, reason: 'merged' }, as());
    await answer(q.row.id, { optionKey: 'yes' }, (await rowOf(q.row.id)).revSeq, as(survivor.id));
    expect((await dataOf(q.row.id)).deciders).toEqual([holger.id]);
    expect((await dataOf(q.row.id)).answers).toHaveLength(1);
  });
});

describe('#4532 review pins: the via pointer, and each blocked-state guard alone', () => {
  it('an invalid via is QUESTION_INVALID at /input/via on the answer door and /via on the take-back door', async () => {
    const q = await ask((await createLog()).row.id);
    const e1 = await errorOf(answer(q.row.id, { optionKey: 'yes', via: 'FAX' }, q.row.revSeq));
    expect(JSON.stringify(e1.extensions)).toContain('/input/via');
    await answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq);
    const e2 = await errorOf(retract(q.row.id, (await rowOf(q.row.id)).revSeq, { via: 'FAX' }));
    expect(JSON.stringify(e2.extensions)).toContain('"/via"');
  });

  it('a withdrawn question is QUESTION_WITHDRAWN and an unverifiable one QUESTION_INVALID, each on its own', async () => {
    const log = await createLog();
    const q = await ask(log.row.id);
    await M.withdrawQuestion(null, { ref: q.row.id, reason: 'moot', expectedRevision: q.row.revSeq }, as(writer.id));
    expect(await codeOf(answer(q.row.id, { optionKey: 'yes' }, (await rowOf(q.row.id)).revSeq))).toBe('QUESTION_WITHDRAWN');
    const q2 = await ask(log.row.id);
    await db.node.update({ where: { id: q2.row.id }, data: { data: { ...(q2.row.data as object), codec: 'question@0' } as never } });
    expect(await codeOf(answer(q2.row.id, { optionKey: 'yes' }, (await rowOf(q2.row.id)).revSeq))).toBe('QUESTION_INVALID');
  });
});

describe('#4532 blind round 4: the capability at the entry limit, a corrupt log, and a log at another loc', () => {
  const viewFor = async (id: string, ctx: Context) => D.viewerMayAnswer({ row: await rowOf(id), shown: await dataOf(id), evaluation: { state: 'OPEN', question: await dataOf(id) } }, {}, ctx);

  it('viewerMayAnswer is false for an eligible decider once only the take-back slot is left, and true one slot earlier', async () => {
    const q = await ask((await createLog()).row.id);
    const answers = (n: number) => Array.from({ length: n }, (_, i) => ({ key: i % 2 ? 'yes' : 'no', at: '2026-01-01T00:00:00.000Z', by: { userId: holger.id, workerId: null, appId: null } }));
    const withAnswers = async (n: number) => {
      const data = await dataOf(q.row.id);
      return D.viewerMayAnswer({ row: await rowOf(q.row.id), shown: { ...data, answers: answers(n) }, evaluation: { state: 'OPEN', question: { ...data, answers: answers(n) } } }, {}, as(holger.id));
    };
    expect(await withAnswers(MAX_ANSWERS - 2)).toBe(true);
    expect(await withAnswers(MAX_ANSWERS - 1)).toBe(false);
  });

  it('a corrupt log payload reads as false, not as an error in the non-null field', async () => {
    const log = await createLog();
    const q = await ask(log.row.id);
    expect(await viewFor(q.row.id, as(holger.id))).toBe(true);
    await db.node.update({ where: { id: log.row.id }, data: { data: { not: 'a log' } as never } });
    expect(await viewFor(q.row.id, as(holger.id))).toBe(false);
  });

  it('a log moved while the answer waits on its lock is refused as a missing log, not authorized against the old row', async () => {
    const log = await createLog();
    const q = await ask(log.row.id);
    // The mover holds the log lock and changes its loc; the answer already found the parent at the OLD loc.
    const mover = holdTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${log.row.id} FOR NO KEY UPDATE`;
      await tx.node.update({ where: { id: log.row.id }, data: { loc: `${log.row.loc}-moved` } });
    });
    const holderPid = await mover.ready;
    let settled = false;
    const attempt = codeOf(answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq)).then((c) => { settled = true; return c; });
    let blocked = false;
    try {
      blocked = await waitBlockedBy(holderPid, () => settled);
    } finally {
      await mover.finish();
    }
    expect(blocked).toBe(true);
    expect(await attempt).toBe('QUESTION_LOG_NOT_FOUND');
    expect((await dataOf(q.row.id)).answers).toHaveLength(0);
  });

  it('a question moved under another log while the answer waits is refused, not judged by the old log', async () => {
    const logA = await createLog();
    const q = await ask(logA.row.id);
    const row = await rowOf(q.row.id);
    // Hold the QUESTION row and move it to another parent loc; the answer's log lookup and lock already passed for log A.
    const mover = holdTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${q.row.id} FOR UPDATE`;
      await tx.node.update({ where: { id: q.row.id }, data: { loc: `${row.loc.slice(0, row.loc.lastIndexOf(':'))}-elsewhere:${row.loc.slice(row.loc.lastIndexOf(':') + 1)}` } });
    });
    const holderPid = await mover.ready;
    let settled = false;
    const attempt = codeOf(answer(q.row.id, { optionKey: 'yes' }, q.row.revSeq)).then((c) => { settled = true; return c; });
    let blocked = false;
    try {
      blocked = await waitBlockedBy(holderPid, () => settled);
    } finally {
      await mover.finish();
    }
    expect(blocked).toBe(true);
    expect(['QUESTION_LOG_NOT_FOUND', 'NODE_WRITE_CONFLICT']).toContain(await attempt);
    expect((await dataOf(q.row.id)).answers).toHaveLength(0);
  });

  it('the last history slot is kept for the take-back: an answer cannot fill the history, and the standing answer can be retracted', async () => {
    const q = await ask((await createLog()).row.id);
    const entry: AnswerEntry = { kind: 'answer', key: 'yes', text: null, reason: null, by: holger.id, at: '2026-11-01T00:00:00.000Z', via: 'api' };
    await seedEntries(q.row.id, Array.from({ length: MAX_ANSWERS - 2 }, (_, i) => ({ ...entry, key: i % 2 ? 'no' : 'yes' })));
    let r = (await rowOf(q.row.id)).revSeq;
    await answer(q.row.id, { optionKey: 'no', reason: 'fills up to the reserved slot' }, r);
    expect((await dataOf(q.row.id)).answers).toHaveLength(MAX_ANSWERS - 1);
    r = (await rowOf(q.row.id)).revSeq;
    const refused = await errorOf(answer(q.row.id, { optionKey: 'yes', reason: 'would fill the history' }, r));
    expect(refused.extensions.code).toBe('QUESTION_INVALID');
    expect((refused.extensions.pointers as Array<{ pointer: string }>)[0].pointer).toBe('/input');
    await retract(q.row.id, r);
    const after = await dataOf(q.row.id);
    expect(after.answers).toHaveLength(MAX_ANSWERS);
    expect(after.answers[after.answers.length - 1].kind).toBe('retraction');
  });
});
