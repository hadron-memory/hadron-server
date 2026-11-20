/**
 * #1641 — question nodes: human questions as governed nodes. The plan of
 * record is `hrn:node:hadronmemory.com:hadron-server:design:decision-nodes`
 * (r4); its section numbers are cited as §n below. The spec placement is
 * `cor:dmo:140` (confirmed, not yet authored).
 *
 * A question is a node with role `question` that only the question doors
 * write (§7). It lives under a question LOG, a node with role `question.log`
 * that holds the code counter and the deciders (§3.3). Both are one governed
 * kind (`question`, strength `authority`) in `GOVERNED_KINDS`.
 *
 * This module holds the shared constants, the typed refusals and the
 * containment checks the generic paths use to refuse a question (§3.2).
 */
import { GraphQLError } from 'graphql';
import type { Prisma } from '../../generated/prisma/index.js';
import { roleIsOrDescendsFrom } from '../governedRole.js';

/** Role of a question node. */
export const QUESTION_ROLE = 'question';
/** Role of a question log node (the only sub-role in v1, Q4). */
export const QUESTION_LOG_ROLE = 'question.log';

/** Whether `role` is in the question family (a question or a log). */
export function isQuestionFamilyRole(role: string | null | undefined): boolean {
  return roleIsOrDescendsFrom(role, QUESTION_ROLE);
}

/** The typed refusal codes of the question doors (§7, §8.4). */
export type QuestionRefusalCode =
  | 'QUESTION_NOT_FOUND'
  | 'QUESTION_LOG_NOT_FOUND'
  | 'QUESTION_LOG_EXISTS'
  | 'QUESTION_LOG_ENCRYPTED'
  | 'QUESTION_LOG_MIRRORED'
  | 'QUESTION_LOG_SYSTEM_MEMORY'
  | 'QUESTION_LOG_ANONYMOUS_MEMORY'
  | 'QUESTION_LOG_NOT_APPROVABLE'
  | 'QUESTION_LOG_TOO_LARGE_FOR_FILTER'
  | 'QUESTION_INVALID'
  | 'QUESTION_TIER_TOO_LOW'
  | 'QUESTION_DECIDER_NOT_ELIGIBLE'
  | 'QUESTION_RECOMMENDATION_MISSING'
  | 'QUESTION_ASSIGNEE_NOT_DECIDER'
  | 'QUESTION_ANSWER_IMMUTABLE'
  | 'QUESTION_NOT_DECIDER'
  | 'QUESTION_NOT_ASKER'
  | 'QUESTION_IMPERSONATION_REFUSED'
  | 'QUESTION_WITHDRAWN'
  | 'QUESTION_ANSWERED'
  | 'QUESTION_NOT_APPROVABLE'
  | 'QUESTION_CONTAINED'
  | 'QUESTION_FORBIDDEN';

/** A typed question refusal: `extensions.code` plus the code's documented extensions. */
export function questionError(
  code: QuestionRefusalCode,
  message: string,
  extensions: Record<string, unknown> = {},
): GraphQLError {
  // The refusal code last, so no extension can shadow it.
  return new GraphQLError(message, { extensions: { ...extensions, code } });
}

/**
 * §3.2 — the refusal for an operation on an ordinary node or a memory that
 * CONTAINS a question or a log: deleting, moving or merging it would erase
 * question history or change a citation. `what` names the operation.
 */
export function questionContainedError(what: string, codes: string[] = []): GraphQLError {
  return questionError(
    'QUESTION_CONTAINED',
    `${what} is refused: it would delete, move or merge a question or a question log. ` +
      'Questions are never deleted or moved; a question is withdrawn through its own operation.',
    codes.length > 0 ? { questionLocs: codes.slice(0, 50) } : {},
  );
}

type Db = Pick<Prisma.TransactionClient, 'node'>;

/** Prisma predicate for a node in the question family (question or log). */
export const QUESTION_FAMILY_WHERE: Prisma.NodeWhereInput = {
  OR: [{ role: QUESTION_ROLE }, { role: { startsWith: `${QUESTION_ROLE}.` } }],
};

/**
 * Prisma predicate for every node OUTSIDE the question family. Not a bare
 * `NOT: QUESTION_FAMILY_WHERE`: `role` is nullable, and SQL's `NOT (role = …)`
 * is NULL — so excluded — for every ordinary node with no role.
 */
export const NOT_QUESTION_FAMILY_WHERE: Prisma.NodeWhereInput = {
  OR: [{ role: null }, { NOT: QUESTION_FAMILY_WHERE }],
};

/**
 * The question-family nodes among `ids`, live or soft-deleted (a tombstone of
 * one is still history). For a generic path to refuse them.
 */
export async function questionFamilyAmong(db: Db, ids: string[]): Promise<Array<{ id: string; loc: string }>> {
  if (ids.length === 0) return [];
  return db.node.findMany({ where: { id: { in: ids }, ...QUESTION_FAMILY_WHERE }, select: { id: true, loc: true } });
}

/**
 * The question-family nodes at or under any of `locs` in `memoryId` (a
 * subtree operation's reach), live or not. Bounded: a refusal needs only
 * evidence, never the full set.
 */
export async function questionFamilyUnder(
  db: Db,
  memoryId: string,
  locs: string[],
): Promise<Array<{ id: string; loc: string }>> {
  if (locs.length === 0) return [];
  return db.node.findMany({
    where: {
      memoryId,
      ...QUESTION_FAMILY_WHERE,
      AND: [{ OR: locs.flatMap((loc) => [{ loc }, { loc: { startsWith: `${loc}:` } }]) }],
    },
    select: { id: true, loc: true },
    take: 50,
  });
}

/** Whether `memoryId` holds any question-family node (live or not). */
export async function memoryHoldsQuestions(db: Db, memoryId: string): Promise<boolean> {
  const row = await db.node.findFirst({ where: { memoryId, ...QUESTION_FAMILY_WHERE }, select: { id: true } });
  return row != null;
}

/** Whether `memoryId` holds a question LOG (the §3.2 / §5.4 container checks). */
export async function memoryHoldsQuestionLog(db: Db, memoryId: string): Promise<boolean> {
  const row = await db.node.findFirst({ where: { memoryId, role: QUESTION_LOG_ROLE }, select: { id: true } });
  return row != null;
}

/** Throw {@link questionContainedError} when any of `ids` is a question or a log. */
export async function refuseQuestionFamily(db: Db, ids: string[], what: string): Promise<void> {
  const hits = await questionFamilyAmong(db, ids);
  if (hits.length > 0) throw questionContainedError(what, hits.map((h) => h.loc));
}

/** Throw {@link questionContainedError} when a subtree at `locs` reaches a question or a log. */
export async function refuseQuestionsUnder(db: Db, memoryId: string, locs: string[], what: string): Promise<void> {
  const hits = await questionFamilyUnder(db, memoryId, locs);
  if (hits.length > 0) throw questionContainedError(what, hits.map((h) => h.loc));
}

/**
 * Refuse placing an ordinary node DIRECTLY under a question log (a create, a
 * move or an import at `<logLoc>:<atom>`). Those locs are the log's code
 * space: a node squatting `<logLoc>:DV` would block the allocator from ever
 * issuing DV. Deeper descendants (a note under a question) are ordinary.
 */
export async function refuseUnderQuestionLog(db: Db, memoryId: string, loc: string, what: string): Promise<void> {
  const cut = loc.lastIndexOf(':');
  if (cut <= 0) return;
  const parent = await db.node.findUnique({
    where: { loc_memoryId: { loc: loc.slice(0, cut), memoryId } },
    select: { role: true },
  });
  if (parent?.role === QUESTION_LOG_ROLE) {
    throw questionError(
      'QUESTION_CONTAINED',
      `${what} is refused: "${loc}" is directly under a question log, whose child locs are its question codes. Questions are asked with askQuestion.`,
      { loc },
    );
  }
}
