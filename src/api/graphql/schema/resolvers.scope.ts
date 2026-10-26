/**
 * Spec 049 Phase 2 — the Scope read + write surface (D-2026-09-13-001).
 *
 * Thin on purpose: every rule lives in `lib/scopes.ts` so the MCP tools and
 * these resolvers are two entry points over ONE computation. What is here is
 * the `cor:api:120` shape (find-one by ref, `{ items, total }` find-many with
 * the `cor:api:100:01` orgId scope), `cor:api:140` ref naming, and the
 * create/update/delete trio.
 *
 * Authorization (plan §8):
 *   - reads go through `canReadScope` / `readableScopesWhere`; a scope the
 *     caller may not read is null / absent, the same as a nonexistent one;
 *   - writes go through `resolveScopeOwnerForWrite` / `requireScopeWrite`;
 *   - the memory list a caller sees is ALWAYS `stored ∩ accessible` (S2), with
 *     the rest as a count — a scope never grants and never enumerates what the
 *     caller cannot read (§8.2).
 */

import { GraphQLError } from 'graphql';
import { Prisma, type Scope } from '../../../generated/prisma/index.js';
import {
  type Context,
  clampListTake,
  getAccessibleMemoryIds,
  resolveOrgScope,
} from './resolvers.helpers.js';
import { resolveScopeRef } from '../../../lib/entityRef/scopeRef.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { narrowToAccessible } from '../../../lib/auth/narrowToAccessible.js';
import {
  appContextIfReadable,
  assertScopeName,
  canReadScope,
  explainScope,
  ownerIdOf,
  ownerTypeOf,
  readableScopesWhere,
  requireScopeWrite,
  resolveScopeByNameInApp,
  resolveScopeMemoryRefs,
  resolveScopeOwnerForWrite,
  scopeMemoryIds,
  type ScopeOwnerType,
} from '../../../lib/scopes.js';
import { forbiddenError, unauthenticatedError } from '../../../lib/refusals.js';

export interface ScopeFilterInput {
  ownerType?: ScopeOwnerType | null;
  ownerRef?: string | null;
  appRef?: string | null;
  name?: string | null;
}

const EMPTY_PAGE = { items: [] as Scope[], total: 0 };

/** Translate the per-owner partial unique into a typed refusal. */
function translateNameTaken(e: unknown, name: string): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    throw new GraphQLError(`A scope named "${name}" already exists for this owner.`, {
      extensions: { code: 'SCOPE_NAME_TAKEN' },
    });
  }
  throw e;
}

/** Resolve a scope ref to a LIVE row the caller may read, or null (no disclosure). */
async function readableScope(ctx: Context, ref: string): Promise<Scope | null> {
  let id: string;
  try {
    ({ id } = await resolveScopeRef(ctx.db, ref));
  } catch {
    return null;
  }
  const scope = await ctx.db.scope.findFirst({ where: { id, deletedAt: null } });
  if (!scope || !(await canReadScope(ctx, scope))) return null;
  return scope;
}

/**
 * Every scope mutation starts here. Impersonation is a READ-ONLY support view
 * (#876): the Apollo plugin already blocks mutations wholesale, and this keeps
 * the module self-sufficient rather than depending on a gate two layers up —
 * `createdBy: ctx.userId` below would otherwise stamp the TARGET as author.
 */
function requireWriter(ctx: Context): string {
  if (ctx.impersonation) throw forbiddenError();
  if (!ctx.userId) throw unauthenticatedError();
  return ctx.userId;
}

/** Resolve a scope ref for a WRITE: not-found and not-readable both read as not found. */
async function writableScope(ctx: Context, ref: string): Promise<Scope> {
  const scope = await readableScope(ctx, ref);
  if (!scope) {
    throw new GraphQLError(`No match for scopeRef "${ref}".`, { extensions: { code: 'NOT_FOUND' } });
  }
  await requireScopeWrite(ctx, scope);
  return scope;
}

export const scopeQueries = {
  scope: async (_: unknown, { ref }: { ref: string }, ctx: Context): Promise<Scope | null> =>
    readableScope(ctx, ref),

  scopes: async (
    _: unknown,
    { filter, orgId, limit, offset }: { filter?: ScopeFilterInput | null; orgId?: string | null; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    const scope = await resolveOrgScope(ctx, orgId);
    if (!scope) return EMPTY_PAGE;
    const where: Prisma.ScopeWhereInput[] = [await readableScopesWhere(ctx, scope.memberOrgIds)];
    if (scope.scopedOrgId) {
      // cor:api:100:01 — the org view: that org's own scopes, its Apps' and its Agents'.
      where.push({
        OR: [
          { organizationId: scope.scopedOrgId },
          { app: { organizationId: scope.scopedOrgId } },
          { agent: { organizationId: scope.scopedOrgId } },
        ],
      });
    }
    if (filter?.name) where.push({ name: filter.name });
    if (filter?.ownerRef || filter?.ownerType) {
      if (!filter.ownerRef || !filter.ownerType) {
        throw new GraphQLError('filter.ownerType and filter.ownerRef go together.', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      try {
        const ref = filter.ownerRef.trim();
        if (filter.ownerType === 'ORGANIZATION') where.push({ organizationId: (await resolveOrgRef(ctx.db, ref)).id });
        else if (filter.ownerType === 'AGENT') where.push({ agentId: (await resolveAgentRef(ctx.db, ref)).id });
        else where.push({ appId: (await resolveAppRef(ctx.db, ref)).id });
      } catch {
        return EMPTY_PAGE; // unresolvable ref ⇒ empty page, never an existence oracle
      }
    }
    if (filter?.appRef) {
      // The App's CONTEXT — what a name would resolve against there.
      let appId: string;
      try {
        ({ id: appId } = await resolveAppRef(ctx.db, filter.appRef.trim()));
      } catch {
        return EMPTY_PAGE;
      }
      // Gated before the context is expanded (Codex P1 on PR #1160): a caller who
      // may not read the App gets the empty page, the same as for no such App.
      const app = await appContextIfReadable(ctx, appId);
      if (!app) return EMPTY_PAGE;
      where.push({
        OR: [
          { appId },
          ...(app.agentIds.length ? [{ agentId: { in: app.agentIds } }] : []),
          ...(app.organizationId ? [{ organizationId: app.organizationId }] : []),
        ],
      });
    }
    const take = clampListTake(limit);
    const skip = Math.max(0, offset ?? 0);
    const [total, items] = await Promise.all([
      ctx.db.scope.count({ where: { AND: where } }),
      take === 0
        ? Promise.resolve([] as Scope[])
        : ctx.db.scope.findMany({ where: { AND: where }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take, skip }),
    ]);
    return { items, total };
  },

  scopeExplain: async (
    _: unknown,
    { scopeRef, name, appRef, loc }: { scopeRef?: string | null; name?: string | null; appRef?: string | null; loc?: string | null },
    ctx: Context,
  ) => {
    let scope: Scope | null = null;
    let shadowed: Scope[] = [];
    if (scopeRef) {
      scope = await readableScope(ctx, scopeRef);
    } else if (name) {
      // A bare name is unique only per owner, so it needs an App context —
      // passed explicitly on GraphQL (no active App exists for a user here),
      // or the App-key credential's own App.
      let appId = ctx.appId ?? null;
      if (appRef) {
        try {
          ({ id: appId } = await resolveAppRef(ctx.db, appRef.trim()));
        } catch {
          return null;
        }
      }
      if (!appId) {
        // #1173: the condition, not `appRef` — the GraphQL argument name is
        // unactionable for the CLI and portal readers of the same string.
        throw new GraphQLError('Resolving a scope by name needs an App context.', {
          extensions: { code: 'BAD_USER_INPUT', missing: 'appContext' },
        });
      }
      const r = await resolveScopeByNameInApp(ctx, name, appId);
      if (r.ambiguousAmong.length) {
        throw new GraphQLError(
          `"${name}" is owned by ${r.ambiguousAmong.length} Agents installed in this App; address one by id: ${r.ambiguousAmong.map((s) => s.id).join(', ')}.`,
          { extensions: { code: 'SCOPE_NAME_AMBIGUOUS', candidates: r.ambiguousAmong.map((s) => s.id) } },
        );
      }
      scope = r.winner;
      shadowed = r.shadowed;
    } else {
      throw new GraphQLError('No scope was named: give a scope reference, or a name with an App context.', {
        extensions: { code: 'BAD_USER_INPUT', missing: 'scopeSelector' },
      });
    }
    if (!scope) return null;
    const ex = await explainScope(ctx, scope.id, loc);
    const rows = await ctx.db.memory.findMany({ where: { id: { in: ex.memoryIds } } });
    const byId = new Map(rows.map((m) => [m.id, m]));
    return {
      scope,
      resolvedVia: ownerTypeOf(scope),
      shadowed,
      memories: ex.memoryIds.map((id) => byId.get(id)).filter((m) => !!m),
      droppedCount: ex.droppedCount,
      winner: ex.winnerMemoryId ? (byId.get(ex.winnerMemoryId) ?? null) : null,
    };
  },
};

export const scopeMutations = {
  createScope: async (
    _: unknown,
    { input }: { input: { name: string; description?: string | null; organizationRef?: string | null; agentRef?: string | null; appRef?: string | null; memoryRefs: string[] } },
    ctx: Context,
  ): Promise<Scope> => {
    const writer = requireWriter(ctx);
    const name = input.name.trim();
    assertScopeName(name);
    const owner = await resolveScopeOwnerForWrite(ctx, input);
    const memoryIds = await resolveScopeMemoryRefs(ctx, input.memoryRefs ?? []);
    try {
      return await ctx.db.$transaction(async (tx) => {
        const scope = await tx.scope.create({
          data: { name, description: input.description?.trim() || null, ...owner, createdBy: writer },
        });
        await tx.scopeMemory.createMany({
          data: memoryIds.map((memoryId, position) => ({ scopeId: scope.id, memoryId, position })),
        });
        return scope;
      });
    } catch (e) {
      translateNameTaken(e, name);
    }
  },

  updateScope: async (
    _: unknown,
    { ref, input }: { ref: string; input: { name?: string | null; description?: string | null; memoryRefs?: string[] | null } },
    ctx: Context,
  ): Promise<Scope> => {
    const writer = requireWriter(ctx);
    const scope = await writableScope(ctx, ref);
    // A name that was PASSED is validated, blank included — a blank rename must
    // be refused, not silently ignored (Copilot on PR #1160).
    const name = input.name != null ? input.name.trim() : undefined;
    if (name !== undefined) assertScopeName(name);
    const memoryIds = input.memoryRefs ? await resolveScopeMemoryRefs(ctx, input.memoryRefs) : null;
    try {
      return await ctx.db.$transaction(async (tx) => {
        const updated = await tx.scope.update({
          where: { id: scope.id },
          data: {
            ...(name !== undefined ? { name } : {}),
            ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
            updatedBy: writer,
          },
        });
        if (memoryIds) {
          // Replace, not merge: the input IS the new order.
          await tx.scopeMemory.deleteMany({ where: { scopeId: scope.id } });
          await tx.scopeMemory.createMany({
            data: memoryIds.map((memoryId, position) => ({ scopeId: scope.id, memoryId, position })),
          });
        }
        return updated;
      });
    } catch (e) {
      translateNameTaken(e, name ?? scope.name);
    }
  },

  deleteScope: async (_: unknown, { ref }: { ref: string }, ctx: Context): Promise<boolean> => {
    const writer = requireWriter(ctx);
    const scope = await writableScope(ctx, ref);
    // Soft delete; the per-owner name index is partial on deleted_at, so the
    // name is free again at once. The join rows stay with the tombstone.
    await ctx.db.scope.update({ where: { id: scope.id }, data: { deletedAt: new Date(), deletedBy: writer } });
    return true;
  },
};

/** The caller-relative projection of a Scope row — everything computed, nothing trusted from storage. */
export const scopeFieldResolvers = {
  Scope: {
    ownerType: (s: Scope): ScopeOwnerType => ownerTypeOf(s),
    ownerId: (s: Scope): string => ownerIdOf(s),
    ownerUrn: async (s: Scope, _: unknown, ctx: Context): Promise<string | null> => {
      if (s.appId) return (await ctx.db.app.findUnique({ where: { id: s.appId }, select: { urn: true } }))?.urn ?? null;
      if (s.agentId) return (await ctx.db.agent.findUnique({ where: { id: s.agentId }, select: { urn: true } }))?.urn ?? null;
      return (await ctx.db.organization.findUnique({ where: { id: s.organizationId! }, select: { urn: true } }))?.urn ?? null;
    },
    /** The memories the caller may read, in scope order, with their stored position. */
    memories: async (s: Scope, _: unknown, ctx: Context) => {
      const rows = await ctx.db.scopeMemory.findMany({
        where: { scopeId: s.id, memory: { deletedAt: null } }, // tombstones are gone for everyone
        orderBy: { position: 'asc' },
      });
      const accessible = await getAccessibleMemoryIds(ctx);
      const { kept } = narrowToAccessible(rows.map((r) => r.memoryId), accessible === null ? 'unrestricted' : new Set(accessible));
      const keptSet = new Set(kept);
      const memories = await ctx.db.memory.findMany({ where: { id: { in: kept } } });
      const byId = new Map(memories.map((m) => [m.id, m]));
      return rows
        .filter((r) => keptSet.has(r.memoryId) && byId.has(r.memoryId))
        .map((r) => ({ position: r.position, memory: byId.get(r.memoryId) }));
    },
    memoryCount: async (s: Scope, _: unknown, ctx: Context): Promise<number> => (await scopeMemoryIds(ctx.db, s.id)).length,
    /** How many of the scope's memories this caller may NOT read — count only (§8.2). */
    hiddenMemoryCount: async (s: Scope, _: unknown, ctx: Context): Promise<number> =>
      (await explainScope(ctx, s.id)).droppedCount,
  },
};
