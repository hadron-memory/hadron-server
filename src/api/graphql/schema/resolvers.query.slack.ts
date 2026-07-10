/**
 * Slack-connection read surface (spec 043 Phase 2) — uniform read
 * conventions (cor:api:120): find-one by ref, paginated list scoped to the
 * caller's member orgs via the SHARED org-scope helper (no bespoke gate —
 * the #362 invariant).
 */
import type { Context } from './resolvers.helpers.js';
import { clampListTake, isOrgMemberOrAdmin, resolveOrgScope } from './resolvers.helpers.js';

export const slackQueries = {
  /**
   * Fetch one Slack connection. Null for missing AND for
   * not-a-member-of-its-org — indistinguishable by design (no existence
   * disclosure).
   */
  slackConnection: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    const connection = await ctx.db.slackConnection.findFirst({
      where: { id: ref, deletedAt: null },
    });
    if (!connection) return null;
    if (!(await isOrgMemberOrAdmin(ctx, connection.organizationId))) return null;
    return connection;
  },

  /**
   * Uniform paginated list (cor:api:120): default scope is the caller's
   * member orgs; orgId narrows per cor:api:100:01 (non-member -> empty
   * page, no disclosure, no admin bypass).
   */
  slackConnections: async (
    _: unknown,
    { orgId, limit, offset }: { orgId?: string | null; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    const scope = await resolveOrgScope(ctx, orgId);
    if (!scope) return { items: [], total: 0 };
    const where = { organizationId: { in: scope.memberOrgIds }, deletedAt: null };
    const take = clampListTake(limit);
    const [items, total] = await Promise.all([
      take === 0
        ? Promise.resolve([])
        : ctx.db.slackConnection.findMany({
            where,
            orderBy: [{ teamName: 'asc' }, { id: 'asc' }],
            take,
            skip: Math.max(0, offset ?? 0),
          }),
      ctx.db.slackConnection.count({ where }),
    ]);
    return { items, total };
  },
};
