import { GraphQLError } from 'graphql';

/**
 * #2984 (Holger V49, 2026-11-01): the limits on a platform or org user invitation's `expiresInDays` and
 * `maxActivations`. hrn:node:hadronmemory.com:specs:cor:dmo:040:05 records them.
 * - `expiresInDays`: 1 to 10; omitted or null means 10 days, so no new invitation ever lacks an expiry.
 * - `maxActivations`: 2 to 1000; omitted or null means 2, so an explicit 1 is refused and no single-use invite is made.
 * 0 and negatives are refused. Existing rows are untouched: the rule covers creation only.
 */
export const INVITE_EXPIRES_IN_DAYS_MIN = 1;
export const INVITE_EXPIRES_IN_DAYS_MAX = 10;
export const INVITE_EXPIRES_IN_DAYS_DEFAULT = 10;
export const INVITE_MAX_ACTIVATIONS_MIN = 2;
export const INVITE_MAX_ACTIVATIONS_MAX = 1000;
export const INVITE_MAX_ACTIVATIONS_DEFAULT = 2;

const refusal = (arg: string, min: number, max: number) =>
  // A typed refusal carries its own message and no request id (hrn:node:hadronmemory.com:specs:cor:api:260:01).
  new GraphQLError(`${arg} must be a whole number from ${min} to ${max}.`, { extensions: { code: 'BAD_USER_INPUT' } });

const outOfRange = (v: number, min: number, max: number) => !(Number.isInteger(v) && v >= min && v <= max);

/**
 * Refuse an out-of-range limit before any write. GraphQL `Int` has already refused fractions and values past 2^31-1.
 * Callers with an authorization gate run this AFTER it, so a refused caller never learns the value was also bad.
 */
export function assertInviteLimits(
  { expiresInDays, maxActivations }: { expiresInDays?: number | null; maxActivations?: number | null },
): void {
  if (expiresInDays != null && outOfRange(expiresInDays, INVITE_EXPIRES_IN_DAYS_MIN, INVITE_EXPIRES_IN_DAYS_MAX)) {
    throw refusal('expiresInDays', INVITE_EXPIRES_IN_DAYS_MIN, INVITE_EXPIRES_IN_DAYS_MAX);
  }
  if (maxActivations != null && outOfRange(maxActivations, INVITE_MAX_ACTIVATIONS_MIN, INVITE_MAX_ACTIVATIONS_MAX)) {
    throw refusal('maxActivations', INVITE_MAX_ACTIVATIONS_MIN, INVITE_MAX_ACTIVATIONS_MAX);
  }
}

/** The expiry for a validated `expiresInDays`: omitted or null means the 10-day default. */
export const inviteExpiresAt = (expiresInDays?: number | null): Date =>
  new Date(Date.now() + (expiresInDays ?? INVITE_EXPIRES_IN_DAYS_DEFAULT) * 24 * 60 * 60 * 1000);

/** The activation cap for a validated `maxActivations`: omitted or null means 2. */
export const inviteMaxActivations = (maxActivations?: number | null): number =>
  maxActivations ?? INVITE_MAX_ACTIVATIONS_DEFAULT;
