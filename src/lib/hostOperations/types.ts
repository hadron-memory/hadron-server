/**
 * #1709 (Task Management T6) — the closed set of host operations and their
 * typed arguments (cor:agt:070:03; the per-type arguments are #1709's T6
 * table, Proposed until folded into the spec).
 *
 * A host carries out only these five types, never a free-form command. Every
 * argument is an id or a name token: a token starts with a letter or digit (so
 * it is never an option), uses only letters, digits and `. _ / @ + -`, and has
 * no `..`, `//` or trailing `/` (so it is never a path escape). A host resolves
 * a repo, worktree or family through its own registration and configuration;
 * the platform never names a path or a command. The database holds the same
 * shapes (prisma/host-operation-invariants.sql `host_operation_args_ok`).
 */

import { normalizeFamily } from '../agentTasks/family.js';

/** The closed set (cor:agt:070:03). */
export const HOST_OPERATION_TYPES = ['worktree.create', 'worker.start', 'worker.deliver', 'worker.end', 'worktree.remove'] as const;
export type HostOperationType = (typeof HOST_OPERATION_TYPES)[number];

export const isHostOperationType = (v: unknown): v is HostOperationType =>
  typeof v === 'string' && (HOST_OPERATION_TYPES as readonly string[]).includes(v);

/** cor:agt:070:02 — `collected` is #1709's addition (Proposed). */
export const HOST_OPERATION_STATUSES = ['issued', 'collected', 'succeeded', 'failed'] as const;
export type HostOperationStatus = (typeof HOST_OPERATION_STATUSES)[number];

/** A name argument. Same shape as `host_operation_token_ok` in prisma/agent-task-matching-invariants.sql. */
export const HOST_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,255}$/;
/** An id argument (a worker, session, event or task id). */
export const HOST_ID_ARG_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** At most this many worktrees per worker in one registration. */
export const HOST_WORKTREES_MAX = 32;
/** A failure reason the host reports, at most this long. */
export const HOST_FAILURE_REASON_MAX = 2000;

export function isHostToken(v: unknown): v is string {
  return typeof v === 'string' && HOST_TOKEN_PATTERN.test(v) && !v.includes('..') && !v.includes('//') && !v.endsWith('/');
}

type ArgKind = 'id' | 'token' | 'family';

/** Each type's arguments: name → kind, and which are optional. `workerId` is on every type. */
const ARGS: Record<HostOperationType, { required: Record<string, ArgKind>; optional?: Record<string, ArgKind> }> = {
  'worktree.create': { required: { workerId: 'id', repo: 'token', baseBranch: 'token', branchName: 'token', label: 'token' } },
  'worker.start': { required: { workerId: 'id', worktree: 'token', family: 'family' }, optional: { taskId: 'id' } },
  'worker.deliver': { required: { workerId: 'id', sessionId: 'id', eventId: 'id' } },
  'worker.end': { required: { workerId: 'id', sessionId: 'id' } },
  'worktree.remove': { required: { workerId: 'id', worktree: 'token' } },
};

const FAMILY = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A refusal of an operation's type or arguments at issue; nothing was written. */
export class HostOperationArgsError extends Error {
  constructor(readonly code: 'HOST_OPERATION_TYPE_UNKNOWN' | 'BAD_HOST_OPERATION_ARGS', message: string) {
    super(message);
    this.name = 'HostOperationArgsError';
  }
}

/**
 * Validate an operation's type and arguments, returning the arguments exactly
 * as they will be stored: only the type's own keys, each a string of its kind.
 * An unknown type is refused `HOST_OPERATION_TYPE_UNKNOWN` (cor:agt:070:03 S2:
 * `shell` among them); a missing, extra or malformed argument
 * `BAD_HOST_OPERATION_ARGS`.
 */
export function validateHostOperation(type: unknown, args: unknown): { type: HostOperationType; args: Record<string, string> } {
  if (!isHostOperationType(type)) {
    throw new HostOperationArgsError(
      'HOST_OPERATION_TYPE_UNKNOWN',
      `A host runs only these operations: ${HOST_OPERATION_TYPES.join(', ')}. There is no other type, and no free-form command.`,
    );
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new HostOperationArgsError('BAD_HOST_OPERATION_ARGS', `${type} takes an object of arguments.`);
  }
  const spec = ARGS[type];
  const allowed = { ...spec.required, ...(spec.optional ?? {}) };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    const kind = allowed[k];
    if (!kind) {
      throw new HostOperationArgsError('BAD_HOST_OPERATION_ARGS', `${type} has no argument "${k}". Its arguments are: ${Object.keys(allowed).join(', ')}.`);
    }
    if (v === null || v === undefined) continue;
    const ok = kind === 'id' ? typeof v === 'string' && HOST_ID_ARG_PATTERN.test(v)
      : kind === 'family' ? typeof v === 'string' && FAMILY.test(v)
      : isHostToken(v);
    if (!ok) {
      const what = kind === 'id' ? 'an id' : kind === 'family' ? 'a lowercase model family token'
        : 'a name token (letters, digits and . _ / @ + -, starting with a letter or digit, no "..", "//" or trailing "/")';
      throw new HostOperationArgsError('BAD_HOST_OPERATION_ARGS', `${type}'s "${k}" must be ${what}.`);
    }
    out[k] = kind === 'family' ? normalizeFamily(v as string)! : v as string;
  }
  for (const k of Object.keys(spec.required)) {
    if (!(k in out)) throw new HostOperationArgsError('BAD_HOST_OPERATION_ARGS', `${type} needs "${k}".`);
  }
  return { type, args: out };
}
