/**
 * The BILLING platform role's two refusals (#5012, Billing A5).
 *
 * BILLING is a platform role for a payment service: it may write credit grants and adjustments and nothing else
 * (`mayWriteLedger` in `resolvers.helpers.ts`). It is never an organization member's, a memory subscription's or an
 * invitation's role, and never combined with another platform role on one user, because the role exists to bound
 * what a leaked key of that user can reach (gate ruling 10.1). Spec:
 * hrn:node:hadronmemory.com:specs:cor:api:010:01 (Proposed line).
 *
 * Both refusals are `BAD_USER_INPUT` with one fixed sentence (the code is the contract; the message names the
 * condition only). Callers judge them AFTER their own authorization gate, so a refused caller gets the gate's answer
 * whatever the values (the #2984 rule), and BEFORE their first write.
 */
import { GraphQLError } from 'graphql';

export const BILLING_MEMBER_ROLE_REFUSAL =
  'BILLING is a platform role and cannot be given to a member, a subscription or an invitation.';

export const BILLING_COMBINED_ROLE_REFUSAL = 'BILLING cannot be combined with another platform role.';

/**
 * Refuse BILLING as the role of an organization member, a memory subscription or an invitation. Every write of a
 * `Role`-typed member column that takes caller input calls this; the inventory pin (G1 in
 * `resolvers.billingRole5012.test.ts`) fails when a new one does not.
 */
export function refuseBillingMemberRole(role: string | null | undefined): void {
  if (role === 'BILLING') {
    throw new GraphQLError(BILLING_MEMBER_ROLE_REFUSAL, { extensions: { code: 'BAD_USER_INPUT' } });
  }
}

/** Refuse a platform-roles list that holds BILLING together with any other role (gate ruling 10.1). */
export function refuseCombinedBillingRole(roles: readonly string[]): void {
  if (roles.includes('BILLING') && new Set(roles).size > 1) {
    throw new GraphQLError(BILLING_COMBINED_ROLE_REFUSAL, { extensions: { code: 'BAD_USER_INPUT' } });
  }
}

/** The platform roles that rank in an access threshold: every `Role` but BILLING. */
export type ThresholdRole = 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER';

/**
 * Drop BILLING from a platform-roles list before handing it to a consumer typed on the four threshold roles (the
 * shared `@hadron-memory/access-control` `Subject`). BILLING confers no read, write or management access anywhere,
 * so leaving it out of an effective-access computation changes no answer; it only keeps the four-valued type honest.
 */
export function thresholdRoles(roles: readonly string[] | undefined): ThresholdRole[] | undefined {
  return roles?.filter((r): r is ThresholdRole => r !== 'BILLING');
}
