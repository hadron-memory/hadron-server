/**
 * #1631 PR3 (cor:aut:040:05): the owner's own passkey records. Reading them needs no ceremony (only registering and
 * revoking do, cor:aut:040:02 and 040:08), but only the owner sees them, the cancel record included: an App key, even
 * one acting for the owner, and an impersonation session get nothing. Dark with the registration switch (#1895,
 * `deploymentSchema`).
 */
import { GraphQLError } from 'graphql';
import type { Context } from './resolvers.helpers.js';

export const passkeyQueries = {
  myPasskeys: async (_: unknown, __: unknown, ctx: Context) => {
    if (!ctx.userId || ctx.appId) {
      throw new GraphQLError('myPasskeys requires the owner\'s own user credential.', { extensions: { code: 'UNAUTHENTICATED' } });
    }
    if (ctx.impersonation) throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
    const rows = await ctx.db.passkeyCredential.findMany({
      where: { ownerId: ctx.userId },
      orderBy: [{ registeredAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      credentialId: Buffer.from(r.credentialId).toString('base64url'),
      label: r.label,
      transports: r.transports,
      backupEligible: r.backupEligible,
      backedUp: r.backedUp,
      registeredAt: r.registeredAt,
      lastUsedAt: r.lastUsedAt,
      revokedAt: r.revokedAt,
      window: r.windowEndsAt
        ? { endsAt: r.windowEndsAt, endedAt: r.windowEndedAt, outcome: r.windowOutcome, registrationMethod: r.registrationMethod }
        : null,
      cancel: r.cancelledAt ? { at: r.cancelledAt, ip: r.cancelIp, userAgent: r.cancelUserAgent } : null,
    }));
  },
};
