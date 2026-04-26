/**
 * Typed errors raised by the edge-condition evaluator. Stable codes that
 * callers can switch on; messages are safe to log but not safe to display
 * to end users (the user-facing surface maps codes to plain-language
 * strings — see user-messages.ts when it lands in US4).
 *
 * Codes match the contract in
 * `spec-kits/specs/001-edge-condition-spec/contracts/evaluator-api.md`.
 */

export type EvaluationErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_JSONLOGIC'
  | 'DISALLOWED_OPERATOR'
  | 'UNKNOWN_SCOPE'
  | 'RESERVED_NAME'
  | 'AST_TOO_LARGE'
  | 'AST_TOO_DEEP'
  | 'MEMORY_ENCRYPTED_NO_KEY'
  | 'TYPE_MISMATCH';

export interface EvaluationErrorDetail {
  edgeId?: string;
  field?: string;
  operator?: string;
  memoryUrn?: string;
}

export interface EvaluationError {
  code: EvaluationErrorCode;
  message: string;
  detail: EvaluationErrorDetail;
}

/**
 * Returned by a memory layer's `read()` when the layer cannot fulfill the
 * read because the memory is encrypted and the active session has no key.
 * The evaluator translates this into an `EvaluationError` with code
 * `MEMORY_ENCRYPTED_NO_KEY`.
 */
export interface EncryptedMemoryError {
  reason: 'key_unavailable';
  memoryUrn: string;
}
