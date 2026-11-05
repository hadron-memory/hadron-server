/**
 * #1332 — `recordNodeContentValidationReport`: the one write path for content-validation
 * reports (hrn:node:hadronmemory.com:specs:cor:dmo:160:01). The MCP tool and the run tool
 * `hadron_record_content_validation` delegate here; the rules live in
 * `src/lib/contentValidationReport.ts`.
 *
 * Refusals 1–2 are judged here, before anything about the report is looked at: a caller who
 * cannot read the memory gets NODE_NOT_FOUND (cor:api:140:03), one who reads but does not write
 * it gets FORBIDDEN, and neither learns anything about R's author, the task or a run id.
 */
import { GraphQLError } from 'graphql';
import type { NodeContentValidationOutcome } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import { isMemoryHiddenForWrite, isMemoryReadableCached, memoryWriteForbidden, requireMemoryWriteAccess } from './resolvers.helpers.js';
import { resolveNodeRefForCaller } from './resolvers.nodeRefAccess.js';
import { resolveContentValidation, resolveNodeUrnField } from './resolvers.types.js';
import { liveReadSnapshotContext, liveTxContext, withAuthorizedMemoryTx } from './authorizedTx.js';
import { memoryAuthorityAnchors } from './installMemory.js';
import { NodeNotFoundError } from '../../../lib/entityRef/errors.js';
import { withReconciledNodeRead } from '../../../lib/includes/reconciledNodeRead.js';
import {
  deriveReporter,
  isValidationRunIdUniqueViolation,
  recordContentValidationReportInTx,
} from '../../../lib/contentValidationReport.js';

/** Bounded inputs. A runId is the caller's own label; never an identity. */
export const RUN_ID_MAX_LENGTH = 200;
const TASK_REF_MAX_LENGTH = 2048;
const OUTCOMES: readonly NodeContentValidationOutcome[] = ['PASS', 'FAIL', 'ERROR'];

export interface RecordContentValidationArgs {
  nodeRef: string;
  nodeRevision: number;
  validationTaskRef: string;
  validationTaskRevision: number;
  outcome: NodeContentValidationOutcome;
  runId?: string | null;
}

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

function nodeNotFound(nodeRef: string): GraphQLError {
  return new GraphQLError('Node not found', { extensions: { code: 'NODE_NOT_FOUND', nodeRef } });
}

/** The caller's own arguments, judged before anything is read; a refusal here says nothing about the memory. */
function validateArgs(args: RecordContentValidationArgs): { runId: string | null } {
  if (typeof args.nodeRef !== 'string' || args.nodeRef.trim() === '') throw badInput('nodeRef is required.');
  if (!Number.isSafeInteger(args.nodeRevision) || args.nodeRevision < 1) throw badInput('nodeRevision must be a positive integer.');
  if (typeof args.validationTaskRef !== 'string' || args.validationTaskRef.trim() === '' || args.validationTaskRef.length > TASK_REF_MAX_LENGTH) {
    throw badInput(`validationTaskRef must be 1-${TASK_REF_MAX_LENGTH} characters.`);
  }
  if (!Number.isSafeInteger(args.validationTaskRevision) || args.validationTaskRevision < 1) {
    throw badInput('validationTaskRevision must be a positive integer.');
  }
  if (!OUTCOMES.includes(args.outcome)) throw badInput('outcome must be PASS, FAIL or ERROR.');
  const runId = args.runId ?? null;
  if (runId !== null && (typeof runId !== 'string' || runId.length === 0 || runId.length > RUN_ID_MAX_LENGTH || runId.trim() !== runId)) {
    throw badInput(`runId must be 1-${RUN_ID_MAX_LENGTH} characters with no surrounding whitespace.`);
  }
  return { runId };
}

async function resolveLiveNode(ctx: Context, nodeRef: string): Promise<{ id: string; memoryId: string }> {
  let id: string;
  try {
    ({ id } = await resolveNodeRefForCaller(ctx, nodeRef));
  } catch (error) {
    if (error instanceof NodeNotFoundError) throw nodeNotFound(nodeRef);
    throw error;
  }
  const node = await ctx.db.node.findUnique({ where: { id }, select: { memoryId: true, deletedAt: true } });
  if (!node || node.deletedAt) throw nodeNotFound(nodeRef);
  return { id, memoryId: node.memoryId };
}

export const contentValidationReportMutations = {
  recordNodeContentValidationReport: async (_: unknown, args: RecordContentValidationArgs, ctx: Context) => {
    const { runId } = validateArgs(args);
    // 1. Not found, for a missing node and for a memory the caller cannot read.
    const { id: nodeId, memoryId } = await resolveLiveNode(ctx, args.nodeRef);
    if (await isMemoryHiddenForWrite(ctx, memoryId, 'node')) throw nodeNotFound(args.nodeRef);
    // 2. Not a writer. Impersonation never records (it is read-only on every surface).
    if (ctx.impersonation) throw memoryWriteForbidden();
    // #2043: an install memory's pooled write decision is a pre-flight only; the fenced
    // transaction below re-runs the gate.
    await requireMemoryWriteAccess({ ...ctx, installWritePreflight: true }, memoryId);
    const reporter = await deriveReporter(ctx.db, ctx);
    // Settle a raw writer's unrecorded change first, so the current revision and its stamp
    // are the reconciled ones (the transaction refuses a writer that races this). Like every
    // reconciling read, readability is re-checked inside the fence, after any wait: a caller
    // who lost access since the gate above publishes nothing and gets the not-found.
    const settled = await withReconciledNodeRead(ctx.db, nodeId, memoryId,
      async (tx, mayReconcile) => isMemoryReadableCached(await (mayReconcile ? liveTxContext : liveReadSnapshotContext)(ctx, tx), memoryId),
      async () => true);
    if (!settled) throw nodeNotFound(args.nodeRef);
    const authorityAnchors = await memoryAuthorityAnchors(ctx.db, ctx, memoryId);
    const record = () => withAuthorizedMemoryTx(
      ctx, memoryId, authorityAnchors,
      async (txCtx) => { await requireMemoryWriteAccess(txCtx, memoryId); },
      async (tx) => recordContentValidationReportInTx(tx, {
        nodeId, memoryId, nodeRevision: args.nodeRevision,
        validationTaskRef: args.validationTaskRef, validationTaskRevision: args.validationTaskRevision,
        outcome: args.outcome, runId, reporter,
      }),
    );
    let result;
    try {
      result = await record();
    } catch (error) {
      // A concurrent insert with this runId won the unique index. Retry once: the replay
      // check then answers with the stored report or the content-free conflict, never the
      // raw database error.
      if (!isValidationRunIdUniqueViolation(error)) throw error;
      result = await record();
    }
    const { report, replayed, lockedNodeRevision } = result;
    const task = await ctx.db.node.findFirst({
      where: { id: report.validationTaskId, deletedAt: null },
      select: { loc: true, memoryId: true },
    });
    const validationTaskRef = task && (await isMemoryReadableCached(ctx, task.memoryId))
      ? await resolveNodeUrnField(task, ctx)
      : null;
    // The state is projected only inside the memory the write was authorized for. A node that
    // moved or was deleted after the commit answers from the authorized (node, memory, locked
    // revision) snapshot: following it would project a memory this call never gated.
    const current = await ctx.db.node.findUnique({ where: { id: nodeId }, select: { revSeq: true, memoryId: true, deletedAt: true } });
    const revSeq = current && !current.deletedAt && current.memoryId === memoryId ? current.revSeq : lockedNodeRevision;
    const status = await resolveContentValidation({ nodeId, memoryId, revSeq }, ctx);
    return {
      nodeId,
      replayed,
      report: {
        nodeRevision: report.nodeRevSeq,
        validationTaskRef,
        validationTaskRevision: validationTaskRef ? report.validationTaskRevSeq : null,
        outcome: report.outcome,
        reportedAt: report.reportedAt,
        authorCheck: report.authorCheck,
      },
      state: status.state,
    };
  },
};
