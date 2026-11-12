/**
 * #4039 (cor:cht:020:02, plan D7/D9): a conversation's ENTRY condition, `data.entryCondition` on a
 * depth-2 `conversations:<name>` node. It is the completion-rule condition form restricted to what exists
 * before a chat does: `memory.*` and `agent.*` variables and the `now()` / `today()` builtins. A `chat.*` or
 * `message.data.*` variable has no value at start and is refused when saved and again when evaluated.
 */
import { validateEdgeCondition } from './validator.js';
import type { EvaluationError } from './errors.js';

/** The `data` key that carries the condition. */
export const ENTRY_CONDITION_KEY = 'entryCondition';

/** True for a top-level conversation node loc (`conversations:<name>`), in any memory. */
export function isConversationLoc(loc: string): boolean {
  const parts = loc.split(':');
  return parts.length === 2 && parts[0] === 'conversations' && parts[1] !== '';
}

/** The condition a write would store on `loc` with `data`, or `undefined` when `loc` is not a conversation or carries none. */
export function entryConditionOf(loc: string, data: unknown): unknown {
  if (!isConversationLoc(loc)) return undefined;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const c = (data as Record<string, unknown>)[ENTRY_CONDITION_KEY];
  return c === null ? undefined : c;
}

const PATH_OPS = new Set(['var', 'missing', 'missing_some']);
/** Marker for a computed variable path: refused, since its value is unknown until evaluation. */
const COMPUTED_PATH = '<computed path>';
const UNAVAILABLE_PREFIXES = ['chat.', 'message.data.'];

function unavailablePath(node: unknown, depth = 0): string | null {
  if (depth > 64 || node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = unavailablePath(child, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [op, args] of Object.entries(node as Record<string, unknown>)) {
    if (PATH_OPS.has(op)) {
      const candidates: unknown[] = op === 'var'
        ? [Array.isArray(args) ? args[0] : args]
        : op === 'missing' ? (Array.isArray(args) ? args : [args])
        : op === 'missing_some' && Array.isArray(args) ? (Array.isArray(args[1]) ? args[1] : [args[1]]) : [];
      for (const c of candidates) {
        if (typeof c === 'string' && UNAVAILABLE_PREFIXES.some((p) => c.startsWith(p))) return c;
        // A path that is computed (an expression, not a literal) cannot be checked against the start scope.
        if (c !== null && c !== undefined && typeof c === 'object') return COMPUTED_PATH;
      }
    }
    const hit = unavailablePath(args, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Edge-condition validation plus the start-time scope rule. Null/undefined is valid (the conversation always holds). */
export function validateEntryCondition(condition: unknown): { ok: true } | { ok: false; error: EvaluationError } {
  const base = validateEdgeCondition(condition);
  if (!base.ok) return base;
  const field = unavailablePath(condition);
  if (field === COMPUTED_PATH) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_SCOPE',
        message: 'an entry condition may name a variable only by a literal memory.* or agent.* path, not a computed one',
        detail: { field },
      },
    };
  }
  if (field) {
    return {
      ok: false,
      error: {
        code: 'SCOPE_NOT_AVAILABLE_AT_START',
        message: `'${field}' has no value when a chat starts; an entry condition may read only memory.* and agent.* variables`,
        detail: { field },
      },
    };
  }
  return { ok: true };
}

/** The reason for a refused start (B3): the evaluation codes plus the two the start itself raises. */
export type EntryStartReason = EvaluationError['code'] | 'MEMORY_UNREADABLE';

/** Stable message ids, with English defaults, for `ENTRY_CONDITION_FAILED`. Next to the edge-condition `user-messages.ts` ids. */
export function entryStartMessageFor(reason: EntryStartReason): { id: string; text: string } {
  switch (reason) {
    case 'MEMORY_ENCRYPTED_NO_KEY':
      return {
        id: 'chat-start.error.memory_encrypted_no_key',
        text: 'This chat needs your password to unlock your private memory before it can start. Please re-enter your password and try again.',
      };
    case 'MEMORY_UNREADABLE':
      return {
        id: 'chat-start.error.memory_unreadable',
        text: "This chat can't read the memory it keeps your details in, so it cannot choose where to start. Please contact the person who set it up.",
      };
    case 'TYPE_MISMATCH':
      return {
        id: 'chat-start.error.type_mismatch',
        text: "A start condition in this agent compared values of incompatible types. The agent's author needs to review it.",
      };
    default:
      return {
        id: 'chat-start.error.invalid_condition',
        text: "A start condition in this agent is invalid. The agent's author needs to fix it before this chat can start.",
      };
  }
}
