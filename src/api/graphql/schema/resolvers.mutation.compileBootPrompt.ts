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
import { compileBootPrompt, compileNotPermitted, type CompileTargetInput } from './compileBootPrompt.js';
import type { Context } from './resolvers.helpers.js';

async function run(ctx: Context, resolve: () => Promise<CompileTargetInput>, setPointer: boolean | null | undefined) {
  let target: CompileTargetInput;
  try {
    target = await resolve();
  } catch {
    throw compileNotPermitted();
  }
  const result = await compileBootPrompt(ctx, target, { setPointer: setPointer ?? true });
  const node = await ctx.db.node.findUniqueOrThrow({ where: { id: result.nodeId } });
  // The compile never approves or signs.
  return { node, revNo: result.revNo, contentHash: result.contentHash, pointerSet: result.pointerSet, approvalIssued: false };
}

export const compileBootPromptMutations = {
  compileAgentBootPrompt: (_: unknown, args: { agentRef: string; setPointer?: boolean | null }, ctx: Context) =>
    run(ctx, async () => ({ kind: 'AGENT', agentId: (await resolveAgentRef(ctx.db, args.agentRef)).id }), args.setPointer),

  compileAppAgentBootPrompt: (_: unknown, args: { appRef: string; agentRef: string }, ctx: Context) =>
    run(ctx, async () => ({
      kind: 'APP_AGENT',
      appId: (await resolveAppRef(ctx.db, args.appRef)).id,
      agentId: (await resolveAgentRef(ctx.db, args.agentRef)).id,
    }), true),

  compileWorkerBootPrompt: (_: unknown, args: { workerRef: string; setPointer?: boolean | null }, ctx: Context) =>
    run(ctx, async () => ({ kind: 'WORKER', workerId: (await resolveWorkerRef(ctx.db, args.workerRef)).id }), args.setPointer),
};
