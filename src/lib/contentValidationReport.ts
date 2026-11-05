/**
 * #1332 — recording a content-validation report (hrn:node:hadronmemory.com:specs:cor:dmo:160:01;
 * rulings 0133, 0139, 0142, 0191).
 *
 * A report says "validation task V at revision v judged revision R of node N: PASS, FAIL or
 * ERROR". It is advisory history: it never edits the node and never blocks a write, and a
 * report for an older revision never moves the current revision's state (#1326's read).
 *
 * ## Who may record one
 *
 * Any writer of the node's memory except R's author, decided only from R's authorship stamp
 * (cor:dmo:060:16), never from anything the caller claims:
 *
 * | R's stamp | refused                                   | CHECKED              | AUTHOR_UNKNOWN |
 * |-----------|-------------------------------------------|----------------------|----------------|
 * | HUMAN     | that person acting as themselves          | anyone else          | —              |
 * | TASK      | a run whose entry task is the author task | a run of another task| a non-run caller, a run with no entry task |
 * | none      | —                                         | —                    | everyone       |
 *
 * CHECKED means only "the recorded author was compared and differs".
 *
 * ## The reporter
 *
 * {@link deriveReporter} reads the reporter from what the server authenticated, never from the
 * request: the first that applies of a headless run (the server's AppRun id, never the
 * request's `runId`), a worker session (worker + agent), a person with no worker binding (by
 * user id, whatever credential they used, including a user API key), an App key with no user
 * or worker. The reporter is stored with the report and is the identity a `runId` replay must
 * match.
 *
 * ## Refusal order
 *
 * The resolver does 1–2 (not found, then not a writer); {@link recordContentValidationReportInTx}
 * does the rest in order, inside the authorized transaction: 3 the report's own checks, 4 the
 * author, 5 the run-id replay, then the insert. Every refusal writes nothing.
 *
 * ## Locks
 *
 * The node row FOR SHARE (a concurrent edit waits, so R's stamp and the current revision read
 * together), then the memory's config lock SHARED, the same order an authoring write takes
 * (node, then config shared; a rule write takes the config lock exclusively and last).
 */
import { GraphQLError } from 'graphql';
import {
  Prisma,
  type NodeContentValidationAuthorCheck,
  type NodeContentValidationOutcome,
  type NodeContentValidationReport,
  type NodeRoleRule,
} from '../generated/prisma/index.js';
import { isRunPrincipal, RUN_CLIENT_PREFIX } from './auth/runPrincipal.js';
import { currentActor, currentActorAmbiguity } from './requestActor.js';
import { lockMemoryConfigShared, resolveNodeRoleRule } from './governedRole.js';
import { ruleKeysOf } from './nodeRoleWriters.js';
import { safeNodeUrnV2 } from './urnEmit.js';

/** The server-derived reporter (cor:dmo:160:01 refusal 5). */
export type ContentValidationReporter =
  | { kind: 'RUN'; runId: string; entryNodeId: string | null }
  | { kind: 'WORKER'; workerId: string; agentId: string | null }
  | { kind: 'PERSON'; userId: string }
  | { kind: 'APP_KEY'; appKeyId: string };

export type ContentValidationRefusalCode =
  | 'CONTENT_VALIDATION_REPORTER_UNKNOWN'
  | 'CONTENT_VALIDATION_NODE_REVISION_INVALID'
  | 'CONTENT_VALIDATION_NOT_CONFIGURED'
  | 'CONTENT_VALIDATION_TASK_BROKEN'
  | 'CONTENT_VALIDATION_WRONG_TASK'
  | 'CONTENT_VALIDATION_TASK_REVISION_INVALID'
  | 'CONTENT_VALIDATION_REPORTER_IS_AUTHOR'
  | 'CONTENT_VALIDATION_RUN_ID_CONFLICT';

const REFUSAL_TEXT: Record<ContentValidationRefusalCode, string> = {
  CONTENT_VALIDATION_REPORTER_UNKNOWN:
    'This caller cannot record a content-validation report: no run, worker session, person or App key could be identified.',
  CONTENT_VALIDATION_NODE_REVISION_INVALID: 'The node revision is newer than the node\'s current revision.',
  CONTENT_VALIDATION_NOT_CONFIGURED: 'No validation task is configured for this node\'s role.',
  CONTENT_VALIDATION_TASK_BROKEN:
    'The validation task of this node\'s rule is unavailable, so no report is recorded until a manager of the memory repairs the rule.',
  CONTENT_VALIDATION_WRONG_TASK: 'The task is not the validation task this node\'s rule names.',
  CONTENT_VALIDATION_TASK_REVISION_INVALID: 'The validation task revision is newer than the task\'s current revision.',
  CONTENT_VALIDATION_REPORTER_IS_AUTHOR: 'The author of this revision cannot record its content validation.',
  CONTENT_VALIDATION_RUN_ID_CONFLICT: 'This runId is already used by another report.',
};

/** A typed refusal. It carries its code only: never a task, an author, or another report. */
export class ContentValidationRefusal extends GraphQLError {
  constructor(public readonly code: ContentValidationRefusalCode) {
    super(REFUSAL_TEXT[code], { extensions: { code } });
    this.name = 'ContentValidationRefusal';
  }
}

/**
 * The reporter of the current request, from what the server authenticated. Called after the
 * write gate, so it decides nothing about access; it only names who is recording.
 *
 * A run is recognized by the run principal the runner builds (`runAuthContext`, never from
 * input) and confirmed against its AppRun row, whose `entryNodeId` the server set when it
 * minted the run. A worker comes from the validated session binding ({@link currentActor}).
 */
export async function deriveReporter(
  db: Pick<Prisma.TransactionClient, 'appRun'>,
  ctx: { clientId?: string | null; appId?: string | null; userId?: string | null; appKeyId?: string | null; impersonation?: unknown },
): Promise<ContentValidationReporter> {
  if (ctx.impersonation) throw new ContentValidationRefusal('CONTENT_VALIDATION_REPORTER_UNKNOWN');
  if (isRunPrincipal(ctx)) {
    const runId = ctx.clientId!.slice(RUN_CLIENT_PREFIX.length);
    const run = runId && ctx.appId
      ? await db.appRun.findFirst({ where: { id: runId, appId: ctx.appId }, select: { id: true, entryNodeId: true } })
      : null;
    if (!run) throw new ContentValidationRefusal('CONTENT_VALIDATION_REPORTER_UNKNOWN');
    return { kind: 'RUN', runId: run.id, entryNodeId: run.entryNodeId };
  }
  // A connection bound to several workers that named none: refuse rather than guess (#1701).
  if (currentActorAmbiguity()) throw new ContentValidationRefusal('CONTENT_VALIDATION_REPORTER_UNKNOWN');
  const actor = currentActor();
  if (actor.workerId) return { kind: 'WORKER', workerId: actor.workerId, agentId: actor.agentId ?? null };
  if (ctx.userId) return { kind: 'PERSON', userId: ctx.userId };
  if (ctx.appKeyId) return { kind: 'APP_KEY', appKeyId: ctx.appKeyId };
  throw new ContentValidationRefusal('CONTENT_VALIDATION_REPORTER_UNKNOWN');
}

/** The stored reporter columns of a reporter. */
export function reporterColumns(reporter: ContentValidationReporter) {
  return {
    reporterKind: reporter.kind,
    reporterRunId: reporter.kind === 'RUN' ? reporter.runId : null,
    reporterWorkerId: reporter.kind === 'WORKER' ? reporter.workerId : null,
    reporterAgentId: reporter.kind === 'WORKER' ? reporter.agentId : null,
    reporterUserId: reporter.kind === 'PERSON' ? reporter.userId : null,
    reporterAppKeyId: reporter.kind === 'APP_KEY' ? reporter.appKeyId : null,
  };
}

/**
 * Same reporter: the same kind and every id equal. A stored report with no recorded reporter
 * (written before #1332, or imported) matches nobody, so it never replays.
 */
function sameReporter(stored: NodeContentValidationReport, reporter: ContentValidationReporter): boolean {
  if (stored.reporterKind == null) return false;
  const want = reporterColumns(reporter);
  return stored.reporterKind === want.reporterKind &&
    stored.reporterRunId === want.reporterRunId &&
    stored.reporterWorkerId === want.reporterWorkerId &&
    stored.reporterAgentId === want.reporterAgentId &&
    stored.reporterUserId === want.reporterUserId &&
    stored.reporterAppKeyId === want.reporterAppKeyId;
}

type AuthorshipStamp = {
  authorshipKind: 'TASK' | 'HUMAN' | null;
  authoredByTask: string | null;
  authoredByHuman: string | null;
};

/**
 * The author check (cor:dmo:160:01 table). Returns the check to record, or refuses the
 * author. Only the stamp and the reporter decide it; agents and `editedBy*` are never
 * compared (ruling 0191).
 */
export function judgeReporterAgainstAuthor(
  stamp: AuthorshipStamp | null,
  reporter: ContentValidationReporter,
): NodeContentValidationAuthorCheck {
  if (stamp?.authorshipKind === 'HUMAN' && stamp.authoredByHuman) {
    // 0142: the person acting as themselves, through any credential. A worker they hold,
    // a run on their behalf and an App key are not that person.
    if (reporter.kind === 'PERSON' && reporter.userId === stamp.authoredByHuman) {
      throw new ContentValidationRefusal('CONTENT_VALIDATION_REPORTER_IS_AUTHOR');
    }
    return 'CHECKED';
  }
  if (stamp?.authorshipKind === 'TASK' && stamp.authoredByTask) {
    if (reporter.kind !== 'RUN' || reporter.entryNodeId == null) return 'AUTHOR_UNKNOWN';
    if (reporter.entryNodeId === stamp.authoredByTask) {
      throw new ContentValidationRefusal('CONTENT_VALIDATION_REPORTER_IS_AUTHOR');
    }
    return 'CHECKED';
  }
  return 'AUTHOR_UNKNOWN';
}

export interface ContentValidationReportInput {
  nodeId: string;
  memoryId: string;
  nodeRevision: number;
  /** The task, by id or canonical node URN, compared with the rule's; never resolved on its own. */
  validationTaskRef: string;
  validationTaskRevision: number;
  outcome: NodeContentValidationOutcome;
  runId: string | null;
  reporter: ContentValidationReporter;
}

export interface ContentValidationReportResult {
  report: NodeContentValidationReport;
  /** True when an earlier report with the same runId was returned and nothing was written. */
  replayed: boolean;
}

/** The node's validation rules: each rule key of its current state that names or requires a validation task. */
function validationRules(role: string | null, runnable: boolean | null, rules: readonly NodeRoleRule[]): NodeRoleRule[] {
  const out: NodeRoleRule[] = [];
  for (const key of ruleKeysOf(role, runnable)) {
    const resolution = resolveNodeRoleRule(key, rules);
    if (resolution.kind !== 'RULE') continue;
    // The marker outlives the SetNull on the task FK, so a deleted task reads as broken.
    if (resolution.rule.validationTaskId || resolution.rule.validationTaskRequired) out.push(resolution.rule);
  }
  return out;
}

/**
 * Steps 3–5 and the insert, inside the caller's authorized transaction (which already
 * re-ran the write gate). See the module comment for the order and the locks.
 */
export async function recordContentValidationReportInTx(
  tx: Prisma.TransactionClient,
  input: ContentValidationReportInput,
): Promise<ContentValidationReportResult> {
  const rows = await tx.$queryRaw<Array<{
    rev_seq: number; role: string | null; is_runnable: boolean | null;
    authorship_kind: 'TASK' | 'HUMAN' | null; authored_by_task: string | null; authored_by_human: string | null;
    unchanged: boolean;
  }>>`
    SELECT n.rev_seq, n.role, n.is_runnable, n.authorship_kind, n.authored_by_task, n.authored_by_human,
      (n.revision_content_hash IS NOT NULL AND n.revision_content_hash = hadron_node_revision_state_hash(n)) AS unchanged
    FROM nodes n
    WHERE n.id = ${input.nodeId} AND n.memory_id = ${input.memoryId} AND n.deleted_at IS NULL
    FOR SHARE`;
  const node = rows[0];
  // Moved or deleted since the gate: the same answer as a node read.
  if (!node) throw new GraphQLError('Node not found', { extensions: { code: 'NODE_NOT_FOUND' } });
  // A raw writer changed the content without a revision: the number and the stamp are not
  // R's yet. The resolver reconciles before this transaction; a writer that raced it is
  // refused here rather than judged on a stale stamp.
  if (!node.unchanged) {
    throw new GraphQLError('The node changed while the report was being recorded; retry.', { extensions: { code: 'CONFLICT' } });
  }

  // 3. The report's own checks.
  if (input.nodeRevision > node.rev_seq) throw new ContentValidationRefusal('CONTENT_VALIDATION_NODE_REVISION_INVALID');
  await lockMemoryConfigShared(tx, input.memoryId);
  const config = await tx.memoryConfig.findUnique({ where: { memoryId: input.memoryId }, include: { rules: true } });
  const rules = validationRules(node.role, node.is_runnable, config?.rules ?? []);
  if (rules.length === 0) throw new ContentValidationRefusal('CONTENT_VALIDATION_NOT_CONFIGURED');
  const taskIds = [...new Set(rules.flatMap((rule) => (rule.validationTaskId ? [rule.validationTaskId] : [])))];
  const tasks = await tx.node.findMany({
    where: { id: { in: taskIds } },
    select: { id: true, loc: true, revSeq: true, isRunnable: true, deletedAt: true, memory: { select: { urn: true, deletedAt: true } } },
  });
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const rule of rules) {
    const task = rule.validationTaskId ? byId.get(rule.validationTaskId) : undefined;
    // D-2026-09-25-E: an operation relying on a broken rule fails closed.
    if (!task || task.deletedAt || task.memory.deletedAt || task.isRunnable !== true) {
      throw new ContentValidationRefusal('CONTENT_VALIDATION_TASK_BROKEN');
    }
  }
  const task = tasks.find((t) => input.validationTaskRef === t.id || input.validationTaskRef === safeNodeUrnV2(t.memory.urn, t.loc));
  if (!task) throw new ContentValidationRefusal('CONTENT_VALIDATION_WRONG_TASK');
  if (input.validationTaskRevision > task.revSeq) throw new ContentValidationRefusal('CONTENT_VALIDATION_TASK_REVISION_INVALID');

  // 4. The author of R. The current revision's stamp is on the locked row; an older one is on
  // its snapshot (a snapshot captures the pre-edit state at its number). A snapshot pruned past
  // the memory's revision cap leaves nothing to compare: author unknown (0139).
  const stamp: AuthorshipStamp | null = input.nodeRevision === node.rev_seq
    ? { authorshipKind: node.authorship_kind, authoredByTask: node.authored_by_task, authoredByHuman: node.authored_by_human }
    : await tx.nodeRevision.findFirst({
        where: { nodeId: input.nodeId, revNo: input.nodeRevision },
        select: { authorshipKind: true, authoredByTask: true, authoredByHuman: true },
      });
  const authorCheck = judgeReporterAgainstAuthor(stamp, input.reporter);

  // 5. The run-id replay, scoped to this node in this memory, so a run id never answers
  // across nodes or memories. Any other match is one content-free conflict.
  if (input.runId != null) {
    const stored = await tx.nodeContentValidationReport.findFirst({
      where: { nodeId: input.nodeId, memoryId: input.memoryId, runId: input.runId },
    });
    if (stored) {
      if (sameReporter(stored, input.reporter) &&
          stored.nodeRevSeq === input.nodeRevision &&
          stored.validationTaskId === task.id &&
          stored.validationTaskRevSeq === input.validationTaskRevision) {
        return { report: stored, replayed: true };
      }
      throw new ContentValidationRefusal('CONTENT_VALIDATION_RUN_ID_CONFLICT');
    }
  }

  const report = await tx.nodeContentValidationReport.create({
    data: {
      nodeId: input.nodeId,
      memoryId: input.memoryId,
      nodeRevSeq: input.nodeRevision,
      validationTaskId: task.id,
      validationTaskRevSeq: input.validationTaskRevision,
      outcome: input.outcome,
      runId: input.runId,
      authorCheck,
      ...reporterColumns(input.reporter),
    },
  });
  return { report, replayed: false };
}

/**
 * The loser of two concurrent inserts with one runId on one node and memory. Its
 * transaction is aborted by the violation, so the caller retries the whole act once and the
 * replay check (step 5) answers it under the same rules: the stored report, or the conflict.
 */
export function isValidationRunIdUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = err.meta?.target;
  if (target === 'node_validation_node_memory_run_uniq') return true;
  return Array.isArray(target) && (target.includes('run_id') || target.includes('runId'));
}
