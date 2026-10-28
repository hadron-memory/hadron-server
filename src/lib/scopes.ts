/**
 * Spec 049 Phase 2 — named search scopes ("lenses"), D-2026-09-13-001.
 *
 * A Scope is an ORDERED list of memories with exactly one owner — organization,
 * Agent, or App. Everything that decides what a scope MEANS lives here, so the
 * GraphQL resolvers (`resolvers.scope.ts`) and the MCP tools (`mcp/server.ts`)
 * cannot drift:
 *
 *   - owner resolution + the write gate per owner (§8.3 of the plan);
 *   - the read gate per owner;
 *   - name resolution in an App's context — App › Agent › organization,
 *     namespaced, NEVER unioned (D-001 rejected union: "merges two builders'
 *     intentions nobody reviewed");
 *   - `explainScope`: the resolved memory list ∩ the caller's access (S2), the
 *     dropped COUNT, and which memory would win for an address (the input the
 *     stubbed task-customization operation consumes).
 *
 * A scope NEVER grants (D-2026-09-13-004): every read of its memory list goes
 * through `narrowToAccessible` against the canonical gate. Dropped memories are
 * disclosed by count only — a memory the caller cannot read is, for this
 * caller, a memory that does not exist, and enumerating its URN would be the
 * existence oracle §8.2 forbids.
 */

import { GraphQLError } from 'graphql';
import type { Prisma, Scope } from '../generated/prisma/index.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import {
  getAccessibleMemoryIds,
  isAppParticipant,
  isOrgMemberOrAdmin,
  isOwnerOrOrgMember,
  isPlatformAdmin,
  requireOrgRole,
  requireAgentAccess,
  requireOwnerOrOrgRole,
  resolveReadableAgentRef,
} from '../api/graphql/schema/resolvers.helpers.js';
import { resolveAgentRef } from './entityRef/agentRef.js';
import { resolveAppRef } from './entityRef/appRef.js';
import { resolveMemoryRef } from './entityRef/memoryRef.js';
import { resolveOrgRef } from './entityRef/orgRef.js';
import { narrowToAccessible } from './auth/narrowToAccessible.js';
import { resolveActiveOrg, type ActiveOrgResolution } from './auth/activeOrg.js';
import { isLifecycleActive } from '@hadron-memory/access-control';
import { LIVE_ORG_MEMBERSHIP } from './auth/liveOrgMembership.js';
import { forbiddenError } from './refusals.js';

/** The ladder's built-in tokens (D-2026-09-13-002); a scope may not take either name. */
export const RESERVED_SCOPE_NAMES: ReadonlySet<string> = new Set(['global', 'app']);

/** Same shape as AiServiceConfig names: 1–64 lower-case `[a-z0-9_-]`, letter-or-digit first. */
export const SCOPE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type ScopeOwnerType = 'ORGANIZATION' | 'AGENT' | 'APP';

/** The S1 owner columns — exactly one non-null (CHECK `chk_scope_owner`). */
export interface ScopeOwnerColumns {
  organizationId: string | null;
  agentId: string | null;
  appId: string | null;
}

export function ownerTypeOf(s: ScopeOwnerColumns): ScopeOwnerType {
  if (s.appId) return 'APP';
  if (s.agentId) return 'AGENT';
  return 'ORGANIZATION';
}

export function ownerIdOf(s: ScopeOwnerColumns): string {
  return (s.appId ?? s.agentId ?? s.organizationId) as string;
}

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

/** Validate a scope name: shape, and the two reserved ladder tokens. */
export function assertScopeName(name: string): void {
  if (!SCOPE_NAME_RE.test(name)) {
    throw badInput('Scope name must be 1–64 characters of lower-case a-z, 0-9, "_" or "-", starting with a letter or digit.');
  }
  if (RESERVED_SCOPE_NAMES.has(name)) {
    throw badInput(`"${name}" is a reserved scope name (the ladder's ${name === 'global' ? 'active-organization' : 'active-App'} view) and cannot be created.`);
  }
}

/**
 * Turn a caller's owner input into the S1 columns, gated for WRITE.
 *
 * Exactly one of the three refs must be passed. Gates (plan §8.3):
 *   - organization: CONTRIBUTOR+ (D-001: "org scopes are created by
 *     contributors and usable by every member");
 *   - App: ADMIN of the owning org, or the owner of a user-owned App;
 *   - Agent: ADMIN of the owning org, or the owner of a user-owned Agent.
 * All through the shared predicates; a bespoke check would drift.
 */
export async function resolveScopeOwnerForWrite(
  ctx: Context,
  input: { organizationRef?: string | null; agentRef?: string | null; appRef?: string | null },
): Promise<ScopeOwnerColumns> {
  const given = [input.organizationRef, input.agentRef, input.appRef].filter((r) => !!r?.trim());
  if (given.length !== 1) {
    throw badInput('A scope has exactly one owner: pass exactly one of organizationRef, agentRef, appRef.');
  }
  if (input.organizationRef) {
    const { id } = await resolveOrgRef(ctx.db, input.organizationRef.trim());
    await requireOrgRole(ctx, id, 'CONTRIBUTOR');
    return { organizationId: id, agentId: null, appId: null };
  }
  if (input.agentRef) {
    // #1944: through the read gate, so an Agent the caller can't read answers
    // as absent (as a retired one does); the write gate below decides the rest.
    const agent = await resolveReadableAgentRef(ctx, input.agentRef.trim());
    await requireAgentAccess(ctx, agent, 'ADMIN');
    return { organizationId: null, agentId: agent.id, appId: null };
  }
  const { id } = await resolveAppRef(ctx.db, input.appRef!.trim());
  // Live AND installed: an uninstalled App must not keep supplying its owner
  // to the write gate (Copilot on PR #1160) — same rule as the read side.
  const app = await ctx.db.app.findFirst({
    where: { id, deletedAt: null, uninstalledAt: null },
    select: { organizationId: true, ownerUserId: true },
  });
  if (!app) throw forbiddenError();
  await requireOwnerOrOrgRole(ctx, app, 'ADMIN');
  return { organizationId: null, agentId: null, appId: id };
}

/** The WRITE gate on an existing scope — the same rules as at create. */
export async function requireScopeWrite(ctx: Context, scope: ScopeOwnerColumns): Promise<void> {
  if (scope.organizationId) return requireOrgRole(ctx, scope.organizationId, 'CONTRIBUTOR');
  if (scope.agentId) {
    const agent = await ctx.db.agent.findFirst({
      where: { id: scope.agentId, deletedAt: null },
      select: { organizationId: true, ownerUserId: true },
    });
    if (!agent) throw forbiddenError();
    return requireAgentAccess(ctx, agent, 'ADMIN');
  }
  const app = await ctx.db.app.findFirst({
    where: { id: scope.appId!, deletedAt: null, uninstalledAt: null },
    select: { organizationId: true, ownerUserId: true },
  });
  if (!app) throw forbiddenError();
  return requireOwnerOrOrgRole(ctx, app, 'ADMIN');
}

/**
 * The READ gate (plan §8.3): an org scope to that org's members, an App scope
 * to the App's participants (`isAppParticipant` — the same predicate that
 * admits them to the App's team chat and sessions), an Agent scope to whoever
 * may read the Agent (PUBLIC, or owner / org member as `Query.agent`).
 *
 * Pure App-key principals (no `userId`) read their own App's scopes, their
 * App's org's scopes, and scopes of Agents installed in their App — the same
 * reach `resolveScopeByNameInApp` gives them — and nothing else.
 */
export async function canReadScope(ctx: Context, scope: ScopeOwnerColumns): Promise<boolean> {
  if (!ctx.userId && ctx.appId) {
    const reach = await appKeyScopeReach(ctx, ctx.appId);
    return (
      (scope.appId !== null && scope.appId === reach.appId) ||
      (scope.organizationId !== null && scope.organizationId === reach.organizationId) ||
      (scope.agentId !== null && reach.agentIds.includes(scope.agentId))
    );
  }
  if (scope.organizationId) return isOrgMemberOrAdmin(ctx, scope.organizationId);
  if (scope.appId) {
    const app = await ctx.db.app.findFirst({
      where: { id: scope.appId, deletedAt: null, uninstalledAt: null },
      select: { id: true, organizationId: true, ownerUserId: true },
    });
    return !!app && (await isAppParticipant(ctx, app));
  }
  const agent = await ctx.db.agent.findFirst({
    where: { id: scope.agentId!, deletedAt: null },
    select: { organizationId: true, ownerUserId: true, visibility: true },
  });
  if (!agent) return false;
  // Impersonation is bounded to the ONE shared org (#876 / #1094): a PUBLIC
  // Agent elsewhere is outside the support view, whatever its visibility
  // (Copilot on PR #1160).
  if (ctx.impersonation && agent.organizationId !== ctx.impersonation.orgId) return false;
  return agent.visibility === 'PUBLIC' || isOwnerOrOrgMember(ctx, agent);
}

/**
 * An App's RESOLUTION CONTEXT — its organization and its LIVE installed Agents
 * — returned only to a caller who may read the App (a participant, or the
 * App key of that App); `null` otherwise, indistinguishable from a nonexistent
 * App. Shared by name resolution and the `scopes(filter.appRef)` list so the
 * gate cannot be omitted by one of them (plan §8, `a-gate-a-caller-can-omit`).
 */
export async function appContextIfReadable(
  ctx: Context,
  appId: string,
): Promise<{ id: string; organizationId: string | null; agentIds: string[] } | null> {
  const app = await ctx.db.app.findFirst({
    where: { id: appId, deletedAt: null, uninstalledAt: null },
    select: {
      id: true,
      organizationId: true,
      ownerUserId: true,
      appAgents: { where: { agent: { deletedAt: null } }, select: { agentId: true } },
    },
  });
  if (!app) return null;
  const admitted = ctx.userId ? await isAppParticipant(ctx, app) : ctx.appId === app.id;
  if (!admitted) return null;
  return { id: app.id, organizationId: app.organizationId, agentIds: app.appAgents.map((a) => a.agentId) };
}

/** An App key's scope reach: its App, its App's org, its App's installed Agents. */
async function appKeyScopeReach(
  ctx: Context,
  appId: string,
): Promise<{ appId: string; organizationId: string | null; agentIds: string[] }> {
  const app = await ctx.db.app.findFirst({
    where: { id: appId, deletedAt: null, uninstalledAt: null },
    // Live Agents only: deleteAgent soft-deletes and leaves the AppAgent row,
    // and a dead Agent's scope must neither be readable nor shadow a live one
    // (Codex on PR #1160).
    select: { organizationId: true, appAgents: { where: { agent: { deletedAt: null } }, select: { agentId: true } } },
  });
  return {
    appId,
    organizationId: app?.organizationId ?? null,
    agentIds: app?.appAgents.map((a) => a.agentId) ?? [],
  };
}

/**
 * The Prisma `where` for "every scope this caller may READ" — the list
 * query's default page (`cor:api:120`), built from the same rules as
 * {@link canReadScope} but as a clause so it pages. Optionally narrowed to one
 * org (`cor:api:100:01`, already membership-gated by the caller).
 */
export async function readableScopesWhere(
  ctx: Context,
  memberOrgIds: string[],
): Promise<Prisma.ScopeWhereInput> {
  const live = { deletedAt: null } as const;
  if (!ctx.userId && ctx.appId) {
    const reach = await appKeyScopeReach(ctx, ctx.appId);
    return {
      ...live,
      OR: [
        { appId: reach.appId },
        ...(reach.organizationId ? [{ organizationId: reach.organizationId }] : []),
        ...(reach.agentIds.length ? [{ agentId: { in: reach.agentIds } }] : []),
      ],
    };
  }
  if (!ctx.userId) return { ...live, id: { in: [] } };

  // Platform admin: everything but user-owned entities that are not theirs
  // (spec 047 strict ownership — the same carve-out the memory gate makes).
  if (isPlatformAdmin(ctx) && !ctx.impersonation) {
    return {
      ...live,
      NOT: {
        OR: [
          { app: { ownerUserId: { not: null, notIn: [ctx.userId] } } },
          { agent: { ownerUserId: { not: null, notIn: [ctx.userId] } } },
        ],
      },
    };
  }

  // App participation = AppMember at any role, org CONTRIBUTOR+, or user-owner.
  //
  // Under IMPERSONATION (#876 / #1094): `ctx.userId` is the TARGET, so the
  // identity-keyed arms below would answer about the target's memberships
  // ANYWHERE. Bound exactly as `isAppParticipant` / `isOwnerOrOrgMember` are —
  // `memberOrgIds` is already the one shared org (resolveOrgScope), the App arm
  // is confined to Apps of that org, and the user-owned arms (identity-scoped,
  // invisible to a support view) are dropped.
  const identityArms = ctx.impersonation ? [] : [{ ownerUserId: ctx.userId }];
  const contributorOrgIds = (
    await ctx.db.orgMember.findMany({
      where: {
        userId: ctx.userId,
        ...LIVE_ORG_MEMBERSHIP,
        role: { in: ['CONTRIBUTOR', 'ADMIN', 'OWNER'] },
        organizationId: { in: memberOrgIds },
      },
      select: { organizationId: true },
    })
  ).map((m) => m.organizationId);
  const memberAppIds = (
    await ctx.db.appMember.findMany({ where: { userId: ctx.userId }, select: { appId: true } })
  ).map((m) => m.appId);

  return {
    ...live,
    OR: [
      { organizationId: { in: memberOrgIds } },
      {
        app: {
          deletedAt: null,
          ...(ctx.impersonation ? { organizationId: { in: memberOrgIds } } : {}),
          OR: [
            { id: { in: memberAppIds } },
            ...identityArms,
            ...(contributorOrgIds.length ? [{ organizationId: { in: contributorOrgIds } }] : []),
          ],
        },
      },
      {
        agent: {
          deletedAt: null,
          OR: [
            // PUBLIC admits anyone — except a support view, bounded to its org.
            ...(ctx.impersonation ? [] : [{ visibility: 'PUBLIC' as const }]),
            ...identityArms,
            { organizationId: { in: memberOrgIds } },
          ],
        },
      },
    ],
  };
}

/**
 * Resolve the memory refs of a create/update into an ORDERED, de-duplicated id
 * list the caller may READ. A memory the caller cannot read is reported as "no
 * match" exactly like a nonexistent one — a scope author must not be able to
 * probe memory existence through this argument.
 */
export async function resolveScopeMemoryRefs(ctx: Context, memoryRefs: string[]): Promise<string[]> {
  const accessible = await getAccessibleMemoryIds(ctx);
  const ids: string[] = [];
  for (const raw of memoryRefs) {
    const ref = raw.trim();
    if (!ref) continue;
    let id: string;
    try {
      ({ id } = await resolveMemoryRef(ctx.db, ref));
    } catch {
      throw badInput(`No match for memoryRef "${ref}".`);
    }
    if (accessible !== null && !accessible.includes(id)) {
      throw badInput(`No match for memoryRef "${ref}".`);
    }
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) throw badInput('A scope needs at least one memory.');
  return ids;
}

/** The scope's ordered memory ids, as stored (no access applied — see explainScope). */
export async function scopeMemoryIds(db: Context['db'], scopeId: string): Promise<string[]> {
  // Live memories only: deleteMemory soft-deletes, so the FK cascade never
  // runs and the join row survives its memory (Codex on PR #1160). A tombstone
  // must not be counted, hidden or "dropped" — for every caller it is gone.
  const rows = await db.scopeMemory.findMany({
    where: { scopeId, memory: { deletedAt: null } },
    orderBy: { position: 'asc' },
    select: { memoryId: true },
  });
  return rows.map((r) => r.memoryId);
}

/**
 * Resolve a scope NAME in an App's context: App › Agent (installed in the App)
 * › the App's organization. Namespaced, never unioned. Two installed Agents
 * each owning a scope of that name is AMBIGUOUS at the Agent tier — the caller
 * disambiguates by id; nothing is guessed. Only scopes the caller may read take
 * part, so a shadowed scope the caller cannot see neither wins nor is listed.
 */
export async function resolveScopeByNameInApp(
  ctx: Context,
  name: string,
  appId: string,
): Promise<{ winner: Scope | null; shadowed: Scope[]; ambiguousAmong: Scope[] }> {
  // The App is gated BEFORE its context is expanded: an outsider naming a
  // guessed App must not learn which (public) Agents and scopes it has
  // installed by comparing results (Codex P1 on PR #1160). A user needs to be
  // a participant; an App key needs it to be its own App; nobody else gets
  // even an empty-vs-nonempty tell — the same "nothing found" either way.
  const app = await appContextIfReadable(ctx, appId);
  if (!app) return { winner: null, shadowed: [], ambiguousAmong: [] };
  const agentIds = app.agentIds;
  const candidates = await ctx.db.scope.findMany({
    where: {
      name,
      deletedAt: null,
      OR: [
        { appId },
        ...(agentIds.length ? [{ agentId: { in: agentIds } }] : []),
        ...(app.organizationId ? [{ organizationId: app.organizationId }] : []),
      ],
    },
  });
  const readable: Scope[] = [];
  for (const s of candidates) if (await canReadScope(ctx, s)) readable.push(s);

  const byTier = {
    APP: readable.filter((s) => s.appId),
    AGENT: readable.filter((s) => s.agentId),
    ORGANIZATION: readable.filter((s) => s.organizationId),
  };
  const ordered = [...byTier.APP, ...byTier.AGENT, ...byTier.ORGANIZATION];
  if (byTier.APP.length) return { winner: byTier.APP[0], shadowed: ordered.slice(1), ambiguousAmong: [] };
  if (byTier.AGENT.length > 1) return { winner: null, shadowed: byTier.ORGANIZATION, ambiguousAmong: byTier.AGENT };
  if (byTier.AGENT.length === 1) return { winner: byTier.AGENT[0], shadowed: byTier.ORGANIZATION, ambiguousAmong: [] };
  if (byTier.ORGANIZATION.length) return { winner: byTier.ORGANIZATION[0], shadowed: [], ambiguousAmong: [] };
  return { winner: null, shadowed: [], ambiguousAmong: [] };
}

export interface ScopeExplanation {
  /** The scope's memories the caller may read, in scope order. */
  memoryIds: string[];
  /** How many of the scope's memories the caller may NOT read — count only (§8.2). */
  droppedCount: number;
  /** The first memory (in scope order) holding a live node at `loc`, if a loc was asked. */
  winnerMemoryId: string | null;
}

/**
 * What a scope resolves to FOR THIS CALLER: its ordered memory list ∩ the
 * canonical accessible set (S2), the dropped count, and — when a `loc` is
 * given — which memory would win for that address, which is the one thing the
 * stubbed task-customization operation will consume (D-2026-09-13-005: search
 * itself never uses the order and never dedupes).
 */
export async function explainScope(ctx: Context, scopeId: string, loc?: string | null): Promise<ScopeExplanation> {
  const ordered = await scopeMemoryIds(ctx.db, scopeId);
  const accessible = await getAccessibleMemoryIds(ctx);
  const { kept, droppedIds } = narrowToAccessible(ordered, accessible === null ? 'unrestricted' : new Set(accessible));
  let winnerMemoryId: string | null = null;
  if (loc && kept.length) {
    const holders = await ctx.db.node.findMany({
      where: { loc, memoryId: { in: kept }, deletedAt: null },
      select: { memoryId: true },
    });
    const holding = new Set(holders.map((h) => h.memoryId));
    winnerMemoryId = kept.find((id) => holding.has(id)) ?? null;
  }
  return { memoryIds: kept, droppedCount: droppedIds.length, winnerMemoryId };
}

// ── Spec 049 Phase 3 — the search ladder (D-2026-09-13-002 / -004) ────────────

/** The ladder's two built-in views (reserved names — see RESERVED_SCOPE_NAMES). */
export const BUILTIN_SCOPE_APP = 'app';
export const BUILTIN_SCOPE_GLOBAL = 'global';

/** What a search was produced under — the disclosure envelope's input (plan §2 S3). */
export interface SearchScopeResolution {
  /** A named scope, the `app` view, the `global` (organization) view, or the user-owned view. */
  kind: 'scope' | 'app' | 'global' | 'user-owned';
  /** Which rung chose it — `trigger` for a headless run's snapshot (Phase 3b). */
  source: 'call' | 'session' | 'active-app' | 'active-org' | 'trigger';
  /** Human-readable label for the envelope: the scope name, the App URN, the org URN. */
  label: string;
  /** For `kind: 'scope'`: the scope's owner URN, when it has one. */
  ownerUrn: string | null;
  /**
   * The memory ids to search — ALREADY intersected with the caller's access
   * (S2). `null` means "the caller's accessible set as the engine computes it"
   * (the `global` and user-owned views, which narrow by organization rather
   * than by list).
   */
  memoryIds: string[] | null;
  /** For `kind: 'global'`: the organization the engine narrows to. */
  orgScopeId: string | null;
  /** Memories the scope lists that the caller may NOT read — count only (§8.2). */
  droppedCount: number;
}

/**
 * The `app` view: the App's attached memories — the `AgentMemoryItem` rows of
 * EVERY installed Agent plus the App's own app-class memories. A new
 * computation on purpose: `getAppMemoryAccess` is a GATE and is
 * primary-Agent-only (`take: 1`) by design; this is a LENS, and the lens is
 * still intersected with the gate's output by the caller (plan §4.2 step 3).
 * System-class memories are left out, as the broad search leaves them out.
 */
export async function appScopeMemoryIds(db: Context['db'], appId: string): Promise<string[]> {
  const app = await db.app.findFirst({
    where: { id: appId, deletedAt: null, uninstalledAt: null },
    select: {
      organizationId: true,
      ownerUserId: true,
      appAgents: {
        orderBy: { createdAt: 'asc' },
        select: {
          agent: {
            select: {
              id: true,
              organizationId: true,
              deletedAt: true,
              memoryItems: {
                where: { deletedAt: null, memory: { deletedAt: null, class: { not: 'system' } } },
                orderBy: { createdAt: 'asc' },
                select: { memoryId: true, memory: { select: { appId: true, ownerUserId: true } } },
              },
            },
          },
        },
      },
    },
  });
  if (!app) return [];
  const ids: string[] = [];
  for (const row of app.appAgents) {
    if (!row.agent || row.agent.deletedAt) continue;
    // The same three admissibility rules the gate applies to an install
    // (`getPrimaryAgentAccess` / `admissibleFoldRows`, Copilot on PR #1161):
    // a cross-org install needs a live AgentOrgGrant (same-org auto-passes;
    // a user-owned App has no org and rides its owner's subscription);
    if (app.organizationId !== null && app.organizationId !== row.agent.organizationId) {
      const grant = await db.agentOrgGrant.findUnique({
        where: { orgId_agentId: { orgId: app.organizationId, agentId: row.agent.id } },
      });
      if (!grant || !isLifecycleActive(grant)) continue;
    }
    for (const item of row.agent.memoryItems) {
      // an app-scoped memory row is THIS App's only (an Agent's items are
      // global to the Agent, so another App's rows ride along otherwise);
      if (item.memory.appId != null && item.memory.appId !== appId) continue;
      // a user-owned memory folds in only when the App shares its owner.
      if (item.memory.ownerUserId != null && item.memory.ownerUserId !== app.ownerUserId) continue;
      if (!ids.includes(item.memoryId)) ids.push(item.memoryId);
    }
  }
  const own = await db.memory.findMany({
    where: { appId, class: 'app', deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  for (const m of own) if (!ids.includes(m.id)) ids.push(m.id);
  return ids;
}

export interface ResolveSearchScopeArgs {
  /** A scope named in the call: a scope id, a bare name, `app`, or `global`. */
  scopeArg?: string | null;
  /** The App context for a bare name or for `app` — explicit on GraphQL, the active App on MCP. */
  appId?: string | null;
  /** The session's active scope (MCP), consulted only when nothing is named. */
  storedScopeId?: string | null;
  /** Whether the ambient rungs (session, active App, active org) apply at all — MCP yes, GraphQL no. */
  ambient: boolean;
  /** The active organization, already resolved by the Phase 1 ladder (for `global`). */
  activeOrg?: ActiveOrgResolution | null;
}

/**
 * The search ladder (D-2026-09-13-002): a scope named in the call › the
 * session's active scope › the active App (`app`) › the active organization
 * (`global`) › the user-owned view. Returns `null` when nothing applies (a
 * GraphQL call that named nothing keeps its pre-spec-049 semantics — the
 * caller's accessible set, optionally org-narrowed — so the portal's and the
 * CLI's existing results do not change under them from a flag they never
 * passed, which is the surprise `cor:acl:020:03` rule 5 names).
 *
 * Every named scope is intersected with the caller's access (S2) — a lens
 * never grants (D-004) — and the dropped count travels in the result for the
 * envelope. Refuses with `ORG_REQUIRED` (member list attached) when `global`
 * is asked for and the organization is ambiguous, and with
 * `SCOPE_NAME_AMBIGUOUS` / `NOT_FOUND` for a name that resolves to several or
 * to nothing the caller may read.
 */
export async function resolveSearchScope(
  ctx: Context,
  args: ResolveSearchScopeArgs,
): Promise<SearchScopeResolution | null> {
  const named = args.scopeArg?.trim() || null;

  // ── Rung 1: named in the call ──
  if (named) {
    if (named === BUILTIN_SCOPE_GLOBAL) return globalView(ctx, args.activeOrg ?? null, 'call');
    if (named === BUILTIN_SCOPE_APP) {
      if (!args.appId) {
        // #1173: state the CONDITION, never a surface's remedy. Three
        // surfaces read this string, so "pass appRef (GraphQL) or select an
        // App (MCP)" was unactionable on two of them — a CLI user can type
        // neither. `missing` is the surface-neutral carrier each client
        // renders in its own vocabulary.
        throw new GraphQLError('scope "app" needs an App context.', {
          extensions: { code: 'BAD_USER_INPUT', missing: 'appContext' },
        });
      }
      return appView(ctx, args.appId, 'call');
    }
    let scope: Scope | null = null;
    if (SCOPE_NAME_RE.test(named) && !(await ctx.db.scope.findFirst({ where: { id: named }, select: { id: true } }))) {
      // A bare NAME, unique only per owner — resolved in the App's context.
      if (!args.appId) {
        // The second clause is a FACT about scope ids, not an instruction in
        // one surface's vocabulary: an id is a value every caller can supply.
        throw new GraphQLError(`Resolving scope "${named}" by name needs an App context; a scope id needs none.`, {
          extensions: { code: 'BAD_USER_INPUT', missing: 'appContext' },
        });
      }
      const r = await resolveScopeByNameInApp(ctx, named, args.appId);
      if (r.ambiguousAmong.length) {
        throw new GraphQLError(
          `"${named}" is owned by ${r.ambiguousAmong.length} Agents installed in this App; pass the scope id to choose one: ${r.ambiguousAmong.map((s) => s.id).join(', ')}.`,
          { extensions: { code: 'SCOPE_NAME_AMBIGUOUS', candidates: r.ambiguousAmong.map((s) => s.id) } },
        );
      }
      scope = r.winner;
    } else {
      const row = await ctx.db.scope.findFirst({ where: { id: named, deletedAt: null } });
      scope = row && (await canReadScope(ctx, row)) ? row : null;
    }
    if (!scope) {
      throw new GraphQLError(`No readable scope matches "${named}".`, { extensions: { code: 'NOT_FOUND' } });
    }
    return scopeView(ctx, scope, 'call');
  }

  if (!args.ambient) return null;

  // ── Rung 2: the session's active scope, re-authorized ──
  if (args.storedScopeId) {
    const row = await ctx.db.scope.findFirst({ where: { id: args.storedScopeId, deletedAt: null } });
    if (row && (await canReadScope(ctx, row))) return scopeView(ctx, row, 'session');
  }

  // ── Rung 3: the active App ⇒ `app` ──
  if (args.appId) return appView(ctx, args.appId, 'active-app');

  // ── Rungs 4/5: the active organization ⇒ `global`, or the user-owned view ──
  return globalView(ctx, args.activeOrg ?? null, 'active-org');
}

async function scopeView(ctx: Context, scope: Scope, source: SearchScopeResolution['source']): Promise<SearchScopeResolution> {
  const ex = await explainScope(ctx, scope.id);
  let ownerUrn: string | null = null;
  if (scope.appId) ownerUrn = (await ctx.db.app.findUnique({ where: { id: scope.appId }, select: { urn: true } }))?.urn ?? null;
  else if (scope.agentId) ownerUrn = (await ctx.db.agent.findUnique({ where: { id: scope.agentId }, select: { urn: true } }))?.urn ?? null;
  else if (scope.organizationId) ownerUrn = (await ctx.db.organization.findUnique({ where: { id: scope.organizationId }, select: { urn: true } }))?.urn ?? null;
  return {
    kind: 'scope',
    source,
    label: scope.name,
    ownerUrn,
    memoryIds: ex.memoryIds,
    orgScopeId: null,
    droppedCount: ex.droppedCount,
  };
}

async function appView(ctx: Context, appId: string, source: SearchScopeResolution['source']): Promise<SearchScopeResolution> {
  const app = await ctx.db.app.findFirst({ where: { id: appId, deletedAt: null }, select: { urn: true } });
  const listed = await appScopeMemoryIds(ctx.db, appId);
  const accessible = await getAccessibleMemoryIds(ctx);
  const { kept, droppedIds } = narrowToAccessible(listed, accessible === null ? 'unrestricted' : new Set(accessible));
  return {
    kind: 'app',
    source,
    label: app?.urn ?? appId,
    ownerUrn: app?.urn ?? null,
    memoryIds: kept,
    orgScopeId: null,
    droppedCount: droppedIds.length,
  };
}

async function globalView(
  ctx: Context,
  activeOrg: ActiveOrgResolution | null,
  source: SearchScopeResolution['source'],
): Promise<SearchScopeResolution> {
  // Both views MATERIALISE their list (Copilot on PR #1161): the envelope's
  // `memoryUrns` must say what was searched, and a null "no narrowing" would
  // have labelled the caller's ENTIRE accessible set (public memories included)
  // as "user-owned". cor:api:100 — the user-owned view is the caller's own
  // memories; the org view is the org's readable memories.
  if (!activeOrg || activeOrg.kind === 'user-owned') {
    const accessible = await getAccessibleMemoryIds(ctx);
    const own = ctx.userId
      ? (
          await ctx.db.memory.findMany({
            where: {
              deletedAt: null,
              class: { not: 'system' }, // the broad-search default, kept on the materialised path
              ...(accessible === null ? {} : { id: { in: accessible } }),
              OR: [{ ownerUserId: ctx.userId }, { class: { in: ['personal', 'private'] }, userId: ctx.userId }],
            },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          })
        ).map((m) => m.id)
      : [];
    return { kind: 'user-owned', source, label: 'user-owned memories', ownerUrn: null, memoryIds: own, orgScopeId: null, droppedCount: 0 };
  }
  if (activeOrg.kind === 'required') {
    // TWO refusals share this code, and only one of them is about something
    // MISSING (Copilot on PR #1175). A caller who named a foreign or
    // nonexistent org supplied a selection — it was refused — so telling a
    // client `missing: 'activeOrg'` there would have it prompt for the
    // selection just made: the wrong-remedy defect #1173 is about, reappearing
    // inside its own fix. `memberOrgIds` is the half that is true for both.
    const namedNotMember = activeOrg.reason === 'named_not_member';
    throw new GraphQLError(
      namedNotMember
        ? 'The named organization is not one you are a member of.'
        // #1173: `orgId` is a GraphQL argument and `hadron_set_active_org` an
        // MCP tool — a CLI user can type neither, and a portal user can click
        // neither. State the condition all three surfaces share.
        : `You belong to ${activeOrg.memberOrgIds.length} organizations and none is active.`,
      {
        extensions: {
          code: 'ORG_REQUIRED',
          ...(namedNotMember ? {} : { missing: 'activeOrg' }),
          memberOrgIds: activeOrg.memberOrgIds,
        },
      },
    );
  }
  const org = await ctx.db.organization.findUnique({ where: { id: activeOrg.organizationId }, select: { urn: true } });
  // The org view as findNodes' orgId narrowing computes it: the accessible set
  // ∩ the organization's memories — materialised for the envelope.
  const accessible = await getAccessibleMemoryIds(ctx);
  const orgMemoryIds = (
    await ctx.db.memory.findMany({
      where: {
        deletedAt: null,
        class: { not: 'system' }, // the broad-search default, kept on the materialised path
        organizationId: activeOrg.organizationId,
        ...(accessible === null ? {} : { id: { in: accessible } }),
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
  ).map((m) => m.id);
  return {
    kind: 'global',
    source,
    label: org?.urn ?? activeOrg.organizationId,
    ownerUrn: org?.urn ?? null,
    memoryIds: orgMemoryIds,
    orgScopeId: activeOrg.organizationId,
    droppedCount: 0,
  };
}

/**
 * The GraphQL entry to the ladder: a scope NAMED in the call, with the App
 * context from `appRef` (participant-gated — a foreign App reads the same as
 * no App) and the organization from `orgId` for `global`. No ambient rungs:
 * GraphQL has no session state for a user principal; an App-key credential IS
 * its App. Shared by `findNodes` and `globalSearch` so the two cannot drift.
 */
export async function resolveNamedScopeForQuery(
  ctx: Context,
  scopeArg: string,
  appRef: string | null,
  orgId: string | null,
): Promise<SearchScopeResolution> {
  let appId: string | null = ctx.appId ?? null;
  if (appRef) {
    // The same gate name resolution and the list use: a foreign or unknown App
    // is no context, with no tell between the two.
    let candidate: string | null = null;
    try {
      ({ id: candidate } = await resolveAppRef(ctx.db, appRef.trim()));
    } catch {
      candidate = null;
    }
    appId = candidate ? ((await appContextIfReadable(ctx, candidate))?.id ?? null) : null;
  }
  let activeOrg: ActiveOrgResolution | null = null;
  if (ctx.userId) {
    let namedOrgId: string | null = null;
    if (orgId) {
      try {
        ({ id: namedOrgId } = await resolveOrgRef(ctx.db, orgId));
      } catch {
        // An explicit org that names nothing is a FINAL refusal, not a fall
        // through to the single membership — that would answer a different
        // organization's question with plausible rows (Codex on PR #1161). A
        // nonexistent org reads exactly like a foreign one.
        activeOrg = { kind: 'required', reason: 'named_not_member', memberOrgIds: [] };
      }
    }
    if (!activeOrg) {
      activeOrg = await resolveActiveOrg(ctx.db, {
        userId: ctx.userId,
        namedOrgId,
        activeAppId: appId,
        restrictToOrgId: ctx.impersonation?.orgId,
      });
    }
  } else if (ctx.appId) {
    const app = await ctx.db.app.findUnique({ where: { id: ctx.appId }, select: { organizationId: true } });
    activeOrg = app?.organizationId ? { kind: 'org', organizationId: app.organizationId, source: 'app' } : { kind: 'user-owned' };
  }
  const r = await resolveSearchScope(ctx, { scopeArg, appId, ambient: false, activeOrg });
  // Unreachable: a named scope always resolves or throws.
  if (!r) throw new GraphQLError(`No readable scope matches "${scopeArg}".`, { extensions: { code: 'NOT_FOUND' } });
  return r;
}

// ── Spec 049 Phase 3b — a headless run's scope (D-2026-09-13-004) ─────────────

/**
 * What a run carries: the trigger's scope as it stood at mint. Its memory ids
 * are the scope's STORED order — not intersected with anyone's access, because
 * the run's principal is judged at USE, hop by hop (`resolveRunScope`). The
 * name / owner are display data for the disclosure; `scopeId` is provenance.
 */
export interface RunScopeSnapshot {
  scopeId: string;
  name: string;
  ownerType: ScopeOwnerType;
  ownerId: string;
  memoryIds: string[];
}

/**
 * Resolve a trigger's `scopeRef` for CREATE / UPDATE (plan §3.3): an id or a
 * bare name in the App's context, readable by the caller, and OWNED BY that
 * context — the App itself, an Agent installed in it, or the App's
 * organization. A scope from elsewhere would let a trigger author smuggle a
 * lens the App never had; refused as input, with no existence tell.
 */
export async function resolveScopeForTrigger(ctx: Context, appId: string, scopeRef: string): Promise<string> {
  const ref = scopeRef.trim();
  const refuse = () => badInput(`No readable scope matches "${ref}" in this App's context.`);
  const context = await appContextIfReadable(ctx, appId);
  if (!context) throw refuse();
  let scope: Scope | null = await ctx.db.scope.findFirst({ where: { id: ref, deletedAt: null } });
  if (!scope) {
    const r = await resolveScopeByNameInApp(ctx, ref, appId);
    if (r.ambiguousAmong.length) {
      throw new GraphQLError(
        `"${ref}" is owned by ${r.ambiguousAmong.length} Agents installed in this App; pass the scope id: ${r.ambiguousAmong.map((s) => s.id).join(', ')}.`,
        { extensions: { code: 'SCOPE_NAME_AMBIGUOUS', candidates: r.ambiguousAmong.map((s) => s.id) } },
      );
    }
    scope = r.winner;
  }
  if (!scope || !(await canReadScope(ctx, scope))) throw refuse();
  const inContext =
    scope.appId === appId ||
    (scope.agentId !== null && context.agentIds.includes(scope.agentId)) ||
    (scope.organizationId !== null && scope.organizationId === context.organizationId);
  if (!inContext) throw refuse();
  return scope.id;
}

/** Snapshot a trigger's scope for a run at mint; null when the scope is gone (⇒ `app`). */
export async function snapshotScopeForTrigger(db: Context['db'], scopeId: string): Promise<RunScopeSnapshot | null> {
  // ONE statement for the row and its ordered list, so a concurrent
  // updateScope cannot land between them and leave a snapshot that pairs old
  // metadata with a new list (Copilot on PR #1163). Live memories only, as
  // scopeMemoryIds reads them.
  const scope = await db.scope.findFirst({
    where: { id: scopeId, deletedAt: null },
    include: { memories: { where: { memory: { deletedAt: null } }, orderBy: { position: 'asc' }, select: { memoryId: true } } },
  });
  if (!scope) return null;
  return {
    scopeId: scope.id,
    name: scope.name,
    ownerType: ownerTypeOf(scope),
    ownerId: ownerIdOf(scope),
    memoryIds: scope.memories.map((m) => m.memoryId),
  };
}

/** Read a stored snapshot back, tolerating anything that is not one (⇒ null). */
export function parseRunScopeSnapshot(raw: unknown): RunScopeSnapshot | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Partial<RunScopeSnapshot>;
  if (typeof s.scopeId !== 'string' || typeof s.name !== 'string' || !Array.isArray(s.memoryIds)) return null;
  return {
    scopeId: s.scopeId,
    name: s.name,
    ownerType: (s.ownerType ?? 'APP') as ScopeOwnerType,
    ownerId: typeof s.ownerId === 'string' ? s.ownerId : '',
    memoryIds: s.memoryIds.filter((id): id is string => typeof id === 'string'),
  };
}

/**
 * The scope a run searches under, FOR THE GIVEN PRINCIPAL, judged now: the
 * snapshot ∩ the principal's CURRENT access (S2) — never the snapshot alone,
 * which would make a mint-time list an access grant that outlives a revoked
 * membership. No snapshot ⇒ the App's attached memories (`app`), D-004's
 * default. The one function every run-side consumer calls, per hop; today's
 * consumers are the `AppRun.scope` disclosure and the kernel-side seam a
 * run search tool will plug into.
 */
export async function resolveRunScope(
  ctx: Context,
  run: { appId: string; scopeSnapshot: unknown },
): Promise<SearchScopeResolution> {
  const snap = parseRunScopeSnapshot(run.scopeSnapshot);
  if (!snap) return appView(ctx, run.appId, 'trigger');
  const accessible = await getAccessibleMemoryIds(ctx);
  const { kept, droppedIds } = narrowToAccessible(snap.memoryIds, accessible === null ? 'unrestricted' : new Set(accessible));
  const ownerUrn =
    snap.ownerType === 'APP'
      ? ((await ctx.db.app.findUnique({ where: { id: snap.ownerId }, select: { urn: true } }))?.urn ?? null)
      : snap.ownerType === 'AGENT'
        ? ((await ctx.db.agent.findUnique({ where: { id: snap.ownerId }, select: { urn: true } }))?.urn ?? null)
        : ((await ctx.db.organization.findUnique({ where: { id: snap.ownerId }, select: { urn: true } }))?.urn ?? null);
  return {
    kind: 'scope',
    source: 'trigger',
    label: snap.name,
    ownerUrn,
    memoryIds: kept,
    orgScopeId: null,
    droppedCount: droppedIds.length,
  };
}

/** The `scope_narrowed` degrade code, appended to an envelope's comma-separated set. */
export const SCOPE_NARROWED = 'scope_narrowed';

export function mergeDegraded(existing: string | null | undefined, extra: string | null): string | null {
  const set = [existing, extra].filter((s): s is string => !!s).flatMap((s) => s.split(','));
  return set.length ? [...new Set(set)].join(',') : null;
}

/** The GraphQL / MCP projection of a resolution: URNs only for readable memories. */
export async function scopeInfoOf(ctx: Context, r: SearchScopeResolution) {
  const memoryUrns = r.memoryIds
    ? (await ctx.db.memory.findMany({ where: { id: { in: r.memoryIds } }, select: { id: true, urn: true } }))
        .sort((a, b) => r.memoryIds!.indexOf(a.id) - r.memoryIds!.indexOf(b.id))
        .map((m) => m.urn)
    : [];
  return { kind: r.kind, source: r.source, label: r.label, ownerUrn: r.ownerUrn, memoryUrns, droppedCount: r.droppedCount };
}
