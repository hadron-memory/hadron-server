import { GraphQLError } from 'graphql';

/**
 * #2984 (Holger V45): the limits on a platform or org user invitation's `expiresInDays` and `maxActivations`.
 * hrn:node:hadronmemory.com:specs:cor:dmo:040:05 calls both tunable and states no bounds; these are the ruled numbers.
 * Omitted or null keeps its meaning (no expiry; one activation). 0 and negatives are refused: `expiresInDays: 0` used
 * to mean "never expires" and `maxActivations: 0` made a link nobody could use.
 */
export const INVITE_EXPIRES_IN_DAYS_MAX = 3650;
export const INVITE_MAX_ACTIVATIONS_MAX = 1000;

const refusal = (arg: string, max: number) =>
  // A typed refusal carries its own message and no request id (hrn:node:hadronmemory.com:specs:cor:api:260:01).
  new GraphQLError(`${arg} must be a whole number from 1 to ${max}.`, { extensions: { code: 'BAD_USER_INPUT' } });

/**
 * Refuse an out-of-range limit before any write. GraphQL `Int` has already refused fractions and values past 2^31-1.
 * Callers with an authorization gate run this AFTER it, so a refused caller never learns the value was also bad.
 */
export function assertInviteLimits(
  { expiresInDays, maxActivations }: { expiresInDays?: number | null; maxActivations?: number | null },
): void {
  if (expiresInDays != null && !(Number.isInteger(expiresInDays) && expiresInDays >= 1 && expiresInDays <= INVITE_EXPIRES_IN_DAYS_MAX)) {
    throw refusal('expiresInDays', INVITE_EXPIRES_IN_DAYS_MAX);
  }
  if (maxActivations != null && !(Number.isInteger(maxActivations) && maxActivations >= 1 && maxActivations <= INVITE_MAX_ACTIVATIONS_MAX)) {
    throw refusal('maxActivations', INVITE_MAX_ACTIVATIONS_MAX);
  }
}

/** The expiry for a validated `expiresInDays`: null (omitted or null) means no expiry. */
export const inviteExpiresAt = (expiresInDays?: number | null): Date | null =>
  expiresInDays != null ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : null;
