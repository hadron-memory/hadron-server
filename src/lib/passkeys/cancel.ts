/**
 * #1631 PR2 (cor:aut:040:07-08): a first passkey's cancel link.
 *
 * The one revocation that needs no sign-in (cor:aut:040:08, Exceptions): it works once, only while the passkey's
 * cooling-off window is open, and also ends every sign-in that passkey completed, with everything descending from
 * them (`endSignInsCompletedBy`, R66 A), in the same transaction under the owner's authority anchor. The token is
 * stored only as SHA-256; the cancel is recorded on the credential with its time, IP address and user agent.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { lockAuthorityAnchors } from '../auth/authorityAnchors.js';
import { endSignInsCompletedBy } from '../../auth/signIn.js';

const sha256Hex = (v: string) => createHash('sha256').update(v).digest('hex');
export const CANCEL_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Issue the cancel token for a first passkey, in the registering transaction. The raw token goes only into the email. */
export async function issueCancelToken(tx: Prisma.TransactionClient, passkeyId: string): Promise<string> {
  const open = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM passkey_credentials
    WHERE id = ${passkeyId} AND revoked_at IS NULL AND window_ends_at IS NOT NULL AND window_outcome IS NULL FOR UPDATE`;
  if (open.length !== 1) throw new Error('a cancel token is issued only for a first passkey with an open window');
  const token = randomBytes(32).toString('base64url');
  // passkey_id is unique: a second token for the same passkey fails here.
  await tx.$executeRaw`INSERT INTO passkey_cancel_tokens (id, passkey_id, token_hash) VALUES (${generateId()}, ${passkeyId}, ${sha256Hex(token)})`;
  return token;
}

/**
 * Follow a cancel link. True once the passkey is revoked as cancelled and its sign-ins are ended; false is the one
 * uniform refusal (unknown or spent token, window closed, passkey already revoked) and changes nothing.
 *
 * Order: find the passkey from the token without locks; then, in one transaction, take the owner's authority anchor,
 * lock the credential and re-check the open window and that the owner is not deleted (an erased owner's record takes no IP or user agent), spend the token, revoke, and end the sign-ins. Concurrent cancels
 * serialise on the anchor, and the second finds the token spent.
 */
export async function cancelFirstPasskey(
  db: PrismaClient,
  input: { token: string; ip: string; userAgent: string },
): Promise<boolean> {
  if (!CANCEL_TOKEN.test(input.token)) return false;
  const tokenHash = sha256Hex(input.token);
  const [probe] = await db.$queryRaw<Array<{ passkey_id: string; owner_id: string }>>`
    SELECT t.passkey_id, c.owner_id FROM passkey_cancel_tokens t JOIN passkey_credentials c ON c.id = t.passkey_id
     WHERE t.token_hash = ${tokenHash}`;
  if (!probe) return false;
  return db.$transaction(async (tx) => {
    await lockAuthorityAnchors(tx, [{ kind: 'user', id: probe.owner_id }], 'exclusive');
    // Eligibility is decided by the clock NOW, after the anchor wait (findings:db-clock-must-order-after-lock-wait);
    // the times recorded below use the transaction's clock, which the passkey guard requires and which is earlier.
    const open = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM passkey_credentials
      WHERE id = ${probe.passkey_id} AND owner_id = ${probe.owner_id} AND revoked_at IS NULL AND window_outcome IS NULL
        AND window_ends_at > (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
        AND EXISTS (SELECT 1 FROM users u WHERE u.id = owner_id AND u.deleted_at IS NULL)
      FOR UPDATE`;
    if (open.length !== 1) return false;
    const spent = await tx.$queryRaw<Array<{ id: string }>>`UPDATE passkey_cancel_tokens SET used_at = clock_timestamp()
      WHERE token_hash = ${tokenHash} AND used_at IS NULL RETURNING id`;
    if (spent.length !== 1) return false;
    await tx.$executeRaw`UPDATE passkey_credentials SET
        revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3),
        cancelled_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3),
        window_ended_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3),
        window_outcome = 'cancelled', cancel_ip = ${input.ip}, cancel_user_agent = ${input.userAgent}
      WHERE id = ${probe.passkey_id}`;
    await endSignInsCompletedBy(tx, probe.passkey_id);
    return true;
  });
}
