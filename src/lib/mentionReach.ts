// Which team-chat messages REACH a worker — #2020 (S4 of epic #2016), the one
// rule the mentions read and the mention counts share.
//
// A message reaches a worker when the worker did not write it AND its stored
// `mentions` either holds one of the worker's own tokens (a name, or a reply
// the post path folded in) or holds a broadcast token AND carries the
// `broadcastWakes` stamp the server wrote at post time (cor:agt:080:14: whether
// the author may wake everyone is decided when the message is posted, never
// re-decided from today's roles). An unstamped broadcast is ordinary unread, not
// a mention (cor:agt:080:08 "as 080:14 allows"). Nothing here re-parses a body.
//
// Due wakes (tickers/wakeRule.ts, tickers/dueWakes.ts) still apply their own
// timing rule; S1 (#2017) adopts this predicate there.

import { Prisma } from '../generated/prisma/index.js';
import { BROADCAST_MENTION_TOKENS } from './mentionToken.js';

/** The part of a message envelope routing reads. */
export type ReachEnvelope = {
  authorWorkerId: string | null;
  mentions: readonly string[];
  /** Strictly boolean `true` in the stored envelope; anything else is unstamped. */
  broadcastWakes: boolean;
  teamTagsVersion?: number;
  teamBroadcastWorkerIds?: readonly string[];
};

const BROADCAST = BROADCAST_MENTION_TOKENS as readonly string[];

/** Read a stored (plaintext or decrypted) envelope. Malformed fields read as absent. */
export function reachEnvelopeOf(data: unknown): ReachEnvelope {
  const e = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return {
    authorWorkerId: typeof e.authorWorkerId === 'string' ? e.authorWorkerId : null,
    mentions: Array.isArray(e.mentions) ? e.mentions.filter((v): v is string => typeof v === 'string') : [],
    broadcastWakes: e.broadcastWakes === true,
    ...(e.teamTagsVersion === 1 ? { teamTagsVersion: 1, teamBroadcastWorkerIds: Array.isArray(e.teamBroadcastWorkerIds) ? e.teamBroadcastWorkerIds.filter((v): v is string => typeof v === 'string') : [] } : {}),
  };
}

/**
 * How a message's mentions address a token set, ignoring authorship:
 * `'direct'` (one of `tokens`), `'broadcast'` (a stamped broadcast), or null.
 * The SQL twin is {@link mentionReachSql}.
 */
export function mentionReach(env: Pick<ReachEnvelope, 'mentions' | 'broadcastWakes' | 'teamTagsVersion' | 'teamBroadcastWorkerIds'>, tokens: readonly string[], workerIds: readonly string[] = []): 'direct' | 'broadcast' | null {
  if (env.mentions.some((t) => tokens.includes(t))) return 'direct';
  if (env.teamTagsVersion === 1 && env.teamBroadcastWorkerIds?.some(id => workerIds.includes(id))) return 'direct';
  if (env.broadcastWakes && env.mentions.some((t) => (env.teamTagsVersion === 1 ? t === 'all' : BROADCAST.includes(t)))) return 'broadcast';
  return null;
}

/**
 * Does the message reach a worker? Never its own post (`ownWorkerIds`: the
 * worker, or every Worker of an Agent-in-App attendee), else {@link mentionReach}.
 * A human's post (no `authorWorkerId`) is never anyone's own.
 */
export function reachesWorker(env: ReachEnvelope, ownWorkerIds: readonly string[], tokens: readonly string[]): boolean {
  if (env.authorWorkerId !== null && ownWorkerIds.includes(env.authorWorkerId)) return false;
  return mentionReach(env, tokens, ownWorkerIds) !== null;
}

/**
 * The SQL twin of {@link mentionReach} over a `data` jsonb expression and a
 * `text[]` token expression. The stamp is compared as jsonb (`= 'true'::jsonb`)
 * so a string `"true"` is unstamped, exactly as in JS. Authorship is the
 * caller's predicate, as each counting query already carries one.
 */
export function mentionReachSql(data: Prisma.Sql, tokens: Prisma.Sql, workerIds: Prisma.Sql = Prisma.sql`ARRAY[]::text[]`): Prisma.Sql {
  return Prisma.sql`(
    (jsonb_typeof(${data}->'mentions') = 'array' AND (
      (${data}->'mentions') ?| ${tokens}
      OR ((${data}->'broadcastWakes') = 'true'::jsonb AND (
        (${data}->'mentions') ? 'all'
        OR ((${data}->'teamTagsVersion') IS DISTINCT FROM '1'::jsonb AND (${data}->'mentions') ? 'team')
      ))
    ))
    OR ((${data}->'teamTagsVersion') = '1'::jsonb AND jsonb_typeof(${data}->'teamBroadcastWorkerIds') = 'array'
      AND (${data}->'teamBroadcastWorkerIds') ?| ${workerIds})
  )`;
}
