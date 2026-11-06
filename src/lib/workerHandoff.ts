/**
 * Worker handoffs (#1029) — the continuity record between two stints of one
 * worker.
 *
 * ## Why this exists
 *
 * `endSession(summary:)` wrote `Session.summary` and nothing read it back, so
 * the only transport between one stint of a worker and the next was a human
 * copying text out of one chat session and pasting it into another. The fix has
 * two separable halves, and only the first was settled by decision:
 *
 * - **Storage** (Holger, 2026-08-18): ordered child nodes in the worker's own
 *   working memory (`Worker.memoryId`), append-only, newest last. Chosen over
 *   `Session.summary` (one mutable string, no ordering, no read path) and
 *   the per-worker prompt override (since removed, #2712: single field, no history, and it conflates what a worker
 *   has BECOME with where a worker GOT TO). What ordered nodes give that
 *   neither does: a sequence a human can walk in the portal with no new surface
 *   built, individual addressability so a handoff can be cited, revision
 *   history, and the memory's existing access gates.
 * - **Delivery** (this module + `Worker.continuity`): a fresh session has to
 *   RECEIVE the newest handoff, because it does not know there is anything to
 *   look for. Binding is briefing, so binding is handoff.
 *
 * ## Why the convention lives here rather than in the client
 *
 * The loc format, the parent bootstrap and the memory lookup are three things a
 * caller would otherwise re-derive — the `#1028` pattern (domain logic
 * accreting on clients because the server exposes a primitive instead of the
 * intent), on a surface with three clients. `endSession(handoff:)` takes the
 * prose and this module owns the address.
 */

import type { PrismaClient } from '../generated/prisma/index.js';

/** Parent loc of a worker's handoff sequence, in its working memory. */
export const HANDOFFS_PARENT_LOC = 'handoffs';

/**
 * Envelope key on a handoff node's `data`: the session that wrote it.
 *
 * This is what lets `MISSING` be distinguished from `CURRENT` — "is the newest
 * handoff the one the previous stint wrote, or an older one it never replaced?"
 * — without which a three-day-old handoff is silently indistinguishable from a
 * current one.
 */
export const HANDOFF_SESSION_KEY = 'sessionId';

/**
 * What a fresh binding inherits.
 *
 * `MISSING` is deliberately not "no handoff": it still carries whatever newest
 * handoff exists, and reports that the PREVIOUS stint did not write it. A
 * reaped session leaves exactly this state, and the honest failure is to say so
 * rather than to hand over stale prose as though it were current
 * (#1029 done-criterion).
 */
export type WorkerContinuityStatus = 'FIRST_STINT' | 'CURRENT' | 'MISSING';

/**
 * Format a handoff's loc from an instant: `handoffs:<yyyy-mm-dd>-<hhmm>`.
 *
 * Lexically sortable, which is the whole ordering mechanism — `Node.seq` is a
 * 32-bit `Int` and a `yyyymmddhhmm` value overflows it, a trap this has hit
 * before. UTC, so a sequence written from two time zones still sorts by when it
 * happened rather than by where the driver was sitting.
 */
export function handoffLocFor(at: Date): string {
  const iso = at.toISOString();
  return `${HANDOFFS_PARENT_LOC}:${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

/**
 * The loc to write next, disambiguated only if the minute is already taken.
 *
 * The common case keeps the exact shape the convention documents, so nothing
 * already written becomes irregular; a second handoff in the same minute gets a
 * ZERO-PADDED suffix (`-02`, `-03`, … `-50`) that still sorts after its
 * predecessor.
 *
 * The suffix is ZERO-PADDED (PR #1045 review, Codex P2). Unpadded, `-10` sorts
 * BEFORE `-9`, so once ten handoffs landed in one minute the newest-by-loc read
 * would silently return the ninth — a correctness bug in the ordering contract
 * that only appears under load, which is the worst time to discover it. Two
 * digits cover the bound below.
 *
 * Bounded rather than unbounded: a caller looping here is a bug, and a loud
 * failure beats a spin.
 */
export async function nextHandoffLoc(
  db: Pick<PrismaClient, 'node'>,
  memoryId: string,
  at: Date,
): Promise<string> {
  const base = handoffLocFor(at);
  for (let n = 1; n <= 50; n++) {
    const loc = n === 1 ? base : `${base}-${String(n).padStart(2, '0')}`;
    // loc-scope-ok: scoped to one memory by id.
    const taken = await db.node.findFirst({
      where: { memoryId, loc },
      select: { id: true },
    });
    if (!taken) return loc;
  }
  throw new Error(`Cannot allocate a handoff loc under ${base} — 50 already exist in this minute.`);
}

/**
 * The newest handoff node in a worker's working memory, or null.
 *
 * Ordered by `loc` descending, which IS the ordering contract — see
 * `handoffLocFor`. Children only: the parent node itself carries the convention
 * prose, not a handoff, and `startsWith` on the `:`-terminated prefix keeps a
 * sibling branch (`handoffs-archive`) out.
 */
export async function newestHandoff(
  db: Pick<PrismaClient, 'node'>,
  memoryId: string,
): Promise<{ id: string; loc: string; data: unknown; createdAt: Date } | null> {
  // loc-scope-ok: scoped to one memory by id.
  const rows = await db.node.findMany({
    where: {
      memoryId,
      loc: { startsWith: `${HANDOFFS_PARENT_LOC}:` },
      deletedAt: null,
    },
    orderBy: { loc: 'desc' as const },
    take: 1,
    select: { id: true, loc: true, data: true, createdAt: true },
  });
  return rows[0] ?? null;
}

/**
 * Which session wrote a handoff, from its envelope — null for a hand-written
 * one (the prototype nodes predate this write path and carry no envelope).
 *
 * A null here reads as "not written by the previous session", so a hand-written
 * handoff surfaces as `MISSING` rather than `CURRENT`. That is the honest
 * answer: the platform genuinely cannot attest that it belongs to the stint
 * that just ended.
 */
export function handoffSessionId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const value = (data as Record<string, unknown>)[HANDOFF_SESSION_KEY];
  return typeof value === 'string' ? value : null;
}

/**
 * Derive the continuity status from the previous stint and the newest handoff.
 *
 * Kept as a pure function so the three states are readable in one place and
 * testable without a database — the resolver supplies the two facts.
 */
export function continuityStatusOf(args: {
  previousSessionId: string | null;
  handoffSessionId: string | null;
}): WorkerContinuityStatus {
  if (!args.previousSessionId) return 'FIRST_STINT';
  return args.handoffSessionId === args.previousSessionId ? 'CURRENT' : 'MISSING';
}

/** The shape `Worker.continuity` resolves to, as the MCP renderer needs it. */
export interface RenderableContinuity {
  status: WorkerContinuityStatus;
  handoff: { loc: string; content: string | null; createdAt: Date } | null;
  previousSession: { id: string; endedAt: Date | null; autoExpiredAt: Date | null } | null;
}

/**
 * Render continuity for an MCP caller — used by BOTH `hadron_start_session`
 * and `hadron_get_worker`, so bind and post-compaction recovery cannot drift in
 * what they tell an agent.
 *
 * Returns '' when there is nothing to say (a first stint with no handoff), so a
 * caller can append it unconditionally without emitting an empty heading.
 *
 * The MISSING wording is the honest-degradation criterion (#1029): it names the
 * gap BEFORE the stale content, because an agent that reads a handoff first and
 * a caveat second has already started acting on it. An auto-expired stint says
 * so explicitly — "nobody wrote this down" and "the server reaped it mid-task"
 * lead a successor to different next steps.
 */
export function renderWorkerContinuity(c: RenderableContinuity | null): string {
  if (!c) return '';
  const body = c.handoff?.content?.trim() ?? '';
  const wrote = (h: NonNullable<RenderableContinuity['handoff']>) =>
    `${h.loc}, written ${h.createdAt.toISOString()}`;

  if (c.status === 'CURRENT' && c.handoff) {
    return (
      `\n\nHandoff from the previous session (${wrote(c.handoff)}) — this is where the last stint got to. ` +
      'Read it before you act, and follow its pointers rather than re-deriving them:\n\n' +
      body
    );
  }

  if (c.status === 'MISSING') {
    const prev = c.previousSession;
    const how = prev?.autoExpiredAt
      ? `was auto-expired by the server at ${prev.autoExpiredAt.toISOString()} — nobody closed it deliberately`
      : `ended at ${prev?.endedAt?.toISOString() ?? 'an unrecorded time'} without writing one`;
    const head =
      `\n\n⚠ No current handoff: the previous session (${prev?.id.slice(0, 8) ?? 'unknown'}) ${how}. ` +
      'Whatever it was mid-way through is not written down anywhere.';
    return c.handoff
      ? `${head}\n\nThe newest handoff on file is OLDER than that stint (${wrote(c.handoff)}) — ` +
          'treat it as history, not as the current state of play:\n\n' +
          body
      : `${head} There is no earlier handoff either, so start by reading the team chat and your own worklog.`;
  }

  // FIRST_STINT — say nothing rather than announce an absence that is normal.
  // A handoff with no ended session before it is not reachable through the
  // write path, but if one is ever hand-written, hand it over rather than
  // silently dropping it.
  return c.handoff ? `\n\nA handoff exists for this worker (${wrote(c.handoff)}):\n\n${body}` : '';
}
