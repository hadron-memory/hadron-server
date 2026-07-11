/**
 * External-MCP-server write surface (hadrontool-mcp conduit registry).
 * Registration is org-ADMIN gated; the row grants nothing by itself —
 * every run-time call still walks the policy chain as
 * `tool.mcp__<slug>__<tool>` plus the action budget. Static headers are
 * the v1 auth posture: encrypted at rest with tokenCrypto, write-only on
 * this surface (update replaces or clears; nothing ever reads them back).
 */
import { GraphQLError } from 'graphql';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import type { Context } from './resolvers.helpers.js';
import { isOrgMemberOrAdmin, requireOrgRole } from './resolvers.helpers.js';
import { encryptMcpHeaders, MCP_SLUG_RE, validateMcpServerUrl } from '../../../lib/mcpServers.js';

export interface CreateArgs {
  orgRef: string;
  slug: string;
  name: string;
  url: string;
  headers?: Record<string, unknown> | null;
  toolAllowlist?: string[] | null;
  enabled?: boolean | null;
}

export interface UpdateArgs {
  ref: string;
  name?: string | null;
  url?: string | null;
  /** JSON object replaces the stored headers; explicit null via clearHeaders. */
  headers?: Record<string, unknown> | null;
  clearHeaders?: boolean | null;
  toolAllowlist?: string[] | null;
  enabled?: boolean | null;
}

function validateAllowlist(list: string[]): string[] {
  const cleaned = [...new Set(list.map((t) => t.trim()).filter((t) => t.length > 0))];
  if (cleaned.length > 200) {
    throw new GraphQLError('toolAllowlist is too long (max 200 entries).', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  return cleaned;
}

export const mcpMutations = {
  /** Register an external MCP server (org ADMIN/OWNER; slug unique per org). */
  createMcpServer: async (_: unknown, args: CreateArgs, ctx: Context) => {
    const { id: organizationId } = await resolveOrgRef(ctx.db, args.orgRef);
    await requireOrgRole(ctx, organizationId, 'ADMIN');

    const slug = args.slug.trim().toLowerCase();
    if (!MCP_SLUG_RE.test(slug)) {
      throw new GraphQLError('slug must be lowercase [a-z0-9-], start alphanumeric, max 24 chars.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    validateMcpServerUrl(args.url);
    if (!args.name.trim()) {
      throw new GraphQLError('name is required.', { extensions: { code: 'BAD_USER_INPUT' } });
    }

    try {
      return await ctx.db.mcpServer.create({
        data: {
          organizationId,
          slug,
          name: args.name.trim(),
          url: args.url,
          headersEncrypted: args.headers != null ? encryptMcpHeaders(args.headers) : null,
          toolAllowlist: args.toolAllowlist ? validateAllowlist(args.toolAllowlist) : [],
          enabled: args.enabled ?? true,
          createdBy: ctx.userId ?? null,
        },
      });
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'P2002') {
        throw new GraphQLError(`An MCP server with slug "${slug}" already exists in this organization.`, {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      throw err;
    }
  },

  /**
   * Update a registered server. The slug is immutable — flow nodes
   * reference it inside `data.tools` names, so renaming would silently
   * orphan them; register a new slug instead.
   */
  updateMcpServer: async (_: unknown, args: UpdateArgs, ctx: Context) => {
    const server = await ctx.db.mcpServer.findUnique({ where: { id: args.ref } });
    // Missing and not-my-org answer identically (no existence disclosure);
    // a MEMBER without ADMIN gets Forbidden below.
    if (!server || !(await isOrgMemberOrAdmin(ctx, server.organizationId))) {
      throw new GraphQLError('MCP server not found.', { extensions: { code: 'NOT_FOUND' } });
    }
    await requireOrgRole(ctx, server.organizationId, 'ADMIN');

    if (args.headers != null && args.clearHeaders) {
      throw new GraphQLError('Pass headers OR clearHeaders, not both.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    if (args.url != null) validateMcpServerUrl(args.url);
    if (args.name != null && !args.name.trim()) {
      throw new GraphQLError('name must not be empty.', { extensions: { code: 'BAD_USER_INPUT' } });
    }

    return ctx.db.mcpServer.update({
      where: { id: server.id },
      data: {
        ...(args.name != null ? { name: args.name.trim() } : {}),
        ...(args.url != null ? { url: args.url } : {}),
        ...(args.headers != null ? { headersEncrypted: encryptMcpHeaders(args.headers) } : {}),
        ...(args.clearHeaders ? { headersEncrypted: null } : {}),
        ...(args.toolAllowlist != null ? { toolAllowlist: validateAllowlist(args.toolAllowlist) } : {}),
        ...(args.enabled != null ? { enabled: args.enabled } : {}),
        updatedBy: ctx.userId ?? null,
      },
    });
  },

  /**
   * Hard-delete a registered server (org ADMIN/OWNER). Runs referencing
   * its tools fail their hop loud afterwards — the wanted signal.
   */
  deleteMcpServer: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    const server = await ctx.db.mcpServer.findUnique({ where: { id: ref } });
    if (!server || !(await isOrgMemberOrAdmin(ctx, server.organizationId))) {
      throw new GraphQLError('MCP server not found.', { extensions: { code: 'NOT_FOUND' } });
    }
    await requireOrgRole(ctx, server.organizationId, 'ADMIN');
    await ctx.db.mcpServer.delete({ where: { id: server.id } });
    return true;
  },
};
