/**
 * #4428 (Questions S4, #1641): the read side. An App's questions across its memories and logs, the
 * effective assignee, the filters and sorts, the asker's pull, and the log finder. Every filter is
 * applied to the evaluated view; `Node.properties` never decides an answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbWorkerAttribution } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { approvedMergeProof } from '../../../test/mergeConsent.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { questionDataSchema, type AnswerEntry, type QuestionData } from '../../../lib/questions/codec.js';
import { questionName, renderQuestion, renderQuestionAbstract } from '../../../lib/questions/render.js';
import * as questionsModule from './resolvers.questions.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let writer: { id: string };
let holger: { id: string };
let reader: { id: string };
let outsider: { id: string };
let kay: { id: string };
let platformAdmin: { id: string };
let orgId: string;
let org2Id: string;
let app: { id: string; urn: string };
let memA: { id: string };
let memB: { id: string };
let logA: { row: { id: string } };
let logB: { row: { id: string } };

const as = (userId = admin.id, extra: Partial<Context> = {}): Context => ({ db, userId, roles: [], ...extra });
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const D = (resolvers as unknown as { Question: Record<string, (v: any, a: unknown, ctx: Context) => any> }).Question;
const L = (resolvers as unknown as { QuestionLog: Record<string, (v: any, a: unknown, ctx: Context) => any> }).QuestionLog;

const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message;
  }
};

const simple = (extra: Record<string, unknown> = {}) => ({
  title: 'Ship the codec?', yesno: true, recommendation: { key: 'yes', reason: 'ready' }, ...extra,
});
const ask = (logRef: string, input: Record<string, unknown> = simple(), userId = writer.id, extra: Partial<Context> = {}) =>
  M.askQuestion(null, { logRef, input }, as(userId, extra));
const asWorker = <T>(workerId: string, fn: () => Promise<T>) => runAsActor({ workerId, agentId: null }, fn);
const ids = (page: { items: Array<{ row: { id: string } }> }) => page.items.map((v) => v.row.id);
const idSet = (page: { items: Array<{ row: { id: string } }> }) => ids(page).sort();
const rowOf = (id: string) => db.node.findUniqueOrThrow({ where: { id } });

/** Append an answer-list entry consistently, standing in for the answer door (the S3 door is a later slice's). */
async function writeAnswerForTest(id: string, entry: Partial<AnswerEntry> & Pick<AnswerEntry, 'by'>): Promise<void> {
  const row = await rowOf(id);
  const d = questionDataSchema.parse(row.data);
  const full: AnswerEntry = { kind: 'answer', key: null, text: null, reason: null, at: '2026-10-06T21:00:00.000Z', via: 'portal', ...entry };
  const answers = [...d.answers, full];
  const next: QuestionData = { ...d, answers, status: full.kind === 'answer' ? 'answered' : 'open' };
  await db.node.update({
    where: { id },
    data: {
      name: questionName(next), abstract: renderQuestionAbstract(next), content: renderQuestion(next),
      data: next as never, revisionContentHash: 'refresh',
    },
  });
}
const answerAt = (id: string, by: string, at: string) => writeAnswerForTest(id, { kind: 'answer', key: 'yes', by, at });
const retractAt = (id: string, by: string, at: string) => writeAnswerForTest(id, { kind: 'retraction', by, at });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'List Org', urn: 'list.example' } });
  const org2 = await db.organization.create({ data: { id: generateId(), name: 'Other Org', urn: 'other-list.example' } });
  orgId = org.id;
  org2Id = org2.id;
  admin = await db.user.create({ data: { githubId: 442801, githubUsername: 'ql-admin', handle: 'ql-admin', roles: [] } });
  writer = await db.user.create({ data: { githubId: 442802, githubUsername: 'ql-writer', handle: 'ql-writer', roles: [] } });
  holger = await db.user.create({ data: { githubId: 442803, githubUsername: 'ql-holger', handle: 'ql-holger', roles: [] } });
  reader = await db.user.create({ data: { githubId: 442804, githubUsername: 'ql-reader', roles: [] } });
  outsider = await db.user.create({ data: { githubId: 442805, githubUsername: 'ql-outsider', roles: [] } });
  platformAdmin = await db.user.create({ data: { githubId: 442807, githubUsername: 'ql-platform', roles: ['ADMIN'] } });
  kay = await db.user.create({ data: { githubId: 442806, githubUsername: 'ql-kay', handle: 'ql-kay', roles: [] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: writer.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: holger.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: reader.id, role: 'READER' },
    { organizationId: org.id, userId: kay.id, role: 'CONTRIBUTOR' },
    { organizationId: org2.id, userId: admin.id, role: 'ADMIN' },
  ] });
  // One App, two memories: A in this org (its members read it), B in another org (only its members read it).
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: 'list.example:team' } });
  memA = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'team-a' }, as());
  memB = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'team-b' }, as());
  logA = await M.createQuestionLog(null, { memoryRef: memA.id, loc: 'questions', defaultDeciders: [holger.id, admin.id] }, as());
  logB = await M.createQuestionLog(null, { memoryRef: memB.id, loc: 'questions', defaultDeciders: [admin.id] }, as());
  // Attach the memories to the App after the logs exist, so decider eligibility is judged on the plain org memories.
  // A is the App's team space (every member reads it); B is an app-class memory owned by one user (strict ownership: only admin reads it).
  await db.memory.update({ where: { id: memA.id }, data: { appId: app.id, class: 'app', visibility: null } });
  await db.memory.update({ where: { id: memB.id }, data: { appId: app.id, class: 'app', visibility: null, organizationId: null, ownerUserId: admin.id } });
  await db.appMember.createMany({ data: [admin, writer, holger, kay, reader].map((u, i) => ({ appId: app.id, userId: u.id, role: i === 0 ? 'owner' : 'member' })) });
});

describe('#4428 acceptance 1: the effective assignee', () => {
  it('is the explicit assignee, else the asking worker\'s current holder (read at the time), else null', async () => {
    await createDbWorkerAttribution(db, writer.id, 'worker-ada');
    await db.worker.update({ where: { id: 'worker-ada' }, data: { heldByUserId: holger.id } });
    const explicit = await ask(logA.row.id, simple({ assignee: holger.id }));
    const byWorker = await asWorker('worker-ada', () => ask(logA.row.id));
    const plain = await ask(logA.row.id);
    const read = async (id: string) => Q.question(null, { ref: id }, as(reader.id));

    expect(D.effectiveAssigneeId(await read(explicit.row.id), {}, as())).toBe(holger.id);
    expect(D.effectiveAssigneeId(await read(byWorker.row.id), {}, as())).toBe(holger.id);
    expect(D.assigneeId(await read(byWorker.row.id), {}, as())).toBeNull();
    expect(D.effectiveAssigneeId(await read(plain.row.id), {}, as())).toBeNull();

    // (c) the holder changes: the same question now reads the new holder, with no write to the node.
    const before = await rowOf(byWorker.row.id);
    await db.worker.update({ where: { id: 'worker-ada' }, data: { heldByUserId: kay.id } });
    expect(D.effectiveAssigneeId(await read(byWorker.row.id), {}, as())).toBe(kay.id);
    const after = await rowOf(byWorker.row.id);
    expect({ rev: after.revSeq, data: after.data }).toEqual({ rev: before.revSeq, data: before.data });

    // (d) a worker with no holder: nobody.
    await db.worker.update({ where: { id: 'worker-ada' }, data: { heldByUserId: null, heldAt: null } });
    expect(D.effectiveAssigneeId(await read(byWorker.row.id), {}, as())).toBeNull();
  });

  it('shows the assignee by name and handle, and follows an account merge for the explicit assignee', async () => {
    const q = await ask(logA.row.id, simple({ assignee: holger.id }));
    const view = await Q.question(null, { ref: q.row.id }, as(reader.id));
    expect(await D.assignee(view, {}, as(reader.id))).toMatchObject({ id: holger.id });
    expect(await D.effectiveAssignee(view, {}, as(reader.id))).toMatchObject({ id: holger.id });
    // The explicit assignee's account is merged into kay's: the question now routes to the survivor, and the survivor's filter finds it.
    await M.mergeUsers(null, { input: { source: holger.id, target: kay.id, consentProof: await approvedMergeProof(db, holger.id, kay.id, platformAdmin.id) } },
      as(platformAdmin.id, { roles: ['ADMIN'] }));
    expect(D.effectiveAssigneeId(await Q.question(null, { ref: q.row.id }, as(reader.id)), {}, as())).toBe(kay.id);
    expect(ids(await Q.questions(null, { appRef: app.id, assigneeId: kay.id }, as(reader.id)))).toEqual([q.row.id]);
  });
});

describe('#4428 acceptances 2-4: assignee filters', () => {
  async function fixture() {
    await createDbWorkerAttribution(db, writer.id, 'worker-ada');
    await db.worker.update({ where: { id: 'worker-ada' }, data: { heldByUserId: holger.id } });
    const explicit = await ask(logA.row.id, simple({ assignee: holger.id }));
    const viaWorker = await asWorker('worker-ada', () => ask(logA.row.id));
    const nobody = await ask(logA.row.id);
    const other = await ask(logA.row.id, simple({ deciders: [holger.id, admin.id], assignee: admin.id }));
    return { explicit, viaWorker, nobody, other };
  }

  it('2: assigneeId filters on the EFFECTIVE value (a question with no stored assignee is found)', async () => {
    const f = await fixture();
    const page = await Q.questions(null, { appRef: app.id, assigneeId: holger.id }, as(reader.id));
    expect(idSet(page)).toEqual([f.explicit, f.viaWorker].map((v) => v.row.id).sort());
    expect(page.total).toBe(2);
  });

  it('3: unassigned returns the unrouted ones; with assigneeId, either match is kept; false alone is the routed ones', async () => {
    const f = await fixture();
    expect(idSet(await Q.questions(null, { appRef: app.id, unassigned: true }, as(reader.id)))).toEqual([f.nobody.row.id]);
    expect(idSet(await Q.questions(null, { appRef: app.id, assigneeId: holger.id, unassigned: true }, as(reader.id))))
      .toEqual([f.explicit, f.viaWorker, f.nobody].map((v) => v.row.id).sort());
    expect(idSet(await Q.questions(null, { appRef: app.id, unassigned: false }, as(reader.id))))
      .toEqual([f.explicit, f.viaWorker, f.other].map((v) => v.row.id).sort());
  });

  it("4: a member who can read the memory lists another member's questions; a stranger gets the empty page", async () => {
    const f = await fixture();
    const asAdminsView = await Q.questions(null, { appRef: app.id, assigneeId: admin.id }, as(reader.id));
    expect(idSet(asAdminsView)).toEqual([f.other.row.id]);
    const stranger = await Q.questions(null, { appRef: app.id, assigneeId: admin.id }, as(outsider.id));
    expect(stranger).toEqual({ items: [], total: 0 });
  });
});

describe('#4428 acceptance 5: the App scope', () => {
  it('lists both logs\' questions; a caller who reads one memory sees only that memory, and the total counts only those', async () => {
    const a = await ask(logA.row.id);
    const b = await M.askQuestion(null, { logRef: logB.row.id, input: simple() }, as(admin.id));
    const both = await Q.questions(null, { appRef: app.id }, as(admin.id));
    expect(idSet(both)).toEqual([a, b].map((v) => v.row.id).sort());
    const onlyA = await Q.questions(null, { appRef: app.id }, as(reader.id));
    expect(ids(onlyA)).toEqual([a.row.id]);
    expect(onlyA.total).toBe(1);
  });

  it('an unknown App is the empty page; both scopes or none is BAD_USER_INPUT', async () => {
    expect(await Q.questions(null, { appRef: generateId() }, as(reader.id))).toEqual({ items: [], total: 0 });
    expect(await Q.questions(null, { appRef: 'hrn:app:nowhere.example:none' }, as(reader.id))).toEqual({ items: [], total: 0 });
    expect(await codeOf(Q.questions(null, { appRef: app.id, logRef: logA.row.id }, as(reader.id)))).toBe('BAD_USER_INPUT');
    expect(await codeOf(Q.questions(null, {}, as(reader.id)))).toBe('BAD_USER_INPUT');
  });
});

describe('#4428 acceptance 6: answered', () => {
  it('true keeps answered states, false keeps OPEN, and a withdrawn question is in neither', async () => {
    const open = await ask(logA.row.id);
    const decided = await ask(logA.row.id, simple({ tier: 'ANSWERED' }));
    const unconfirmed = await ask(logA.row.id, simple({ tier: 'SIGNED' }));
    const retracted = await ask(logA.row.id, simple({ tier: 'ANSWERED' }));
    const withdrawn = await ask(logA.row.id);
    await answerAt(decided.row.id, holger.id, '2026-10-06T21:00:00.000Z');
    await answerAt(unconfirmed.row.id, holger.id, '2026-10-06T21:00:00.000Z');
    await answerAt(retracted.row.id, holger.id, '2026-10-06T21:00:00.000Z');
    await retractAt(retracted.row.id, holger.id, '2026-10-07T21:00:00.000Z');
    await M.withdrawQuestion(null, { ref: withdrawn.row.id, reason: 'moot', expectedRevision: 1 }, as(writer.id));
    // A question answered and THEN withdrawn keeps its answer entry but is WITHDRAWN: in neither list.
    const answeredThenWithdrawn = await ask(logA.row.id, simple({ tier: 'ANSWERED' }));
    await answerAt(answeredThenWithdrawn.row.id, holger.id, '2026-10-06T21:00:00.000Z');
    await M.withdrawQuestion(null, { ref: answeredThenWithdrawn.row.id, reason: 'moot', expectedRevision: 1 }, as(holger.id));

    const yes = await Q.questions(null, { appRef: app.id, answered: true }, as(reader.id));
    expect(idSet(yes)).toEqual([decided, unconfirmed].map((v) => v.row.id).sort());
    const no = await Q.questions(null, { appRef: app.id, answered: false }, as(reader.id));
    expect(idSet(no)).toEqual([open, retracted].map((v) => v.row.id).sort());
    // Applied to the evaluated state, not a hint: a forged `answered` property changes nothing.
    await db.$executeRaw`UPDATE nodes SET properties = jsonb_set(properties, '{answered}', 'true') WHERE id = ${open.row.id}`;
    expect(idSet(await Q.questions(null, { appRef: app.id, answered: false }, as(reader.id)))).toEqual(idSet(no));
  });
});

describe('#4428 acceptances 7-8: the asker pull', () => {
  it('7: askedByMe lists the session\'s own questions; answeredSince excludes earlier and retracted answers', async () => {
    await createDbWorkerAttribution(db, writer.id, 'worker-ada');
    const mine1 = await asWorker('worker-ada', () => ask(logA.row.id, simple({ tier: 'ANSWERED' })));
    const mine2 = await asWorker('worker-ada', () => ask(logA.row.id, simple({ tier: 'ANSWERED' })));
    const mine3 = await asWorker('worker-ada', () => ask(logA.row.id, simple({ tier: 'ANSWERED' })));
    // Asked by another person: the same user would also count as the asker (the existing rule).
    const notMine = await ask(logA.row.id, simple(), holger.id);
    await answerAt(mine1.row.id, holger.id, '2026-10-01T00:00:00.000Z');
    await answerAt(mine2.row.id, holger.id, '2026-10-10T00:00:00.000Z');
    await answerAt(mine3.row.id, holger.id, '2026-10-12T00:00:00.000Z');
    await retractAt(mine3.row.id, holger.id, '2026-10-13T00:00:00.000Z');

    const own = await asWorker('worker-ada', () => Q.questions(null, { appRef: app.id, askedByMe: true }, as(writer.id)));
    expect(idSet(own)).toEqual([mine1, mine2, mine3].map((v) => v.row.id).sort());
    expect(ids(own)).not.toContain(notMine.row.id);

    const since = await asWorker('worker-ada', () => Q.questions(null,
      { appRef: app.id, askedByMe: true, answeredSince: '2026-10-10T00:00:00.000Z' }, as(writer.id)));
    expect(ids(since)).toEqual([mine2.row.id]);
    const exactlyAt = await asWorker('worker-ada', () => Q.questions(null,
      { appRef: app.id, answeredSince: '2026-10-11T00:00:00.000Z' }, as(writer.id)));
    expect(exactlyAt.total).toBe(0);
  });

  it('7: a bare App key bound to the asking worker\'s session is not the asker (no person behind the request)', async () => {
    await createDbWorkerAttribution(db, writer.id, 'worker-ada');
    await asWorker('worker-ada', () => ask(logA.row.id));
    const key = { db, appId: app.id, roles: ['ADMIN'] } as Context;
    const page = await asWorker('worker-ada', () => Q.questions(null, { logRef: logA.row.id, askedByMe: true }, key));
    expect(page.total).toBe(0);
  });

  it('askedByWorkerId and askedByAppId filter on who asked', async () => {
    await createDbWorkerAttribution(db, writer.id, 'worker-ada');
    const w = await asWorker('worker-ada', () => ask(logA.row.id));
    await ask(logA.row.id);
    expect(ids(await Q.questions(null, { appRef: app.id, askedByWorkerId: 'worker-ada' }, as(reader.id)))).toEqual([w.row.id]);
    expect((await Q.questions(null, { appRef: app.id, askedByWorkerId: 'worker-nobody' }, as(reader.id))).total).toBe(0);
    expect((await Q.questions(null, { appRef: app.id, askedByAppId: generateId() }, as(reader.id))).total).toBe(0);
  });

  it('8: an hdr_app_ key principal asks in a memory of its App, reads the question, and finds it by askedByMe', async () => {
    await db.memory.update({ where: { id: memA.id }, data: { class: 'app' } });
    const key = { db, appId: app.id, appKeyId: generateId(), roles: ['ADMIN'] } as Context;
    const asked = await M.askQuestion(null, { logRef: logA.row.id, input: simple() }, key);
    const read = await Q.question(null, { ref: asked.row.id }, key);
    expect(read?.row.id).toBe(asked.row.id);
    const mine = await Q.questions(null, { appRef: app.id, askedByMe: true }, key);
    expect(ids(mine)).toEqual([asked.row.id]);
  });
});

describe('#4428 acceptance 9: sorts and paging', () => {
  it('PRIORITY_DESC, ASKED_AT_ASC/DESC and ANSWERED_AT_DESC, with stable pages', async () => {
    const low = await ask(logA.row.id, simple({ priority: 'LOW' }));
    const urgent = await ask(logA.row.id, simple({ priority: 'URGENT' }));
    const high1 = await ask(logA.row.id, simple({ priority: 'HIGH' }));
    const high2 = await ask(logA.row.id, simple({ priority: 'HIGH' }));
    const normal = await ask(logA.row.id, simple({ priority: 'NORMAL', tier: 'ANSWERED' }));
    const unanswered = [low, urgent, high1, high2];
    await answerAt(normal.row.id, holger.id, '2026-10-20T00:00:00.000Z');
    const withAsked = async (sort: string, extra: Record<string, unknown> = {}) =>
      ids(await Q.questions(null, { appRef: app.id, sort, ...extra }, as(reader.id)));
    // Newest ask first inside a priority: high2 was asked after high1.
    expect(await withAsked('PRIORITY_DESC')).toEqual([urgent, high2, high1, normal, low].map((v) => v.row.id));
    // Asked-at order follows the stored askedAt; equal instants fall to n.
    const desc = await withAsked('ASKED_AT_DESC');
    const asc = await withAsked('ASKED_AT_ASC');
    expect(desc.slice().reverse()).toEqual(asc);
    expect(new Set(desc)).toEqual(new Set([...unanswered, normal].map((v) => v.row.id)));
    const answeredOrder = await withAsked('ANSWERED_AT_DESC');
    expect(answeredOrder[0]).toBe(normal.row.id);
    expect(answeredOrder.slice(1).sort()).toEqual(unanswered.map((v) => v.row.id).sort());
    // Two pages of two plus one cover every question exactly once.
    const p1 = await withAsked('PRIORITY_DESC', { limit: 2, offset: 0 });
    const p2 = await withAsked('PRIORITY_DESC', { limit: 2, offset: 2 });
    const p3 = await withAsked('PRIORITY_DESC', { limit: 2, offset: 4 });
    expect([...p1, ...p2, ...p3]).toEqual(await withAsked('PRIORITY_DESC'));
  });
});

describe('#4428 acceptance 10: the evaluation cap', () => {
  it('an appRef list and a logRef list over the cap refuse QUESTION_LOG_TOO_LARGE_FOR_FILTER', async () => {
    await ask(logA.row.id);
    await ask(logA.row.id);
    await ask(logA.row.id);
    const spy = vi.spyOn(questionsModule.questionListBounds, 'cap').mockReturnValue(2);
    try {
      expect(await codeOf(Q.questions(null, { appRef: app.id }, as(reader.id)))).toBe('QUESTION_LOG_TOO_LARGE_FOR_FILTER');
      expect(await codeOf(Q.questions(null, { logRef: logA.row.id }, as(reader.id)))).toBe('QUESTION_LOG_TOO_LARGE_FOR_FILTER');
    } finally {
      spy.mockRestore();
    }
    expect((await Q.questions(null, { appRef: app.id }, as(reader.id))).total).toBe(3);
  });
});

describe('#4428 acceptance 11: questionLogs', () => {
  it('lists the readable logs of an App with their memory; one memory; unreadable and unknown are []', async () => {
    const all = await Q.questionLogs(null, { appRef: app.id }, as(admin.id));
    expect(all.map((v: any) => v.row.id).sort()).toEqual([logA.row.id, logB.row.id].sort());
    expect(all.map((v: any) => L.memoryId(v, {}, as())).sort()).toEqual([memA.id, memB.id].sort());
    const mine = await Q.questionLogs(null, { appRef: app.id }, as(reader.id));
    expect(mine.map((v: any) => v.row.id)).toEqual([logA.row.id]);
    expect(await Q.questionLogs(null, { appRef: generateId() }, as(reader.id))).toEqual([]);
    expect((await Q.questionLogs(null, { memoryRef: memA.id }, as(reader.id))).map((v: any) => v.row.id)).toEqual([logA.row.id]);
    expect(await Q.questionLogs(null, { memoryRef: memB.id }, as(reader.id))).toEqual([]);
    expect(await Q.questionLogs(null, { memoryRef: memA.id }, as(outsider.id))).toEqual([]);
    expect(await codeOf(Q.questionLogs(null, { appRef: app.id, memoryRef: memA.id }, as(reader.id)))).toBe('BAD_USER_INPUT');
    expect(await codeOf(Q.questionLogs(null, {}, as(reader.id)))).toBe('BAD_USER_INPUT');
    void orgId; void org2Id;
  });
});
