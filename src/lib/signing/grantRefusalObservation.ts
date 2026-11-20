/**
 * #4546 (cor:acl:140:07): an anonymous observation of a verified ineligible proof. The proof spend has ALREADY committed;
 * this best-effort writer must never roll it back or change the bare refusal. No signer or failure reason is stored.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';

export interface GrantRefusalObservation {
  requestId: string;
  grantId: string;
  /** The proof transaction's DB clock, not a delayed writer's arrival time. */
  attemptedAt: Date;
}

/**
 * A separate bounded transaction holds no prover/authority anchors: grant, then request, then judge on the DB clock.
 * The open/unexpired predicate mirrors effectiveRequestState in requests.ts. GREATEST preserves the latest proof time
 * even if two independent observations acquire the grant in the reverse order. A lock/database/pool failure only loses
 * this optional observation; proof consumption and the caller's uniform refusal have already been decided.
 */
export async function recordGrantRefusalObservation(db: PrismaClient, observation: GrantRefusalObservation): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      // Prisma binds Date as timestamptz; normalize to the column's naive UTC before GREATEST, independent of session TZ.
      await tx.$executeRaw`SET LOCAL lock_timeout = '750ms'`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '1000ms'`;
      await tx.$queryRaw`SELECT id FROM grants WHERE id = ${observation.grantId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM grant_signing_requests
        WHERE id = ${observation.requestId} AND grant_id = ${observation.grantId} FOR UPDATE`;
      await tx.$executeRaw`UPDATE grant_signing_requests SET last_refused_at = GREATEST(last_refused_at, (${observation.attemptedAt}::timestamptz AT TIME ZONE 'UTC'))
        WHERE id = ${observation.requestId} AND grant_id = ${observation.grantId}
          AND state = 'open' AND expires_at > hadron_signing_now()`;
    }, { maxWait: 1000, timeout: 1500 });
  } catch {
    // Optional observability only: never turn this into an eligibility decision, expose identifiers, or print DB errors.
    console.warn('grant.signing.refusal_observation_failed');
  }
}
