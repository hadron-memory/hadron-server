/**
 * sendPasskeyRegistrationNotices — the post-commit sender for every passkey registration's email notice (#1631 PR2,
 * cor:aut:040:02). The registering transaction wrote the outbox row, so a passkey never exists without its notice.
 *
 * Same lease as the #1647 deletion notice (`sendUserDeletionNotices.ts`): a try is claimed before the send, a failure is
 * settled only by its own claim, MAX_NOTICE_ATTEMPTS is a hard ceiling, and a delivery is recorded as sent whichever
 * claim it came from. A first passkey's cancel token (encrypted) is cleared at every terminal state. A user with no
 * email address, or a deployment with no mail sender, settles the notice as failed at once; the in-app notice remains.
 */
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/index.js';
import { isEmailSenderConfigured, sendPasskeyRegisteredNotice, type PasskeyNoticeContent } from '../auth/email.js';
import { decryptToken } from '../lib/tokenCrypto.js';
import { MAX_NOTICE_ATTEMPTS, NOTICE_LEASE_MS } from './sendUserDeletionNotices.js';

export const PASSKEY_CANCEL_PATH = '/passkeys/cancel';

export interface PasskeyNoticeSender {
  configured: () => boolean;
  send: (to: string, notice: PasskeyNoticeContent) => Promise<void>;
}

const emailSender: PasskeyNoticeSender = { configured: isEmailSenderConfigured, send: sendPasskeyRegisteredNotice };

/** One pass over the unsettled notices. Returns how many reached a terminal state. */
export async function processPasskeyRegistrationNotices(
  db: PrismaClient,
  sender: PasskeyNoticeSender = emailSender,
  now: () => Date = () => new Date(),
): Promise<number> {
  throw new Error('not implemented');
}

/** Start the recurring pass (every minute, first run after 30s). */
export function startPasskeyRegistrationNoticeLoop(
  db: PrismaClient,
  options: { intervalMs?: number; initialDelayMs?: number } = {},
): NodeJS.Timeout {
  const intervalMs = options.intervalMs ?? 60 * 1000;
  const initialDelayMs = options.initialDelayMs ?? 30 * 1000;
  const run = async () => {
    try {
      await processPasskeyRegistrationNotices(db);
    } catch (err) {
      console.error('[passkey-registration-notice] pass failed:', err);
    }
  };
  return setTimeout(() => {
    void run();
    setInterval(run, intervalMs);
  }, initialDelayMs);
}

void randomBytes; void decryptToken; void MAX_NOTICE_ATTEMPTS; void NOTICE_LEASE_MS; void PASSKEY_CANCEL_PATH;
