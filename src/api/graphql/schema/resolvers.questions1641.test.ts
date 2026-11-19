import { observeTransactionBackend, waitForAdvisoryWaiter } from '../../../test/advisoryWaiter.js';
import { approvedMergeProof } from '../../../test/mergeConsent.js';
/**
 * #1641 S1 — question nodes: the log and question doors, the reads, and the
 * §3.2 gap closures on every generic path. Plan of record:
 * hrn:node:hadronmemory.com:hadron-server:design:decision-nodes (r4).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbWorkerAttribution } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { questionDataSchema, questionLogDataSchema, type AnswerEntry, type QuestionData } from '../../../lib/questions/codec.js';
import { canonicalQuestionJson, questionName, renderQuestion, renderQuestionAbstract, renderQuestionLog } from '../../../lib/questions/render.js';
import { computeApprovalHash } from '../../../lib/approvalHash.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let writer: { id: string };
let holger: { id: string };
let reader: { id: string };
let outsider: { id: string };
let platformAdmin: { id: string };
let orgId: string;
let memory: { id: string; urn: string };

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
const errorOf = async (p: Promise<unknown>): Promise<GraphQLError> => {
  try { await p; } catch (e) { return e as GraphQLError; }
  throw new Error('expected a refusal');
};

const createLog = (extra: Record<string, unknown> = {}, userId = admin.id, context: Partial<Context> = {}) =>
  M.createQuestionLog(null, { memoryRef: memory.id, loc: 'questions', defaultDeciders: [holger.id], ...extra }, as(userId, context));

const simple = (extra: Record<string, unknown> = {}) => ({
  title: 'Ship the codec?',
  yesno: true,
  recommendation: { key: 'yes', reason: 'ready' },
  ...extra,
});
const ask = (logRef: string, input: Record<string, unknown> = simple(), userId = writer.id, extra: Partial<Context> = {}) =>
  M.askQuestion(null, { logRef, input }, as(userId, extra));

/** The question's stored row. */
const rowOf = (id: string) => db.node.findUniqueOrThrow({ where: { id } });

/**
 * Append an answer-list entry CONSISTENTLY (data, rendered content, name and
 * abstract together, with a fingerprint refresh), standing in for the answer
 * door until S3 ships it (S3 deletes this helper). A real door write, minus
 * the door.
 */
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
/** Answer the question with option `key` as `by`. */
const answerAsS2 = (id: string, key: string, by: string) => writeAnswerForTest(id, { kind: 'answer', key, by });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Question Org', urn: 'decision.example' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 164101, githubUsername: 'dn-admin', handle: 'dn-admin', roles: [] } });
  writer = await db.user.create({ data: { githubId: 164102, githubUsername: 'dn-writer', handle: 'dn-writer', roles: [] } });
  holger = await db.user.create({ data: { githubId: 164103, githubUsername: 'dn-holger', handle: 'dn-holger', roles: [] } });
  reader = await db.user.create({ data: { githubId: 164104, githubUsername: 'dn-reader', roles: [] } });
  outsider = await db.user.create({ data: { githubId: 164105, githubUsername: 'dn-outsider', roles: [] } });
  platformAdmin = await db.user.create({ data: { githubId: 164106, githubUsername: 'dn-platform', roles: ['ADMIN'] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: writer.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: holger.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: reader.id, role: 'READER' },
  ] });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'team-shared' }, as());
});

describe('#1728 Channel roots cannot squat question-code space', () => {
  it.each([0, 1])('refuses the next code after %i questions without consuming it', async (issued) => {
    const log = await createLog();
    for (let i = 0; i < issued; i++) await ask(log.row.id);
    const code = issued === 0 ? 'QA' : 'QB';
    const loc = `questions:${code}`;
    const beforeChannels = await db.channel.count({ where: { memoryId: memory.id } });
    expect(await codeOf(M.createChannel(null, {
      input: { memoryRef: memory.id, loc, name: 'Squatter' },
    }, as(writer.id)))).toBe('QUESTION_CONTAINED');
    expect(await db.channel.count({ where: { memoryId: memory.id } })).toBe(beforeChannels);
    expect(await db.node.count({ where: { memoryId: memory.id, loc: { in: [loc, `${loc}:messages`] } } })).toBe(0);
    const question = await ask(log.row.id);
    expect(D.code(question, {}, as())).toBe(code);
  });

  it('still permits a Channel outside the question log', async () => {
    await createLog();
    const channel = await M.createChannel(null, {
      input: { memoryRef: memory.id, loc: 'discussion', name: 'Discussion' },
    }, as(writer.id));
    expect(channel).toBeTruthy();
    expect(await db.channel.count({ where: { memoryId: memory.id } })).toBe(1);
  });
});

describe('createQuestionLog (§3.3, §6.1)', () => {
  it('memory MANAGE creates a governed question.log; writers and outsiders cannot', async () => {
    expect(await codeOf(createLog({}, writer.id))).toBe('QUESTION_FORBIDDEN');
    expect(await codeOf(createLog({}, outsider.id))).toMatch(/^MEMORY_NOT_FOUND/);
    const log = await createLog({ name: 'Team questions' });
    expect(L.prefix(log, {}, as())).toBe('Q');
    expect(L.lastCode(log, {}, as())).toBe(0);
    expect(L.defaultDeciderIds(log, {}, as())).toEqual([holger.id]);
    const row = await rowOf(log.row.id);
    expect(row).toMatchObject({ role: 'question.log', loc: 'questions', name: 'Team questions' });
    expect(row.content).toContain('A question log.');
    expect(row.data).toMatchObject({ codec: 'hadron.dev/question-log/v1', kind: 'question.log' });
  });

  it('refuses an encrypted memory, a git-mirrored one, an occupied loc, a nested log, and an ineligible decider', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true, vectorIndexEnabled: false } });
    expect(await codeOf(createLog())).toBe('QUESTION_LOG_ENCRYPTED');
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: false, source: 'https://github.com/x/y' } });
    expect(await codeOf(createLog())).toBe('QUESTION_LOG_MIRRORED');
    await db.memory.update({ where: { id: memory.id }, data: { source: null } });
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'questions:old', name: 'Old' } });
    expect(await codeOf(createLog())).toBe('QUESTION_LOG_EXISTS');
    const log = await createLog({ loc: 'team' });
    const d = await ask(log.row.id);
    expect(await codeOf(createLog({ loc: `team:${D.code(d, {}, as())}:sub` }))).toBe('QUESTION_CONTAINED');
    expect(await codeOf(createLog({ loc: 'other', defaultDeciders: [outsider.id] }))).toBe('QUESTION_DECIDER_NOT_ELIGIBLE');
  });
});

describe("the log gate admits whoever manages the App (Holger's ruling, team chat #7790)", () => {
  const asPlatform = () => as(platformAdmin.id, { roles: ['ADMIN'] });
  const logCount = () => db.node.count({ where: { memoryId: memory.id, role: 'question.log' } });

  /** Make the memory a fresh App's own (an app-class memory its participants read), with `reader` (an org READER) as an AppMember at `role`. */
  async function appWithReaderAs(role: string): Promise<{ id: string }> {
    const app = await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'Team', urn: 'decision.example:team' } });
    await db.memory.update({ where: { id: memory.id }, data: { appId: app.id, class: 'app', visibility: null } });
    await db.appMember.create({ data: { appId: app.id, userId: reader.id, role } });
    return app;
  }

  it('a platform admin who belongs to no org creates a log and replaces its deciders', async () => {
    const log = await M.createQuestionLog(null, { memoryRef: memory.id, loc: 'questions', defaultDeciders: [holger.id] }, asPlatform());
    const next = await M.setQuestionLogDeciders(null,
      { logRef: log.row.id, defaultDeciders: [admin.id], expectedRevision: 1, reason: 'platform' }, asPlatform());
    expect(L.defaultDeciderIds(next, {}, as())).toEqual([admin.id]);
  });

  it("an owner-role member of the memory's App creates a log and replaces its deciders", async () => {
    expect(await codeOf(createLog({}, reader.id))).toBe('QUESTION_FORBIDDEN');
    await appWithReaderAs('owner');
    // An app-class memory is read through the App, so the App's owner is the decider here.
    const log = await createLog({ defaultDeciders: [reader.id] }, reader.id);
    await M.setQuestionLogDeciders(null,
      { logRef: log.row.id, defaultDeciders: [reader.id], expectedRevision: 1, reason: 'app owner' }, as(reader.id));
    expect((await rowOf(log.row.id)).revSeq).toBe(2);
  });

  it("any other App role is refused, an uninstalled or deleted App's memory is concealed, and nothing is written", async () => {
    const app = await appWithReaderAs('member');
    expect(await codeOf(createLog({ defaultDeciders: [reader.id] }, reader.id))).toBe('QUESTION_FORBIDDEN');
    await db.appMember.update({ where: { appId_userId: { appId: app.id, userId: reader.id } }, data: { role: 'owner' } });
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    // Refused by the arm and concealed; without its uninstalled filter the call reaches the decider check.
    expect(await codeOf(createLog({ defaultDeciders: [reader.id] }, reader.id))).toMatch(/^MEMORY_NOT_FOUND/);
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: null, deletedAt: new Date() } });
    // A deleted App's memory is no longer readable through it, so it is concealed.
    expect(await codeOf(createLog({ defaultDeciders: [reader.id] }, reader.id))).toMatch(/^MEMORY_NOT_FOUND/);
    expect(await logCount()).toBe(0);
  });

  it("the owner role in another App does not reach this memory's log", async () => {
    await appWithReaderAs('member');
    const log = await createLog({ defaultDeciders: [reader.id] });
    const other = await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'Other', urn: 'decision.example:other' } });
    await db.appMember.create({ data: { appId: other.id, userId: reader.id, role: 'owner' } });
    const before = await rowOf(log.row.id);
    expect(await codeOf(M.setQuestionLogDeciders(null,
      { logRef: log.row.id, defaultDeciders: [reader.id], expectedRevision: 1, reason: 'r' }, as(reader.id))))
      .toBe('QUESTION_FORBIDDEN');
    const after = await rowOf(log.row.id);
    expect({ revSeq: after.revSeq, data: after.data }).toEqual({ revSeq: before.revSeq, data: before.data });
  });
});

describe('the App owner arm under concurrent revocation (#1690 review: Rook P3-1, Chip R7)', () => {
  it("a demotion can't commit between the in-transaction gate and the log write: it waits for the write", async () => {
    const app = await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'Team', urn: 'decision.example:team' } });
    await db.memory.update({ where: { id: memory.id }, data: { appId: app.id, class: 'app', visibility: null } });
    await db.appMember.create({ data: { appId: app.id, userId: reader.id, role: 'owner' } });

    // Hold the log's path lock, so the create passes its gate and then waits.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memory.id}), hashtext(${'questions'}))`;
      locked();
      await held;
    }, { timeout: 30_000 });
    await isLocked;

    const observed = observeTransactionBackend(db);
    const create = createLog({ defaultDeciders: [reader.id] }, reader.id, { db: observed.db });
    void create.catch(() => {});
    let demoted = false;
    let demotion: Promise<void> = Promise.resolve();
    let demotedWhileHeld = false;
    try {
      const pid = await observed.backendFor(create);
      await waitForAdvisoryWaiter(db, { pid, key: { form: 'int-pair', first: memory.id, second: 'questions' } });
      demotion = db.appMember.update({
        where: { appId_userId: { appId: app.id, userId: reader.id } }, data: { role: 'member' },
      }).then(() => { demoted = true; });
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      // Record before releasing: the caller's membership row is held, so the demotion is still waiting.
      demotedWhileHeld = demoted;
      release();
      await holder;
      await Promise.allSettled([create, demotion]);
    }
    expect(demotedWhileHeld).toBe(false);
    const log = await create;
    await demotion;
    // The write was authorized by the role it held throughout; the demotion is ordered after it.
    expect((await rowOf(log.row.id)).role).toBe('question.log');
    expect(await codeOf(M.setQuestionLogDeciders(null,
      { logRef: log.row.id, defaultDeciders: [reader.id], expectedRevision: 1, reason: 'after demotion' }, as(reader.id))))
      .toBe('QUESTION_FORBIDDEN');
  });

  it("the owner role in the App doesn't reach another user's App-scoped personal memory, even one shared with them", async () => {
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'agent', urn: 'decision.example:agent', visibility: 'ORGANIZATION' } });
    const app = await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'Team', urn: 'decision.example:team' } });
    await db.appMember.create({ data: { appId: app.id, userId: reader.id, role: 'owner' } });
    const personal = await db.memory.create({ data: {
      id: generateId(), name: 'holger-personal', urn: 'decision.example:holger-personal', class: 'personal',
      userId: holger.id, organizationId: orgId, appId: app.id, userMemoryOfAgentId: agent.id,
    } });
    await db.memoryShare.create({ data: { memoryId: personal.id, granteeId: reader.id, grantorId: holger.id, role: 'writer' } });
    // Refused by the class guard and concealed; without the guard this create would succeed.
    expect(await codeOf(M.createQuestionLog(null,
      { memoryRef: personal.id, loc: 'questions', defaultDeciders: [holger.id] }, as(reader.id))))
      .toMatch(/^MEMORY_NOT_FOUND/);
    expect(await db.node.count({ where: { memoryId: personal.id, role: 'question.log' } })).toBe(0);
  });
});

describe('askQuestion (§4, §5, §7; #4426)', () => {
  it('a writer asks; the server issues QA, renders the content, and the state is OPEN and verifiable', async () => {
    const log = await createLog();
    await createDbWorkerAttribution(db, writer.id, 'worker-ada');
    const d = await runAsActor({ workerId: 'worker-ada', agentId: null }, () => ask(log.row.id, simple({
      priority: 'URGENT', background: 'Background.', blocks: [{ ref: 'hadron-server#1641' }],
    })));
    expect(D.code(d, {}, as())).toBe('QA');
    expect(D.state(d, {}, as())).toBe('OPEN');
    expect(D.priority(d, {}, as())).toBe('URGENT');
    expect(D.tier(d, {}, as())).toBe('ANSWERED');
    expect(D.answered(d, {}, as())).toBe(false);
    expect(D.deciderIds(d, {}, as())).toEqual([holger.id]);
    const askedBy = await D.askedBy(d, {}, as());
    expect(askedBy).toMatchObject({ userId: writer.id, workerId: 'worker-ada' });
    expect(D.options(d, {}, as())).toMatchObject([{ key: 'yes' }, { key: 'no' }]);
    expect(await D.recommendation(d, {}, as())).toMatchObject({ key: 'yes', reason: 'ready', by: { userId: writer.id, workerId: 'worker-ada' } });
    const row = await rowOf(d.row.id);
    expect(row).toMatchObject({ loc: 'questions:QA', role: 'question', seq: 1, name: 'QA: Ship the codec?', revSeq: 1 });
    expect(row.content).toContain('```hadron-question');
    // The stored payload is one question: no parts key (acceptance 1).
    expect(Object.keys(row.data as object)).not.toContain('parts');
    expect(row.data).toMatchObject({ codec: 'hadron.dev/question/v1', kind: 'question', answers: [], taskId: null, assignee: null });
    expect((await rowOf(log.row.id)).data).toMatchObject({ lastCode: 1 });
    expect(await Q.verifyQuestion(null, { ref: d.row.id }, as(reader.id))).toMatchObject({ state: 'OPEN', findings: [] });
    expect((await ask(log.row.id)).row.loc).toBe('questions:QB');
  });

  it('acceptance 1: an input key "parts" is refused QUESTION_INVALID', async () => {
    const log = await createLog();
    const e = await errorOf(ask(log.row.id, { title: 't', parts: [{ question: 'q' }] }));
    expect(e.extensions.code).toBe('QUESTION_INVALID');
  });

  it('acceptance 2: a full ask renders the sections, verifies OPEN, and the structured fields come back', async () => {
    const log = await createLog();
    const d = await ask(log.row.id, simple({
      yesno: undefined,
      options: [
        { key: 'a', label: 'A', whyChoose: 'cheap', whyNot: 'slow', risks: 'drift' },
        { key: 'b', label: 'B', whyChoose: null, whyNot: null, risks: null },
        { key: 'c', label: 'C' },
      ],
      recommendation: { key: 'a', reason: 'cheapest' },
      background: 'Why we ask.', whyNow: 'Release Friday.',
      neededBy: new Date('2026-12-01T00:00:00.000Z'), defaultAction: 'ship A',
      blocks: [{ ref: 'hadron-server#1' }], sources: [{ ref: 'team:1' }],
      specsTouched: [{ spec: 'cor:dmo:140:03' }], specsMustChange: [{ spec: 'cor:dmo:140:07' }],
    }));
    const row = await rowOf(d.row.id);
    const headings = ['## Explanation', '## What this question is blocking', '## Specs', '## Sources', '## Options', '## Answer'];
    let at = -1;
    for (const h of headings) {
      const i = row.content!.indexOf(h);
      expect(i, h).toBeGreaterThan(at);
      at = i;
    }
    expect(row.content).toContain('**Needed by:** 2026-12-01T00:00:00.000Z. If unanswered: ship A');
    expect(await Q.verifyQuestion(null, { ref: d.row.id }, as(reader.id))).toMatchObject({ state: 'OPEN', findings: [] });
    expect(D.options(d, {}, as())[0]).toEqual({ key: 'a', label: 'A', whyChoose: 'cheap', whyNot: 'slow', risks: 'drift' });
    expect(D.neededBy(d, {}, as())).toBe('2026-12-01T00:00:00.000Z');
    expect(D.specsMustChange(d, {}, as())).toEqual([{ ref: null, node: null, spec: 'cor:dmo:140:07' }]);
    expect(D.taskId(d, {}, as())).toBeNull();
  });

  it('readers and outsiders cannot ask; impersonation is refused', async () => {
    const log = await createLog();
    expect(await codeOf(ask(log.row.id, simple(), reader.id))).toBe('QUESTION_FORBIDDEN');
    expect(await codeOf(ask(log.row.id, simple(), outsider.id))).toBe('QUESTION_LOG_NOT_FOUND');
    expect(await codeOf(ask(log.row.id, simple(), writer.id, { impersonation: { adminUserId: admin.id } as never }))).toBe('QUESTION_IMPERSONATION_REFUSED');
  });

  it('acceptance 3: validates: pointers, recommendation rules, tiers, assignee, deciders narrowed never widened', async () => {
    const log = await createLog({ eligibleDeciders: [admin.id] });
    const bad = await errorOf(ask(log.row.id, { title: '', options: [{ key: '!', label: 'x' }] }));
    expect(bad.extensions.code).toBe('QUESTION_INVALID');
    expect((bad.extensions.pointers as Array<{ pointer: string }>).map((p) => p.pointer)).toEqual(expect.arrayContaining(['/title', '/options/0/key']));
    const opts = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }];
    const invalid = async (input: Record<string, unknown>) => codeOf(ask(log.row.id, input));
    expect(await invalid({ title: 't', options: [...opts, { key: 'a', label: 'dup' }], recommendation: { key: 'a', reason: 'r' } })).toBe('QUESTION_INVALID');
    expect(await invalid({ title: 't', options: opts, recommendation: { key: 'z', reason: 'r' } })).toBe('QUESTION_INVALID');
    expect(await invalid({ title: 't', options: opts })).toBe('QUESTION_RECOMMENDATION_MISSING');
    expect(await invalid({ title: 't', options: opts, recommendation: { key: 'a', reason: 'r' }, noRecommendation: { reason: 'r' } })).toBe('QUESTION_INVALID');
    expect(await invalid({ title: 't', recommendation: { key: 'a', reason: 'r' } })).toBe('QUESTION_INVALID');
    expect(await invalid({ title: 't', defaultAction: 'ship' })).toBe('QUESTION_INVALID');
    expect(await invalid({ title: 't', options: opts, yesno: true, noRecommendation: { reason: 'r' } })).toBe('QUESTION_INVALID');
    expect(await invalid({ title: 't', authorizes: true, tier: 'ANSWERED', noRecommendation: undefined })).toBe('QUESTION_TIER_TOO_LOW');
    expect(await invalid(simple({ authorizes: true, tier: 'APPROVED' }))).toBe('QUESTION_TIER_TOO_LOW');
    expect(await invalid(simple({ assignee: writer.id }))).toBe('QUESTION_ASSIGNEE_NOT_DECIDER');
    const auth = await ask(log.row.id, simple({ authorizes: true }));
    expect(D.tier(auth, {}, as())).toBe('SIGNED');
    expect(await invalid(simple({ deciders: [writer.id] }))).toBe('QUESTION_DECIDER_NOT_ELIGIBLE');
    const narrowed = await ask(log.row.id, simple({ deciders: [admin.id], assignee: admin.id }));
    expect(D.deciderIds(narrowed, {}, as())).toEqual([admin.id]);
    expect(D.assigneeId(narrowed, {}, as())).toBe(admin.id);
    const free = await ask(log.row.id, { title: 'Name it' });
    expect(D.options(free, {}, as())).toEqual([]);
    expect(await D.recommendation(free, {}, as())).toBeNull();
    const none = await ask(log.row.id, { title: 'Pick', options: opts, noRecommendation: { reason: 'no view' } });
    expect(D.noRecommendationReason(none, {}, as())).toBe('no view');
  });

  it('acceptance 10: Node.properties holds priority, answered, assignee and askedByWorkerId', async () => {
    const log = await createLog();
    await createDbWorkerAttribution(db, writer.id, 'worker-bea');
    const d = await runAsActor({ workerId: 'worker-bea', agentId: null }, () => ask(log.row.id, simple({ priority: 'HIGH', assignee: holger.id })));
    const row = await rowOf(d.row.id);
    expect(row.properties).toMatchObject({
      code: 'QA', n: 1, status: 'open', answered: false, priority: 'high', tier: 'answered', assignee: holger.id,
      askedByUserId: writer.id, askedByWorkerId: 'worker-bea', answeredAt: null, deciders: [holger.id],
    });
  });

  it('concurrent asks on one log never duplicate a code (two connections)', async () => {
    const log = await createLog();
    const second = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    try {
      const results = await Promise.all([
        ...Array.from({ length: 4 }, () => ask(log.row.id)),
        ...Array.from({ length: 4 }, () => M.askQuestion(null, { logRef: log.row.id, input: simple() }, { db: second as never, userId: writer.id, roles: [] })),
      ]);
      const locs = results.map((r) => r.row.loc).sort();
      expect(new Set(locs).size).toBe(8);
      expect(locs).toEqual(['QA', 'QB', 'QC', 'QD', 'QE', 'QF', 'QG', 'QH'].map((c) => `questions:${c}`));
      expect((await rowOf(log.row.id)).data).toMatchObject({ lastCode: 8 });
    } finally {
      await second.$disconnect();
    }
  });
});

describe('amendQuestion (§6.2, §7; #4426)', () => {
  it('before an answer any writer amends (OCC on revision); priority is a decider\'s; an omitted field is unchanged', async () => {
    const log = await createLog();
    const d = await ask(log.row.id, simple({ background: 'Keep me', assignee: holger.id }));
    const amend = (input: Record<string, unknown>, rev: number, userId = writer.id) =>
      M.amendQuestion(null, { ref: d.row.id, input, expectedRevision: rev, reason: 'clarify' }, as(userId));
    const a = await amend({ title: 'Ship the codec now?', whyNow: 'Friday', specsTouched: [{ spec: 'cor:dmo:140' }] }, 1);
    expect(D.revSeq(a, {}, as())).toBe(2);
    expect(D.title(a, {}, as())).toBe('Ship the codec now?');
    expect(D.background(a, {}, as())).toBe('Keep me');
    expect(D.assigneeId(a, {}, as())).toBe(holger.id);
    expect(await codeOf(amend({ title: 'x' }, 1))).toBe('NODE_WRITE_CONFLICT');
    expect(await codeOf(amend({ priority: 'URGENT' }, 2))).toBe('QUESTION_NOT_DECIDER');
    const urgent = await amend({ priority: 'URGENT' }, 2, holger.id);
    expect(D.priority(urgent, {}, as())).toBe('URGENT');
    // The revision history records the reason.
    const revs = await db.nodeRevision.findMany({ where: { nodeId: d.row.id }, orderBy: { revNo: 'asc' } });
    expect(revs.map((r) => r.revLabel)).toEqual(['clarify', 'clarify']);
    // A no-op amendment writes no revision.
    expect(D.revSeq(await amend({ priority: 'URGENT' }, 3, holger.id), {}, as())).toBe(3);
  });

  it('acceptance 6: an explicit null clears background, whyNow, assignee, neededBy and defaultAction; omitting leaves them', async () => {
    const log = await createLog();
    const d = await ask(log.row.id, simple({
      background: 'b', whyNow: 'w', assignee: holger.id, neededBy: new Date('2026-12-01T00:00:00.000Z'), defaultAction: 'go',
    }));
    const amend = (input: Record<string, unknown>, rev: number) =>
      M.amendQuestion(null, { ref: d.row.id, input, expectedRevision: rev, reason: 'r' }, as(writer.id));
    const same = await amend({ title: 'Ship the codec?' }, 1);
    expect(D.revSeq(same, {}, as())).toBe(1);
    expect(D.assigneeId(same, {}, as())).toBe(holger.id);
    const cleared = await amend({ background: null, whyNow: null, assignee: null, defaultAction: null, neededBy: null }, 1);
    expect(D.background(cleared, {}, as())).toBeNull();
    expect(D.whyNow(cleared, {}, as())).toBeNull();
    expect(D.assigneeId(cleared, {}, as())).toBeNull();
    expect(D.neededBy(cleared, {}, as())).toBeNull();
    expect(D.defaultAction(cleared, {}, as())).toBeNull();
    expect(await codeOf(amend({ assignee: writer.id }, 2))).toBe('QUESTION_ASSIGNEE_NOT_DECIDER');
  });

  it('the tier is raised by any writer; lowered only by a decider, before an answer, never for an authorizing question', async () => {
    const log = await createLog();
    const d = await ask(log.row.id);
    const amend = (input: Record<string, unknown>, rev: number, userId = writer.id) =>
      M.amendQuestion(null, { ref: d.row.id, input, expectedRevision: rev, reason: 'r' }, as(userId));
    expect(D.tier(await amend({ tier: 'APPROVED' }, 1), {}, as())).toBe('APPROVED');
    expect(await codeOf(amend({ tier: 'ANSWERED' }, 2))).toBe('QUESTION_NOT_DECIDER');
    expect(D.tier(await amend({ tier: 'ANSWERED' }, 2, holger.id), {}, as())).toBe('ANSWERED');
    const auth = await ask(log.row.id, simple({ authorizes: true }));
    expect(await codeOf(M.amendQuestion(null, { ref: auth.row.id, input: { tier: 'APPROVED' }, expectedRevision: 1, reason: 'r' }, as(holger.id)))).toBe('QUESTION_TIER_TOO_LOW');
  });

  it('after an answer, only a decider amends; answered options stay; the tier is never lowered', async () => {
    const log = await createLog();
    const d = await ask(log.row.id, simple({ tier: 'SIGNED' }));
    await answerAsS2(d.row.id, 'yes', holger.id);
    const view = await Q.question(null, { ref: d.row.id }, as());
    expect(D.state(view, {}, as())).toBe('ANSWERED_UNCONFIRMED');
    const amend = (input: Record<string, unknown>, userId = writer.id) =>
      M.amendQuestion(null, { ref: d.row.id, input, expectedRevision: 1, reason: 'clarify' }, as(userId));
    expect(await codeOf(amend({ title: 'x' }))).toBe('QUESTION_NOT_DECIDER');
    expect(await codeOf(amend({ options: [{ key: 'no', label: 'No' }], recommendation: { key: 'no', reason: 'r' } }, holger.id))).toBe('QUESTION_ANSWER_IMMUTABLE');
    expect(await codeOf(amend({ tier: 'APPROVED' }, holger.id))).toBe('QUESTION_TIER_TOO_LOW');
    expect(await codeOf(amend({ title: 'Clarified' }, holger.id))).toBe('NO_ERROR');
  });

  it('a tampered question is refused by every door', async () => {
    const log = await createLog();
    const d = await ask(log.row.id);
    await db.$executeRaw`UPDATE nodes SET data = jsonb_set(data, '{title}', '"forged"') WHERE id = ${d.row.id}`;
    expect(await Q.verifyQuestion(null, { ref: d.row.id }, as())).toMatchObject({ state: 'TAMPERED', findings: ['DATA_MISMATCH'] });
    const e = await errorOf(M.amendQuestion(null, { ref: d.row.id, input: { title: 'x' }, expectedRevision: 1, reason: 'r' }, as(writer.id)));
    expect(e.extensions).toMatchObject({ code: 'QUESTION_INVALID', state: 'TAMPERED' });
    expect(await codeOf(M.withdrawQuestion(null, { ref: d.row.id, reason: 'r', expectedRevision: 1 }, as(writer.id)))).toBe('QUESTION_INVALID');
  });

  it('harmless drift (a raw tag edit) is reconciled under the door\'s lock, not wedged', async () => {
    const log = await createLog();
    const d = await ask(log.row.id);
    await db.$executeRaw`UPDATE nodes SET tags = ARRAY['drift'] WHERE id = ${d.row.id}`;
    const a = await M.amendQuestion(null, { ref: d.row.id, input: { title: 'Still fine' }, expectedRevision: 1, reason: 'r' }, as(writer.id));
    expect(D.state(a, {}, as())).toBe('OPEN');
    expect(D.revSeq(a, {}, as())).toBe(3);
  });
});

describe('withdrawQuestion (§7)', () => {
  it('the asker or a decider withdraws; the code stays consumed; terminal refusals', async () => {
    const log = await createLog();
    const d = await ask(log.row.id);
    expect(await codeOf(M.withdrawQuestion(null, { ref: d.row.id, reason: 'moot', expectedRevision: 1 }, as(admin.id)))).toBe('QUESTION_NOT_ASKER');
    const w = await M.withdrawQuestion(null, { ref: d.row.id, reason: 'moot', expectedRevision: 1 }, as(writer.id));
    expect(D.state(w, {}, as())).toBe('WITHDRAWN');
    expect(await D.withdrawn(w, {}, as())).toMatchObject({ reason: 'moot', by: { userId: writer.id } });
    expect(await codeOf(M.withdrawQuestion(null, { ref: d.row.id, reason: 'again', expectedRevision: 2 }, as(holger.id)))).toBe('QUESTION_WITHDRAWN');
    expect(await codeOf(M.amendQuestion(null, { ref: d.row.id, input: { title: 'x' }, expectedRevision: 2, reason: 'r' }, as(holger.id)))).toBe('QUESTION_WITHDRAWN');
    expect((await ask(log.row.id)).row.loc).toBe('questions:QB');
    const d2 = await ask(log.row.id);
    expect(D.state(await M.withdrawQuestion(null, { ref: d2.row.id, reason: 'mine', expectedRevision: 1 }, as(holger.id)), {}, as())).toBe('WITHDRAWN');
  });

  it('acceptance 7: once ever answered, a decider only; a decider withdraws a DECIDED question (no supersession)', async () => {
    const log = await createLog();
    const d = await ask(log.row.id);
    await answerAsS2(d.row.id, 'yes', holger.id);
    expect(D.state(await Q.question(null, { ref: d.row.id }, as()), {}, as())).toBe('DECIDED');
    expect(await codeOf(M.withdrawQuestion(null, { ref: d.row.id, reason: 'r', expectedRevision: 1 }, as(writer.id)))).toBe('QUESTION_NOT_DECIDER');
    const w = await M.withdrawQuestion(null, { ref: d.row.id, reason: 'r', expectedRevision: 1 }, as(holger.id));
    expect(D.state(w, {}, as())).toBe('WITHDRAWN');
  });

  it('a retraction does not undo "ever answered": the asker still cannot withdraw', async () => {
    const log = await createLog();
    const d = await ask(log.row.id);
    await answerAsS2(d.row.id, 'yes', holger.id);
    await writeAnswerForTest(d.row.id, { kind: 'retraction', by: holger.id, at: '2026-10-06T22:00:00.000Z' });
    expect(D.state(await Q.question(null, { ref: d.row.id }, as()), {}, as())).toBe('OPEN');
    expect(await codeOf(M.withdrawQuestion(null, { ref: d.row.id, reason: 'r', expectedRevision: 1 }, as(writer.id)))).toBe('QUESTION_NOT_DECIDER');
    // The amend gate reads the same rule: after a retraction the asker still cannot amend.
    expect(await codeOf(M.amendQuestion(null, { ref: d.row.id, input: { title: 'Ship it?' }, expectedRevision: 1, reason: 'r' }, as(writer.id)))).toBe('QUESTION_NOT_DECIDER');
  });
});

describe('setQuestionLogDeciders (Q6) and purgeUnansweredQuestion (Q8)', () => {
  it('MANAGE replaces the defaults as an audited log revision; existing questions keep theirs', async () => {
    const log = await createLog();
    const before = await ask(log.row.id);
    expect(await codeOf(M.setQuestionLogDeciders(null, { logRef: log.row.id, defaultDeciders: [admin.id], expectedRevision: 1, reason: 'r' }, as(writer.id)))).toBe('QUESTION_FORBIDDEN');
    const next = await M.setQuestionLogDeciders(null, { logRef: log.row.id, defaultDeciders: [admin.id], eligibleDeciders: [holger.id], expectedRevision: 1, reason: 'Holger delegates' }, as());
    expect(L.defaultDeciderIds(next, {}, as())).toEqual([admin.id]);
    expect(L.eligibleDeciderIds(next, {}, as())).toEqual([holger.id]);
    const revs = await db.nodeRevision.findMany({ where: { nodeId: log.row.id } });
    expect(revs.map((r) => r.revLabel)).toEqual(['Holger delegates']);
    expect((await rowOf(log.row.id)).data).toMatchObject({ lastCode: 1, lastAction: { op: 'set-deciders', reason: 'Holger delegates', by: { userId: admin.id } } });
    expect(D.deciderIds(await Q.question(null, { ref: before.row.id }, as()), {}, as())).toEqual([holger.id]);
    expect(D.deciderIds(await ask(log.row.id), {}, as())).toEqual([admin.id]);
    expect(await codeOf(M.setQuestionLogDeciders(null, { logRef: log.row.id, defaultDeciders: [outsider.id], expectedRevision: 2, reason: 'r' }, as()))).toBe('QUESTION_DECIDER_NOT_ELIGIBLE');
  });

  it('a platform admin purges a never-answered question, recorded on the log; never an answered one', async () => {
    const log = await createLog();
    const d = await ask(log.row.id);
    const answered = await ask(log.row.id);
    await answerAsS2(answered.row.id, 'yes', holger.id);
    expect(await codeOf(M.purgeUnansweredQuestion(null, { ref: d.row.id, reason: 'spam' }, as(admin.id)))).toBe('QUESTION_FORBIDDEN');
    expect(await codeOf(M.purgeUnansweredQuestion(null, { ref: answered.row.id, reason: 'x' }, as(platformAdmin.id, { roles: ['ADMIN'] })))).toBe('QUESTION_ANSWERED');
    expect(await M.purgeUnansweredQuestion(null, { ref: d.row.id, reason: 'spam' }, as(platformAdmin.id, { roles: ['ADMIN'] }))).toBe(true);
    expect(await db.node.findUnique({ where: { id: d.row.id } })).toBeNull();
    const logView = await Q.questionLog(null, { ref: log.row.id }, as());
    const purges = await L.purges(logView, {}, as());
    expect(purges).toEqual([expect.objectContaining({ code: 'QA', byUserId: platformAdmin.id, reason: 'spam', contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
    expect((await ask(log.row.id)).row.loc).toBe('questions:QC');
  });
});

describe('reads (§8.1)', () => {
  it('question by code or citation, questions sorted and filtered after evaluation, awaitingMe; unreadable is null', async () => {
    const log = await createLog();
    const a = await ask(log.row.id);
    const b = await ask(log.row.id, simple({ priority: 'URGENT' }));
    await M.withdrawQuestion(null, { ref: a.row.id, reason: 'moot', expectedRevision: 1 }, as(writer.id));
    expect((await Q.question(null, { code: 'QB', logRef: log.row.id }, as(reader.id))).row.id).toBe(b.row.id);
    expect(await Q.question(null, { code: 'QZ', logRef: log.row.id }, as(reader.id))).toBeNull();
    expect(await Q.question(null, { code: 'QB-1', logRef: log.row.id }, as(reader.id))).toBeNull(); // no part suffix any more (#4426)
    expect(await Q.question(null, { ref: a.row.id }, as(outsider.id))).toBeNull();
    expect(await Q.questionLog(null, { ref: log.row.id }, as(outsider.id))).toBeNull();

    const page = await Q.questions(null, { logRef: log.row.id, sort: 'PORTAL_DEFAULT' }, as(reader.id));
    expect(page.total).toBe(2);
    expect(page.items.map((v: any) => v.row.loc)).toEqual(['questions:QB', 'questions:QA']);
    const open = await Q.questions(null, { logRef: log.row.id, state: ['OPEN'] }, as(reader.id));
    expect(open.items.map((v: any) => v.row.loc)).toEqual(['questions:QB']);
    // The hint in properties is never the filter: a forged status changes nothing.
    await db.$executeRaw`UPDATE nodes SET properties = jsonb_set(properties, '{status}', '"open"') WHERE id = ${a.row.id}`;
    expect((await Q.questions(null, { logRef: log.row.id, state: ['OPEN'] }, as(reader.id))).total).toBe(1);

    expect((await Q.questions(null, { awaitingMe: true }, as(holger.id))).items.map((v: any) => v.row.loc)).toEqual(['questions:QB']);
    expect((await Q.questions(null, { awaitingMe: true }, as(writer.id))).total).toBe(0);
    expect(await D.viewerIsDecider(b, {}, as(holger.id))).toBe(true);
    expect(await D.viewerIsDecider(b, {}, as(writer.id))).toBe(false);
    expect(await D.portalUrl(b, {}, as())).toBeNull(); // FRONTEND_URL is pinned empty in tests
  });
});

describe('§3.2 — no generic path writes, deletes, moves or merges a question', () => {
  it('createNode / updateNode refuse the question family (ROLE_GOVERNED); updateNodeData too', async () => {
    const log = await createLog();
    const d = await ask(log.row.id);
    expect(await codeOf(M.createNode(null, { input: { memoryId: memory.id, loc: 'x', name: 'x', role: 'question' } }, as()))).toBe('ROLE_GOVERNED');
    expect(await codeOf(M.createNode(null, { input: { memoryId: memory.id, loc: 'y', name: 'y', role: 'question.log' } }, as()))).toBe('ROLE_GOVERNED');
    expect(await codeOf(M.updateNode(null, { input: { id: d.row.id, content: 'x' } }, as()))).toBe('ROLE_GOVERNED');
    expect(await codeOf(M.updateNode(null, { input: { id: d.row.id, role: null } }, as()))).toBe('ROLE_GOVERNED');
    expect(await codeOf(M.updateNodeData(null, { nodeRef: d.row.id, data: { title: 'x' } }, as()))).toBe('ROLE_GOVERNED');
    const refusal = await errorOf(M.updateNode(null, { input: { id: d.row.id, content: 'x' } }, as()));
    expect(refusal.extensions).toMatchObject({ kind: 'question', strength: 'authority', door: 'amendQuestion', mcpDoor: null });
    expect(refusal.message).toContain('There is no route to suggest');
    // No generic-shaped door mutation exists for the kind.
    expect(M.askQuestionNode).toBeUndefined();
    expect((resolvers.Mutation as Record<string, unknown>).createQuestionNode).toBeUndefined();
  });

  it('nothing is created in a log\'s code space except by askQuestion', async () => {
    const log = await createLog();
    expect(await codeOf(M.createNode(null, { input: { memoryId: memory.id, loc: 'questions:QA', name: 'squat' } }, as()))).toBe('QUESTION_CONTAINED');
    const other = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'loose', name: 'Loose' } });
    expect(await codeOf(M.moveNode(null, { sourceRef: other.id, targetUrn: `${memory.urn}:questions:QA` }, as()))).toBe('QUESTION_CONTAINED');
    // Deeper descendants are ordinary.
    const d = await ask(log.row.id);
    expect(await codeOf(M.createNode(null, { input: { memoryId: memory.id, loc: `${d.row.loc}:note`, name: 'note' } }, as()))).toBe('NO_ERROR');
  });

  it('deleteNode (soft, hard, an ancestor recursively), moveNode, mergeNodes refuse QUESTION_CONTAINED', async () => {
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'team', name: 'Team' } });
    const log = await createLog({ loc: 'team:questions' });
    const d = await ask(log.row.id);
    const plain = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'plain', name: 'Plain' } });
    expect(await codeOf(M.deleteNode(null, { nodeRef: d.row.id }, as()))).toBe('QUESTION_CONTAINED');
    expect(await codeOf(M.deleteNode(null, { nodeRef: d.row.id, hard: true }, as()))).toBe('QUESTION_CONTAINED');
    expect(await codeOf(M.deleteNode(null, { nodeRef: log.row.id, recursive: true }, as()))).toBe('QUESTION_CONTAINED');
    const team = await db.node.findFirstOrThrow({ where: { memoryId: memory.id, loc: 'team' } });
    expect(await codeOf(M.deleteNode(null, { nodeRef: team.id, recursive: true, hard: true }, as()))).toBe('QUESTION_CONTAINED');
    expect(await codeOf(M.moveNode(null, { sourceRef: d.row.id, targetUrn: `${memory.urn}:elsewhere` }, as()))).toBe('QUESTION_CONTAINED');
    expect(await codeOf(M.moveNode(null, { sourceRef: team.id, targetUrn: `${memory.urn}:team2` }, as()))).toBe('QUESTION_CONTAINED');
    expect(await codeOf(M.mergeNodes(null, { input: { source: plain.id, target: d.row.id } }, as()))).toBe('QUESTION_CONTAINED');
    expect(await codeOf(M.mergeNodes(null, { input: { source: d.row.id, target: plain.id, deleteSource: true } }, as()))).toBe('QUESTION_CONTAINED');
    expect((await rowOf(d.row.id)).deletedAt).toBeNull();
  });

  it('question history is never pruned, deleted or cleared', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { maxRevCount: 1 } });
    const log = await createLog();
    const d = await ask(log.row.id);
    for (let rev = 1; rev <= 3; rev++) {
      await M.amendQuestion(null, { ref: d.row.id, input: { title: `Title ${rev}` }, expectedRevision: rev, reason: `r${rev}` }, as(writer.id));
    }
    const revs = await db.nodeRevision.findMany({ where: { nodeId: d.row.id } });
    expect(revs).toHaveLength(3);
    expect(await codeOf(M.deleteNodeRevision(null, { revisionId: revs[0].id }, as()))).toBe('QUESTION_CONTAINED');
    expect(await codeOf(M.clearNodeHistory(null, { nodeRef: d.row.id }, as()))).toBe('QUESTION_CONTAINED');
    expect(await codeOf(M.restoreNodeRevision(null, { revisionId: revs[0].id }, as()))).toBe('ROLE_GOVERNED');
    expect(await db.nodeRevision.count({ where: { nodeId: d.row.id } })).toBe(3);
  });

  it('the memory holding a log: never deleted, encrypted or git-mirrored; a clone leaves questions behind', async () => {
    await createLog().then((log) => ask(log.row.id));
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'ordinary', name: 'Ordinary' } });
    expect(await codeOf(M.deleteMemory(null, { id: memory.id }, as()))).toBe('QUESTION_CONTAINED');
    expect(await codeOf(M.updateMemory(null, { ref: memory.id, source: 'https://github.com/x/y' }, as()))).toBe('QUESTION_LOG_MIRRORED');
    const clone = await M.cloneMemory(null, { ref: memory.id, targetUrn: 'hrn:mem:decision.example:copy' }, as());
    const cloned = await db.node.findMany({ where: { memoryId: clone.id } });
    expect(cloned.filter((n) => n.role?.startsWith('question'))).toEqual([]);
    // …and only them: a role-less node is cloned (SQL NOT over a NULL role excludes it).
    expect(cloned.map((n) => n.loc)).toContain('ordinary');
  });

  it('encryptMemory refuses a memory holding a log (reciprocal to createQuestionLog)', async () => {
    const priv = await resolvers.Mutation.createMemory(null, { orgId, name: 'assistant', memoryClass: 'private' }, as(holger.id));
    await M.createQuestionLog(null, { memoryRef: priv.id, loc: 'questions', defaultDeciders: [holger.id] }, as(holger.id));
    const dataKey = Buffer.alloc(32, 7).toString('base64');
    expect(await codeOf(M.encryptMemory(null, { memoryId: priv.id, dataKey }, as(holger.id)))).toBe('QUESTION_LOG_ENCRYPTED');
  });

  it('approval: a log is never approvable, a question not yet (S2), and bulk approval skips both with a receipt', async () => {
    const log = await createLog();
    const d = await ask(log.row.id);
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'ordinary', name: 'Ordinary', content: 'x' } });
    expect(await codeOf(M.approveNode(null, { nodeRef: log.row.id }, as(holger.id)))).toBe('QUESTION_LOG_NOT_APPROVABLE');
    expect(await codeOf(M.approveNode(null, { nodeRef: d.row.id }, as(holger.id)))).toBe('QUESTION_NOT_APPROVABLE');
    const bulk = await M.approveMemoryNodes(null, { memoryRef: memory.id }, as());
    expect(bulk).toMatchObject({ skippedQuestionCount: 2, skippedQuestions: ['questions', 'questions:QA'] });
    expect(bulk.approved.map((r: { loc: string }) => r.loc)).toContain('ordinary');
    expect((await rowOf(d.row.id)).approvedRevNo).toBeNull();
  });
});

describe('a personal assistant outside any team (§3.4, r4 use case)', () => {
  it('an agent in another org\'s App asks in its human\'s log; the human sees it awaiting them', async () => {
    // Holger's own unencrypted personal memory; he creates the log and decides.
    const personal = await resolvers.Mutation.createMemory(null, { orgId, name: 'pa', memoryClass: 'personal' }, as(holger.id));
    const log = await M.createQuestionLog(null, { memoryRef: personal.id, loc: 'questions', defaultDeciders: [holger.id] }, as(holger.id));
    // The agent writes on Holger's own token (the honest limit of §6.1: to the server it IS him).
    const d = await runAsActor({ workerId: null, agentId: 'pa-agent' }, () => ask(log.row.id, simple(), holger.id));
    expect(D.state(d, {}, as(holger.id))).toBe('OPEN');
    expect((await Q.questions(null, { awaitingMe: true }, as(holger.id))).items.map((v: any) => v.row.id)).toEqual([d.row.id]);
    // Nobody else reads it.
    expect(await Q.question(null, { ref: d.row.id }, as(admin.id))).toBeNull();
  });
});

describe('Rook §10 on #1690 — the chat-by-loc operations never reach the question family', () => {
  /**
   * Everything a refused write must leave as it was. Since #1717 (#1725) a chat
   * operation reaches only a `chats:<id>` root, and deleteChat takes only the
   * root and its `:messages` subtree, so the fixtures sit at those shapes: a
   * log elsewhere would be refused for its address alone and test nothing.
   */
  const snapshot = async (questionId: string, logId: string, under: string) => {
    const [d, l, view] = await Promise.all([rowOf(questionId), rowOf(logId), Q.question(null, { ref: questionId }, as(holger.id))]);
    return {
      question: { revSeq: d.revSeq, data: d.data, content: d.content, deletedAt: d.deletedAt },
      log: { revSeq: l.revSeq, data: l.data, content: l.content, deletedAt: l.deletedAt },
      state: D.state(view, {}, as()),
      children: await db.node.count({ where: { memoryId: memory.id, loc: { startsWith: `${under}:` } } }),
    };
  };
  /** A log at `logLoc` and a question the writer asked in it. */
  const setUp = async (logLoc: string, under: string) => {
    const log = await createLog({ loc: logLoc });
    const d = await ask(log.row.id);
    return { log, d, before: await snapshot(d.row.id, log.row.id, under) };
  };

  it('send, retitle and delete are refused on a log at a chat-root address (its creator, the memory owner, a platform admin)', async () => {
    const { log, d, before } = await setUp('chats:questions', 'chats');
    expect(before.state).toBe('OPEN');
    expect(log.row.loc).toBe('chats:questions');
    const attempts: Array<[string, string]> = [
      ['chats:questions', writer.id],
      ['chats:questions', admin.id],
      ['chats:questions', platformAdmin.id],
    ];
    for (const [chatId, userId] of attempts) {
      const c = as(userId, { roles: userId === platformAdmin.id ? ['ADMIN'] : ['READER'] });
      expect({ chatId, userId, op: 'send', r: await codeOf(M.sendChatMessage(null, { chatId, userMessage: 'hi' }, c)) })
        .toEqual({ chatId, userId, op: 'send', r: 'CHAT_NOT_FOUND' });
      expect({ chatId, userId, op: 'title', r: await codeOf(M.updateChatTitle(null, { chatId, title: 'x' }, c)) })
        .toMatchObject({ chatId, userId, op: 'title', r: 'CHAT_NOT_FOUND' });
      expect({ chatId, userId, op: 'delete', r: await codeOf(M.deleteChat(null, { chatId }, c)) })
        .toEqual({ chatId, userId, op: 'delete', r: 'CHAT_NOT_FOUND' });
    }
    expect(await snapshot(d.row.id, log.row.id, 'chats')).toEqual(before);
  });

  it('deleting a chat whose transcript holds a log is refused; retitling it touches only the chat', async () => {
    // An ordinary chat root the writer authored, with a log under its `:messages`.
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'chats:planning', name: 'Planning', createdBy: writer.id } });
    const { log, d, before } = await setUp('chats:planning:messages:questions', 'chats:planning');
    const c = as(writer.id, { roles: ['READER'] });
    expect(await codeOf(M.deleteChat(null, { chatId: 'chats:planning' }, c))).toBe('QUESTION_CONTAINED');
    expect(await M.updateChatTitle(null, { chatId: 'chats:planning', title: 'Renamed' }, c)).toBe(true);
    expect(await snapshot(d.row.id, log.row.id, 'chats:planning')).toEqual(before);
    expect((await db.node.findFirstOrThrow({ where: { memoryId: memory.id, loc: 'chats:planning' } })).deletedAt).toBeNull();
  });
});

describe('Rook §10 on #1690 — where a question log may not live', () => {
  it('refuses a system memory (P2: a snapshot restore rewrites it) and an anonymous memory (P3-1: its promotion encrypts it)', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { class: 'system' as never, visibility: null } });
    expect(await codeOf(createLog())).toBe('QUESTION_LOG_SYSTEM_MEMORY');
    const app = await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'Anon', urn: `${orgId.toLowerCase()}:anon` } });
    const agent = await M.createAgent(null, { orgRef: orgId, name: 'Anon Agent' }, as(admin.id, { roles: ['READER'] }));
    await db.memory.update({ where: { id: memory.id }, data: { class: 'app' as never, appId: app.id, userMemoryOfAgentId: agent.id, userId: null } });
    expect(await codeOf(createLog())).toBe('QUESTION_LOG_ANONYMOUS_MEMORY');
    expect(await db.node.count({ where: { memoryId: memory.id, role: 'question.log' } })).toBe(0);
  });
});

describe('Rook §10 on #1690 — the asker worker arm needs a person (P3-3)', () => {
  it('an App key bound to the asking worker\'s session is not the asker', async () => {
    const app = await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'Team', urn: `${orgId.toLowerCase()}:team` } });
    const log = await createLog();
    await createDbWorkerAttribution(db, writer.id, 'worker-ada');
    const d = await runAsActor({ workerId: 'worker-ada', agentId: null }, () => ask(log.row.id));
    // An admin-role App key, so the memory write gate passes and the asker check is what decides.
    const key = { db, appId: app.id, roles: ['ADMIN'] } as Context;
    const r = await runAsActor({ workerId: 'worker-ada', agentId: null }, () =>
      codeOf(M.withdrawQuestion(null, { ref: d.row.id, reason: 'mine?', expectedRevision: 1 }, key)));
    expect(r).toBe('QUESTION_NOT_ASKER');
    expect(D.state(await Q.question(null, { ref: d.row.id }, as()), {}, as())).toBe('OPEN');
  });
});

describe('Rook §10 on #1690 — the counter write never absorbs drift on the log (P3-2)', () => {
  it('an unrevisioned change to the log is recorded as its own revision before askQuestion bumps the counter', async () => {
    const log = await createLog();
    const row = await rowOf(log.row.id);
    // Drift: a direct write with no revision and no fingerprint refresh.
    await db.node.update({ where: { id: log.row.id }, data: { data: { ...(row.data as object), defaultDeciders: [holger.id, admin.id] } as never } });
    expect(await db.nodeRevision.count({ where: { nodeId: log.row.id } })).toBe(0);
    await ask(log.row.id);
    const revs = await db.nodeRevision.findMany({ where: { nodeId: log.row.id } });
    expect(revs).toHaveLength(1);
    // The drift is on the record as a revision of its own, not folded silently into the counter write.
    expect(revs[0].data).toMatchObject({ defaultDeciders: [holger.id, admin.id], lastCode: 0 });
  });
});

describe("Diego's P3 on #1690 — the rendered log stays current after an ask", () => {
  it('the content re-renders from the counted data in the counter write, with no revision', async () => {
    const log = await createLog({ name: 'Team questions' });
    await ask(log.row.id);
    await ask(log.row.id);
    const row = await rowOf(log.row.id);
    expect(row.data).toMatchObject({ lastCode: 2 });
    expect(row.content).toContain('2 issued so far');
    expect(row.content).toBe(renderQuestionLog(row.name, questionLogDataSchema.parse(row.data)));
    expect(await db.nodeRevision.count({ where: { nodeId: log.row.id } })).toBe(0);
  });
});

describe('#1715 — merge-aware identity: stored ids follow mergeUsers, and no record is rewritten', () => {
  const merge = async (source: string, target: string) =>
    M.mergeUsers(null, { input: { source, target, consentProof: await approvedMergeProof(db, source, target, platformAdmin.id) } }, as(platformAdmin.id, { roles: ['ADMIN'] }));
  const fresh = (n: number) => db.user.create({ data: { githubId: 164200 + n, githubUsername: `dn-merge-${n}`, roles: [] } });
  const stored = async (id: string) => {
    const r = await rowOf(id);
    return { data: r.data, content: r.content, name: r.name, abstract: r.abstract, revSeq: r.revSeq };
  };

  it('merges accounts named in a log and a question, records the merge, and leaves both records byte-for-byte', async () => {
    const log = await createLog();
    const d = await ask(log.row.id);
    const [logBefore, dBefore] = [await stored(log.row.id), await stored(d.row.id)];
    const survivor = await fresh(1);
    await merge(holger.id, survivor.id);
    expect(await db.userMerge.findUniqueOrThrow({ where: { sourceUserId: holger.id } }))
      .toMatchObject({ targetUserId: survivor.id, mergedBy: platformAdmin.id });
    expect(await stored(log.row.id)).toEqual(logBefore);
    expect(await stored(d.row.id)).toEqual(dBefore);
    const v = await Q.verifyQuestion(null, { ref: d.row.id }, as(admin.id));
    expect({ state: v.state, findings: v.findings }).toEqual({ state: 'OPEN', findings: [] });
  });

  it("the survivor is the decider: viewerIsDecider, awaitingMe, and a decider's withdrawal after an answer", async () => {
    const d = await ask((await createLog()).row.id);
    await answerAsS2(d.row.id, 'yes', holger.id);
    const survivor = await fresh(2);
    expect(await codeOf(M.withdrawQuestion(null, { ref: d.row.id, reason: 'r', expectedRevision: 1 }, as(survivor.id)))).toMatch(/^QUESTION_NOT_FOUND|^QUESTION_NOT_DECIDER/);
    await merge(holger.id, survivor.id);
    const view = await Q.question(null, { ref: d.row.id }, as(survivor.id));
    expect(await D.viewerIsDecider(view, {}, as(survivor.id))).toBe(true);
    expect(await codeOf(M.withdrawQuestion(null, { ref: d.row.id, reason: 'merged', expectedRevision: 1 }, as(survivor.id)))).toBe('NO_ERROR');
  });

  it("an approval the merge moved to the survivor is still a decider's: the question stays DECIDED", async () => {
    const d = await ask((await createLog()).row.id);
    await answerAsS2(d.row.id, 'yes', holger.id);
    // Stands in for the approval door (questions are approvable from S2): holger approved revision 1.
    const r = await rowOf(d.row.id);
    await db.node.update({ where: { id: d.row.id }, data: {
      approvedBy: holger.id, approvedRevNo: r.revSeq, approvedAt: new Date(),
      approvalHash: computeApprovalHash({ title: r.name, abstract: r.abstract, content: r.content }),
    } });
    expect(D.state(await Q.question(null, { ref: d.row.id }, as(admin.id)), {}, as())).toBe('DECIDED');
    await merge(holger.id, (await fresh(10)).id);
    expect(D.state(await Q.question(null, { ref: d.row.id }, as(admin.id)), {}, as())).toBe('DECIDED');
  });

  it('awaitingMe lists an open question whose stored decider was merged into the caller', async () => {
    const d = await ask((await createLog()).row.id);
    const survivor = await fresh(3);
    await merge(holger.id, survivor.id);
    expect((await Q.questions(null, { awaitingMe: true }, as(survivor.id))).items.map((v: any) => v.row.id)).toEqual([d.row.id]);
  });

  it('the survivor is the asker, and a chain of merges is followed to its end', async () => {
    const d = await ask((await createLog()).row.id);
    const [mid, end] = [await fresh(4), await fresh(5)];
    await merge(writer.id, mid.id);
    await merge(mid.id, end.id);
    expect(await codeOf(M.withdrawQuestion(null, { ref: d.row.id, reason: 'mine', expectedRevision: 1 }, as(end.id)))).toBe('NO_ERROR');
  });

  it("nobody else gains anything: another user is still not the asker or a decider", async () => {
    const d = await ask((await createLog()).row.id);
    await merge(holger.id, (await fresh(6)).id);
    expect(await codeOf(M.withdrawQuestion(null, { ref: d.row.id, reason: 'r', expectedRevision: 1 }, as(admin.id)))).toBe('QUESTION_NOT_ASKER');
    expect((await Q.questions(null, { awaitingMe: true }, as(admin.id))).total).toBe(0);
  });

  it("a new ask on a log naming a merged-away decider stores the survivor; the log's own record is untouched", async () => {
    const log = await createLog();
    const survivor = await fresh(7);
    await merge(holger.id, survivor.id);
    const before = await stored(log.row.id);
    const byDefault = await ask(log.row.id);
    expect(D.deciderIds(byDefault, {}, as())).toEqual([survivor.id]);
    // Naming the survivor narrows from the log's set, which names them by their old id.
    const named = await ask(log.row.id, simple({ deciders: [survivor.id] }));
    expect(D.deciderIds(named, {}, as())).toEqual([survivor.id]);
    const after = await stored(log.row.id);
    expect((after.data as { defaultDeciders: string[] }).defaultDeciders).toEqual([holger.id]);
    expect(after.revSeq).toBe(before.revSeq);
  });

  it('a question and a log show the merges their stored ids follow', async () => {
    const log = await createLog();
    const d = await ask(log.row.id);
    const survivor = await fresh(8);
    await merge(holger.id, survivor.id);
    const view = await Q.question(null, { ref: d.row.id }, as(survivor.id));
    const shown = await D.identityMerges(view, {}, as(survivor.id));
    expect(shown).toEqual([expect.objectContaining({ fromUserId: holger.id, toUserId: survivor.id })]);
    expect(shown[0].to).toMatchObject({ id: survivor.id });
    const logView = await Q.questionLog(null, { ref: log.row.id }, as(survivor.id));
    expect(await L.identityMerges(logView, {}, as(survivor.id))).toEqual([expect.objectContaining({ fromUserId: holger.id, toUserId: survivor.id })]);
    // A question naming no merged account shows none.
    const other = await M.createQuestionLog(null, { memoryRef: memory.id, loc: 'other', defaultDeciders: [admin.id] }, as());
    const untouched = await ask(other.row.id);
    expect(await D.identityMerges(untouched, {}, as(admin.id))).toEqual([]);
  });

  it('a decider change keeping a set that names a merged-away account, and a new log naming one, store the survivor', async () => {
    const log = await createLog({ eligibleDeciders: [writer.id] });
    const survivor = await fresh(9);
    await merge(writer.id, survivor.id);
    const next = await M.setQuestionLogDeciders(null,
      { logRef: log.row.id, defaultDeciders: [admin.id], expectedRevision: 1, reason: 'kept' }, as());
    expect(L.eligibleDeciderIds(next, {}, as())).toEqual([survivor.id]);
    // A new log naming the merged-away account names its survivor.
    const fresh2 = await M.createQuestionLog(null, { memoryRef: memory.id, loc: 'later', defaultDeciders: [writer.id] }, as());
    expect(L.defaultDeciderIds(fresh2, {}, as())).toEqual([survivor.id]);
  });
});

// #4425: old roles become ordinary nodes; the historical payload is left untouched.
it('old decision-role rows are not questions and a memory writer can edit them', async () => {
  const log = await db.node.create({ data: { memoryId: memory.id, loc: 'old', name: 'Old log', role: 'decision.log', nodeType: 'info' } });
  const node = await db.node.create({ data: { memoryId: memory.id, loc: 'old:DA', name: 'Old ask', role: 'decision', nodeType: 'info' } });
  expect(Q.question).toBeTypeOf('function');
  expect(await Q.question(null, { ref: node.id }, as(writer.id))).toBeNull();
  expect(await Q.questions(null, { logRef: log.id }, as(writer.id))).toEqual({ items: [], total: 0 });
  await M.updateNode(null, { input: { id: node.id, name: 'Ordinary editable node' } }, as(writer.id));
  expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).name).toBe('Ordinary editable node');
});

describe('#4426 — nodes and logs in the old format', () => {
  /** A literal pre-#4426 payload (`hadron.dev/decision/v1`), written as the old doors wrote it. */
  async function legacyNode(code: string, n: number, over: Record<string, unknown> = {}) {
    const data = {
      codec: 'hadron.dev/decision/v1', renderer: 'decision-md/1', kind: 'decision', logId: 'x', code, n,
      title: 'Old one', urgency: 'normal', tier: 'approved', authorizes: false, grant: null, archival: false,
      deciders: [holger.id], askedBy: { userId: writer.id, workerId: null, appId: null }, askedAt: '2026-11-18T10:00:00.000Z',
      context: null, blocks: [], sources: [], followUps: [],
      parts: [{ n: 1, question: 'Old?', options: [], recommendation: null, noRecommendation: { reason: 'r' }, answer: null, answerHistory: [] }],
      status: 'open', withdrawn: null, supersedes: null, supersededBy: null,
      ...over,
    };
    const content = `# ${code}: Old one\n\nold text\n\n---\n\n\`\`\`hadron-decision\n${canonicalQuestionJson(data)}\n\`\`\`\n`;
    return db.node.create({
      data: {
        id: generateId(), memoryId: memory.id, loc: `questions:${code}`, role: 'question', seq: n, name: `${code}: Old one`,
        abstract: 'old', content, data: data as never,
      },
    });
  }
  const platform = () => as(platformAdmin.id, { roles: ['ADMIN'] });

  it('acceptance 8: a legacy node reads UNVERIFIABLE, no door writes it, and only a platform admin purges it', async () => {
    const log = await createLog();
    const old = await legacyNode('QA', 1);
    const view = await Q.question(null, { ref: old.id }, as());
    expect(D.state(view, {}, as())).toBe('UNVERIFIABLE');
    expect(await Q.verifyQuestion(null, { ref: old.id }, as())).toMatchObject({ state: 'UNVERIFIABLE', findings: ['UNKNOWN_CODEC'], codec: 'hadron.dev/decision/v1' });
    expect(await codeOf(M.amendQuestion(null, { ref: old.id, input: { title: 'x' }, expectedRevision: 1, reason: 'r' }, as(writer.id)))).toBe('QUESTION_INVALID');
    expect(await codeOf(M.withdrawQuestion(null, { ref: old.id, reason: 'r', expectedRevision: 1 }, as(writer.id)))).toBe('QUESTION_INVALID');
    expect(await codeOf(M.purgeUnansweredQuestion(null, { ref: old.id, reason: 'stranded' }, as(admin.id)))).toBe('QUESTION_FORBIDDEN');
    expect(await db.node.findUnique({ where: { id: old.id } })).not.toBeNull();
    expect(await M.purgeUnansweredQuestion(null, { ref: old.id, reason: 'stranded' }, platform())).toBe(true);
    expect(await db.node.findUnique({ where: { id: old.id } })).toBeNull();
    const purges = await L.purges(await Q.questionLog(null, { ref: log.row.id }, as()), {}, as());
    expect(purges).toEqual([expect.objectContaining({ code: 'QA', byUserId: platformAdmin.id, reason: 'stranded' })]);
    // The code stays consumed.
    expect((await ask(log.row.id)).row.loc).toBe('questions:QB');
  });

  it('acceptance 8: nothing else unparsed is purgeable: a corrupt new-codec node, an unknown codec, a node with no block', async () => {
    const log = await createLog();
    const corrupt = await ask(log.row.id);
    // The payload no longer parses (answers is not a list) in the block and the cache alike.
    await db.$executeRaw`UPDATE nodes SET data = jsonb_set(data, '{answers}', '"x"'), content = replace(content, '"answers":[]', '"answers":"x"') WHERE id = ${corrupt.row.id}`;
    expect(await Q.verifyQuestion(null, { ref: corrupt.row.id }, as())).toMatchObject({ state: 'TAMPERED', findings: ['BLOCK_INVALID'] });
    const unknown = await legacyNode('QX', 40, { codec: 'hadron.dev/decision/v9' });
    const noBlock = await db.node.create({
      data: { id: generateId(), memoryId: memory.id, loc: 'questions:QY', role: 'question', seq: 41, name: 'QY: x', abstract: 'x', content: 'no block', data: {} },
    });
    for (const id of [corrupt.row.id, unknown.id, noBlock.id]) {
      expect(await codeOf(M.purgeUnansweredQuestion(null, { ref: id, reason: 'x' }, platform()))).toBe('QUESTION_INVALID');
      expect(await db.node.findUnique({ where: { id } })).not.toBeNull();
    }
  });

  it('acceptance 9: a log with the legacy codec and kind still accepts askQuestion and setQuestionLogDeciders, and keeps them', async () => {
    const log = await createLog({ prefix: 'D' });
    await db.$executeRaw`UPDATE nodes SET data = jsonb_set(jsonb_set(data, '{codec}', '"hadron.dev/decision-log/v1"'), '{kind}', '"decision.log"'), revision_content_hash = 'refresh' WHERE id = ${log.row.id}`;
    const q = await ask(log.row.id);
    expect(D.code(q, {}, as())).toBe('DA');
    expect((await rowOf(log.row.id)).data).toMatchObject({ codec: 'hadron.dev/decision-log/v1', kind: 'decision.log', lastCode: 1 });
    const next = await M.setQuestionLogDeciders(null, { logRef: log.row.id, defaultDeciders: [admin.id], expectedRevision: (await rowOf(log.row.id)).revSeq, reason: 'r' }, as());
    expect(L.defaultDeciderIds(next, {}, as())).toEqual([admin.id]);
    expect((await rowOf(log.row.id)).data).toMatchObject({ codec: 'hadron.dev/decision-log/v1', kind: 'decision.log' });
  });
});

describe('#4426 — the list orders and filters by priority', () => {
  it('PORTAL_DEFAULT is urgent, high, normal, low, then open before the rest, then newest; the priority filter narrows', async () => {
    const log = await createLog();
    const low = await ask(log.row.id, simple({ priority: 'LOW' }));
    const normal = await ask(log.row.id, simple({ priority: 'NORMAL' }));
    const high = await ask(log.row.id, simple({ priority: 'HIGH' }));
    const urgent = await ask(log.row.id, simple({ priority: 'URGENT' }));
    const answeredHigh = await ask(log.row.id, simple({ priority: 'HIGH' }));
    await answerAsS2(answeredHigh.row.id, 'yes', holger.id);
    const page = await Q.questions(null, { logRef: log.row.id, sort: 'PORTAL_DEFAULT' }, as(reader.id));
    expect(page.items.map((v: any) => v.row.id)).toEqual([urgent, high, answeredHigh, normal, low].map((v) => v.row.id));
    const only = await Q.questions(null, { logRef: log.row.id, priority: ['HIGH', 'LOW'] }, as(reader.id));
    expect(only.items.map((v: any) => v.row.id).sort()).toEqual([high, answeredHigh, low].map((v) => v.row.id).sort());
  });
});
