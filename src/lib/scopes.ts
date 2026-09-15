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
  requireOwnerOrOrgRole,
} from '../api/graphql/schema/resolvers.helpers.js';
import { resolveAgentRef } from './entityRef/agentRef.js';
import { resolveAppRef } from './entityRef/appRef.js';
import { resolveMemoryRef } from './entityRef/memoryRef.js';
import { resolveOrgRef } from './entityRef/orgRef.js';
import { narrowToAccessible } from './auth/narrowToAccessible.js';

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
    const { id } = await resolveAgentRef(ctx.db, input.agentRef.trim());
    const agent = await ctx.db.agent.findFirst({
      where: { id, deletedAt: null },
      select: { organizationId: true, ownerUserId: true },
    });
    if (!agent) throw new Error('Forbidden');
    await requireOwnerOrOrgRole(ctx, agent, 'ADMIN');
    return { organizationId: null, agentId: id, appId: null };
  }
  const { id } = await resolveAppRef(ctx.db, input.appRef!.trim());
  // Live AND installed: an uninstalled App must not keep supplying its owner
  // to the write gate (Copilot on PR #1160) — same rule as the read side.
  const app = await ctx.db.app.findFirst({
    where: { id, deletedAt: null, uninstalledAt: null },
    select: { organizationId: true, ownerUserId: true },
  });
  if (!app) throw new Error('Forbidden');
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
    if (!agent) throw new Error('Forbidden');
    return requireOwnerOrOrgRole(ctx, agent, 'ADMIN');
  }
  const app = await ctx.db.app.findFirst({
    where: { id: scope.appId!, deletedAt: null, uninstalledAt: null },
    select: { organizationId: true, ownerUserId: true },
  });
  if (!app) throw new Error('Forbidden');
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
        deletedAt: null,
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
