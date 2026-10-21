/**
 * #1631 PR2 (cor:aut:040:07, 040:09): end a first passkey's cooling-off window early.
 *
 * Only a fresh sign-in by a method DIFFERENT from the one used to register the passkey ends it, on the server-hosted
 * "end the window early" page (two magic links are not different methods; a different identity provider, or a
 * browser-bound magic link after an identity-provider registration, is). The acting user is the fresh sign-in's user
 * (the ONE qualifying row on this browser, as for registration) and must own the in-window passkey (Rook, #1631
 * 6316353964). The window's end is recorded with the platform clock; its pending signatures then stop being pending.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { lockAuthorityAnchors } from '../auth/authorityAnchors.js';
import { consumeFreshSignIn, FRESH_SIGN_IN_MAX_AGE_SECONDS } from './freshSignIn.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** True once the acting user's in-window first passkey has its window ended early; false is the one refusal. */
export async function endWindowEarly(db: PrismaClient, input: { signInBrowserHash: string }): Promise<{ passkeyId: string } | null> {
  if (!HEX64.test(input.signInBrowserHash)) return null;
  const qualifying = (tx: Pick<PrismaClient, '$queryRaw'>) => tx.$queryRaw<Array<{ user_id: string; method: string }>>`
    SELECT user_id, method FROM fresh_sign_ins
     WHERE browser_nonce_hash = ${input.signInBrowserHash} AND confirmed_at IS NOT NULL AND consumed_at IS NULL
       AND signed_in_at >= (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${FRESH_SIGN_IN_MAX_AGE_SECONDS})`;
  const peek = await qualifying(db);
  if (peek.length !== 1) return null;
  const { user_id: userId } = peek[0];
  return db.$transaction(async (tx) => {
    await lockAuthorityAnchors(tx, [{ kind: 'user', id: userId }], 'exclusive');
    if (!(await tx.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true } }))) return null;
    const recheck = await qualifying(tx);
    if (recheck.length !== 1 || recheck[0].user_id !== userId) return null;
    // The acting user's own first passkey, with its window still open (the platform clock the passkey guard uses).
    const [open] = await tx.$queryRaw<Array<{ id: string; registration_method: string }>>`
      SELECT id, registration_method FROM passkey_credentials
       WHERE owner_id = ${userId} AND revoked_at IS NULL AND window_outcome IS NULL AND window_ended_at IS NULL
         AND window_ends_at > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3)
       FOR UPDATE`;
    // A different method only: two magic links are the same method, and so are two sign-ins with one provider.
    if (!open || open.registration_method === recheck[0].method) return null;
    const spent = await consumeFreshSignIn(tx, { browserNonceHash: input.signInBrowserHash, actingUserId: userId, purpose: 'end-window' });
    if (!spent || spent.method === open.registration_method) throw new Error('fresh sign-in changed under the anchor');
    await tx.$executeRaw`UPDATE passkey_credentials
       SET window_outcome = 'ended-early', window_ended_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3)
     WHERE id = ${open.id}`;
    return { passkeyId: open.id };
  });
}
