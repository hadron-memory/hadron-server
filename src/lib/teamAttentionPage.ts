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
export const PAGE_RESULT_PAIRS_DEFAULT = 20;
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
  /** Scan-era marker: 's' = seq-first Channel-local order (the structural
   * #3248 design). The prior era minted 'c' (C-collation loc order, cursor
   * in c_num/c_ful); an authentic signed token of that era — or any marker
   * this build did not mint — is refused with a TYPED restart, never
   * reinterpreted: its cursor fields mean something else (#3281). */
  o: 's';
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
  /** Seq-first keyset cursor per channel: the last consumed row's seq. */
  c_seq: number[];
  /** Seq-first keyset cursor per channel: the last consumed row's loc suffix
   * (the tiebreak in the (seq, loc) keyset for duplicate-seq rows). */
  c_loc: string[];
  /** Last COUNTED-message suffix per channel (empty until one was counted) —
   * the stale-frontier check row. Independent of the raw cursor: the raw
   * cursor may sit on a residual-rejected row (#1430 decoupling). */
  c_front: string[];
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
  // Structural validation in two tiers (#3166/#3170/#3171 classification,
  // carried to the seq-first era per #3281):
  //
  // 1. The era-INDEPENDENT v2 core — dictionaries, target arrays, queue,
  //    scalars — every era's minted token carries these with consistent
  //    parallel lengths and in-bounds indices. A signed payload that fails
  //    the core is malformed: INVALID, not an old era.
  // 2. The era-specific channel arrays. The current era ('s') carries
  //    c_seq/c_loc/c_front; the prior loc-ordered era ('c' or no marker)
  //    carried c_num/c_ful/c_front instead. Only a token whose OWN era's
  //    arrays are all present is classified as an authentic prior-era
  //    continuation — answered with the TYPED stale-page restart so the
  //    router discards only `page` and retries from its unchanged committed
  //    `since`. A marker this build never minted, or a mixture of eras'
  //    arrays, is malformed.
  const targetArrays = ['t_w', 't_c', 't_r', 't_mo', 't_seen', 't_head', 't_prior', 'u_unread', 'u_ment', 'u_first', 'u_last'] as const;
  const seqEraChannelArrays = ['c_inc', 'c_min', 'c_max', 'c_loc', 'c_front', 'c_seq'] as const;
  const coreArraysValid =
    Array.isArray(value.W) && Array.isArray(value.C) && Array.isArray(value.R) &&
    targetArrays.every((key) => Array.isArray((value as Record<string, unknown>)[key]));
  const parallelValid = coreArraysValid && targetArrays.every((key) =>
    ((value as Record<string, unknown>)[key] as unknown[]).length === (value.t_w as number[]).length);
  const queueValid = parallelValid &&
    Array.isArray(value.q) && (value.q as number[]).every((ti) =>
      Number.isInteger(ti) && ti >= 0 && ti < (value.t_w as number[]).length);
  const scalarValid = queueValid &&
    typeof value.c_done === 'string' && typeof value.e_emitted === 'string' &&
    typeof value.dg === 'string' && typeof value.next === 'number' &&
    typeof value.ts === 'number';
  const indicesValid = scalarValid &&
    (value.t_w as number[]).every((w, i) => {
      const tc = (value.t_c as number[])[i];
      const tr = (value.t_r as number[])[i];
      return Number.isInteger(w) && w >= 0 && w < (value.W as string[]).length &&
        Number.isInteger(tc) && tc >= 0 && tc < (value.C as string[]).length &&
        Number.isInteger(tr) && tr >= 0 && tr < (value.R as string[]).length;
    });
  const coreValid =
    value.v === 2 &&
    value.kind === 'team-attention-page' &&
    (value.op === 'poll' || value.op === 'preview') &&
    typeof value.appId === 'string' &&
    typeof value.userId === 'string' &&
    parallelValid && scalarValid && indicesValid;
  if (!coreValid) {
    fail('Invalid team-attention page token.', 'INVALID_ATTENTION_PAGE');
  }
  const field = (key: string) => (value as Record<string, unknown>)[key];
  const channelArraysOf = (keys: readonly string[]) =>
    keys.every((key) => Array.isArray(field(key))) &&
    keys.every((key) => (field(key) as unknown[]).length === (value.C as string[]).length);
  if (value.o === 's') {
    // Current era: the full seq-first channel state must be present, and NO
    // prior-era arrays may ride along — no minted token carried both, so a
    // `c_num`/`c_ful` under the current marker is mixed-era, not current
    // (Chip #3341: an 's' token with valid c_seq/c_loc plus prior c_num was
    // accepted here).
    if (!channelArraysOf(seqEraChannelArrays)
      || field('c_num') !== undefined || field('c_ful') !== undefined) {
      fail('Invalid team-attention page token.', 'INVALID_ATTENTION_PAGE');
    }
    return value as PageContinuation;
  }
  // Prior eras — the three shapes this branch's history actually minted
  // (#3299/#3301; verified against 70ed1328, b6faa1b7, 30a9f261):
  //   pre-C  (70ed1328): NO marker, cursor in c_num only.
  //   early C (b6faa1b7): o:'c', c_num + c_front (c_ful not yet).
  //   late C  (30a9f261): o:'c', c_num + c_front + c_ful.
  // Each authentic form restarts TYPED. A payload mixing eras' arrays
  // (current arrays under a prior marker, or c_ful on a marker-less token)
  // is malformed: no minted token ever looked like that.
  const commonPrior = ['c_inc', 'c_min', 'c_max', 'c_num'] as const;
  // PRESENCE, not type: no minted token of any era carried another era's
  // fields in ANY form — a scalar c_seq/c_num is as unminted as an array one
  // (Chip #3566 / Atilla #3570: the Array.isArray guards accepted
  // `c_num:'007'` under the current marker).
  const lacksCurrentArrays = field('c_seq') === undefined && field('c_loc') === undefined;
  const staleRestart = (): never =>
    fail('This scan continuation predates the current scan era; poll again without page to restart from your committed watermark.', 'TEAM_ATTENTION_STALE_PAGE');
  if (value.o === undefined) {
    if (channelArraysOf(commonPrior) && lacksCurrentArrays
      && field('c_front') === undefined && field('c_ful') === undefined) {
      staleRestart();
    }
    fail('Invalid team-attention page token.', 'INVALID_ATTENTION_PAGE');
  }
  if (value.o === 'c') {
    // c_ful is era-shape evidence: absent = early C (b6faa1b7), a
    // channel-parallel array = late C (30a9f261). Anything else — a scalar,
    // a wrong-length array — is a shape no era minted and is malformed
    // rather than prior-era (Chip #3341).
    const ful = field('c_ful');
    const fulWellFormed = ful === undefined
      || (Array.isArray(ful) && ful.length === (value.C as string[]).length);
    if (channelArraysOf([...commonPrior, 'c_front']) && lacksCurrentArrays && fulWellFormed) {
      staleRestart();
    }
    fail('Invalid team-attention page token.', 'INVALID_ATTENTION_PAGE');
  }
  // A marker no era of this codec minted, on an otherwise core-valid signed
  // token: a continuation from some other build of this codec (a newer
  // deployment rolled back). Restart typed — INVALID would misdescribe a
  // well-signed continuation, and the restart is lossless. Current arrays
  // under a foreign marker stay malformed.
  if (lacksCurrentArrays) staleRestart();
  fail('Invalid team-attention page token.', 'INVALID_ATTENTION_PAGE');
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
