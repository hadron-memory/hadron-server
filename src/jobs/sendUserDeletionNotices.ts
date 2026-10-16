/**
 * sendUserDeletionNotices — the post-commit sender for the notice an administrator's erasure of a user leaves
 * behind (#1647, cor:aut:020:03).
 *
 * The deletion transaction wrote a PENDING intent with the recipient address encrypted. This moves each intent
 * PENDING -> SENT on the provider's acknowledgement, retries a failure up to MAX_NOTICE_ATTEMPTS, then FAILED; an
 * intent with no recipient, or no configured sender, is UNAVAILABLE. The ciphertext is cleared at every terminal state
 * (FAILED, UNAVAILABLE and SENT alike). A restart resumes whatever is still PENDING. The notice text carries no reason.
 *
 * ## Exclusive claim (lease)
 *
 * A try is claimed BEFORE the send, under a lease: `attempts` is incremented, `leaseUntil` set and a fresh `claimToken`
 * stored, in one guarded update that only succeeds while no live lease exists. So:
 *  - no pass claims a notice while another pass's send is in flight (the lease is live);
 *  - a crash after the claim burns that try and the lease expires; if that was the LAST try the notice settles FAILED
 *    without a further send (a hard ceiling, never an attempt 4);
 *  - a failure is settled ONLY by the claim that owns it (token match), so a stale pass can neither fail nor release a
 *    newer claim; a SUCCESS settles SENT whichever claim it came from, because the message was in fact delivered, and
 *    nothing may overwrite it afterwards. Delivery stays at-least-once: a lease that expires mid-send can allow a
 *    second send.
 *
 * Run one pass by hand:
 *   tsx src/jobs/sendUserDeletionNotices.ts
 */

import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/index.js';
import { isEmailSenderConfigured, sendAccountDeletionNotice } from '../auth/email.js';
import { decryptToken } from '../lib/tokenCrypto.js';

export const MAX_NOTICE_ATTEMPTS = 3;
/** Longer than any sane provider call; a claim older than this is a crashed or hung pass. */
export const NOTICE_LEASE_MS = 5 * 60 * 1000;

export interface NoticeSender {
  configured: () => boolean;
  send: (to: string) => Promise<void>;
}

const emailSender: NoticeSender = { configured: isEmailSenderConfigured, send: sendAccountDeletionNotice };

/** One pass over the PENDING intents. Returns how many reached a terminal state. */
export async function processUserDeletionNotices(
  db: PrismaClient,
  sender: NoticeSender = emailSender,
  now: () => Date = () => new Date(),
): Promise<number> {
  const pending = await db.userDeletionNotice.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  let terminal = 0;
  const terminalData = { recipientCiphertext: null, leaseUntil: null, claimToken: null };
  for (const notice of pending) {
    if (!notice.recipientCiphertext || !sender.configured()) {
      const done = await db.userDeletionNotice.updateMany({
        where: { auditId: notice.auditId, status: 'PENDING', OR: [{ leaseUntil: null }, { leaseUntil: { lt: now() } }] },
        data: { status: 'UNAVAILABLE', ...terminalData },
      });
      terminal += done.count;
      continue;
    }
    const at = now();
    // The ceiling: an expired lease on the last try is a crashed final attempt. No further send.
    if (notice.attempts >= MAX_NOTICE_ATTEMPTS) {
      const done = await db.userDeletionNotice.updateMany({
        where: { auditId: notice.auditId, status: 'PENDING', attempts: { gte: MAX_NOTICE_ATTEMPTS }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: at } }] },
        data: { status: 'FAILED', ...terminalData },
      });
      terminal += done.count;
      continue;
    }
    const token = randomBytes(12).toString('hex');
    const claimed = await db.userDeletionNotice.updateMany({
      where: {
        auditId: notice.auditId,
        status: 'PENDING',
        attempts: notice.attempts,
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: at } }],
      },
      data: { attempts: notice.attempts + 1, leaseUntil: new Date(at.getTime() + NOTICE_LEASE_MS), claimToken: token },
    });
    if (claimed.count === 0) continue;
    try {
      await sender.send(decryptToken(notice.recipientCiphertext));
    } catch {
      // Only the owner of this claim settles its failure: the last try is FAILED, an earlier one releases the lease.
      const last = notice.attempts + 1 >= MAX_NOTICE_ATTEMPTS;
      const done = await db.userDeletionNotice.updateMany({
        where: { auditId: notice.auditId, status: 'PENDING', claimToken: token },
        data: last ? { status: 'FAILED', ...terminalData } : { leaseUntil: null, claimToken: null },
      });
      if (last) terminal += done.count;
      continue;
    }
    // Delivered: SENT whichever claim this is, and never overwritten after. A late ack may follow a FAILED settled by a
    // newer claim's failure; the truth is that it was sent.
    const sent = await db.userDeletionNotice.updateMany({
      where: { auditId: notice.auditId, status: { in: ['PENDING', 'FAILED'] } },
      data: { status: 'SENT', ...terminalData },
    });
    terminal += sent.count;
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
