/**
 * Telegram events ingress, tool -> core (#597, Telegram phase 2).
 *
 * hadrontool-telegram POSTs normalized Telegram events here over internal HTTP:
 *
 *   POST /internal/telegram-events
 *   Authorization: Bearer <CORE_EVENTS_TOKEN>
 *   { event: 'telegram.<kind>', connectionId, [eventId], ... }   (eventId optional: the tool sends none today; see eventDedupeKey)
 *
 * `connectionId` is the TOOL's connection id; dispatch resolves it to the core TelegramConnection. Same posture as
 * emailEvents / slackEvents: 503 while CORE_EVENTS_TOKEN is unset (the event plane is off), 401 for a missing or wrong
 * bearer (constant-time compare), 400 for a malformed body, 202 once dispatch completed, and 503 (retryable) for a tool connection core has no live row
 * for.
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
import { createHash } from 'node:crypto';
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
  /**
   * The tool's event id, the dedupe key, when it sends one. The tool does NOT today (it forwards no update_id), so core
   * derives one: see {@link eventDedupeKey}. After dispatch resolves it, this is always set.
   */
  eventId?: string | number;
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
    // eventId is OPTIONAL on the wire (the tool sends none today); when present it must be a non-empty string or an
    // integer (a Telegram update_id), normalized to a string by eventDedupeKey.
    (b.eventId === undefined || (typeof b.eventId === 'string' && b.eventId !== '') || Number.isSafeInteger(b.eventId as unknown))
  );
}

/** JSON with object keys sorted at every level, so two byte-different spellings of one event hash alike. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The dedupe key of an event. DERIVED KEY, the tool sends none: hadrontool-telegram forwards no update_id, so core
 * hashes the canonical event JSON (a retry is byte-identical; a message carries its messageId, so distinct messages
 * differ; two identical /start payloads from one chat collapse, harmless as redemption is idempotent). A tool-sent
 * eventId, if one ever arrives, WINS. Option B (the tool forwards update_id as eventId) is tracked in
 * hadron-memory/hadrontool-telegram#4.
 */
export function eventDedupeKey(event: InboundTelegramEvent): string {
  if (event.eventId !== undefined && event.eventId !== null && String(event.eventId) !== '') return String(event.eventId);
  const { eventId: _unused, ...rest } = event;
  void _unused;
  return `derived:${createHash('sha256').update(canonicalJson(rest)).digest('hex')}`;
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
 * Dispatch one inbound event: resolve the connection (an unknown or soft-deleted tool connection is reported as 'unknown', which the route
 * answers 503 so the tool redelivers, and leaves no receipt), claim the event id, run the consumer.
 */
export async function dispatchTelegramEvent(raw: InboundTelegramEvent): Promise<'dispatched' | 'duplicate' | 'unknown'> {
  const event: InboundTelegramEvent = { ...raw, eventId: eventDedupeKey(raw) };
  const connection = await db.telegramConnection.findFirst({
    where: { toolConnectionId: event.connectionId, deletedAt: null },
    select: { id: true, organizationId: true, appId: true, provider: true, toolConnectionId: true, botUsername: true },
  });
  if (!connection) {
    // UNKNOWN is a retryable 503 at the route, not a 202: the tool advances its poll cursor only on a 2xx, so a 202 would
    // delete an event that arrived before core's row exists (the tool starts polling at registration). Bounded: the tool
    // dead-letters a poison update after 5 attempts, and a deleted connection stops polling itself. (The wider gap, a
    // registration whose response was lost, is deferred to #4829.)
    console.log(`[telegram-events] ${event.event} for unknown tool connection ${event.connectionId}, not acknowledged (retryable)`);
    return 'unknown';
  }
  let claimId: string;
  try {
    claimId = (
      await db.telegramEventReceipt.create({
        data: { connectionId: event.connectionId, eventId: String(event.eventId) },
        select: { id: true },
      })
    ).id;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    console.log(`[telegram-events] duplicate event ${event.eventId} for tool connection ${event.connectionId}, dropped`);
    return 'duplicate';
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
  return 'dispatched';
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
      const outcome = await dispatchTelegramEvent(req.body);
      if (outcome === 'unknown') {
        res.status(503).json({ error: 'unknown connection', retryable: true });
        return;
      }
      res.status(202).json({ ok: true });
    } catch (err) {
      respondInternalFault(res, 'telegram-events', err);
    }
  });
}
