/**
 * #1606 / #1607 — comment nodes (`cor:dmo:110`): the pure parts shared by the
 * GraphQL comment path, the generic-path refusals and the mint/approval
 * exclusion. The contract of record is
 * `hrn:node:hadronmemory.com:hadron-server:design:comment-nodes-contract`.
 */
import { GraphQLError } from 'graphql';
import { currentActor } from '../requestActor.js';

/** The node type the comment path owns (`cor:dmo:020:04`). */
export const COMMENT_NODE_TYPE = 'comment';

/** Memory classes a comment may live in (`cor:dmo:110:02`). */
export const COMMENTABLE_CLASSES: ReadonlySet<string> = new Set(['app', 'knowledge', 'personal', 'group']);

export const COMMENT_BODY_MAX = 20_000;
export const COMMENT_QUOTE_MAX = 2_000;
export const COMMENT_REASON_MAX = 2_000;

/** The loc of a comment node and of its governed edge. Permanent: ids never change. */
export const commentLoc = (nodeId: string) => `comments:${nodeId}`;
export const commentEdgeLoc = (nodeId: string, kind: 'anchor' | 'reply') => `comments:${nodeId}:${kind}`;

export type CommentAuthorKind = 'WORKER' | 'USER' | 'USER_AGENT' | 'APP';

export type ParsedAuthorKey =
  | { kind: 'WORKER'; workerId: string }
  | { kind: 'USER_AGENT'; userId: string; agentId: string }
  | { kind: 'USER'; userId: string }
  | { kind: 'APP'; appId: string };

/** The principal fields an author key is derived from. */
export type CommentPrincipal = { userId?: string | null; appId?: string | null };

/**
 * The author key of the current request (`cor:dmo:110:03`, `110:05`), or null
 * when the caller has no principal that can author.
 *
 * Derived from the SAME source #1610 stamps `createdBy*` from: the request's
 * validated actor (`currentActor()`) plus the authenticated user / App, never
 * from arguments. So a comment's author key and its node's `createdBy*` can
 * never disagree:
 *   - a worker session                → `w:<workerId>` (the user is provenance);
 *   - a user with an unnamed agent    → `ua:<userId>:<agentId>`;
 *   - a user                          → `u:<userId>`;
 *   - an App key with no user         → `app:<appId>`.
 */
export function authorKeyOf(principal: CommentPrincipal): string | null {
  const actor = currentActor();
  if (actor.workerId) return `w:${actor.workerId}`;
  if (principal.userId && actor.agentId) return `ua:${principal.userId}:${actor.agentId}`;
  if (principal.userId) return `u:${principal.userId}`;
  if (principal.appId) return `app:${principal.appId}`;
  return null;
}

/** Parse a stored author / actor key. Throws on a malformed key (the DB CHECK forbids one). */
export function parseAuthorKey(key: string): ParsedAuthorKey {
  const [prefix, a, b] = key.split(':');
  if (prefix === 'w' && a) return { kind: 'WORKER', workerId: a };
  if (prefix === 'ua' && a && b) return { kind: 'USER_AGENT', userId: a, agentId: b };
  if (prefix === 'u' && a) return { kind: 'USER', userId: a };
  if (prefix === 'app' && a) return { kind: 'APP', appId: a };
  throw new Error(`malformed comment author key: ${key}`);
}

/** The typed refusal codes of the comment path (contract §5). */
export type CommentRefusalCode =
  | 'COMMENT_TARGET_NOT_FOUND'
  | 'COMMENT_NOT_FOUND'
  | 'COMMENT_FORBIDDEN'
  | 'COMMENT_TARGET_IS_COMMENT'
  | 'COMMENT_MEMORY_NOT_COMMENTABLE'
  | 'COMMENT_OPEN_THREAD_EXISTS'
  | 'COMMENT_ANCHOR_REVISION_INVALID'
  | 'COMMENT_ANCHOR_REVISION_UNAVAILABLE'
  | 'COMMENT_NOT_AUTHOR'
  | 'COMMENT_RETRACTED'
  | 'COMMENT_HIDDEN'
  | 'COMMENT_NOT_TOP_LEVEL'
  | 'COMMENT_THREAD_STATE'
  | 'COMMENT_ADMIN_REQUIRED'
  | 'COMMENT_IMPERSONATION_REFUSED'
  | 'COMMENT_BODY_INVALID'
  | 'COMMENT_MOVE_UNCOMMENTABLE'
  | 'COMMENT_MERGE_FOLDS_THREADS'
  | 'COMMENT_NOT_APPROVABLE';

/** A typed comment refusal: `extensions.code` plus the code's documented extensions. */
export function commentError(
  code: CommentRefusalCode,
  message: string,
  extensions: Record<string, unknown> = {},
): GraphQLError {
  return new GraphQLError(message, { extensions: { code, ...extensions } });
}

/**
 * Validate a body: non-blank, at most {@link COMMENT_BODY_MAX} characters.
 * Returned unchanged (whitespace is the author's).
 */
export function validateBody(body: string): string {
  if (body.trim().length === 0) {
    throw commentError('COMMENT_BODY_INVALID', 'A comment body cannot be empty.', { field: 'body', max: COMMENT_BODY_MAX });
  }
  if (body.length > COMMENT_BODY_MAX) {
    throw commentError('COMMENT_BODY_INVALID', `A comment body is at most ${COMMENT_BODY_MAX} characters.`, { field: 'body', max: COMMENT_BODY_MAX });
  }
  return body;
}

/** Validate an optional quote; a blank quote is stored as none. */
export function validateQuote(quote: string | null | undefined): string | null {
  if (quote == null || quote.trim().length === 0) return null;
  if (quote.length > COMMENT_QUOTE_MAX) {
    throw commentError('COMMENT_BODY_INVALID', `A quote is at most ${COMMENT_QUOTE_MAX} characters.`, { field: 'quote', max: COMMENT_QUOTE_MAX });
  }
  return quote;
}

/** Validate a moderation reason (hide, thread delete): required, bounded. */
export function validateReason(reason: string): string {
  if (reason.trim().length === 0 || reason.length > COMMENT_REASON_MAX) {
    throw commentError('COMMENT_BODY_INVALID', `A reason is required, at most ${COMMENT_REASON_MAX} characters.`, { field: 'reason', max: COMMENT_REASON_MAX });
  }
  return reason;
}

/**
 * What a comment node keeps in `Node.data` (encrypted with the body on an
 * encrypted memory). `lastAction` names the comment-path operation that last
 * wrote the row. A comment keeps no revision history (#1721, cor:dmo:110:12).
 */
export type CommentNodeData = {
  quote: string | null;
  hiddenReason?: string | null;
  deleteReason?: string | null;
  lastAction: { op: CommentOp; by: string; at: string };
  /**
   * #1721 — who last edited the body or quote, and when (cor:dmo:110:12).
   * Set by an edit only; resolve, reopen and delete leave it alone, so it is
   * the comment's "edited" record. Absent on a comment never edited.
   */
  lastEdit?: { by: string; at: string };
};

export type CommentOp = 'create' | 'reply' | 'edit' | 'retract' | 'resolve' | 'reopen' | 'hide' | 'delete-thread';

/** Read the comment fields out of a (decrypted) `Node.data`, tolerating absence. */
export function commentDataOf(data: unknown): Partial<CommentNodeData> {
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as Partial<CommentNodeData>) : {};
}

/**
 * The `ROLE_GOVERNED` refusal for a generic write that would produce, remove
 * or edit a comment (`cor:dmo:110:04`), in the shape the governed-kind gate
 * uses (`src/lib/governedRole.ts`) so clients handle it as one code. Comments
 * are not a `GOVERNED_KINDS` entry: that register generates create/update
 * door mutations, and the comment path's doors are its own §4 operations.
 */
export function commentGovernedError(
  op: 'create' | 'update' | 'delete' | 'move' | 'merge' | 'edge' | 'restore' | 'import',
  refusal: 'produces' | 'removes' | 'edits',
): GraphQLError {
  const what = refusal === 'produces' ? 'create a comment' : refusal === 'removes' ? 'turn a comment into another node' : 'change a comment';
  return new GraphQLError(
    `ROLE_GOVERNED: a generic ${op} cannot ${what}. Comments are written only through the comment operations (createComment, replyToComment, editComment, retractComment, resolveCommentThread, reopenCommentThread, hideComment, deleteCommentThread).`,
    { extensions: { code: 'ROLE_GOVERNED', kind: 'comment', strength: 'integrity', door: 'createComment', mcpDoor: null, op, refusal } },
  );
}

/**
 * Refuse a generic node write whose prior or next type is `comment`
 * (`cor:dmo:110:04`): no generic path creates a comment, converts one into
 * another type, converts another node into one, or edits a comment.
 */
export function assertNotCommentWrite(
  priorType: string | null | undefined,
  nextType: string | null | undefined,
  op: Parameters<typeof commentGovernedError>[0],
): void {
  const was = priorType === COMMENT_NODE_TYPE;
  const willBe = nextType === COMMENT_NODE_TYPE;
  if (!was && willBe) throw commentGovernedError(op, 'produces');
  if (was && !willBe && nextType != null) throw commentGovernedError(op, 'removes');
  if (was) throw commentGovernedError(op, 'edits');
}

/** Whether `error` is the comment-path {@link commentGovernedError} refusal. */
export function isCommentGovernedError(error: unknown): boolean {
  return error instanceof GraphQLError && error.extensions.code === 'ROLE_GOVERNED' && error.extensions.kind === 'comment';
}
