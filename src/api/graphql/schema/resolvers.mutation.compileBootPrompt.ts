/**
 * #2046 (S9-4, cor:agt:040:12) — the compile's GraphQL doors: `compileAgentBootPrompt`,
 * `compileAppAgentBootPrompt`, `compileWorkerBootPrompt`. GraphQL only: there is no MCP twin.
 *
 * Every ref that does not resolve answers the same BOOT_PROMPT_COMPILE_NOT_PERMITTED a non-manager gets, so
 * the call tells a caller nothing about whether a target exists (spec: "not permitted,
 * also for a target that doesn't exist").
 */
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveWorkerRef } from '../../../lib/entityRef/workerRef.js';
import { AmbiguousLegacyUrnError, EntityNotFoundError } from '../../../lib/entityRef/errors.js';
import { UrnNotQualifiedError, UrnParseError } from '../../../lib/urn.js';
import { compileBootPrompt, compileDeadline, compileNotPermitted, remainingBudgetMs, resolveWithinBudget, type CompileTargetInput } from './compileBootPrompt.js';
import type { Context } from './resolvers.helpers.js';

/** A retired Agent still resolves, so its manager is told it is retired (gate first, then retired). */
const RETIRED_TOO = { includeDeleted: true } as const;

async function run(ctx: Context, resolve: () => Promise<CompileTargetInput>, setPointer: boolean | null | undefined) {
  // One budget for the whole operation: resolving the ref counts against it, and a pool fault or stall there is the
  // same typed CONFLICT as inside the compile (#2424, cor:agt:040:12).
  const deadline = compileDeadline();
  let target: CompileTargetInput;
  try {
    target = await resolveWithinBudget(deadline, resolve);
  } catch (e) {
    // Only a ref that names nothing (missing, malformed, ambiguous) is the stable refusal. A database fault or a
    // programming error is not a denial: it goes to the shared error path (Anne P2-2 on #2258).
    if (e instanceof EntityNotFoundError || e instanceof UrnParseError || e instanceof UrnNotQualifiedError || e instanceof AmbiguousLegacyUrnError) {
      throw compileNotPermitted();
    }
    throw e;
  }
  const result = await compileBootPrompt(ctx, target, { setPointer: setPointer ?? true, budgetMs: remainingBudgetMs(deadline) });
  // The node comes from the deciding transaction: a read here could fail after the compile committed.
  // The compile never approves or signs.
  return { node: result.node, revNo: result.revNo, contentHash: result.contentHash, pointerSet: result.pointerSet, approvalIssued: false };
}

export const compileBootPromptMutations = {
  compileAgentBootPrompt: (_: unknown, args: { agentRef: string; setPointer?: boolean | null }, ctx: Context) =>
    run(ctx, async () => ({ kind: 'AGENT', agentId: (await resolveAgentRef(ctx.db, args.agentRef, RETIRED_TOO)).id }), args.setPointer),

  compileAppAgentBootPrompt: (_: unknown, args: { appRef: string; agentRef: string }, ctx: Context) =>
    run(ctx, async () => ({
      kind: 'APP_AGENT',
      appId: (await resolveAppRef(ctx.db, args.appRef)).id,
      agentId: (await resolveAgentRef(ctx.db, args.agentRef, RETIRED_TOO)).id,
    }), true),

  compileWorkerBootPrompt: (_: unknown, args: { workerRef: string; setPointer?: boolean | null }, ctx: Context) =>
    run(ctx, async () => ({ kind: 'WORKER', workerId: (await resolveWorkerRef(ctx.db, args.workerRef)).id }), args.setPointer),
};
