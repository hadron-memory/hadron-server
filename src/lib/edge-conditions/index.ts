/**
 * Public entry point for the edge-condition evaluator. Callers (the edge
 * resolver, hooks, future routing/access rules) import from here so the
 * internal module layout can evolve without breaking consumers.
 */

export {
  evaluateEdgeCondition,
  validateEdgeCondition,
  type EvaluateRequest,
  type EvaluateResult,
} from './evaluator.js';
export type { ValidateResult } from './validator.js';
export type { MemoryLayerHandle, ScopeReadCtx } from './scope-resolver.js';
export type {
  EvaluationError,
  EvaluationErrorCode,
  EvaluationErrorDetail,
  EncryptedMemoryError,
} from './errors.js';
export {
  V1_OPERATORS,
  V1_OPERATORS_SET,
  VALID_SCOPE_PREFIXES,
  VALID_BUILTINS,
  RESERVED_VAR_PATHS,
} from './operators.js';
export {
  validateExtractionSpec,
  validateNodeDataExtractionSpecs,
  type ExtractionSpecEntry,
  type ExtractionSpecValidateResult,
} from './reserved-names.js';
export { userMessageFor, type UserMessage } from './user-messages.js';
