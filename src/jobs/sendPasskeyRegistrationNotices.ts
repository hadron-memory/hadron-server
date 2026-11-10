/**
 * sendPasskeyRegistrationNotices — the post-commit sender for every passkey registration's email notice (#1631 PR2,
 * cor:aut:040:02). The registering transaction wrote the outbox row, so a passkey never exists without its notice.
 *
 * Same lease as the #1647 deletion notice (`sendUserDeletionNotices.ts`): a try is claimed before the send, a failure is
 * settled only by its own claim, MAX_NOTICE_ATTEMPTS is a hard ceiling, and a delivery is recorded as sent whichever
 * claim it came from. A first passkey's cancel token (encrypted) is cleared at every terminal state. A user with no
 * email address, or a deployment with no mail sender, settles the notice as failed at once; the in-app notice remains.
 */
import { getProjectBaseUrl } from '../lib/baseUrl.js';
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
  const pending = await db.passkeyRegistrationNotice.findMany({
    where: { sentAt: null, failedAt: null },
    orderBy: { createdAt: 'asc' },
    take: 100,
    include: {
      user: { select: { email: true } },
      passkey: { select: { label: true, registeredAt: true, windowEndsAt: true } },
    },
  });
  let terminal = 0;
  const unleased = (at: Date) => ({ OR: [{ leaseUntil: null }, { leaseUntil: { lt: at } }] });
  const settle = { cancelTokenEnc: null, leaseUntil: null, claimToken: null };
  const fail = async (id: string, extra: object = {}) => {
    const done = await db.passkeyRegistrationNotice.updateMany({
      where: { id, sentAt: null, failedAt: null, ...extra }, data: { failedAt: now(), ...settle },
    });
    terminal += done.count;
  };
  for (const notice of pending) {
    if (!notice.user.email || !sender.configured()) { await fail(notice.id, unleased(now())); continue; }
    const at = now();
    // The ceiling: an expired lease on the last try is a crashed final attempt. No further send.
    if (notice.attempts >= MAX_NOTICE_ATTEMPTS) { await fail(notice.id, { attempts: { gte: MAX_NOTICE_ATTEMPTS }, ...unleased(at) }); continue; }
    const token = randomBytes(12).toString('hex');
    const claimed = await db.passkeyRegistrationNotice.updateMany({
      where: { id: notice.id, sentAt: null, failedAt: null, attempts: notice.attempts, ...unleased(at) },
      data: { attempts: notice.attempts + 1, leaseUntil: new Date(at.getTime() + NOTICE_LEASE_MS), claimToken: token },
    });
    if (claimed.count === 0) continue;
    const content: PasskeyNoticeContent = {
      kind: notice.kind as 'first' | 'later', label: notice.passkey.label, registeredAt: notice.passkey.registeredAt,
      ...(notice.kind === 'first' && notice.cancelTokenEnc ? {
        cancelUrl: `${getProjectBaseUrl()}${PASSKEY_CANCEL_PATH}?token=${decryptToken(notice.cancelTokenEnc)}`,
        windowEndsAt: notice.passkey.windowEndsAt ?? undefined,
      } : {}),
    };
    try {
      await sender.send(notice.user.email, content);
    } catch {
      // Only the owner of this claim settles its failure: the last try fails, an earlier one releases the lease.
      if (notice.attempts + 1 >= MAX_NOTICE_ATTEMPTS) await fail(notice.id, { claimToken: token });
      else await db.passkeyRegistrationNotice.updateMany({ where: { id: notice.id, claimToken: token, sentAt: null, failedAt: null }, data: { leaseUntil: null, claimToken: null } });
      continue;
    }
    // Delivered: sent whichever claim this is, and never overwritten after.
    const sent = await db.passkeyRegistrationNotice.updateMany({
      where: { id: notice.id, sentAt: null }, data: { sentAt: now(), failedAt: null, ...settle },
    });
    terminal += sent.count;
  }
  return terminal;
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

