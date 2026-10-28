/**
 * Spec 049 Phase 6 — `resolveRegister` (plan §4.3, D5 local / D-2026-09-13-007)
 * and `renderDerivedBlocks` (the ONE composition point for the briefing's
 * register block, ahead of the shared-prompt-blocks D11 composer).
 *
 * One resolver, every consumer: the boot briefing (`Worker.prompt`, which
 * `hadron_start_session` and `hadron_get_worker` both render through),
 * `hadron_whoami`, the headless-run snapshot at mint (`AppRun.registerSnapshot`)
 * and the GraphQL `attendeeRegister` query the relay reads instead of its
 * configured `appRef`.
 *
 * What a view row is: the register rows that APPLY to an attendee — rows
 * naming the Worker; rows naming the Worker's Agent in this App (a Worker
 * inherits its Agent-in-App rows); rows with no attendee owned by this App or
 * by the org — collapsed to ONE row per Channel by precedence: App › org per
 * owner (namespaced, never unioned — the winning owner's `role` / `mentionOnly`
 * stand), and within an owner the most specific attendee wins (Worker › Agent
 * › everyone). Joined with the Channel's watermark (`lastSeq`,
 * `lastMessageAt`) and the attendee's read-state (Phase 7 — null until then).
 *
 * The register NEVER grants (D-008): `canRead` / `canPost` use the EXISTING
 * host-memory gates (`getAccessibleMemoryIds`, `requireMemoryWriteAccess`,
 * `isAppParticipant`). Operational callers evaluate their authenticated actor;
 * attendee-facing projections may supply a separate access subject. The host
 * memory's identity is disclosed only when the VIEWER may read it (§8.2).
 */

import type { Prisma, RegisterEntry } from '../generated/prisma/index.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import {
  getAccessibleMemoryIds,
  isAppParticipant,
  requireMemoryWriteAccess,
} from '../api/graphql/schema/resolvers.helpers.js';
import { composeWorkerUrn } from './entityRef/workerRef.js';
import { normalizeUrnForLookup } from './urn.js';
import { emitEntityUrnV2 } from './urnEmit.js';
import { readStatesFor } from './channelReadState.js';
import { openSessionPlacement } from './sessionPlacement.js';

/** v2 entity URN for display; falls back to the bare urn (display strings never throw). */
function safeEmitEntityUrnV2(type: 'memory' | 'agent', bareUrn: string): string {
  try {
    return emitEntityUrnV2(type, bareUrn);
  } catch {
    return bareUrn;
  }
}

/** S5 — the closed disclosure vocabulary, rendered identically by every consumer. */
export type RegisterDisclosure =
  | 'HOST_MEMORY_NOT_READABLE'
  | 'HOST_MEMORY_NOT_WRITABLE'
  | 'CHANNEL_DELETED'
  | 'DRIVER_NOT_PARTICIPANT'
  | 'UNKNOWN_ACTOR'
  | 'IMPERSONATION';

export type RegisterAttendee = { workerId: string } | { agentId: string; appId: string };

export interface RegisterViewRow {
  entry: {
    id: string;
    ownerType: 'ORGANIZATION' | 'APP';
    ownerId: string;
    role: 'WATCH' | 'POST' | 'BOTH';
    mentionOnly: boolean;
    installDefault: boolean;
    description: string | null;
    /** Which attendee column the winning row named: the Worker, the Agent, or nobody. */
    namedBy: 'WORKER' | 'AGENT' | 'EVERYONE';
  };
  channel: {
    id: string;
    name: string;
    kind: string;
    loc: string;
    /** The host memory's URN — only when the viewer may read it (§8.2); else null. */
    hostMemoryUrn: string | null;
    hostMemoryId: string | null;
    lastSeq: number;
    lastMessageAt: Date | null;
    deleted: boolean;
  };
  /** Phase 7 — the attendee's cursor; null until read-state lands. */
  readState: { lastSeenSeq: number } | null;
  canRead: boolean;
  /** `UNKNOWN` when no access subject was supplied. */
  canPost: boolean | 'UNKNOWN';
  /** S5 — why the access subject cannot act, when it cannot. */
  disclosure: RegisterDisclosure | null;
  attendeeUrn: string | null;
  /** The winning register row itself — what the GraphQL `entry` field serves. */
  raw: RegisterEntry;
}

export interface RegisterView {
  attendee: RegisterAttendee;
  attendeeUrn: string | null;
  rows: RegisterViewRow[];
}

type EntryRow = RegisterEntry;

/** The attendee as columns: the Worker and its Agent-in-App, or a bare Agent-in-App. */
async function attendeeColumns(
  db: Context['db'],
  attendee: RegisterAttendee,
  actingSessionId?: string | null,
): Promise<{ workerId: string | null; agentId: string; appId: string; organizationId: string | null; attendeeUrn: string | null; heldByUserId: string | null } | null> {
  if ('workerId' in attendee) {
    const w = await db.worker.findUnique({
      where: { id: attendee.workerId },
      select: { id: true, agentId: true, appId: true, slug: true, heldByUserId: true, app: { select: { urn: true, organizationId: true } } },
    });
    if (!w) return null;
    let urn: string | null = null;
    try {
      urn = composeWorkerUrn(normalizeUrnForLookup(w.app.urn), w.slug);
    } catch {
      urn = null;
    }
    // #2458 (cor:dmo:050:11): the worker's OWN open session finishes under the agent it was bound with; any other reader
    // sees the live row.
    const placed = actingSessionId ? await openSessionPlacement(db, w.id, actingSessionId) : null;
    return { workerId: w.id, agentId: placed?.agentId ?? w.agentId, appId: w.appId, organizationId: w.app.organizationId, attendeeUrn: urn, heldByUserId: w.heldByUserId };
  }
  // An Agent-in-App attendee EXISTS only as a live install: without the
  // AppAgent row the pair is fabricated, and resolving it would hand the
  // caller the App's EVERYONE rows plus a foreign Agent's URN (Codex P1 on
  // PR #1167) — the same relationship the register-write and run-mint gates
  // require.
  const [agent, app, install] = await Promise.all([
    db.agent.findFirst({ where: { id: attendee.agentId, deletedAt: null }, select: { urn: true } }),
    db.app.findFirst({ where: { id: attendee.appId, deletedAt: null }, select: { organizationId: true } }),
    db.appAgent.findUnique({ where: { appId_agentId: { appId: attendee.appId, agentId: attendee.agentId } }, select: { agentId: true } }),
  ]);
  if (!agent || !app || !install) return null;
  return {
    workerId: null,
    agentId: attendee.agentId,
    appId: attendee.appId,
    organizationId: app.organizationId,
    attendeeUrn: safeEmitEntityUrnV2('agent', agent.urn),
    heldByUserId: null,
  };
}

/** A Worker has no credential: its durable holder is the driver to evaluate. */
async function attendeeAccessActor(
  db: Context['db'],
  columns: NonNullable<Awaited<ReturnType<typeof attendeeColumns>>>,
): Promise<{ actor: Context; unavailableReason: null } | { actor: null; unavailableReason: RegisterDisclosure }> {
  if (!columns.workerId) return { actor: { db, appId: columns.appId }, unavailableReason: null };
  if (!columns.heldByUserId) return { actor: null, unavailableReason: 'UNKNOWN_ACTOR' };
  const holder = await db.user.findFirst({
    where: { id: columns.heldByUserId, deletedAt: null },
    select: { id: true, roles: true },
  });
  if (!holder) return { actor: null, unavailableReason: 'UNKNOWN_ACTOR' };
  const actor: Context = { db, userId: holder.id, roles: holder.roles };
  // A holder can lose participation while retaining independent access to a
  // Channel. Then they cannot act AS this Worker even if they can read it as
  // themselves (the same current-App gate as Worker cursor ownership, #1353).
  const app = await db.app.findFirst({
    where: { id: columns.appId, deletedAt: null, uninstalledAt: null },
    select: { id: true, organizationId: true, ownerUserId: true },
  });
  if (!app || !(await isAppParticipant(actor, app))) {
    // The holder is no longer an eligible Worker driver. No actor can be
    // supplied for this projection; HOST/DRIVER_NOT_PARTICIPANT would claim
    // something about the Channel's host App that may be false.
    return { actor: null, unavailableReason: 'UNKNOWN_ACTOR' };
  }
  return { actor, unavailableReason: null };
}

/** Precedence: App › org; within an owner Worker › Agent › everyone. Lower is stronger. */
function rank(e: EntryRow): number {
  const owner = e.appId ? 0 : 10;
  const specificity = e.attendeeWorkerId ? 0 : e.attendeeAgentId ? 1 : 2;
  return owner + specificity;
}

/**
 * The rows that apply to an attendee, collapsed to one per Channel (App › org,
 * Worker › Agent › everyone). Rows only — no gates, no watermarks; what the
 * run snapshot stores and `resolveRegister` builds its view from.
 */
export async function collectRegisterRows(db: Context['db'], attendee: RegisterAttendee, actingSessionId?: string | null): Promise<{ columns: NonNullable<Awaited<ReturnType<typeof attendeeColumns>>>; rows: EntryRow[] } | null> {
  const columns = await attendeeColumns(db, attendee, actingSessionId);
  if (!columns) return null;
  const arms: Prisma.RegisterEntryWhereInput[] = [
    // Named the Agent in this App (App-owned), or the Agent anywhere in the org (org-owned).
    { appId: columns.appId, attendeeAgentId: columns.agentId },
    // Everyone in this App.
    { appId: columns.appId, attendeeWorkerId: null, attendeeAgentId: null },
  ];
  if (columns.workerId) arms.push({ attendeeWorkerId: columns.workerId });
  if (columns.organizationId) {
    arms.push({ organizationId: columns.organizationId, attendeeAgentId: columns.agentId });
    arms.push({ organizationId: columns.organizationId, attendeeWorkerId: null, attendeeAgentId: null });
  }
  const rows = await db.registerEntry.findMany({
    where: { deletedAt: null, OR: arms },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const byChannel = new Map<string, EntryRow>();
  for (const r of rows) {
    const held = byChannel.get(r.channelId);
    if (!held || rank(r) < rank(held)) byChannel.set(r.channelId, r);
  }
  return { columns, rows: [...byChannel.values()] };
}

export interface ResolveRegisterArgs {
  attendee: RegisterAttendee;
  /** The authenticated viewer. Also decides canRead / canPost by default. */
  actor?: Context | null;
  /** Display-only override; ATTENDEE resolves a Worker's holder or an Agent's App principal. */
  accessActor?: Context | null | 'ATTENDEE';
  /** Rows already collected (a run's snapshot) — otherwise collected live. */
  rows?: EntryRow[];
}

/**
 * The attendee's register as a VIEW: one row per Channel, the watermark, and
 * the access subject's real read/post standing on the host memory with S5's
 * reason when it cannot act. Null when the attendee does not exist.
 */
export async function resolveRegister(db: Context['db'], args: ResolveRegisterArgs): Promise<RegisterView | null> {
  const collected = args.rows
    ? await (async () => {
        const columns = await attendeeColumns(db, args.attendee, args.actor?.sessionId);
        return columns ? { columns, rows: args.rows! } : null;
      })()
    : await collectRegisterRows(db, args.attendee, args.actor?.sessionId);
  if (!collected) return null;
  const { columns, rows } = collected;
  const viewer = args.actor ?? null;
  const attendeeAccess = args.accessActor === 'ATTENDEE'
    ? await attendeeAccessActor(db, columns)
    : null;
  const actor: Context | null = args.accessActor === 'ATTENDEE'
    ? attendeeAccess!.actor
    : args.accessActor === undefined ? viewer : args.accessActor;
  const channelIds = [...new Set(rows.map((r) => r.channelId))];
  const channels = new Map(
    (
      await db.channel.findMany({
        where: { id: { in: channelIds } },
        select: {
          id: true, name: true, kind: true, loc: true, memoryId: true, lastSeq: true, lastMessageAt: true, deletedAt: true,
          memory: { select: { urn: true, appId: true, app: { select: { id: true, organizationId: true, ownerUserId: true, deletedAt: true } } } },
        },
      })
    ).map((c) => [c.id, c]),
  );
  const viewerAccessible = viewer ? await getAccessibleMemoryIds(viewer) : null;
  const accessible = actor === viewer ? viewerAccessible : actor ? await getAccessibleMemoryIds(actor) : null;
  // The two post-side gates, decided ONCE per host App and per host memory:
  // a register is unbounded and this runs on every briefing render, so the
  // N rows of one App must not cost N gate round trips (Copilot on PR #1167).
  const participantByApp = new Map<string, Promise<boolean>>();
  const participantOf = (app: { id: string; organizationId: string | null; ownerUserId: string | null }) => {
    let p = participantByApp.get(app.id);
    if (!p) {
      p = isAppParticipant(actor!, app);
      participantByApp.set(app.id, p);
    }
    return p;
  };
  const writableByMemory = new Map<string, Promise<boolean>>();
  const writableMemory = (memoryId: string) => {
    let p = writableByMemory.get(memoryId);
    if (!p) {
      p = requireMemoryWriteAccess(actor!, memoryId).then(() => true, () => false);
      writableByMemory.set(memoryId, p);
    }
    return p;
  };
  // Phase 7 — the attendee's cursors, joined per Channel (0 when none).
  const cursors = await readStatesFor(db, args.attendee, channelIds);
  const view: RegisterViewRow[] = [];
  for (const e of rows) {
    const c = channels.get(e.channelId);
    if (!c) continue;
    const canRead = !!actor && (accessible === null || accessible.includes(c.memoryId));
    const viewerCanRead = !!viewer && (viewerAccessible === null || viewerAccessible.includes(c.memoryId));
    let canPost: boolean | 'UNKNOWN' = 'UNKNOWN';
    let disclosure: RegisterDisclosure | null = null;
    if (c.deletedAt) {
      disclosure = 'CHANNEL_DELETED';
      canPost = actor || args.accessActor === 'ATTENDEE' ? false : 'UNKNOWN';
    } else if (!actor) {
      disclosure = attendeeAccess?.unavailableReason ?? 'UNKNOWN_ACTOR';
      // An unheld Worker has no driver, so the attendee-facing projection
      // reports false rather than an unevaluated posting capability.
      if (args.accessActor === 'ATTENDEE') canPost = false;
    } else if (actor.impersonation) {
      canPost = false;
      disclosure = canRead ? 'IMPERSONATION' : 'HOST_MEMORY_NOT_READABLE';
    } else if (!canRead) {
      canPost = false;
      disclosure = 'HOST_MEMORY_NOT_READABLE';
    } else {
      // The post gate is the host memory's write gate — and, for a Channel
      // hosted in an App, the driver must be that App's participant
      // (`cor:acl:030:01`: participation follows the host memory's audience).
      const hostApp = c.memory.app && !c.memory.app.deletedAt ? c.memory.app : null;
      const participant = hostApp ? await participantOf(hostApp) : true;
      if (!participant && actor.userId) {
        canPost = false;
        disclosure = 'DRIVER_NOT_PARTICIPANT';
      } else if (await writableMemory(c.memoryId)) {
        canPost = true;
      } else {
        canPost = false;
        disclosure = 'HOST_MEMORY_NOT_WRITABLE';
      }
    }
    view.push({
      entry: {
        id: e.id,
        ownerType: e.appId ? 'APP' : 'ORGANIZATION',
        ownerId: (e.appId ?? e.organizationId) as string,
        role: e.role,
        mentionOnly: e.mentionOnly,
        installDefault: e.installDefault,
        description: e.description,
        namedBy: e.attendeeWorkerId ? 'WORKER' : e.attendeeAgentId ? 'AGENT' : 'EVERYONE',
      },
      channel: {
        id: c.id,
        name: c.name,
        kind: c.kind,
        loc: c.loc,
        // Both the URN and the id are disclosed under the canonical read gate
        // (§8.2): an unreadable host memory's primary key is as much an
        // existence oracle as its URN (Codex P1 on PR #1167).
        hostMemoryUrn: viewerCanRead ? safeEmitEntityUrnV2('memory', c.memory.urn) : null,
        hostMemoryId: viewerCanRead ? c.memoryId : null,
        lastSeq: c.lastSeq,
        lastMessageAt: c.lastMessageAt,
        deleted: !!c.deletedAt,
      },
      readState: cursors.has(c.id) ? { lastSeenSeq: cursors.get(c.id)! } : null,
      canRead,
      canPost,
      disclosure,
      attendeeUrn: columns.attendeeUrn,
      raw: e,
    });
  }
  view.sort((a, b) => a.channel.loc.localeCompare(b.channel.loc) || a.channel.id.localeCompare(b.channel.id));
  return { attendee: args.attendee, attendeeUrn: columns.attendeeUrn, rows: view };
}

/** The shape a run's `registerSnapshot` stores: the collapsed rows, no gates, no watermarks. */
export interface RunRegisterSnapshot {
  attendee: { agentId: string; appId: string };
  rows: Array<{
    id: string; channelId: string; organizationId: string | null; appId: string | null;
    attendeeWorkerId: string | null; attendeeAgentId: string | null;
    role: 'WATCH' | 'POST' | 'BOTH'; mentionOnly: boolean; installDefault: boolean; description: string | null;
    /** The row's audit columns as ISO strings — a snapshot row serves the public `RegisterEntry` type and must not fabricate them. */
    createdAt: string; createdBy: string | null; updatedAt: string | null; updatedBy: string | null;
  }>;
}

/** Snapshot an Agent-in-App attendee's register for a run at mint; null when the attendee does not resolve. */
export async function snapshotRegisterForRun(db: Context['db'], agentId: string, appId: string): Promise<RunRegisterSnapshot | null> {
  const collected = await collectRegisterRows(db, { agentId, appId });
  if (!collected) return null;
  return {
    attendee: { agentId, appId },
    rows: collected.rows.map((r) => ({
      id: r.id, channelId: r.channelId, organizationId: r.organizationId, appId: r.appId,
      attendeeWorkerId: r.attendeeWorkerId, attendeeAgentId: r.attendeeAgentId,
      role: r.role, mentionOnly: r.mentionOnly, installDefault: r.installDefault, description: r.description,
      createdAt: r.createdAt.toISOString(), createdBy: r.createdBy, updatedAt: r.updatedAt?.toISOString() ?? null, updatedBy: r.updatedBy,
    })),
  };
}

/** Read a stored snapshot back, tolerating anything that is not one (⇒ null). */
export function parseRunRegisterSnapshot(raw: unknown): RunRegisterSnapshot | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const a = o.attendee as Record<string, unknown> | undefined;
  if (!a || typeof a.agentId !== 'string' || typeof a.appId !== 'string' || !Array.isArray(o.rows)) return null;
  return o as unknown as RunRegisterSnapshot;
}

/**
 * A snapshot's rows as the entry rows `resolveRegister` consumes. The audit
 * columns are the snapshotted ones (Copilot on PR #1167: a fabricated epoch
 * would surface as `entry.createdAt` through the public type); a row from a
 * pre-audit snapshot falls back to the epoch rather than failing the read.
 */
export function snapshotRowsAsEntries(snap: RunRegisterSnapshot): EntryRow[] {
  return snap.rows.map(
    (r) =>
      ({
        ...r,
        createdAt: r.createdAt ? new Date(r.createdAt) : new Date(0),
        createdBy: r.createdBy ?? null,
        updatedAt: r.updatedAt ? new Date(r.updatedAt) : null,
        updatedBy: r.updatedBy ?? null,
        deletedAt: null,
        deletedBy: null,
      }) as EntryRow,
  );
}

/** The view as the GraphQL `RegisterViewRow` list: the raw entry row for the nested `RegisterEntry` field. */
export function toGqlRegisterRows(view: RegisterView) {
  return view.rows.map((r) => ({
    entry: r.raw,
    namedBy: r.entry.namedBy,
    channel: r.channel,
    lastSeenSeq: r.readState?.lastSeenSeq ?? null,
    canRead: r.canRead,
    canPost: r.canPost === 'UNKNOWN' ? null : r.canPost,
    disclosure: r.disclosure,
    attendeeUrn: r.attendeeUrn,
  }));
}

/** S5's reason as one human line. */
export function describeDisclosure(d: RegisterDisclosure): string {
  switch (d) {
    case 'HOST_MEMORY_NOT_READABLE': return 'you cannot read its host memory';
    case 'HOST_MEMORY_NOT_WRITABLE': return 'you cannot write its host memory (watch only)';
    case 'CHANNEL_DELETED': return 'the Channel is deleted';
    case 'DRIVER_NOT_PARTICIPANT': return 'your driver is not a participant of the host App (watch only)';
    case 'UNKNOWN_ACTOR': return 'posting rights not evaluated (no actor)';
    case 'IMPERSONATION': return 'support view — read only';
  }
}

/**
 * The register as a briefing block — DERIVED data, never an authored prompt
 * part. Both the Worker resolver (`Worker.prompt`) and the run kernel call
 * this one function, so when the D11 composer lands it absorbs one function
 * rather than a fourth string-concatenation path. Returns '' for an attendee
 * with no rows, so a caller can append it unconditionally.
 */
export function renderDerivedBlocks(view: RegisterView | null): string {
  if (!view || view.rows.length === 0) return '';
  const lines = view.rows.map((r) => {
    const where = r.channel.hostMemoryUrn ? `${r.channel.hostMemoryUrn}:${r.channel.loc}` : `${r.channel.loc} (host memory hidden from this viewer)`;
    let standing: string;
    if (r.disclosure === 'UNKNOWN_ACTOR' && r.canPost === false) {
      standing = 'no eligible driver (read + post unavailable)';
    } else if (r.disclosure) {
      standing = describeDisclosure(r.disclosure);
    } else {
      standing = r.canPost === true ? 'read + post' : r.canPost === false ? 'read only' : 'read';
    }
    const flags = [r.entry.role.toLowerCase(), ...(r.entry.mentionOnly ? ['mention-only'] : []), ...(r.entry.installDefault ? ['install default'] : [])].join(', ');
    const seen = r.readState?.lastSeenSeq ?? 0;
    const water =
      r.channel.lastSeq > 0
        ? r.channel.lastSeq > seen
          ? `new since seq ${seen} (channel is at ${r.channel.lastSeq})`
          : `nothing new (at seq ${r.channel.lastSeq})`
        : 'no messages yet';
    return `- ${r.channel.name} — ${where}: ${flags}; ${standing}; ${water}${r.entry.description ? `\n  ${r.entry.description}` : ''}`;
  });
  return `## Channels (register)\n${lines.join('\n')}`;
}
