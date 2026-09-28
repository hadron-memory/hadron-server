/**
 * #1353 — worker-owned team-chat attention for the internal router pilot.
 *
 * The poll token is a signed, actor/App-bound snapshot. It NEVER advances
 * ChannelReadState. A router adopts the returned token only after every
 * listed nudge has been accepted; retaining the previous token after a
 * partial failure deliberately causes duplicates rather than loss.
 *
 * The feature is dark unless BOTH the operator and App are explicitly
 * allowlisted. This matters for `maybeAdvanceOwnChannelRead`: outside the
 * pilot an ordinary transcript read is byte-for-byte the old read-only act.
 */

import { createHmac } from 'node:crypto';
import { GraphQLError } from 'graphql';
import { Prisma, type PrismaClient } from '../generated/prisma/index.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import { isAppParticipant } from '../api/graphql/schema/resolvers.helpers.js';
import { resolveAppRef } from './entityRef/appRef.js';
import { AppNotFoundError } from './entityRef/errors.js';
import { resolveChannelRefId } from './entityRef/channelRef.js';
import { composeWorkerUrn } from './entityRef/workerRef.js';
import { normalizeUrnForLookup } from './urn.js';
import { resolveRegister } from './resolveRegister.js';
import { advanceReadState } from './channelReadState.js';
import { BROADCAST_MENTION_TOKENS, mentionTokenOf } from './mentionToken.js';
import { escapePrismaLikePattern } from './literalLocPrefix.js';
import { safeEqual } from './constantTime.js';
import { decryptNodeFields } from './nodeCrypto.js';
import {
  maskEmpty, maskGet, maskSet, scopeDigest, signPageToken, verifyPageToken,
  MAX_PAGE_TOKEN_CHARS, PAGE_RESULT_PAIRS_DEFAULT, PAGE_RESULT_PAIRS_MAX,
  PAGE_SCAN_ROW_BUDGET_DEFAULT, PAGE_SCAN_ROW_BUDGET_MAX,
  type PageContinuation,
} from './teamAttentionPage.js';
import {
  isSessionLive,
  loadLastEventBySession,
  OPEN_SESSION_SCAN_CAP,
  recentlyTouchedFilter,
} from './sessionActivity.js';

const MAX_WORKERS = 20;
const MAX_TARGETS = 200;
const MAX_TOKEN_CHARS = 65_536;
const SWITCHOVER_PROOF_TTL_MS = 10 * 60 * 1000;
const ENCRYPTED_MESSAGE_PAGE_SIZE = 50;

type AppRow = {
  id: string;
  urn: string;
  organizationId: string | null;
  ownerUserId: string | null;
  defaultChannelId: string | null;
};

type LiveWorker = {
  id: string;
  name: string;
  urn: string | null;
};

type Target = {
  workerId: string;
  workerName: string;
  workerUrn: string | null;
  channelId: string;
  channelName: string;
  channelLoc: string;
  memoryId: string;
  registerId: string;
  mentionOnly: boolean;
  seen: number;
  head: number;
  mentionTokens: string[];
};

type AttentionSnapshot = {
  v: 1;
  kind: 'team-attention';
  appId: string;
  userId: string;
  workers: Array<{
    workerId: string;
    channels: Array<{
      channelId: string;
      registerId: string;
      mentionOnly: boolean;
      head: number;
    }>;
  }>;
};

type SwitchoverProof = {
  v: 1;
  kind: 'team-attention-switchover';
  appId: string;
  userId: string;
  issuedAt: number;
  expiresAt: number;
  targets: Array<{
    workerId: string;
    channelId: string;
    registerId: string;
    mentionOnly: boolean;
    from: number;
    through: number;
  }>;
};

type SignedPayload = AttentionSnapshot | SwitchoverProof;

export type TeamAttentionChannel = {
  channel: string;
  name: string;
  unread: number;
  unreadMentions: number;
  firstUnreadSeq: number | null;
  lastSeq: number;
};

export type TeamAttentionWorker = {
  worker: string;
  name: string;
  urn: string | null;
  live: true;
  channels: TeamAttentionChannel[];
};

export type TeamAttentionResult = {
  token: string;
  workers: TeamAttentionWorker[];
};

export type TeamAttentionSwitchoverWorker = {
  worker: string;
  name: string;
  urn: string | null;
  channels: Array<{
    channel: string;
    name: string;
    fromSeq: number;
    throughSeq: number;
    unread: number;
    unreadMentions: number;
  }>;
};

export type TeamAttentionSwitchoverPreview = {
  proof: string;
  expiresAt: Date;
  workers: TeamAttentionSwitchoverWorker[];
};

function fail(message: string, code: string, extra: Record<string, unknown> = {}): never {
  throw new GraphQLError(message, { extensions: { code, ...extra } });
}

function idSet(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  );
}

/** Exact, two-dimensional pilot gate. Unset means off. */
export function teamAttentionPilotEnabled(userId: string | undefined, appId: string): boolean {
  return teamAttentionPilotOperatorEnabled(userId) && idSet('TEAM_ATTENTION_PILOT_APP_IDS').has(appId);
}

/** Cheap first dimension for avoiding pilot-only lookups on ordinary reads. */
export function teamAttentionPilotOperatorEnabled(userId: string | undefined): boolean {
  return !!userId && idSet('TEAM_ATTENTION_PILOT_USER_IDS').has(userId);
}

function tokenSigningKey(): Buffer {
  const secret = process.env.TEAM_ATTENTION_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!secret) fail('The team-attention token signer is not configured.', 'TEAM_ATTENTION_NOT_CONFIGURED');
  // A deployment may intentionally fall back to JWT_SECRET, but tokens in
  // this protocol must not share the JWT signing domain. The derived key also
  // gives future team-attention formats an explicit version boundary.
  return createHmac('sha256', secret).update('hadron/team-attention/v1').digest();
}

/** The raw secret behind `tokenSigningKey`, for the v2 paged-attention codec
 * (its own HMAC domain derivation lives in teamAttentionPage.ts). */
export function attentionTokenSecret(): string {
  const secret = process.env.TEAM_ATTENTION_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!secret) fail('The team-attention token signer is not configured.', 'TEAM_ATTENTION_NOT_CONFIGURED');
  return secret;
}

function sign(payload: SignedPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', tokenSigningKey()).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verify(token: string): SignedPayload {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_CHARS) {
    fail('Invalid team-attention token.', 'INVALID_ATTENTION_TOKEN');
  }
  const parts = token.split('.');
  if (parts.length !== 2) fail('Invalid team-attention token.', 'INVALID_ATTENTION_TOKEN');
  const [body, supplied] = parts;
  const expected = createHmac('sha256', tokenSigningKey()).update(body).digest('base64url');
  if (!safeEqual(supplied, expected)) fail('Invalid team-attention token.', 'INVALID_ATTENTION_TOKEN');
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<SignedPayload>;
    if (
      value.v !== 1 ||
      (value.kind !== 'team-attention' && value.kind !== 'team-attention-switchover') ||
      typeof value.appId !== 'string' ||
      typeof value.userId !== 'string'
    ) fail('Invalid team-attention token.', 'INVALID_ATTENTION_TOKEN');
    return value as SignedPayload;
  } catch (error) {
    if (error instanceof GraphQLError) throw error;
    fail('Invalid team-attention token.', 'INVALID_ATTENTION_TOKEN');
  }
}

/**
 * A LIVE App: not deleted, not uninstalled, and — when org-owned — in an org
 * that is not soft-deleted. `softDeleteOrganizationCore` stamps only the org
 * and keeps its membership rows, so the App row and `isAppParticipant` alone
 * would go on admitting a deleted org's former participants (#1362 review).
 */
const LIVE_APP_WHERE: Prisma.AppWhereInput = {
  deletedAt: null,
  uninstalledAt: null,
  OR: [{ organizationId: null }, { organization: { deletedAt: null } }],
};

async function resolvePilotApp(ctx: Context, appRef: string): Promise<AppRow> {
  if (!ctx.userId || ctx.impersonation) fail('Team attention is available only to an ordinary user.', 'FORBIDDEN');
  let id: string;
  try {
    ({ id } = await resolveAppRef(ctx.db, appRef));
  } catch (error) {
    if (error instanceof AppNotFoundError) fail('App not found.', 'APP_NOT_FOUND');
    throw error;
  }
  const app = await ctx.db.app.findFirst({
    where: { id, ...LIVE_APP_WHERE },
    select: { id: true, urn: true, organizationId: true, ownerUserId: true, defaultChannelId: true },
  });
  // Existing-but-unreadable and absent Apps are indistinguishable. This is a
  // public GraphQL door even while MCP discovery hides the pilot tools.
  if (!app || !(await isAppParticipant(ctx, app))) fail('App not found.', 'APP_NOT_FOUND');
  if (!teamAttentionPilotEnabled(ctx.userId, app.id)) {
    fail('Team attention is not enabled for this operator and App.', 'FEATURE_NOT_AVAILABLE');
  }
  return app;
}

/**
 * Whether `resolvePilotApp` would admit this caller and App — the SAME checks,
 * as a boolean, for the capability probe (#1362 review, Codex P2). Probing on
 * the env allowlists alone advertised `team-attention` for an App that had
 * since been uninstalled, deleted or left, and every tool then answered
 * APP_NOT_FOUND.
 */
export async function teamAttentionAvailable(ctx: Context, appId: string): Promise<boolean> {
  if (!ctx.userId || ctx.impersonation || !teamAttentionPilotEnabled(ctx.userId, appId)) return false;
  const app = await ctx.db.app.findFirst({
    where: { id: appId, ...LIVE_APP_WHERE },
    select: { id: true, organizationId: true, ownerUserId: true },
  });
  return !!app && (await isAppParticipant(ctx, app));
}

async function liveOwnWorkers(ctx: Context, app: AppRow): Promise<LiveWorker[]> {
  const now = new Date();
  const rows = await ctx.db.session.findMany({
    where: {
      userId: ctx.userId!,
      appId: app.id,
      workerId: { not: null },
      endedAt: null,
      deletedAt: null,
      worker: { appId: app.id, retiredAt: null },
      ...recentlyTouchedFilter(now),
    },
    orderBy: [{ updatedAt: { sort: 'desc', nulls: 'last' } }, { startedAt: 'desc' }],
    select: {
      id: true,
      type: true,
      startedAt: true,
      updatedAt: true,
      autoExpiredAt: true,
      endedAt: true,
      worker: { select: { id: true, name: true, slug: true } },
    },
    take: OPEN_SESSION_SCAN_CAP + 1,
  });
  if (rows.length > OPEN_SESSION_SCAN_CAP) {
    fail(`More than ${OPEN_SESSION_SCAN_CAP} recent Worker sessions match.`, 'TEAM_ATTENTION_SCOPE_TOO_LARGE');
  }
  const events = await loadLastEventBySession(ctx.db as never, rows.map((r) => r.id));
  const byId = new Map<string, LiveWorker>();
  for (const row of rows) {
    if (!row.worker || !isSessionLive(row, events.get(row.id), now)) continue;
    let urn: string | null = null;
    try {
      urn = composeWorkerUrn(normalizeUrnForLookup(app.urn), row.worker.slug);
    } catch {
      urn = null;
    }
    byId.set(row.worker.id, { id: row.worker.id, name: row.worker.name, urn });
  }
  const workers = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  if (workers.length > MAX_WORKERS) fail(`More than ${MAX_WORKERS} live Workers match.`, 'TEAM_ATTENTION_SCOPE_TOO_LARGE');
  return workers;
}

async function attentionTargets(ctx: Context, app: AppRow): Promise<Target[]> {
  const workers = await liveOwnWorkers(ctx, app);
  const targets: Target[] = [];
  for (const worker of workers) {
    const view = await resolveRegister(ctx.db, { attendee: { workerId: worker.id }, actor: ctx });
    for (const row of view?.rows ?? []) {
      if (row.entry.role === 'POST' || !row.canRead || row.channel.deleted || !row.channel.hostMemoryId) continue;
      const token = mentionTokenOf(worker.name);
      targets.push({
        workerId: worker.id,
        workerName: worker.name,
        workerUrn: worker.urn,
        channelId: row.channel.id,
        channelName: row.channel.name,
        channelLoc: row.channel.loc,
        memoryId: row.channel.hostMemoryId,
        registerId: row.entry.id,
        mentionOnly: row.entry.mentionOnly,
        seen: row.readState?.lastSeenSeq ?? 0,
        head: row.channel.lastSeq,
        mentionTokens: token ? [...BROADCAST_MENTION_TOKENS, token] : [...BROADCAST_MENTION_TOKENS],
      });
    }
  }
  targets.sort((a, b) => a.workerId.localeCompare(b.workerId) || a.channelLoc.localeCompare(b.channelLoc) || a.channelId.localeCompare(b.channelId));
  if (targets.length > MAX_TARGETS) fail(`More than ${MAX_TARGETS} Worker/Channel targets match.`, 'TEAM_ATTENTION_SCOPE_TOO_LARGE');
  return targets;
}

/** One row fetched by the paged scan's inner SELECT — already filtered to
 * live chat-messages of the one Channel (the partial-index predicate), so the
 * row budget counts exactly the rows examined. */
type EncryptedCandidateRow = {
  memory_id: string;
  seq: number;
  loc: string;
  data: unknown;
};

function decryptRoutingEnvelope(candidate: EncryptedCandidateRow): Record<string, unknown> {
  try {
    const decrypted = decryptNodeFields(
      { data: candidate.data },
      { id: candidate.memory_id, isEncrypted: true },
    );
    return (decrypted.data && typeof decrypted.data === 'object')
      ? decrypted.data as Record<string, unknown>
      : {};
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SESSION_EXPIRED')) {
      fail(`SESSION_EXPIRED: memory ${candidate.memory_id} is encrypted but no active session key is available.`, 'SESSION_EXPIRED', { memoryId: candidate.memory_id });
    }
    throw error;
  }
}

// ── #1384/#1421 paged (v2) scan engine ───────────────────────────────────────
//
// The retired v1 poll decrypted an encrypted Channel's whole unread backlog
// inside one request (its doors now answer UPGRADE_REQUIRED; the exhaustive
// unreadCounts loop is deleted). The v2 engine below performs a bounded
// amount of work per call and hands the private progress back in a signed
// continuation (codec in teamAttentionPage.ts). In-memory state mirrors the
// continuation payload; entry/exit points serialize it. Channels are indexed
// in sorted-id order so the round-robin schedule is deterministic across
// pulls.

/** Mutable scan state, isomorphic to the signed continuation payload. */
export interface PagedScanState {
  /** Channel index → frozen span [cMin, cMax] over its targets. */
  cMin: number[];
  cMax: number[];
  /** Seq-first keyset cursor per channel: (seq, locSuffix). seq -1 = not
   * started. The scan walks (message_channel_id, seq, loc) on the partial
   * C-collation index — the seq range IS the frozen bound (post-freeze
   * rows have seq > cMax and cannot enter the range; no separate
   * frozen-upper-loc lookup needed). */
  cCursorSeq: number[];
  cCursorLoc: string[];
  /** Last COUNTED-message suffix ('' until one counted) — the stale-frontier
   * check row, independent of the raw cursor (#1430 decoupling). */
  cFrontNum: string[];
  /** Channel index → frozen incarnation, compared on every resume (#3111). */
  cInc: number[];
  cDone: boolean[];
  /** Target index → private partial accumulators (never surfaced as exact
   * until the target's channel is done and the item is emitted). */
  aUnread: number[];
  aMent: number[];
  aFirst: number[]; // 0 = none seen yet
  aLast: number[]; // 0 = none
  /** Target indices awaiting delivery, in completion-visit order. */
  pending: number[];
  emitted: boolean[];
  /** Round-robin scheduler position (channel index). */
  next: number;
}

/** One bounded work step. `budget` is the GLOBAL decrypted-row allowance for
 * this request; plaintext channels complete in one aggregate visit without
 * charging the budget (their cost is one indexed query, not row decryption).
 * Returns the number of decrypted rows consumed. */
async function pagedScanStep(
  db: Context['db'],
  targets: Target[],
  channelIndexOf: Map<string, number>,
  /** Channel index → live geometry rehydrated this pull; plaintext channels
   * aggregate in bounded seq windows (row-linear SQL work would otherwise
   * escape the request budget — Codex P1 on #1428). */
  channelGeometry: Map<number, { memoryId: string; locPrefix: string; encrypted: boolean; channelId: string }>,
  mentionTokensByTarget: string[][],
  state: PagedScanState,
  budget: number,
): Promise<number> {
  const channelCount = state.cDone.length;
  const targetsOfChannel = new Map<number, number[]>();
  targets.forEach((_t, i) => {
    const c = channelIndexOf.get(targets[i].channelId)!;
    const list = targetsOfChannel.get(c) ?? [];
    list.push(i);
    targetsOfChannel.set(c, list);
  });

  let spent = 0;
  let visits = 0;
  // Guard against a pathological loop when channels keep drifting away: a
  // full lap that only retires vanished channels still counts as visits.
  while (spent < budget && visits < channelCount * 2) {
    visits++;
    // Advance to the next not-done channel, round-robin; stop when a full
    // lap finds only done channels.
    let k = -1;
    for (let step = 0; step < channelCount; step++) {
      const candidate = (state.next + step) % channelCount;
      if (!state.cDone[candidate]) { k = candidate; break; }
    }
    if (k === -1) break;
    state.next = (k + 1) % channelCount;

    const geometry = channelGeometry.get(k);
    if (!geometry) {
      state.cDone[k] = true;
      continue;
    }
    // Fairness quantum (#3051 finding 7): no single channel may consume the
    // whole request budget — each active channel gets at most an equal share
    // of the remaining budget per visit, so 200 backlogged channels each get
    // a visit within ceil(active / floor(budget / active)) rounds (≤4 pulls
    // at the contract's 50/200 numbers), instead of the first channel eating
    // all 50 rows and the last waiting 200 pulls.
    const activeChannels = state.cDone.filter((done) => !done).length;
    const share = Math.max(1, Math.floor((budget - spent) / Math.max(1, activeChannels)));
    const take = Math.min(budget - spent, share, ENCRYPTED_MESSAGE_PAGE_SIZE);
    const prefix = geometry.locPrefix;
    // #1430 seq-first scan on the partial (message_channel_id, seq, loc C)
    // index. The inner SELECT carries the index predicate VERBATIM
    // (node_type / deleted_at; `seq > cMin` proves seq IS NOT NULL), so the
    // planner can use nodes_msg_channel_seq_loc_c_idx as the access path —
    // without predicate proof it must scan/sort the wider nodes table despite
    // the LIMIT (Andi #3277; Chip's #3282 EXPLAIN measured 20k rows examined
    // for LIMIT 2 when the predicate was applied only in JS). The frozen seq
    // range IS the bound: post-freeze rows (seq > cMax) cannot enter the
    // index range, so sustained traffic cannot prevent completion. The
    // (seq, loc) keyset handles duplicate seqs; loc order inversions
    // (999/1000) are irrelevant because seq leads. Every RETURNED row has
    // passed every predicate, so examined work per page is ≤ take (the only
    // extra rows the index walk can touch are same-seq duplicates at the
    // cursor's seq — a finite pre-#919 artifact, paid once per step).
    const cursorLoc = state.cCursorLoc[k] ? prefix + state.cCursorLoc[k] : '';

    const rows = await db.$queryRaw<EncryptedCandidateRow[]>(Prisma.sql`
      SELECT n.seq::int AS seq, n.loc, n.data, n.memory_id
      FROM nodes n
      WHERE n.message_channel_id = ${geometry.channelId}
        AND n.node_type = 'chat-message'
        AND n.deleted_at IS NULL
        AND n.seq > ${state.cMin[k]}
        AND n.seq <= ${state.cMax[k]}
        AND (${state.cCursorSeq[k]} = -1 OR n.seq > ${state.cCursorSeq[k]}
          OR (n.seq = ${state.cCursorSeq[k]} AND n.loc COLLATE "C" > ${cursorLoc} COLLATE "C"))
      ORDER BY n.seq, n.loc COLLATE "C"
      LIMIT ${take}
    `);

    const list = targetsOfChannel.get(k) ?? [];
    for (const row of rows) {
      spent++; // every returned row passed all predicates — charge it
      const envelope = geometry.encrypted
        ? decryptRoutingEnvelope(row)
        : ((row.data && typeof row.data === 'object') ? row.data as Record<string, unknown> : {});
      const mentions = Array.isArray(envelope.mentions)
        ? envelope.mentions.filter((v): v is string => typeof v === 'string')
        : [];
      let anyCounted = false;
      for (const ti of list) {
        const target = targets[ti];
        if (row.seq <= target.seen || row.seq > target.head || envelope.authorWorkerId === target.workerId) continue;
        anyCounted = true;
        state.aUnread[ti]++;
        state.aFirst[ti] = state.aFirst[ti] === 0 ? row.seq : Math.min(state.aFirst[ti], row.seq);
        const mentioned = mentionTokensByTarget[ti].some((token) => mentions.includes(token));
        if (mentioned) state.aMent[ti]++;
        if (!target.mentionOnly || mentioned) {
          state.aLast[ti] = Math.max(state.aLast[ti], row.seq);
        }
      }
      state.cCursorSeq[k] = row.seq;
      state.cCursorLoc[k] = row.loc.slice(prefix.length);
      // The COUNTED frontier only advances when ≥1 target actually counted
      // this row — an own post after a counted message must not weaken the
      // deletion check (#3153 finding 3).
      if (anyCounted) state.cFrontNum[k] = state.cCursorLoc[k];
    }

    // Done when the frozen seq range is exhausted (fewer than `take`
    // qualifying rows). Post-freeze traffic never enters the index range —
    // no seq inference, no padding-boundary hazard.
    if (rows.length < take) {
      state.cDone[k] = true;
      list.sort((a, b) => targets[a].workerId.localeCompare(targets[b].workerId));
      state.pending.push(...list);
    }
  }
  return spent;
}

// ── #1384/#1421 paged (v2) public surface ────────────────────────────────────

export interface TeamAttentionPageItem {
  worker: string;
  workerName: string;
  workerUrn: string | null;
  channel: string;
  channelName: string;
  unread: number;
  unreadMentions: number;
  firstUnreadSeq: number | null;
  lastRelevantSeq: number | null;
  lastSeq: number; // the frozen Channel head this page's counts are exact for
}

export interface TeamAttentionPageResult {
  items: TeamAttentionPageItem[];
  scanComplete: boolean;
  /** Present while any Channel is unfinished or queued items remain
   * undelivered. Absent (null) on the final page. */
  nextPage: string | null;
  /** Present ONLY on the final page: a v1-shaped `since` head snapshot the
   * router adopts under the unchanged no-loss rule (every listed nudge
   * accepted first). Routers migrate without discarding a watermark. */
  adoptableSince: string | null;
}

export interface TeamAttentionPreviewPageResult {
  items: TeamAttentionPageItem[];
  scanComplete: boolean;
  nextPage: string | null;
  /** Present ONLY on the final page: the existing short-lived switchover
   * proof, bound to the complete frozen target scope and from/through heads.
   * An incomplete preview NEVER carries a proof, so a capped/partial preview
   * can never become a silent backlog-discard path. */
  proof: string | null;
  expiresAt: Date | null;
}

function stateToContinuation(
  op: 'poll' | 'preview',
  appId: string,
  userId: string,
  targets: Target[],
  channelIds: string[],
  state: PagedScanState,
  priorFloors: number[],
  channelIncarnations: number[],
): PageContinuation {
  const workerIds = [...new Set(targets.map((t) => t.workerId))].sort();
  const workerIndex = new Map(workerIds.map((id, i) => [id, i]));
  const registerIds = [...new Set(targets.map((t) => t.registerId))].sort();
  const registerIndex = new Map(registerIds.map((id, i) => [id, i]));
  const payload: PageContinuation = {
    v: 2,
    kind: 'team-attention-page',
    // Era marker 's' = seq-first Channel-local scan. The loc-ordered era
    // minted 'c'; verifyPageToken restarts those typed rather than
    // reinterpreting their cursor (Andi #3281).
    o: 's',
    op,
    appId,
    userId,
    ts: Date.now(),
    W: workerIds,
    C: channelIds,
    R: registerIds,
    t_w: targets.map((t) => workerIndex.get(t.workerId)!),
    t_c: targets.map((t) => channelIds.indexOf(t.channelId)),
    t_r: targets.map((t) => registerIndex.get(t.registerId)!),
    t_mo: targets.map((t) => (t.mentionOnly ? 1 : 0)),
    t_seen: targets.map((t) => t.seen),
    t_head: targets.map((t) => t.head),
    t_prior: priorFloors,
    c_done: channelIds.reduce((m, _id, k) => (state.cDone[k] ? maskSet(m, k) : m), maskEmpty()),
    c_seq: state.cCursorSeq,
    c_loc: state.cCursorLoc,
    c_front: state.cFrontNum,
    c_inc: channelIncarnations,
    c_min: state.cMin,
    c_max: state.cMax,
    u_unread: state.aUnread,
    u_ment: state.aMent,
    u_first: state.aFirst,
    u_last: state.aLast,
    e_emitted: targets.reduce((m, _t, i) => (state.emitted[i] ? maskSet(m, i) : m), maskEmpty()),
    q: state.pending,
    next: state.next,
    dg: '',
  };
  payload.dg = scopeDigest(payload, attentionTokenSecret());
  return payload;
}

function continuationToState(page: PageContinuation): PagedScanState {
  const channelCount = page.C.length;
  const state: PagedScanState = {
    cMin: page.c_min,
    cMax: page.c_max,
    cCursorSeq: page.c_seq,
    cCursorLoc: page.c_loc,
    cFrontNum: page.c_front,
    cInc: page.c_inc,
    cDone: Array.from({ length: channelCount }, (_v, k) => maskGet(page.c_done, k)),
    aUnread: page.u_unread,
    aMent: page.u_ment,
    aFirst: page.u_first,
    aLast: page.u_last,
    pending: page.q,
    emitted: page.t_w.map((_v, i) => maskGet(page.e_emitted, i)),
    next: page.next,
  };
  return state;
}

/**
 * The paged attention poll (#1384 v2). Each call performs bounded work — at
 * most `scanLimit` decrypted rows and `limit` emitted Worker/Channel pairs —
 * and returns either a continuation or, when every frozen Channel is scanned
 * AND every queued item delivered, the final page with the adoptable v1-shaped
 * `since` snapshot. `since` (a v1 token) is accepted on the FIRST page only,
 * carrying the router's committed watermark forward; `page` continues a scan.
 * Never advances ChannelReadState; drift answers a typed stale-page refusal.
 */
async function runPagedAttention(
  ctx: Context,
  appRef: string,
  args: { since?: string | null; page?: string | null; limit?: number | null; scanLimit?: number | null },
  op: 'poll' | 'preview',
): Promise<{ items: TeamAttentionPageItem[]; scanComplete: boolean; nextPage: string | null; adoptableSince: string | null; proof: string | null; proofExpiresAt: Date | null; frozenSeen: number[]; frozenHead: number[] }> {
  const app = await resolvePilotApp(ctx, appRef);
  if (args.since === 'now') {
    fail('since:"now" is intentionally unavailable: preview and explicitly confirm a switchover instead.', 'SWITCHOVER_CONFIRMATION_REQUIRED');
  }
  if (args.since && args.page) {
    fail('Pass either since (start a scan) or page (continue one), not both.', 'BAD_USER_INPUT');
  }
  if (op === 'preview' && args.since) {
    fail('The paged preview takes no since token.', 'BAD_USER_INPUT');
  }
  // Integer budgets: GraphQL coerces Int and MCP validates via zod .int(),
  // but direct resolver callers bypass both — a fractional budget must fail
  // loudly rather than reach a SQL LIMIT (Codex P2 on #1428).
  for (const [name, value] of [['limit', args.limit], ['scanLimit', args.scanLimit]] as const) {
    if (value != null && !Number.isInteger(value)) {
      fail(`${name} must be an integer.`, 'BAD_USER_INPUT');
    }
  }
  const limit = Math.max(1, Math.min(args.limit ?? PAGE_RESULT_PAIRS_DEFAULT, PAGE_RESULT_PAIRS_MAX));
  const scanLimit = Math.max(1, Math.min(args.scanLimit ?? PAGE_SCAN_ROW_BUDGET_DEFAULT, PAGE_SCAN_ROW_BUDGET_MAX));

  let targets = await attentionTargets(ctx, app);
  const secret = attentionTokenSecret();
  const liveIncarnations = new Map(
    (await ctx.db.channel.findMany({
      where: { id: { in: [...new Set(targets.map((t) => t.channelId))] } },
      select: { id: true, incarnation: true },
    })).map((c) => [c.id, c.incarnation]),
  );

  // The frozen channel dictionary is sorted-id: deterministic round-robin.
  let channelIds = [...new Set(targets.map((t) => t.channelId))].sort();
  let channelIndexOf = new Map(channelIds.map((id, k) => [id, k]));

  let state: PagedScanState;
  /** True when this request STARTED the scan (no continuation) — the only
   * point where the membership completeness gate (#3257) runs. */
  let freshScan = false;
  /** Frozen Channel incarnations — captured at freeze, compared on every
   * resume INCLUDING unstarted and done channels (#3111 lifecycle gate). */
  let channelIncarnations: number[] = [];
  let priorHeads: Map<string, number> | null = null;
  // Per-target relevance floor (the ORIGINAL since head this scan started
  // from, 0 when none) — frozen into the continuation so a resumed page
  // keeps emitting against the original watermark (#3051 finding 6).
  let priorFloors: number[] = [];
  // Frozen per-target spans — the FROZEN head (not the live one) is what the
  // final preview proof and the emitted lastSeq describe; live heads may sit
  // above them by the time the last page is pulled.
  let frozenSeen: number[];
  let frozenHead: number[];

  if (args.page) {
    const decoded = verifyPageToken(args.page, secret);
    if (decoded.op !== op) fail('That page token belongs to the other attention operation.', 'INVALID_ATTENTION_PAGE');
    if (decoded.appId !== app.id || decoded.userId !== ctx.userId) {
      fail('That page token belongs to another operator or App.', 'INVALID_ATTENTION_PAGE');
    }
    if (decoded.dg !== scopeDigest(decoded, secret)) {
      fail('The page token scope does not match; poll again without page.', 'TEAM_ATTENTION_STALE_PAGE');
    }
    state = continuationToState(decoded);
    frozenSeen = decoded.t_seen;
    frozenHead = decoded.t_head;
    priorFloors = decoded.t_prior;
    channelIncarnations = decoded.c_inc;
    // Lifecycle gate FIRST, covering every frozen channel — unstarted and
    // done included. A same-address recreate preserves Channel/register IDs
    // and only increments incarnation (#3111; Chip reproduced old-token
    // acceptance through the supported deleteChannel + ensureChannelWithRoot
    // path), so identity and head comparisons alone cannot see it.
    for (let k = 0; k < decoded.C.length; k++) {
      if (liveIncarnations.get(decoded.C[k]) !== decoded.c_inc[k]) {
        fail('A Channel was recreated since this scan started; poll again without page.', 'TEAM_ATTENTION_STALE_PAGE');
      }
    }
    // Rehydrate by REBUILDING the working target list FROM THE FROZEN
    // ARRAYS (#3046 finding 2): the frozen set and order drive scan,
    // emission, snapshot and continuation for the rest of this request;
    // live rows only prove liveness/participation and supply display
    // metadata plus the register behind the (worker, channel, mentionOnly)
    // identity. EXACT set-and-order equality is required — a count
    // difference or any unmatched entry answers a typed stale restart, so a
    // target that appeared between pages can never slip into the final
    // snapshot unscanned. A forward READ-cursor move does NOT stale the
    // scan (the frozen span stays exact for its captured range; redundant
    // nudges allowed, loss impossible); a head moving backward does.
    if (decoded.t_w.length !== targets.length) {
      fail('The scan scope drifted (target set changed size); poll again without page.', 'TEAM_ATTENTION_STALE_PAGE');
    }
    const liveAtFreeze = targets;
    const claimed = new Set<Target>();
    const rebuilt: Target[] = [];
    for (let i = 0; i < decoded.t_w.length; i++) {
      const workerId = decoded.W[decoded.t_w[i]];
      const channelId = decoded.C[decoded.t_c[i]];
      const registerId = decoded.R[decoded.t_r[i]];
      const match = liveAtFreeze.find(
        (t) => t.workerId === workerId
          && t.channelId === channelId
          && t.registerId === registerId
          && decoded.t_mo[i] === (t.mentionOnly ? 1 : 0)
          && !claimed.has(t)
          && decoded.t_head[i] <= t.head,
      );
      if (!match) {
        fail('The scan scope drifted (register, participation or head changed); poll again without page.', 'TEAM_ATTENTION_STALE_PAGE');
      }
      claimed.add(match);
      rebuilt.push({ ...match, seen: decoded.t_seen[i], head: decoded.t_head[i] });
    }
    targets = rebuilt;
    channelIds = [...new Set(targets.map((t) => t.channelId))].sort();
    channelIndexOf = new Map(channelIds.map((id, k) => [id, k]));
    if (channelIds.length !== decoded.C.length || channelIds.some((id, k) => id !== decoded.C[k])) {
      fail('The scan scope drifted (channel dictionary changed); poll again without page.', 'TEAM_ATTENTION_STALE_PAGE');
    }
    // Boundary check: the frontier row of every still-active channel must
    // still exist undeleted — deletion of the scan frontier is the mutation
    // we CAN detect cheaply; interior edits are the documented residual.
    for (let k = 0; k < channelIds.length; k++) {
      // Stale-frontier check uses the COUNTED frontier — the raw cursor may
      // legitimately sit on a residual-rejected row (#1430 decoupling).
      if (state.cDone[k] || state.cFrontNum[k] === '') continue;
      const target = targets.find((t) => t.channelId === channelIds[k]);
      const frontierLoc = `${target?.channelLoc ?? ''}:messages:${state.cFrontNum[k]}`;
      const frontier = await ctx.db.node.findFirst({
        where: { memoryId: target?.memoryId, loc: frontierLoc, deletedAt: null },
        select: { id: true },
      });
      if (!frontier) {
        fail('A Channel\'s scanned history changed (frontier row removed); poll again without page.', 'TEAM_ATTENTION_STALE_PAGE');
      }
    }
  } else {
    let prior: AttentionSnapshot | null = null;
    if (args.since) {
      const decoded = verify(args.since);
      if (decoded.kind !== 'team-attention') fail('That token is not an attention poll token.', 'INVALID_ATTENTION_TOKEN');
      if (decoded.appId !== app.id || decoded.userId !== ctx.userId) {
        fail('That attention token belongs to another operator or App.', 'INVALID_ATTENTION_TOKEN');
      }
      prior = decoded;
    }
    priorHeads = previousHeads(prior);
    for (const target of targets) {
      const key = `${target.workerId}:${target.channelId}:${target.registerId}:${target.mentionOnly}`;
      const priorHead = priorHeads.get(key);
      if (priorHead != null && priorHead > target.head) {
        fail('A Channel watermark moved behind the supplied token; poll again without since.', 'ATTENTION_TOKEN_STALE');
      }
    }
    // The idle short-circuit survives from v1 (poll only — a preview always
    // accounts for the full backlog): when every current target was in the
    // prior scope and no head moved, nothing relevant can be newer than the
    // token — no message-table touch, final page immediately.
    if (
      op === 'poll' &&
      prior &&
      targets.every((target) => {
        const key = `${target.workerId}:${target.channelId}:${target.registerId}:${target.mentionOnly}`;
        return priorHeads!.get(key) === target.head;
      })
    ) {
      return { items: [], scanComplete: true, nextPage: null, adoptableSince: sign(snapshot(app.id, ctx.userId!, targets)), proof: null, proofExpiresAt: null, frozenSeen: targets.map((t) => t.seen), frozenHead: targets.map((t) => t.head) };
    }
    frozenSeen = targets.map((t) => t.seen);
    frozenHead = targets.map((t) => t.head);
    channelIncarnations = channelIds.map((id) => liveIncarnations.get(id) ?? 0);
    priorFloors = targets.map((target) => {
      const key = `${target.workerId}:${target.channelId}:${target.registerId}:${target.mentionOnly}`;
      return priorHeads?.get(key) ?? 0;
    });
    freshScan = true;
    state = {
      cMin: channelIds.map((id) => Math.min(...targets.filter((t) => t.channelId === id).map((t) => t.seen))),
      cMax: channelIds.map((id) => Math.max(...targets.filter((t) => t.channelId === id).map((t) => t.head))),
      cCursorSeq: channelIds.map(() => -1),
      cCursorLoc: channelIds.map(() => ''),
      cFrontNum: channelIds.map(() => ''),
      cInc: channelIds.map((id) => liveIncarnations.get(id) ?? 0),
      cDone: channelIds.map(() => false),
      aUnread: targets.map(() => 0),
      aMent: targets.map(() => 0),
      aFirst: targets.map(() => 0),
      aLast: targets.map(() => 0),
      pending: [],
      emitted: targets.map(() => false),
      next: 0,
    };
  }

  // Encryption split feeds the scan step: encrypted channels decrypt under
  // the row budget; plaintext channels aggregate in bounded seq windows
  // inside the same round-robin (one giant aggregate would be row-linear
  // server work — Codex P1 on #1428).
  const memories = await ctx.db.memory.findMany({
    where: { id: { in: [...new Set(targets.map((t) => t.memoryId))] } },
    select: { id: true, isEncrypted: true },
  });
  const encryptedMemoryIds = new Set(memories.filter((m) => m.isEncrypted).map((m) => m.id));

  // Encrypted channels: one bounded round-robin step.
  const channelGeometry = new Map<number, { memoryId: string; locPrefix: string; encrypted: boolean; channelId: string }>();
  for (let k = 0; k < channelIds.length; k++) {
    const target = targets.find((t) => t.channelId === channelIds[k]);
    if (target) {
      channelGeometry.set(k, {
        memoryId: target.memoryId,
        locPrefix: `${target.channelLoc}:messages:`,
        encrypted: encryptedMemoryIds.has(target.memoryId),
        channelId: channelIds[k],
      });
    }
  }
  // #3257 rollout completeness gate — freeze only. The paged reader trusts
  // Node.messageChannelId for membership; an unstamped live chat-message
  // under a Channel's messages prefix (an old binary still appending after
  // the backfill migration, or an off-road generic-surface create) would be
  // INVISIBLE to the scan, so a fresh scan refuses until adoption completes
  // instead of silently missing messages. Runs once per Channel per scan
  // start, never on resume: post-freeze appends allocate seq above every
  // row the freeze saw, so they sit outside the frozen span and the next
  // scan's gate re-checks them. seq IS NOT NULL is included explicitly so
  // the planner can prove the partial-index predicate and serve this from
  // nodes_msg_channel_seq_loc_c_idx (the NULL membership partition is empty
  // once adoption has run — the check is O(log n) in steady state).
  if (freshScan) {
    for (let k = 0; k < channelIds.length; k++) {
      const geometry = channelGeometry.get(k)!;
      const unstamped = await ctx.db.$queryRaw<Array<{ loc: string }>>(Prisma.sql`
        SELECT n.loc FROM nodes n
        WHERE n.memory_id = ${geometry.memoryId}
          AND n.node_type = 'chat-message'
          AND n.deleted_at IS NULL
          AND n.seq IS NOT NULL
          AND n.message_channel_id IS NULL
          AND starts_with(n.loc, ${geometry.locPrefix})
        LIMIT 1
      `);
      if (unstamped.length > 0) {
        fail(
          `Channel ${geometry.locPrefix.slice(0, -':messages:'.length)} has live chat-message rows without Channel membership (for example ${unstamped[0].loc}); an older writer or an off-road create left them unstamped. Re-run Channel adoption, then poll again — your committed watermark is untouched.`,
          'TEAM_ATTENTION_MEMBERSHIP_INCOMPLETE',
          { channel: channelIds[k], exampleLoc: unstamped[0].loc },
        );
      }
    }
  }

  await pagedScanStep(ctx.db, targets, channelIndexOf, channelGeometry, targets.map((t) => t.mentionTokens), state, scanLimit);

  // Emission: deliver completed targets in completion-visit order. The poll
  // applies v1's relevance rule (lastRelevant > priorHead; priorHead 0 when
  // this scan started without a since token); the preview accounts for the
  // full backlog and emits every completed target.
  const items: TeamAttentionPageItem[] = [];
  while (items.length < limit && state.pending.length > 0) {
    const i = state.pending[0];
    state.pending = state.pending.slice(1);
    state.emitted[i] = true;
    const target = targets[i];
    const priorHead = priorFloors[i] ?? 0;
    if (op === 'poll' && state.aLast[i] <= priorHead) continue; // nothing relevant since the watermark
    items.push({
      worker: target.workerId,
      workerName: target.workerName,
      workerUrn: target.workerUrn,
      channel: target.channelId,
      channelName: target.channelName,
      unread: state.aUnread[i],
      unreadMentions: state.aMent[i],
      firstUnreadSeq: state.aFirst[i] || null,
      lastRelevantSeq: state.aLast[i] || null,
      lastSeq: frozenHead[i],
    });
  }

  const scanComplete = state.cDone.every(Boolean) && state.pending.length === 0;
  if (scanComplete) {
    if (op === 'preview') {
      // The proof starts its short life only now — the final page of a FULL
      // preview — and binds the frozen from/through heads; messages arriving
      // after the freeze remain unread.
      const issuedAt = Date.now();
      const expiresAt = issuedAt + SWITCHOVER_PROOF_TTL_MS;
      const proof: SwitchoverProof = {
        v: 1,
        kind: 'team-attention-switchover',
        appId: app.id,
        userId: ctx.userId!,
        issuedAt,
        expiresAt,
        targets: targets.map((t, i) => ({
          workerId: t.workerId,
          channelId: t.channelId,
          registerId: t.registerId,
          mentionOnly: t.mentionOnly,
          from: frozenSeen[i],
          through: frozenHead[i],
        })),
      };
      return { items, scanComplete: true, nextPage: null, adoptableSince: null, proof: sign(proof), proofExpiresAt: new Date(expiresAt), frozenSeen, frozenHead };
    }
    return { items, scanComplete: true, nextPage: null, adoptableSince: sign(snapshot(app.id, ctx.userId!, targets)), proof: null, proofExpiresAt: null, frozenSeen, frozenHead };
  }
  // #3053 compaction: delivered targets' accumulators are final and already
  // emitted — zero them in the continuation so token size decreases
  // monotonically as results deliver (the emitted mask prevents re-emission
  // and their channels are done, so nothing reads these values again).
  for (let i = 0; i < state.emitted.length; i++) {
    if (state.emitted[i]) {
      state.aUnread[i] = 0; state.aMent[i] = 0; state.aFirst[i] = 0; state.aLast[i] = 0;
    }
  }
  const payload = stateToContinuation(op, app.id, ctx.userId!, targets, channelIds, state, priorFloors, channelIncarnations);
  payload.t_seen = frozenSeen;
  payload.t_head = frozenHead;
  const signed = signPageToken(payload, secret);
  if ('tooLarge' in signed) {
    fail(
      `The scan continuation would not fit the ${MAX_PAGE_TOKEN_CHARS}-character transport ceiling (${signed.actualChars} needed); poll again without page to restart from your committed watermark.`,
      'TEAM_ATTENTION_PAGE_TOO_LARGE',
    );
  }
  return { items, scanComplete: false, nextPage: signed.token, adoptableSince: null, proof: null, proofExpiresAt: null, frozenSeen, frozenHead };
}

/** The paged attention poll (#1384 v2). See `runPagedAttention`. */
export async function teamAttentionPage(
  ctx: Context,
  appRef: string,
  args: { since?: string | null; page?: string | null; limit?: number | null; scanLimit?: number | null },
): Promise<TeamAttentionPageResult> {
  const run = await runPagedAttention(ctx, appRef, args, 'poll');
  return { items: run.items, scanComplete: run.scanComplete, nextPage: run.nextPage, adoptableSince: run.adoptableSince };
}

/** The paged switchover preview (#1384 v2): same bounded scan and paged
 * result contract; the short-lived apply proof exists ONLY on the final page
 * of a fully completed preview. `confirmTeamAttentionSwitchover` (apply) is
 * unchanged. */
export async function teamAttentionPreviewPage(
  ctx: Context,
  appRef: string,
  args: { page?: string | null; limit?: number | null; scanLimit?: number | null },
): Promise<TeamAttentionPreviewPageResult> {
  const run = await runPagedAttention(ctx, appRef, args, 'preview');
  return { items: run.items, scanComplete: run.scanComplete, nextPage: run.nextPage, proof: run.proof, expiresAt: run.proofExpiresAt };
}

function snapshot(appId: string, userId: string, targets: Target[]): AttentionSnapshot {
  const workers = new Map<string, AttentionSnapshot['workers'][number]>();
  for (const t of targets) {
    let worker = workers.get(t.workerId);
    if (!worker) {
      worker = { workerId: t.workerId, channels: [] };
      workers.set(t.workerId, worker);
    }
    worker.channels.push({
      channelId: t.channelId,
      registerId: t.registerId,
      mentionOnly: t.mentionOnly,
      head: t.head,
    });
  }
  return { v: 1, kind: 'team-attention', appId, userId, workers: [...workers.values()] };
}

function previousHeads(value: AttentionSnapshot | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const worker of value?.workers ?? []) {
    if (!worker || typeof worker.workerId !== 'string' || !Array.isArray(worker.channels)) {
      fail('Invalid team-attention token.', 'INVALID_ATTENTION_TOKEN');
    }
    for (const channel of worker.channels) {
      if (
        !channel ||
        typeof channel.channelId !== 'string' ||
        typeof channel.registerId !== 'string' ||
        typeof channel.mentionOnly !== 'boolean' ||
        !Number.isInteger(channel.head) ||
        channel.head < 0
      ) fail('Invalid team-attention token.', 'INVALID_ATTENTION_TOKEN');
      out.set(`${worker.workerId}:${channel.channelId}:${channel.registerId}:${channel.mentionOnly}`, channel.head);
    }
  }
  return out;
}

export async function getTeamAttention(ctx: Context, appRef: string, since?: string | null): Promise<TeamAttentionResult> {
  // #1384 v2 retirement: the v1 poll decrypts an encrypted Channel's whole
  // unread backlog inside one request. It is refused everywhere so no
  // deployment can expose unbounded work; routers migrate by passing their
  // existing since token to teamAttentionPage (the watermark carries over).
  void ctx; void appRef; void since;
  fail(
    'Team attention v1 is retired: use the paged teamAttentionPage operation (your existing since token is accepted there).',
    'UPGRADE_REQUIRED',
  );
}

export async function previewTeamAttentionSwitchover(
  ctx: Context,
  appRef: string,
): Promise<TeamAttentionSwitchoverPreview> {
  // #1384 v2 retirement: the unbounded v1 preview shares the v1 poll's scan.
  // The paged teamAttentionPreviewPage replaces it; apply
  // (confirmTeamAttentionSwitchover) is unchanged and honors existing
  // unexpired proofs to expiry.
  void ctx; void appRef;
  fail(
    'Switchover preview v1 is retired: use the paged teamAttentionPreviewPage operation; the proof it issues on its final page feeds the unchanged apply.',
    'UPGRADE_REQUIRED',
  );
}

function targetIdentity(t: Pick<Target, 'workerId' | 'channelId' | 'registerId' | 'mentionOnly' | 'seen'>): string {
  return `${t.workerId}:${t.channelId}:${t.registerId}:${t.mentionOnly}:${t.seen}`;
}

export async function confirmTeamAttentionSwitchover(
  ctx: Context,
  appRef: string,
  proofToken: string,
): Promise<{ applied: true; workersAdvanced: number; channelsAdvanced: number }> {
  const app = await resolvePilotApp(ctx, appRef);
  const decoded = verify(proofToken);
  if (decoded.kind !== 'team-attention-switchover') fail('That token is not a switchover proof.', 'INVALID_SWITCHOVER_PROOF');
  if (decoded.appId !== app.id || decoded.userId !== ctx.userId || !Array.isArray(decoded.targets)) {
    fail('That switchover proof belongs to another operator or App.', 'INVALID_SWITCHOVER_PROOF');
  }
  if (!Number.isInteger(decoded.expiresAt) || Date.now() > decoded.expiresAt) {
    fail('That switchover preview has expired; preview again.', 'SWITCHOVER_PROOF_EXPIRED');
  }
  if (decoded.targets.length > MAX_TARGETS) fail('Invalid switchover proof.', 'INVALID_SWITCHOVER_PROOF');

  try {
    await ctx.db.$transaction(
      async (tx) => {
        const txCtx = { ...ctx, db: tx as unknown as PrismaClient };
        // Re-asked INSIDE the serializable transaction, on its own connection
        // (#1362 review, Copilot): the entry check can go stale before these
        // writes, and an App uninstalled or a participation revoked since then
        // must not still advance cursors. A revocation racing these writes
        // surfaces as a serialization abort, mapped to stale below.
        if (!(await teamAttentionAvailable(txCtx, app.id))) {
          fail('Access to this App changed after preview; preview again.', 'SWITCHOVER_PROOF_STALE');
        }
        const current = await attentionTargets(txCtx, app);
        const currentByIdentity = new Map(current.map((t) => [targetIdentity(t), t]));
        const proofIdentities = new Set<string>();
        for (const target of decoded.targets) {
          if (
            !target ||
            typeof target.workerId !== 'string' ||
            typeof target.channelId !== 'string' ||
            typeof target.registerId !== 'string' ||
            typeof target.mentionOnly !== 'boolean' ||
            !Number.isInteger(target.from) || target.from < 0 ||
            !Number.isInteger(target.through) || target.through < 0
          ) fail('Invalid switchover proof.', 'INVALID_SWITCHOVER_PROOF');
          const identity = `${target.workerId}:${target.channelId}:${target.registerId}:${target.mentionOnly}:${target.from}`;
          proofIdentities.add(identity);
          const live = currentByIdentity.get(identity);
          if (!live || live.head < target.through) {
            fail('The Worker/register/read-state scope changed after preview; preview again.', 'SWITCHOVER_PROOF_STALE');
          }
        }
        if (proofIdentities.size !== currentByIdentity.size || [...currentByIdentity.keys()].some((k) => !proofIdentities.has(k))) {
          fail('The live Worker/register scope changed after preview; preview again.', 'SWITCHOVER_PROOF_STALE');
        }
        for (const target of decoded.targets) {
          await advanceReadState(tx, { workerId: target.workerId }, target.channelId, target.through);
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034') {
      fail('The Worker/register or access scope changed during apply; preview again.', 'SWITCHOVER_PROOF_STALE');
    }
    throw e;
  }
  return {
    applied: true,
    workersAdvanced: new Set(decoded.targets.map((t) => t.workerId)).size,
    channelsAdvanced: decoded.targets.length,
  };
}

/** Resolve one exact, live, caller-owned Worker session and its owning App. */
async function ownLiveSessionWorker(
  ctx: Context,
  sessionRef: string,
  expectedAppId?: string,
): Promise<{ workerId: string; appId: string } | null> {
  if (!ctx.userId || ctx.impersonation) return null;
  const session = await ctx.db.session.findFirst({
    where: {
      id: sessionRef.trim(),
      userId: ctx.userId,
      appId: expectedAppId,
      workerId: { not: null },
      endedAt: null,
      deletedAt: null,
      worker: { retiredAt: null },
    },
    select: {
      id: true,
      appId: true,
      workerId: true,
      type: true,
      startedAt: true,
      updatedAt: true,
      autoExpiredAt: true,
      endedAt: true,
      worker: { select: { appId: true } },
    },
  });
  if (
    !session?.workerId ||
    !session.appId ||
    session.worker?.appId !== session.appId ||
    !teamAttentionPilotEnabled(ctx.userId, session.appId)
  ) return null;
  // A historical Session.userId proves who started the Worker, not who may
  // still drive it. Recheck current App participation before a read mutates
  // its cursor, including when the Channel is independently readable.
  const app = await ctx.db.app.findFirst({
    where: { id: session.appId, ...LIVE_APP_WHERE },
    select: { id: true, organizationId: true, ownerUserId: true },
  });
  if (!app || !(await isAppParticipant(ctx, app))) return null;
  const events = await loadLastEventBySession(ctx.db as never, [session.id]);
  return isSessionLive(session, events.get(session.id), new Date())
    ? { workerId: session.workerId, appId: session.appId }
    : null;
}

/**
 * Advance only a contiguous, unfiltered forward page. A skipped offset,
 * backward window, mentions filter, count-only read, or sinceSeq gap is a
 * read but not evidence that the unseen interval was consumed.
 */
export async function maybeAdvanceOwnChannelRead(
  ctx: Context,
  args: {
    channelId: string;
    capturedHead: number;
    sessionRef?: string | null;
    sinceSeq?: number | null;
    beforeSeq?: number | null;
    mentionsRef?: string | null;
    limit?: number | null;
    offset?: number | null;
    page: { items: Array<{ seq: number }>; total: number };
  },
): Promise<number | null> {
  const sessionRef = args.sessionRef?.trim() || ctx.sessionId?.trim();
  if (!sessionRef || args.mentionsRef || args.beforeSeq != null || (args.offset ?? 0) !== 0 || (args.limit ?? 1) <= 0) return null;
  const session = await ownLiveSessionWorker(ctx, sessionRef);
  if (!session) return null;
  const { workerId } = session;
  const view = await resolveRegister(ctx.db, { attendee: { workerId }, actor: ctx });
  const row = view?.rows.find((r) => r.channel.id === args.channelId);
  if (!row || row.entry.role === 'POST' || !row.canRead || row.channel.deleted) return null;
  const seen = row.readState?.lastSeenSeq ?? 0;
  if (args.sinceSeq != null && args.sinceSeq > seen) return null;
  const exhausted = args.page.total <= args.page.items.length;
  const visible = args.page.items.reduce((max, item) => Math.max(max, item.seq), seen);
  let through = exhausted ? args.capturedHead : visible;
  // A backfilled pre-#919 Channel can hold DUPLICATE seq values, and a partial
  // page can end midway through one: advancing to it would hide the unread
  // sibling forever (#1362 review, Codex P1). Stop one short when the Channel
  // has more rows at the edge seq than this page returned.
  if (!exhausted && visible > seen && row.channel.hostMemoryId) {
    const returnedAtEdge = args.page.items.filter((item) => item.seq === visible).length;
    const atEdge = await ctx.db.node.count({
      where: {
        memoryId: row.channel.hostMemoryId,
        loc: { startsWith: escapePrismaLikePattern(`${row.channel.loc}:messages:`) },
        nodeType: 'chat-message',
        deletedAt: null,
        seq: visible,
      },
    });
    if (atEdge > returnedAtEdge) through = visible - 1;
  }
  through = Math.min(args.capturedHead, through);
  if (through <= seen) return seen;
  return advanceReadState(ctx.db, { workerId }, args.channelId, through);
}

export async function markOwnTeamChatRead(
  ctx: Context,
  args: { appRef: string; channelRef?: string | null; sessionRef: string; seq: number },
): Promise<{ workerId: string; channelId: string; lastSeenSeq: number }> {
  const app = await resolvePilotApp(ctx, args.appRef);
  const session = await ownLiveSessionWorker(ctx, args.sessionRef, app.id);
  if (!session) fail('That session is not one of your live Worker sessions in this App.', 'SESSION_NOT_LIVE');
  const { workerId } = session;
  // The caller names the Channel. The MCP tool resolves an OMITTED channel to
  // the one its convenience read serves (locateTeamChatChannel), which need
  // not be App.defaultChannel; defaulting to that here marked the wrong
  // Channel after a read of the other one (#1362 review, Copilot).
  const channelRef = args.channelRef?.trim();
  const channelId = channelRef ? await resolveChannelRefId(ctx.db, channelRef) : null;
  if (!channelId) fail('No readable registered Channel matches.', 'CHANNEL_NOT_FOUND');
  const view = await resolveRegister(ctx.db, { attendee: { workerId }, actor: ctx });
  const row = view?.rows.find((r) => r.channel.id === channelId);
  if (!row || row.entry.role === 'POST' || !row.canRead || row.channel.deleted) {
    fail('No readable registered Channel matches.', 'CHANNEL_NOT_FOUND');
  }
  if (!Number.isInteger(args.seq) || args.seq < 0) fail('seq must be a non-negative integer.', 'BAD_USER_INPUT');
  if (args.seq > row.channel.lastSeq) {
    fail(`seq ${args.seq} is beyond the Channel watermark (${row.channel.lastSeq}).`, 'SEQ_BEYOND_WATERMARK', { lastSeq: row.channel.lastSeq });
  }
  const lastSeenSeq = await advanceReadState(ctx.db, { workerId }, row.channel.id, args.seq);
  return { workerId, channelId: row.channel.id, lastSeenSeq };
}
