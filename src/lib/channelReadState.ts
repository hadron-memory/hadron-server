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
 */

import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import { getAccessibleMemoryIds } from '../api/graphql/schema/resolvers.helpers.js';
import { generateId } from './id.js';
import { BROADCAST_MENTION_TOKENS, mentionTokenOf } from './mentionToken.js';
import { parseRunRegisterSnapshot, type RegisterAttendee } from './resolveRegister.js';
import { escapePrismaLikePattern } from './literalLocPrefix.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** Message nodeTypes that occupy a seq — mirrors chatRoot.ts's allowlist. */
const MESSAGE_NODE_TYPES = ['chat-message', 'record'];

/**
 * Advance an attendee's cursor on a Channel — monotonic, race-safe, and safe
 * inside an interactive transaction (`ON CONFLICT … DO UPDATE`, never a
 * caught P2002). Returns the cursor after the write.
 */
export async function advanceReadState(db: Db, attendee: RegisterAttendee, channelId: string, seq: number): Promise<number> {
  const target = Math.max(0, Math.floor(seq));
  const rows =
    'workerId' in attendee
      ? await db.$queryRaw<Array<{ last_seen_seq: number }>>`
          INSERT INTO channel_read_states (id, worker_id, channel_id, last_seen_seq, updated_at)
          VALUES (${generateId()}, ${attendee.workerId}, ${channelId}, ${target}, now())
          ON CONFLICT (worker_id, channel_id) WHERE worker_id IS NOT NULL
            DO UPDATE SET last_seen_seq = GREATEST(channel_read_states.last_seen_seq, EXCLUDED.last_seen_seq), updated_at = now()
          RETURNING last_seen_seq`
      : await db.$queryRaw<Array<{ last_seen_seq: number }>>`
          INSERT INTO channel_read_states (id, agent_id, app_id, channel_id, last_seen_seq, updated_at)
          VALUES (${generateId()}, ${attendee.agentId}, ${attendee.appId}, ${channelId}, ${target}, now())
          ON CONFLICT (agent_id, app_id, channel_id) WHERE agent_id IS NOT NULL
            DO UPDATE SET last_seen_seq = GREATEST(channel_read_states.last_seen_seq, EXCLUDED.last_seen_seq), updated_at = now()
          RETURNING last_seen_seq`;
  return rows[0]?.last_seen_seq ?? target;
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

/** The mention tokens that address an attendee — broadcasts plus its own Worker token(s). */
export async function attendeeMentionTokens(db: Db, attendee: RegisterAttendee): Promise<string[]> {
  const workers =
    'workerId' in attendee
      ? await db.worker.findMany({ where: { id: attendee.workerId }, select: { name: true } })
      : await db.worker.findMany({ where: { agentId: attendee.agentId, appId: attendee.appId, retiredAt: null }, select: { name: true } });
  return [...new Set([
    ...BROADCAST_MENTION_TOKENS,
    ...workers.map((w) => mentionTokenOf(w.name)).filter((t): t is string => !!t),
  ])];
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
      // Only new messages that name the attendee count — a small indexed
      // query over the (seen, lastSeq] window, content never injected.
      const mentions = tokens.length
        ? await db.node.count({
            where: {
              memoryId: c.memoryId,
              loc: { startsWith: escapePrismaLikePattern(`${c.loc}:messages:`) },
              nodeType: { in: MESSAGE_NODE_TYPES },
              deletedAt: null,
              seq: { gt: seen, lte: c.lastSeq },
              OR: tokens.map((t) => ({ data: { path: ['mentions'], array_contains: [t] } })),
            },
          })
        : 0;
      lines.push(
        mentions > 0
          ? `- ${c.name} (${where}): ${mentions} new mention${mentions === 1 ? '' : 's'} of you since seq ${seen} (channel is at ${c.lastSeq})`
          : `- ${c.name} (${where}): nothing new for you (mention-only; channel is at ${c.lastSeq})`,
      );
      continue;
    }
    lines.push(`- ${c.name} (${where}): new since seq ${seen} (channel is at ${c.lastSeq})`);
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
