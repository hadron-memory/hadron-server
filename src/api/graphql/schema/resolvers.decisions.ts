/**
 * #1641 S1 — the decision doors and reads (plan of record:
 * `hrn:node:hadronmemory.com:hadron-server:design:decision-nodes`, r4; §n
 * below are its sections; spec placement `cor:dmo:140`, not yet authored).
 *
 * The ONLY way a decision or a decision log is written. Each state change is
 * its own operation (§7) — there is no generic create/update pair — and every
 * one re-renders the decision's `content` from its structured payload, so the
 * approval hash covers exactly what a decider sees (§5.2).
 *
 * S1 ships: createDecisionLog, setDecisionLogDeciders, askDecision,
 * amendDecision, withdrawDecision, purgeUnansweredDecision, and the reads
 * decisionLog / decision / decisions (incl. awaitingMe) / verifyDecision.
 * Answering, superseding and decider approval are S2; the signed tier is S3
 * (#1614 S2b), so an authorizing decision can be asked but never DECIDED yet
 * (Q11).
 *
 * Gates (§6.1): a log is created and its deciders changed by memory MANAGE
 * or an owner-role member of the memory's App (Holger, team chat #7790);
 * a decision is asked and amended (before an answer) by memory WRITERS,
 * agents included; after an answer only a decider amends; withdrawal is the
 * asker's or a decider's; purge is a platform admin's, of a never-answered
 * decision only. Reads use the log memory's read gate. Every write re-runs
 * its gate under the memory's authority anchors (`withAuthorizedMemoryTx`).
 *
 * Lock order (§7): authority anchors → the log row (ask, purge, deciders) →
 * the decision row. Never a log lock taken while a decision row is held.
 */
import { createHash } from 'crypto';
import { GraphQLError } from 'graphql';
import type { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import {
  concealUnreadableDenial,
  getAccessibleMemoryIds,
  isAuthorizationDenial,
  isMemoryReadableCached,
  isMemoryReadableFresh,
  isPlatformAdmin,
  requireMemoryManageAccess,
  requireMemoryWriteAccess,
} from './resolvers.helpers.js';
import { resolveNodeRefForCaller } from './resolvers.nodeRefAccess.js';
import { resolveNodeUrnField } from './resolvers.types.js';
import { withAuthorizedMemoryTx } from './authorizedTx.js';
import { identitiesOf, mergeLinksFrom, survivorsOf } from '../../../lib/userMerges.js';
import { writeNodeCore } from './resolvers.mutation.node.js';
import { loadCommentActor, type CommentActorRef } from './resolvers.comments.js';
import { NodeNotFoundError } from '../../../lib/entityRef/errors.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { portalUrlForUrn } from '../../../lib/portalUrl.js';
import { currentActor } from '../../../lib/requestActor.js';
import { validateLoc, InvalidLocError } from '../../../lib/validateLoc.js';
import { acquireLockSet, ancestorLocs } from '../../../lib/nodeSubtreeLock.js';
import { lockEdgeEndpointMemories } from '../../../lib/edgeEndpointLock.js';
import { deletePendingEdgesTargetingNodes } from '../../../lib/pendingEdgePromotion.js';
import { hardDeleteThreadsOfTargets } from '../../../lib/comments/lifecycle.js';
import { NODE_APPROVAL_ROW_SELECT, approvalRecordOf, loadApprovedSnapshots } from '../../../lib/nodeApproval.js';
import { ensureCurrentNodeRevisionInTransaction, revisionStateHashRefreshMarker } from '../../../lib/nodeRevisionSnapshot.js';
import {
  DECISION_FAMILY_WHERE,
  DECISION_LOG_ROLE,
  DECISION_ROLE,
  decisionContainedError,
  decisionError,
} from '../../../lib/decisions/index.js';
import {
  DECISION_CODEC,
  DECISION_LOG_CODEC,
  MAX_DECIDERS,
  MAX_PARTS,
  amendInputSchema,
  askInputSchema,
  checkPart,
  decisionDataSchema,
  decisionLogDataSchema,
  invalidDecision,
  optionsOf,
  parseOrRefuse,
  type DecisionActor,
  type DecisionAnswer,
  type DecisionData,
  type DecisionLogData,
  type DecisionPart,
  type DecisionPartInput,
  type DecisionRef,
} from '../../../lib/decisions/codec.js';
import {
  CURRENT_DECISION_RENDERER,
  canonicalDecisionJson,
  decisionName,
  renderDecision,
  renderDecisionAbstract,
  renderDecisionLog,
} from '../../../lib/decisions/render.js';
import { evaluateDecision, type DecisionEvaluation, type DecisionNodeRow, type DecisionState } from '../../../lib/decisions/evaluate.js';
import { DEFAULT_DECISION_PREFIX, DECISION_PREFIX_RE, decisionCode, decisionLoc, parseDecisionCitation } from '../../../lib/decisions/codes.js';

type Tx = Prisma.TransactionClient;

/** A list above this many decisions refuses rather than paging on unevaluated hints (§5.5). */
export const DECISION_LIST_EVALUATION_CAP = 5_000;

/** Reasons ride in `NodeRevision.revLabel`, so they share its cap. */
const REASON_MAX = 500;

// ─── Rows ────────────────────────────────────────────────────────────────────

const DECISION_ROW_SELECT = {
  ...NODE_APPROVAL_ROW_SELECT,
  data: true,
  role: true,
  seq: true,
  deletedAt: true,
} as const satisfies Prisma.NodeSelect;

type DecisionRow = Prisma.NodeGetPayload<{ select: typeof DECISION_ROW_SELECT }>;

const LOG_ROW_SELECT = {
  id: true, memoryId: true, loc: true, name: true, role: true, data: true, revSeq: true, deletedAt: true,
} as const satisfies Prisma.NodeSelect;

type LogRow = Prisma.NodeGetPayload<{ select: typeof LOG_ROW_SELECT }>;

/** The evaluated decision a `Decision` field resolver reads. */
export interface DecisionView {
  row: DecisionRow;
  evaluation: DecisionEvaluation;
  /** What the card shows: the authenticated block, else the cache, else nothing (TAMPERED / UNVERIFIABLE). */
  shown: DecisionData | null;
}

/** The log a `DecisionLog` field resolver reads. */
export interface DecisionLogView {
  row: LogRow;
  data: DecisionLogData;
}

// ─── Principals and gates ────────────────────────────────────────────────────

/** The authenticated actor of this request, server-taken (§7 provenance). */
function actorOf(ctx: Context): DecisionActor {
  return { userId: ctx.userId ?? null, workerId: currentActor().workerId, appId: ctx.appId ?? null };
}

/** Decisions are never written under impersonation (a support session is read-only for them). */
function refuseImpersonation(ctx: Context): void {
  if (ctx.impersonation) {
    throw decisionError('DECISION_IMPERSONATION_REFUSED', 'Decisions cannot be written under impersonation.');
  }
}

/**
 * #1715 — every stored id that now means the caller: their own, plus every
 * account merged into theirs (`user_merges`, transitively). Stored ids are
 * never rewritten by a merge, so each "is the caller named here?" gate asks it
 * of this set. Read on `ctx.db`, which is the transaction's client for a gate
 * re-checked inside one; memoized per request (a txCtx drops the memo).
 */
function callerIdentities(ctx: Context): Promise<Set<string>> {
  if (!ctx.userId) return Promise.resolve(new Set());
  return (ctx.mergedIdentityCache ??= identitiesOf(ctx.db, ctx.userId));
}

/** #1715 — the account each id now is, for a NEW write that names users (stored records are never rewritten). */
const survivors = (db: Tx | Context['db'], ids: readonly string[]) => survivorsOf(db, ids);

/** §6.1 — the caller is one of the decision's deciders: a user principal, never an App key or impersonation. */
async function isDecider(ctx: Context, d: Pick<DecisionData, 'deciders'>): Promise<boolean> {
  if (ctx.impersonation || !ctx.userId) return false;
  const ids = await callerIdentities(ctx);
  return d.deciders.some((id) => ids.has(id));
}

/**
 * Whether the caller asked the decision: the same worker, the same user, or the same bare App key.
 * The worker arm needs a person behind the request (Rook's P3-3 on #1690, the #1713 interim): a
 * pure App key may bind any session of its App, so its worker id alone proves nothing.
 */
async function isAsker(ctx: Context, d: Pick<DecisionData, 'askedBy'>): Promise<boolean> {
  const actor = actorOf(ctx);
  if (ctx.userId && d.askedBy.workerId && d.askedBy.workerId === actor.workerId) return true;
  if (d.askedBy.userId && ctx.userId && (await callerIdentities(ctx)).has(d.askedBy.userId)) return true;
  return !d.askedBy.userId && !ctx.userId && !!d.askedBy.appId && d.askedBy.appId === ctx.appId;
}

/** Whether any part was ever answered (an answer now, or one in its history). */
function everAnswered(d: DecisionData): boolean {
  return d.parts.some((p) => p.answer != null || p.answerHistory.length > 0);
}

function validateReason(reason: string): string {
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > REASON_MAX) {
    invalidDecision([{ pointer: '/reason', message: `a reason is required, at most ${REASON_MAX} characters` }]);
  }
  return reason;
}

/** The write gate, typed (§6.1: memory writers, agents included). */
async function requireDecisionWrite(ctx: Context, memoryId: string): Promise<void> {
  try {
    await requireMemoryWriteAccess(ctx, memoryId);
  } catch (error) {
    if (isAuthorizationDenial(error)) {
      throw decisionError('DECISION_FORBIDDEN', 'Asking or changing a decision needs write access to its memory.');
    }
    throw error;
  }
}

/** Is the caller an `owner`-role member of the live, installed App this memory belongs to? */
async function isOwnerRoleAppMember(
  ctx: Context,
  memory: { class: string; appId: string | null },
): Promise<boolean> {
  if (memory.class === 'personal' || memory.class === 'private') return false;
  if (!memory.appId || !ctx.userId || ctx.impersonation) return false;
  const member = await ctx.db.appMember.findFirst({
    where: { appId: memory.appId, userId: ctx.userId, role: 'owner', app: { deletedAt: null, uninstalledAt: null } },
    select: { userId: true },
  });
  return member !== null;
}

/**
 * The log transactions' `afterLock`: hold the caller's membership row in the
 * memory's App, and the App row, FOR SHARE before the in-transaction gate
 * re-check (#1690 review: Rook P3-1, Chip's QA P2). Without it an owner-role
 * member demoted (`ensureAppMember`) or an App uninstalled while this write
 * waits on its locks commits first, and the log is written under authority
 * already revoked. Same shape as the task gate's (`inTaskWriteTx`). A caller
 * with no such row locks nothing, and the gate decides on its other arms.
 */
function holdAppOwnerRow(ctx: Context, memoryId: string) {
  return async (tx: Tx): Promise<void> => {
    if (!ctx.userId) return;
    await tx.$queryRaw`
      SELECT 1 FROM app_members m
      JOIN memories mem ON mem.app_id = m.app_id
      JOIN apps a ON a.id = m.app_id
      WHERE mem.id = ${memoryId} AND m.user_id = ${ctx.userId}
      FOR SHARE OF m, a`;
  };
}

/**
 * The log gate, typed (§6.1): memory MANAGE, which admits platform admins, or
 * an `owner`-role member of the App the memory belongs to. The second arm is
 * Holger's ruling replacing the strict one (team chat #7790, Ada #7821): an
 * owner-role AppMember has the same rights as `App.ownerUserId`, so whoever
 * manages the App sets who decides in its memories (cor:acl:010:01).
 * Identity-scoped, so never under impersonation, and never for a personal or
 * private memory (cor:acl:010:02). With `concealRef`, a caller who cannot even
 * open the memory's record is answered as if it did not exist (#1316) —
 * decided on the raw denial, before it is typed.
 */
async function requireLogManage(ctx: Context, memoryId: string, concealRef?: string): Promise<void> {
  const memory = await ctx.db.memory.findUniqueOrThrow({
    where: { id: memoryId },
    select: { class: true, userId: true, organizationId: true, ownerUserId: true, appId: true },
  });
  const gate = async () => {
    if (await isOwnerRoleAppMember(ctx, memory)) return;
    await requireMemoryManageAccess(ctx, memory);
  };
  try {
    if (concealRef === undefined) await gate();
    else await concealUnreadableDenial(ctx, memoryId, concealRef, gate);
  } catch (error) {
    if (isAuthorizationDenial(error)) {
      throw decisionError('DECISION_FORBIDDEN', "Creating a decision log or changing its deciders needs management rights on the memory.");
    }
    throw error;
  }
}

const decisionMissing = (ref: string) => decisionError('DECISION_NOT_FOUND', `Decision not found: "${ref}"`, { ref });
const logMissing = (ref: string) => decisionError('DECISION_LOG_NOT_FOUND', `Decision log not found: "${ref}"`, { ref });

/** Resolve a ref to a live, readable node of `role`, or the typed miss (no existence oracle). */
async function resolveGovernedNode(
  ctx: Context,
  ref: string,
  role: string,
  missing: (ref: string) => GraphQLError,
): Promise<{ id: string; memoryId: string; loc: string }> {
  let id: string;
  try {
    ({ id } = await resolveNodeRefForCaller(ctx, ref));
  } catch (error) {
    if (error instanceof NodeNotFoundError) throw missing(ref);
    throw error;
  }
  const node = await ctx.db.node.findUnique({ where: { id }, select: { id: true, memoryId: true, loc: true, role: true, deletedAt: true } });
  if (!node || node.deletedAt || node.role !== role || !(await isMemoryReadableCached(ctx, node.memoryId))) throw missing(ref);
  return node;
}

/**
 * §6.1a — each named decider is a live user who can read the log's memory
 * now. Evaluated as that user (no platform-admin bypass rides along), on the
 * transaction's client.
 */
async function assertDecidersEligible(tx: Tx, memoryId: string, userIds: readonly string[]): Promise<void> {
  for (const userId of userIds) {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { deletedAt: true } });
    const readable = user && !user.deletedAt &&
      await isMemoryReadableFresh({ db: tx, userId, roles: [] } as unknown as Context, memoryId, tx);
    if (!readable) {
      throw decisionError(
        'DECISION_DECIDER_NOT_ELIGIBLE',
        `User ${userId} cannot be a decider here: a decider is a user who can read the decision log's memory.`,
        { userId },
      );
    }
  }
}

function uniqueIds(ids: readonly string[], pointer: string): string[] {
  const out = [...new Set(ids)];
  if (out.length !== ids.length) invalidDecision([{ pointer, message: 'a user is listed twice' }]);
  if (out.length > MAX_DECIDERS) invalidDecision([{ pointer, message: `at most ${MAX_DECIDERS} users` }]);
  return out;
}

// ─── Log helpers ─────────────────────────────────────────────────────────────

function parseLogData(row: LogRow): DecisionLogData {
  const parsed = decisionLogDataSchema.safeParse(row.data);
  // A log is written only by its doors; an unparseable one is a server fault, loudly.
  if (!parsed.success) throw new Error(`decision log ${row.id} has an invalid payload`);
  return parsed.data;
}

/**
 * Lock the log row (`FOR NO KEY UPDATE`, the allocator lock) and re-read it
 * live, in `memoryId`. With `expectedRevision` (a door that revises the log),
 * the token is checked first and drift reconciled after, as for a decision
 * ({@link lockDecision}).
 */
async function lockLog(tx: Tx, logId: string, memoryId: string, ref: string, expectedRevision?: number): Promise<{ row: LogRow; data: DecisionLogData }> {
  await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${logId} FOR NO KEY UPDATE`;
  const seen = await tx.node.findUnique({ where: { id: logId }, select: LOG_ROW_SELECT });
  if (!seen || seen.deletedAt || seen.memoryId !== memoryId || seen.role !== DECISION_LOG_ROLE) throw logMissing(ref);
  if (expectedRevision !== undefined) requireRevision(seen, expectedRevision);
  // Every path, not only the OCC one (Rook's P3-2 on #1690): the counter write
  // that follows asks for a fingerprint refresh, which would otherwise absorb
  // any earlier unrevisioned change to the log, defaultDeciders included,
  // with no revision recording it (Q6).
  await ensureCurrentNodeRevisionInTransaction(tx, logId, { expectedMemoryId: memoryId });
  const row = await tx.node.findUniqueOrThrow({ where: { id: logId }, select: LOG_ROW_SELECT });
  return { row, data: parseLogData(row) };
}

/** The log a decision belongs to: its parent loc. */
async function logOfDecision(db: Pick<Tx, 'node'>, decision: { memoryId: string; loc: string }): Promise<LogRow | null> {
  const cut = decision.loc.lastIndexOf(':');
  if (cut <= 0) return null;
  const row = await db.node.findUnique({
    where: { loc_memoryId: { loc: decision.loc.slice(0, cut), memoryId: decision.memoryId } },
    select: LOG_ROW_SELECT,
  });
  return row && row.role === DECISION_LOG_ROLE ? row : null;
}

function logContentOf(name: string, data: DecisionLogData) {
  return {
    content: renderDecisionLog(name, data),
    abstract: `Decision log: codes ${data.prefix}A, ${data.prefix}B, … issued in sequence, never reused.`,
    data: data as unknown as Record<string, unknown>,
    properties: { prefix: data.prefix } as Record<string, unknown>,
  };
}

// ─── Decision helpers ────────────────────────────────────────────────────────

/**
 * Lock the decision row, check the caller's OCC token against the revision
 * they read, then reconcile any unrevisioned drift as its own revision
 * (#1323) and re-read. The door's write then guards on the reconciled
 * revision: left to `writeNodeCore`, the reconcile would move `revSeq` past
 * its compare-and-swap and roll back with the refusal, so a decision with
 * harmless drift could never be changed again. Drift that alters what the
 * decision renders evaluates TAMPERED and is refused by the caller.
 */
async function lockDecision(tx: Tx, id: string, memoryId: string, ref: string, expectedRevision?: number): Promise<DecisionRow> {
  await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${id} FOR UPDATE`;
  const seen = await tx.node.findUnique({ where: { id }, select: { memoryId: true, role: true, deletedAt: true, revSeq: true } });
  if (!seen || seen.deletedAt || seen.memoryId !== memoryId || seen.role !== DECISION_ROLE) throw decisionMissing(ref);
  if (expectedRevision !== undefined) requireRevision(seen, expectedRevision);
  await ensureCurrentNodeRevisionInTransaction(tx, id, { expectedMemoryId: memoryId });
  return tx.node.findUniqueOrThrow({ where: { id }, select: DECISION_ROW_SELECT });
}

function requireRevision(row: { revSeq: number }, expectedRevision: number): void {
  if (row.revSeq !== expectedRevision) {
    throw new GraphQLError(
      `NODE_WRITE_CONFLICT: the decision is at revision ${row.revSeq}, not ${expectedRevision}. Reload and retry.`,
      { extensions: { code: 'NODE_WRITE_CONFLICT', currentRevision: row.revSeq } },
    );
  }
}

async function evaluateRows(db: Pick<Tx, 'nodeRevision'>, rows: DecisionRow[]): Promise<DecisionView[]> {
  // Decision logs never live in encrypted memories (§5.4), so every field is plaintext.
  const snapshots = await loadApprovedSnapshots(db as Tx, rows);
  // #1715: each approver's merge-aware identities, once per distinct approver.
  const approvers = [...new Set(rows.map((r) => r.approvedBy).filter((id): id is string => id != null))];
  const identities = new Map(await Promise.all(approvers.map(async (id) => [id, await identitiesOf(db as Tx, id)] as const)));
  return rows.map((row) => {
    const snaps = snapshots.get(row.id);
    const evaluation = evaluateDecision(
      row as DecisionNodeRow,
      snaps ? snaps.map((snap) => ({ title: snap.name, abstract: snap.abstract, content: snap.content })) : null,
      row.approvedBy ? identities.get(row.approvedBy) : undefined,
    );
    const cached = evaluation.decision ? null : decisionDataSchema.safeParse(row.data);
    return { row, evaluation, shown: evaluation.decision ?? (cached?.success ? cached.data : null) };
  });
}

/**
 * Refuse a door write on a decision whose state forbids it: corrupt evidence
 * first (§5.5 precedence), then the terminal states.
 */
function requireWritable(view: DecisionView): DecisionData {
  const { state, decision } = view.evaluation;
  if (state === 'TAMPERED' || state === 'UNVERIFIABLE' || !decision) {
    throw decisionError(
      'DECISION_INVALID',
      `This decision is ${state} and cannot be changed through the decision operations; run verifyDecision for the findings.`,
      { state },
    );
  }
  if (state === 'WITHDRAWN') throw decisionError('DECISION_WITHDRAWN', `${decision.code} was withdrawn.`, { decisionCode: decision.code });
  if (state === 'SUPERSEDED') throw decisionError('DECISION_SUPERSEDED', `${decision.code} was superseded.`, { decisionCode: decision.code });
  return decision;
}

/** The derived, never-authoritative property projection for filters (§5.3). */
function propertiesOf(d: DecisionData): Record<string, unknown> {
  const answeredAt = d.parts.map((p) => p.answer?.at).filter((a): a is string => !!a).sort().pop() ?? null;
  return {
    code: d.code, n: d.n, status: d.status, tier: d.tier, authorizes: d.authorizes, urgency: d.urgency,
    askedAt: d.askedAt, answeredAt, deciders: d.deciders,
  };
}

/** The card hint (§6.3): never read by a relying consumer. */
function statusHint(d: DecisionData): DecisionData['status'] {
  if (d.withdrawn) return 'withdrawn';
  if (d.supersededBy) return 'superseded';
  return d.parts.every((p) => p.answer != null) ? 'answered' : 'open';
}

/** Every rendered field of a decision node, from its payload (§5.2). */
function renderedFields(d: DecisionData) {
  return {
    name: decisionName(d),
    abstract: renderDecisionAbstract(d),
    content: renderDecision(d),
    data: d as unknown as Record<string, unknown>,
    properties: propertiesOf(d),
  };
}

function buildPart(input: DecisionPartInput, n: number, actor: DecisionActor, pointer: string): DecisionPart {
  if (input.recommendation && input.noRecommendation) {
    invalidDecision([{ pointer, message: 'give either a recommendation or noRecommendation, not both' }]);
  }
  const part: DecisionPart = {
    n,
    question: input.question,
    options: optionsOf(input, pointer) ?? [],
    recommendation: input.recommendation
      ? { key: input.recommendation.key, by: actor, reason: input.recommendation.reason ?? null, attributedTo: input.recommendation.attributedTo ?? null }
      : null,
    noRecommendation: input.noRecommendation ?? null,
    answer: null,
    answerHistory: [],
  };
  checkPart(part, pointer);
  return part;
}

/** Re-validate a payload a door built, so a door bug fails loudly rather than persisting. */
function finalize(d: DecisionData): DecisionData {
  const parsed = decisionDataSchema.parse(d);
  parsed.parts.forEach((p, i) => checkPart(p, `/parts/${i}`));
  return parsed;
}

/** Highest decision number ever issued under the log: the counter, or a decision child above it. */
async function highWaterN(tx: Tx, log: LogRow, data: DecisionLogData): Promise<number> {
  const top = await tx.node.findFirst({
    where: { memoryId: log.memoryId, loc: { startsWith: `${log.loc}:` }, role: DECISION_ROLE },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });
  return Math.max(data.lastCode, top?.seq ?? 0, ...data.purges.map((p) => p.n));
}

/** GraphQL enum values (`URGENT`, `SIGNED`) to the codec's (`urgent`, `signed`), on an input's top level. */
function lowerEnums(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const key of ['urgency', 'tier'] as const) {
    if (typeof out[key] === 'string') out[key] = (out[key] as string).toLowerCase();
  }
  return out;
}

function toTier(v: string | null | undefined): 'approved' | 'signed' | null {
  return v == null ? null : v === 'SIGNED' || v === 'signed' ? 'signed' : 'approved';
}
function toUrgency(v: string | null | undefined): 'normal' | 'urgent' | null {
  return v == null ? null : v === 'URGENT' || v === 'urgent' ? 'urgent' : 'normal';
}

// ─── Doors ───────────────────────────────────────────────────────────────────

type AskArgs = { logRef: string; input: Record<string, unknown> };

export const decisionMutations = {
  /**
   * §3.3, §7 — create a decision log: memory MANAGE or an App owner (`requireLogManage`); refused in an encrypted
   * (Q5) or git-mirrored memory, at a loc that holds anything, or inside a
   * decision's or log's subtree.
   */
  createDecisionLog: async (
    _: unknown,
    args: { memoryRef: string; loc: string; name?: string | null; prefix?: string | null; defaultDeciders: string[]; eligibleDeciders?: string[] | null },
    ctx: Context,
  ): Promise<DecisionLogView> => {
    refuseImpersonation(ctx);
    const { id: memoryId } = await resolveMemoryRef(ctx.db, args.memoryRef);
    try {
      validateLoc(args.loc);
    } catch (error) {
      if (error instanceof InvalidLocError) throw new GraphQLError(error.message, { extensions: { code: error.name, loc: error.loc, segment: error.segment } });
      throw error;
    }
    const prefix = args.prefix ?? DEFAULT_DECISION_PREFIX;
    if (!DECISION_PREFIX_RE.test(prefix)) invalidDecision([{ pointer: '/prefix', message: 'a prefix is one to three upper-case letters' }]);
    const name = (args.name ?? '').trim() || 'Decisions';
    if (name.length > 300 || name.includes('\n')) invalidDecision([{ pointer: '/name', message: 'a single line of at most 300 characters' }]);
    const defaults = uniqueIds(args.defaultDeciders, '/defaultDeciders');
    if (defaults.length === 0) invalidDecision([{ pointer: '/defaultDeciders', message: 'name at least one decider' }]);
    const eligible = uniqueIds((args.eligibleDeciders ?? []).filter((u) => !defaults.includes(u)), '/eligibleDeciders');
    await requireLogManage(ctx, memoryId, args.memoryRef);

    const effects: Array<() => void> = [];
    const view = await withAuthorizedMemoryTx(ctx, memoryId, [], (txCtx) => requireLogManage(txCtx, memoryId), async (tx, txCtx) => {
      // Under the memory's FOR SHARE anchor, which a mirror attach and an
      // encryption (each FOR UPDATE on this row) wait on, so neither can land
      // between this read and the commit (§3.2, §5.4).
      const memory = await tx.memory.findUniqueOrThrow({
        where: { id: memoryId },
        select: { isEncrypted: true, source: true, class: true, userId: true, userMemoryOfAgentId: true },
      });
      // Rook's §10 P2 on #1690: an agent's definition memory is not a
      // decision home (§3.4 uses personal and App memories), and
      // restoreRevision rewrites a system memory wholesale: it would
      // resurrect a withdrawn decision as OPEN and erase later ones.
      if (memory.class === 'system') throw decisionError('DECISION_LOG_SYSTEM_MEMORY', 'A decision log cannot live in a system memory (an agent\'s definition, which a snapshot restore rewrites).', { memoryId });
      // Rook's P3-1: an anonymous per-user memory is encrypted wholesale on
      // its promotion (linkMemoryToUser), a path outside the §5.4 pairing.
      if (memory.userMemoryOfAgentId && !memory.userId) throw decisionError('DECISION_LOG_ANONYMOUS_MEMORY', 'A decision log cannot live in an anonymous memory (its promotion may encrypt every node).', { memoryId });
      if (memory.isEncrypted) throw decisionError('DECISION_LOG_ENCRYPTED', 'A decision log cannot live in an encrypted memory (a decision is verified by re-rendering its plaintext).', { memoryId });
      if (memory.source) throw decisionError('DECISION_LOG_MIRRORED', 'A decision log cannot live in a git-mirrored memory (a mirror could forge decisions).', { memoryId });
      await lockEdgeEndpointMemories(tx, [memoryId]);
      await acquireLockSet(tx, [...ancestorLocs(args.loc).map((loc) => ({ memoryId, loc })), { memoryId, loc: args.loc }]);
      const occupied = await tx.node.findFirst({
        where: { memoryId, OR: [{ loc: args.loc }, { loc: { startsWith: `${args.loc}:` } }] },
        select: { loc: true },
      });
      if (occupied) {
        throw decisionError('DECISION_LOG_EXISTS', `"${args.loc}" already holds a node (or a deleted one) at or under it; a decision log needs an empty loc.`, { loc: occupied.loc });
      }
      const ancestors = ancestorLocs(args.loc);
      const container = ancestors.length === 0 ? null : await tx.node.findFirst({
        where: { memoryId, loc: { in: ancestors }, ...DECISION_FAMILY_WHERE }, select: { loc: true },
      });
      if (container) throw decisionContainedError('Creating a decision log here', [container.loc]);
      // #1715: name who each decider is now, never a merged-away account.
      const nowDefaults = await survivors(tx, defaults);
      const nowEligible = (await survivors(tx, eligible)).filter((u) => !nowDefaults.includes(u));
      await assertDecidersEligible(tx, memoryId, [...nowDefaults, ...nowEligible]);

      const data: DecisionLogData = decisionLogDataSchema.parse({
        codec: DECISION_LOG_CODEC, kind: 'decision.log', prefix, lastCode: 0,
        defaultDeciders: nowDefaults, eligibleDeciders: nowEligible, purges: [],
        lastAction: { op: 'create', by: actorOf(ctx), at: new Date().toISOString(), reason: null },
      });
      const node = await writeNodeCore(
        {
          memoryId, loc: args.loc, name, role: DECISION_LOG_ROLE, nodeType: 'info',
          ...logContentOf(name, data),
          description: null, contentType: null, alias: null, tags: [], llmModel: null, aiAgent: null,
          isLink: false, objectType: null, edges: [],
        },
        txCtx,
        'create',
        { ownsKind: 'decision', governedContext: 'node-write', transaction: { tx, pooledDb: ctx.db, afterCommit: (e) => effects.push(e) } },
      );
      const row = await tx.node.findUniqueOrThrow({ where: { id: (node as { id: string }).id }, select: LOG_ROW_SELECT });
      return { row, data };
    }, { fence: true, timeout: 60_000, afterLock: holdAppOwnerRow(ctx, memoryId) });
    for (const effect of effects) effect();
    return view;
  },

  /**
   * §6.1, Q6 — replace a log's default (and other eligible) deciders, as an
   * audited revision of the log. Existing decisions keep their frozen sets.
   */
  setDecisionLogDeciders: async (
    _: unknown,
    args: { logRef: string; defaultDeciders: string[]; eligibleDeciders?: string[] | null; expectedRevision: number; reason: string },
    ctx: Context,
  ): Promise<DecisionLogView> => {
    refuseImpersonation(ctx);
    const reason = validateReason(args.reason);
    const defaults = uniqueIds(args.defaultDeciders, '/defaultDeciders');
    if (defaults.length === 0) invalidDecision([{ pointer: '/defaultDeciders', message: 'name at least one decider' }]);
    const log = await resolveGovernedNode(ctx, args.logRef, DECISION_LOG_ROLE, logMissing);
    await requireLogManage(ctx, log.memoryId);
    const effects: Array<() => void> = [];
    const view = await withAuthorizedMemoryTx(ctx, log.memoryId, [], (txCtx) => requireLogManage(txCtx, log.memoryId), async (tx, txCtx) => {
      const { row, data: prior } = await lockLog(tx, log.id, log.memoryId, args.logRef, args.expectedRevision);
      const keepEligible = args.eligibleDeciders == null ? prior.eligibleDeciders : args.eligibleDeciders;
      const listed = uniqueIds(keepEligible.filter((u) => !defaults.includes(u)), '/eligibleDeciders');
      // #1715: a new revision names who each decider is now (a kept set may
      // still name a merged-away account).
      const nowDefaults = await survivors(tx, defaults);
      const eligible = (await survivors(tx, listed)).filter((u) => !nowDefaults.includes(u));
      await assertDecidersEligible(tx, log.memoryId, [...nowDefaults, ...eligible]);
      const data: DecisionLogData = decisionLogDataSchema.parse({
        ...prior,
        defaultDeciders: nowDefaults,
        eligibleDeciders: eligible,
        lastAction: { op: 'set-deciders', by: actorOf(ctx), at: new Date().toISOString(), reason },
      });
      await writeNodeCore(
        { memoryId: log.memoryId, loc: row.loc, ...logContentOf(row.name, data), reason },
        txCtx,
        'update',
        {
          targetNodeId: row.id, guardRevSeq: row.revSeq, ownsKind: 'decision', governedContext: 'node-write',
          transaction: { tx, pooledDb: ctx.db, afterCommit: (e) => effects.push(e) },
        },
      );
      return { row: await tx.node.findUniqueOrThrow({ where: { id: row.id }, select: LOG_ROW_SELECT }), data };
    }, { fence: true, timeout: 60_000, afterLock: holdAppOwnerRow(ctx, log.memoryId) });
    for (const effect of effects) effect();
    return view;
  },

  /**
   * §4, §7 — ask a decision: allocate the next code under the log lock, write
   * the payload and its rendering as revision 1. Memory writers, agents
   * included. `authorizes: true` forces the signed tier (§6.2).
   */
  askDecision: async (_: unknown, args: AskArgs, ctx: Context): Promise<DecisionView> => {
    refuseImpersonation(ctx);
    const input = parseOrRefuse(askInputSchema, lowerEnums(args.input));
    const log = await resolveGovernedNode(ctx, args.logRef, DECISION_LOG_ROLE, logMissing);
    await requireDecisionWrite(ctx, log.memoryId);
    const authorizes = input.authorizes ?? false;
    const tier = input.tier ?? (authorizes ? 'signed' : 'approved');
    if (authorizes && tier !== 'signed') {
      throw decisionError('DECISION_TIER_TOO_LOW', 'A decision that authorizes something must be at the signed tier.', { tier });
    }
    if (!authorizes && input.grant != null) invalidDecision([{ pointer: '/grant', message: 'a grant needs authorizes: true' }]);
    const actor = actorOf(ctx);
    const parts = input.parts.map((p, i) => buildPart(p, i + 1, actor, `/parts/${i}`));

    const effects: Array<() => void> = [];
    const id = await withAuthorizedMemoryTx(ctx, log.memoryId, [], (txCtx) => requireDecisionWrite(txCtx, log.memoryId), async (tx, txCtx) => {
      const { row: logRow, data: logData } = await lockLog(tx, log.id, log.memoryId, args.logRef);
      // #1715: the log's sets may name merged-away accounts; compare, and
      // store, who each one is now. The log's own record is not rewritten.
      const eligibleSet = new Set(await survivors(tx, [...logData.defaultDeciders, ...logData.eligibleDeciders]));
      const deciders = await survivors(tx, input.deciders ? uniqueIds(input.deciders, '/deciders') : logData.defaultDeciders);
      const outside = deciders.filter((u) => !eligibleSet.has(u));
      if (outside.length > 0) {
        throw decisionError('DECISION_DECIDER_NOT_ELIGIBLE', `Deciders can be narrowed from the log's set, never widened: ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not eligible in this log.`, { userIds: outside });
      }
      await assertDecidersEligible(tx, log.memoryId, deciders);

      const n = (await highWaterN(tx, logRow, logData)) + 1;
      const code = decisionCode(logData.prefix, n);
      const loc = decisionLoc(logRow.loc, code);
      const squatter = await tx.node.findUnique({ where: { loc_memoryId: { loc, memoryId: log.memoryId } }, select: { id: true } });
      if (squatter) {
        // Unreachable through the guarded paths (a log's code space is closed
        // to every other writer); loud, so an operator can move the squatter.
        throw decisionError('DECISION_CONTAINED', `The next code ${code} is occupied by another node at "${loc}"; move it out of the log before asking.`, { loc });
      }
      const data = finalize({
        codec: DECISION_CODEC, renderer: CURRENT_DECISION_RENDERER, kind: 'decision',
        logId: logRow.id, code, n,
        title: input.title, urgency: input.urgency ?? 'normal', tier, authorizes,
        grant: (input.grant ?? null) as DecisionData['grant'], archival: false,
        deciders, askedBy: actor, askedAt: new Date().toISOString(),
        context: input.context ?? null,
        blocks: input.blocks ?? [], sources: input.sources ?? [], followUps: input.followUps ?? [],
        parts, status: 'open', withdrawn: null, supersedes: null, supersededBy: null,
      });
      const node = await writeNodeCore(
        {
          memoryId: log.memoryId, loc, role: DECISION_ROLE, nodeType: 'info', seq: n,
          ...renderedFields(data),
          description: null, contentType: null, alias: null, tags: [], llmModel: null, aiAgent: null,
          isLink: false, objectType: null, edges: [],
        },
        txCtx,
        'create',
        { ownsKind: 'decision', governedContext: 'node-write', transaction: { tx, pooledDb: ctx.db, afterCommit: (e) => effects.push(e) } },
      );
      // The counter, as chat roots keep theirs: a sanctioned direct write that
      // asks for a fingerprint refresh, so it is not reconciled as drift. The
      // rendered content carries the issued count, so it is re-rendered in the
      // same write (Diego's P3 on #1690): no revision, and never stale.
      const counted: DecisionLogData = { ...logData, lastCode: n };
      await tx.node.update({
        where: { id: logRow.id },
        data: {
          data: counted as unknown as Prisma.InputJsonValue,
          content: renderDecisionLog(logRow.name, counted),
          revisionContentHash: revisionStateHashRefreshMarker(),
        },
      });
      return (node as { id: string }).id;
    }, { fence: true, timeout: 60_000 });
    for (const effect of effects) effect();
    return loadDecisionView(ctx, id);
  },

  /**
   * §7 — amend a decision: question, options, recommendation, context and
   * references; add parts; raise the tier. Before any answer, any memory
   * writer; after one, a decider only (and the evidence goes stale). Urgency
   * is changed by a decider (Q14); the tier is lowered only by a decider,
   * before an answer, never for an authorizing decision (§6.2). Answers never
   * change here.
   */
  amendDecision: async (
    _: unknown,
    args: { ref: string; input: Record<string, unknown>; expectedRevision: number; reason: string },
    ctx: Context,
  ): Promise<DecisionView> => {
    refuseImpersonation(ctx);
    const reason = validateReason(args.reason);
    const patch = parseOrRefuse(amendInputSchema, lowerEnums(args.input));
    const target = await resolveGovernedNode(ctx, args.ref, DECISION_ROLE, decisionMissing);
    await requireDecisionWrite(ctx, target.memoryId);
    const actor = actorOf(ctx);
    const effects: Array<() => void> = [];
    await withAuthorizedMemoryTx(ctx, target.memoryId, [], (txCtx) => requireDecisionWrite(txCtx, target.memoryId), async (tx, txCtx) => {
      const row = await lockDecision(tx, target.id, target.memoryId, args.ref, args.expectedRevision);
      const [view] = await evaluateRows(tx, [row]);
      const current = requireWritable(view);
      const decider = await isDecider(txCtx, current);
      const answered = everAnswered(current);
      if (answered && !decider) {
        throw decisionError('DECISION_NOT_DECIDER', `${current.code} has an answer, so only one of its deciders may amend it.`, { decisionCode: current.code });
      }
      const next: DecisionData = structuredClone(current);
      if (patch.title != null) next.title = patch.title;
      if (patch.context !== undefined) next.context = patch.context ?? null;
      if (patch.blocks != null) next.blocks = patch.blocks;
      if (patch.sources != null) next.sources = patch.sources;
      if (patch.followUps != null) next.followUps = patch.followUps;
      if (patch.urgency != null && patch.urgency !== current.urgency) {
        if (!decider) throw decisionError('DECISION_NOT_DECIDER', 'Only a decider changes the urgency of an asked decision.', { decisionCode: current.code });
        next.urgency = patch.urgency;
      }
      if (patch.tier != null && patch.tier !== current.tier) {
        if (patch.tier === 'approved') {
          if (current.authorizes || answered) {
            throw decisionError('DECISION_TIER_TOO_LOW', current.authorizes
              ? 'A decision that authorizes something stays at the signed tier.'
              : 'The tier cannot be lowered once a part is answered.', { tier: patch.tier });
          }
          if (!decider) throw decisionError('DECISION_NOT_DECIDER', 'Only a decider lowers the tier.', { decisionCode: current.code });
        }
        next.tier = patch.tier;
      }
      for (const [i, pp] of (patch.parts ?? []).entries()) {
        const pointer = `/parts/${i}`;
        const part = next.parts.find((p) => p.n === pp.n);
        if (!part) {
          throw decisionError('DECISION_PART_RENUMBER', `${current.code} has no part ${pp.n}; parts keep their numbers and new ones are added with addParts.`, { part: pp.n });
        }
        if (pp.recommendation && pp.noRecommendation) invalidDecision([{ pointer, message: 'give either a recommendation or noRecommendation, not both' }]);
        if (pp.question != null) part.question = pp.question;
        const options = optionsOf({ options: pp.options, yesno: pp.yesno }, pointer);
        if (options) {
          const keys = new Set(options.map((o) => o.key));
          const lost = [part.answer, ...part.answerHistory].filter((a): a is DecisionAnswer => a?.key != null && !keys.has(a.key));
          if (lost.length > 0) {
            throw decisionError('DECISION_ANSWER_IMMUTABLE', `Part ${part.n}'s options must keep every option it was answered with (${lost.map((a) => a.key).join(', ')}).`, { part: part.n });
          }
          part.options = options;
        }
        if (pp.recommendation) {
          part.recommendation = { key: pp.recommendation.key, by: actor, reason: pp.recommendation.reason ?? null, attributedTo: pp.recommendation.attributedTo ?? null };
          part.noRecommendation = null;
        } else if (pp.noRecommendation) {
          part.recommendation = null;
          part.noRecommendation = pp.noRecommendation;
        }
        checkPart(part, pointer);
      }
      for (const [i, added] of (patch.addParts ?? []).entries()) {
        if (next.parts.length >= MAX_PARTS) invalidDecision([{ pointer: `/addParts/${i}`, message: `a decision has at most ${MAX_PARTS} parts` }]);
        next.parts.push(buildPart(added, next.parts.length + 1, actor, `/addParts/${i}`));
      }
      next.status = statusHint(next);
      const final = finalize(next);
      if (canonicalDecisionJson(final) === canonicalDecisionJson(current)) return; // nothing changed: no revision
      await writeNodeCore(
        { memoryId: target.memoryId, loc: row.loc, ...renderedFields(final), reason },
        txCtx,
        'update',
        {
          targetNodeId: row.id, guardRevSeq: row.revSeq, ownsKind: 'decision', governedContext: 'node-write',
          transaction: { tx, pooledDb: ctx.db, afterCommit: (e) => effects.push(e) },
        },
      );
    }, { fence: true, timeout: 60_000 });
    for (const effect of effects) effect();
    return loadDecisionView(ctx, target.id);
  },

  /**
   * §7 — withdraw a decision (terminal; its code stays consumed). The asker
   * or a decider; once a part is answered, a decider only. Refused for a
   * DECIDED decision (supersede it instead) and for a terminal one.
   */
  withdrawDecision: async (
    _: unknown,
    args: { ref: string; reason: string; expectedRevision: number },
    ctx: Context,
  ): Promise<DecisionView> => {
    refuseImpersonation(ctx);
    const reason = validateReason(args.reason);
    const target = await resolveGovernedNode(ctx, args.ref, DECISION_ROLE, decisionMissing);
    await requireDecisionWrite(ctx, target.memoryId);
    const effects: Array<() => void> = [];
    await withAuthorizedMemoryTx(ctx, target.memoryId, [], (txCtx) => requireDecisionWrite(txCtx, target.memoryId), async (tx, txCtx) => {
      const row = await lockDecision(tx, target.id, target.memoryId, args.ref, args.expectedRevision);
      const [view] = await evaluateRows(tx, [row]);
      const current = requireWritable(view);
      if (view.evaluation.state === 'DECIDED') {
        throw decisionError('DECISION_ANSWERED_DECIDED', `${current.code} is DECIDED; a decided decision is superseded, not withdrawn.`, { decisionCode: current.code });
      }
      const decider = await isDecider(txCtx, current);
      if (everAnswered(current) ? !decider : !(decider || (await isAsker(txCtx, current)))) {
        throw decisionError(
          everAnswered(current) ? 'DECISION_NOT_DECIDER' : 'DECISION_NOT_ASKER',
          everAnswered(current)
            ? `${current.code} has an answer, so only one of its deciders may withdraw it.`
            : `Only the asker of ${current.code} or one of its deciders may withdraw it.`,
          { decisionCode: current.code },
        );
      }
      const next = finalize({ ...current, withdrawn: { by: actorOf(ctx), at: new Date().toISOString(), reason }, status: 'withdrawn' });
      await writeNodeCore(
        { memoryId: target.memoryId, loc: row.loc, ...renderedFields(next), reason },
        txCtx,
        'update',
        {
          targetNodeId: row.id, guardRevSeq: row.revSeq, ownsKind: 'decision', governedContext: 'node-write',
          transaction: { tx, pooledDb: ctx.db, afterCommit: (e) => effects.push(e) },
        },
      );
    }, { fence: true, timeout: 60_000 });
    for (const effect of effects) effect();
    return loadDecisionView(ctx, target.id);
  },

  /**
   * Q8 — a platform admin hard-deletes a decision that was NEVER answered,
   * recording actor, reason, code and the content's hash on the log (a log
   * revision). The code stays consumed.
   */
  purgeUnansweredDecision: async (_: unknown, args: { ref: string; reason: string }, ctx: Context): Promise<boolean> => {
    refuseImpersonation(ctx);
    const reason = validateReason(args.reason);
    const target = await resolveGovernedNode(ctx, args.ref, DECISION_ROLE, decisionMissing);
    const requireAdmin = async (c: Context) => {
      if (!isPlatformAdmin(c)) throw decisionError('DECISION_FORBIDDEN', 'Only a platform admin may purge a decision.');
    };
    await requireAdmin(ctx);
    const effects: Array<() => void> = [];
    await withAuthorizedMemoryTx(ctx, target.memoryId, [], requireAdmin, async (tx, txCtx) => {
      const logRow = await logOfDecision(tx, target);
      if (!logRow) throw new Error(`decision ${target.id} has no log`);
      const { row: lockedLog, data: logData } = await lockLog(tx, logRow.id, target.memoryId, args.ref);
      const row = await lockDecision(tx, target.id, target.memoryId, args.ref);
      const [view] = await evaluateRows(tx, [row]);
      const d = view.evaluation.decision;
      if (!d) {
        throw decisionError('DECISION_INVALID', `This decision is ${view.evaluation.state}; its answers cannot be established, so it is not purged.`, { state: view.evaluation.state });
      }
      const cached = decisionDataSchema.safeParse(row.data);
      if (everAnswered(d) || (cached.success && everAnswered(cached.data))) {
        throw decisionError('DECISION_ANSWERED', `${d.code} has been answered, so it is never purged; withdraw or supersede it.`, { decisionCode: d.code });
      }
      const descendants = await tx.node.count({ where: { memoryId: target.memoryId, loc: { startsWith: `${row.loc}:` } } });
      if (descendants > 0) throw decisionContainedError('Purging this decision', [row.loc]);
      const data: DecisionLogData = decisionLogDataSchema.parse({
        ...logData,
        lastCode: Math.max(logData.lastCode, d.n),
        purges: [...logData.purges, {
          code: d.code, n: d.n, by: txCtx.userId!, at: new Date().toISOString(), reason,
          contentHash: createHash('sha256').update(row.content ?? '', 'utf8').digest('hex'),
        }],
        lastAction: { op: 'purge', by: actorOf(ctx), at: new Date().toISOString(), reason },
      });
      await writeNodeCore(
        { memoryId: target.memoryId, loc: lockedLog.loc, ...logContentOf(lockedLog.name, data), reason: `purge ${d.code}: ${reason}`.slice(0, REASON_MAX) },
        txCtx,
        'update',
        {
          targetNodeId: lockedLog.id, ownsKind: 'decision', governedContext: 'node-write',
          transaction: { tx, pooledDb: ctx.db, afterCommit: (e) => effects.push(e) },
        },
      );
      await hardDeleteThreadsOfTargets(tx, [row.id]);
      await deletePendingEdgesTargetingNodes(tx, [row.id]);
      const res = await tx.node.deleteMany({ where: { id: row.id, memoryId: target.memoryId } });
      if (res.count !== 1) throw decisionMissing(args.ref);
    }, { fence: true, timeout: 60_000 });
    for (const effect of effects) effect();
    return true;
  },
};

// ─── Reads ───────────────────────────────────────────────────────────────────

async function loadDecisionView(ctx: Context, id: string): Promise<DecisionView> {
  const row = await ctx.db.node.findUnique({ where: { id }, select: DECISION_ROW_SELECT });
  if (!row || row.deletedAt || row.role !== DECISION_ROLE) throw decisionMissing(id);
  const [view] = await evaluateRows(ctx.db as unknown as Tx, [row]);
  return view;
}

async function loadLogView(ctx: Context, ref: string): Promise<DecisionLogView | null> {
  let log: { id: string };
  try {
    log = await resolveGovernedNode(ctx, ref, DECISION_LOG_ROLE, logMissing);
  } catch (error) {
    if (error instanceof GraphQLError && error.extensions.code === 'DECISION_LOG_NOT_FOUND') return null;
    throw error;
  }
  const row = await ctx.db.node.findUniqueOrThrow({ where: { id: log.id }, select: LOG_ROW_SELECT });
  return { row, data: parseLogData(row) };
}

const STATE_ORDER: Record<DecisionState, number> = {
  OPEN: 0, ANSWERED_UNCONFIRMED: 1, STALE: 2, TAMPERED: 3, UNVERIFIABLE: 4, DECIDED: 5, WITHDRAWN: 6, SUPERSEDED: 7,
};

function sortViews(views: DecisionView[], sort: 'PORTAL_DEFAULT' | 'CODE'): DecisionView[] {
  const n = (v: DecisionView) => v.shown?.n ?? v.row.seq ?? 0;
  if (sort === 'CODE') return [...views].sort((a, b) => n(a) - n(b) || a.row.loc.localeCompare(b.row.loc));
  // Uma's list sort (§8.4): urgency, then open-before-answered, then newest ask.
  return [...views].sort((a, b) =>
    (b.shown?.urgency === 'urgent' ? 1 : 0) - (a.shown?.urgency === 'urgent' ? 1 : 0) ||
    STATE_ORDER[a.evaluation.state] - STATE_ORDER[b.evaluation.state] ||
    (b.shown?.askedAt ?? '').localeCompare(a.shown?.askedAt ?? '') ||
    n(b) - n(a));
}

export const decisionQueries = {
  /** §6.1a — a log's settings, under its memory's read gate. Null when missing or unreadable. */
  decisionLog: (_: unknown, { ref }: { ref: string }, ctx: Context) => loadLogView(ctx, ref),

  /**
   * One decision by ref (id or URN), or by code (`DU`, or a citation `DU-1`)
   * within a log. Null when missing or unreadable (no existence oracle).
   */
  decision: async (
    _: unknown,
    args: { ref?: string | null; code?: string | null; logRef?: string | null },
    ctx: Context,
  ): Promise<DecisionView | null> => {
    if ((args.ref == null) === (args.code == null)) {
      throw new GraphQLError('Give exactly one of ref and code (with logRef).', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    let id: string;
    if (args.ref != null) {
      try {
        ({ id } = await resolveGovernedNode(ctx, args.ref, DECISION_ROLE, decisionMissing));
      } catch (error) {
        if (error instanceof GraphQLError && error.extensions.code === 'DECISION_NOT_FOUND') return null;
        throw error;
      }
    } else {
      if (args.logRef == null) throw new GraphQLError('A code needs logRef.', { extensions: { code: 'BAD_USER_INPUT' } });
      const log = await loadLogView(ctx, args.logRef);
      if (!log) return null;
      const cited = parseDecisionCitation(args.code!, log.data.prefix);
      if (!cited) return null;
      const row = await ctx.db.node.findUnique({
        where: { loc_memoryId: { loc: decisionLoc(log.row.loc, cited.code), memoryId: log.row.memoryId } },
        select: { id: true, role: true, deletedAt: true },
      });
      if (!row || row.deletedAt || row.role !== DECISION_ROLE) return null;
      id = row.id;
    }
    return loadDecisionView(ctx, id);
  },

  /**
   * §8.1 — the decisions of one log, or (`awaitingMe`) the OPEN decisions the
   * caller decides across every memory they can read: the portal's pull cue
   * (r4). Every candidate is evaluated BEFORE filtering, sorting and paging
   * (§5.5); `properties` only narrows the candidate scan, never the answer.
   */
  decisions: async (
    _: unknown,
    args: {
      logRef?: string | null; awaitingMe?: boolean | null;
      state?: DecisionState[] | null; tier?: string | null; urgency?: string[] | null; authorizes?: boolean | null;
      sort?: 'PORTAL_DEFAULT' | 'CODE' | null; limit?: number | null; offset?: number | null;
    },
    ctx: Context,
  ): Promise<{ items: DecisionView[]; total: number }> => {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const offset = Math.max(args.offset ?? 0, 0);
    let where: Prisma.NodeWhereInput;
    if (args.awaitingMe) {
      if (!ctx.userId || ctx.impersonation) return { items: [], total: 0 };
      const accessible = await getAccessibleMemoryIds(ctx);
      // #1715: a decision names the caller by any id merged into theirs.
      const me = [...(await callerIdentities(ctx))];
      where = {
        role: DECISION_ROLE, deletedAt: null,
        ...(accessible === null ? {} : { memoryId: { in: accessible } }),
        OR: me.map((id) => ({ properties: { path: ['deciders'], array_contains: [id] } })),
      };
      if (args.logRef) {
        const log = await loadLogView(ctx, args.logRef);
        if (!log) return { items: [], total: 0 };
        where = { ...where, memoryId: log.row.memoryId, loc: { startsWith: `${log.row.loc}:` } };
      }
    } else {
      if (!args.logRef) throw new GraphQLError('Give logRef, or awaitingMe: true.', { extensions: { code: 'BAD_USER_INPUT' } });
      const log = await loadLogView(ctx, args.logRef);
      if (!log) return { items: [], total: 0 };
      where = { role: DECISION_ROLE, deletedAt: null, memoryId: log.row.memoryId, loc: { startsWith: `${log.row.loc}:` } };
    }
    const count = await ctx.db.node.count({ where });
    if (count > DECISION_LIST_EVALUATION_CAP) {
      throw decisionError('DECISION_LOG_TOO_LARGE_FOR_FILTER', `${count} decisions exceed the ${DECISION_LIST_EVALUATION_CAP} this list evaluates at once.`, { count, cap: DECISION_LIST_EVALUATION_CAP });
    }
    // Only askDecision writes the decision role, always directly under a log.
    const rows = await ctx.db.node.findMany({ where, select: DECISION_ROW_SELECT });
    let views = await evaluateRows(ctx.db as unknown as Tx, rows);
    if (args.awaitingMe) {
      const me = await callerIdentities(ctx);
      views = views.filter((v) => v.evaluation.state === 'OPEN' && !!v.evaluation.decision?.deciders.some((id) => me.has(id)));
    }
    const tier = toTier(args.tier);
    const urgencies = args.urgency?.map(toUrgency);
    views = views.filter((v) =>
      (!args.state || args.state.includes(v.evaluation.state)) &&
      (!tier || v.shown?.tier === tier) &&
      (!urgencies || (!!v.shown && urgencies.includes(v.shown.urgency))) &&
      (args.authorizes == null || v.shown?.authorizes === args.authorizes));
    const sorted = sortViews(views, args.sort ?? 'PORTAL_DEFAULT');
    return { items: sorted.slice(offset, offset + limit), total: sorted.length };
  },

  /** §8.1 — the integrity and evidence check, through the one evaluation. */
  verifyDecision: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    const { id } = await resolveGovernedNode(ctx, ref, DECISION_ROLE, decisionMissing);
    const view = await loadDecisionView(ctx, id);
    const block = view.evaluation.decision;
    const cachedCodec = (view.row.data as { codec?: unknown } | null)?.codec;
    const cachedRenderer = (view.row.data as { renderer?: unknown } | null)?.renderer;
    return {
      state: view.evaluation.state,
      findings: view.evaluation.findings,
      codec: block?.codec ?? (typeof cachedCodec === 'string' ? cachedCodec : null),
      renderer: block?.renderer ?? (typeof cachedRenderer === 'string' ? cachedRenderer : null),
      revision: view.row.revSeq,
      approvedRevision: view.row.approvedRevNo,
      approvalIntegrity: view.evaluation.approval.integrity,
      approvalByDecider: view.evaluation.approval.byDecider,
    };
  },
};

// ─── Field resolvers ─────────────────────────────────────────────────────────

const ENUM = (v: string) => v.toUpperCase().replace(/-/g, '_');

function refOut(r: DecisionRef) {
  return { ref: 'ref' in r ? r.ref : null, node: 'node' in r ? r.node : null, spec: 'spec' in r ? r.spec : null };
}

function answerOut(a: DecisionAnswer) {
  return { ...a, via: ENUM(a.via), byUserId: a.by, recordedByUserId: a.recordedBy, source: a.source ? refOut(a.source) : null };
}

async function actorOut(ctx: Context, a: DecisionActor) {
  return {
    userId: a.userId, workerId: a.workerId, appId: a.appId,
    user: a.userId ? await loadCommentActor(ctx, 'user', a.userId) : null,
    worker: a.workerId ? await loadCommentActor(ctx, 'worker', a.workerId) : null,
    app: a.appId ? await loadCommentActor(ctx, 'app', a.appId) : null,
  };
}

/** Every user id a stored payload names: its actors' `userId`s, answer marks, and decider lists. */
function userIdsNamedIn(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) userIdsNamedIn(v, out);
  else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (typeof v === 'string' && (key === 'userId' || key === 'by' || key === 'recordedBy')) out.add(v);
      else if (Array.isArray(v) && /deciders$/i.test(key)) for (const id of v) if (typeof id === 'string') out.add(id);
      else userIdsNamedIn(v, out);
    }
  }
  return out;
}

/**
 * #1715 — the account merges a stored payload's user ids follow: the record
 * keeps the merged-away id, and the merge says who it is now. Each link of
 * each chain, oldest first.
 */
async function identityMergesOf(ctx: Context, payload: unknown) {
  const links = await mergeLinksFrom(ctx.db, [...userIdsNamedIn(payload)]);
  return Promise.all(links.map(async (l) => ({
    fromUserId: l.sourceUserId, from: await loadCommentActor(ctx, 'user', l.sourceUserId),
    toUserId: l.targetUserId, to: await loadCommentActor(ctx, 'user', l.targetUserId),
    mergedAt: l.mergedAt,
  })));
}

const users = (ctx: Context, ids: readonly string[]) =>
  Promise.all(ids.map((id) => loadCommentActor(ctx, 'user', id))).then((refs) => refs.filter((r): r is CommentActorRef => r != null));

export const decisionFieldResolvers = {
  Decision: {
    id: (v: DecisionView) => v.row.id,
    urn: (v: DecisionView, _: unknown, ctx: Context) => resolveNodeUrnField(v.row, ctx),
    portalUrl: async (v: DecisionView, _: unknown, ctx: Context) => portalUrlForUrn(await resolveNodeUrnField(v.row, ctx)),
    code: (v: DecisionView) => v.shown?.code ?? v.row.loc.slice(v.row.loc.lastIndexOf(':') + 1),
    n: (v: DecisionView) => v.shown?.n ?? v.row.seq ?? 0,
    logId: (v: DecisionView) => v.shown?.logId ?? null,
    title: (v: DecisionView) => v.shown?.title ?? v.row.name,
    urgency: (v: DecisionView) => ENUM(v.shown?.urgency ?? 'normal'),
    tier: (v: DecisionView) => ENUM(v.shown?.tier ?? 'signed'),
    authorizes: (v: DecisionView) => v.shown?.authorizes ?? false,
    archival: (v: DecisionView) => v.shown?.archival ?? false,
    state: (v: DecisionView) => v.evaluation.state,
    context: (v: DecisionView) => v.shown?.context ?? null,
    parts: (v: DecisionView) => (v.shown?.parts ?? []).map((p) => ({
      ...p,
      citation: `${v.shown!.code}-${p.n}`,
      noRecommendationReason: p.noRecommendation?.reason ?? null,
      answer: p.answer ? answerOut(p.answer) : null,
      answerHistory: p.answerHistory.map(answerOut),
      recommendation: p.recommendation ? { ...p.recommendation } : null,
    })),
    blocks: (v: DecisionView) => (v.shown?.blocks ?? []).map(refOut),
    sources: (v: DecisionView) => (v.shown?.sources ?? []).map(refOut),
    followUps: (v: DecisionView) => (v.shown?.followUps ?? []).map(refOut),
    deciderIds: (v: DecisionView) => v.shown?.deciders ?? [],
    deciders: (v: DecisionView, _: unknown, ctx: Context) => users(ctx, v.shown?.deciders ?? []),
    viewerIsDecider: async (v: DecisionView, _: unknown, ctx: Context) => !!v.shown && (await isDecider(ctx, v.shown)),
    identityMerges: (v: DecisionView, _: unknown, ctx: Context) => identityMergesOf(ctx, v.shown),
    askedBy: (v: DecisionView, _: unknown, ctx: Context) => actorOut(ctx, v.shown?.askedBy ?? { userId: null, workerId: null, appId: null }),
    askedAt: (v: DecisionView) => v.shown?.askedAt ?? null,
    answeredAt: (v: DecisionView) => {
      const parts = v.shown?.parts ?? [];
      if (parts.length === 0 || parts.some((p) => !p.answer)) return null;
      return parts.map((p) => p.answer!.at).sort().pop() ?? null;
    },
    withdrawn: async (v: DecisionView, _: unknown, ctx: Context) => {
      const w = v.shown?.withdrawn;
      return w ? { at: w.at, reason: w.reason, by: await actorOut(ctx, w.by) } : null;
    },
    evidence: async (v: DecisionView, _: unknown, ctx: Context) => {
      const record = approvalRecordOf(v.row);
      return {
        approval: record ? {
          byUserId: record.approvedBy,
          by: record.approvedBy ? await loadCommentActor(ctx, 'user', record.approvedBy) : null,
          revision: record.revision,
          approvedAt: record.approvedAt,
          integrity: v.evaluation.approval.integrity,
          byDecider: v.evaluation.approval.byDecider,
        } : null,
      };
    },
    revSeq: (v: DecisionView) => v.row.revSeq,
    /** The node itself, under the ordinary read gate (the Decision was returned only after it). */
    node: (v: DecisionView, _: unknown, ctx: Context) => ctx.db.node.findUnique({ where: { id: v.row.id } }),
  },
  DecisionLog: {
    id: (v: DecisionLogView) => v.row.id,
    urn: (v: DecisionLogView, _: unknown, ctx: Context) => resolveNodeUrnField(v.row, ctx),
    portalUrl: async (v: DecisionLogView, _: unknown, ctx: Context) => portalUrlForUrn(await resolveNodeUrnField(v.row, ctx)),
    loc: (v: DecisionLogView) => v.row.loc,
    name: (v: DecisionLogView) => v.row.name,
    prefix: (v: DecisionLogView) => v.data.prefix,
    lastCode: (v: DecisionLogView) => v.data.lastCode,
    revSeq: (v: DecisionLogView) => v.row.revSeq,
    defaultDeciderIds: (v: DecisionLogView) => v.data.defaultDeciders,
    eligibleDeciderIds: (v: DecisionLogView) => v.data.eligibleDeciders,
    defaultDeciders: (v: DecisionLogView, _: unknown, ctx: Context) => users(ctx, v.data.defaultDeciders),
    eligibleDeciders: (v: DecisionLogView, _: unknown, ctx: Context) => users(ctx, v.data.eligibleDeciders),
    identityMerges: (v: DecisionLogView, _: unknown, ctx: Context) => identityMergesOf(ctx, v.data),
    purges: (v: DecisionLogView, _: unknown, ctx: Context) => Promise.all(v.data.purges.map(async (p) => ({
      ...p, byUserId: p.by, by: await loadCommentActor(ctx, 'user', p.by),
    }))),
  },
};
