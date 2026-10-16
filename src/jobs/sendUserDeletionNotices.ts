/**
 * sendUserDeletionNotices — the post-commit sender for the notice an administrator's erasure of a user leaves
 * behind (#1647, cor:aut:020:03).
 *
 * The deletion transaction wrote a PENDING intent with the recipient address encrypted. This moves each intent
 * PENDING -> SENT on the provider's acknowledgement, retries a failure up to MAX_ATTEMPTS, then FAILED; an intent
 * with no recipient, or no configured sender, is UNAVAILABLE. The ciphertext is cleared at every terminal state.
 * A restart resumes whatever is still PENDING. The notice text carries no reason.
 *
 * Run one pass by hand:
 *   tsx src/jobs/sendUserDeletionNotices.ts
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { isEmailSenderConfigured, sendAccountDeletionNotice } from '../auth/email.js';
import { decryptToken } from '../lib/tokenCrypto.js';

export const MAX_NOTICE_ATTEMPTS = 3;

export interface NoticeSender {
  configured: () => boolean;
  send: (to: string) => Promise<void>;
}

const emailSender: NoticeSender = { configured: isEmailSenderConfigured, send: sendAccountDeletionNotice };

/** One pass over the PENDING intents. Returns how many reached a terminal state. */
export async function processUserDeletionNotices(
  db: PrismaClient,
  sender: NoticeSender = emailSender,
): Promise<number> {
  const pending = await db.userDeletionNotice.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  let terminal = 0;
  for (const notice of pending) {
    const settle = async (status: 'SENT' | 'FAILED' | 'UNAVAILABLE') => {
      const done = await db.userDeletionNotice.updateMany({
        where: { auditId: notice.auditId, status: 'PENDING' },
        data: { status, recipientCiphertext: null },
      });
      terminal += done.count;
    };
    if (!notice.recipientCiphertext || !sender.configured()) {
      await settle('UNAVAILABLE');
      continue;
    }
    // Claim one try atomically, so two instances never send the same notice twice.
    const claimed = await db.userDeletionNotice.updateMany({
      where: { auditId: notice.auditId, status: 'PENDING', attempts: notice.attempts },
      data: { attempts: notice.attempts + 1 },
    });
    if (claimed.count === 0) continue;
    try {
      await sender.send(decryptToken(notice.recipientCiphertext));
      await settle('SENT');
    } catch {
      if (notice.attempts + 1 >= MAX_NOTICE_ATTEMPTS) await settle('FAILED');
    }
  }
  return terminal;
}

/** Start the recurring pass (every minute, first run after 30s): resumes PENDING intents after a restart or a failed try. */
export function startUserDeletionNoticeLoop(
  db: PrismaClient,
  options: { intervalMs?: number; initialDelayMs?: number } = {},
): NodeJS.Timeout {
  const intervalMs = options.intervalMs ?? 60 * 1000;
  const initialDelayMs = options.initialDelayMs ?? 30 * 1000;
  const run = async () => {
    try {
      await processUserDeletionNotices(db);
    } catch (err) {
      console.error('[user-deletion-notice] pass failed:', err);
    }
  };
  return setTimeout(() => {
    void run();
    setInterval(run, intervalMs);
  }, initialDelayMs);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { db } = await import('../integrations/db/client.js');
  console.log(`settled ${await processUserDeletionNotices(db)}`);
  await db.$disconnect();
}
