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

type CountRow = {
  worker_id: string;
  channel_id: string;
  unread: number;
  unread_mentions: number;
  first_unread_seq: number | null;
  last_relevant_seq: number | null;
};

type PlaintextCountRow = CountRow;

type EncryptedCandidateRow = {
  channel_id: string;
  memory_id: string;
  seq: number;
  loc: string;
  data: unknown;
};

type EncryptedChannelScan = {
  channelId: string;
  memoryId: string;
  locPrefix: string;
  minSeen: number;
  maxHead: number;
  afterSeq: number;
  afterLoc: string;
  targets: Target[];
};

function countKey(workerId: string, channelId: string): string {
  return `${workerId}:${channelId}`;
}

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

/**
 * Batch every plaintext predicate in one aggregate query. Encrypted routing
 * envelopes cannot be filtered in SQL, so scan each Channel once in bounded
 * keyset pages and fan each decrypted envelope out to that Channel's Worker
 * targets in memory. A page materializes at most PAGE_SIZE rows per active
 * Channel; it never duplicates an encrypted backlog per Worker.
 */
async function unreadCounts(db: Context['db'], targets: Target[]): Promise<Map<string, CountRow>> {
  if (targets.length === 0) return new Map();
  const memories = await db.memory.findMany({
    where: { id: { in: [...new Set(targets.map((target) => target.memoryId))] } },
    select: { id: true, isEncrypted: true },
  });
  const encryptedMemoryIds = new Set(memories.filter((memory) => memory.isEncrypted).map((memory) => memory.id));
  const plaintextTargets = targets.filter((target) => !encryptedMemoryIds.has(target.memoryId));
  const encryptedTargets = targets.filter((target) => encryptedMemoryIds.has(target.memoryId));
  const out = new Map<string, CountRow>();

  if (plaintextTargets.length > 0) {
    const values = plaintextTargets.map((target) => Prisma.sql`(
      ${target.workerId}, ${target.channelId}, ${target.memoryId},
      ${escapePrismaLikePattern(`${target.channelLoc}:messages:`)},
      ${target.seen}, ${target.head}, ${target.mentionOnly}, ${JSON.stringify(target.mentionTokens)}::jsonb
    )`);
    const rows = await db.$queryRaw<PlaintextCountRow[]>(Prisma.sql`
      WITH targets(worker_id, channel_id, memory_id, loc_prefix, seen, head, mention_only, mention_tokens) AS (
        VALUES ${Prisma.join(values)}
      )
      SELECT
        t.worker_id,
        t.channel_id,
        COUNT(n.id) FILTER (
          WHERE (n.data->>'authorWorkerId') IS DISTINCT FROM t.worker_id
        )::int AS unread,
        COUNT(n.id) FILTER (
          WHERE (n.data->>'authorWorkerId') IS DISTINCT FROM t.worker_id
            AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(t.mention_tokens) AS wanted(token)
            WHERE COALESCE(n.data->'mentions', '[]'::jsonb) ? wanted.token
          )
        )::int AS unread_mentions,
        MIN(n.seq) FILTER (
          WHERE (n.data->>'authorWorkerId') IS DISTINCT FROM t.worker_id
        )::int AS first_unread_seq,
        MAX(n.seq) FILTER (
          WHERE (n.data->>'authorWorkerId') IS DISTINCT FROM t.worker_id
            AND (
              NOT t.mention_only OR EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(t.mention_tokens) AS wanted(token)
                WHERE COALESCE(n.data->'mentions', '[]'::jsonb) ? wanted.token
              )
            )
        )::int AS last_relevant_seq
      FROM targets t
      LEFT JOIN nodes n
        ON n.memory_id = t.memory_id
        AND n.loc LIKE (t.loc_prefix || '%') ESCAPE '\\'
        AND n.node_type = 'chat-message'
        AND n.deleted_at IS NULL
        AND n.seq > t.seen
        AND n.seq <= t.head
      GROUP BY t.worker_id, t.channel_id
    `);
    for (const row of rows) out.set(countKey(row.worker_id, row.channel_id), row);
  }

  const scansByChannel = new Map<string, EncryptedChannelScan>();
  for (const target of encryptedTargets) {
    let scan = scansByChannel.get(target.channelId);
    if (!scan) {
      scan = {
        channelId: target.channelId,
        memoryId: target.memoryId,
        locPrefix: escapePrismaLikePattern(`${target.channelLoc}:messages:`),
        minSeen: target.seen,
        maxHead: target.head,
        afterSeq: -1,
        afterLoc: '',
        targets: [],
      };
      scansByChannel.set(target.channelId, scan);
    } else {
      scan.minSeen = Math.min(scan.minSeen, target.seen);
      scan.maxHead = Math.max(scan.maxHead, target.head);
    }
    scan.targets.push(target);
    out.set(countKey(target.workerId, target.channelId), {
      worker_id: target.workerId,
      channel_id: target.channelId,
      unread: 0,
      unread_mentions: 0,
      first_unread_seq: null,
      last_relevant_seq: null,
    });
  }

  let activeScans = [...scansByChannel.values()];
  while (activeScans.length > 0) {
    const values = activeScans.map((scan) => Prisma.sql`(
      ${scan.channelId}, ${scan.memoryId}, ${scan.locPrefix},
      ${scan.minSeen}, ${scan.maxHead}, ${scan.afterSeq}, ${scan.afterLoc}
    )`);
    const candidates = await db.$queryRaw<EncryptedCandidateRow[]>(Prisma.sql`
      WITH channels(channel_id, memory_id, loc_prefix, min_seen, max_head, after_seq, after_loc) AS (
        VALUES ${Prisma.join(values)}
      )
      SELECT
        channels.channel_id,
        channels.memory_id,
        page.seq::int,
        page.loc,
        page.data
      FROM channels
      CROSS JOIN LATERAL (
        SELECT n.seq, n.loc, n.data
        FROM nodes n
        WHERE n.memory_id = channels.memory_id
          AND n.loc LIKE (channels.loc_prefix || '%') ESCAPE '\\'
          AND n.node_type = 'chat-message'
          AND n.deleted_at IS NULL
          AND n.seq > channels.min_seen
          AND n.seq <= channels.max_head
          AND (n.seq, n.loc) > (channels.after_seq, channels.after_loc)
        ORDER BY n.seq, n.loc
        LIMIT ${ENCRYPTED_MESSAGE_PAGE_SIZE}
      ) page
      ORDER BY channels.channel_id, page.seq, page.loc
    `);
    const pageByChannel = new Map<string, EncryptedCandidateRow[]>();
    for (const candidate of candidates) {
      const rows = pageByChannel.get(candidate.channel_id) ?? [];
      rows.push(candidate);
      pageByChannel.set(candidate.channel_id, rows);
    }

    const stillActive: EncryptedChannelScan[] = [];
    for (const scan of activeScans) {
      const page = pageByChannel.get(scan.channelId) ?? [];
      for (const candidate of page) {
        const envelope = decryptRoutingEnvelope(candidate);
        const mentions = Array.isArray(envelope.mentions)
          ? envelope.mentions.filter((value): value is string => typeof value === 'string')
          : [];
        for (const target of scan.targets) {
          if (candidate.seq <= target.seen || candidate.seq > target.head || envelope.authorWorkerId === target.workerId) continue;
          const count = out.get(countKey(target.workerId, target.channelId))!;
          count.unread += 1;
          count.first_unread_seq = count.first_unread_seq == null
            ? candidate.seq
            : Math.min(count.first_unread_seq, candidate.seq);
          const mentioned = target.mentionTokens.some((token) => mentions.includes(token));
          if (mentioned) count.unread_mentions += 1;
          if (!target.mentionOnly || mentioned) {
            count.last_relevant_seq = count.last_relevant_seq == null
              ? candidate.seq
              : Math.max(count.last_relevant_seq, candidate.seq);
          }
        }
      }
      if (page.length === ENCRYPTED_MESSAGE_PAGE_SIZE) {
        const last = page[page.length - 1];
        scan.afterSeq = last.seq;
        scan.afterLoc = last.loc;
        stillActive.push(scan);
      }
    }
    activeScans = stillActive;
  }
  return out;
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
  const app = await resolvePilotApp(ctx, appRef);
  if (since === 'now') {
    fail('since:"now" is intentionally unavailable: preview and explicitly confirm a switchover instead.', 'SWITCHOVER_CONFIRMATION_REQUIRED');
  }
  let prior: AttentionSnapshot | null = null;
  if (since) {
    const decoded = verify(since);
    if (decoded.kind !== 'team-attention') fail('That token is not an attention poll token.', 'INVALID_ATTENTION_TOKEN');
    if (decoded.appId !== app.id || decoded.userId !== ctx.userId) {
      fail('That attention token belongs to another operator or App.', 'INVALID_ATTENTION_TOKEN');
    }
    if (!Array.isArray(decoded.workers)) fail('Invalid team-attention token.', 'INVALID_ATTENTION_TOKEN');
    prior = decoded;
  }

  const targets = await attentionTargets(ctx, app);
  const heads = previousHeads(prior);
  for (const target of targets) {
    const key = `${target.workerId}:${target.channelId}:${target.registerId}:${target.mentionOnly}`;
    const priorHead = heads.get(key);
    if (priorHead != null && priorHead > target.head) {
      fail('A Channel watermark moved behind the supplied token; poll again without since.', 'ATTENTION_TOKEN_STALE');
    }
  }
  const nextSnapshot = snapshot(app.id, ctx.userId!, targets);
  // The ordinary one-minute idle poll stops at register/read-state metadata:
  // when every current target was in the prior scope and no Channel head
  // moved, no relevant message can possibly be newer than the token. Avoid
  // touching the message table at all. A new Worker/register deliberately
  // misses this shortcut so its existing unread backlog is considered.
  if (
    prior &&
    targets.every((target) => {
      const key = `${target.workerId}:${target.channelId}:${target.registerId}:${target.mentionOnly}`;
      return heads.get(key) === target.head;
    })
  ) {
    return { token: sign(nextSnapshot), workers: [] };
  }

  const counts = await unreadCounts(ctx.db, targets);
  const workerRows = new Map<string, TeamAttentionWorker>();
  for (const target of targets) {
    const key = `${target.workerId}:${target.channelId}:${target.registerId}:${target.mentionOnly}`;
    const priorHead = heads.get(key) ?? 0;
    const count = counts.get(`${target.workerId}:${target.channelId}`);
    if (!count || count.last_relevant_seq == null || count.last_relevant_seq <= priorHead) continue;
    let worker = workerRows.get(target.workerId);
    if (!worker) {
      worker = {
        worker: target.workerId,
        name: target.workerName,
        urn: target.workerUrn,
        live: true,
        channels: [],
      };
      workerRows.set(target.workerId, worker);
    }
    worker.channels.push({
      channel: target.channelId,
      name: target.channelName,
      unread: count.unread,
      unreadMentions: count.unread_mentions,
      firstUnreadSeq: count.first_unread_seq,
      lastSeq: target.head,
    });
  }
  return { token: sign(nextSnapshot), workers: [...workerRows.values()] };
}

export async function previewTeamAttentionSwitchover(
  ctx: Context,
  appRef: string,
): Promise<TeamAttentionSwitchoverPreview> {
  const app = await resolvePilotApp(ctx, appRef);
  const targets = await attentionTargets(ctx, app);
  const counts = await unreadCounts(ctx.db, targets);
  const issuedAt = Date.now();
  const expiresAt = issuedAt + SWITCHOVER_PROOF_TTL_MS;
  const proof: SwitchoverProof = {
    v: 1,
    kind: 'team-attention-switchover',
    appId: app.id,
    userId: ctx.userId!,
    issuedAt,
    expiresAt,
    targets: targets.map((t) => ({
      workerId: t.workerId,
      channelId: t.channelId,
      registerId: t.registerId,
      mentionOnly: t.mentionOnly,
      from: t.seen,
      through: t.head,
    })),
  };
  const workers = new Map<string, TeamAttentionSwitchoverWorker>();
  for (const target of targets) {
    let worker = workers.get(target.workerId);
    if (!worker) {
      worker = { worker: target.workerId, name: target.workerName, urn: target.workerUrn, channels: [] };
      workers.set(target.workerId, worker);
    }
    const count = counts.get(`${target.workerId}:${target.channelId}`);
    worker.channels.push({
      channel: target.channelId,
      name: target.channelName,
      fromSeq: target.seen,
      throughSeq: target.head,
      unread: count?.unread ?? 0,
      unreadMentions: count?.unread_mentions ?? 0,
    });
  }
  return { proof: sign(proof), expiresAt: new Date(expiresAt), workers: [...workers.values()] };
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
  const through = Math.min(args.capturedHead, exhausted ? args.capturedHead : visible);
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
