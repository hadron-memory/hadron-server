/**
 * External-MCP-server read surface (hadrontool-mcp conduit) — uniform read
 * conventions (cor:api:120): find-one by ref, paginated list scoped to the
 * caller's member orgs via the SHARED org-scope helper (no bespoke gate —
 * the #362 invariant). `headersEncrypted` never crosses this surface; the
 * GraphQL type exposes only `hasHeaders`.
 */
import type { Context } from './resolvers.helpers.js';
import { clampListTake, isOrgMemberOrAdmin, resolveOrgScope } from './resolvers.helpers.js';
import { listMcpTools } from '../../../lib/mcpToolClient.js';
import {
  decryptMcpHeaders,
  mcpRunToolName,
  mcpToolAllowed,
  MAX_RUN_TOOL_NAME_LENGTH,
  MCP_UPSTREAM_TOOL_RE,
} from '../../../lib/mcpServers.js';

export const mcpQueries = {
  /**
   * Fetch one registered MCP server. Null for missing AND for
   * not-a-member-of-its-org — indistinguishable by design.
   */
  mcpServer: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    const server = await ctx.db.mcpServer.findUnique({ where: { id: ref } });
    if (!server) return null;
    if (!(await isOrgMemberOrAdmin(ctx, server.organizationId))) return null;
    return server;
  },

  /**
   * Uniform paginated list (cor:api:120): default scope is the caller's
   * member orgs; orgId narrows per cor:api:100:01 (non-member → empty
   * page, no disclosure, no admin bypass).
   */
  mcpServers: async (
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
        : ctx.db.mcpServer.findMany({
            where,
            orderBy: [{ slug: 'asc' }, { id: 'asc' }],
            take,
            skip: Math.max(0, offset ?? 0),
          }),
      ctx.db.mcpServer.count({ where }),
    ]);
    return { items, total };
  },

  /**
   * Live `tools/list` passthrough for one registered server — what authors
   * browse to pick `data.tools` entries. Applies the same admissibility
   * filter as run-tool materialization (allowlist + name grammar + length),
   * so what this returns IS what a run can call. Org membership required;
   * same null-for-missing posture as `mcpServer`.
   */
  mcpServerTools: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    const server = await ctx.db.mcpServer.findUnique({ where: { id: ref } });
    if (!server || !(await isOrgMemberOrAdmin(ctx, server.organizationId))) return null;
    const tools = await listMcpTools({ url: server.url, headers: decryptMcpHeaders(server) });
    return tools
      .filter(
        (t) =>
          mcpToolAllowed(server, t.name) &&
          MCP_UPSTREAM_TOOL_RE.test(t.name) &&
          mcpRunToolName(server.slug, t.name).length <= MAX_RUN_TOOL_NAME_LENGTH,
      )
      .map((t) => ({
        name: t.name,
        description: t.description ?? null,
        runToolName: mcpRunToolName(server.slug, t.name),
        inputSchema: t.inputSchema,
      }));
  },
};
