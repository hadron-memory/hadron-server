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

import { LINK_CAP_MEMORY_SELECT, agentLinkTenant, cappedLinkLevel } from '../../../lib/auth/agentMemoryLinkCap.js';
import { GraphQLError } from 'graphql';
import { Prisma, type PrismaClient } from '../../../generated/prisma/index.js';
import { mintMemoryUrnV2 } from '../../../lib/mintMemoryUrnV2.js';
import { isGrantedAgentMemoryRole } from '../../../lib/appAgent.js';
import { agentSlugFromUrn, normalizeUrnForLookup } from '../../../lib/urn.js';
import {
  agentSlugCandidates,
  memoryCarriesLegacyKeyFor,
} from '../../../lib/sharedMemoryLegacyKey.js';

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
 * AgentMemoryItem is global to the Agent, while a shared chat belongs to one
 * App. Only this App's knowledge (plus App-agnostic knowledge) can ground its
 * prompts. Strict-owner knowledge is available only to its owner.
 */
export async function sharedChatKnowledgeMemoryIds(
  db: PrismaClient,
  agentId: string,
  appId: string,
  callerUserId: string,
): Promise<string[]> {
  const items = await db.agentMemoryItem.findMany({
    where: {
      agentId, deletedAt: null,
      // A legacy user holding can be class='knowledge' with ownerUserId NULL.
      // userMemoryOfAgentId still makes it per-user, never shared-chat context.
      memory: { class: 'knowledge', deletedAt: null, userMemoryOfAgentId: null },
    },
    select: { memoryId: true, role: true, memory: { select: LINK_CAP_MEMORY_SELECT } },
  });
  // #1349: an item grounds the chat only as far as the Agent's tenant reaches
  // the memory on its own (cor:dmo:050:09) — a link is a limit, never a grant.
  const tenant = { ...(await agentLinkTenant(db, agentId)), appId, userId: callerUserId };
  return items
    .filter(({ role, memory }) =>
      isGrantedAgentMemoryRole(role) &&
      (memory.appId == null || memory.appId === appId) &&
      (memory.ownerUserId == null || memory.ownerUserId === callerUserId) &&
      cappedLinkLevel(tenant, memory, role) !== null,
    )
    .map(({ memoryId }) => memoryId);
}

/**
 * Display name for an App's shared app-class memory (#995).
 *
 * Both segments carry information when the App and the Agent are named
 * differently ("Eng Team WL — Second Agent — shared chats"). But for a **team**
 * App they are normally identical: the Team Agent and the App it is installed
 * as are one concept to a user, and `hadron team --help`'s getting-started
 * sequence installs an agent called "MM Eng Team" under the name "MM Eng Team".
 * Composing blindly then stutters — "MM Eng Team — MM Eng Team — shared chats" —
 * which was the DEFAULT outcome for teams, not an edge case.
 *
 * Compared EXACTLY rather than case/whitespace-insensitively: exact match covers
 * every observed case, and a fuzzy compare would silently collapse a distinction
 * someone made on purpose. Easy to loosen later; a wrong collapse is harder to
 * notice.
 *
 * Cosmetic only — nothing resolves by this name — and it is applied at the label
 * level so any future app-class memory kind beyond "shared chats" inherits it.
 */
export function sharedMemoryName(
  appName: string,
  agentName: string,
  kind = 'shared chats',
): string {
  const label = appName === agentName ? appName : `${appName} — ${agentName}`;
  return `${label} — ${kind}`;
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
 * Provision the app-class memory for an `(App, Agent)` pair. On first call
 * creates a `class='app'` memory carrying `sharedMemoryOfAgentId = agentId`;
 * subsequent calls for the same pair return the existing memory's id.
 *
 * #723 — the pair's identity is the `(appId, sharedMemoryOfAgentId)` COLUMN
 * unique, not the URN string it used to be (`${app.urn}:${agentSlug}:shared`).
 * The string key was the last thing pinning a memory to a compound v1 URN
 * (#722 Stage 3 flipped the other six creation sites): a multi-atom memory slug
 * means node URNs inside the memory don't round-trip through `splitNodeUrn`, so
 * the portal link a node read emits 404s — which is every team chat, since
 * `chats:team` lives in this memory by construction (#939). It also made the
 * lookup key move when the App was renamed, silently orphaning the memory and
 * provisioning a second one. With identity in a column the URN is minted FLAT
 * (`<root>:<app-slug>-shared`, aliased on collision) like every other memory,
 * and it can be re-minted later without disturbing find-or-create.
 *
 * Rows created before #723 carry no agent column, so the lookup falls back ONCE
 * to the old string key — matching `…:<agent-slug>:shared` in either `urn` or
 * `legacyUrn` (the #697 Task-A sweep moves the compound form there), scoped to
 * this App — and ADOPTS the match by writing the column. The migration adopts
 * them in bulk; this path covers whatever it left (an Agent installed after it
 * ran, an ambiguous match it declined to guess at) so no legacy pairing can
 * quietly get a second shared memory. The adoption does NOT rewrite the row's
 * urn: flattening an existing memory's address is the #697 backfill's job
 * (`pnpm admin:backfill-urn-v2`), which records the old value in `legacyUrn` so
 * existing references keep resolving.
 *
 * #951: `createApp` now calls this for the App's founding Agent, so a freshly
 * installed App HAS a writable memory from the start. It stays idempotent and
 * lazily callable — the shared-chat and team-chat paths still call it, which
 * is what covers Apps created before that change. It is deliberately NOT
 * called from `installAgentIntoApp`: a team App installs one persona Agent per
 * teammate, and one shared memory per persona would be noise, not a team space.
 *
 * One app-class memory per `(app, agent)`, not per `app` alone — the
 * 2026-05-12-user-installing-app design discussion (§3) reintroduced
 * the multi-Agent App via the `AppAgent` join, dropping `App.agentId`
 * as the single FK. Keying the shared memory by `(app, agent)` keeps
 * the chat-visibility decision (`shared` chats are scoped to one App
 * AND one Agent) intact across the upcoming 008-amendment migration:
 * two Agents installed in the same App will not collide on one shared
 * memory.
 *
 * Mirrors the personal-memory provisioner pattern at
 * `resolvers.ts:3573-3625`.
 *
 * Concurrency + soft-delete handling: the lookup keys off the
 * `(appId, sharedMemoryOfAgentId)` unique, which spans soft-deleted rows, so a
 * tombstoned pairing is found and restored rather than colliding with a fresh
 * `create`. A P2002 on the insert is resolved by WHICH unique it hit: the
 * pairing unique means a concurrent request provisioned this same pairing (take
 * its row), while the `urn` unique means a DIFFERENT pairing won the slug we
 * probed as free — there is nothing of ours to re-read, so the mint is retried
 * and aliases around the winner.
 */
export async function findOrCreateAppClassMemory(args: {
  appId: string;
  appUrn: string;
  appName: string;
  /**
   * #723 — the Agent side of the pairing's IDENTITY (stored in
   * `Memory.sharedMemoryOfAgentId`). A PK, so it survives an Agent rename; the
   * urn below is only used to derive the legacy string key and a display name.
   */
  agentId: string;
  /** The Agent the shared chat is conducted with. URN form
   *  `<org-urn>:<agent-slug>`; the slug is everything after the first
   *  colon segment. */
  agentUrn: string;
  agentName: string;
  organizationId: string | null;
  /**
   * #951: the App's USER owner, for a user-owned App (spec 047). Memories
   * carry the same org-XOR-user ownership as every other tenanted row
   * (`chk_memory_owner_xor`), so passing only `organizationId` left BOTH
   * columns null for a user-owned App and the insert failed the CHECK — i.e.
   * the shared memory could never be provisioned there at all.
   */
  ownerUserId?: string | null;
  actingUserId: string;
  db: PrismaClient;
}): Promise<string> {
  const { appId, appUrn, appName, agentId, agentUrn, agentName, organizationId, actingUserId, db } =
    args;
  const ownerUserId = args.ownerUserId ?? null;
  const agentSlug = agentSlugFromUrn(agentUrn);
  if (!agentSlug) {
    throw new Error(
      `findOrCreateAppClassMemory: agentUrn "${agentUrn}" has no slug segment after the org prefix.`,
    );
  }

  /** Un-delete a tombstoned pairing rather than provisioning a second one. */
  const revive = async (row: { id: string; deletedAt: Date | null }): Promise<string> => {
    if (row.deletedAt) {
      await db.memory.update({
        where: { id: row.id },
        data: { deletedAt: null, deletedBy: null },
      });
    }
    return row.id;
  };

  // 1. The canonical key: the (App, Agent) column unique. Spans soft-deleted
  //    rows by design (see the doc comment).
  const existing = await db.memory.findUnique({
    where: { appId_sharedMemoryOfAgentId: { appId, sharedMemoryOfAgentId: agentId } },
    select: { id: true, deletedAt: true },
  });
  if (existing) return revive(existing);

  // 2. Pre-#723 rows carry no column — adopt the one the OLD string key names,
  //    through the SAME matcher the migration and the sweep use
  //    (`sharedMemoryLegacyKey.ts`): parsed-atom equality against the Agent's
  //    current AND legacy slug. Deliberately not a Prisma `endsWith` filter —
  //    that compiles to SQL LIKE, where a legal `_` in a slug is a wildcard, so
  //    provisioning `sales_bot` could adopt `salesXbot`'s team space. The
  //    candidate scan is scoped to this App's unkeyed app-class rows (a
  //    handful). Oldest wins, deterministically.
  const candidates = await db.memory.findMany({
    where: { appId, class: 'app', sharedMemoryOfAgentId: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, urn: true, legacyUrn: true, deletedAt: true },
  });
  // The Agent's legacy urn comes from the row, not the caller: the #697 Task-A
  // sweep can have re-slugged the Agent since the memory urn was written, and
  // matching only the current slug would miss that Agent's own memory and
  // provision a duplicate. Threading it through every caller's `select` would
  // be four chances to forget.
  const agentRow = await db.agent.findUnique({
    where: { id: agentId },
    select: { urn: true, legacyUrn: true },
  });
  const agentSlugs = agentSlugCandidates(agentRow ?? { urn: agentUrn });
  const legacyRow = candidates.find((m) => memoryCarriesLegacyKeyFor(m, agentSlugs));
  if (legacyRow) {
    // Guarded on `sharedMemoryOfAgentId: null` so a concurrent adopter (or the
    // migration) can't be overwritten; a lost race re-reads the winner.
    const claimed = await db.memory.updateMany({
      where: { id: legacyRow.id, sharedMemoryOfAgentId: null },
      data: { sharedMemoryOfAgentId: agentId, updatedBy: actingUserId },
    });
    if (claimed.count === 1) return revive(legacyRow);
    const winner = await db.memory.findUnique({
      where: { appId_sharedMemoryOfAgentId: { appId, sharedMemoryOfAgentId: agentId } },
      select: { id: true, deletedAt: true },
    });
    if (winner) return revive(winner);
  }

  // 3. Mint a FLAT single-atom v2 urn (#697 Stage 3, the site #722 deferred).
  //    Root is the owning principal (Task A FK-rooting: the org, or the user
  //    handle for a user-owned App), falling back to the App's own root atom
  //    when neither name resolves. The slug is the App's terminal atom plus the
  //    `-shared` marker — self-describing, and far less of a landgrab under the
  //    root than a bare `shared`; a collision aliases deterministically on the
  //    agent slug (`<app>-shared-<agent>`), which is safe now that lookups no
  //    longer recompute the urn.
  const appSlug = normalizeUrnForLookup(appUrn).split(':').pop() ?? appUrn;
  const root = await resolveMemoryRoot(db, { organizationId, ownerUserId, appUrn });

  // Mint-and-insert is RETRIED, because the two uniques a P2002 can come from
  // mean opposite things. Losing the (App, Agent) unique means someone
  // provisioned THIS pairing — take their row. Losing `urn` means a DIFFERENT
  // pairing took the slug we probed as free (two Agents in one App bootstrapping
  // at once both see `<app>-shared` unclaimed); there is no row of ours to find,
  // and the right answer is to mint again — the second probe sees the winner and
  // aliases to `<app>-shared-<agent>`. Rethrowing there would fail a first-time
  // team chat or worklog write on a pure race.
  for (let attempt = 0; ; attempt++) {
    const urn = await mintMemoryUrnV2(db, {
      root,
      desiredSlug: `${appSlug}-shared`,
      authorRoot: agentSlug,
    });
    try {
      const created = await db.memory.create({
        data: {
          organizationId,
          // Owner XOR (`chk_memory_owner_xor`): an org-owned App's shared memory
          // is org-owned, a user-owned App's belongs to that user.
          ownerUserId: organizationId === null ? ownerUserId : null,
          urn,
          name: sharedMemoryName(appName, agentName),
          class: 'app',
          // 035-visibility-enum-cleanup: app-class visibility is NULL.
          visibility: null,
          appId,
          sharedMemoryOfAgentId: agentId,
          userId: null,
          createdBy: actingUserId,
        },
        select: { id: true },
      });
      return created.id;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
      const race = await db.memory.findUnique({
        where: { appId_sharedMemoryOfAgentId: { appId, sharedMemoryOfAgentId: agentId } },
        select: { id: true, deletedAt: true },
      });
      if (race) return revive(race);
      // A urn clash with another pairing. Bounded so a genuinely unwinnable
      // clash surfaces as the DB error rather than spinning.
      if (attempt >= MINT_RETRY_LIMIT) throw err;
    }
  }
}

/**
 * How many times a urn clash with a DIFFERENT pairing may force a re-mint before
 * the P2002 is allowed to surface. Each retry re-probes and aliases, so more
 * than a couple means something is wrong with the probe, not with contention.
 */
const MINT_RETRY_LIMIT = 3;

/**
 * The pool root a newly provisioned shared memory is minted under: the owning
 * ORG's name, or the owning USER's handle for a user-owned App (spec 047), per
 * Task A's rule that the root comes from the OWNER FK and never from a stored
 * URN string (a stored root can have drifted from the real owner). The App's
 * own root atom is the last-resort fallback — only reachable if the owner row
 * is gone or handle-less, where minting under the App's root still beats
 * failing to provision the App's only writable memory.
 */
export async function resolveMemoryRoot(
  db: PrismaClient,
  args: { organizationId: string | null; ownerUserId: string | null; appUrn: string },
): Promise<string> {
  if (args.organizationId) {
    const org = await db.organization.findUnique({
      where: { id: args.organizationId },
      select: { urn: true },
    });
    if (org?.urn) return org.urn;
  } else if (args.ownerUserId) {
    const user = await db.user.findUnique({
      where: { id: args.ownerUserId },
      select: { handle: true },
    });
    if (user?.handle) return user.handle;
  }
  return normalizeUrnForLookup(args.appUrn).split(':')[0] ?? args.appUrn;
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
 * #1835: compileTemplate intersects this fragment with the includer's
 * memoryId; it never spreads it over that id. Bare references therefore stay
 * local even when knowledge/system memories are in the allowed read-set.
 * Keep this D5 filter: it is the chat's authority constraint, independent of
 * the compiler's address constraint, and excludes the author's personal
 * memories on shared chats. Prompt-level guardrails do not satisfy D5.
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
  /** From the holding `Memory.class`. The full `MemoryClass` enum is
   *  accepted so callers don't need to narrow; `group` and `private`
   *  class memory are explicitly rejected as they do not hold
   *  chat-roots (spec 023; `private` added 2026-05-24). */
  memoryClass: 'personal' | 'app' | 'knowledge' | 'system' | 'group' | 'private';
  /** True during the migration window — treats missing `scope` as
   *  `private` for any non-shared memory class. */
  allowMissingScope?: boolean;
}): void {
  const { scope, memoryClass, allowMissingScope = false } = args;

  // 023-app-shape: group-class memory is for team-shared collaborative
  // content, not chat-roots. A chat-root landing on a group memory is
  // corruption regardless of scope. `private`-class (added 2026-05-24)
  // is for secure single-owner records and likewise does not hold
  // chat-roots — chats live on personal/knowledge (private chats) or
  // app (shared chats).
  if (memoryClass === 'group' || memoryClass === 'private') {
    throw new ChatScopeError(
      'CHAT_MEMORY_OUT_OF_SCOPE',
      `Chat-root cannot live on a ${memoryClass}-class memory.`,
    );
  }

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
  | 'CHAT_MEMORY_OUT_OF_SCOPE'
  // #3097: expected refusal states of `startChat`'s conversation selection.
  | 'AGENT_HAS_NO_CONVERSATIONS'
  | 'CONVERSATION_NOT_FOUND'
  | 'CONVERSATION_HAS_NO_STAGES';

/** Typed error thrown by the chat-scope layer. */
/**
 * Extends `GraphQLError` so Apollo Server's default formatter
 * preserves `extensions.code` on the wire. Without this, Apollo
 * masks the error as `INTERNAL_SERVER_ERROR` and clients lose the
 * ability to distinguish `SHARED_CHAT_REQUIRES_APP_CONTEXT` from
 * `SHARED_CHAT_NOT_AVAILABLE_FOR_APP_SESSIONS` programmatically —
 * they'd have to substring-match the English message text. The
 * top-level `code` property is kept for type-narrowing in tests and
 * internal callers that catch `instanceof ChatScopeError`.
 */
export class ChatScopeError extends GraphQLError {
  readonly code: ChatScopeErrorCode;

  constructor(code: ChatScopeErrorCode, message: string) {
    super(message, { extensions: { code } });
    this.name = 'ChatScopeError';
    this.code = code;
  }
}
