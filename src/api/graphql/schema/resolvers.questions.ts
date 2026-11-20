/**
 * #1641 S1 — the question doors and reads (plan of record:
 * `hrn:node:hadronmemory.com:hadron-server:design:decision-nodes`, r4; §n
 * below are its sections; spec placement `cor:dmo:140`, not yet authored).
 *
 * The ONLY way a question or a question log is written. Each state change is
 * its own operation (§7) — there is no generic create/update pair — and every
 * one re-renders the question's `content` from its structured payload, so the
 * approval hash covers exactly what a decider sees (§5.2).
 *
 * S1 ships: createQuestionLog, setQuestionLogDeciders, askQuestion,
 * amendQuestion, withdrawQuestion, purgeUnansweredQuestion, and the reads
 * questionLog / question / questions (incl. awaitingMe) / verifyQuestion.
 * Answering, superseding and decider approval are S2; the signed tier is S3
 * (#1614 S2b), so an authorizing question can be asked but never DECIDED yet
 * (Q11).
 *
 * Gates (§6.1): a log is created and its deciders changed by memory MANAGE
 * or an owner-role member of the memory's App (Holger, team chat #7790);
 * a question is asked and amended (before an answer) by memory WRITERS,
 * agents included; after an answer only a decider amends; withdrawal is the
 * asker's or a decider's; purge is a platform admin's, of a never-answered
 * question only. Reads use the log memory's read gate. Every write re-runs
 * its gate under the memory's authority anchors (`withAuthorizedMemoryTx`).
 *
 * Lock order (§7): authority anchors → the log row (ask, purge, deciders) →
 * the question row. Never a log lock taken while a question row is held.
 */
import { createHash } from 'crypto';
import { canWriteToMemory } from '../../../mcp/access-control.js';
import { GraphQLError } from 'graphql';
import type { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import {
  concealUnreadableDenial,
  getAccessibleMemoryIds,
  isAuthorizationDenial,
  isMemoryReadableCached,
  isPlatformAdmin,
  requireMemoryManageAccess,
  requireMemoryWriteAccess,
} from './resolvers.helpers.js';
import { resolveNodeRefForCaller } from './resolvers.nodeRefAccess.js';
import { resolveNodeUrnField } from './resolvers.types.js';
import { withAuthorizedMemoryTx } from './authorizedTx.js';
import { identitiesOf, mergeLinksFrom, survivorOf, survivorsOf } from '../../../lib/userMerges.js';
import { writeNodeCore } from './resolvers.mutation.node.js';
import { loadCommentActor, type CommentActorRef } from './resolvers.comments.js';
import { NodeNotFoundError } from '../../../lib/entityRef/errors.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { AppNotFoundError, EntityNotFoundError } from '../../../lib/entityRef/errors.js';
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
  QUESTION_FAMILY_WHERE,
  QUESTION_LOG_ROLE,
  QUESTION_ROLE,
  questionContainedError,
  questionError,
} from '../../../lib/questions/index.js';
import {
  QUESTION_CODEC,
  QUESTION_LOG_CODEC,
  LEGACY_DECISION_CODEC,
  MAX_DECIDERS,
  amendInputSchema,
  askInputSchema,
  checkQuestion,
  currentAnswer,
  everAnswered,
  questionDataSchema,
  questionLogDataSchema,
  invalidQuestion,
  optionsOf,
  parseOrRefuse,
  type AnswerEntry,
  type QuestionActor,
  type QuestionData,
  type QuestionLogData,
  type QuestionRef,
} from '../../../lib/questions/codec.js';
import {
  CURRENT_QUESTION_RENDERER,
  canonicalQuestionJson,
  questionName,
  renderQuestion,
  renderQuestionAbstract,
  renderQuestionLog,
} from '../../../lib/questions/render.js';
import { evaluateQuestion, type QuestionEvaluation, type QuestionNodeRow, type QuestionState } from '../../../lib/questions/evaluate.js';
import { DEFAULT_QUESTION_PREFIX, QUESTION_PREFIX_RE, questionCode, questionLoc, parseQuestionCitation } from '../../../lib/questions/codes.js';

type Tx = Prisma.TransactionClient;

/** A list above this many questions refuses rather than paging on unevaluated hints (§5.5). */
export const QUESTION_LIST_EVALUATION_CAP = 5_000;
/** #4428 — `questionLogs` answers at most this many logs and refuses beyond it rather than truncating. */
export const QUESTION_LOGS_LIST_CAP = 200;

/** The cap a list reads, behind one property so a test can lower it (#4428 acceptance 10). */
export const questionListBounds = { cap: (): number => QUESTION_LIST_EVALUATION_CAP, logCap: (): number => QUESTION_LOGS_LIST_CAP };

/** Reasons ride in `NodeRevision.revLabel`, so they share its cap. */
const REASON_MAX = 500;

// ─── Rows ────────────────────────────────────────────────────────────────────

const QUESTION_ROW_SELECT = {
  ...NODE_APPROVAL_ROW_SELECT,
  data: true,
  role: true,
  seq: true,
  deletedAt: true,
} as const satisfies Prisma.NodeSelect;

type QuestionRow = Prisma.NodeGetPayload<{ select: typeof QUESTION_ROW_SELECT }>;

const LOG_ROW_SELECT = {
  id: true, memoryId: true, loc: true, name: true, role: true, data: true, revSeq: true, deletedAt: true,
} as const satisfies Prisma.NodeSelect;

type LogRow = Prisma.NodeGetPayload<{ select: typeof LOG_ROW_SELECT }>;

/** The evaluated question a `Question` field resolver reads. */
export interface QuestionView {
  row: QuestionRow;
  evaluation: QuestionEvaluation;
  /** What the card shows: the authenticated block, else the cache, else nothing (TAMPERED / UNVERIFIABLE). */
  shown: QuestionData | null;
  /**
   * #4428 — who the question is routed to, worked out at read and never stored: the explicit assignee
   * (followed through account merges), else the current holder of the worker that asked, else null.
   * Set by `attachEffectiveAssignees` on the read paths; undefined on a view a write holds.
   */
  effectiveAssigneeId?: string | null;
}

/** The log a `QuestionLog` field resolver reads. */
export interface QuestionLogView {
  row: LogRow;
  data: QuestionLogData;
}

// ─── Principals and gates ────────────────────────────────────────────────────

/** The authenticated actor of this request, server-taken (§7 provenance). */
function actorOf(ctx: Context): QuestionActor {
  return { userId: ctx.userId ?? null, workerId: currentActor().workerId, appId: ctx.appId ?? null };
}

/** Questions are never written under impersonation (a support session is read-only for them). */
function refuseImpersonation(ctx: Context): void {
  if (ctx.impersonation) {
    throw questionError('QUESTION_IMPERSONATION_REFUSED', 'Questions cannot be written under impersonation.');
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

/** §6.1 — the caller is one of the question's deciders: a user principal, never an App key or impersonation. */
async function isDecider(ctx: Context, d: Pick<QuestionData, 'deciders'>): Promise<boolean> {
  if (ctx.impersonation || !ctx.userId) return false;
  const ids = await callerIdentities(ctx);
  return d.deciders.some((id) => ids.has(id));
}

/**
 * Whether the caller asked the question: the same worker, the same user, or the same bare App key.
 * The worker arm needs a person behind the request (Rook's P3-3 on #1690, the #1713 interim): a
 * pure App key may bind any session of its App, so its worker id alone proves nothing.
 */
async function isAsker(ctx: Context, d: Pick<QuestionData, 'askedBy'>): Promise<boolean> {
  return isAskerWith(ctx, askerNeedsIdentities(ctx, d) ? await callerIdentities(ctx) : new Set(), d);
}

/** Whether judging {@link isAskerWith} on this row needs the caller's identities: a user-named asker the worker arm does not already settle. */
function askerNeedsIdentities(ctx: Context, d: Pick<QuestionData, 'askedBy'>): boolean {
  if (ctx.userId && d.askedBy.workerId && d.askedBy.workerId === actorOf(ctx).workerId) return false;
  return !!d.askedBy.userId && !!ctx.userId;
}

/** {@link isAsker} with the caller's identities already resolved (a list judges many rows against one set). */
function isAskerWith(ctx: Context, identities: ReadonlySet<string>, d: Pick<QuestionData, 'askedBy'>): boolean {
  const actor = actorOf(ctx);
  if (ctx.userId && d.askedBy.workerId && d.askedBy.workerId === actor.workerId) return true;
  if (d.askedBy.userId && ctx.userId && identities.has(d.askedBy.userId)) return true;
  return !d.askedBy.userId && !ctx.userId && !!d.askedBy.appId && d.askedBy.appId === ctx.appId;
}

function validateReason(reason: string): string {
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > REASON_MAX) {
    invalidQuestion([{ pointer: '/reason', message: `a reason is required, at most ${REASON_MAX} characters` }]);
  }
  return reason;
}

/** The write gate, typed (§6.1: memory writers, agents included). */
async function requireQuestionWrite(ctx: Context, memoryId: string): Promise<void> {
  try {
    await requireMemoryWriteAccess(ctx, memoryId);
  } catch (error) {
    if (isAuthorizationDenial(error)) {
      throw questionError('QUESTION_FORBIDDEN', 'Asking or changing a question needs write access to its memory.');
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
      throw questionError('QUESTION_FORBIDDEN', "Creating a question log or changing its deciders needs management rights on the memory.");
    }
    throw error;
  }
}

const questionMissing = (ref: string) => questionError('QUESTION_NOT_FOUND', `Question not found: "${ref}"`, { ref });
const logMissing = (ref: string) => questionError('QUESTION_LOG_NOT_FOUND', `Question log not found: "${ref}"`, { ref });

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
 * #3161 / cor:dmo:130:09: each named decider is a live user who can write the log's memory
 * now. Reuse the canonical write gate as that user, with no platform-admin role bypass,
 * on the current transaction client (never the pooled client or a request's cached read map).
 */
async function assertDecidersEligible(tx: Tx, memoryId: string, userIds: readonly string[]): Promise<void> {
  for (const userId of userIds) {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { deletedAt: true } });
    const writable = user && !user.deletedAt &&
      await canWriteToMemory(tx as unknown as Context['db'], { userId, roles: [] }, memoryId);
    if (!writable) {
      throw questionError(
        'QUESTION_DECIDER_NOT_ELIGIBLE',
        `User ${userId} cannot be a decider here: a decider is a user who can write the question log's memory.`,
        { userId },
      );
    }
  }
}

function uniqueIds(ids: readonly string[], pointer: string): string[] {
  const out = [...new Set(ids)];
  if (out.length !== ids.length) invalidQuestion([{ pointer, message: 'a user is listed twice' }]);
  if (out.length > MAX_DECIDERS) invalidQuestion([{ pointer, message: `at most ${MAX_DECIDERS} users` }]);
  return out;
}

// ─── Log helpers ─────────────────────────────────────────────────────────────

function parseLogData(row: LogRow): QuestionLogData {
  const parsed = questionLogDataSchema.safeParse(row.data);
  // A log is written only by its doors; an unparseable one is a server fault, loudly.
  if (!parsed.success) throw new Error(`question log ${row.id} has an invalid payload`);
  return parsed.data;
}

/**
 * Lock the log row (`FOR NO KEY UPDATE`, the allocator lock) and re-read it
 * live, in `memoryId`. With `expectedRevision` (a door that revises the log),
 * the token is checked first and drift reconciled after, as for a question
 * ({@link lockQuestion}).
 */
async function lockLog(tx: Tx, logId: string, memoryId: string, ref: string, expectedRevision?: number): Promise<{ row: LogRow; data: QuestionLogData }> {
  // The channel-host key before the first row lock, as createLog takes it: the drift
  // reconcile below writes a revision that may name a worker (F(W)), and writeNodeCore
  // asks for this key only after, which closes a cycle through the root-seq key (#2805).
  await lockEdgeEndpointMemories(tx, [memoryId]);
  await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${logId} FOR NO KEY UPDATE`;
  const seen = await tx.node.findUnique({ where: { id: logId }, select: LOG_ROW_SELECT });
  if (!seen || seen.deletedAt || seen.memoryId !== memoryId || seen.role !== QUESTION_LOG_ROLE) throw logMissing(ref);
  if (expectedRevision !== undefined) requireRevision(seen, expectedRevision);
  // Every path, not only the OCC one (Rook's P3-2 on #1690): the counter write
  // that follows asks for a fingerprint refresh, which would otherwise absorb
  // any earlier unrevisioned change to the log, defaultDeciders included,
  // with no revision recording it (Q6).
  await ensureCurrentNodeRevisionInTransaction(tx, logId, { expectedMemoryId: memoryId });
  const row = await tx.node.findUniqueOrThrow({ where: { id: logId }, select: LOG_ROW_SELECT });
  return { row, data: parseLogData(row) };
}

/** The log a question belongs to: its parent loc. */
async function logOfQuestion(db: Pick<Tx, 'node'>, question: { memoryId: string; loc: string }): Promise<LogRow | null> {
  const cut = question.loc.lastIndexOf(':');
  if (cut <= 0) return null;
  const row = await db.node.findUnique({
    where: { loc_memoryId: { loc: question.loc.slice(0, cut), memoryId: question.memoryId } },
    select: LOG_ROW_SELECT,
  });
  return row && row.role === QUESTION_LOG_ROLE ? row : null;
}

function logContentOf(name: string, data: QuestionLogData) {
  return {
    content: renderQuestionLog(name, data),
    abstract: `Decision log: codes ${data.prefix}A, ${data.prefix}B, … issued in sequence, never reused.`,
    data: data as unknown as Record<string, unknown>,
    properties: { prefix: data.prefix } as Record<string, unknown>,
  };
}

// ─── Question helpers ────────────────────────────────────────────────────────

/**
 * Lock the question row, check the caller's OCC token against the revision
 * they read, then reconcile any unrevisioned drift as its own revision
 * (#1323) and re-read. The door's write then guards on the reconciled
 * revision: left to `writeNodeCore`, the reconcile would move `revSeq` past
 * its compare-and-swap and roll back with the refusal, so a question with
 * harmless drift could never be changed again. Drift that alters what the
 * question renders evaluates TAMPERED and is refused by the caller.
 */
async function lockQuestion(tx: Tx, id: string, memoryId: string, ref: string, expectedRevision?: number): Promise<QuestionRow> {
  await lockEdgeEndpointMemories(tx, [memoryId]); // before any row lock or fence write, as lockLog (#2805)
  await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${id} FOR UPDATE`;
  const seen = await tx.node.findUnique({ where: { id }, select: { memoryId: true, role: true, deletedAt: true, revSeq: true } });
  if (!seen || seen.deletedAt || seen.memoryId !== memoryId || seen.role !== QUESTION_ROLE) throw questionMissing(ref);
  if (expectedRevision !== undefined) requireRevision(seen, expectedRevision);
  await ensureCurrentNodeRevisionInTransaction(tx, id, { expectedMemoryId: memoryId });
  return tx.node.findUniqueOrThrow({ where: { id }, select: QUESTION_ROW_SELECT });
}

function requireRevision(row: { revSeq: number }, expectedRevision: number): void {
  if (row.revSeq !== expectedRevision) {
    throw new GraphQLError(
      `NODE_WRITE_CONFLICT: the question is at revision ${row.revSeq}, not ${expectedRevision}. Reload and retry.`,
      { extensions: { code: 'NODE_WRITE_CONFLICT', currentRevision: row.revSeq } },
    );
  }
}

async function evaluateRows(db: Pick<Tx, 'nodeRevision'>, rows: QuestionRow[]): Promise<QuestionView[]> {
  // Question logs never live in encrypted memories (§5.4), so every field is plaintext.
  const snapshots = await loadApprovedSnapshots(db as Tx, rows);
  // #1715: each approver's merge-aware identities, once per distinct approver.
  const approvers = [...new Set(rows.map((r) => r.approvedBy).filter((id): id is string => id != null))];
  const identities = new Map(await Promise.all(approvers.map(async (id) => [id, await identitiesOf(db as Tx, id)] as const)));
  return rows.map((row) => {
    const snaps = snapshots.get(row.id);
    const evaluation = evaluateQuestion(
      row as QuestionNodeRow,
      snaps ? snaps.map((snap) => ({ title: snap.name, abstract: snap.abstract, content: snap.content })) : null,
      row.approvedBy ? identities.get(row.approvedBy) : undefined,
    );
    const cached = evaluation.question ? null : questionDataSchema.safeParse(row.data);
    return { row, evaluation, shown: evaluation.question ?? (cached?.success ? cached.data : null) };
  });
}

/**
 * Refuse a door write on a question whose state forbids it: corrupt evidence
 * first (§5.5 precedence), then the terminal states.
 */
function requireWritable(view: QuestionView): QuestionData {
  const { state, question } = view.evaluation;
  if (state === 'TAMPERED' || state === 'UNVERIFIABLE' || !question) {
    throw questionError(
      'QUESTION_INVALID',
      `This question is ${state} and cannot be changed through the question operations; run verifyQuestion for the findings.`,
      { state },
    );
  }
  if (state === 'WITHDRAWN') throw questionError('QUESTION_WITHDRAWN', `${question.code} was withdrawn.`, { questionCode: question.code });
  return question;
}

/** The derived, never-authoritative property projection for filters (§5.3). */
function propertiesOf(d: QuestionData): Record<string, unknown> {
  const standing = currentAnswer(d);
  return {
    code: d.code, n: d.n, status: d.status, answered: standing != null, priority: d.priority, tier: d.tier,
    authorizes: d.authorizes, askedAt: d.askedAt, answeredAt: standing?.at ?? null, deciders: d.deciders,
    assignee: d.assignee, askedByUserId: d.askedBy.userId, askedByWorkerId: d.askedBy.workerId, askedByAppId: d.askedBy.appId,
  };
}

/** The card hint (§6.3): never read by a relying consumer. */
function statusHint(d: QuestionData): QuestionData['status'] {
  if (d.withdrawn) return 'withdrawn';
  return currentAnswer(d) ? 'answered' : 'open';
}

/** Every rendered field of a question node, from its payload (§5.2). */
function renderedFields(d: QuestionData) {
  return {
    name: questionName(d),
    abstract: renderQuestionAbstract(d),
    content: renderQuestion(d),
    data: d as unknown as Record<string, unknown>,
    properties: propertiesOf(d),
  };
}

/** Re-validate a payload a door built, so a door bug fails loudly rather than persisting. */
async function finalize(tx: Tx, d: QuestionData): Promise<QuestionData> {
  const parsed = questionDataSchema.parse(d);
  // #4525: deciders are stored as survivors AT ASK TIME and never rewritten, so a later merge can leave one merged away.
  // The assignee is a survivor, so compare identities, not raw ids (as byDecider does, #1715).
  const ids = parsed.assignee == null ? [] : [...parsed.deciders, parsed.assignee];
  const links = await mergeLinksFrom(tx, ids);
  checkQuestion(parsed, '', (a, b) => survivorOf(links, a) === survivorOf(links, b));
  return parsed;
}

/** Highest question number ever issued under the log: the counter, or a question child above it. */
async function highWaterN(tx: Tx, log: LogRow, data: QuestionLogData): Promise<number> {
  const top = await tx.node.findFirst({
    where: { memoryId: log.memoryId, loc: { startsWith: `${log.loc}:` }, role: QUESTION_ROLE },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });
  return Math.max(data.lastCode, top?.seq ?? 0, ...data.purges.map((p) => p.n));
}

/**
 * #4426 / blind review P1: the old format reserved an answer, an answer history
 * and an `archival` flag, so "no answer operation existed" is not proof of an
 * empty history. A legacy node is purgeable only when its payload is readable and
 * shows none of them; anything else counts as possibly answered.
 */
function legacyMayHoldAnswers(data: unknown): boolean {
  if (data == null || typeof data !== 'object') return true;
  const rec = data as { archival?: unknown; status?: unknown; parts?: unknown };
  if (rec.archival !== false) return true;
  if (rec.status !== 'open' && rec.status !== 'withdrawn') return true;
  if (!Array.isArray(rec.parts) || rec.parts.length === 0) return true;
  return rec.parts.some((part: unknown) => {
    if (part == null || typeof part !== 'object') return true;
    const p = part as { answer?: unknown; answerHistory?: unknown };
    return p.answer !== null || !Array.isArray(p.answerHistory) || p.answerHistory.length > 0;
  });
}

/**
 * GraphQL values to the codec's, on an input's top level: enums (`URGENT`,
 * `SIGNED`) lower-cased, and the `DateTime` scalar's parsed value (a Date) as
 * an ISO 8601 UTC string.
 */
function lowerEnums(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const key of ['priority', 'tier'] as const) {
    if (typeof out[key] === 'string') out[key] = (out[key] as string).toLowerCase();
  }
  if (out.neededBy instanceof Date) {
    out.neededBy = Number.isNaN(out.neededBy.getTime()) ? 'invalid' : out.neededBy.toISOString();
  }
  return out;
}

const TIER_RANK = { answered: 0, approved: 1, signed: 2 } as const;

function toTier(v: string | null | undefined): QuestionData['tier'] | null {
  return v == null ? null : (v.toLowerCase() as QuestionData['tier']);
}
function toPriority(v: string | null | undefined): QuestionData['priority'] | null {
  return v == null ? null : (v.toLowerCase() as QuestionData['priority']);
}

// ─── Doors ───────────────────────────────────────────────────────────────────

type AskArgs = { logRef: string; input: Record<string, unknown> };

export const questionMutations = {
  /**
   * §3.3, §7 — create a question log: memory MANAGE or an App owner (`requireLogManage`); refused in an encrypted
   * (Q5) or git-mirrored memory, at a loc that holds anything, or inside a
   * question's or log's subtree.
   */
  createQuestionLog: async (
    _: unknown,
    args: { memoryRef: string; loc: string; name?: string | null; prefix?: string | null; defaultDeciders: string[]; eligibleDeciders?: string[] | null },
    ctx: Context,
  ): Promise<QuestionLogView> => {
    refuseImpersonation(ctx);
    const { id: memoryId } = await resolveMemoryRef(ctx.db, args.memoryRef);
    try {
      validateLoc(args.loc);
    } catch (error) {
      if (error instanceof InvalidLocError) throw new GraphQLError(error.message, { extensions: { code: error.name, loc: error.loc, segment: error.segment } });
      throw error;
    }
    const prefix = args.prefix ?? DEFAULT_QUESTION_PREFIX;
    if (!QUESTION_PREFIX_RE.test(prefix)) invalidQuestion([{ pointer: '/prefix', message: 'a prefix is one to three upper-case letters' }]);
    const name = (args.name ?? '').trim() || 'Questions';
    if (name.length > 300 || name.includes('\n')) invalidQuestion([{ pointer: '/name', message: 'a single line of at most 300 characters' }]);
    const defaults = uniqueIds(args.defaultDeciders, '/defaultDeciders');
    if (defaults.length === 0) invalidQuestion([{ pointer: '/defaultDeciders', message: 'name at least one decider' }]);
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
      // question home (§3.4 uses personal and App memories), and
      // restoreRevision rewrites a system memory wholesale: it would
      // resurrect a withdrawn question as OPEN and erase later ones.
      if (memory.class === 'system') throw questionError('QUESTION_LOG_SYSTEM_MEMORY', 'A question log cannot live in a system memory (an agent\'s definition, which a snapshot restore rewrites).', { memoryId });
      // Rook's P3-1: an anonymous per-user memory is encrypted wholesale on
      // its promotion (linkMemoryToUser), a path outside the §5.4 pairing.
      if (memory.userMemoryOfAgentId && !memory.userId) throw questionError('QUESTION_LOG_ANONYMOUS_MEMORY', 'A question log cannot live in an anonymous memory (its promotion may encrypt every node).', { memoryId });
      if (memory.isEncrypted) throw questionError('QUESTION_LOG_ENCRYPTED', 'A question log cannot live in an encrypted memory (a question is verified by re-rendering its plaintext).', { memoryId });
      if (memory.source) throw questionError('QUESTION_LOG_MIRRORED', 'A question log cannot live in a git-mirrored memory (a mirror could forge questions).', { memoryId });
      await lockEdgeEndpointMemories(tx, [memoryId]);
      await acquireLockSet(tx, [...ancestorLocs(args.loc).map((loc) => ({ memoryId, loc })), { memoryId, loc: args.loc }]);
      const occupied = await tx.node.findFirst({
        where: { memoryId, OR: [{ loc: args.loc }, { loc: { startsWith: `${args.loc}:` } }] },
        select: { loc: true },
      });
      if (occupied) {
        throw questionError('QUESTION_LOG_EXISTS', `"${args.loc}" already holds a node (or a deleted one) at or under it; a question log needs an empty loc.`, { loc: occupied.loc });
      }
      const ancestors = ancestorLocs(args.loc);
      const container = ancestors.length === 0 ? null : await tx.node.findFirst({
        where: { memoryId, loc: { in: ancestors }, ...QUESTION_FAMILY_WHERE }, select: { loc: true },
      });
      if (container) throw questionContainedError('Creating a question log here', [container.loc]);
      // #1715: name who each decider is now, never a merged-away account.
      const nowDefaults = await survivors(tx, defaults);
      const nowEligible = (await survivors(tx, eligible)).filter((u) => !nowDefaults.includes(u));
      await assertDecidersEligible(tx, memoryId, [...nowDefaults, ...nowEligible]);

      const data: QuestionLogData = questionLogDataSchema.parse({
        codec: QUESTION_LOG_CODEC, kind: 'question.log', prefix, lastCode: 0,
        defaultDeciders: nowDefaults, eligibleDeciders: nowEligible, purges: [],
        lastAction: { op: 'create', by: actorOf(ctx), at: new Date().toISOString(), reason: null },
      });
      const node = await writeNodeCore(
        {
          memoryId, loc: args.loc, name, role: QUESTION_LOG_ROLE, nodeType: 'info',
          ...logContentOf(name, data),
          description: null, contentType: null, alias: null, tags: [], llmModel: null, aiAgent: null,
          isLink: false, objectType: null, edges: [],
        },
        txCtx,
        'create',
        { authoring: { kind: 'platform', record: 'question' }, ownsKind: 'question', governedContext: 'node-write', transaction: { tx, pooledDb: ctx.db, afterCommit: (e) => effects.push(e) } },
      );
      const row = await tx.node.findUniqueOrThrow({ where: { id: (node as { id: string }).id }, select: LOG_ROW_SELECT });
      return { row, data };
    }, { timeout: 60_000, afterLock: holdAppOwnerRow(ctx, memoryId) });
    for (const effect of effects) effect();
    return view;
  },

  /**
   * §6.1, Q6 — replace a log's default (and other eligible) deciders, as an
   * audited revision of the log. Existing questions keep their frozen sets.
   */
  setQuestionLogDeciders: async (
    _: unknown,
    args: { logRef: string; defaultDeciders: string[]; eligibleDeciders?: string[] | null; expectedRevision: number; reason: string },
    ctx: Context,
  ): Promise<QuestionLogView> => {
    refuseImpersonation(ctx);
    const reason = validateReason(args.reason);
    const defaults = uniqueIds(args.defaultDeciders, '/defaultDeciders');
    if (defaults.length === 0) invalidQuestion([{ pointer: '/defaultDeciders', message: 'name at least one decider' }]);
    const log = await resolveGovernedNode(ctx, args.logRef, QUESTION_LOG_ROLE, logMissing);
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
      const data: QuestionLogData = questionLogDataSchema.parse({
        ...prior,
        defaultDeciders: nowDefaults,
        eligibleDeciders: eligible,
        lastAction: { op: 'set-deciders', by: actorOf(ctx), at: new Date().toISOString(), reason },
      });
      await writeNodeCore(
        { memoryId: log.memoryId, loc: row.loc, ...logContentOf(row.name, data), reason },
        txCtx,
        'update',
        { authoring: { kind: 'platform', record: 'question' },
          targetNodeId: row.id, guardRevSeq: row.revSeq, ownsKind: 'question', governedContext: 'node-write',
          transaction: { tx, pooledDb: ctx.db, afterCommit: (e) => effects.push(e) },
        },
      );
      return { row: await tx.node.findUniqueOrThrow({ where: { id: row.id }, select: LOG_ROW_SELECT }), data };
    }, { timeout: 60_000, afterLock: holdAppOwnerRow(ctx, log.memoryId) });
    for (const effect of effects) effect();
    return view;
  },

  /**
   * §4, §7 — ask a question: allocate the next code under the log lock, write
   * the payload and its rendering as revision 1. Memory writers, agents
   * included. `authorizes: true` forces the signed tier (§6.2).
   */
  askQuestion: async (_: unknown, args: AskArgs, ctx: Context): Promise<QuestionView> => {
    refuseImpersonation(ctx);
    const input = parseOrRefuse(askInputSchema, lowerEnums(args.input));
    const log = await resolveGovernedNode(ctx, args.logRef, QUESTION_LOG_ROLE, logMissing);
    await requireQuestionWrite(ctx, log.memoryId);
    const authorizes = input.authorizes ?? false;
    const tier = input.tier ?? (authorizes ? 'signed' : 'answered');
    if (authorizes && tier !== 'signed') {
      throw questionError('QUESTION_TIER_TOO_LOW', 'A question that authorizes something must be at the signed tier.', { tier });
    }
    if (!authorizes && input.grant != null) invalidQuestion([{ pointer: '/grant', message: 'a grant needs authorizes: true' }]);
    const actor = actorOf(ctx);
    const options = optionsOf(input, '/options') ?? [];

    const effects: Array<() => void> = [];
    const id = await withAuthorizedMemoryTx(ctx, log.memoryId, [], (txCtx) => requireQuestionWrite(txCtx, log.memoryId), async (tx, txCtx) => {
      const { row: logRow, data: logData } = await lockLog(tx, log.id, log.memoryId, args.logRef);
      // #1715: the log's sets may name merged-away accounts; compare, and
      // store, who each one is now. The log's own record is not rewritten.
      const eligibleSet = new Set(await survivors(tx, [...logData.defaultDeciders, ...logData.eligibleDeciders]));
      const deciders = await survivors(tx, input.deciders ? uniqueIds(input.deciders, '/deciders') : logData.defaultDeciders);
      const outside = deciders.filter((u) => !eligibleSet.has(u));
      if (outside.length > 0) {
        throw questionError('QUESTION_DECIDER_NOT_ELIGIBLE', `Deciders can be narrowed from the log's set, never widened: ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not eligible in this log.`, { userIds: outside });
      }
      await assertDecidersEligible(tx, log.memoryId, deciders);

      const assignee = input.assignee == null ? null : (await survivors(tx, [input.assignee]))[0];
      const n = (await highWaterN(tx, logRow, logData)) + 1;
      const code = questionCode(logData.prefix, n);
      const loc = questionLoc(logRow.loc, code);
      const squatter = await tx.node.findUnique({ where: { loc_memoryId: { loc, memoryId: log.memoryId } }, select: { id: true } });
      if (squatter) {
        // Unreachable through the guarded paths (a log's code space is closed
        // to every other writer); loud, so an operator can move the squatter.
        throw questionError('QUESTION_CONTAINED', `The next code ${code} is occupied by another node at "${loc}"; move it out of the log before asking.`, { loc });
      }
      const data = await finalize(tx, {
        codec: QUESTION_CODEC, renderer: CURRENT_QUESTION_RENDERER, kind: 'question',
        logId: logRow.id, code, n,
        title: input.title, background: input.background ?? null, whyNow: input.whyNow ?? null,
        priority: input.priority ?? 'normal', tier, authorizes,
        grant: (input.grant ?? null) as QuestionData['grant'],
        deciders, assignee, askedBy: actor, askedAt: new Date().toISOString(),
        neededBy: input.neededBy ?? null, defaultAction: input.defaultAction ?? null, taskId: null,
        blocks: input.blocks ?? [], sources: input.sources ?? [],
        specsTouched: input.specsTouched ?? [], specsMustChange: input.specsMustChange ?? [],
        options,
        recommendation: input.recommendation ? { key: input.recommendation.key, by: actor, reason: input.recommendation.reason } : null,
        noRecommendation: input.noRecommendation ?? null,
        answers: [], status: 'open', withdrawn: null,
      });
      const node = await writeNodeCore(
        {
          memoryId: log.memoryId, loc, role: QUESTION_ROLE, nodeType: 'info', seq: n,
          ...renderedFields(data),
          description: null, contentType: null, alias: null, tags: [], llmModel: null, aiAgent: null,
          isLink: false, objectType: null, edges: [],
        },
        txCtx,
        'create',
        { authoring: { kind: 'platform', record: 'question' }, ownsKind: 'question', governedContext: 'node-write', transaction: { tx, pooledDb: ctx.db, afterCommit: (e) => effects.push(e) } },
      );
      // The counter, as chat roots keep theirs: a sanctioned direct write that
      // asks for a fingerprint refresh, so it is not reconciled as drift. The
      // rendered content carries the issued count, so it is re-rendered in the
      // same write (Diego's P3 on #1690): no revision, and never stale.
      const counted: QuestionLogData = { ...logData, lastCode: n };
      await tx.node.update({
        where: { id: logRow.id },
        data: {
          data: counted as unknown as Prisma.InputJsonValue,
          content: renderQuestionLog(logRow.name, counted),
          revisionContentHash: revisionStateHashRefreshMarker(),
        },
      });
      return (node as { id: string }).id;
    }, { timeout: 60_000 });
    for (const effect of effects) effect();
    return loadQuestionView(ctx, id);
  },

  /**
   * §7 — amend a question: title, background, options, recommendation and
   * references; raise the tier. Before any answer, any memory writer; after
   * one, a decider only (and the evidence goes stale). Priority is changed by
   * a decider (Q14); the tier is lowered only by a decider,
   * before an answer, never for an authorizing question (§6.2). Answers never
   * change here.
   */
  amendQuestion: async (
    _: unknown,
    args: { ref: string; input: Record<string, unknown>; expectedRevision: number; reason: string },
    ctx: Context,
  ): Promise<QuestionView> => {
    refuseImpersonation(ctx);
    const reason = validateReason(args.reason);
    const patch = parseOrRefuse(amendInputSchema, lowerEnums(args.input));
    const target = await resolveGovernedNode(ctx, args.ref, QUESTION_ROLE, questionMissing);
    await requireQuestionWrite(ctx, target.memoryId);
    const actor = actorOf(ctx);
    const effects: Array<() => void> = [];
    await withAuthorizedMemoryTx(ctx, target.memoryId, [], (txCtx) => requireQuestionWrite(txCtx, target.memoryId), async (tx, txCtx) => {
      const row = await lockQuestion(tx, target.id, target.memoryId, args.ref, args.expectedRevision);
      const [view] = await evaluateRows(tx, [row]);
      const current = requireWritable(view);
      const decider = await isDecider(txCtx, current);
      const answered = everAnswered(current);
      if (answered && !decider) {
        throw questionError('QUESTION_NOT_DECIDER', `${current.code} has an answer, so only one of its deciders may amend it.`, { questionCode: current.code });
      }
      const next: QuestionData = structuredClone(current);
      if (patch.title != null) next.title = patch.title;
      if (patch.background !== undefined) next.background = patch.background ?? null;
      if (patch.whyNow !== undefined) next.whyNow = patch.whyNow ?? null;
      if (patch.neededBy !== undefined) next.neededBy = patch.neededBy ?? null;
      if (patch.defaultAction !== undefined) next.defaultAction = patch.defaultAction ?? null;
      if (patch.assignee !== undefined) {
        next.assignee = patch.assignee == null ? null : (await survivors(tx, [patch.assignee]))[0];
      }
      if (patch.blocks != null) next.blocks = patch.blocks;
      if (patch.sources != null) next.sources = patch.sources;
      if (patch.specsTouched != null) next.specsTouched = patch.specsTouched;
      if (patch.specsMustChange != null) next.specsMustChange = patch.specsMustChange;
      if (patch.priority != null && patch.priority !== current.priority) {
        if (!decider) throw questionError('QUESTION_NOT_DECIDER', 'Only a decider changes the priority of an asked question.', { questionCode: current.code });
        next.priority = patch.priority;
      }
      if (patch.tier != null && patch.tier !== current.tier) {
        if (TIER_RANK[patch.tier] < TIER_RANK[current.tier]) {
          if (current.authorizes || answered) {
            throw questionError('QUESTION_TIER_TOO_LOW', current.authorizes
              ? 'A question that authorizes something stays at the signed tier.'
              : 'The tier cannot be lowered once the question has been answered.', { tier: patch.tier });
          }
          if (!decider) throw questionError('QUESTION_NOT_DECIDER', 'Only a decider lowers the tier.', { questionCode: current.code });
        }
        next.tier = patch.tier;
      }
      const options = optionsOf({ options: patch.options, yesno: patch.yesno }, '/options');
      if (options) {
        const keys = new Set(options.map((o) => o.key));
        const lost = current.answers.filter((a) => a.key != null && !keys.has(a.key));
        if (lost.length > 0) {
          throw questionError('QUESTION_ANSWER_IMMUTABLE', `${current.code}'s options must keep every option it was answered with (${[...new Set(lost.map((a) => a.key))].join(', ')}).`, { questionCode: current.code });
        }
        next.options = options;
        // A free-text question holds no recommendation.
        if (options.length === 0) { next.recommendation = null; next.noRecommendation = null; }
      }
      if (patch.recommendation && patch.noRecommendation) invalidQuestion([{ pointer: '', message: 'give either a recommendation or noRecommendation, not both' }]);
      if (patch.recommendation) {
        next.recommendation = { key: patch.recommendation.key, by: actor, reason: patch.recommendation.reason };
        next.noRecommendation = null;
      } else if (patch.noRecommendation) {
        next.recommendation = null;
        next.noRecommendation = patch.noRecommendation;
      }
      next.status = statusHint(next);
      const final = await finalize(tx, next);
      if (canonicalQuestionJson(final) === canonicalQuestionJson(current)) return; // nothing changed: no revision
      await writeNodeCore(
        { memoryId: target.memoryId, loc: row.loc, ...renderedFields(final), reason },
        txCtx,
        'update',
        { authoring: { kind: 'platform', record: 'question' },
          targetNodeId: row.id, guardRevSeq: row.revSeq, ownsKind: 'question', governedContext: 'node-write',
          transaction: { tx, pooledDb: ctx.db, afterCommit: (e) => effects.push(e) },
        },
      );
    }, { timeout: 60_000 });
    for (const effect of effects) effect();
    return loadQuestionView(ctx, target.id);
  },

  /**
   * §7 — withdraw a question (terminal; its code stays consumed). The asker
   * or a decider; once the question has ever been answered, a decider only. A
   * DECIDED question may be withdrawn (no supersession); a terminal one may not.
   */
  withdrawQuestion: async (
    _: unknown,
    args: { ref: string; reason: string; expectedRevision: number },
    ctx: Context,
  ): Promise<QuestionView> => {
    refuseImpersonation(ctx);
    const reason = validateReason(args.reason);
    const target = await resolveGovernedNode(ctx, args.ref, QUESTION_ROLE, questionMissing);
    await requireQuestionWrite(ctx, target.memoryId);
    const effects: Array<() => void> = [];
    await withAuthorizedMemoryTx(ctx, target.memoryId, [], (txCtx) => requireQuestionWrite(txCtx, target.memoryId), async (tx, txCtx) => {
      const row = await lockQuestion(tx, target.id, target.memoryId, args.ref, args.expectedRevision);
      const [view] = await evaluateRows(tx, [row]);
      const current = requireWritable(view);
      const decider = await isDecider(txCtx, current);
      if (everAnswered(current) ? !decider : !(decider || (await isAsker(txCtx, current)))) {
        throw questionError(
          everAnswered(current) ? 'QUESTION_NOT_DECIDER' : 'QUESTION_NOT_ASKER',
          everAnswered(current)
            ? `${current.code} has an answer, so only one of its deciders may withdraw it.`
            : `Only the asker of ${current.code} or one of its deciders may withdraw it.`,
          { questionCode: current.code },
        );
      }
      const next = await finalize(tx, { ...current, withdrawn: { by: actorOf(ctx), at: new Date().toISOString(), reason }, status: 'withdrawn' });
      await writeNodeCore(
        { memoryId: target.memoryId, loc: row.loc, ...renderedFields(next), reason },
        txCtx,
        'update',
        { authoring: { kind: 'platform', record: 'question' },
          targetNodeId: row.id, guardRevSeq: row.revSeq, ownsKind: 'question', governedContext: 'node-write',
          transaction: { tx, pooledDb: ctx.db, afterCommit: (e) => effects.push(e) },
        },
      );
    }, { timeout: 60_000 });
    for (const effect of effects) effect();
    return loadQuestionView(ctx, target.id);
  },

  /**
   * Q8 — a platform admin hard-deletes a question that was NEVER answered,
   * recording actor, reason, code and the content's hash on the log (a log
   * revision). The code stays consumed.
   */
  purgeUnansweredQuestion: async (_: unknown, args: { ref: string; reason: string }, ctx: Context): Promise<boolean> => {
    refuseImpersonation(ctx);
    const reason = validateReason(args.reason);
    const target = await resolveGovernedNode(ctx, args.ref, QUESTION_ROLE, questionMissing);
    const requireAdmin = async (c: Context) => {
      if (!isPlatformAdmin(c)) throw questionError('QUESTION_FORBIDDEN', 'Only a platform admin may purge a question.');
    };
    await requireAdmin(ctx);
    const effects: Array<() => void> = [];
    await withAuthorizedMemoryTx(ctx, target.memoryId, [], requireAdmin, async (tx, txCtx) => {
      const logRow = await logOfQuestion(tx, target);
      if (!logRow) throw new Error(`question ${target.id} has no log`);
      const { row: lockedLog, data: logData } = await lockLog(tx, logRow.id, target.memoryId, args.ref);
      const row = await lockQuestion(tx, target.id, target.memoryId, args.ref);
      const [view] = await evaluateRows(tx, [row]);
      const d = view.evaluation.question;
      // #4426 §6: a node asked in the pre-#4426 format can never have an answer (no
      // answer operation existed for it) and no door will touch it, so a purge is
      // its only way out. Any other unparsed node stays refused.
      const legacy = !d && (row.data as { codec?: unknown } | null)?.codec === LEGACY_DECISION_CODEC && row.seq != null && row.seq >= 1;
      if (!d && !legacy) {
        throw questionError('QUESTION_INVALID', `This question is ${view.evaluation.state}; its answers cannot be established, so it is not purged.`, { state: view.evaluation.state });
      }
      if (!d && legacyMayHoldAnswers(row.data)) {
        throw questionError('QUESTION_ANSWERED', 'This question is in the old format and its payload shows an answer, an authorization record or an unreadable history, so it is never purged.', { state: view.evaluation.state });
      }
      const cached = questionDataSchema.safeParse(row.data);
      if (d && (everAnswered(d) || (cached.success && everAnswered(cached.data)))) {
        throw questionError('QUESTION_ANSWERED', `${d.code} has been answered, so it is never purged; withdraw it.`, { questionCode: d.code });
      }
      const purgedCode = d ? d.code : row.loc.slice(row.loc.lastIndexOf(':') + 1);
      const purgedN = d ? d.n : (row.seq as number);
      const descendants = await tx.node.count({ where: { memoryId: target.memoryId, loc: { startsWith: `${row.loc}:` } } });
      if (descendants > 0) throw questionContainedError('Purging this question', [row.loc]);
      const data: QuestionLogData = questionLogDataSchema.parse({
        ...logData,
        lastCode: Math.max(logData.lastCode, purgedN),
        purges: [...logData.purges, {
          code: purgedCode, n: purgedN, by: txCtx.userId!, at: new Date().toISOString(), reason,
          contentHash: createHash('sha256').update(row.content ?? '', 'utf8').digest('hex'),
        }],
        lastAction: { op: 'purge', by: actorOf(ctx), at: new Date().toISOString(), reason },
      });
      await writeNodeCore(
        { memoryId: target.memoryId, loc: lockedLog.loc, ...logContentOf(lockedLog.name, data), reason: `purge ${purgedCode}: ${reason}`.slice(0, REASON_MAX) },
        txCtx,
        'update',
        { authoring: { kind: 'platform', record: 'question' },
          targetNodeId: lockedLog.id, ownsKind: 'question', governedContext: 'node-write',
          transaction: { tx, pooledDb: ctx.db, afterCommit: (e) => effects.push(e) },
        },
      );
      await hardDeleteThreadsOfTargets(tx, [row.id]);
      await deletePendingEdgesTargetingNodes(tx, [row.id]);
      const res = await tx.node.deleteMany({ where: { id: row.id, memoryId: target.memoryId } });
      if (res.count !== 1) throw questionMissing(args.ref);
    }, { timeout: 60_000 });
    for (const effect of effects) effect();
    return true;
  },
};

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * #4428 §1 — the effective assignee of each view, in one worker query and one merge lookup for the
 * whole batch: the stored assignee (through `survivorOf`), else the holder of the asking worker.
 * Computed at read because a worker changes holder; a stored default would go stale.
 */
async function attachEffectiveAssignees(db: Pick<Tx, 'worker' | '$queryRaw'>, views: QuestionView[]): Promise<QuestionView[]> {
  const explicit = [...new Set(views.map((v) => v.shown?.assignee).filter((id): id is string => !!id))];
  const workerIds = [...new Set(views.filter((v) => !v.shown?.assignee).map((v) => v.shown?.askedBy.workerId).filter((id): id is string => !!id))];
  const holders = new Map<string, string | null>();
  if (workerIds.length > 0) {
    for (const w of await db.worker.findMany({ where: { id: { in: workerIds } }, select: { id: true, heldByUserId: true } })) {
      holders.set(w.id, w.heldByUserId);
    }
  }
  // One merge lookup covers explicit assignees AND worker holders, so display and filter agree after a merge.
  const mergeIds = [...new Set([...explicit, ...[...holders.values()].filter((id): id is string => !!id)])];
  const links = mergeIds.length > 0 ? await mergeLinksFrom(db, mergeIds) : [];
  for (const v of views) {
    const stored = v.shown?.assignee;
    v.effectiveAssigneeId = stored ? survivorOf(links, stored) : (() => { const h = v.shown?.askedBy.workerId ? holders.get(v.shown.askedBy.workerId) ?? null : null; return h ? survivorOf(links, h) : null; })();
  }
  return views;
}

async function loadQuestionView(ctx: Context, id: string): Promise<QuestionView> {
  const row = await ctx.db.node.findUnique({ where: { id }, select: QUESTION_ROW_SELECT });
  if (!row || row.deletedAt || row.role !== QUESTION_ROLE) throw questionMissing(id);
  const [view] = await attachEffectiveAssignees(ctx.db as unknown as Tx, await evaluateRows(ctx.db as unknown as Tx, [row]));
  return view;
}

async function loadLogView(ctx: Context, ref: string): Promise<QuestionLogView | null> {
  let log: { id: string };
  try {
    log = await resolveGovernedNode(ctx, ref, QUESTION_LOG_ROLE, logMissing);
  } catch (error) {
    if (error instanceof GraphQLError && error.extensions.code === 'QUESTION_LOG_NOT_FOUND') return null;
    throw error;
  }
  const row = await ctx.db.node.findUniqueOrThrow({ where: { id: log.id }, select: LOG_ROW_SELECT });
  return { row, data: parseLogData(row) };
}

const STATE_ORDER: Record<QuestionState, number> = {
  OPEN: 0, ANSWERED_UNCONFIRMED: 1, STALE: 2, TAMPERED: 3, UNVERIFIABLE: 4, DECIDED: 5, WITHDRAWN: 6,
};
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

type QuestionSortName = 'PORTAL_DEFAULT' | 'CODE' | 'ASKED_AT_DESC' | 'ASKED_AT_ASC' | 'PRIORITY_DESC' | 'ANSWERED_AT_DESC';

const answeredAtOf = (v: QuestionView): string | null => (v.shown ? currentAnswer(v.shown)?.at ?? null : null);

export function sortViews(views: QuestionView[], sort: QuestionSortName): QuestionView[] {
  const n = (v: QuestionView) => v.shown?.n ?? v.row.seq ?? 0;
  const rank = (v: QuestionView) => PRIORITY_RANK[v.shown?.priority ?? 'normal'];
  const askedAt = (v: QuestionView) => v.shown?.askedAt ?? '';
  // #4604 F3: a loc is unique only inside one memory, and an App-scope list spans memories, so two rows can share n AND loc. The last key
  // is the row id (unique), on EVERY comparator, so the order is total: for a fixed set of rows, two requests give one order (inserts, deletes
  // and changed sort keys between requests can still shift offsets).
  const byId = (a: QuestionView, b: QuestionView) => (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0);
  // Every sort ends in the same stable tiebreak: n descending, then loc, then id.
  const tie = (a: QuestionView, b: QuestionView) => n(b) - n(a) || a.row.loc.localeCompare(b.row.loc) || byId(a, b);
  if (sort === 'CODE') return [...views].sort((a, b) => n(a) - n(b) || a.row.loc.localeCompare(b.row.loc) || byId(a, b));
  if (sort === 'ASKED_AT_DESC') return [...views].sort((a, b) => askedAt(b).localeCompare(askedAt(a)) || tie(a, b));
  if (sort === 'ASKED_AT_ASC') return [...views].sort((a, b) => askedAt(a).localeCompare(askedAt(b)) || tie(a, b));
  if (sort === 'PRIORITY_DESC') return [...views].sort((a, b) => rank(a) - rank(b) || askedAt(b).localeCompare(askedAt(a)) || tie(a, b));
  if (sort === 'ANSWERED_AT_DESC') {
    return [...views].sort((a, b) => {
      const x = answeredAtOf(a), y = answeredAtOf(b);
      if (x === null || y === null) return x === y ? tie(a, b) : x === null ? 1 : -1;
      return y.localeCompare(x) || tie(a, b);
    });
  }
  // Uma's list sort (§8.4, #4426): priority (urgent first), open-before-answered, then newest ask.
  return [...views].sort((a, b) =>
    rank(a) - rank(b) ||
    STATE_ORDER[a.evaluation.state] - STATE_ORDER[b.evaluation.state] ||
    askedAt(b).localeCompare(askedAt(a)) ||
    tie(a, b));
}

/** #4428 §2 — the memories of an App the caller can read, or null when the App does not resolve. */
async function readableAppMemoryIds(ctx: Context, appRef: string): Promise<string[]> {
  let app: { id: string };
  try {
    app = await resolveAppRef(ctx.db, appRef);
  } catch (error) {
    // An unknown App answers like one with nothing to show: no existence oracle.
    if (error instanceof AppNotFoundError) return [];
    throw error;
  }
  const accessible = await getAccessibleMemoryIds(ctx);
  const memories = await ctx.db.memory.findMany({
    where: { appId: app.id, deletedAt: null, id: { in: accessible } },
    select: { id: true },
  });
  return memories.map((m) => m.id);
}

export const questionQueries = {
  /** §6.1a — a log's settings, under its memory's read gate. Null when missing or unreadable. */
  questionLog: (_: unknown, { ref }: { ref: string }, ctx: Context) => loadLogView(ctx, ref),

  /**
   * One question by ref (id or URN), or by code (`QA`)
   * within a log. Null when missing or unreadable (no existence oracle).
   */
  question: async (
    _: unknown,
    args: { ref?: string | null; code?: string | null; logRef?: string | null },
    ctx: Context,
  ): Promise<QuestionView | null> => {
    if ((args.ref == null) === (args.code == null)) {
      throw new GraphQLError('Give exactly one of ref and code (with logRef).', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    let id: string;
    if (args.ref != null) {
      try {
        ({ id } = await resolveGovernedNode(ctx, args.ref, QUESTION_ROLE, questionMissing));
      } catch (error) {
        if (error instanceof GraphQLError && error.extensions.code === 'QUESTION_NOT_FOUND') return null;
        throw error;
      }
    } else {
      if (args.logRef == null) throw new GraphQLError('A code needs logRef.', { extensions: { code: 'BAD_USER_INPUT' } });
      const log = await loadLogView(ctx, args.logRef);
      if (!log) return null;
      const cited = parseQuestionCitation(args.code!, log.data.prefix);
      if (!cited) return null;
      const row = await ctx.db.node.findUnique({
        where: { loc_memoryId: { loc: questionLoc(log.row.loc, cited.code), memoryId: log.row.memoryId } },
        select: { id: true, role: true, deletedAt: true },
      });
      if (!row || row.deletedAt || row.role !== QUESTION_ROLE) return null;
      id = row.id;
    }
    return loadQuestionView(ctx, id);
  },

  /**
   * §8.1 — the questions of one log, or (`awaitingMe`) the OPEN questions the
   * caller decides across every memory they can read: the portal's pull cue
   * (r4). Every candidate is evaluated BEFORE filtering, sorting and paging
   * (§5.5); `properties` only narrows the candidate scan, never the answer.
   */
  questions: async (
    _: unknown,
    args: {
      logRef?: string | null; awaitingMe?: boolean | null; appRef?: string | null;
      state?: QuestionState[] | null; tier?: string | null; priority?: string[] | null; authorizes?: boolean | null;
      answered?: boolean | null; assigneeId?: string | null; unassigned?: boolean | null;
      askedByMe?: boolean | null; askedByWorkerId?: string | null; askedByAppId?: string | null; answeredSince?: Date | string | null;
      sort?: QuestionSortName | null; limit?: number | null; offset?: number | null;
    },
    ctx: Context,
  ): Promise<{ items: QuestionView[]; total: number }> => {
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
    const offset = Math.max(args.offset ?? 0, 0);
    if (args.logRef && args.appRef) {
      throw new GraphQLError('Give logRef or appRef, not both.', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    if (!args.logRef && !args.appRef && !args.awaitingMe) {
      throw new GraphQLError('Give logRef, appRef, or awaitingMe: true.', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    let answeredSince: string | null = null;
    if (args.answeredSince != null) {
      const at = new Date(args.answeredSince);
      if (Number.isNaN(at.getTime())) throw new GraphQLError('answeredSince is not a time.', { extensions: { code: 'BAD_USER_INPUT' } });
      answeredSince = at.toISOString();
    }
    let where: Prisma.NodeWhereInput;
    if (args.awaitingMe) {
      if (!ctx.userId || ctx.impersonation) return { items: [], total: 0 };
      const accessible = await getAccessibleMemoryIds(ctx);
      // #1715: a question names the caller by any id merged into theirs.
      const me = [...(await callerIdentities(ctx))];
      where = {
        role: QUESTION_ROLE, deletedAt: null,
        memoryId: { in: accessible },
        OR: me.map((id) => ({ properties: { path: ['deciders'], array_contains: [id] } })),
      };
      if (args.logRef) {
        const log = await loadLogView(ctx, args.logRef);
        if (!log) return { items: [], total: 0 };
        where = { ...where, memoryId: log.row.memoryId, loc: { startsWith: `${log.row.loc}:` } };
      } else if (args.appRef) {
        const ids = new Set(await readableAppMemoryIds(ctx, args.appRef));
        where = { ...where, memoryId: { in: accessible.filter((id) => ids.has(id)) } };
      }
    } else if (args.appRef) {
      const ids = await readableAppMemoryIds(ctx, args.appRef);
      if (ids.length === 0) return { items: [], total: 0 };
      where = { role: QUESTION_ROLE, deletedAt: null, memoryId: { in: ids } };
    } else {
      const log = await loadLogView(ctx, args.logRef!);
      if (!log) return { items: [], total: 0 };
      where = { role: QUESTION_ROLE, deletedAt: null, memoryId: log.row.memoryId, loc: { startsWith: `${log.row.loc}:` } };
    }
    const cap = questionListBounds.cap();
    // #4604 F2: ONE statement bounds the evaluation: fetch at most cap + 1 and refuse, before evaluating anything, when the extra row is there.
    // A separate count-then-fetch let an insert between the two statements push the fetch past the cap. The count below only words the refusal.
    // Only askQuestion writes the question role, always directly under a log.
    const rows = await ctx.db.node.findMany({ where, select: QUESTION_ROW_SELECT, take: cap + 1 });
    if (rows.length > cap) {
      // The fetch saw cap + 1 rows, so the list is over the cap; `count` is the larger of a later count and cap + 1, a lower bound at the fetch.
      const count = Math.max(await ctx.db.node.count({ where }), cap + 1);
      throw questionError('QUESTION_LOG_TOO_LARGE_FOR_FILTER', `${count} questions exceed the ${cap} this list evaluates at once.`, { count, cap });
    }
    let views = await attachEffectiveAssignees(ctx.db as unknown as Tx, await evaluateRows(ctx.db as unknown as Tx, rows));
    if (args.awaitingMe) {
      const me = await callerIdentities(ctx);
      views = views.filter((v) => v.evaluation.state === 'OPEN' && !!v.evaluation.question?.deciders.some((id) => me.has(id)));
    }
    const tier = toTier(args.tier);
    const priorities = args.priority?.map(toPriority);
    // #4428 §3 — every filter reads the EVALUATED view, never `properties`.
    const assigneeIds = args.assigneeId ? await identitiesOf(ctx.db, args.assigneeId) : null;
    const byMe = args.askedByMe ? true : null;
    views = views.filter((v) => {
      if (args.state && !args.state.includes(v.evaluation.state)) return false;
      if (tier && v.shown?.tier !== tier) return false;
      if (priorities && !(v.shown && priorities.includes(v.shown.priority))) return false;
      if (args.authorizes != null && v.shown?.authorizes !== args.authorizes) return false;
      if (args.answered != null) {
        const st = v.evaluation.state;
        const isAnswered = st === 'ANSWERED_UNCONFIRMED' || st === 'DECIDED' || st === 'STALE';
        if (args.answered ? !isAnswered : st !== 'OPEN') return false;
      }
      const eff = v.effectiveAssigneeId ?? null;
      const mine = !!assigneeIds && eff !== null && assigneeIds.has(eff);
      if (args.assigneeId && args.unassigned) { if (!mine && eff !== null) return false; }
      else if (args.assigneeId) { if (!mine) return false; }
      else if (args.unassigned != null) { if (args.unassigned ? eff !== null : eff === null) return false; }
      if (args.askedByWorkerId && v.shown?.askedBy.workerId !== args.askedByWorkerId) return false;
      if (args.askedByAppId && v.shown?.askedBy.appId !== args.askedByAppId) return false;
      if (answeredSince !== null) {
        const at = answeredAtOf(v);
        if (at === null || new Date(at).getTime() < new Date(answeredSince).getTime()) return false;
      }
      return true;
    });
    // #4604 F5: the asker pull is judged LAST, on the rows every other filter kept. The caller's identities are resolved LAZILY, once for the
    // request, and only when a surviving row needs them (a user-named asker the worker arm did not already settle): a matching worker, an
    // App-only caller or an unevaluable row never costs a lookup, as under the per-row rule.
    if (byMe) {
      const mine = views.some((v) => !!v.shown && askerNeedsIdentities(ctx, v.shown)) ? await callerIdentities(ctx) : new Set<string>();
      views = views.filter((v) => !!v.shown && isAskerWith(ctx, mine, v.shown));
    }
    const sorted = sortViews(views, args.sort ?? 'PORTAL_DEFAULT');
    return { items: sorted.slice(offset, offset + limit), total: sorted.length };
  },

  /**
   * #4428 §5 — the question logs in the readable memories of an App, or in one memory. Exactly one
   * of appRef and memoryRef; an unknown or unreadable scope answers [] so nothing tells them apart.
   */
  questionLogs: async (_: unknown, args: { appRef?: string | null; memoryRef?: string | null }, ctx: Context): Promise<QuestionLogView[]> => {
    if ((args.appRef == null) === (args.memoryRef == null)) {
      throw new GraphQLError('Give exactly one of appRef and memoryRef.', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    let memoryIds: string[];
    if (args.appRef != null) {
      memoryIds = await readableAppMemoryIds(ctx, args.appRef);
    } else {
      let memory: { id: string };
      try {
        memory = await resolveMemoryRef(ctx.db, args.memoryRef!);
      } catch (error) {
        if (error instanceof EntityNotFoundError) return [];
        throw error;
      }
      memoryIds = (await isMemoryReadableCached(ctx, memory.id)) ? [memory.id] : [];
    }
    if (memoryIds.length === 0) return [];
    const rows = await ctx.db.node.findMany({
      where: { role: QUESTION_LOG_ROLE, deletedAt: null, memoryId: { in: memoryIds } },
      select: LOG_ROW_SELECT,
      orderBy: [{ memoryId: 'asc' }, { loc: 'asc' }],
      take: questionListBounds.logCap() + 1,
    });
    const logCap = questionListBounds.logCap();
    if (rows.length > logCap) {
      throw questionError('QUESTION_LOG_TOO_LARGE_FOR_FILTER', `More than ${logCap} question logs; narrow the scope.`, { cap: logCap });
    }
    return rows.map((row) => ({ row, data: parseLogData(row) }));
  },

  /** §8.1 — the integrity and evidence check, through the one evaluation. */
  verifyQuestion: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    const { id } = await resolveGovernedNode(ctx, ref, QUESTION_ROLE, questionMissing);
    const view = await loadQuestionView(ctx, id);
    const block = view.evaluation.question;
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

function refOut(r: QuestionRef) {
  return { ref: 'ref' in r ? r.ref : null, node: 'node' in r ? r.node : null, spec: 'spec' in r ? r.spec : null };
}

async function answerOut(ctx: Context, a: AnswerEntry) {
  return {
    kind: ENUM(a.kind), key: a.key, text: a.text, reason: a.reason, byUserId: a.by,
    by: await loadCommentActor(ctx, 'user', a.by), at: a.at, via: ENUM(a.via),
  };
}

const optionOut = (o: QuestionData['options'][number]) => ({ key: o.key, label: o.label, whyChoose: o.whyChoose, whyNot: o.whyNot, risks: o.risks });

async function actorOut(ctx: Context, a: QuestionActor) {
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
      if (typeof v === 'string' && (key === 'userId' || key === 'by' || key === 'assignee')) out.add(v);
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

export const questionFieldResolvers = {
  Question: {
    id: (v: QuestionView) => v.row.id,
    urn: (v: QuestionView, _: unknown, ctx: Context) => resolveNodeUrnField(v.row, ctx),
    portalUrl: async (v: QuestionView, _: unknown, ctx: Context) => portalUrlForUrn(await resolveNodeUrnField(v.row, ctx)),
    code: (v: QuestionView) => v.shown?.code ?? v.row.loc.slice(v.row.loc.lastIndexOf(':') + 1),
    n: (v: QuestionView) => v.shown?.n ?? v.row.seq ?? 0,
    logId: (v: QuestionView) => v.shown?.logId ?? null,
    title: (v: QuestionView) => v.shown?.title ?? v.row.name,
    priority: (v: QuestionView) => ENUM(v.shown?.priority ?? 'normal'),
    tier: (v: QuestionView) => ENUM(v.shown?.tier ?? 'signed'),
    authorizes: (v: QuestionView) => v.shown?.authorizes ?? false,
    state: (v: QuestionView) => v.evaluation.state,
    background: (v: QuestionView) => v.shown?.background ?? null,
    whyNow: (v: QuestionView) => v.shown?.whyNow ?? null,
    answered: (v: QuestionView) => !!v.shown && currentAnswer(v.shown) != null,
    options: (v: QuestionView) => (v.shown?.options ?? []).map(optionOut),
    recommendation: async (v: QuestionView, _: unknown, ctx: Context) => {
      const r = v.shown?.recommendation;
      return r ? { key: r.key, reason: r.reason, by: await actorOut(ctx, r.by) } : null;
    },
    noRecommendationReason: (v: QuestionView) => v.shown?.noRecommendation?.reason ?? null,
    answer: async (v: QuestionView, _: unknown, ctx: Context) => {
      const a = v.shown ? currentAnswer(v.shown) : null;
      return a ? answerOut(ctx, a) : null;
    },
    answers: (v: QuestionView, _: unknown, ctx: Context) => Promise.all((v.shown?.answers ?? []).map((a) => answerOut(ctx, a))),
    neededBy: (v: QuestionView) => v.shown?.neededBy ?? null,
    defaultAction: (v: QuestionView) => v.shown?.defaultAction ?? null,
    blocks: (v: QuestionView) => (v.shown?.blocks ?? []).map(refOut),
    sources: (v: QuestionView) => (v.shown?.sources ?? []).map(refOut),
    specsTouched: (v: QuestionView) => (v.shown?.specsTouched ?? []).map(refOut),
    specsMustChange: (v: QuestionView) => (v.shown?.specsMustChange ?? []).map(refOut),
    assigneeId: (v: QuestionView) => v.shown?.assignee ?? null,
    assignee: (v: QuestionView, _: unknown, ctx: Context) => (v.shown?.assignee ? loadCommentActor(ctx, 'user', v.shown.assignee) : null),
    effectiveAssigneeId: (v: QuestionView) => v.effectiveAssigneeId ?? null,
    effectiveAssignee: (v: QuestionView, _: unknown, ctx: Context) => (v.effectiveAssigneeId ? loadCommentActor(ctx, 'user', v.effectiveAssigneeId) : null),
    taskId: (v: QuestionView) => v.shown?.taskId ?? null,
    deciderIds: (v: QuestionView) => v.shown?.deciders ?? [],
    deciders: (v: QuestionView, _: unknown, ctx: Context) => users(ctx, v.shown?.deciders ?? []),
    viewerIsDecider: async (v: QuestionView, _: unknown, ctx: Context) => !!v.shown && (await isDecider(ctx, v.shown)),
    identityMerges: (v: QuestionView, _: unknown, ctx: Context) => identityMergesOf(ctx, v.shown),
    askedBy: (v: QuestionView, _: unknown, ctx: Context) => actorOut(ctx, v.shown?.askedBy ?? { userId: null, workerId: null, appId: null }),
    askedAt: (v: QuestionView) => v.shown?.askedAt ?? null,
    answeredAt: (v: QuestionView) => (v.shown ? currentAnswer(v.shown)?.at ?? null : null),
    withdrawn: async (v: QuestionView, _: unknown, ctx: Context) => {
      const w = v.shown?.withdrawn;
      return w ? { at: w.at, reason: w.reason, by: await actorOut(ctx, w.by) } : null;
    },
    evidence: async (v: QuestionView, _: unknown, ctx: Context) => {
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
    revSeq: (v: QuestionView) => v.row.revSeq,
    /** The node itself, under the ordinary read gate (the Question was returned only after it). */
    node: (v: QuestionView, _: unknown, ctx: Context) => ctx.db.node.findUnique({ where: { id: v.row.id } }),
  },
  QuestionLog: {
    id: (v: QuestionLogView) => v.row.id,
    urn: (v: QuestionLogView, _: unknown, ctx: Context) => resolveNodeUrnField(v.row, ctx),
    portalUrl: async (v: QuestionLogView, _: unknown, ctx: Context) => portalUrlForUrn(await resolveNodeUrnField(v.row, ctx)),
    memoryId: (v: QuestionLogView) => v.row.memoryId,
    loc: (v: QuestionLogView) => v.row.loc,
    name: (v: QuestionLogView) => v.row.name,
    prefix: (v: QuestionLogView) => v.data.prefix,
    lastCode: (v: QuestionLogView) => v.data.lastCode,
    revSeq: (v: QuestionLogView) => v.row.revSeq,
    defaultDeciderIds: (v: QuestionLogView) => v.data.defaultDeciders,
    eligibleDeciderIds: (v: QuestionLogView) => v.data.eligibleDeciders,
    defaultDeciders: (v: QuestionLogView, _: unknown, ctx: Context) => users(ctx, v.data.defaultDeciders),
    eligibleDeciders: (v: QuestionLogView, _: unknown, ctx: Context) => users(ctx, v.data.eligibleDeciders),
    identityMerges: (v: QuestionLogView, _: unknown, ctx: Context) => identityMergesOf(ctx, v.data),
    purges: (v: QuestionLogView, _: unknown, ctx: Context) => Promise.all(v.data.purges.map(async (p) => ({
      ...p, byUserId: p.by, by: await loadCommentActor(ctx, 'user', p.by),
    }))),
  },
};
