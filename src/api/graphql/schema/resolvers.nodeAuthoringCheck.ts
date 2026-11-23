/**
 * #4168 (hrn:node:hadronmemory.com:specs:cor:dmo:060:17): Query.nodeAuthoringCheck, the authoring
 * attestation check of a proposed node write, without writing. It calls the write's own
 * {@link judgeAuthoring} on the same node state before and after, so the read cannot pass what the
 * write refuses or refuse what it accepts. `authoringFromRequest` builds the same context a direct
 * write request does, so a trusted portal human is judged as the write judges them.
 *
 * Order, which is what keeps the read from being an oracle:
 *   1. the node (or memory) must be readable, else the node read's own not-found;
 *   2. the caller must be able to write the memory, else one UNAVAILABLE, identical on every node
 *      and role, before anything about the memory's rules is looked at (cor:dmo:160:02, R1);
 *   3. only then the rules, through {@link judgeAuthoring}.
 *
 * It shows the verdict and the write's recovery (a task the caller cannot read is NO_RECOVERY, no
 * id, reference, revision or count) and nothing else from the memory's configuration. The lock the
 * shared computation takes is a shared advisory lock inside a read-only transaction: nothing is
 * written, so no revision, stamp, event or usage record exists afterwards.
 */
import { GraphQLError } from 'graphql';
import { NodeNotFoundError } from '../../../lib/entityRef/errors.js';
import { MemoryNotFoundError } from '../../../lib/asset/gate.js';
import {
  AuthoringAttestationError,
  authoringFromRequest,
  judgeAuthoring,
  type AuthoredWith,
} from '../../../lib/authoringAttestation.js';
import type { Context } from './resolvers.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { isMemoryReadableCached } from './resolvers.helpers.js';
import { resolveNodeRefForCaller } from './resolvers.nodeRefAccess.js';
import { mayRecordIn } from './resolvers.validationTaskSet.js';

export interface NodeAuthoringCheckInput {
  ref?: string | null;
  memoryId?: string | null;
  loc?: string | null;
  role?: string | null;
  isRunnable?: boolean | null;
  authoredWith?: AuthoredWith | null;
  changesAuthoredContent?: boolean | null;
}

const UNAVAILABLE = Object.freeze({ state: 'UNAVAILABLE', code: null, role: null, message: null, recovery: null });

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

export const nodeAuthoringCheckQueries = {
  nodeAuthoringCheck: async (_: unknown, { input }: { input: NodeAuthoringCheckInput }, ctx: Context) => {
    const byRef = input.ref != null;
    const byAddress = input.memoryId != null || input.loc != null;
    if (byRef === byAddress || (byAddress && (input.memoryId == null || input.loc == null))) {
      throw badInput('Name the node by ref, or by memoryId and loc together, and not both.');
    }

    let memoryId: string;
    let existing: { role: string | null; isRunnable: boolean | null } | null = null;
    if (byRef) {
      const { id } = await resolveNodeRefForCaller(ctx, input.ref!);
      const node = await ctx.db.node.findUnique({ where: { id }, select: { memoryId: true, role: true, isRunnable: true, deletedAt: true } });
      // Denied, missing and soft-deleted refuse identically (cor:api:140:03).
      if (!node || node.deletedAt || !(await isMemoryReadableCached(ctx, node.memoryId))) throw new NodeNotFoundError(input.ref!);
      memoryId = node.memoryId;
      existing = node;
    } else {
      memoryId = (await resolveMemoryRef(ctx.db, input.memoryId!)).id;
      if (!(await isMemoryReadableCached(ctx, memoryId))) throw new MemoryNotFoundError(input.memoryId!);
    }

    // One answer for a reader who does not write, before the node's loc or the rules are looked at.
    if (!(await mayRecordIn(ctx, memoryId))) return UNAVAILABLE;

    if (!byRef) {
      const found = await ctx.db.node.findFirst({
        where: { memoryId, loc: input.loc!, deletedAt: null }, select: { role: true, isRunnable: true },
      });
      existing = found;
    }

    const role = input.role === undefined ? (existing?.role ?? null) : input.role;
    const runnable = input.isRunnable === undefined ? (existing?.isRunnable ?? null) : input.isRunnable;
    const verdict = await ctx.db.$transaction((tx) => judgeAuthoring(tx, memoryId, {
      priorRole: existing?.role, priorRunnable: existing?.isRunnable,
      role, runnable, mintHuman: true,
      // A create is always an authored change; an edit is one unless the caller says it is not.
      authoredChange: existing === null || input.changesAuthoredContent !== false,
    }, authoringFromRequest(ctx, input.authoredWith ?? null)));

    if (!verdict.refused) return { state: 'PASS', code: null, role: null, message: null, recovery: null };
    const refusal = new AuthoringAttestationError(verdict.refused, verdict.role, verdict.recovery, 'graphql');
    return { state: 'REFUSED', code: verdict.refused, role: verdict.role, message: refusal.message, recovery: verdict.recovery };
  },
};
