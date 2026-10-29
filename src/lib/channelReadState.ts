/**
 * Spec 049 Phase 7 — read-state and the attention section (D-2026-09-13-009,
 * plan §3.6 / §4.4 / §8.7).
 *
 * Read-state is where an ATTENDEE is up to on a Channel — outside the register
 * (what-I-attend and where-I-am are two records), keyed on the attendee so two
 * Workers cast from one Agent never share a cursor. Every advance is MONOTONIC:
 * `GREATEST(existing, incoming)` in one statement, so an older transaction
 * never overwrites a newer cursor; two concurrent runs may both see a window
 * as new (duplicate attention), never skip one.
 *
 * The attention section is CPU-computed per hop from the run's register
 * snapshot ∩ live `Channel.lastSeq` ∩ the attendee's read-state — no model
 * call, no message content. The watermark each Channel is AT when the section
 * is rendered is captured with it, and those captured values — not a re-read —
 * are what the checkpoint advances, so a message landing between render and
 * checkpoint is never skipped. `mentionOnly` rows count only new messages whose
 * stored `data.mentions` names one of the attendee's tokens: a Worker's own,
 * or for an Agent-in-App every Worker cast from that Agent in that App
 * (mentions name Workers, never Agents — plan §4.4, proposed).
 *
 * The attendee's OWN posts are never new to it, on any row (Holger,
 * 2026-09-26, hadron-server#1388; cor:dmo:090:07): the attention form of
 * "never send a message back to its author". Deciding that reads routing
 * metadata (`data.authorWorkerId`), never content. On an ENCRYPTED Channel the
 * author is sealed inside the envelope, so the row says it was not filtered
 * rather than decrypting per hop (accepted noise, same ruling).
 */

import { Prisma, type PrismaClient } from '../generated/prisma/index.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import { getAccessibleMemoryIds } from '../api/graphql/schema/resolvers.helpers.js';
import { generateId } from './id.js';
import { mentionTokenOf } from './mentionToken.js';
import { mentionReachSql } from './mentionReach.js';
import { parseRunRegisterSnapshot, type RegisterAttendee } from './resolveRegister.js';
import { escapePrismaLikePattern } from './literalLocPrefix.js';
import { TEAM_CHAT_LOC } from './teamChatLoc.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** Message nodeTypes that occupy a seq — mirrors chatRoot.ts's allowlist. */
const MESSAGE_NODE_TYPES = ['chat-message', 'record'];

/**
 * Advance an attendee's cursor on a Channel — monotonic, race-safe, and safe
 * inside an interactive transaction (`ON CONFLICT … DO UPDATE`, never a
 * caught P2002). Returns the cursor after the write.
 *
 * #2181: the same statement records the Channel incarnation the cursor was RAISED under (`channel_incarnation`). An
 * insert records it; a conflict records it only when `last_seen_seq` rises, so an equal or lower mark changes neither
 * and a legacy NULL label is never relabelled as current.
 */
export async function advanceReadState(db: Db, attendee: RegisterAttendee, channelId: string, seq: number): Promise<number> {
  const target = Math.max(0, Math.floor(seq));
  const rows =
    'workerId' in attendee
      ? await db.$queryRaw<Array<{ last_seen_seq: number }>>`
          INSERT INTO channel_read_states (id, worker_id, channel_id, last_seen_seq, channel_incarnation, updated_at)
          VALUES (${generateId()}, ${attendee.workerId}, ${channelId}, ${target}, (SELECT incarnation FROM channels WHERE id = ${channelId}), now())
          ON CONFLICT (worker_id, channel_id) WHERE worker_id IS NOT NULL
            DO UPDATE SET
              channel_incarnation = CASE WHEN EXCLUDED.last_seen_seq > channel_read_states.last_seen_seq
                THEN EXCLUDED.channel_incarnation ELSE channel_read_states.channel_incarnation END,
              last_seen_seq = GREATEST(channel_read_states.last_seen_seq, EXCLUDED.last_seen_seq), updated_at = now()
          RETURNING last_seen_seq`
      : await db.$queryRaw<Array<{ last_seen_seq: number }>>`
          INSERT INTO channel_read_states (id, agent_id, app_id, channel_id, last_seen_seq, channel_incarnation, updated_at)
          VALUES (${generateId()}, ${attendee.agentId}, ${attendee.appId}, ${channelId}, ${target}, (SELECT incarnation FROM channels WHERE id = ${channelId}), now())
          ON CONFLICT (agent_id, app_id, channel_id) WHERE agent_id IS NOT NULL
            DO UPDATE SET
              channel_incarnation = CASE WHEN EXCLUDED.last_seen_seq > channel_read_states.last_seen_seq
                THEN EXCLUDED.channel_incarnation ELSE channel_read_states.channel_incarnation END,
              last_seen_seq = GREATEST(channel_read_states.last_seen_seq, EXCLUDED.last_seen_seq), updated_at = now()
          RETURNING last_seen_seq`;
  return rows[0]?.last_seen_seq ?? target;
}

/**
 * #2181 — the two incarnations a read state is described by: the Channel's CURRENT one, and the one the stored cursor was
 * last raised under (NULL = legacy / never advanced under a known incarnation). They are separate on purpose: a client
 * may call a cursor current only when both equal its sampled incarnation.
 */
export async function readStateIncarnations(
  db: Db,
  attendee: RegisterAttendee,
  channelId: string,
): Promise<{ channelIncarnation: number; cursorIncarnation: number | null }> {
  const [channel, state] = await Promise.all([
    db.channel.findUnique({ where: { id: channelId }, select: { incarnation: true } }),
    db.$queryRaw<Array<{ channel_incarnation: number | null }>>`
      SELECT channel_incarnation FROM channel_read_states
      WHERE channel_id = ${channelId} AND ${'workerId' in attendee
        ? Prisma.sql`worker_id = ${attendee.workerId}`
        : Prisma.sql`agent_id = ${attendee.agentId} AND app_id = ${attendee.appId}`}`,
  ]);
  return { channelIncarnation: channel?.incarnation ?? 1, cursorIncarnation: state[0]?.channel_incarnation ?? null };
}

/**
 * #2138 §3.1 — record that a worker CHECKED its App's team channel: `last_checked_at = now()` on its own read-state row,
 * created at seq 0 when it has none. A check is any read of that channel through the worker's OWN bound session (a page
 * read, an inbox read, a mark-read, an empty one included); it moves no read position and no delivery mark.
 *
 * Only the App's TEAM channel counts: a channel whose root is `chats:team` in a memory of the worker's own App. Anything
 * else, or a worker of another App, stamps nothing. Callers must have established that the actor IS the worker's own
 * live session; this function cannot tell a person's `asMe` read from the worker's, so it is never called for those.
 * Returns whether a row was stamped.
 */
export async function stampChannelCheck(db: Db, workerId: string, channelId: string): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ ok: number }>>`
    INSERT INTO channel_read_states (id, worker_id, channel_id, last_seen_seq, last_checked_at, updated_at)
    SELECT ${generateId()}, w.id, c.id, 0, now(), now()
    FROM workers w
    JOIN channels c ON c.id = ${channelId} AND c.deleted_at IS NULL AND c.loc = ${TEAM_CHAT_LOC}
    JOIN memories m ON m.id = c.memory_id AND m.app_id = w.app_id
    WHERE w.id = ${workerId} AND w.retired_at IS NULL
    ON CONFLICT (worker_id, channel_id) WHERE worker_id IS NOT NULL
      DO UPDATE SET last_checked_at = now()
    RETURNING 1 AS ok`;
  return rows.length > 0;
}

/**
 * #2138 §3.1 — the inbox read: a worker's own session read of its pending batches checks the team channel(s) of its App
 * (the inbox is not addressed to one channel). Same rules as {@link stampChannelCheck}; returns the channels stamped.
 */
export async function stampTeamChannelChecks(db: Db, workerId: string): Promise<number> {
  const rows = await db.$queryRaw<Array<{ ok: number }>>`
    INSERT INTO channel_read_states (id, worker_id, channel_id, last_seen_seq, last_checked_at, updated_at)
    SELECT gen_random_uuid()::text, w.id, c.id, 0, now(), now()
    FROM workers w
    JOIN memories m ON m.app_id = w.app_id
    JOIN channels c ON c.memory_id = m.id AND c.deleted_at IS NULL AND c.loc = ${TEAM_CHAT_LOC}
    WHERE w.id = ${workerId} AND w.retired_at IS NULL
    ON CONFLICT (worker_id, channel_id) WHERE worker_id IS NOT NULL
      DO UPDATE SET last_checked_at = now()
    RETURNING 1 AS ok`;
  return rows.length;
}

/**
 * #2138 follow-up — WHY a read that arrived with a session did not count as a check. Log-only diagnostics (the
 * `channel.check.miss` AppLog entry); no behaviour hangs on it.
 *  - BINDING_REFUSED: the request NAMED a session (X-Hadron-Session) but the server refused the binding, so it was served as a
 *    session-less read (the caller is not told).
 *  - SESSION_NOT_OWN_LIVE: the session is not the caller's own live Worker session.
 *  - SESSION_REVIVE_REFUSED: the session had lapsed and could not be resumed.
 *  - CROSS_APP: the channel is another App's team channel (the worker's own App does not host it).
 *  - WORKER_RETIRED / CHANNEL_GONE: the worker or the channel is gone.
 *  - NO_TEAM_CHANNEL: the inbox read found no team channel of the worker's App.
 */
export type CheckMissReason =
  | 'BINDING_REFUSED' | 'SESSION_NOT_OWN_LIVE' | 'SESSION_REVIVE_REFUSED'
  | 'CROSS_APP' | 'WORKER_RETIRED' | 'CHANNEL_GONE' | 'NO_TEAM_CHANNEL';

/** Why `stampChannelCheck` stamped nothing, or null when the channel is simply not a team channel (not a miss). */
export async function diagnoseNoStamp(db: Db, workerId: string, channelId: string): Promise<CheckMissReason | null> {
  const [w, c] = await Promise.all([
    db.worker.findUnique({ where: { id: workerId }, select: { appId: true, retiredAt: true } }),
    db.channel.findUnique({ where: { id: channelId }, select: { loc: true, deletedAt: true, memory: { select: { appId: true } } } }),
  ]);
  if (!c || c.deletedAt) return c && c.loc === TEAM_CHAT_LOC ? 'CHANNEL_GONE' : null;
  if (c.loc !== TEAM_CHAT_LOC) return null;
  if (!w || w.retiredAt) return 'WORKER_RETIRED';
  if (c.memory.appId !== w.appId) return 'CROSS_APP';
  return null;
}

/**
 * Log one `channel.check.miss` AppLog entry. Log-only and never throws: it records the reason code and the way the read
 * arrived, plus the session id the AppLog row already carries, and nothing about the worker, the channel or the message
 * content. A channel that is not a team channel logs nothing (an ordinary read of another channel is not a miss).
 */
export async function recordCheckMiss(
  db: Db,
  args: { channelId: string; sessionId?: string | null; reason: CheckMissReason; via: 'read' | 'mark' | 'inbox' },
): Promise<void> {
  try {
    const ch = await db.channel.findUnique({ where: { id: args.channelId }, select: { loc: true, memory: { select: { appId: true } } } });
    if (!ch || ch.loc !== TEAM_CHAT_LOC) return;
    const session = args.sessionId ? await db.session.findUnique({ where: { id: args.sessionId }, select: { appId: true } }) : null;
    const appId = session?.appId ?? ch.memory.appId;
    if (!appId) return;
    await db.appLogEntry.create({
      data: {
        appId,
        level: 'WARN',
        sessionId: args.sessionId ?? null,
        message: 'channel.check.miss',
        detail: { reason: args.reason, via: args.via },
      },
    });
  } catch {
    // diagnostics only: a failed log write must never affect the read
  }
}

/**
 * The inbox read stamped no team channel: log NO_TEAM_CHANNEL when the App truly has none (none provisioned, or deleted).
 * Called AFTER the read's transaction, best-effort and log-only: it never throws and cannot abort or alter the read.
 */
export async function recordNoTeamChannelMiss(db: Db, args: { appId: string; sessionId: string }): Promise<void> {
  try {
    // loc-scope-ok: scoped to this App's own memories (memory.appId), not a bare loc
    const own = await db.channel.findFirst({ where: { loc: TEAM_CHAT_LOC, deletedAt: null, memory: { appId: args.appId } }, select: { id: true } });
    if (own) return;
    await db.appLogEntry.create({
      data: { appId: args.appId, level: 'WARN', sessionId: args.sessionId, message: 'channel.check.miss', detail: { reason: 'NO_TEAM_CHANNEL', via: 'inbox' } },
    });
  } catch {
    // diagnostics only
  }
}

/** The attendee's cursors on a set of Channels; a Channel with no row reads 0. */
export async function readStatesFor(db: Db, attendee: RegisterAttendee, channelIds: string[]): Promise<Map<string, number>> {
  if (channelIds.length === 0) return new Map();
  const rows = await db.channelReadState.findMany({
    where: {
      channelId: { in: channelIds },
      ...('workerId' in attendee ? { workerId: attendee.workerId } : { agentId: attendee.agentId, appId: attendee.appId }),
    },
    select: { channelId: true, lastSeenSeq: true },
  });
  return new Map(rows.map((r) => [r.channelId, r.lastSeenSeq]));
}

/**
 * The mention tokens that name an attendee — its own Worker token(s). A
 * broadcast is not one of them (#2020): it reaches the attendee only when the
 * server stamped it at post time, which `mentionReach` / `mentionReachSql` decide.
 */
export async function attendeeMentionTokens(db: Db, attendee: RegisterAttendee): Promise<string[]> {
  const workers =
    'workerId' in attendee
      ? await db.worker.findMany({ where: { id: attendee.workerId }, select: { name: true } })
      : await db.worker.findMany({ where: { agentId: attendee.agentId, appId: attendee.appId, retiredAt: null }, select: { name: true } });
  return [...new Set(workers.map((w) => mentionTokenOf(w.name)).filter((t): t is string => !!t))];
}

/**
 * The Workers whose posts are the attendee's OWN, never new to it on any row
 * (#1388): on a mention-only row a Worker's own team-wide broadcast would
 * otherwise read as a mention of its own Agent (#1362 review, Codex P2), and
 * on an unfiltered row as news. Retired Workers included: their posts are
 * still the attendee's own.
 */
async function attendeeWorkerIds(db: Db, attendee: RegisterAttendee): Promise<string[]> {
  if ('workerId' in attendee) return [attendee.workerId];
  const workers = await db.worker.findMany({ where: { agentId: attendee.agentId, appId: attendee.appId }, select: { id: true } });
  return workers.map((w) => w.id);
}

export interface AttentionSection {
  /** The rendered `## Channels (attention)` block; '' when the run has no attendee or no rows. */
  text: string;
  /** Channel id → the watermark captured at render time — what the checkpoint advances. */
  captured: Map<string, number>;
}

/**
 * Render the attention section for a run (plan §4.4): one comparison per
 * Channel, no model call. Empty for a run with no attendee (no `agentId`),
 * no snapshot, or no rows.
 */
export async function renderAttentionSection(
  db: Db,
  run: { id: string; agentId: string | null; appId: string; userId: string | null; organizationId: string; registerSnapshot: unknown },
): Promise<AttentionSection> {
  const none: AttentionSection = { text: '', captured: new Map() };
  if (!run.agentId) return none;
  const snap = parseRunRegisterSnapshot(run.registerSnapshot);
  if (!snap || snap.rows.length === 0) return none;
  const attendee: RegisterAttendee = { agentId: run.agentId, appId: run.appId };
  const channelIds = [...new Set(snap.rows.map((r) => r.channelId))];
  // The snapshot is data, never a grant (plan §8.1): an owner-side register
  // row may name a Channel whose host memory this run's principal cannot
  // read, and a prompt line naming it would be the disclosure resolveRegister
  // refuses (Codex P1 on PR #1168). Intersect with the run principal's
  // canonical accessible set — the same Context{appId, userId?} the kernel's
  // tools run under (cor:agt:010:01) — before rendering or advancing.
  const principal = {
    db: db as PrismaClient,
    appId: run.appId,
    userId: run.userId ?? undefined,
    organizationId: run.organizationId,
    clientId: `run:${run.id}`,
  } as unknown as Context;
  const accessible = await getAccessibleMemoryIds(principal);
  const [channels, cursors] = await Promise.all([
    db.channel.findMany({
      where: {
        id: { in: channelIds },
        deletedAt: null,
        ...(accessible === null ? {} : { memoryId: { in: accessible } }),
      },
      select: { id: true, name: true, loc: true, lastSeq: true, memoryId: true, memory: { select: { urn: true, isEncrypted: true } } },
      orderBy: [{ loc: 'asc' }, { id: 'asc' }],
    }),
    readStatesFor(db, attendee, channelIds),
  ]);
  if (channels.length === 0) return none;
  const mentionRows = snap.rows.filter((r) => r.mentionOnly);
  const tokens = mentionRows.length ? await attendeeMentionTokens(db, attendee) : [];
  const ownWorkerIds = await attendeeWorkerIds(db, attendee);
  // A live message in the (seen, lastSeq] window, optionally narrowed. Own
  // posts are excluded with a NULL-SAFE predicate: a message with no
  // authorWorkerId (a human's) must still count, where a Prisma JSON-path NOT
  // would read it as NULL and drop it (#1362 review;
  // dev:findings:prisma-json-path-not-drops-rows-missing-the-key). Content is
  // never read or injected.
  const othersInWindow = (c: { memoryId: string; loc: string; lastSeq: number }, seen: number, narrow: Prisma.Sql) => Prisma.sql`
    FROM nodes node
    WHERE node.memory_id = ${c.memoryId}
      AND node.loc LIKE ${escapePrismaLikePattern(`${c.loc}:messages:`) + '%'} ESCAPE '\\'
      AND node.node_type IN (${Prisma.join(MESSAGE_NODE_TYPES)})
      AND node.deleted_at IS NULL
      AND node.seq > ${seen}
      AND node.seq <= ${c.lastSeq}
      AND NOT (COALESCE(node.data->>'authorWorkerId', '') = ANY(${ownWorkerIds}::text[]))
      ${narrow}`;
  const captured = new Map<string, number>();
  const lines: string[] = [];
  for (const c of channels) {
    const row = snap.rows.find((r) => r.channelId === c.id)!;
    const seen = cursors.get(c.id) ?? 0;
    captured.set(c.id, c.lastSeq);
    const where = `${c.memory.urn}:${c.loc}`;
    if (c.lastSeq <= seen) {
      lines.push(`- ${c.name} (${where}): nothing new`);
      continue;
    }
    if (row.mentionOnly && c.memory.isEncrypted) {
      // An encrypted memory stores the whole message envelope as `{ __enc }`,
      // so the `data.mentions` path below would match nothing and report
      // "nothing new for you" — and the checkpoint would then advance past a
      // mention (#1362 review, Codex P1). Mentions cannot be filtered here, so
      // fail toward duplicate attention, never toward loss: report it as new.
      lines.push(`- ${c.name} (${where}): new since seq ${seen} (channel is at ${c.lastSeq}; encrypted, so mentions were not filtered)`);
      continue;
    }
    if (row.mentionOnly) {
      // Only new messages that reach the attendee count (#2020: its names, or a
      // broadcast stamped at post time) — counted in SQL, so nothing is
      // materialized however large the window.
      const mentions = (
        await db.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n
          ${othersInWindow(c, seen, Prisma.sql`AND ${mentionReachSql(Prisma.sql`node.data`, Prisma.sql`${tokens}::text[]`, Prisma.sql`${ownWorkerIds}::text[]`)}`)}`
      )[0]?.n ?? 0;
      lines.push(
        mentions > 0
          ? `- ${c.name} (${where}): ${mentions} new mention${mentions === 1 ? '' : 's'} of you since seq ${seen} (channel is at ${c.lastSeq})`
          : `- ${c.name} (${where}): nothing new for you (mention-only; channel is at ${c.lastSeq})`,
      );
      continue;
    }
    if (c.memory.isEncrypted) {
      // The author is sealed in the envelope: say so rather than decrypt per
      // hop (#1388, accepted noise).
      lines.push(`- ${c.name} (${where}): new since seq ${seen} (channel is at ${c.lastSeq}; encrypted, so your own posts were not filtered)`);
      continue;
    }
    // One indexed EXISTS per row: only someone else's live post is news
    // (#1388; cor:dmo:090:07).
    const [{ found }] = await db.$queryRaw<Array<{ found: boolean }>>`
      SELECT EXISTS (SELECT 1 ${othersInWindow(c, seen, Prisma.empty)}) AS found`;
    lines.push(
      found
        ? `- ${c.name} (${where}): new since seq ${seen} (channel is at ${c.lastSeq})`
        : // Own posts, or deleted ones: either way nothing live from anyone
          // else, so say exactly that (#1393 QA, Chip).
          `- ${c.name} (${where}): nothing new from others since seq ${seen} (channel is at ${c.lastSeq})`,
    );
  }
  return { text: `## Channels (attention)\n${lines.join('\n')}`, captured };
}

/** Advance every captured watermark for a run's attendee — the checkpoint's other half. */
export async function advanceCapturedReadStates(
  db: Db,
  run: { agentId: string | null; appId: string },
  captured: Map<string, number>,
): Promise<void> {
  if (!run.agentId || captured.size === 0) return;
  const attendee: RegisterAttendee = { agentId: run.agentId, appId: run.appId };
  for (const [channelId, seq] of captured) {
    await advanceReadState(db, attendee, channelId, seq);
  }
}
