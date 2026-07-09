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
 * AgentWebhook delivery (agent-pong#1 prerequisite 2) and/or a spec-039 bus
 * publish — WITHOUT touching the tool. The transport is HTTP now and wraps
 * behind a NATS subject later (D-2026-06-17-004 posture: a missing broker
 * never breaks the path).
 */
import { timingSafeEqual } from 'crypto';
import type { Express, Request, Response } from 'express';
import { db } from '../integrations/db/client.js';

/** Normalized event payload the tools send (mirrors the tool's EmailEvent). */
export interface InboundEmailEvent {
  event: 'email.received' | 'email.sent';
  connectionId: string;
  folder: string;
  message: {
    id: string;
    conversationId: string | null;
    subject: string | null;
    from: { name: string | null; address: string } | null;
    receivedAt: string;
    snippet: string;
  } & Record<string, unknown>;
}

/** Constant-time bearer comparison. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
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
  const connection = await db.exchangeConnection.findFirst({
    where: { toolConnectionId: event.connectionId, deletedAt: null },
    select: { id: true, organizationId: true, userId: true, mailboxEmail: true },
  });
  if (!connection) {
    console.log(`[email-events] ${event.event} for unknown tool connection ${event.connectionId} — dropped`);
    return;
  }
  console.log(
    `[email-events] ${event.event} in ${connection.mailboxEmail} (connection ${connection.id}, folder ${event.folder}): "${event.message.subject ?? ''}"`,
  );
  // Future consumers attach here (per-connection AgentWebhook delivery /
  // spec-039 bus publish) — agent-pong#1 prerequisite 2.
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
      console.error('[email-events] dispatch failed:', err);
      res.status(500).json({ error: 'dispatch failed' });
    }
  });
}
