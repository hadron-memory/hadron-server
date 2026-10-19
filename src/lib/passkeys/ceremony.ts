/**
 * #1631 S2a: DB-backed ceremony state. A ceremony is opened by one browser for
 * one purpose and can be consumed once; a JWT is never proof of it. Expiry and
 * consumption use the database clock, and the consume runs inside the caller's
 * transaction, so a later refusal rolls it back.
 */
import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';

export type CeremonyPurpose = 'SIGN_IN' | 'STEP_UP_ONLY';

/** Open a ceremony for the browser identified by `browserNonceHash`. */
export async function createCeremony(
  tx: Prisma.TransactionClient,
  input: { purpose: CeremonyPurpose; browserNonceHash: string; ttlSeconds: number },
): Promise<{ id: string }> {
  if (!/^[0-9a-f]{64}$/.test(input.browserNonceHash)) throw new Error('browser nonce hash must be 64 lowercase hex');
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1) throw new Error('ttlSeconds must be a positive integer');
  const id = randomBytes(32).toString('base64url');
  await tx.$executeRaw`INSERT INTO passkey_ceremonies (id, purpose, browser_nonce_hash, expires_at)
    VALUES (${id}, ${input.purpose}, ${input.browserNonceHash},
            (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + make_interval(secs => ${input.ttlSeconds}))`;
  return { id };
}

/**
 * Consume once. False for an unknown, expired, already-consumed, foreign-browser
 * or wrong-purpose ceremony; the caller must not distinguish them to the client.
 * A mismatch leaves the ceremony unconsumed.
 */
export async function consumeCeremony(
  tx: Prisma.TransactionClient,
  input: { id: string; browserNonceHash: string; purpose: CeremonyPurpose },
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`UPDATE passkey_ceremonies
     SET consumed_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
   WHERE id = ${input.id} AND consumed_at IS NULL
     AND browser_nonce_hash = ${input.browserNonceHash} AND purpose = ${input.purpose}
     AND expires_at > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
   RETURNING id`;
  return rows.length === 1;
}
