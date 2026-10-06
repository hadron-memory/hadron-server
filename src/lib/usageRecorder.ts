/**
 * #1061 — the ONE write path for operation-count usage events (`read` / `write`).
 *
 * Counterpart to {@link ./usageActivity.ts}, which aggregates what this module
 * records. Before #1061 there were exactly four emitters, all inline in
 * `src/mcp/server.ts` (`hadron_get_node`, `hadron_get_nodes`,
 * `hadron_create_node`, `hadron_update_node`), so the Usage Activity chart
 * under-reported by roughly an order of magnitude: every search, list, portal
 * read, CLI read, chat post, worklog record, delete, move and edge write was
 * invisible. Routing all of them through one helper is what keeps a new
 * read/write surface from silently re-opening that gap.
 *
 * This is deliberately NOT `recordLlmUsage` (spec 046). That module owns
 * TOKEN-BEARING events: it carries a cost snapshot, BYOK classification and the
 * gated credit debit. Operation-count events carry none of those — they are a
 * count of graph activity, not of spend — so they stay a plain insert. The
 * rule from `conventions:llm-usage-metering-chokepoint` is unchanged; this
 * module is just the shared spelling of the "stays inline" half of it.
 *
 * CONTRACT: recording never fails, delays, or alters the work it measures.
 * Every entry point is void-returning and fire-and-forget — the insert is not
 * awaited and its rejection is swallowed. A metering failure must never turn a
 * successful read into an error.
 *
 * AUTHORIZATION IS THE CALLER'S JOB. This module records what a caller was
 * already allowed to do; it performs no access checks. Only pass nodes the
 * caller demonstrably read or wrote — an event naming a node the caller cannot
 * read is the #825 defect (it lands in another tenant's analytics).
 *
 * WHAT COUNTS AS A READ (Holger, 2026-08-21): node CONTENT crossing the
 * boundary. A surface returning N node projections records N reads — a search
 * with 30 hits is thirty reads, so reading 30 nodes through one search and
 * reading them one at a time land in the same place on the chart.
 *
 * The corollary is the line the following surfaces sit on the far side of, by
 * decision rather than by omission:
 *   - `hadron_search` / `globalSearch` — one locator line per hit
 *     (`[kind] urn — name`), across seven entity kinds most of which are not
 *     nodes. It can MATCH on body text, but it never returns it.
 *   - `hadron_list_nodes` — a tree outline of `urn — name (N children)`.
 *   - `Query.resolveUrn` — resolves a URN to `{kind, id, memoryId}`.
 * Locating a node is not reading it. If one of these ever starts returning
 * content (an abstract in the outline, a snippet in the hit line), it crosses
 * the line and must record. GraphQL `findNodes` is NOT an exception to this:
 * even with no query it returns whole node projections, so it records.
 */

import { usageEventCountsAsActivity } from './sessionActivity.js';
import { generateId } from './id.js';
import type { Prisma, PrismaClient } from '../generated/prisma/index.js';

/** The two operation-count event types the usage-activity surface aggregates. */
export type UsageOperationType = 'read' | 'write';

/**
 * The node a usage event is attributed to. `memoryId` is carried explicitly
 * rather than derived from `nodeId`: the FK is `SetNull` on node deletion, so a
 * memory would silently lose every event whose node was later deleted
 * (`findings:usage-events-memory-scoping`, #796).
 */
export interface UsageNodeRef {
  id: string;
  loc: string;
  memoryId: string;
}

/** Resolved attribution for one event. See {@link usageActorFrom}. */
export interface UsageActor {
  userId: string | null;
  appId: string | null;
  clientId: string | null;
  sessionId: string | null;
  /** True when recording must be suppressed entirely — see {@link usageActorFrom}. */
  suppressed: boolean;
}

/**
 * The shape both principal carriers satisfy structurally: the GraphQL `Context`
 * and the MCP `auth` object. Typed structurally rather than as a union so this
 * module imports neither — `resolvers.helpers.ts` and `mcp/server.ts` both
 * import THIS, and a back-import would be a cycle.
 */
export interface UsagePrincipal {
  userId?: string | null;
  appId?: string | null;
  clientId?: string | null;
  sessionId?: string | null;
  /** Present and truthy only on the GraphQL side, during admin impersonation. */
  impersonation?: unknown;
}

/**
 * Normalize a principal into event attribution.
 *
 * IMPERSONATION IS SUPPRESSED, not re-attributed. In an admin support session
 * `ctx.userId` is the TARGET user, so recording normally would file an admin's
 * browsing as the target's own activity — the exact fail-open shape the #876
 * sweep catalogued, here landing in the target's Usage Activity chart. Nor is
 * `userId: null` right: a support read is observation, not the memory's usage,
 * and impersonation already has a purpose-built audit trail. So an impersonated
 * caller records nothing at all.
 */
export function usageActorFrom(principal: UsagePrincipal): UsageActor {
  return {
    userId: principal.userId ?? null,
    appId: principal.appId ?? null,
    // The audit string, matching what the pre-#1061 emitters wrote: MCP passed
    // `auth.clientId`, the GraphQL `recordUsage` mutation preferred `userId`.
    // Preferring clientId keeps the human-readable "github:<user>" form when
    // there is one; `userId` is carried separately in its own column anyway.
    clientId: principal.clientId ?? principal.userId ?? null,
    sessionId: principal.sessionId ?? null,
    suppressed: Boolean(principal.impersonation),
  };
}

/**
 * Rows per `createMany`. A single call CAN legitimately touch thousands of
 * nodes — `searchReplaceInNodes` over a whole memory is the extreme — and one
 * unbounded insert would hold a pool connection far longer than the work it
 * measures. Chunking keeps the fire-and-forget insert cheap and bounded.
 */
const INSERT_CHUNK = 500;

// Recording remains off the request path, but fixture/shutdown boundaries can
// wait for its complete lifetime, including activity checks and every chunk.
const pendingUsageWrites = new WeakMap<object, Set<Promise<void>>>();

/**
 * Wait for this client's outstanding operation-usage writes (#1189).
 * Call only at a quiescent boundary; this does not stop future producers.
 * Failures retain the recorder's swallow-and-continue contract.
 */
export async function drainNodeUsage(db: object): Promise<void> {
  while (true) {
    const pending = pendingUsageWrites.get(db);
    if (!pending?.size) return;
    await Promise.all([...pending]);
  }
}

function trackUsageWrite(db: object, write: Promise<void>): void {
  let pending = pendingUsageWrites.get(db);
  if (!pending) pendingUsageWrites.set(db, (pending = new Set()));
  pending.add(write);
  void write.then(() => {
    pending.delete(write);
    if (pending.size === 0) pendingUsageWrites.delete(db);
  });
}

/**
 * Record one `read`/`write` event per node. Fire-and-forget: returns
 * immediately, never throws, never rejects.
 *
 * Pass EVERY node whose content the caller received — a search returning 30
 * hits records 30 reads (Holger, 2026-08-21). The unit is "node content
 * returned", not "operation performed", so the series stays comparable across
 * surfaces that return one node and surfaces that return many.
 *
 * An empty `nodes` array is a no-op, so callers can hand over a filtered list
 * without a length check.
 */
export function recordNodeUsage(
  db: Pick<PrismaClient, 'usageEvent'>,
  type: UsageOperationType,
  nodes: UsageNodeRef | readonly UsageNodeRef[],
  principal: UsagePrincipal,
): void {
  // The whole body is guarded, not just the insert's promise. `.catch()` only
  // covers a REJECTION; a SYNCHRONOUS throw before the promise exists — a
  // caller whose `db` has no `usageEvent` delegate, a malformed ref — would
  // propagate straight into the read or write being measured and fail it. That
  // is precisely the outcome the fire-and-forget contract exists to prevent, so
  // it cannot depend on every call site handing over a well-formed client.
  try {
    const actor = usageActorFrom(principal);
    if (actor.suppressed) return;

    const list = Array.isArray(nodes) ? nodes : [nodes as UsageNodeRef];
    if (list.length === 0) return;

    const rows: Prisma.UsageEventCreateManyInput[] = list.map((n) => ({
      id: generateId(),
      type,
      nodeLoc: n.loc,
      nodeId: n.id,
      memoryId: n.memoryId,
      appId: actor.appId,
      // spec 046 FR-001 — user attribution when the principal is a user. This
      // column, not `createdBy`, is what the own-activity chart filters on.
      userId: actor.userId,
      createdBy: actor.clientId,
      // #930 — the bound session doubles as the reaper's liveness heartbeat, so
      // an un-attributed event lets a busy session read as idle.
      sessionId: actor.sessionId,
    }));

    // #1653 / DY-2: the rows count as ACTIVITY only if the bound session is
    // live and owned by this principal right now. Decided once per call, off
    // the request path; any failure records them as not counting (safe).
    const write = (async () => {
      // One instant for the decision and every row's timestamp (local P2-1).
      const at = new Date();
      const counts = await attributedRequestActivity(db, principal, actor.sessionId, { at });
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        await db.usageEvent
          .createMany({ data: rows.slice(i, i + INSERT_CHUNK).map((r) => ({ ...r, countsAsActivity: counts, createdAt: at })) })
          .catch(() => {});
      }
    })().catch(() => {});
    trackUsageWrite(db, write);
  } catch {
    // Deliberately silent: see above. Metering a read must never break it.
  }
}

/**
 * Does a request attributed to `sessionId` count as ACTIVITY? (#1653, DY-1,
 * DY-2.) Yes when the session is live and owned by this principal
 * (`usageEventCountsAsActivity`).
 *
 * For a PURE App key there is one more case. An App key cannot author team
 * chat or mark a cursor, so its attributed request is the only act it has;
 * under DY-1 that act RESUMES the key's own lapsed session, through the same
 * locked verdict every resume passes (`reviveOwnLapsedSession`: the
 * person-less session of the key's App, an unheld worker, nobody else live,
 * not dormant). A user's attributed request never resumes: a user resumes by
 * posting, reading or marking read (DA).
 *
 * Never throws; a failure reads as "does not count".
 */
export async function attributedRequestActivity(
  db: unknown,
  principal: UsagePrincipal,
  sessionId: string | null | undefined,
  opts: {
    /**
     * The instant liveness is judged at, which the caller MUST also write as
     * the event's `createdAt` (#1660 review, local P2-1). A check and a later
     * insert are separate operations, and a session can lapse between them;
     * stamping the event at the checked instant makes "counted" mean "live at
     * the moment it was counted", whenever the row lands.
     */
    at?: Date;
    /**
     * The caller's transaction, when the event insert IS the act (#1660
     * review, local P2-2): an App-key resume then commits with the insert or
     * not at all, instead of in a transaction of its own.
     */
    tx?: unknown;
  } = {},
): Promise<boolean> {
  if (!sessionId) return false;
  const client = (opts.tx ?? db) as Partial<Pick<PrismaClient, 'session' | 'usageEvent' | '$transaction'>>;
  if (!client.session || !client.usageEvent) return false;
  try {
    if (await usageEventCountsAsActivity(client as never, principal, sessionId, opts.at)) return true;
    if (principal.userId || principal.impersonation || !principal.appId) return false;
    // Lazy import: teamAttention sits above this module in the graph.
    const { reviveOwnLapsedSession, resumeOwnLapsedSessionInTx } = await import('./teamAttention.js');
    const ctxLike = { db: client, appId: principal.appId, roles: [] } as never;
    if (opts.tx) return await resumeOwnLapsedSessionInTx(ctxLike, opts.tx as never, sessionId);
    if (!client.$transaction) return false;
    return await reviveOwnLapsedSession(ctxLike, sessionId);
  } catch (err) {
    // Inside the caller's transaction a failure must abort it: swallowing it
    // here would let the insert commit on an aborted transaction's behalf.
    if (opts.tx) throw err;
    return false;
  }
}

/**
 * Convenience wrapper for the common single-node read. Accepts the node row
 * shape resolvers already have in hand.
 */
export function recordNodeRead(
  db: Pick<PrismaClient, 'usageEvent'>,
  node: UsageNodeRef | null | undefined,
  principal: UsagePrincipal,
): void {
  if (!node) return;
  recordNodeUsage(db, 'read', node, principal);
}

/** Convenience wrapper for the common single-node write. */
export function recordNodeWrite(
  db: Pick<PrismaClient, 'usageEvent'>,
  node: UsageNodeRef | null | undefined,
  principal: UsagePrincipal,
): void {
  if (!node) return;
  recordNodeUsage(db, 'write', node, principal);
}

/**
 * Narrow an arbitrary row to a {@link UsageNodeRef}, dropping anything that
 * lacks the three attribution fields.
 *
 * List surfaces project nodes with varying `select` sets, and a projection that
 * omits `memoryId` would otherwise record an event with a null memory — a row
 * that counts in the own-activity chart but silently vanishes from the
 * memory-scoped one. Filtering here makes the omission visible as a missing
 * event rather than an inconsistency between two charts.
 */
export function toUsageNodeRef(row: unknown): UsageNodeRef | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.loc !== 'string') return null;
  if (typeof r.memoryId !== 'string') return null;
  return { id: r.id, loc: r.loc, memoryId: r.memoryId };
}

/** {@link toUsageNodeRef} over a list, dropping rows that don't qualify. */
export function toUsageNodeRefs(rows: readonly unknown[]): UsageNodeRef[] {
  return rows.map(toUsageNodeRef).filter((r): r is UsageNodeRef => r !== null);
}
