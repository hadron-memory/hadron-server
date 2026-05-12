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
 */
export async function findOrCreateAppClassMemory(args: {
  appId: string;
  appUrn: string;
  appName: string;
  organizationId: string;
  actingUserId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
}): Promise<string> {
  const { appId, appUrn, appName, organizationId, actingUserId, db } = args;

  const existing = await db.memory.findFirst({
    where: { appId, class: 'app', deletedAt: null },
    select: { id: true },
  });
  if (existing) {
    return existing.id;
  }

  const created = await db.memory.create({
    data: {
      organizationId,
      urn: `${appUrn}:shared`,
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
}

/** Discriminator for chat-scope errors so callers can distinguish them. */
export type ChatScopeErrorCode =
  | 'SHARED_CHAT_REQUIRES_APP_CONTEXT'
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
