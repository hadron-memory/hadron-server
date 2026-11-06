/**
 * #1332 (cor:dmo:160:01): `hadron_record_content_validation`, the run tool a flow uses to record
 * the result of running a node's validation task. A thin call into the one write path, the
 * `recordNodeContentValidationReport` resolver, under the run principal: the gates, the ordered
 * refusals and the reporter are computed there. The reporter is THIS run, derived from the run
 * principal and its AppRun row; `runId` is only the caller's idempotency label, so naming another
 * run's id there changes nothing about who reported.
 *
 * The flow guards every node tool inherits (same org only, encrypted memories denied) are applied
 * to the node's memory before the reconcile or any write, through the resolver's memoryGuard.
 *
 * Arguments are passed through as written: a run tool's arguments are not schema-checked, and the
 * resolver judges a malformed one (BAD_USER_INPUT) before reading anything.
 */
import { recordContentValidationReport } from '../../../api/graphql/schema/resolvers.contentValidationReport.js';
import type { RunToolDef } from './types.js';

export const hadronRecordContentValidation: RunToolDef = {
  name: 'hadron_record_content_validation',
  description:
    'Record the result of running a node\'s validation task on one revision of the node. Advisory: it never edits the node. ' +
    'validationTaskRef is the task the node\'s role rule names now, validationTaskRevision the task revision that ran. ' +
    'The report is recorded as this run; a run whose entry task authored that node revision is refused. ' +
    'runId makes a retry idempotent. A CONFLICT means the node changed during the call and nothing was written; do not resubmit blindly.',
  inputSchema: {
    type: 'object',
    properties: {
      nodeRef: { type: 'string', description: 'The node: its id or fully-qualified node URN.' },
      nodeRevision: { type: 'integer', description: 'The node revision the task ran on.' },
      validationTaskRef: { type: 'string', description: 'The validation task: its id or node URN.' },
      validationTaskRevision: { type: 'integer', description: 'The task revision that ran.' },
      outcome: { type: 'string', enum: ['PASS', 'FAIL', 'ERROR'] },
      runId: { type: 'string', description: 'Your label for this report (1-200 characters), for idempotent retries. Not an identity.' },
    },
    required: ['nodeRef', 'nodeRevision', 'validationTaskRef', 'validationTaskRevision', 'outcome'],
  },
  cost: 1,
  execute: async (ctx, args) => {
    const receipt = await recordContentValidationReport(
      {
        nodeRef: args.nodeRef as string,
        nodeRevision: args.nodeRevision as number,
        validationTaskRef: args.validationTaskRef as string,
        validationTaskRevision: args.validationTaskRevision as number,
        outcome: args.outcome as never,
        runId: (args.runId ?? null) as string | null,
      },
      ctx.principal,
      {
        // The flow guards of resolveFlowMemory, judged on the memory the resolver will lock. A
        // memory outside them answers the resolver's NODE_NOT_FOUND, exactly like a missing node.
        memoryGuard: async (memoryId) => {
          const memory = await ctx.db.memory.findUnique({ where: { id: memoryId }, select: { organizationId: true, deletedAt: true, isEncrypted: true } });
          return !!memory && !memory.deletedAt && memory.organizationId === ctx.run.organizationId && !memory.isEncrypted;
        },
      },
    );
    ctx.log(`${receipt.replayed ? 'replayed' : 'recorded'} validation ${receipt.report.outcome} for revision ${receipt.report.nodeRevision} of node ${receipt.nodeId}`);
    return {
      nodeId: receipt.nodeId,
      replayed: receipt.replayed,
      outcome: receipt.report.outcome,
      nodeRevision: receipt.report.nodeRevision,
      authorCheck: receipt.report.authorCheck,
      state: receipt.state,
    };
  },
};

export const CONTENT_VALIDATION_TOOLS: readonly RunToolDef[] = [hadronRecordContentValidation];
