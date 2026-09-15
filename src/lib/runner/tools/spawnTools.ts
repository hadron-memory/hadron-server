/**
 * Fan-out tools (plan-spawn, D-2026-05-09-018/-019):
 *
 *  - hadron_spawn — dispatch one independent child run per item, each
 *    walking `process_item`'s flow under the parent's principal. Optional
 *    `callback` (fires ONCE when all children are terminal) and
 *    `item_callback` (fires per child). The parent flow continues — no
 *    waiting state; the callback pattern replaces parent-side waiting.
 *  - hadron_child_runs — the reserved "h-children" aggregation surface:
 *    lets a callback run read its siblings' outcomes.
 *
 * Per-item mints go through the FULL launch gate (quota, policy, encrypted,
 * cross-org) — a fan-out cannot manufacture authority the trigger lacked.
 */

import { mintAppRun, mergedView, RunLaunchDeniedError } from '../../../jobs/appRuns.js';
import { resolveScopeForTrigger, snapshotScopeForTrigger } from '../../scopes.js';
import type { RunToolDef } from './types.js';

const MAX_SPAWN_ITEMS = (() => {
  const raw = Number(process.env.RUN_MAX_SPAWN_ITEMS);
  return Number.isFinite(raw) && raw > 0 ? raw : 20; // D-SP-5
})();
const MAX_SPAWN_DEPTH = (() => {
  const raw = Number(process.env.RUN_MAX_SPAWN_DEPTH);
  return Number.isFinite(raw) && raw > 0 ? raw : 2; // D-SP-7
})();

export const hadronSpawn: RunToolDef = {
  name: 'hadron_spawn',
  description:
    'Fan out: start one independent child run per item, each executing the process_item ' +
    'flow node with that item in its payload. Returns immediately with counts — children ' +
    'run in parallel. Optional callback node runs once when ALL children finish; optional ' +
    'item_callback node runs as EACH child finishes.',
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: `The work items — one child run per element (max ${MAX_SPAWN_ITEMS}).`,
      },
      process_item: {
        type: 'string',
        description: 'Fully-qualified URN of the flow node each child starts at.',
      },
      item_key: {
        type: 'string',
        description: 'Payload key each item lands under in the child (default "item").',
      },
      callback: {
        type: 'string',
        description: 'Optional node URN to run ONCE when all children have finished.',
      },
      item_callback: {
        type: 'string',
        description: 'Optional node URN to run as EACH child finishes.',
      },
      scope_ref: {
        type: 'string',
        description:
          'Optional named search scope (id or name, resolved in this App\'s context) every child ' +
          'and callback run searches under. Default: the scope this run itself carries.',
      },
    },
    required: ['items', 'process_item'],
  },
  cost: 1,
  execute: async (ctx, args) => {
    const items = Array.isArray(args.items) ? (args.items as unknown[]) : null;
    const processItem = typeof args.process_item === 'string' ? args.process_item : '';
    if (!items || items.length === 0 || !processItem) {
      throw new Error('hadron_spawn: "items" (non-empty array) and "process_item" (node URN) are required.');
    }
    if (items.length > MAX_SPAWN_ITEMS) {
      throw new Error(`hadron_spawn: ${items.length} items exceeds the per-call cap of ${MAX_SPAWN_ITEMS}.`);
    }
    const itemKey = typeof args.item_key === 'string' && args.item_key.length > 0 ? args.item_key : 'item';
    if (itemKey.startsWith('__')) {
      throw new Error('hadron_spawn: "item_key" must not use the reserved "__" prefix.');
    }
    // '' ≡ absent (PR-547 review, Gemini): an empty string must not persist
    // as a callback URN and fail at mint time.
    const callback = typeof args.callback === 'string' && args.callback.length > 0 ? args.callback : null;
    const itemCallback =
      typeof args.item_callback === 'string' && args.item_callback.length > 0 ? args.item_callback : null;
    // Spec 049 §3.3: the fan-out is scope-bearing like a schedule or webhook —
    // an explicit scope_ref is resolved in the App's context under the run
    // principal and snapshotted once, else every child inherits the parent's
    // snapshot verbatim. Persisted in the spawn config so the callbacks mint
    // under the same lens.
    let scopeSnapshot: unknown = ctx.run.scopeSnapshot;
    if (typeof args.scope_ref === 'string' && args.scope_ref.trim().length > 0) {
      const scopeId = await resolveScopeForTrigger(ctx.principal, ctx.run.appId, args.scope_ref);
      scopeSnapshot = await snapshotScopeForTrigger(ctx.db, scopeId);
    }

    // Depth guard (D-SP-7): walk the lineage — trees are legal, bombs are not.
    let depth = 0;
    let cursor = ctx.run.parentRunId;
    while (cursor && depth < MAX_SPAWN_DEPTH + 1) {
      depth++;
      const p = await ctx.db.appRun.findUnique({ where: { id: cursor }, select: { parentRunId: true } });
      cursor = p?.parentRunId ?? null;
    }
    if (depth >= MAX_SPAWN_DEPTH) {
      throw new Error(`hadron_spawn: spawn depth ${depth + 1} exceeds RUN_MAX_SPAWN_DEPTH (${MAX_SPAWN_DEPTH}).`);
    }

    // One fan-out per run (v1) — a second call would clobber the claim state.
    const fresh = await ctx.db.appRun.findUniqueOrThrow({
      where: { id: ctx.run.id },
      select: { spawn: true, eventData: true, data: true },
    });
    if (fresh.spawn) {
      throw new Error('hadron_spawn: this run already fanned out — one spawn per run in v1.');
    }

    // Persist config BEFORE minting, with the dispatch guard up (D-SP-4):
    // a fast first child must not fire the callback mid-dispatch.
    await ctx.db.appRun.update({
      where: { id: ctx.run.id },
      data: {
        spawn: {
          processItem, itemKey, callback, itemCallback,
          total: items.length, dispatching: true,
          ...(scopeSnapshot != null ? { scopeSnapshot } : {}),
        } as never,
      },
    });

    // D-SP-3: children see the parent's CURRENT view as trigger payload.
    const parentView = mergedView(
      fresh.eventData,
      fresh.data !== null && typeof fresh.data === 'object' && !Array.isArray(fresh.data)
        ? (fresh.data as Record<string, unknown>)
        : {},
    );

    let spawned = 0;
    let denied = 0;
    const deniedReasons: string[] = [];
    try {
      for (const item of items) {
        try {
          await mintAppRun(ctx.db, {
            organizationId: ctx.run.organizationId,
            appId: ctx.run.appId,
            agentId: ctx.run.agentId,
            userId: ctx.run.userId,
            triggerKind: 'SPAWN',
            triggerId: ctx.run.id,
            parentRunId: ctx.run.id,
            entryNodeUrn: processItem,
            eventData: { ...parentView, [itemKey]: item },
            // Spec 049: the fan-out's lens — the override or the parent's own.
            scopeSnapshot,
            createdBy: `run:${ctx.run.id}`,
          });
          spawned++;
        } catch (err) {
          // Per-item denial is DATA, not an exception (D-SP-5): spawned
          // children are independent and never orphan-cancelled.
          denied++;
          if (deniedReasons.length < 3) {
            deniedReasons.push(
              err instanceof RunLaunchDeniedError ? `${err.code}: ${err.message}` : String((err as Error)?.message ?? err),
            );
          }
        }
      }
    } finally {
      // Drop the dispatch guard even on crash-through; the terminal-parent
      // path in handleSpawnCompletion is the second net.
      await ctx.db.$executeRaw`
        UPDATE app_runs SET spawn = spawn - 'dispatching' WHERE id = ${ctx.run.id}`;
    }
    if (spawned === 0) {
      // Remove the config entirely — a failed fan-out must never fire a
      // zero-children callback, even via the crash-stuck-guard clearing
      // path on the parent's terminal (PR-547 review, Gemini).
      await ctx.db.$executeRaw`UPDATE app_runs SET spawn = NULL WHERE id = ${ctx.run.id}`;
      // A fan-out that fanned out NOTHING is a malfunction (→ TOOL_FAILED).
      throw new Error(`hadron_spawn: no children could be spawned (${deniedReasons.join('; ')}).`);
    }
    ctx.log(`spawned ${spawned}/${items.length} child runs for ${processItem}${denied ? ` (${denied} denied)` : ''}`);
    return { spawned, denied, ...(deniedReasons.length > 0 ? { deniedReasons } : {}) };
  },
};

export const hadronChildRuns: RunToolDef = {
  name: 'hadron_child_runs',
  description:
    'List the child runs of a fan-out with their outcomes — status, extracted data, ' +
    'position, failure. Defaults to the fan-out THIS run belongs to (the common case ' +
    'inside a spawn callback). Coordination runs (callbacks) are excluded.',
  inputSchema: {
    type: 'object',
    properties: {
      parentRunId: {
        type: 'string',
        description: 'The fan-out parent run id. Default: this run\'s own parent.',
      },
    },
  },
  cost: 0,
  execute: async (ctx, args) => {
    const parentRunId =
      typeof args.parentRunId === 'string' && args.parentRunId.length > 0
        ? args.parentRunId
        : ctx.run.parentRunId;
    if (!parentRunId) {
      throw new Error('hadron_child_runs: no parentRunId given and this run has no parent.');
    }
    // Same-app scope: a run cannot read another App's fan-outs.
    const parent = await ctx.db.appRun.findUnique({
      where: { id: parentRunId },
      select: { appId: true },
    });
    if (!parent || parent.appId !== ctx.run.appId) {
      throw new Error(`hadron_child_runs: fan-out "${parentRunId}" not found for this App.`);
    }
    const children = await ctx.db.appRun.findMany({
      where: { parentRunId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, status: true, data: true, curNodeUrn: true, failure: true, eventData: true },
    });
    return children
      .filter((c) => !(c.eventData as Record<string, unknown> | null)?.__spawnCallback)
      .map((c) => ({
        id: c.id,
        status: c.status,
        data: c.data,
        curNodeUrn: c.curNodeUrn,
        failure: c.failure,
      }));
  },
};

export const SPAWN_TOOLS: readonly RunToolDef[] = [hadronSpawn, hadronChildRuns];
