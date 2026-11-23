/**
 * #4828 / #4847 (hrn:node:hadronmemory.com:specs:cor:int:030:03, clauses 1-4; V14 of cor:dmo:080:04 is where the sentence came from):
 * the ONE teardown path for the chat tool registrations (Telegram and Slack) of a connection core has deleted: an App or an
 * organization being deleted, the single-connection doors, and the reconciliation of live rows whose owner is already deleted.
 *
 * DURABLE (#4847). The deleting transaction does two things in ONE statement per provider: it soft-deletes the live rows in scope
 * (`WHERE deleted_at IS NULL ... RETURNING`, so a row already deleted is neither touched nor returned) and records one intent per
 * tool registration in `chat_tool_teardown_intents`. The intent has NO foreign key to the App or organization, on purpose: a URN
 * reclaim hard-deletes an App and its connection rows cascade away with it, and the intent must outlive them. After the commit
 * {@link dispatchChatToolTeardown} makes the first attempt; {@link chatToolTeardownSweepTick} retries what is unconfirmed.
 *
 * AN ATTEMPT is claimed by one guarded update (`state = 'PENDING' AND due`), so two sweeps, or a sweep and a dispatch, ask the tool
 * once between them. Only the tool's SUCCESS confirms (clause 3: a tool answers a repeat DELETE with success, hadrontool-telegram#8
 * and hadrontool-slack#6; core never counts a not-found as success on its own account). The wait after attempt n is 5 minutes
 * doubling to at most 6 hours; the tenth failed attempt moves the intent to CAPPED through one guarded update, which raises ONE alarm,
 * after which nothing is retried and nothing is dropped until an operator requeues it ({@link requeueCappedChatToolTeardowns}).
 *
 * RECONCILIATION covers the live rows of an owner that is already deleted, and only those, and queues them through the same intent.
 * LIMITS, stated: a connection deleted BEFORE this existed has no intent and is not swept (the node: "from now on only"); a
 * registration whose core row was hard-deleted earlier has no row to reconcile from (needs a tool-side listing, out of scope).
 * No admin door reaches a deleted connection: a caller's repeat delete still does nothing (cor:dmo:080:04); the retry is the system's own.
 */
import * as Sentry from '@sentry/node';
import { Prisma, type PrismaClient } from '../generated/prisma/index.js';
import { db as globalDb } from '../integrations/db/client.js';
import { toNaiveUtc } from './sessionActivity.js';
import { deleteSlackToolConnection } from './slackClient.js';
import { deleteTelegramToolConnection } from './telegramClient.js';

export type ChatToolKind = 'slack' | 'telegram';
/** One recorded intent: the handle the tool call needs, and the intent's own id (the attempt is claimed on it). */
export interface ChatToolTeardown { kind: ChatToolKind; id: string; provider: string; toolConnectionId: string }
/** An organization (every connection it holds) or an App (its Telegram bot, and the Slack workspaces it is the default App of). */
export type ChatToolScope = { organizationId: string } | { appId: string };
export type TeardownAttempt = 'confirmed' | 'failed' | 'capped' | 'skipped';

/** Ten attempts, then CAPPED with one alarm (cor:int:030:03 clause 4). */
export const CHAT_TOOL_TEARDOWN_MAX_ATTEMPTS = 10;
export const CHAT_TOOL_TEARDOWN_CAPPED_TAG = 'chat_tool_teardown.capped';
const SWEEP_BATCH = 20;
const RECONCILE_BATCH = 100;

type IntentRow = { id: string; kind: string; provider: string; tool_connection_id: string };
const asTeardown = (r: IntentRow): ChatToolTeardown => ({ kind: r.kind as ChatToolKind, id: r.id, provider: r.provider, toolConnectionId: r.tool_connection_id });
const NOW_UTC = Prisma.sql`(clock_timestamp() AT TIME ZONE 'UTC')`;

/**
 * `WITH gone AS (<the soft-delete, RETURNING id, provider, tool_connection_id>) INSERT <one intent per row>`: the soft-delete and its
 * intents are ONE statement, so they commit together or not at all. A repeat meets the (kind, tool_connection_id) unique key and
 * records nothing. The key is safe because a tool connection id is never reused: every registration mints a fresh one, and both
 * connection tables hold a UNIQUE tool_connection_id over live AND soft-deleted rows, so core cannot even insert a second row with an
 * id an intent already names (pinned in chatToolTeardown4847.test.ts); the intent is also never consulted for a live row, by that same key.
 * A hard-deleted row (a URN reclaim) is covered only by the tool's own contract: a registration id is never minted twice. One path
 * serves the doors, the org and App paths and the reconciliation without ever doubling an intent.
 */
function recordIntents(kind: ChatToolKind, softDelete: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    WITH gone AS (${softDelete})
    INSERT INTO chat_tool_teardown_intents (id, kind, provider, tool_connection_id, connection_id, state, attempts, created_at)
    SELECT replace(gen_random_uuid()::text, '-', ''), ${kind}, gone.provider, gone.tool_connection_id, gone.id, 'PENDING', 0, ${NOW_UTC}
    FROM gone
    ON CONFLICT (kind, tool_connection_id) DO NOTHING
    RETURNING id, kind, provider, tool_connection_id`;
}
const telegramRows = (where: Prisma.Sql, deletedBy: string | null) => Prisma.sql`
  UPDATE telegram_connections SET deleted_at = ${NOW_UTC}, deleted_by = ${deletedBy}
  WHERE ${where} AND deleted_at IS NULL RETURNING id, provider, tool_connection_id`;
const slackRows = (where: Prisma.Sql, deletedBy: string | null) => Prisma.sql`
  UPDATE slack_connections SET deleted_at = ${NOW_UTC}, deleted_by = ${deletedBy}
  WHERE ${where} AND deleted_at IS NULL RETURNING id, provider, tool_connection_id`;

/**
 * INSIDE the deleting transaction: soft-delete every LIVE row in scope and record its intent. Returns the intents this call
 * recorded, for {@link dispatchChatToolTeardown} to attempt after the commit (a rolled-back delete records and asks nothing).
 */
export async function softDeleteChatToolConnections(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  scope: ChatToolScope,
  deletedBy: string | null,
): Promise<ChatToolTeardown[]> {
  const telegramWhere = 'organizationId' in scope ? Prisma.sql`organization_id = ${scope.organizationId}` : Prisma.sql`app_id = ${scope.appId}`;
  const slackWhere = 'organizationId' in scope ? Prisma.sql`organization_id = ${scope.organizationId}` : Prisma.sql`default_app_id = ${scope.appId}`;
  const telegram = await tx.$queryRaw<IntentRow[]>(recordIntents('telegram', telegramRows(telegramWhere, deletedBy)));
  const slack = await tx.$queryRaw<IntentRow[]>(recordIntents('slack', slackRows(slackWhere, deletedBy)));
  return [...telegram, ...slack].map(asTeardown);
}

/**
 * One connection from a single-connection door, already soft-deleted by that door's own guarded update: record its intent. Run in
 * the same transaction as that update. Returns the intent to dispatch, or null when one already exists for the registration.
 */
export async function recordChatToolTeardown(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  row: { kind: ChatToolKind; id: string; provider: string; toolConnectionId: string },
): Promise<ChatToolTeardown | null> {
  const rows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
    INSERT INTO chat_tool_teardown_intents (id, kind, provider, tool_connection_id, connection_id, state, attempts, created_at)
    VALUES (replace(gen_random_uuid()::text, '-', ''), ${row.kind}, ${row.provider}, ${row.toolConnectionId}, ${row.id}, 'PENDING', 0, ${NOW_UTC})
    ON CONFLICT (kind, tool_connection_id) DO NOTHING
    RETURNING id, kind, provider, tool_connection_id`);
  return rows[0] ? asTeardown(rows[0]) : null;
}

/** The alarm: ids only, never a token. One event per intent (fingerprint), raised only by the one guarded transition to CAPPED. */
function reportCapped(c: { intentId: string; kind: string; provider: string; toolConnectionId: string; attempts: number }): void {
  console.error(`[chatToolTeardown] ${c.kind} teardown CAPPED after ${c.attempts} attempts: the tool still holds ${c.provider}/${c.toolConnectionId}; an operator must requeue or clean it`);
  try {
    Sentry.captureMessage('Chat tool teardown capped: the tool still holds a registration core could not drop', {
      level: 'error',
      tags: { [CHAT_TOOL_TEARDOWN_CAPPED_TAG]: 'true', kind: c.kind },
      fingerprint: [CHAT_TOOL_TEARDOWN_CAPPED_TAG, c.intentId],
      extra: { intentId: c.intentId, provider: c.provider, toolConnectionId: c.toolConnectionId, attempts: c.attempts },
    });
  } catch { /* an alarm must not break the sweep */ }
}

/**
 * One attempt on one intent, claimed by a single guarded update (PENDING, due, under the cap): a concurrent caller, or an intent
 * confirmed, capped, not yet due or unknown, is 'skipped' and asks the tool nothing. The tool's success confirms; anything else is a
 * failed attempt; the tenth failure caps the intent and raises the alarm once. Never throws.
 */
export async function attemptChatToolTeardown(db: PrismaClient, intentId: string, now: Date = new Date()): Promise<TeardownAttempt> {
  const nowUtc = toNaiveUtc(now);
  const claimed = await db.$queryRaw<Array<{ kind: string; provider: string; tool_connection_id: string; attempts: number }>>`
    UPDATE chat_tool_teardown_intents SET attempts = attempts + 1, last_attempt_at = ${nowUtc}::timestamp
    WHERE id = ${intentId} AND state = 'PENDING' AND attempts < ${CHAT_TOOL_TEARDOWN_MAX_ATTEMPTS}
      AND (last_attempt_at IS NULL OR last_attempt_at + interval '5 minutes' * LEAST(power(2, LEAST(attempts - 1, 7)), 72) <= ${nowUtc}::timestamp)
    RETURNING kind, provider, tool_connection_id, attempts`;
  const intent = claimed[0];
  if (!intent) return 'skipped';
  const call = intent.kind === 'slack' ? deleteSlackToolConnection : deleteTelegramToolConnection;
  const confirmed = await Promise.resolve().then(() => call(intent.provider, intent.tool_connection_id)).then((ok) => ok === true, () => false);
  if (confirmed) {
    await db.$executeRaw`UPDATE chat_tool_teardown_intents SET state = 'CONFIRMED', confirmed_at = ${nowUtc}::timestamp WHERE id = ${intentId} AND state = 'PENDING'`;
    return 'confirmed';
  }
  const capped = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE chat_tool_teardown_intents SET state = 'CAPPED', capped_at = ${nowUtc}::timestamp
    WHERE id = ${intentId} AND state = 'PENDING' AND attempts >= ${CHAT_TOOL_TEARDOWN_MAX_ATTEMPTS} RETURNING id`;
  if (capped.length > 0) {
    reportCapped({ intentId, kind: intent.kind, provider: intent.provider, toolConnectionId: intent.tool_connection_id, attempts: intent.attempts });
    return 'capped';
  }
  return 'failed';
}

const inFlight = new Set<Promise<unknown>>();

/** Test hook: resolves once every attempt {@link dispatchChatToolTeardown} started has finished (the dispatch is fire-and-forget). */
export async function chatToolTeardownIdle(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

/** After the commit: the first attempt on each recorded intent. Fire-and-forget; one tool failing never stops another or fails the delete. */
export function dispatchChatToolTeardown(teardowns: readonly ChatToolTeardown[]): void {
  for (const t of teardowns) {
    const attempt = attemptChatToolTeardown(globalDb, t.id)
      .catch((error: unknown) => {
        console.error(`[chatToolTeardown] ${t.kind} teardown attempt failed for ${t.provider}/${t.toolConnectionId}:`, error);
      })
      .finally(() => { inFlight.delete(attempt); });
    inFlight.add(attempt);
  }
}

/**
 * Queue the live connections of an owner that is ALREADY deleted (a live row whose App, or whose organization, is soft-deleted;
 * for Slack, whose default App or organization is), through the same intent. Only those: a live owner's row is never reached.
 * Bounded per call; `FOR UPDATE SKIP LOCKED` so two instances do not fight over a row. Returns how many rows it queued.
 */
export async function reconcileOrphanedChatToolConnections(db: PrismaClient, limit = RECONCILE_BATCH): Promise<number> {
  const telegram = await db.$queryRaw<IntentRow[]>(recordIntents('telegram', Prisma.sql`
    UPDATE telegram_connections SET deleted_at = ${NOW_UTC}, deleted_by = 'system:reconcile'
    WHERE deleted_at IS NULL AND id IN (
      SELECT c.id FROM telegram_connections c
      WHERE c.deleted_at IS NULL
        AND (EXISTS (SELECT 1 FROM apps a WHERE a.id = c.app_id AND a.deleted_at IS NOT NULL)
          OR EXISTS (SELECT 1 FROM organizations o WHERE o.id = c.organization_id AND o.deleted_at IS NOT NULL))
      ORDER BY c.id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING id, provider, tool_connection_id`));
  const slack = await db.$queryRaw<IntentRow[]>(recordIntents('slack', Prisma.sql`
    UPDATE slack_connections SET deleted_at = ${NOW_UTC}, deleted_by = 'system:reconcile'
    WHERE deleted_at IS NULL AND id IN (
      SELECT c.id FROM slack_connections c
      WHERE c.deleted_at IS NULL
        AND (EXISTS (SELECT 1 FROM apps a WHERE a.id = c.default_app_id AND a.deleted_at IS NOT NULL)
          OR EXISTS (SELECT 1 FROM organizations o WHERE o.id = c.organization_id AND o.deleted_at IS NOT NULL))
      ORDER BY c.id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING id, provider, tool_connection_id`));
  return telegram.length + slack.length;
}

/**
 * Cap what a crash left behind: an intent still PENDING with every attempt used (the tenth claim ran, the process died before it
 * recorded the outcome) can never be claimed again, so without this it would sit PENDING, silent, forever. Once its last wait has
 * passed it is CAPPED through the same guarded transition, with the one alarm. Returns how many it capped.
 */
async function capExhausted(db: PrismaClient, now: Date): Promise<number> {
  const nowUtc = toNaiveUtc(now);
  const rows = await db.$queryRaw<Array<{ id: string; kind: string; provider: string; tool_connection_id: string; attempts: number }>>`
    UPDATE chat_tool_teardown_intents SET state = 'CAPPED', capped_at = ${nowUtc}::timestamp
    WHERE state = 'PENDING' AND attempts >= ${CHAT_TOOL_TEARDOWN_MAX_ATTEMPTS}
      AND last_attempt_at + interval '5 minutes' * LEAST(power(2, LEAST(attempts - 1, 7)), 72) <= ${nowUtc}::timestamp
    RETURNING id, kind, provider, tool_connection_id, attempts`;
  for (const r of rows) reportCapped({ intentId: r.id, kind: r.kind, provider: r.provider, toolConnectionId: r.tool_connection_id, attempts: r.attempts });
  return rows.length;
}

/**
 * One bounded sweep pass: reconcile live rows of deleted owners, cap what a crash left exhausted, then attempt every intent that is
 * due (PENDING, under the cap, its wait passed), oldest first. Never throws on one intent; a pass over nothing does nothing.
 */
export async function chatToolTeardownSweepTick(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<{ reconciled: number; capped: number; attempted: number; confirmed: number }> {
  const reconciled = await reconcileOrphanedChatToolConnections(db);
  let capped = await capExhausted(db, now);
  const nowUtc = toNaiveUtc(now);
  const due = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM chat_tool_teardown_intents
    WHERE state = 'PENDING' AND attempts < ${CHAT_TOOL_TEARDOWN_MAX_ATTEMPTS}
      AND (last_attempt_at IS NULL OR last_attempt_at + interval '5 minutes' * LEAST(power(2, LEAST(attempts - 1, 7)), 72) <= ${nowUtc}::timestamp)
    ORDER BY last_attempt_at NULLS FIRST, id LIMIT ${SWEEP_BATCH}`;
  let attempted = 0;
  let confirmed = 0;
  for (const { id } of due) {
    let outcome: TeardownAttempt;
    try { outcome = await attemptChatToolTeardown(db, id, now); } catch (error) { console.error('[chatToolTeardown] sweep attempt failed:', error); continue; }
    if (outcome === 'skipped') continue;
    attempted++;
    if (outcome === 'confirmed') confirmed++;
    if (outcome === 'capped') capped++;
  }
  return { reconciled, capped, attempted, confirmed };
}

/** The operator's lever: put CAPPED intents back in the retry from a clean count (one by id, or every one). Returns how many. */
export async function requeueCappedChatToolTeardowns(db: PrismaClient, opts: { id: string } | { all: true }): Promise<number> {
  const where = 'id' in opts ? Prisma.sql`id = ${opts.id} AND` : Prisma.empty;
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE chat_tool_teardown_intents SET state = 'PENDING', attempts = 0, last_attempt_at = NULL, capped_at = NULL
    WHERE ${where} state = 'CAPPED' RETURNING id`;
  return rows.length;
}

/** The capped intents, for an operator: ids and handles only (never a token), oldest cap first. */
export async function listCappedChatToolTeardowns(
  db: PrismaClient,
): Promise<Array<{ id: string; kind: string; provider: string; toolConnectionId: string; attempts: number; cappedAt: Date | null }>> {
  return db.chatToolTeardownIntent.findMany({
    where: { state: 'CAPPED' },
    orderBy: [{ cappedAt: 'asc' }, { id: 'asc' }],
    select: { id: true, kind: true, provider: true, toolConnectionId: true, attempts: true, cappedAt: true },
  });
}
