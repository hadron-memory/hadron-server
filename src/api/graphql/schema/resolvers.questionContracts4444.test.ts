/**
 * #4444 — contract pins for the question doors (follow-up to #4435's BLIND F3 and LOCAL F2).
 * Tests only: external results of the doors, never source text. Every literal below is written
 * out here on purpose: a fixture and an expectation that import the same constant cannot catch
 * that constant being wrong.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { questionError, type QuestionRefusalCode } from '../../../lib/questions/index.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let admin: { id: string };
let writer: { id: string };
let holger: { id: string };
let memory: { id: string };

const as = (userId = admin.id): Context => ({ db, userId, roles: [] });
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) { return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message; }
};
const createLog = () => M.createQuestionLog(null, { memoryRef: memory.id, loc: 'questions', defaultDeciders: [holger.id] }, as());
const ask = (logRef: string) => M.askQuestion(null, { logRef, input: {
  title: 'Ship the codec?',
  yesno: true,
  recommendation: { key: 'yes', reason: 'ready' },
} }, as(writer.id));
const rowOf = (id: string) => db.node.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Contract Org', urn: 'contract.example' } });
  admin = await db.user.create({ data: { githubId: 444401, githubUsername: 'qc-admin', handle: 'qc-admin', roles: [] } });
  writer = await db.user.create({ data: { githubId: 444402, githubUsername: 'qc-writer', handle: 'qc-writer', roles: [] } });
  holger = await db.user.create({ data: { githubId: 444403, githubUsername: 'qc-holger', handle: 'qc-holger', roles: [] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: writer.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: holger.id, role: 'CONTRIBUTOR' },
  ] });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'team-shared' }, as());
});

// The complete public refusal-code set of the question doors (#1641 §7, §8.4), written out. A
// Record keyed by QuestionRefusalCode makes `pnpm tsc` fail on an omitted OR an extra code.
const CONTRACT: Record<QuestionRefusalCode, true> = {
  QUESTION_NOT_FOUND: true, QUESTION_LOG_NOT_FOUND: true, QUESTION_LOG_EXISTS: true, QUESTION_LOG_ENCRYPTED: true,
  QUESTION_LOG_MIRRORED: true, QUESTION_LOG_SYSTEM_MEMORY: true, QUESTION_LOG_ANONYMOUS_MEMORY: true,
  QUESTION_LOG_NOT_APPROVABLE: true, QUESTION_LOG_TOO_LARGE_FOR_FILTER: true, QUESTION_INVALID: true,
  QUESTION_TIER_TOO_LOW: true, QUESTION_DECIDER_NOT_ELIGIBLE: true, QUESTION_RECOMMENDATION_MISSING: true,
  QUESTION_ASSIGNEE_NOT_DECIDER: true, QUESTION_ANSWER_IMMUTABLE: true, QUESTION_UNKNOWN_OPTION: true, QUESTION_NOT_ANSWERED: true, QUESTION_NOT_DECIDER: true, QUESTION_NOT_ASKER: true,
  QUESTION_IMPERSONATION_REFUSED: true, QUESTION_WITHDRAWN: true,
  QUESTION_ANSWERED: true, QUESTION_NOT_APPROVABLE: true, QUESTION_CONTAINED: true, QUESTION_FORBIDDEN: true,
};
const CODES = Object.keys(CONTRACT);

/** The contract check itself: what a mixed or former-prefix code must fail. */
function assertCodeContract(codes: readonly string[]): void {
  for (const code of codes) {
    if (!/^QUESTION_[A-Z_]+$/.test(code)) throw new Error(`not a QUESTION_* code: ${code}`);
    const err = questionError(code as QuestionRefusalCode, 'm');
    if (!(err instanceof GraphQLError) || err.extensions.code !== code) throw new Error(`refusal does not carry its code: ${code}`);
  }
}

describe('question refusal-code contract (#4444)', () => {
  it('names 25 distinct codes, every one QUESTION_*-prefixed and carried verbatim on extensions.code', () => {
    expect(CODES).toHaveLength(25);
    expect(new Set(CODES).size).toBe(25);
    expect(() => assertCodeContract(CODES)).not.toThrow();
    for (const code of CODES) expect(questionError(code as QuestionRefusalCode, 'm', { code: 'SHADOW' }).extensions.code).toBe(code);
  });

  it('sensitivity control: one code reverted to the former DECISION_ prefix fails, for that reason', () => {
    const reverted = CODES.map((c) => (c === 'QUESTION_WITHDRAWN' ? 'DECISION_WITHDRAWN' : c));
    expect(() => assertCodeContract(reverted)).toThrow('not a QUESTION_* code: DECISION_WITHDRAWN');
    expect(() => assertCodeContract(CODES.filter((c) => c !== 'QUESTION_WITHDRAWN'))).not.toThrow(); // the control does not trip on absence: tsc owns omission
  });

  // The codes no other suite exercises, each through its real door.
  it('QUESTION_NOT_FOUND: an unknown question ref', async () => {
    expect(await codeOf(M.withdrawQuestion(null, { ref: generateId(), reason: 'r', expectedRevision: 1 }, as()))).toBe('QUESTION_NOT_FOUND');
  });

  it('QUESTION_LOG_TOO_LARGE_FOR_FILTER: a log past the 5000-question evaluation cap', async () => {
    const log = await createLog();
    const rows = Array.from({ length: 5001 }, (_, i) => ({ id: generateId(), memoryId: memory.id, loc: `questions:Z${i}`, name: `q${i}`, role: 'question' }));
    await db.node.createMany({ data: rows });
    expect(await codeOf(Q.questions(null, { logRef: log.row.id }, as()))).toBe('QUESTION_LOG_TOO_LARGE_FOR_FILTER');
  });
});

describe('question codec and renderer ids (#4444)', () => {
  // Written out, not imported. When a slice intentionally versions the codec, THIS is the test that
  // changes with it; a wrong id anywhere else (door, renderer, evaluator) must make it fail.
  it('a new question and its log carry the active versioned ids in data and in the rendered block', async () => {
    const log = await createLog();
    const q = await ask(log.row.id);
    const qr = await rowOf(q.row.id);
    expect(qr.data).toMatchObject({ codec: 'hadron.dev/question/v1', renderer: 'question-md/1' });
    expect(qr.content).toContain('hadron.dev/question/v1');
    expect((await rowOf(log.row.id)).data).toMatchObject({ codec: 'hadron.dev/question-log/v1' });
  });

  it('a question stored under another codec id is unverifiable, not silently accepted', async () => {
    const q = await ask((await createLog()).row.id);
    const r = await rowOf(q.row.id);
    const bad = { ...(r.data as object), codec: 'hadron.dev/question/v0' };
    await db.node.update({ where: { id: q.row.id }, data: { data: bad as never, content: (r.content ?? '').replaceAll('hadron.dev/question/v1', 'hadron.dev/question/v0') } });
    expect(await Q.verifyQuestion(null, { ref: q.row.id }, as())).toMatchObject({ state: 'UNVERIFIABLE', findings: ['UNKNOWN_CODEC'] });
  });
});
