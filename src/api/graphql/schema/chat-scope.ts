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
 * Lazy-provision the app-class memory for an `(App, Agent)` pair. On
 * first call creates a `class='app'` memory with URN
 * `${app.urn}:${agentSlug}:shared`; subsequent calls for the same pair
 * return the existing memory's id.
 *
 * One app-class memory per `(app, agent)`, not per `app` alone — the
 * 2026-05-12-user-installing-app design discussion (§3) reintroduced
 * the multi-Agent App via the `AppAgent` join, dropping `App.agentId`
 * as the single FK. Keying the shared memory by `(app, agent)` keeps
 * the chat-visibility decision (`shared` chats are scoped to one App
 * AND one Agent) intact across the upcoming 008-amendment migration:
 * two Agents installed in the same App will not collide on one shared
 * memory. The agent slug is derived from `agent.urn` — for an agent
 * with URN `<org-urn>:<agent-slug>` installed in App
 * `<org-urn>:<app-slug>`, the shared memory URN is
 * `<org-urn>:<app-slug>:<agent-slug>:shared`.
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
  /** The Agent the shared chat is conducted with. URN form
   *  `<org-urn>:<agent-slug>`; the slug is everything after the first
   *  colon segment. */
  agentUrn: string;
  agentName: string;
  organizationId: string;
  actingUserId: string;
  db: PrismaClient;
}): Promise<string> {
  const { appId, appUrn, appName, agentUrn, agentName, organizationId, actingUserId, db } = args;
  const agentSlug = agentUrn.split(':').slice(1).join(':');
  if (!agentSlug) {
    throw new Error(
      `findOrCreateAppClassMemory: agentUrn "${agentUrn}" has no slug segment after the org prefix.`,
    );
  }
  const urn = `${appUrn}:${agentSlug}:shared`;

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
        name: `${appName} — ${agentName} — shared chats`,
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
 * Build a Prisma `where`-clause fragment restricting node reads to the
 * chat's allowed read-set. This is the D5 retrieval-time enforcement
 * point from the 2026-05-12-chat-visibility design discussion:
 *
 *   "A `shared` chat's read-set is `{app-class memory, knowledge
 *    memory, agent system memory}`. Personal memory is excluded."
 *
 * Pass the returned object as the `accessFilter` argument to
 * `compileTemplate` (or as the access fragment in any future
 * memoryId-taking chat-tool dispatch). The fragment shape is
 * `{ memoryId: { in: <ids> } }` — when spread into a Prisma `where`,
 * it constrains node lookups to the allowed set.
 *
 * Why this is load-bearing: `compileTemplate`'s `where: { loc,
 * memoryId, ...accessFilter }` spreads the filter AFTER the literal
 * `memoryId` argument, which means a permissive `accessFilter`
 * (e.g. `memoryAccessFilter(ctx)`, returning every memory the caller
 * can read) effectively *broadens* the lookup beyond the chat's
 * holding memory. For a `shared` chat this means a Mustache reference
 * like `{{secret-data.field}}` would happily resolve against the
 * caller's own personal memory if a node named `secret-data` lives
 * there. The narrow filter here is the only thing standing between
 * a shared chat and the author's personal data — prompt-level
 * guardrails do not satisfy D5.
 */
export function chatScopeAccessFilter(
  chat: ChatScopeContext,
  attachments: ChatScopeAttachments,
): { memoryId: { in: string[] } } {
  const ids = Array.from(allowedReadSet(chat, attachments));
  return { memoryId: { in: ids } };
}

/**
 * Validate the chat-root node's stored scope matches the holding
 * memory's class (data-model.md §I-1):
 *
 *   data.scope === 'private'  ⟹  memory.class ∈ { personal, knowledge }
 *   data.scope === 'shared'   ⟺  memory.class === 'app'
 *
 * The `shared ⇔ app` half is load-bearing for the chat-visibility
 * privacy boundary: a shared chat in any other memory class is
 * corruption and we reject it before doing any work.
 *
 * The `private` half tolerates the legacy `knowledge`-class fallback.
 * `startChat`'s legacy-attachment branch (caller has no App context
 * and no per-user memory) stores chats in the agent's first writable
 * attached memory, which today is always `knowledge`-class. The
 * 20260512120000_chat_scope_backfill migration tags every pre-feature
 * chat-root with `data.scope='private'` regardless of holding memory
 * class, so after backfill the (private + knowledge) state is
 * permanent for those legacy chats. Migrating their content is out of
 * scope per spec 017 FR-018 ("no chat content moves between
 * memories").
 *
 * `allowMissingScope: true` (passed from `sendChatMessage` /
 * `processChatResponse`) tolerates pre-migration chats with no
 * `data.scope` set — these are functionally indistinguishable from
 * private chats and keep working until the backfill runs.
 *
 * Throws ChatScopeError('CHAT_MEMORY_OUT_OF_SCOPE') on a real
 * corruption.
 */
export function validateChatScopeInvariants(args: {
  /** From the chat-root node's `data`. */
  scope: 'private' | 'shared' | undefined;
  /** From the holding `Memory.class`. */
  memoryClass: 'personal' | 'app' | 'knowledge' | 'system';
  /** True during the migration window — treats missing `scope` as
   *  `private` for any non-shared memory class. */
  allowMissingScope?: boolean;
}): void {
  const { scope, memoryClass, allowMissingScope = false } = args;

  if (scope === undefined) {
    // The legacy migration-window path. Tolerate any non-shared memory
    // class (personal OR knowledge — the two homes legacy chats live
    // in). An app-class chat-root with no scope is corruption: app
    // memory was only introduced for shared chats post-017, so a row
    // there must have been written with explicit scope.
    if (allowMissingScope && (memoryClass === 'personal' || memoryClass === 'knowledge')) {
      return; // legacy private chat, awaiting or surviving backfill — OK
    }
    throw new ChatScopeError(
      'CHAT_MEMORY_OUT_OF_SCOPE',
      `Chat-root node missing data.scope (memory.class=${memoryClass}).`,
    );
  }

  if (scope === 'private' && memoryClass !== 'personal' && memoryClass !== 'knowledge') {
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
