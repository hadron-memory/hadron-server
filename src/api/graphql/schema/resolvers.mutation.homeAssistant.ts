/**
 * Home Assistant instance write surface (hadrontool-home-assistant
 * registry, hadron-server#640). Registration is org-ADMIN gated; the row
 * grants nothing by itself — every run-time call still walks the policy
 * chain as `tool.ha__<slug>__<op>` plus the action budget. The long-lived
 * access token is encrypted at rest with tokenCrypto and WRITE-ONLY on
 * this surface (update replaces; nothing ever reads it back). Mirrors
 * resolvers.mutation.mcp.ts.
 */
import { GraphQLError } from 'graphql';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import type { Context } from './resolvers.helpers.js';
import { isOrgMemberOrAdmin, requireOrgRole } from './resolvers.helpers.js';
import {
  encryptHaAccessToken,
  validateHaInstanceUrl,
  validateHaOpAllowlist,
  HA_SLUG_RE,
} from '../../../lib/homeAssistant.js';

export interface CreateHaArgs {
  orgRef: string;
  slug: string;
  name: string;
  url: string;
  accessToken: string;
  opAllowlist?: string[] | null;
  enabled?: boolean | null;
}

export interface UpdateHaArgs {
  ref: string;
  name?: string | null;
  url?: string | null;
  /** Replaces the stored token; never cleared (an instance without a token is unusable). */
  accessToken?: string | null;
  opAllowlist?: string[] | null;
  enabled?: boolean | null;
}

export const homeAssistantMutations = {
  /** Register a Home Assistant instance (org ADMIN/OWNER; slug unique per org). */
  createHomeAssistantInstance: async (_: unknown, args: CreateHaArgs, ctx: Context) => {
    const { id: organizationId } = await resolveOrgRef(ctx.db, args.orgRef);
    await requireOrgRole(ctx, organizationId, 'ADMIN');

    const slug = args.slug.trim().toLowerCase();
    if (!HA_SLUG_RE.test(slug)) {
      throw new GraphQLError('slug must be lowercase [a-z0-9-], start alphanumeric, max 24 chars.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    validateHaInstanceUrl(args.url);
    if (!args.name.trim()) {
      throw new GraphQLError('name is required.', { extensions: { code: 'BAD_USER_INPUT' } });
    }

    try {
      return await ctx.db.homeAssistantInstance.create({
        data: {
          organizationId,
          slug,
          name: args.name.trim(),
          url: args.url,
          tokenEncrypted: encryptHaAccessToken(args.accessToken),
          opAllowlist: args.opAllowlist ? validateHaOpAllowlist(args.opAllowlist) : [],
          enabled: args.enabled ?? true,
          createdBy: ctx.userId ?? null,
        },
      });
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'P2002') {
        throw new GraphQLError(
          `A Home Assistant instance with slug "${slug}" already exists in this organization.`,
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }
      throw err;
    }
  },

  /**
   * Update a registered instance. The slug is immutable — flow nodes
   * reference it inside `data.tools` names, so renaming would silently
   * orphan them; register a new slug instead.
   */
  updateHomeAssistantInstance: async (_: unknown, args: UpdateHaArgs, ctx: Context) => {
    const instance = await ctx.db.homeAssistantInstance.findUnique({ where: { id: args.ref } });
    // Missing and not-my-org answer identically (no existence disclosure);
    // a MEMBER without ADMIN gets Forbidden below.
    if (!instance || !(await isOrgMemberOrAdmin(ctx, instance.organizationId))) {
      throw new GraphQLError('Home Assistant instance not found.', {
        extensions: { code: 'NOT_FOUND' },
      });
    }
    await requireOrgRole(ctx, instance.organizationId, 'ADMIN');

    if (args.url != null) validateHaInstanceUrl(args.url);
    if (args.name != null && !args.name.trim()) {
      throw new GraphQLError('name must not be empty.', { extensions: { code: 'BAD_USER_INPUT' } });
    }

    return ctx.db.homeAssistantInstance.update({
      where: { id: instance.id },
      data: {
        ...(args.name != null ? { name: args.name.trim() } : {}),
        ...(args.url != null ? { url: args.url } : {}),
        ...(args.accessToken != null ? { tokenEncrypted: encryptHaAccessToken(args.accessToken) } : {}),
        ...(args.opAllowlist != null ? { opAllowlist: validateHaOpAllowlist(args.opAllowlist) } : {}),
        ...(args.enabled != null ? { enabled: args.enabled } : {}),
        updatedBy: ctx.userId ?? null,
      },
    });
  },

  /**
   * Hard-delete a registered instance (org ADMIN/OWNER). Runs referencing
   * its ops fail their hop loud afterwards — the wanted signal.
   */
  deleteHomeAssistantInstance: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    const instance = await ctx.db.homeAssistantInstance.findUnique({ where: { id: ref } });
    if (!instance || !(await isOrgMemberOrAdmin(ctx, instance.organizationId))) {
      throw new GraphQLError('Home Assistant instance not found.', {
        extensions: { code: 'NOT_FOUND' },
      });
    }
    await requireOrgRole(ctx, instance.organizationId, 'ADMIN');
    await ctx.db.homeAssistantInstance.delete({ where: { id: instance.id } });
    return true;
  },
};
