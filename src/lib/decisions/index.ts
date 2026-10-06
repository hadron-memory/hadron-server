/**
 * #1641 — decision nodes: human decisions as governed nodes. The plan of
 * record is `hrn:node:hadronmemory.com:hadron-server:design:decision-nodes`
 * (r4); its section numbers are cited as §n below. The spec placement is
 * `cor:dmo:140` (confirmed, not yet authored).
 *
 * A decision is a node with role `decision` that only the decision doors
 * write (§7). It lives under a decision LOG, a node with role `decision.log`
 * that holds the code counter and the deciders (§3.3). Both are one governed
 * kind (`decision`, strength `authority`) in `GOVERNED_KINDS`.
 *
 * This module holds the shared constants, the typed refusals and the
 * containment checks the generic paths use to refuse a decision (§3.2).
 */
import { GraphQLError } from 'graphql';
import type { Prisma } from '../../generated/prisma/index.js';
import { roleIsOrDescendsFrom } from '../governedRole.js';

/** Role of a decision node. */
export const DECISION_ROLE = 'decision';
/** Role of a decision log node (the only sub-role in v1, Q4). */
export const DECISION_LOG_ROLE = 'decision.log';

/** Whether `role` is in the decision family (a decision or a log). */
export function isDecisionFamilyRole(role: string | null | undefined): boolean {
  return roleIsOrDescendsFrom(role, DECISION_ROLE);
}

/** The typed refusal codes of the decision doors (§7, §8.4). */
export type DecisionRefusalCode =
  | 'DECISION_NOT_FOUND'
  | 'DECISION_LOG_NOT_FOUND'
  | 'DECISION_LOG_EXISTS'
  | 'DECISION_LOG_ENCRYPTED'
  | 'DECISION_LOG_MIRRORED'
  | 'DECISION_LOG_NOT_APPROVABLE'
  | 'DECISION_LOG_TOO_LARGE_FOR_FILTER'
  | 'DECISION_INVALID'
  | 'DECISION_TIER_TOO_LOW'
  | 'DECISION_DECIDER_NOT_ELIGIBLE'
  | 'DECISION_RECOMMENDATION_MISSING'
  | 'DECISION_PART_RENUMBER'
  | 'DECISION_ANSWER_IMMUTABLE'
  | 'DECISION_NOT_DECIDER'
  | 'DECISION_NOT_ASKER'
  | 'DECISION_IMPERSONATION_REFUSED'
  | 'DECISION_WITHDRAWN'
  | 'DECISION_SUPERSEDED'
  | 'DECISION_ANSWERED_DECIDED'
  | 'DECISION_ANSWERED'
  | 'DECISION_NOT_APPROVABLE'
  | 'DECISION_CONTAINED'
  | 'DECISION_FORBIDDEN';

/** A typed decision refusal: `extensions.code` plus the code's documented extensions. */
export function decisionError(
  code: DecisionRefusalCode,
  message: string,
  extensions: Record<string, unknown> = {},
): GraphQLError {
  // The refusal code last, so no extension can shadow it.
  return new GraphQLError(message, { extensions: { ...extensions, code } });
}

/**
 * §3.2 — the refusal for an operation on an ordinary node or a memory that
 * CONTAINS a decision or a log: deleting, moving or merging it would erase
 * decision history or change a citation. `what` names the operation.
 */
export function decisionContainedError(what: string, codes: string[] = []): GraphQLError {
  return decisionError(
    'DECISION_CONTAINED',
    `${what} is refused: it would delete, move or merge a decision or a decision log. ` +
      'Decisions are never deleted or moved; a decision is withdrawn or superseded through its own operations.',
    codes.length > 0 ? { decisionLocs: codes.slice(0, 50) } : {},
  );
}

type Db = Pick<Prisma.TransactionClient, 'node'>;

/** Prisma predicate for a node in the decision family (decision or log). */
export const DECISION_FAMILY_WHERE: Prisma.NodeWhereInput = {
  OR: [{ role: DECISION_ROLE }, { role: { startsWith: `${DECISION_ROLE}.` } }],
};

/**
 * Prisma predicate for every node OUTSIDE the decision family. Not a bare
 * `NOT: DECISION_FAMILY_WHERE`: `role` is nullable, and SQL's `NOT (role = …)`
 * is NULL — so excluded — for every ordinary node with no role.
 */
export const NOT_DECISION_FAMILY_WHERE: Prisma.NodeWhereInput = {
  OR: [{ role: null }, { NOT: DECISION_FAMILY_WHERE }],
};

/**
 * The decision-family nodes among `ids`, live or soft-deleted (a tombstone of
 * one is still history). For a generic path to refuse them.
 */
export async function decisionFamilyAmong(db: Db, ids: string[]): Promise<Array<{ id: string; loc: string }>> {
  if (ids.length === 0) return [];
  return db.node.findMany({ where: { id: { in: ids }, ...DECISION_FAMILY_WHERE }, select: { id: true, loc: true } });
}

/**
 * The decision-family nodes at or under any of `locs` in `memoryId` (a
 * subtree operation's reach), live or not. Bounded: a refusal needs only
 * evidence, never the full set.
 */
export async function decisionFamilyUnder(
  db: Db,
  memoryId: string,
  locs: string[],
): Promise<Array<{ id: string; loc: string }>> {
  if (locs.length === 0) return [];
  return db.node.findMany({
    where: {
      memoryId,
      ...DECISION_FAMILY_WHERE,
      AND: [{ OR: locs.flatMap((loc) => [{ loc }, { loc: { startsWith: `${loc}:` } }]) }],
    },
    select: { id: true, loc: true },
    take: 50,
  });
}

/** Whether `memoryId` holds any decision-family node (live or not). */
export async function memoryHoldsDecisions(db: Db, memoryId: string): Promise<boolean> {
  const row = await db.node.findFirst({ where: { memoryId, ...DECISION_FAMILY_WHERE }, select: { id: true } });
  return row != null;
}

/** Whether `memoryId` holds a decision LOG (the §3.2 / §5.4 container checks). */
export async function memoryHoldsDecisionLog(db: Db, memoryId: string): Promise<boolean> {
  const row = await db.node.findFirst({ where: { memoryId, role: DECISION_LOG_ROLE }, select: { id: true } });
  return row != null;
}

/** Throw {@link decisionContainedError} when any of `ids` is a decision or a log. */
export async function refuseDecisionFamily(db: Db, ids: string[], what: string): Promise<void> {
  const hits = await decisionFamilyAmong(db, ids);
  if (hits.length > 0) throw decisionContainedError(what, hits.map((h) => h.loc));
}

/** Throw {@link decisionContainedError} when a subtree at `locs` reaches a decision or a log. */
export async function refuseDecisionsUnder(db: Db, memoryId: string, locs: string[], what: string): Promise<void> {
  const hits = await decisionFamilyUnder(db, memoryId, locs);
  if (hits.length > 0) throw decisionContainedError(what, hits.map((h) => h.loc));
}

/**
 * Refuse placing an ordinary node DIRECTLY under a decision log (a create, a
 * move or an import at `<logLoc>:<atom>`). Those locs are the log's code
 * space: a node squatting `<logLoc>:DV` would block the allocator from ever
 * issuing DV. Deeper descendants (a note under a decision) are ordinary.
 */
export async function refuseUnderDecisionLog(db: Db, memoryId: string, loc: string, what: string): Promise<void> {
  const cut = loc.lastIndexOf(':');
  if (cut <= 0) return;
  const parent = await db.node.findUnique({
    where: { loc_memoryId: { loc: loc.slice(0, cut), memoryId } },
    select: { role: true },
  });
  if (parent?.role === DECISION_LOG_ROLE) {
    throw decisionError(
      'DECISION_CONTAINED',
      `${what} is refused: "${loc}" is directly under a decision log, whose child locs are its decision codes. Decisions are asked with askDecision.`,
      { loc },
    );
  }
}
