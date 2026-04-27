/**
 * Maps EvaluationError codes to plain-language, user-facing messages.
 *
 * Per Constitution Principle III: error messages MUST state what
 * happened in human terms AND what the user can do about it. The
 * mapping lives in one place so the portal i18n layer can route
 * through these strings (replacing English defaults with localized
 * copy without changing call sites).
 *
 * The string IDs here are stable; the English text is the default
 * fallback. When the platform-wide i18n migration lands, callers
 * pass the ID through `t(id, defaultText)` to look up localized
 * copy.
 */

import type { EvaluationError } from './errors.js';

export interface UserMessage {
  /** Stable string ID for i18n lookup. */
  id: string;
  /** English default text — what the user sees today. */
  text: string;
}

const FALLBACK: UserMessage = {
  id: 'edge-conditions.error.unknown',
  text: 'Something went wrong while routing this conversation. Please try again, or contact support if it keeps happening.',
};

/**
 * Map an EvaluationError to the message the user should see. Always
 * returns a usable message; unknown codes fall back to a generic one.
 */
export function userMessageFor(error: EvaluationError): UserMessage {
  switch (error.code) {
    case 'MEMORY_ENCRYPTED_NO_KEY':
      return {
        id: 'edge-conditions.error.memory_encrypted_no_key',
        text: 'This conversation needs your password to unlock your private memory before it can continue. Please re-enter your password and try again.',
      };
    case 'INVALID_JSON':
    case 'INVALID_JSONLOGIC':
    case 'DISALLOWED_OPERATOR':
    case 'UNKNOWN_SCOPE':
    case 'RESERVED_NAME':
    case 'AST_TOO_LARGE':
    case 'AST_TOO_DEEP':
      return {
        id: 'edge-conditions.error.invalid_condition',
        text: "An edge in this agent has an invalid condition. The agent's author needs to fix it before this conversation can continue.",
      };
    case 'TYPE_MISMATCH':
      return {
        id: 'edge-conditions.error.type_mismatch',
        text: "An edge condition compared values of incompatible types. The agent's author needs to review the condition.",
      };
    default:
      return FALLBACK;
  }
}
