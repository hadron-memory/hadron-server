import { GraphQLError } from 'graphql';
import { type Context, isPlatformAdmin } from './resolvers.helpers.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { configFence, seedRateConfig, validatePolicy } from '../../../lib/rateLimit/index.js';
import { RATE_CLASSES, type FieldClass, type EnforcementMode } from '../../../lib/rateLimit/config.js';
import { generateId } from '../../../lib/id.js';
import type { RateLimitPolicy } from '../../../generated/prisma/index.js';

function requireRateAdmin(ctx: Context) {
  if (!ctx.userId || !isPlatformAdmin(ctx) || ctx.appId || ctx.appKeyId || ctx.sessionId || ctx.sessionBindingRefused || ctx.impersonation || isRunPrincipal(ctx)) {
    throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
  }
}
function project(p: RateLimitPolicy) {
  return { fieldClass: p.fieldClass, principalLimit: p.principalLimit, keyLimit: p.keyLimit, ipLimit: p.ipLimit,
    windowSeconds: p.windowSeconds, retentionSeconds: p.retentionSeconds, enforcementMode: p.enforcementMode,
    version: p.version, updatedAt: p.updatedAt.toISOString(), ipGroupingVersion: 'v1-ipv6-56' };
}
export const rateLimitQueries = {
  rateLimitPolicies: async (_: unknown, _args: unknown, ctx: Context) => {
    requireRateAdmin(ctx);
    return withAuthorizedTx(ctx, [], async live => requireRateAdmin(live), async tx => {
      await seedRateConfig(tx);
      return (await tx.rateLimitPolicy.findMany({ orderBy: { fieldClass: 'asc' } })).map(p => project(validatePolicy(p)));
    });
  },
};
export interface SetRateLimitInput {
  fieldClass: FieldClass;
  expectedVersion: number;
  principalLimit: number;
  keyLimit: number;
  ipLimit: number;
  enforcementMode?: EnforcementMode | null;
  changeReference: string;
}
export const rateLimitMutations = {
  setRateLimitPolicy: async (_: unknown, { input }: { input: SetRateLimitInput }, ctx: Context) => {
    requireRateAdmin(ctx);
    const { fieldClass, expectedVersion, principalLimit, keyLimit, ipLimit, changeReference } = input;
    if (!RATE_CLASSES.includes(fieldClass) || [expectedVersion,principalLimit,keyLimit,ipLimit].some(n => !Number.isInteger(n) || n < 1 || n > 2147483647) ||
        typeof changeReference !== 'string' || !changeReference.trim() || changeReference.length > 1000 ||
        (input.enforcementMode != null && !['LOG_ONLY','ENFORCING'].includes(input.enforcementMode))) {
      throw new GraphQLError('Invalid rate limit policy input.', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    return withAuthorizedTx(ctx, [], async live => requireRateAdmin(live), async tx => {
      await configFence(tx,true);
      const before = await tx.rateLimitPolicy.findUnique({ where: { fieldClass } });
      if (!before) throw new GraphQLError('Initialize rate policies before editing.', { extensions: { code: 'BAD_USER_INPUT' } });
      validatePolicy(before);
      if (before.version !== expectedVersion) throw new GraphQLError('Rate limit policy changed. Read it again.', { extensions: { code: 'CONFLICT' } });
      // cor:api:210:01: explicit null on this non-null stored mode is the same as omission.
      const enforcementMode = input.enforcementMode ?? before.enforcementMode;
      if (principalLimit === before.principalLimit && keyLimit === before.keyLimit && ipLimit === before.ipLimit && enforcementMode === before.enforcementMode) return project(before);
      const after = await tx.rateLimitPolicy.update({ where: { fieldClass }, data: { principalLimit, keyLimit, ipLimit, enforcementMode, version: { increment: 1 }, updatedAt: new Date() } });
      await tx.rateLimitPolicyAudit.create({ data: { id: generateId(), fieldClass, actorId: ctx.userId!, before: project(before), after: project(after), changeReference } });
      return project(after);
    });
  },
};
