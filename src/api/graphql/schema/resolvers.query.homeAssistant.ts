/**
 * Home Assistant instance read surface — uniform read conventions
 * (cor:api:120): find-one by ref, paginated list scoped to the caller's
 * member orgs via the SHARED org-scope helper (no bespoke gate — the #362
 * invariant). `tokenEncrypted` never crosses this surface. Mirrors
 * resolvers.query.mcp.ts, minus the live tools/list — the op catalog is
 * static, so browsing it needs no upstream round-trip.
 */
import { GraphQLError } from 'graphql';
import type { Context } from './resolvers.helpers.js';
import { clampListTake, isOrgMemberOrAdmin, resolveOrgScope } from './resolvers.helpers.js';
import { haOpAllowed, haRunToolName, HA_OPS } from '../../../lib/homeAssistant.js';

export const homeAssistantQueries = {
  /**
   * Fetch one registered instance. Null for missing AND for
   * not-a-member-of-its-org — indistinguishable by design.
   */
  homeAssistantInstance: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    const instance = await ctx.db.homeAssistantInstance.findUnique({ where: { id: ref } });
    if (!instance) return null;
    if (!(await isOrgMemberOrAdmin(ctx, instance.organizationId))) return null;
    return instance;
  },

  /**
   * Uniform paginated list (cor:api:120): default scope is the caller's
   * member orgs; orgId narrows per cor:api:100:01 (non-member → empty
   * page, no disclosure, no admin bypass).
   */
  homeAssistantInstances: async (
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
        : ctx.db.homeAssistantInstance.findMany({
            where,
            orderBy: [{ slug: 'asc' }, { id: 'asc' }],
            take,
            skip: Math.max(0, offset ?? 0),
          }),
      ctx.db.homeAssistantInstance.count({ where }),
    ]);
    return { items, total };
  },

  /**
   * The ops one registered instance exposes (the closed HA_OPS catalog
   * filtered by the row's allowlist) — what authors browse to pick
   * `data.tools` entries; what this returns IS what a run can call. Org
   * membership required; same null-for-missing posture as
   * homeAssistantInstance. A disabled instance errors typed and loud
   * (the mcpServerTools posture — its ops would not resolve in a run).
   */
  homeAssistantInstanceOps: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    const instance = await ctx.db.homeAssistantInstance.findUnique({ where: { id: ref } });
    if (!instance || !(await isOrgMemberOrAdmin(ctx, instance.organizationId))) return null;
    if (!instance.enabled) {
      throw new GraphQLError('This Home Assistant instance is disabled — enable it to browse its ops.', {
        extensions: { code: 'HA_INSTANCE_DISABLED' },
      });
    }
    return HA_OPS.filter((def) => haOpAllowed(instance, def.op)).map((def) => ({
      op: def.op,
      description: def.description,
      runToolName: haRunToolName(instance.slug, def.op),
      inputSchema: def.inputSchema,
    }));
  },
};
