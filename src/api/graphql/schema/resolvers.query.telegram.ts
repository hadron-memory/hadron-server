/**
 * Telegram-connection read surface (#597) — uniform read conventions (cor:api:120): find-one by ref, and a paginated
 * list scoped to the caller's member orgs through the SHARED org-scope helper (no bespoke gate, the #362 invariant).
 */
import type { Context } from './resolvers.helpers.js';
import { clampListTake, isOrgMemberOrAdmin, resolveOrgScope } from './resolvers.helpers.js';

export const telegramQueries = {
  /**
   * Fetch one Telegram connection. Null for a missing row AND for a caller who is not a live member of its org
   * (a revoked member included): indistinguishable by design, so ids cannot be probed.
   */
  telegramConnection: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    const connection = await ctx.db.telegramConnection.findFirst({ where: { id: ref, deletedAt: null } });
    if (!connection) return null;
    if (!(await isOrgMemberOrAdmin(ctx, connection.organizationId))) return null;
    return connection;
  },

  /**
   * Uniform paginated list (cor:api:120). Default scope: the caller's member orgs; orgRef narrows per cor:api:100:01
   * (a non-member gets an empty page, no disclosure, no admin bypass).
   */
  telegramConnections: async (
    _: unknown,
    { orgRef, limit, offset }: { orgRef?: string | null; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    const scope = await resolveOrgScope(ctx, orgRef);
    if (!scope) return { items: [], total: 0 };
    const where = { organizationId: { in: scope.memberOrgIds }, deletedAt: null };
    const take = clampListTake(limit);
    const [items, total] = await Promise.all([
      take === 0
        ? Promise.resolve([])
        : ctx.db.telegramConnection.findMany({
            where,
            orderBy: [{ botUsername: 'asc' }, { id: 'asc' }],
            take,
            skip: Math.max(0, offset ?? 0),
          }),
      ctx.db.telegramConnection.count({ where }),
    ]);
    return { items, total };
  },
};
