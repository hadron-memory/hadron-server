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
//
// v3 (#2072, Holger R53 / A′, cor:agt:080:04/:16) names NO channel range: acknowledging a wake that carried no message
// text moves no message mark, so the proof no longer says which seqs it covers. It carries the wake's identity instead
// (`wakeKey`, the reservation key computed at issue from the whole wake), so the acknowledgement still spends exactly
// the reservation of the wake it delivers. A v1/v2 proof keeps deriving its key from the channels it names; those
// channels are still validated (incarnation) but never written.

import { createHash, createHmac } from 'node:crypto';
import { GraphQLError } from 'graphql';
import { attentionTokenSecret } from '../teamAttention.js';
import { safeEqual } from '../constantTime.js';

export const WAKE_PROOF_VERSION = 3;
const ACCEPTED_VERSIONS: ReadonlySet<unknown> = new Set([1, 2, 3]);
export const WAKE_PROOF_MAX_AGE_MS = 15 * 60 * 1000;
/** The longest proof the verifier accepts; the issuer keeps every proof within it (#1708). */
export const MAX_PROOF_CHARS = 16_384;

export type WakeRequester = { userId: string } | { appKeyId: string };

export type WakeProof = {
  v: 1 | 2 | 3;
  kind: 'wake-proof';
  appId: string;
  workerId: string;
  requester: WakeRequester;
  /** v1/v2 only: the channel ranges the wake counted. Always empty from v3 (#2072): never a message mark. */
  channels: Array<{ channelId: string; incarnation: number; through: number }>;
  ticks: Array<{ tickerId: string; k: number }>;
  /** v2: the task events delivered, by event and alarm chain position (0 for an ordinary event). Empty for v1. */
  tasks: Array<{ eventId: string; chainIndex: number }>;
  /** Manager-authored mentions are exempt from the daily budget (cor:agt:080:15); decided when the wake is issued. */
  exempt: boolean;
  issuedAt: number;
  /** v3: the wake's reservation key (`wakeIdentity` of the whole wake, channels included), signed in. */
  wakeKey?: string;
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
  // v3 carries its identity and no channel range; a v3 proof naming a channel was not issued by this server.
  if (value.v === 3 && (typeof value.wakeKey !== 'string' || value.wakeKey.length === 0 || value.channels.length > 0)) return invalid();
  return value as WakeProof;
}

/** The reservation key a wake proof spends: signed in from v3, derived from the named channels and ticks before. */
export function proofWakeKey(p: WakeProof): string {
  return p.v === 3 ? p.wakeKey! : wakeIdentity(p);
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

// Batch proofs — #2017 (S1), cor:agt:080:17.
//
// A delivery batch's `id` is a signed proof of exactly what the batch rendered: per channel its incarnation, the
// range it covers (`from`..`through`, widened down past ineligible seqs) and the rendered seqs themselves. The key is
// domain-separated from both the wake proof's and the attention token's (K_batch = HMAC-SHA256(secret,
// "hadron-batch-proof-v1")), so none of the three verifies as another. `batchKey` is the batch's STABLE identity: the
// same eligible messages give the same key on every read while each read signs a fresh id. It authorizes nothing;
// only the signed id does.

export const BATCH_PROOF_VERSION = 1;
/** The most rendered seqs one batch carries, across all its channels (renderBatch's message cap). */
export const BATCH_PROOF_MAX_SEQS = 10;

/**
 * Who a batch is issued to: a host's App key (cor:agt:080:22's host arm), or a worker's own live session (R57's self
 * arm, which has no host). Exactly one; a proof issued to one never acknowledges as the other, nor as another session.
 */
export type BatchRequester = { appKeyId: string } | { sessionId: string };

export type BatchProofChannel = {
  channelId: string;
  incarnation: number;
  /** The first seq the batch covers: the seq after the worker's delivered mark when it was issued. */
  from: number;
  /** The last RENDERED seq of this channel; an ack never moves the mark past it. */
  through: number;
  /** Exactly the seqs rendered, ascending; a partial ack may stop only at one of them. */
  seqs: number[];
};

export type BatchProof = {
  v: 1;
  kind: 'batch-proof';
  appId: string;
  workerId: string;
  /** The host of a host-key batch; null exactly when the requester is a session (the self arm has no host). */
  hostId: string | null;
  requester: BatchRequester;
  channels: BatchProofChannel[];
  /** SHA-256 (hex) of the rendered text. */
  renderHash: string;
  batchKey: string;
  issuedAt: number;
};

function batchProofKey(): Buffer {
  return createHmac('sha256', attentionTokenSecret()).update('hadron-batch-proof-v1').digest();
}

/** The batch's stable identity: worker, each channel's incarnation, range and rendered seqs, and the rendered text. */
export function batchKeyOf(p: Pick<BatchProof, 'workerId' | 'channels' | 'renderHash'>): string {
  const channels = [...p.channels]
    .sort((a, b) => a.channelId.localeCompare(b.channelId))
    .map((c) => [c.channelId, c.incarnation, c.from, c.through, c.seqs]);
  return createHash('sha256').update(JSON.stringify([p.workerId, channels, p.renderHash])).digest('hex').slice(0, 32);
}

export function signBatchProof(proof: BatchProof): string {
  const body = Buffer.from(JSON.stringify(proof)).toString('base64url');
  return `${body}.${createHmac('sha256', batchProofKey()).update(body).digest('base64url')}`;
}

const isSeq = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1;

/** Is this a range the loader could have issued? Seqs ascending inside from..through, ending at through. */
function wellFormedChannel(c: Partial<BatchProofChannel> | null | undefined): boolean {
  if (!c || typeof c.channelId !== 'string' || !Number.isInteger(c.incarnation) || !isSeq(c.from) || !isSeq(c.through)) return false;
  const seqs = c.seqs;
  if (!Array.isArray(seqs) || seqs.length === 0 || !seqs.every(isSeq)) return false;
  for (let i = 1; i < seqs.length; i++) if (seqs[i]! <= seqs[i - 1]!) return false;
  return c.from <= seqs[0]! && seqs[seqs.length - 1] === c.through;
}

const principal = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Exactly one principal, paired with its host: an App key with a host id, a session with none. */
function wellPairedRequester(r: unknown, hostId: unknown): boolean {
  if (!r || typeof r !== 'object') return false;
  const { appKeyId, sessionId, ...rest } = r as { appKeyId?: unknown; sessionId?: unknown };
  if (Object.keys(rest).length > 0) return false;
  if (appKeyId !== undefined && sessionId === undefined) return principal(appKeyId) && principal(hostId);
  if (sessionId !== undefined && appKeyId === undefined) return principal(sessionId) && hostId === null;
  return false;
}

/** Is `who` the principal the batch was issued to? Same arm and same principal, never across arms. */
export function sameBatchRequester(proof: BatchProof, who: BatchRequester): boolean {
  const r = proof.requester;
  if ('appKeyId' in r && 'appKeyId' in who) return r.appKeyId === who.appKeyId;
  if ('sessionId' in r && 'sessionId' in who) return r.sessionId === who.sessionId;
  return false;
}

/** The proof's payload, or WAKE_PROOF_INVALID. Signature first, then kind and version, then shape and batchKey. */
export function verifyBatchProof(token: unknown): BatchProof {
  const invalid = () => refuse('WAKE_PROOF_INVALID', 'Not a valid delivery batch id.');
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_PROOF_CHARS) return invalid();
  const parts = token.split('.');
  if (parts.length !== 2) return invalid();
  const [body, supplied] = parts as [string, string];
  const expected = createHmac('sha256', batchProofKey()).update(body).digest('base64url');
  if (!safeEqual(supplied, expected)) return invalid();
  let value: Partial<BatchProof>;
  try {
    value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<BatchProof>;
  } catch {
    return invalid();
  }
  if (value.kind !== 'batch-proof' || value.v !== BATCH_PROOF_VERSION) return invalid();
  const channels = value.channels;
  if (
    typeof value.appId !== 'string' || typeof value.workerId !== 'string' ||
    typeof value.issuedAt !== 'number' || !wellPairedRequester(value.requester, value.hostId) ||
    typeof value.renderHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.renderHash) ||
    typeof value.batchKey !== 'string' ||
    !Array.isArray(channels) || channels.length === 0 || !channels.every(wellFormedChannel) ||
    new Set(channels.map((c) => c.channelId)).size !== channels.length ||
    channels.reduce((n, c) => n + c.seqs.length, 0) > BATCH_PROOF_MAX_SEQS
  ) return invalid();
  if (value.batchKey !== batchKeyOf(value as BatchProof)) return invalid();
  return value as BatchProof;
}
