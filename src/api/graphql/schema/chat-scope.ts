/**
 * Spec 017 — Chat scope enforcement.
 *
 * Two helpers + one error class supporting the two-tier chat-visibility
 * model:
 *
 *   - `allowedReadSet(chat, attachments)` — pure predicate over the
 *     set of memory ids a chat is permitted to read from during
 *     grounding/retrieval or any memory-touching tool call.
 *
 *   - `findOrCreateAppClassMemory(args)` — lazy provisioner mirroring
 *     the existing personal-memory provisioner pattern. Creates the
 *     app-class memory on first shared chat for an App; idempotent
 *     on subsequent calls.
 *
 *   - `ChatScopeError` — typed error thrown when a chat attempts to
 *     read from a memory outside its allowed read-set, OR when a
 *     `shared` chat is requested without a resolvable App context.
 */

import { Prisma, type PrismaClient } from '../../../generated/prisma/index.js';

/** Resolved description of a chat sufficient to compute its read-set. */
export interface ChatScopeContext {
  scope: 'private' | 'shared';
  /** The chat's holding memory (personal-class for private, app-class for shared). */
  memoryId: string;
  /** The App the chat is conducted under, if any. */
  appId: string | null;
  /** The chat's author (chat-root node's createdBy). */
  authorUserId: string;
  /** The agent serving the chat. */
  agentId: string;
}

/** Auxiliary input needed to materialize the agent-attached read targets. */
export interface ChatScopeAttachments {
  /** Memory ids attached to the agent as knowledge-class (read-only). */
  knowledgeMemoryIds: readonly string[];
  /** The agent's system memory id (read-only). */
  systemMemoryId: string | null;
  /**
   * The App's app-class memory id, if one has been provisioned.
   * For private chats under an App, this allows reading shared content
   * during grounding. For shared chats, this MUST equal `chat.memoryId`
   * (the chat is stored there).
   */
  appClassMemoryId: string | null;
}

/**
 * Compute the set of memory ids a chat is permitted to read from.
 *
 * Invariants (spec 017 FR-013/014/015; data-model.md §I-3):
 *
 *   - `shared` chats MUST NOT include any personal-class memory in
 *     the result — not the author's, not anyone else's. Callers are
 *     responsible for never passing a personal-class memory id in
 *     `attachments`; this function's safety property is "never add
 *     a personal id for a shared chat" — which it satisfies
 *     trivially since it has no personal-class memory input for the
 *     shared branch.
 *
 *   - `private` chats MAY read the author's own personal memory
 *     (which IS `chat.memoryId` for the private branch), the App's
 *     app-class memory (if any), and the knowledge + system memories.
 *
 *   - Cross-user personal-memory reads are excluded by construction:
 *     the access-control layer never resolves another user's personal
 *     memory id into `attachments` for the calling user, so it can't
 *     appear in the set.
 */
export function allowedReadSet(
  chat: ChatScopeContext,
  attachments: ChatScopeAttachments,
): Set<string> {
  const set = new Set<string>();

  // The chat's own holding memory is always readable. For a private
  // chat this is the author's personal memory; for a shared chat
  // this is the app-class memory.
  set.add(chat.memoryId);

  // Knowledge + system memories are always read-only contexts.
  for (const id of attachments.knowledgeMemoryIds) {
    set.add(id);
  }
  if (attachments.systemMemoryId) {
    set.add(attachments.systemMemoryId);
  }

  // For private chats under an App, the app-class memory is readable
  // (the user MAY want to ground their private chat against shared
  // family state). For shared chats, the app-class memory IS
  // chat.memoryId — already added above.
  if (chat.scope === 'private' && attachments.appClassMemoryId) {
    set.add(attachments.appClassMemoryId);
  }

  return set;
}

/**
 * Lazy-provision the app-class memory for an App. On first call
 * creates a `class='app'` memory with URN `${app.urn}:shared`;
 * subsequent calls return the existing memory's id.
 *
 * One app-class memory per App (not per `(app, agent)`): per spec
 * 008-agent-installation each App has at most one Agent, so the keys
 * are interchangeable.
 *
 * Mirrors the personal-memory provisioner pattern at
 * `resolvers.ts:3573-3625`.
 *
 * Concurrency + soft-delete handling: the lookup keys off `urn` (the
 * unique column) so a soft-deleted row with the same URN is found and
 * restored rather than colliding with a fresh `create`. The `create`
 * call is wrapped to recover from a concurrent winner — if another
 * request inserted the row between our findUnique and create, P2002
 * fires and we re-read instead of bubbling the failure.
 */
export async function findOrCreateAppClassMemory(args: {
  appId: string;
  appUrn: string;
  appName: string;
  organizationId: string;
  actingUserId: string;
  db: PrismaClient;
}): Promise<string> {
  const { appId, appUrn, appName, organizationId, actingUserId, db } = args;
  const urn = `${appUrn}:shared`;

  const existing = await db.memory.findUnique({
    where: { urn },
    select: { id: true, deletedAt: true },
  });
  if (existing) {
    if (existing.deletedAt) {
      await db.memory.update({
        where: { id: existing.id },
        data: { deletedAt: null, deletedBy: null },
      });
    }
    return existing.id;
  }

  try {
    const created = await db.memory.create({
      data: {
        organizationId,
        urn,
        name: `${appName} — shared chats`,
        class: 'app',
        visibility: 'PRIVATE',
        appId,
        userId: null,
        createdBy: actingUserId,
      },
      select: { id: true },
    });
    return created.id;
  } catch (err) {
    // Concurrent provisioner won the race. The winner left a live (non-
    // soft-deleted) row — re-read and return it. Soft-delete branch is
    // unreachable here in practice but kept for symmetry with the lookup
    // above.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      const race = await db.memory.findUnique({
        where: { urn },
        select: { id: true, deletedAt: true },
      });
      if (race) {
        if (race.deletedAt) {
          await db.memory.update({
            where: { id: race.id },
            data: { deletedAt: null, deletedBy: null },
          });
        }
        return race.id;
      }
    }
    throw err;
  }
}

/**
 * Validate the chat-root node's stored scope matches the holding
 * memory's class (data-model.md §I-1):
 *
 *   data.scope === 'private'  ⟺  memory.class === 'personal'
 *   data.scope === 'shared'   ⟺  memory.class === 'app'
 *
 * A violation is a corruption signal — a chat-root whose scope claims
 * one tier while its holding memory belongs to the other. Throws
 * ChatScopeError('CHAT_MEMORY_OUT_OF_SCOPE') so the chat-handling
 * resolvers can reject the chat early before doing any work that
 * would honor the corrupted state.
 *
 * Legacy chats whose `data.scope` is unset are treated as `'private'`
 * for the duration of the v1 release per FR-017's migration intent;
 * pass `{ allowMissingScope: true }` from `sendChatMessage` /
 * `processChatResponse` so pre-migration chats keep working until the
 * backfill runs (Phase 6, T036/T037).
 */
export function validateChatScopeInvariants(args: {
  /** From the chat-root node's `data`. */
  scope: 'private' | 'shared' | undefined;
  /** From the holding `Memory.class`. */
  memoryClass: 'personal' | 'app' | 'knowledge' | 'system';
  /** True during the migration window — treats missing `scope` as `private`. */
  allowMissingScope?: boolean;
}): void {
  const { scope, memoryClass, allowMissingScope = false } = args;

  if (scope === undefined) {
    if (allowMissingScope && memoryClass === 'personal') {
      return; // legacy private chat, awaiting backfill — OK
    }
    throw new ChatScopeError(
      'CHAT_MEMORY_OUT_OF_SCOPE',
      `Chat-root node missing data.scope (memory.class=${memoryClass}).`,
    );
  }

  if (scope === 'private' && memoryClass !== 'personal') {
    throw new ChatScopeError(
      'CHAT_MEMORY_OUT_OF_SCOPE',
      `Chat claims scope=private but holding memory.class=${memoryClass}.`,
    );
  }
  if (scope === 'shared' && memoryClass !== 'app') {
    throw new ChatScopeError(
      'CHAT_MEMORY_OUT_OF_SCOPE',
      `Chat claims scope=shared but holding memory.class=${memoryClass}.`,
    );
  }
}

/** Discriminator for chat-scope errors so callers can distinguish them. */
export type ChatScopeErrorCode =
  | 'SHARED_CHAT_REQUIRES_APP_CONTEXT'
  | 'SHARED_CHAT_NOT_AVAILABLE_FOR_APP_SESSIONS'
  | 'CHAT_MEMORY_OUT_OF_SCOPE';

/** Typed error thrown by the chat-scope layer. */
export class ChatScopeError extends Error {
  readonly code: ChatScopeErrorCode;

  constructor(code: ChatScopeErrorCode, message: string) {
    super(message);
    this.name = 'ChatScopeError';
    this.code = code;
  }
}
