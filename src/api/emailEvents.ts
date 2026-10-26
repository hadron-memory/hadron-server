/**
 * Email events ingress — tool → core (#396 Phase 4, decided 2026-07-08).
 *
 * The provider capability tools (hadrontool-ms-exchange today) POST
 * normalized email events here over internal HTTP:
 *
 *   POST /internal/email-events
 *   Authorization: Bearer <CORE_EVENTS_TOKEN>
 *   { event: 'email.received'|'email.sent', connectionId, folder, message }
 *
 * `connectionId` is the TOOL's connection id; dispatch resolves it to the
 * core ExchangeConnection identity row.
 *
 * v1 has no consuming agent yet: dispatch resolves the connection, logs, and
 * acks. It is the single seam where consumers attach later — per-connection
 * AgentWebhook delivery and/or a spec-039 bus publish (consumer roadmap on
 * hadron-server#396) — WITHOUT touching the tool. The transport is HTTP now
 * and wraps behind a NATS subject later (D-2026-06-17-004 posture: a missing
 * broker never breaks the path).
 */
import type { Express, Request, Response } from 'express';
import { db } from '../integrations/db/client.js';
import { safeEqual } from '../lib/constantTime.js';
import type { ToolEmailMessage } from '../lib/emailClient.js';
import { respondInternalFault } from '../lib/internalFault.js';

/**
 * Normalized event payload the tools send. The message is the SAME
 * provider-neutral shape the pull path uses (derived from ToolEmailMessage,
 * not re-declared) so the two surfaces cannot drift apart silently.
 */
export interface InboundEmailEvent {
  event: 'email.received' | 'email.sent';
  connectionId: string;
  folder: string;
  message: Pick<ToolEmailMessage, 'id' | 'conversationId' | 'subject' | 'from' | 'receivedAt' | 'snippet'> &
    Record<string, unknown>;
}

/** Shallow shape check — the tool is trusted, but a malformed body must not crash dispatch. */
function isInboundEmailEvent(body: unknown): body is InboundEmailEvent {
  const b = body as InboundEmailEvent | null;
  return (
    !!b &&
    (b.event === 'email.received' || b.event === 'email.sent') &&
    typeof b.connectionId === 'string' &&
    typeof b.folder === 'string' &&
    !!b.message &&
    typeof b.message.id === 'string'
  );
}

/**
 * Dispatch one inbound event. v1: resolve the core connection + log — the
 * attach point for future consumers (AgentWebhook fan-out, bus publish).
 * Unknown tool connections are logged and dropped (a race with disconnect,
 * or a foreign tool) — never an error back to the tool.
 */
export async function dispatchEmailEvent(event: InboundEmailEvent): Promise<void> {
  // syncEnabled preserves the operator's soft-pause contract the legacy
  // /exchange/webhook route enforced: a paused connection's events are
  // dropped here so future consumers can never inherit a missing gate.
  const connection = await db.exchangeConnection.findFirst({
    where: { toolConnectionId: event.connectionId, deletedAt: null, syncEnabled: true },
    select: { id: true, organizationId: true, userId: true, mailboxEmail: true },
  });
  if (!connection) {
    console.log(`[email-events] ${event.event} for unknown or paused tool connection ${event.connectionId} — dropped`);
    return;
  }
  console.log(
    `[email-events] ${event.event} in ${connection.mailboxEmail} (connection ${connection.id}, folder ${event.folder}): "${event.message.subject ?? ''}"`,
  );
  // Future consumers attach here (per-connection AgentWebhook delivery /
  // spec-039 bus publish) — consumer roadmap on hadron-server#396.
}

/** Mount the internal ingress route. */
export function mountEmailEventRoutes(app: Express): void {
  app.post('/internal/email-events', async (req: Request, res: Response) => {
    const token = process.env.CORE_EVENTS_TOKEN;
    if (!token) {
      // Not configured ⇒ the event plane is off; tell the tool clearly (it
      // logs delivery failures) rather than 404-ing like a wrong URL.
      res.status(503).json({ error: 'email events ingress is not configured (CORE_EVENTS_TOKEN unset)' });
      return;
    }
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!presented || !safeEqual(presented, token)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!isInboundEmailEvent(req.body)) {
      res.status(400).json({ error: 'malformed event payload' });
      return;
    }
    // Ack fast (the tool treats delivery as fire-and-forget with logging);
    // dispatch is awaited anyway since v1 dispatch is one indexed lookup.
    try {
      await dispatchEmailEvent(req.body);
      res.status(202).json({ ok: true });
    } catch (err) {
      respondInternalFault(res, 'email-events', err);
    }
  });
}
