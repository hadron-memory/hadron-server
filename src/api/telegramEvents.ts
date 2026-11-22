/**
 * Telegram events ingress, tool -> core (#597, Telegram phase 2).
 *
 * hadrontool-telegram POSTs normalized Telegram events here over internal HTTP:
 *
 *   POST /internal/telegram-events
 *   Authorization: Bearer <CORE_EVENTS_TOKEN>
 *   { event: 'telegram.<kind>', connectionId, eventId, ... }
 *
 * `connectionId` is the TOOL's connection id; dispatch resolves it to the core TelegramConnection. Same posture as
 * emailEvents / slackEvents: 503 while CORE_EVENTS_TOKEN is unset (the event plane is off), 401 for a missing or wrong
 * bearer (constant-time compare), 400 for a malformed body, 202 once dispatch completed.
 *
 * AT-LEAST-ONCE + DEDUPE: the tool's inbox can deliver an event more than once. Dispatch CLAIMS the event first, by
 * inserting a TelegramEventReceipt keyed (connectionId, eventId): the unique key decides, so two concurrent deliveries
 * run the consumer once between them, and a replay is acknowledged and dropped. A consumer that throws RELEASES the
 * claim before the error propagates, so the tool's retry runs it again (the claim never swallows an event whose
 * consumer failed). A process that dies mid-consumer keeps its claim: v1's consumer only logs, so nothing is lost;
 * the phase that adds a real consumer must make it idempotent and decide whether to move the claim after it (the
 * slackEvents ordering).
 *
 * v1 attaches NO behavior: `telegramEventConsumer.handler` logs. DM bindings (telegram.start) and the group bridge
 * attach there later, without touching the tool.
 */
import type { Express, Request, Response } from 'express';
import { db } from '../integrations/db/client.js';
import { safeEqual } from '../lib/constantTime.js';
import { respondInternalFault } from '../lib/internalFault.js';

/** Normalized event payload the tool sends. Fields beyond the envelope vary by kind. */
export interface InboundTelegramEvent {
  /** `telegram.<kind>`, e.g. telegram.start, telegram.message.received. */
  event: string;
  /** The TOOL's connection id. */
  connectionId: string;
  /** The tool's event id (Telegram's update id for a bot): the dedupe key. */
  eventId: string;
  chatId?: string;
  text?: string;
  [extra: string]: unknown;
}

/** The connection a dispatched event resolved to. */
export interface TelegramEventConnection {
  id: string;
  organizationId: string;
  appId: string;
  provider: string;
  toolConnectionId: string;
  botUsername: string;
}

/** The dispatch seam. v1's handler only logs; replace `handler` (tests do) or extend its body in a later phase. */
export const telegramEventConsumer: {
  handler: (event: InboundTelegramEvent, connection: TelegramEventConnection) => Promise<void>;
} = {
  handler: async (event, connection) => {
    console.log(`[telegram-events] ${event.event} for @${connection.botUsername} (connection ${connection.id}), no consumer yet`);
  },
};

/** Shallow shape check: the tool is trusted, but a malformed body must not crash dispatch. */
function isInboundTelegramEvent(body: unknown): body is InboundTelegramEvent {
  const b = body as InboundTelegramEvent | null;
  return (
    !!b &&
    typeof b.event === 'string' &&
    b.event.startsWith('telegram.') &&
    typeof b.connectionId === 'string' &&
    b.connectionId !== '' &&
    typeof b.eventId === 'string' &&
    b.eventId !== ''
  );
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

/** Receipts only need to outlive the tool's bounded retry window; keep a generous day. */
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
/** Fraction of dispatches that also sweep old receipts (opportunistic GC, as slackEvents). */
const RECEIPT_PRUNE_PROBABILITY = 0.01;

/** Delete receipts older than `olderThan`; returns the pruned count. */
export async function pruneTelegramEventReceipts(olderThan: Date): Promise<number> {
  const { count } = await db.telegramEventReceipt.deleteMany({ where: { createdAt: { lt: olderThan } } });
  return count;
}

function pruneReceiptsOpportunistically(): void {
  if (Math.random() >= RECEIPT_PRUNE_PROBABILITY) return;
  pruneTelegramEventReceipts(new Date(Date.now() - RECEIPT_TTL_MS))
    .then((count) => {
      if (count > 0) console.log(`[telegram-events] pruned ${count} expired event receipts`);
    })
    .catch((err) => console.error('[telegram-events] receipt prune failed:', err));
}

/**
 * Dispatch one inbound event: resolve the connection (an unknown or soft-deleted tool connection is logged and dropped,
 * never an error back to the tool, and leaves no receipt), claim the event id, run the consumer.
 */
export async function dispatchTelegramEvent(event: InboundTelegramEvent): Promise<void> {
  const connection = await db.telegramConnection.findFirst({
    where: { toolConnectionId: event.connectionId, deletedAt: null },
    select: { id: true, organizationId: true, appId: true, provider: true, toolConnectionId: true, botUsername: true },
  });
  if (!connection) {
    // KNOWN GAP (deferred to #4829): an event that arrives before core's row exists (the tool starts polling at registration) is
    // acknowledged and dropped here; closing it needs a tool-side change.
    console.log(`[telegram-events] ${event.event} for unknown tool connection ${event.connectionId}, dropped`);
    return;
  }
  let claimId: string;
  try {
    claimId = (
      await db.telegramEventReceipt.create({
        data: { connectionId: event.connectionId, eventId: event.eventId },
        select: { id: true },
      })
    ).id;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    console.log(`[telegram-events] duplicate event ${event.eventId} for tool connection ${event.connectionId}, dropped`);
    return;
  }
  try {
    await telegramEventConsumer.handler(event, connection);
  } catch (err) {
    // Release the claim so the tool's retry is not read as a duplicate; a failed release must not mask the cause.
    await db.telegramEventReceipt.deleteMany({ where: { id: claimId } }).catch((releaseErr) => {
      console.error('[telegram-events] releasing the claim failed:', releaseErr);
    });
    throw err;
  }
  pruneReceiptsOpportunistically();
}

/** Mount the internal ingress route. */
export function mountTelegramEventRoutes(app: Express): void {
  app.post('/internal/telegram-events', async (req: Request, res: Response) => {
    const token = process.env.CORE_EVENTS_TOKEN;
    if (!token) {
      res.status(503).json({ error: 'telegram events ingress is not configured (CORE_EVENTS_TOKEN unset)' });
      return;
    }
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!presented || !safeEqual(presented, token)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!isInboundTelegramEvent(req.body)) {
      res.status(400).json({ error: 'malformed event payload' });
      return;
    }
    // A 2xx tells the tool to delete its inbox row, so ack only after dispatch completed.
    try {
      await dispatchTelegramEvent(req.body);
      res.status(202).json({ ok: true });
    } catch (err) {
      respondInternalFault(res, 'telegram-events', err);
    }
  });
}
