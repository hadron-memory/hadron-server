/** Org-admin write surface for the BYO Resend sender registry. */
import { GraphQLError } from 'graphql';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { encryptResendApiKey, normalizeResendFrom } from '../../../lib/resendSenders.js';
import type { Context } from './resolvers.helpers.js';
import { isOrgMemberOrAdmin, requireOrgRole } from './resolvers.helpers.js';

export interface CreateArgs {
  orgRef: string;
  from: string;
  apiKey: string;
  enabled?: boolean | null;
}

export interface UpdateArgs {
  ref: string;
  from?: string | null;
  apiKey?: string | null;
  enabled?: boolean | null;
}

export const resendSenderMutations = {
  createResendSender: async (_: unknown, args: CreateArgs, ctx: Context) => {
    const { id: organizationId } = await resolveOrgRef(ctx.db, args.orgRef);
    await requireOrgRole(ctx, organizationId, 'ADMIN');

    try {
      return await ctx.db.resendSender.create({
        data: {
          organizationId,
          fromAddress: normalizeResendFrom(args.from),
          apiKeyEncrypted: encryptResendApiKey(args.apiKey),
          enabled: args.enabled ?? true,
          createdBy: ctx.userId ?? null,
        },
      });
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'P2002') {
        throw new GraphQLError('This organization already has a Resend sender.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      throw err;
    }
  },

  updateResendSender: async (_: unknown, args: UpdateArgs, ctx: Context) => {
    const sender = await ctx.db.resendSender.findUnique({ where: { id: args.ref } });
    if (!sender || !(await isOrgMemberOrAdmin(ctx, sender.organizationId))) {
      throw new GraphQLError('Resend sender not found.', { extensions: { code: 'NOT_FOUND' } });
    }
    await requireOrgRole(ctx, sender.organizationId, 'ADMIN');

    return ctx.db.resendSender.update({
      where: { id: sender.id },
      data: {
        ...(args.from != null ? { fromAddress: normalizeResendFrom(args.from) } : {}),
        ...(args.apiKey != null ? { apiKeyEncrypted: encryptResendApiKey(args.apiKey) } : {}),
        ...(args.enabled != null ? { enabled: args.enabled } : {}),
        updatedBy: ctx.userId ?? null,
      },
    });
  },

  deleteResendSender: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    const sender = await ctx.db.resendSender.findUnique({ where: { id: ref } });
    if (!sender || !(await isOrgMemberOrAdmin(ctx, sender.organizationId))) {
      throw new GraphQLError('Resend sender not found.', { extensions: { code: 'NOT_FOUND' } });
    }
    await requireOrgRole(ctx, sender.organizationId, 'ADMIN');
    await ctx.db.resendSender.delete({ where: { id: sender.id } });
    return true;
  },
};
