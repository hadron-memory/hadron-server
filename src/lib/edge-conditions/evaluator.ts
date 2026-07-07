/**
 * Top-level edge-condition evaluator. Async outer shell (memory layer
 * reads can be async — encrypted memory needs a session-key check),
 * synchronous JSONLogic engine over a pre-resolved variable bag.
 *
 * Implements the contract in
 * `spec-kits/specs/001-edge-condition-spec/contracts/evaluator-api.md`.
 */

// Default import, NOT `* as`: json-logic-js is CJS, and under real Node ESM
// (the built image) the namespace form yields `{default: {...}}` with no
// `.apply` — while vitest's transform interop masks it, so tests pass and
// production crashes ("jsonLogic.apply is not a function", first hit by the
// first live multi-node run, 2026-07-07). esModuleInterop makes the default
// import correct in both environments.
import jsonLogic from 'json-logic-js';
import type { EvaluationError } from './errors.js';
import { validateEdgeCondition } from './validator.js';
import { preResolveVariables, type MemoryLayerHandle } from './scope-resolver.js';

export interface EvaluateRequest {
  /** The JSONLogic expression. Null/undefined = always fires. */
  condition: unknown;
  /** Used in error reporting. */
  edge: { id: string; sourceNodeUrn: string };
  /** Memory layers in cascade order: edge-memory first, user-memory second.
      Single-user agents pass a single-element array. */
  memoryLayers: ReadonlyArray<MemoryLayerHandle>;
  /** Chat/session bag. Absent on non-chat surfaces. */
  chat?: Readonly<Record<string, unknown>>;
  /** Agent config/state bag. Always present. */
  agent: Readonly<Record<string, unknown>>;
  /** Pre-extracted per-message data. Absent on surfaces with no message. */
  messageData?: Readonly<Record<string, unknown>>;
  /** Clock injection point for now() / today(). Defaults to wall clock. */
  clock?: () => Date;
}

export type EvaluateResult =
  | { ok: true; fired: boolean }
  | { ok: false; error: EvaluationError };

/**
 * Evaluate a single edge's condition.
 *
 * Steps (per the contract):
 *   1. null/undefined condition → always fires.
 *   2. Structural validation (operators, scopes, reserved names, size,
 *      depth).
 *   3. Pre-resolve variables (memory cascade + chat/agent/message/time).
 *      Encrypted-memory failures surface here.
 *   4. Run JSONLogic engine over the pre-resolved bag.
 *   5. Return fired = Boolean(result).
 */
export async function evaluateEdgeCondition(
  req: EvaluateRequest,
): Promise<EvaluateResult> {
  if (req.condition === null || req.condition === undefined) {
    return { ok: true, fired: true };
  }

  const validation = validateEdgeCondition(req.condition);
  if (!validation.ok) {
    return {
      ok: false,
      error: {
        ...validation.error,
        detail: { ...validation.error.detail, edgeId: req.edge.id },
      },
    };
  }

  const clock = req.clock ?? (() => new Date());
  const resolved = await preResolveVariables(req.condition, {
    edgeId: req.edge.id,
    memoryLayers: req.memoryLayers,
    chat: req.chat,
    agent: req.agent,
    messageData: req.messageData,
    clock,
  });
  if (!resolved.ok) return resolved;

  // The JSONLogic engine's RulesLogic type is over-constrained for our
  // runtime-validated inputs; cast to the loose runtime API.
  const result = jsonLogic.apply(req.condition as never, resolved.bag);
  return { ok: true, fired: Boolean(result) };
}

// Re-export validateEdgeCondition for consumers who only need save-time
// validation (GraphQL resolvers, the on-disk import path) — they don't
// need the async evaluator surface.
export { validateEdgeCondition };
