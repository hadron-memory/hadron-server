/**
 * Slack events ingress — tool → core (spec 043 Phase 2).
 *
 * hadrontool-slack POSTs normalized Slack events here over internal HTTP:
 *
 *   POST /internal/slack-events
 *   Authorization: Bearer <CORE_EVENTS_TOKEN>
 *   { event: 'slack.command'|'slack.interaction'|'slack.message.received'|'slack.gap', connectionId, envelopeId, … }
 *
 * `connectionId` is the TOOL's connection id; dispatch resolves it to the
 * core SlackConnection identity row.
 *
 * AT-LEAST-ONCE + DEDUPE: the tool's persist-before-ack inbox can deliver
 * an event more than once (a tool crash between core's 2xx and the inbox
 * row delete). Dispatch therefore INSERTs a SlackEventReceipt keyed
 * (connectionId, envelopeId) FIRST and drops duplicates on conflict — the
 * core half of the spec-043 delivery contract.
 *
 * Phase 2 consumers: slack.command answers the /hadron usage text via the
 * tool's respond op (the acceptance round-trip). The find/link handlers
 * (Phase 4), task run (Phase 5), and the bridge consumers for
 * slack.message.received / slack.gap (Phase 3) all attach inside
 * `dispatchSlackEvent` — WITHOUT touching the tool. Transport is HTTP now
 * and wraps behind a NATS subject later (D-2026-06-17-004 posture).
 */
import type { Express, Request, Response } from 'express';
import { db } from '../integrations/db/client.js';
import { safeEqual } from '../lib/constantTime.js';
import { runSlackOperation } from '../lib/slackClient.js';
import { respondInternalFault } from '../lib/internalFault.js';

/** The event kinds the tool sends (spec 043). */
export type SlackEventKind = 'slack.command' | 'slack.interaction' | 'slack.message.received' | 'slack.gap';

/** Normalized event payload the tool sends. Fields beyond the envelope vary by kind. */
export interface InboundSlackEvent {
  event: SlackEventKind;
  /** The TOOL's connection id. */
  connectionId: string;
  /** Socket Mode envelope id (synthetic for slack.gap) — the dedupe key. */
  envelopeId: string;
  teamId?: string;
  channelId?: string;
  threadTs?: string | null;
  slackUserId?: string;
  command?: string;
  text?: string;
  responseUrl?: string;
  triggerId?: string;
  value?: string;
  messageTs?: string;
  ts?: string;
  from?: { slackUserId: string | null; botId: string | null; displayName: string | null };
  disconnectedAt?: string | null;
  reconnectedAt?: string;
}

const EVENT_KINDS: SlackEventKind[] = ['slack.command', 'slack.interaction', 'slack.message.received', 'slack.gap'];

/** Shallow shape check — the tool is trusted, but a malformed body must not crash dispatch. */
function isInboundSlackEvent(body: unknown): body is InboundSlackEvent {
  const b = body as InboundSlackEvent | null;
  return (
    !!b &&
    EVENT_KINDS.includes(b.event) &&
    typeof b.connectionId === 'string' &&
    b.connectionId !== '' &&
    typeof b.envelopeId === 'string' &&
    b.envelopeId !== ''
  );
}

/** The /hadron usage text (mrkdwn) — Phase 2's one command answer. */
const USAGE_TEXT = [
  '*Hadron* — commands:',
  '• `/hadron find <query>` — search your Hadron memories _(coming soon)_',
  '• `/hadron task <query>` — find and run a Hadron task _(coming soon)_',
  '• `/hadron link <token>` — link your Slack account to Hadron _(coming soon)_',
  '• `/hadron help` — this message',
].join('\n');

/** Prisma unique-violation check (P2002). */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

/** Receipts only need to outlive the tool's bounded retry window; keep a generous day. */
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

/** Fraction of dispatches that also sweep old receipts (opportunistic GC). */
const RECEIPT_PRUNE_PROBABILITY = 0.01;

/** Delete receipts older than `olderThan`; returns the pruned count. */
export async function pruneSlackEventReceipts(olderThan: Date): Promise<number> {
  const { count } = await db.slackEventReceipt.deleteMany({ where: { createdAt: { lt: olderThan } } });
  return count;
}

/**
 * The receipt table is insert-only on the happy path, so it would grow
 * without bound (PR #600 review) — an occasional dispatch sweeps expired
 * rows instead of a dedicated cron. Fire-and-forget by design.
 */
function pruneReceiptsOpportunistically(): void {
  if (Math.random() >= RECEIPT_PRUNE_PROBABILITY) return;
  pruneSlackEventReceipts(new Date(Date.now() - RECEIPT_TTL_MS))
    .then((count) => {
      if (count > 0) console.log(`[slack-events] pruned ${count} expired event receipts`);
    })
    .catch((err) => console.error('[slack-events] receipt prune failed:', err));
}

/**
 * Answer a slash command with the usage text (ephemeral, via the tool's
 * respond op). Failures are logged, never thrown — a broken reply path must
 * not error the ingress (the tool would pointlessly retry a command whose
 * response window is 30 minutes anyway).
 */
async function handleSlackCommand(
  event: InboundSlackEvent,
  connection: { provider: string; toolConnectionId: string },
): Promise<void> {
  if (!event.responseUrl) return;
  try {
    await runSlackOperation(connection.provider, 'respond', {
      connectionId: connection.toolConnectionId,
      responseUrl: event.responseUrl,
      text: USAGE_TEXT,
    });
  } catch (err) {
    console.error(`[slack-events] usage reply failed for connection ${connection.toolConnectionId}:`, err);
  }
}

/**
 * Dispatch one inbound event: dedupe, resolve the core connection, route by
 * kind. Unknown tool connections are logged and dropped (a race with
 * disconnect, or a foreign tool) — never an error back to the tool.
 */
export async function dispatchSlackEvent(event: InboundSlackEvent): Promise<void> {
  // Dedupe order is CHECK → route → RECORD: the receipt marks COMPLETED
  // dispatch. Recording first would swallow the event forever when the
  // process dies mid-route (no thrown error to release the receipt — the
  // tool's retry would read as a duplicate; PR #600 review, Gemini high +
  // Codex P2). The cost is the honest at-least-once one: a crash between
  // routing and recording re-runs the consumer on retry — consumers are
  // idempotent per the spec-043 contract (and two concurrent deliveries of
  // one envelope may both route for the same reason; the unique key merely
  // collapses their receipts).
  const existing = await db.slackEventReceipt.findFirst({
    where: { connectionId: event.connectionId, envelopeId: event.envelopeId },
    select: { id: true },
  });
  if (existing) {
    console.log(`[slack-events] duplicate envelope ${event.envelopeId} for tool connection ${event.connectionId} — dropped`);
    return;
  }
  await routeSlackEvent(event);
  try {
    await db.slackEventReceipt.create({
      data: { connectionId: event.connectionId, envelopeId: event.envelopeId },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  pruneReceiptsOpportunistically();
}

/** Route a deduped event to its per-kind consumer. */
async function routeSlackEvent(event: InboundSlackEvent): Promise<void> {
  const connection = await db.slackConnection.findFirst({
    where: { toolConnectionId: event.connectionId, deletedAt: null },
    select: { id: true, organizationId: true, defaultAppId: true, provider: true, toolConnectionId: true, teamName: true },
  });
  if (!connection) {
    console.log(`[slack-events] ${event.event} for unknown tool connection ${event.connectionId} — dropped`);
    return;
  }

  switch (event.event) {
    case 'slack.command':
      console.log(
        `[slack-events] ${event.command ?? '/hadron'} "${event.text ?? ''}" from ${event.slackUserId} in ${connection.teamName} (connection ${connection.id})`,
      );
      // Phase 2: every subcommand answers the usage text. The link (Phase
      // 4), find (Phase 4), and task (Phase 5) handlers replace this switch
      // arm's body with a subcommand router.
      await handleSlackCommand(event, connection);
      break;
    case 'slack.interaction':
      // Phase 5 attaches the choice → AppRun trigger here.
      console.log(`[slack-events] interaction from ${event.slackUserId} (connection ${connection.id}) — no consumer yet`);
      break;
    case 'slack.message.received':
      // Phase 3 attaches the bridge inbound consumer here (binding
      // resolution most-specific-first, bot-loop filter on BOTH bot ids,
      // deterministic locs).
      break;
    case 'slack.gap':
      // Phase 3 attaches the paced get-history backfill sweep here.
      console.log(`[slack-events] gap for connection ${connection.id} (${event.disconnectedAt ?? 'unknown'} → ${event.reconnectedAt})`);
      break;
  }
}

/** Mount the internal ingress route. */
export function mountSlackEventRoutes(app: Express): void {
  app.post('/internal/slack-events', async (req: Request, res: Response) => {
    const token = process.env.CORE_EVENTS_TOKEN;
    if (!token) {
      // Not configured ⇒ the event plane is off; tell the tool clearly (it
      // dead-letters after bounded retries) rather than 404-ing like a
      // wrong URL.
      res.status(503).json({ error: 'slack events ingress is not configured (CORE_EVENTS_TOKEN unset)' });
      return;
    }
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!presented || !safeEqual(presented, token)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!isInboundSlackEvent(req.body)) {
      res.status(400).json({ error: 'malformed event payload' });
      return;
    }
    // A 2xx tells the tool's inbox drainer to delete its row — so only ack
    // after dispatch completes (dedupe receipt persisted). Dispatch is
    // cheap: one insert + one indexed lookup + (commands) one tool call.
    try {
      await dispatchSlackEvent(req.body);
      res.status(202).json({ ok: true });
    } catch (err) {
      respondInternalFault(res, 'slack-events', err);
    }
  });
}
