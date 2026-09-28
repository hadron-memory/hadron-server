/**
 * #1384/#1421 — the paged (v2) team-attention scan. The v1 poll decrypts an
 * encrypted Channel's whole unread backlog inside one request; with the pilot
 * gate removed that is unbounded work reachable by every participant. This
 * module implements the reviewed pagination contract (Andi #2977, reconciled
 * Dan #2984, dispatched Ada #2988): every response performs a BOUNDED amount
 * of decryption and returns a signed continuation carrying the scan's private
 * progress; only the final page (all Channels exhausted, all queued results
 * delivered) yields an adoptable head snapshot. Nothing here advances
 * `ChannelReadState` — the old v1 `since` token remains the committed
 * watermark throughout, and any failure or drift restarts from it, so retries
 * may duplicate a nudge but can never lose one.
 *
 * Continuation encoding follows the measured transport contract: compact
 * single-letter fields, ID dictionaries + parallel arrays, accumulators for
 * EVERY unfinished target (a partially scanned Channel can hold nonzero
 * partial counts — dropping them would lose earlier matches on resume), and a
 * sign-time actual-length check against the existing `MAX_TOKEN_CHARS`
 * transport ceiling. Interior edits to already-scanned historical envelopes
 * are an accepted, documented correctness limitation (exact-for-captured-
 * range-as-scanned); the boundary row of each active Channel is re-checked
 * per pull so deletion of the scan frontier is detected and restarts.
 */
import { createHmac } from 'node:crypto';
import { GraphQLError } from 'graphql';
import type { Context } from '../api/graphql/schema/resolvers.js';

export const PAGED_ATTENTION_CAPABILITY = 'team-attention-paged';

/** Per-request budgets (contract defaults; the caps are hard ceilings). */
export const PAGE_SCAN_ROW_BUDGET_DEFAULT = 50;
export const PAGE_SCAN_ROW_BUDGET_MAX = 100;
export const PAGE_RESULT_PAIRS_DEFAULT = 50;
export const PAGE_RESULT_PAIRS_MAX = 100;

export const MAX_PAGE_TOKEN_CHARS = 65_536;

function fail(message: string, code: string): never {
  throw new GraphQLError(message, { extensions: { code } });
}

// ── continuation payload ──────────────────────────────────────────────────────

/**
 * Compact v2 continuation. IDs live in dictionaries (`W` workers, `C`
 * channels); everything target- or channel-shaped is a parallel array over
 * those. `u_*` arrays are the per-target partial accumulators — private scan
 * progress, NEVER surfaced as exact results until the target's Channel is
 * done and the item is emitted.
 */
export interface PageContinuation {
  v: 2;
  kind: 'team-attention-page';
  op: 'poll' | 'preview';
  appId: string;
  userId: string;
  /** Frozen scope, ISO — the instant page 1 captured targets/heads. */
  ts: number;
  /** Worker ID dictionary (index → id). */
  W: string[];
  /** Channel ID dictionary (index → id). */
  C: string[];
  /** Register ID dictionary (index → id) — register identity travels in the
   * token so a deleted/recreated register with the same worker+channel+
   * mentionOnly shape cannot masquerade as the frozen target (#3054 repro 5). */
  R: string[];
  /** Frozen targets, parallel arrays by target index. */
  t_w: number[]; // worker index
  t_c: number[]; // channel index
  t_r: number[]; // register index — identity, matched exactly on resume
  t_mo: number[]; // mentionOnly 0/1
  t_seen: number[]; // frozen seen (read cursor at freeze)
  t_head: number[]; // frozen channel head at freeze
  /** Relevance floor per target: the prior `since` head this scan started
   * from (0 when none) — carried so a resumed page keeps emitting against
   * the ORIGINAL watermark instead of re-nudging pre-watermark backlog
   * (#3051 finding 6 / Chip repro 2). */
  t_prior: number[];
  /** Per-channel scan state, parallel arrays by channel index. `c_done` is a
   * hex bitset (channel index → bit), sized to the channel dictionary. */
  c_done: string;
  /** Keyset cursor: the last consumed row's loc SUFFIX — the part after the
   * channel's `{loc}:messages:` prefix, which rehydration reconstructs from
   * live geometry. Storing the suffix (typically 1-7 chars) instead of the
   * full loc keeps the 200-target continuation within the transport ceiling
   * when channels carry long addresses (#3123 liveness blocker). '' = not
   * started. The reconstructed full loc drives the `loc > cursor` keyset.
   * EXAMINED WORK IS NOT HARD-BOUNDED (#1430): a collated text index can
   * pass foreign/residual rows before LIMIT; only returned rows are
   * budget-bounded. Suffix length is observational, not a guaranteed
   * transport bound — legacy nonnumeric suffixes store verbatim. */
  c_num: string[];
  /** Channel.incarnation at freeze, per channel index — compared on EVERY
   * resume (unstarted and done channels included). A same-address
   * deleteChannel + ensureChannelWithRoot reuses the Channel/register IDs and
   * only increments incarnation, so identity alone cannot detect the
   * lifecycle change (#3111). */
  c_inc: number[];
  c_min: number[]; // frozen span min(seen) across its targets
  c_max: number[]; // frozen span max(head)
  /** Per-target private partial accumulators (0 / null = untouched). */
  u_unread: number[];
  u_ment: number[];
  u_first: number[]; // 0 = none
  u_last: number[]; // 0 = none
  /** Emission state: hex bitset of targets already emitted, pending queue in
   * completion-visit order, and the round-robin scheduler position. */
  e_emitted: string;
  q: number[]; // target indices awaiting delivery
  next: number; // next channel index to visit (round-robin)
  /** HMAC over the frozen scope dictionary contents; re-derived every pull. */
  dg: string;
}

function pageSigningKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('hadron/team-attention/v2').digest();
}

/**
 * Sign a continuation. The length check is on the ACTUAL encoded artifact —
 * estimates cannot prove the transport bound (#2977). On overflow the caller
 * must answer a typed refusal and leave the caller's prior `since` untouched;
 * the continuation is simply not issued.
 */
export function signPageToken(
  payload: PageContinuation,
  secret: string,
): { token: string } | { tooLarge: true; actualChars: number } {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', pageSigningKey(secret)).update(body).digest('base64url');
  const token = `${body}.${signature}`;
  if (token.length > MAX_PAGE_TOKEN_CHARS) return { tooLarge: true, actualChars: token.length };
  return { token };
}

export function verifyPageToken(
  token: string,
  secret: string,
): PageContinuation {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_PAGE_TOKEN_CHARS) {
    fail('Invalid team-attention page token.', 'INVALID_ATTENTION_PAGE');
  }
  const parts = token.split('.');
  if (parts.length !== 2) fail('Invalid team-attention page token.', 'INVALID_ATTENTION_PAGE');
  const [body, supplied] = parts;
  const expected = createHmac('sha256', pageSigningKey(secret)).update(body).digest('base64url');
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !a.equals(b)) fail('Invalid team-attention page token.', 'INVALID_ATTENTION_PAGE');
  let value: Partial<PageContinuation>;
  try {
    value = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as Partial<PageContinuation>;
  } catch {
    fail('Invalid team-attention page token.', 'INVALID_ATTENTION_PAGE');
  }
  if (
    value.v !== 2 ||
    value.kind !== 'team-attention-page' ||
    (value.op !== 'poll' && value.op !== 'preview') ||
    typeof value.appId !== 'string' ||
    typeof value.userId !== 'string' ||
    !Array.isArray(value.W) || !Array.isArray(value.C) || !Array.isArray(value.R) ||
    !Array.isArray(value.c_inc) ||
    !Array.isArray(value.t_w) || !Array.isArray(value.t_c)
  ) {
    fail('Invalid team-attention page token.', 'INVALID_ATTENTION_PAGE');
  }
  return value as PageContinuation;
}

/** The scope digest binds the dictionaries so a pull can detect a token cut
 * against a different freeze than the live scope it rehydrates from. */
export function scopeDigest(payload: Omit<PageContinuation, 'dg'>, secret: string): string {
  const hmac = createHmac('sha256', pageSigningKey(secret));
  hmac.update(payload.W.join('\u0000'));
  hmac.update('\u0001');
  hmac.update(payload.C.join('\u0000'));
  return hmac.digest('base64url').slice(0, 32);
}

/**
 * Mask helpers over hex-string bitsets (a JS number bitmask caps at 31 bits;
 * the contract needs 200). Index 0 is the LOWEST bit of the LAST hex char, so
 * appending targets/channels only ever appends chars — stable across pulls.
 */
export function maskGet(mask: string, i: number): boolean {
  const char = mask.charCodeAt(mask.length - 1 - Math.floor(i / 4)) ?? 48;
  return ((char - 48) & (1 << (i % 4))) !== 0;
}
export function maskSet(mask: string, i: number): string {
  // Pad FIRST, then set the bit at the post-padding index — computing the
  // index before padding returned the string without setting the bit
  // whenever the target bit opened a new nibble (review #3051 finding 3:
  // maskSet('', 0) yielded '0', losing indices 0, 4, 8, …).
  const need = Math.floor(i / 4) + 1;
  const chars = mask.padStart(need, '0').split('');
  const idx = chars.length - 1 - Math.floor(i / 4);
  chars[idx] = String.fromCharCode(((chars[idx].charCodeAt(0) - 48) | (1 << (i % 4))) + 48);
  return chars.join('');
}
export function maskEmpty(): string {
  return '';
}
