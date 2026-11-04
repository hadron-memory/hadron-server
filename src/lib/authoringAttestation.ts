/**
 * #1328 — authoring attestation (D-2026-09-24-003; pending codification in
 * `cor:acl`).
 *
 * A write that AUTHORS a node whose rule names an author task states
 * `authoredWith { task, revision }`, the task it worked from and that task's
 * `revSeq`. The server compares the claim with the rule and the task's current
 * revision, refuses a missing, wrong or stale claim, and on a match records a
 * server-owned TASK stamp. That catches forgetting and stale procedures. It
 * does NOT prove the task was read or followed, and it does not detect a liar.
 *
 * ## The context is required
 *
 * {@link AuthoringContext} is a required argument of every writer, not an
 * option a call site can drop: a writer has to say which of the four things it
 * is doing. Three of them skip the comparison, and each has a narrow source:
 * `trustedHuman` is derived from the authenticated session only
 * ({@link authoringFromRequest}), `carry` is for paths that copy a stored stamp
 * (a clone), and `platform` names a closed list of server-generated records.
 *
 * ## Lock order (#1330)
 *
 * The caller holds its node locks. This takes `lockMemoryConfigShared`, then
 * reads the rulebook and the task, and takes no other lock. Every rule write
 * takes the same lock EXCLUSIVELY and last, so a rule created, repointed or
 * disabled while this waited is judged as committed, including the absent-rule
 * phantom, which a row lock could not cover.
 *
 * A rename across memories takes the shared lock on both. Shared locks do not
 * conflict, and a rule writer's exclusive lock is its last, so this cannot cycle.
 *
 * The task row is read, not locked: a lock here could cycle with a task edit
 * queued behind a rule writer. The check is the serialization point, so a task
 * revision committed before it refuses the claim as stale, and one committed
 * after it orders this write first. The stamp is then true of the revision the
 * write was admitted against, and nodes are not invalidated by a later revision.
 */
import { GraphQLError } from 'graphql';
import type { NodeRoleRule, Prisma } from '../generated/prisma/index.js';
import { lockMemoryConfigShared, resolveNodeRoleRule } from './governedRole.js';
import type { NodeAuthorshipStamp } from './nodeAuthorship.js';
import { ruleKeysOf } from './nodeRoleWriters.js';
import { safeNodeUrnV2 } from './urnEmit.js';

/** The writer's claim: a task, by id or canonical URN, and its current `revSeq`. */
export interface AuthoredWith {
  task: string;
  revision: number;
}

/** The server-generated records a rule cannot require a task for. A closed list, by design. */
export type PlatformAuthoring = 'decision' | 'boot-prompt-compile' | 'session-handoff' | 'spec-reservation' | 'spec-renumber';

/** What a writer is doing, stated at every authoring seam. See the module comment. */
export type AuthoringContext =
  | { kind: 'attested'; authoredWith: AuthoredWith | null }
  | { kind: 'trustedHuman'; authenticatedUserId: string }
  | { kind: 'carry' }
  | { kind: 'platform'; record: PlatformAuthoring };

export type AttestationRefusalCode =
  | 'AUTHORING_ATTESTATION_MISSING'
  | 'AUTHORING_ATTESTATION_WRONG_TASK'
  | 'AUTHORING_ATTESTATION_STALE'
  | 'AUTHOR_TASK_BROKEN';

const REFUSAL_TEXT: Record<AttestationRefusalCode, (role: string) => string> = {
  AUTHORING_ATTESTATION_MISSING: (role) => `Role "${role}" requires authoredWith { task, revision }.`,
  AUTHORING_ATTESTATION_WRONG_TASK: (role) => `The authoredWith task is not the author task of role "${role}".`,
  AUTHORING_ATTESTATION_STALE: (role) => `The authoredWith revision is not the current revision of role "${role}"'s author task.`,
  AUTHOR_TASK_BROKEN: (role) => `The author task of role "${role}" is unavailable, so this write is refused until a manager of the memory repairs the rule.`,
};

/**
 * The typed refusal. `code` and the governed `role` only: the task, its current
 * revision and the remedy are #1329's, under the access-safe disclosure rules.
 */
export class AuthoringAttestationError extends GraphQLError {
  constructor(public readonly code: AttestationRefusalCode, public readonly role: string) {
    super(REFUSAL_TEXT[code](role), { extensions: { code, role } });
    this.name = 'AuthoringAttestationError';
  }
}

/** The ordinary path: the writer's claim, or none. */
export function attestedAuthoring(authoredWith?: AuthoredWith | null): AuthoringContext {
  return { kind: 'attested', authoredWith: authoredWith ?? null };
}

/**
 * The authoring context of a direct write request. `trustedHuman` is reachable
 * only through `portalHumanUserId`, which the /graphql Apollo context derives
 * from the sign-in credential (`middleware/auth.ts`). No input reaches it, and
 * it must match the request's own user. Import, runner and MCP callers use
 * {@link attestedAuthoring} and never see it.
 */
export function authoringFromRequest(
  ctx: { userId?: string | null; portalHumanUserId?: string },
  authoredWith?: AuthoredWith | null,
): AuthoringContext {
  if (ctx.portalHumanUserId && ctx.portalHumanUserId === ctx.userId) {
    return { kind: 'trustedHuman', authenticatedUserId: ctx.portalHumanUserId };
  }
  return attestedAuthoring(authoredWith);
}

export interface AuthoredWrite {
  priorRole: string | null | undefined;
  priorRunnable: boolean | null | undefined;
  role: string | null | undefined;
  runnable: boolean | null | undefined;
  /** Whether the write changes authored state: a create, or an edit by `authoredContentChanged`. */
  authoredChange: boolean;
}

export type AuthoringVerdict =
  | { refused: AttestationRefusalCode; role: string }
  | { refused?: undefined; stamp: NodeAuthorshipStamp | null };

const NO_STAMP: AuthoringVerdict = { stamp: null };

/** The rules the write answers to: each key of the state before and after, most-specific lookup. */
function requiredRules(write: AuthoredWrite, rules: readonly NodeRoleRule[]): Array<{ key: string; rule: NodeRoleRule }> {
  const keys = [...new Set([...ruleKeysOf(write.role, write.runnable), ...ruleKeysOf(write.priorRole, write.priorRunnable)])];
  const required: Array<{ key: string; rule: NodeRoleRule }> = [];
  for (const key of keys) {
    const resolution = resolveNodeRoleRule(key, rules);
    if (resolution.kind !== 'RULE') continue;
    // H5: the marker outlives the SetNull on the task's foreign key, so a
    // deleted task reads as broken rather than as a rule that requires nothing.
    if (resolution.rule.authorTaskRequired || resolution.rule.authorTaskId) required.push({ key, rule: resolution.rule });
  }
  return required;
}

/**
 * Judge an authoring write, answered rather than thrown: git sync skips a
 * refused file and keeps going (#1330). Call inside the write transaction,
 * after the node row is locked and before the first write.
 *
 * Order of refusals: a broken task first, whatever the writer sent (H5), then
 * missing, wrong task, stale. A role change answers to both sides, so clearing
 * or changing a role cannot shed its requirement, and a change across two
 * different required tasks cannot be met by one claim (WRONG_TASK): split it.
 * With no applicable rule a claim is ignored and nothing is stamped.
 */
export async function judgeAuthoring(
  tx: Prisma.TransactionClient,
  memoryId: string,
  write: AuthoredWrite,
  authoring: AuthoringContext,
): Promise<AuthoringVerdict> {
  if (authoring.kind !== 'attested' || !write.authoredChange) return NO_STAMP;
  if (ruleKeysOf(write.role, write.runnable).length === 0 && ruleKeysOf(write.priorRole, write.priorRunnable).length === 0) {
    return NO_STAMP;
  }
  await lockMemoryConfigShared(tx, memoryId);
  const config = await tx.memoryConfig.findUnique({ where: { memoryId }, include: { rules: true } });
  const required = requiredRules(write, config?.rules ?? []);
  if (required.length === 0) return NO_STAMP;

  const taskIds = [...new Set(required.flatMap(({ rule }) => (rule.authorTaskId ? [rule.authorTaskId] : [])))];
  const tasks = await tx.node.findMany({
    where: { id: { in: taskIds } },
    select: { id: true, loc: true, revSeq: true, isRunnable: true, deletedAt: true, memory: { select: { urn: true, deletedAt: true } } },
  });
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const { key, rule } of required) {
    const task = rule.authorTaskId ? byId.get(rule.authorTaskId) : undefined;
    if (!task || task.deletedAt || task.memory.deletedAt || task.isRunnable !== true) {
      return { refused: 'AUTHOR_TASK_BROKEN', role: key };
    }
  }

  const claim = authoring.authoredWith;
  if (!claim) return { refused: 'AUTHORING_ATTESTATION_MISSING', role: required[0]!.key };
  for (const { key, rule } of required) {
    const task = byId.get(rule.authorTaskId!)!;
    if (claim.task !== task.id && claim.task !== safeNodeUrnV2(task.memory.urn, task.loc)) {
      return { refused: 'AUTHORING_ATTESTATION_WRONG_TASK', role: key };
    }
    if (claim.revision !== task.revSeq) return { refused: 'AUTHORING_ATTESTATION_STALE', role: key };
  }
  const task = byId.get(required[0]!.rule.authorTaskId!)!;
  return {
    stamp: {
      authorshipKind: 'TASK',
      authoredByTask: task.id,
      authoredByRevision: task.revSeq,
      authoredByHuman: null,
      authoredAt: new Date(),
    },
  };
}

/** {@link judgeAuthoring} for a writer that stops on a refusal. Returns the stamp to write, or null. */
export async function assertAuthoring(
  tx: Prisma.TransactionClient,
  memoryId: string,
  write: AuthoredWrite,
  authoring: AuthoringContext,
): Promise<NodeAuthorshipStamp | null> {
  const verdict = await judgeAuthoring(tx, memoryId, write, authoring);
  if (verdict.refused) throw new AuthoringAttestationError(verdict.refused, verdict.role);
  return verdict.stamp;
}

/**
 * A rename during a move: it answers to the rules it leaves as well as the rules
 * it lands under, as a role change answers to both roles, so a move cannot shed a
 * requirement during an authored change. One claim must meet both (WRONG_TASK
 * otherwise: split it). The stamp is the destination's, where the node now lives.
 * A plain move changes nothing authored and does not come here.
 */
export async function assertRenameAuthoring(
  tx: Prisma.TransactionClient,
  sourceMemoryId: string,
  destMemoryId: string,
  write: AuthoredWrite,
  authoring: AuthoringContext,
): Promise<NodeAuthorshipStamp | null> {
  if (sourceMemoryId !== destMemoryId) await assertAuthoring(tx, sourceMemoryId, write, authoring);
  return assertAuthoring(tx, destMemoryId, write, authoring);
}

/** The MCP text for an attestation refusal (`[authoring_attestation_missing] …`), or null for any other error. */
export function attestationRefusalText(e: unknown): string | null {
  if (e instanceof AuthoringAttestationError) return `[${e.code.toLowerCase()}] ${e.message}`;
  return null;
}

/**
 * Parse a mirrored `authoredWith: <task>@<revision>` value. Never throws: the
 * loader drops a file that throws and repo-wins cleanup would then delete its
 * row (`findings:git-sync-attestation-must-fail-in-transaction`). A malformed
 * value is no claim, which the gate refuses in the sync transaction.
 */
export function parseMirroredAuthoredWith(value: unknown): AuthoredWith | null {
  if (typeof value !== 'string') return null;
  const at = value.lastIndexOf('@');
  if (at <= 0) return null;
  const revision = value.slice(at + 1);
  if (!/^[1-9][0-9]*$/.test(revision)) return null;
  return { task: value.slice(0, at), revision: Number(revision) };
}

/** The mirrored form of a verified TASK stamp. A HUMAN stamp has none: it is not a claim anyone may repeat. */
export function mirroredAuthoredWith(node: {
  authorshipKind?: string | null;
  authoredByTask?: string | null;
  authoredByRevision?: number | null;
}): string | undefined {
  if (node.authorshipKind !== 'TASK' || !node.authoredByTask || node.authoredByRevision == null) return undefined;
  return `${node.authoredByTask}@${node.authoredByRevision}`;
}
