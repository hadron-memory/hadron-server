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
  throw new Error('not implemented');
}

/**
 * Follow a cancel link. True once the passkey is revoked as cancelled and its sign-ins are ended; false is the one
 * uniform refusal (unknown or spent token, window closed, passkey already revoked) and changes nothing.
 */
export async function cancelFirstPasskey(
  db: PrismaClient,
  input: { token: string; ip: string; userAgent: string },
): Promise<boolean> {
  throw new Error('not implemented');
}

void sha256Hex; void randomBytes; void generateId; void lockAuthorityAnchors; void endSignInsCompletedBy;
