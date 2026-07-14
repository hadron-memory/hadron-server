/** Sanitized org-member read surface for BYO Resend sender configuration. */
import type { Context } from './resolvers.helpers.js';
import { clampListTake, isOrgMemberOrAdmin, resolveOrgScope } from './resolvers.helpers.js';

export const resendSenderQueries = {
  resendSender: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    const sender = await ctx.db.resendSender.findUnique({ where: { id: ref } });
    if (!sender || !(await isOrgMemberOrAdmin(ctx, sender.organizationId))) return null;
    return sender;
  },

  resendSenders: async (
    _: unknown,
    { orgId, limit, offset }: { orgId?: string | null; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    const scope = await resolveOrgScope(ctx, orgId);
    if (!scope) return { items: [], total: 0 };
    const where = { organizationId: { in: scope.memberOrgIds } };
    const take = clampListTake(limit);
    const [items, total] = await Promise.all([
      take === 0
        ? Promise.resolve([])
        : ctx.db.resendSender.findMany({
            where,
            orderBy: [{ fromAddress: 'asc' }, { id: 'asc' }],
            take,
            skip: Math.max(0, offset ?? 0),
          }),
      ctx.db.resendSender.count({ where }),
    ]);
    return { items, total };
  },
};
