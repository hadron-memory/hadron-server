// Wake proofs — #1748, cor:agt:080:16/:17 (plan §4.3, Rook's R4).
//
// A due wake carries a server-signed proof; the router delivers the nudge and
// then hands the proof back to `acknowledgeWakes`. The key is DOMAIN-SEPARATED
// from the attention token's (K_wake = HMAC-SHA256(secret, "hadron-wake-proof-v1")),
// so an attention token cannot verify as a proof, nor the reverse. The
// requester is bound in: only that principal may acknowledge. Freshness (15
// minutes) and the channel incarnation are checked by the acknowledger, which
// has the database.
//
// v2 (#1708, Task Management T5) adds `tasks`: the task events the wake
// delivers, acknowledged per (event, worker, chain position). A v1 proof (no
// `tasks`) still verifies, read as delivering none, so a proof issued before
// the deploy can still be acknowledged inside its 15 minutes.

import { createHash, createHmac } from 'node:crypto';
import { GraphQLError } from 'graphql';
import { attentionTokenSecret } from '../teamAttention.js';
import { safeEqual } from '../constantTime.js';

export const WAKE_PROOF_VERSION = 2;
const ACCEPTED_VERSIONS: ReadonlySet<unknown> = new Set([1, 2]);
export const WAKE_PROOF_MAX_AGE_MS = 15 * 60 * 1000;
const MAX_PROOF_CHARS = 16_384;

export type WakeRequester = { userId: string } | { appKeyId: string };

export type WakeProof = {
  v: 1 | 2;
  kind: 'wake-proof';
  appId: string;
  workerId: string;
  requester: WakeRequester;
  channels: Array<{ channelId: string; incarnation: number; through: number }>;
  ticks: Array<{ tickerId: string; k: number }>;
  /** v2: the task events delivered, by event and alarm chain position (0 for an ordinary event). Empty for v1. */
  tasks: Array<{ eventId: string; chainIndex: number }>;
  /** Manager-authored mentions are exempt from the daily budget (cor:agt:080:15); decided when the wake is issued. */
  exempt: boolean;
  issuedAt: number;
};

const refuse = (code: string, message: string): never => {
  throw new GraphQLError(message, { extensions: { code } });
};

function wakeKey(): Buffer {
  return createHmac('sha256', attentionTokenSecret()).update('hadron-wake-proof-v1').digest();
}

export function signWakeProof(proof: WakeProof): string {
  const body = Buffer.from(JSON.stringify(proof)).toString('base64url');
  return `${body}.${createHmac('sha256', wakeKey()).update(body).digest('base64url')}`;
}

/** The proof's payload, or WAKE_PROOF_INVALID. Signature first, then shape, then version. */
export function verifyWakeProof(token: unknown): WakeProof {
  const invalid = () => refuse('WAKE_PROOF_INVALID', 'Not a valid wake proof.');
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_PROOF_CHARS) return invalid();
  const parts = token.split('.');
  if (parts.length !== 2) return invalid();
  const [body, supplied] = parts as [string, string];
  const expected = createHmac('sha256', wakeKey()).update(body).digest('base64url');
  if (!safeEqual(supplied, expected)) return invalid();
  let value: Partial<WakeProof>;
  try {
    value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<WakeProof>;
  } catch {
    return invalid();
  }
  if (value.kind !== 'wake-proof') return invalid();
  // An unknown version is refused, not guessed at.
  if (!ACCEPTED_VERSIONS.has(value.v)) return invalid();
  if (value.v === 1) value.tasks = [];
  const r = value.requester as { userId?: unknown; appKeyId?: unknown } | undefined;
  if (
    typeof value.appId !== 'string' || typeof value.workerId !== 'string' ||
    typeof value.issuedAt !== 'number' || typeof value.exempt !== 'boolean' ||
    !Array.isArray(value.channels) || !Array.isArray(value.ticks) ||
    !Array.isArray(value.tasks) ||
    !value.tasks.every((t) => t && typeof t.eventId === 'string' && Number.isInteger(t.chainIndex) && t.chainIndex >= 0) ||
    !r || (typeof r.userId !== 'string' && typeof r.appKeyId !== 'string')
  ) return invalid();
  return value as WakeProof;
}

/** Is `who` the principal the proof was issued to? */
export function sameRequester(proof: WakeProof, who: WakeRequester): boolean {
  const r = proof.requester;
  if ('userId' in r && 'userId' in who) return r.userId === who.userId;
  if ('appKeyId' in r && 'appKeyId' in who) return r.appKeyId === who.appKeyId;
  return false;
}

/**
 * Which wake a proof is for: its channels (id, incarnation, delivered-through seq) and ticks (ticker, tick), hashed.
 * Two reads of an unchanged wake share a key; a wake with newer messages or a later tick has another. A budget
 * reservation carries it, so an acknowledgement spends exactly the reservation of the wake it delivers.
 */
export function wakeIdentity(p: Pick<WakeProof, 'channels' | 'ticks'> & { tasks?: WakeProof['tasks'] }): string {
  const parts: unknown[] = [
    [...p.channels].map((c) => [c.channelId, c.incarnation, c.through]).sort(),
    [...p.ticks].map((t) => [t.tickerId, t.k]).sort(),
  ];
  // Only when present, so a wake with no task in it keeps the key it had under v1 (a reservation made just before
  // the deploy still matches its acknowledgement).
  if (p.tasks && p.tasks.length > 0) parts.push([...p.tasks].map((t) => [t.eventId, t.chainIndex]).sort());
  const canon = JSON.stringify(parts);
  return createHash('sha256').update(canon).digest('hex').slice(0, 32);
}
