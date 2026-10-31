import { buildTeamSnapshot, isReadableTeamHead, teamTagsEnabled, teamHeadInvalid, type TeamTagSnapshot } from '../../../lib/teamTagSnapshot.js';
import { lockAppReportsTo } from '../../../lib/workerReportsTo.js';
import { requireWorkerReadAccess } from './resolvers.worker.js';
// Team-chat operations — #939: createTeamChatMessage + teamChatMessages as
// platform operations (team logic lives server-side; CLI/MCP/portal are thin
// surfaces — the #935/#936 wrapper precedent).
//
// Placement (owned by this operation — the specific-product half of
// Q-2026-08-10-001, which deferred a placement scheme for the GENERIC chat
// surface only): the team chat is ONE well-known chat per team App, at loc
// `chats:team` in the TEAM AGENT's shared app-class memory (the
// `findOrCreateAppClassMemory` (app, agent) pair — D-2026-08-11: "the Team
// Agent's shared app memory is the team space"). It is bootstrapped on first
// post; reads never provision anything. Lookup is by loc across the App's
// app-class memories (oldest root wins, deterministically) so an
// already-bootstrapped chat is found without locating the Team Agent at all.
//
// Storage shape (D-2026-08-07-001/-004, kept field-compatible with the #921
// storage rework so it can absorb this surface without a data migration):
//   - chat root: nodeType `chat`, storage keys (`messageCount`,
//     `lastMessageAt`) top-level in `data`; there is no root-level audience
//     marker because access derives from the host memory.
//   - message: body in `Node.content`, envelope in `Node.data`, nodeType
//     `chat-message`, ordering key in `Node.seq` (allocated atomically by
//     `chatRoot.appendChatMessage` — #919; a hand-rolled node write here IS
//     the bug that operation exists to prevent).
//
// Envelope (`Node.data`) fields (#974 re-cut — the Worker model, cor:agt:020:04):
//   authorUserId   — the human author (no sessionRef; #914 parity)
//   authorWorkerId — the Worker author (sessionRef path; replaced the
//                    persona-as-agent model's authorAgentId, D-2026-08-14-004)
//   authorName     — display convenience: worker name / user handle
//   sessionId      — the driving session (sessionRef path; D16 attribution)
//   mentions       — lowercased mention tokens extracted server-side at write
//   replyToSeq     — the seq this message replies to (also a `replies-to` edge)
import { GraphQLError, type GraphQLResolveInfo } from 'graphql';
import { selectsField } from '../selectsField.js';
import { Prisma } from '../../../generated/prisma/index.js';
import type { InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import { generateId } from '../../../lib/id.js';
import { appendChatMessage } from '../../../lib/chatRoot.js';
import { raisePostLimitAlarm } from '../../../lib/agentTasks/postLimit.js';
import { admissionTime, findBrokenPostLimit, findEarlierDuplicate, lockWorkerPostAdmission } from '../../../lib/teamChatAdmission.js';
import { lockStampAuthority, wakeStampsFor } from '../../../lib/tickers/postStamp.js';
import { deriveEdgeLoc, sanitizeLocAtom } from '../../../lib/edgeLoc.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveChannelRefId } from '../../../lib/entityRef/channelRef.js';
import { resolveUserRef } from '../../../lib/entityRef/userRef.js';
import {
  getMemoryEncryptionInfo,
  decryptNodeFields,
  encryptNodeFields,
  type MemoryEncryptionInfo,
} from '../../../lib/nodeCrypto.js';
import {
  type Context,
  isAppParticipant,
  requireSessionWriteAccess,
  requireMemoryWriteAccess,
  getAccessibleMemoryIds,
  clampListTake,
} from './resolvers.helpers.js';
import { isSessionLive, loadLastEventBySession, touchLiveSession } from '../../../lib/sessionActivity.js';
import { findOrCreateAppClassMemory } from './chat-scope.js';
import { mentionTokenOf, BROADCAST_MENTION_TOKENS } from '../../../lib/mentionToken.js';
import { reachesWorker } from '../../../lib/mentionReach.js';
import { extractMentions } from '../../../lib/teamChatMentions.js';
import { TEAM_CHAT_LOC, TEAM_CHAT_MESSAGES_LOC } from '../../../lib/teamChatLoc.js';
import { recordCheckMiss } from '../../../lib/channelReadState.js';
import {
  TEAM_CHAT_SEARCH_SCAN_CAP, assertSearchQuery, decodeSearchCursor, encodeSearchCursor, searchBinding, searchCallerKey, searchPageSize,
} from '../../../lib/teamChatSearch.js';
import { isTeamSpaceRow, teamSpaceAudienceFilter, teamSpaceOwnerFilter } from '../../../lib/auth/teamSpace.js';
// Spec 049 Phase 4 — the Channel row the team chat became.
import { DEFAULT_CHANNEL_NAME, ensureChannelWithRoot } from '../../../lib/channels.js';
import { locateTeamAgent } from './resolvers.worker.js';
import { recordNodeUsage, recordNodeWrite } from '../../../lib/usageRecorder.js';
import { escapePrismaLikePattern } from '../../../lib/literalLocPrefix.js';
import { nodeUrnRoundTrips, safeNodeUrnV2 } from '../../../lib/urnEmit.js';
import { recordMentionsWorker } from '../../../lib/mentionsReadResolution.js';
import {
  maybeAdvanceOwnChannelRead,
  lapsedResumeVerdict,
  resumeOwnLapsedSessionInTx,
  mayStillDriveWorkerApp,
  channelIncarnationChanged,
} from '../../../lib/teamAttention.js';

// The team-chat locs moved to src/lib/teamChatLoc.ts (#1030): the agent-chat
// listing and the shared chat-loc gate both have to exclude `chats:team`, and
// neither may import this resolver — same move as `mentionTokenOf` below.
// Re-exported so existing importers are unchanged.
export { TEAM_CHAT_LOC, TEAM_CHAT_MESSAGES_LOC };
/**
 * Body size cap (#939 — documented decision): 64 KiB of text. Generous enough
 * for pasted diffs/logs (the working currency of a coding team), small enough
 * that a chat stays a chat — larger artifacts belong in their own node with a
 * link. Typed refusal: TEAM_CHAT_BODY_TOO_LARGE.
 */
export const TEAM_CHAT_BODY_MAX_CHARS = 65_536;

const forbidden = (): GraphQLError =>
  new GraphQLError('You are not authorized to use this App\'s team chat.', {
    extensions: { code: 'FORBIDDEN' },
  });

/**
 * (#1509) The refusal for a caller with NO principal at all: no user and no App
 * key (no token, an expired JWT, a garbage bearer). It is not a lack of rights,
 * so it must not read as FORBIDDEN ("needs App membership"): a client has to be
 * able to tell "sign in again" from "you are not a participant" without parsing
 * prose (`conventions:the-error-code-is-the-contract-the-prose-is-not`).
 */
const unauthenticated = (): GraphQLError =>
  new GraphQLError('Authentication required', { extensions: { code: 'UNAUTHENTICATED' } });

/**
 * (#1509) Refuse a principal-less caller BEFORE any lookup, so the answer is
 * the same whether or not the App (or anything it names) exists. Called first
 * on the appRef team-chat surfaces, which never admit an anonymous caller.
 */
function requirePrincipal(ctx: Context): void {
  if (!ctx.userId && !ctx.appId) throw unauthenticated();
}

// Keep the public resolver export for existing callers and tests.
export { extractMentions };

// The mention token moved to src/lib/mentionToken.ts (PR #978 review): worker
// casting has to refuse a name whose token is taken, and that resolver must not
// import this one. Re-exported so existing importers are unchanged.
export { mentionTokenOf };

type AppRow = {
  id: string;
  name: string;
  urn: string;
  organizationId: string | null;
  ownerUserId: string | null;
  uninstalledAt: Date | null;
};

/**
 * #939 membership gate. Posting and reading are both team-member acts
 * (`cor:acl:030:01` — every member of the owning App is a participant in
 * every chat in its shared memory, so unlike worker casting the gate does
 * NOT exclude 'reader' AppMembers: participation follows the host memory's
 * audience, and app-class grants read and write to the same audience).
 * May post/read: an AppMember of the team App (any role), an org member with
 * CONTRIBUTOR+ on the App's org (parity with the worker-staffing gate's org
 * branch), or the owner of a user-owned App.
 *
 * Principal shapes (findings:auth-appid-credential-vs-selection): a PURE
 * App-key principal is DENIED for `post` (the documented lean — a chat
 * message is authored, and authorship is a human or a session-driven worker
 * with a human driver behind it) but ALLOWED for `read` when the key IS this
 * App's (the App's own automation may read its team's chat). A hybrid
 * user+selection principal is judged solely on the USER's own rights.
 * Impersonation may read but never post, and its reads are bounded to the
 * support session's SINGLE org (#876 class; Copilot on PR #941): the org
 * check runs BEFORE the owner/AppMember shortcuts, so a target's user-owned
 * App or cross-org membership never widens the support view.
 */
async function requireTeamChatAccess(
  ctx: Context,
  app: AppRow,
  mode: 'post' | 'read',
): Promise<void> {
  if (ctx.impersonation) {
    if (
      mode === 'post' ||
      app.organizationId === null ||
      app.organizationId !== ctx.impersonation.orgId
    ) {
      throw forbidden();
    }
  }
  if (!ctx.userId) {
    // Pure App-key principal: read-only, and only for its own App.
    if (mode === 'read' && ctx.appId && ctx.appId === app.id) return;
    // A caller with NO principal never reaches here on the appRef surfaces:
    // they refuse it UNAUTHENTICATED before any lookup (requirePrincipal,
    // #1509). The Channel surfaces deliberately answer it CHANNEL_NOT_FOUND
    // instead, identically to a missing ref, so the refusal stays FORBIDDEN.
    throw forbidden();
  }
  // The user branch is the shared App-participation predicate (#943 extracted
  // it to resolvers.helpers so startSession's appRef gate is the SAME rule,
  // not a second copy that can drift): AppMember at any role, org CONTRIBUTOR+,
  // or the owner of a user-owned App.
  if (await isAppParticipant(ctx, app)) return;
  throw forbidden();
}

/**
 * How the platform's own posts render (#1791). A name no handle can take (handles carry no spaces or parentheses), so
 * it cannot be mistaken for a person; the structured flag `authorSystem` is what clients key on.
 */
export const SYSTEM_AUTHOR_NAME = 'Hadron (platform)';

type ChatRootRow = { id: string; memoryId: string; loc: string };
type ChannelIncarnation = { id: string; value: number };

/**
 * Find the team chat root among the App's app-class memories. Memory-scoped
 * by construction (findings:unscoped-loc-lookup-crosses-memories): the loc
 * match never leaves this App's own memories. Oldest root wins so the answer
 * is deterministic even if a second `chats:team` was hand-created in another
 * installed agent's shared memory.
 */
async function locateTeamChatRoot(ctx: Context, app: AppRow): Promise<ChatRootRow | null> {
  const appId = app.id;
  return ctx.db.node.findFirst({
    // loc-scope-ok: deliberately spans the App's OWN app-class memories (one
    // per installed agent) — the relation filter is the tenant scope (#939).
    where: {
      loc: TEAM_CHAT_LOC,
      // Spec 049: only a chat root is the team chat. A live non-chat node
      // squatting the address is not adopted — the bootstrap refuses it
      // (LOC_OCCUPIED) rather than posting into an arbitrary record.
      nodeType: 'chat',
      deletedAt: null,
      // #1207 round 5 (@copilot): `appId + class='app'` selects all FOUR
      // app-class row roles, so this locator could return a `chats:team` root
      // in a Worker's casting memory or a per-user session memory — and both
      // App-ref conveniences then handed it the participation gate and the
      // impersonation shortcut. Same narrowing as `resolveChannelTarget`, from
      // the same shared predicate rather than a fourth copy of it.
      memory: {
        appId,
        ...teamSpaceAudienceFilter,
        ...teamSpaceOwnerFilter({
          appOwnerUserId: app.ownerUserId,
          impersonating: !!ctx.impersonation,
        }),
      },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, memoryId: true, loc: true },
  });
}

/**
 * The Channel the App-ref convenience read (`teamChatMessages`) actually
 * serves: its root is `locateTeamChatRoot`'s — the OLDEST live team-space
 * `chats:team` — which need not be `App.defaultChannel`. A caller advancing a
 * cursor around that read must capture THIS Channel, before the read, with
 * the same context the resolver gets (#1362 review, Codex P2).
 */
export async function locateTeamChatChannel(
  ctx: Context,
  appId: string,
): Promise<{ rootId: string; channelId: string; lastSeq: number } | null> {
  const app = await ctx.db.app.findUnique({ where: { id: appId } });
  if (!app) return null;
  const root = await locateTeamChatRoot(ctx, app);
  if (!root) return null;
  const channel = await ctx.db.channel.findFirst({
    where: { chatRootNodeId: root.id, deletedAt: null },
    select: { id: true, lastSeq: true },
  });
  return channel ? { rootId: root.id, channelId: channel.id, lastSeq: channel.lastSeq } : null;
}

/**
 * First-post bootstrap: provision the Team Agent's shared app-class memory
 * (idempotent, race-safe) and create the `chats` parent, the chat root, and
 * the `chats:team:messages` container in it. Race-safe: a concurrent first
 * post loses the root create on `@@unique([loc, memoryId])` (P2002) and
 * re-reads the winner's row.
 *
 * The Team Agent is located exactly as castWorker does (the roles:
 * branch marker), with one chat-specific fallback: an App with EXACTLY ONE
 * installed Agent needs no marker to be unambiguous — a single-agent team App
 * without role definitions can still chat.
 */
async function bootstrapTeamChat(
  ctx: Context,
  app: AppRow,
): Promise<{ root: ChatRootRow; incarnation: ChannelIncarnation }> {
  let teamAgent: { id: string; name: string; urn: string };
  try {
    teamAgent = await locateTeamAgent(ctx, app.id, null);
  } catch (e) {
    if (!(e instanceof GraphQLError) || e.extensions?.code !== 'TEAM_AGENT_NOT_FOUND') throw e;
    const installed = await ctx.db.appAgent.findMany({
      where: { appId: app.id },
      select: { agent: { select: { id: true, name: true, urn: true, deletedAt: true } } },
    });
    const live = installed.map((r) => r.agent).filter((a) => a && !a.deletedAt);
    if (live.length !== 1) throw e;
    teamAgent = live[0];
  }

  const memoryId = await findOrCreateAppClassMemory({
    appId: app.id,
    appUrn: app.urn,
    appName: app.name,
    agentId: teamAgent.id,
    agentUrn: teamAgent.urn,
    agentName: teamAgent.name,
    organizationId: app.organizationId,
    ownerUserId: app.ownerUserId,
    // Post requires a user identity (requireTeamChatAccess), so this is set.
    actingUserId: ctx.userId!,
    db: ctx.db,
  });

  // ONE creation core. The old bootstrap reimplemented create-or-restore and
  // missed #1226's clean-incarnation reset, so the default team-chat path
  // resurrected the transcript even after createChannel had been fixed.
  const { channel, rootId } = await ensureChannelWithRoot(ctx.db, {
    memoryId,
    loc: TEAM_CHAT_LOC,
    name: DEFAULT_CHANNEL_NAME,
    description: `Team chat — ${app.name}`,
    createdBy: ctx.userId ?? null,
    asDefaultOfAppId: app.id,
    hostLabel: app.name,
  });
  return {
    root: { id: rootId, memoryId, loc: TEAM_CHAT_LOC },
    incarnation: { id: channel.id, value: channel.incarnation },
  };
}

/**
 * Run an encrypt/decrypt step, mapping the crypto layer's plain
 * `SESSION_EXPIRED` Error to the typed GraphQLError — WITHOUT this, Apollo
 * stamps INTERNAL_SERVER_ERROR and the advertised code never reaches the
 * client (conventions:typed-error-must-be-registered-in-formaterror; the
 * encrypt side was Codex P2 on PR #941).
 */
function translateSessionExpired<T>(memEncInfo: MemoryEncryptionInfo, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('SESSION_EXPIRED')) {
      throw new GraphQLError(
        `SESSION_EXPIRED: memory ${memEncInfo.id} is encrypted but no active session key is available.`,
        { extensions: { code: 'SESSION_EXPIRED', memoryId: memEncInfo.id } },
      );
    }
    throw e;
  }
}

/** Map a decrypt failure on an encrypted memory to the typed SESSION_EXPIRED. */
function decryptOrSessionExpired<T extends { content?: string | null; data?: unknown }>(
  node: T,
  memEncInfo: MemoryEncryptionInfo,
): T {
  return translateSessionExpired(memEncInfo, () => decryptNodeFields(node, memEncInfo));
}

/** GraphQL shape of one team-chat message. (Exported — TS4023: a resolver map
 * exported from resolvers.ts cannot use a non-exported interface.) */
export interface TeamChatMessageOut {
  nodeId: string;
  /** The message node's canonical URN (#1209); null only when it cannot be emitted. See `messageUrn`. */
  urn: string | null;
  seq: number;
  body: string;
  at: Date;
  authorUserId: string | null;
  authorWorkerId: string | null;
  /** #1791: posted by the platform itself, a system author that is neither a user nor a worker. */
  authorSystem: boolean;
  authorName: string | null;
  /** Item J: the Worker's App when a post crossed Apps; null otherwise. */
  authorAppId: string | null;
  sessionId: string | null;
  replyToSeq: number | null;
  mentions: string[];
  /**
   * #2020: the post-time stamp (cor:agt:080:14) — the author could wake
   * everyone. Internal routing input for the reach rule (`lib/mentionReach.ts`);
   * deliberately not in the SDL.
   */
  broadcastWakes: boolean;
  teamTagsVersion?: number;
  teamBroadcastWorkerIds?: string[];
  teamTags?: TeamTagSnapshot[] | null;
}

type MessageRow = {
  id: string;
  loc: string;
  seq: number | null;
  content: string | null;
  data: unknown;
  createdAt: Date;
};

/**
 * The host memory's stored URN, loaded ONCE per read or post (#1209): every
 * message on a Channel root lives in that one memory.
 */
async function hostMemoryUrn(ctx: Context, memoryId: string): Promise<string | null> {
  const memory = await ctx.db.memory.findUnique({ where: { id: memoryId }, select: { urn: true } });
  return memory?.urn ?? null;
}

/**
 * A message's canonical URN (#1209), composed server-side because no client can:
 * a message loc carries a random component, so the root and the seq do not
 * reconstruct it. Null — never a best-effort guess — unless the emitted URN
 * RESOLVES BACK to this node. Emitting is not enough: a stored pre-v2 COMPOUND
 * memory urn (the legacy team space `<org>:<app>:<agent>:shared`, a common chat
 * host) emits a flat string without falling back, yet the resolver splits it
 * as a different memory and loc, so it would name nothing (@codex, PR #1317).
 * Same predicate and shape as `Channel.urn`; `Worker.urn`'s nullable contract.
 */
function messageUrn(memBareUrn: string | null, loc: string | null): string | null {
  if (!memBareUrn || !loc) return null;
  return nodeUrnRoundTrips(memBareUrn, loc) ? safeNodeUrnV2(memBareUrn, loc) : null;
}

/** Decrypt a message row and project it onto the GraphQL shape. */
function projectMessage(row: MessageRow, memEncInfo: MemoryEncryptionInfo, memBareUrn: string | null, metadataVisible = false): TeamChatMessageOut {
  const dec = decryptOrSessionExpired({ content: row.content, data: row.data }, memEncInfo);
  const env = (dec.data as Record<string, unknown> | null) ?? {};
  return {
    nodeId: row.id,
    urn: messageUrn(memBareUrn, row.loc),
    seq: row.seq ?? 0,
    body: dec.content ?? '',
    at: row.createdAt,
    authorUserId: typeof env.authorUserId === 'string' ? env.authorUserId : null,
    authorWorkerId: typeof env.authorWorkerId === 'string' ? env.authorWorkerId : null,
    authorSystem: env.authorSystem === true,
    authorName: typeof env.authorName === 'string' ? env.authorName : null,
    authorAppId: typeof env.authorAppId === 'string' ? env.authorAppId : null,
    sessionId: typeof env.sessionId === 'string' ? env.sessionId : null,
    replyToSeq: typeof env.replyToSeq === 'number' ? env.replyToSeq : null,
    mentions: Array.isArray(env.mentions) ? env.mentions.filter((m): m is string => typeof m === 'string') : [],
    broadcastWakes: env.broadcastWakes === true,
    teamTagsVersion: typeof env.teamTagsVersion === 'number' ? env.teamTagsVersion : undefined,
    teamBroadcastWorkerIds: Array.isArray(env.teamBroadcastWorkerIds) ? env.teamBroadcastWorkerIds.filter((id): id is string => typeof id === 'string') : [],
    teamTags: metadataVisible && env.teamTagsVersion === 1 && Array.isArray(env.teamTags) ? env.teamTags.filter((t): t is TeamTagSnapshot => !!t && typeof t === 'object' && typeof t.headId === 'string' && typeof t.label === 'string') : null,
  };
}

/**
 * Resolve the author of a sessionRef post: the session's bound Worker (#974,
 * cor:agt:020:04's four-condition derivation). Refuses a session the caller
 * couldn't write (requireSessionWriteAccess semantics, cor:dmo:070:05 —
 * attributed user only here, since the membership gate already denied pure
 * App-key principals for posts), a session that is not bound to the TARGET
 * App (Codex P1 on PR #941 — without this, a member of Apps A and B could
 * author into B's chat as A's worker), a session that has ended (its worker
 * may since have been freed and taken over — the cor:agt:020:03 liveness
 * model), and a session bound to no Worker.
 */
async function resolveSessionAuthor(
  ctx: Context,
  // #1196: null when the host memory belongs to no App. Every Worker is then
  // "of another App" by construction — there is no host App for one to match —
  // so item J's cross-App arm becomes the ONLY arm, and the question reduces to
  // the one that arm already asks: may this session's driver WRITE the host
  // memory? That is the correct rule rather than a degenerate case of it.
  app: AppRow | null,
  hostMemoryId: string,
  sessionRef: string,
): Promise<{ workerId: string; agentId: string | null; name: string; sessionId: string; workerAppId: string; crossApp: boolean; resume: boolean }> {
  const session = await ctx.db.session.findUnique({
    where: { id: sessionRef },
    select: { id: true, appId: true, userId: true, workerId: true, agentId: true, endedAt: true, expiresAt: true, type: true, startedAt: true, updatedAt: true, autoExpiredAt: true, launchOperationId: true, memoryId: true },
  });
  if (!session) {
    throw new GraphQLError(`Session "${sessionRef}" not found.`, {
      extensions: { code: 'SESSION_NOT_FOUND' },
    });
  }
  try {
    await requireSessionWriteAccess(ctx, session);
  } catch {
    throw new GraphQLError('You cannot post as a session you are not attributed to.', {
      extensions: { code: 'FORBIDDEN' },
    });
  }
  // Spec 049 Phase 8, item J (plan §4.5): the session-App pin
  // (SESSION_NOT_IN_APP) does not survive as a separate rule — its purpose (a
  // session of App A must not author in App B) is subsumed by the one check
  // below: the Worker's App is the Channel's, or the driver may write the
  // Channel's host memory.
  const now = new Date();
  const hardExpired = session.expiresAt && now.getTime() >= session.expiresAt.getTime();
  if (session.endedAt || hardExpired) {
    // #1036: only persisted reap evidence or the expiry promise proves a cause.
    const cause = session.autoExpiredAt
      ? `was auto-expired by the server at ${session.autoExpiredAt.toISOString()}`
      : !session.endedAt && hardExpired ? `expired at its promised deadline ${session.expiresAt!.toISOString()}`
        : 'has ended (cause not recorded)';
    throw new GraphQLError(
      `Session "${sessionRef}" ${cause}. Its holder must start a new session for this worker to continue; recovering their own session requires no force override.`,
      { extensions: { code: 'SESSION_ENDED' } },
    );
  }
  // cor:agt:020:04's "active session" is the shared liveness predicate
  // (cor:agt:020:11), not `endedAt` alone: since #1114 an open session
  // outside its idle window is not ended, but nobody is driving it — and a
  // GraphQL caller gets no MCP heartbeat (Copilot on PR #1169). The same
  // predicate the bind refuses WORKER_TAKEN on and the roster reports.
  const events = await loadLastEventBySession(ctx.db as never, [session.id]);
  // #1617 B (Holger, 2026-10-05): a LAPSED session is not refused yet. Its own
  // driver may resume it by this post, which is decided at the END, once every
  // other gate has passed, so a post refused for another reason revives nothing.
  const lapsed = !isSessionLive(session, events.get(session.id), now);
  if (!session.workerId) {
    throw new GraphQLError(
      `Session "${sessionRef}" is not bound to a worker — to post as yourself, say so (omit sessionRef on GraphQL; asMe: true on MCP).`,
      { extensions: { code: 'SESSION_NOT_WORKER_BOUND' } },
    );
  }
  // The worker-App pin (#974 — what the old SESSION_AGENT_NOT_IN_APP roster
  // check became): a Worker belongs to exactly one App by construction, and
  // that App must be THIS one. Evaluated at POST time rather than bind time
  // deliberately — a worker retired after the session started must stop being
  // able to author through it, which a bind-time check cannot express. The
  // Worker row survives the agent's uninstall (cor:dmo:050:11), so uninstall
  // no longer severs authorship — retirement is the revocation lever.
  const worker = await ctx.db.worker.findUnique({
    where: { id: session.workerId },
    select: { id: true, appId: true, name: true, retiredAt: true },
  });
  if (!worker) {
    throw new GraphQLError(
      `Session "${sessionRef}" is bound to a worker that no longer exists.`,
      { extensions: { code: 'SESSION_NOT_WORKER_BOUND' } },
    );
  }
  if (worker.retiredAt) {
    throw new GraphQLError(
      `Session "${sessionRef}" is bound to a retired worker — a retired worker stops authoring at once.`,
      { extensions: { code: 'WORKER_RETIRED', workerId: worker.id } },
    );
  }
  // Item J — the worker-App pin became the host-memory write check
  // (D-2026-09-13-008, #1048's rule: the host memory decides). A Worker of
  // ANOTHER App authors here iff the session's on-behalf-of user may write
  // the Channel's host memory — evaluated for the USER (no App selection in
  // the way: `requireMemoryWriteAccess` under an active App delegates to the
  // App-isolation gate, which is a different question). A pure App-key session
  // has nothing to derive the right from and is admitted only on the same-App
  // branch — never widened.
  const crossApp = app === null || worker.appId !== app.id;
  if (crossApp) {
    let driverMayWrite = false;
    // The on-behalf-of user is the SESSION's user, never the caller's:
    // requireSessionWriteAccess lets a platform admin drive someone else's
    // session, and the right to author elsewhere is that person's, with
    // that person's effective rights — no admin bypass rides along (Codex
    // P2 on PR #1169). A denial is the gate's typed refusal; anything else
    // (a transient DB failure) is rethrown, never read as "not writable"
    // (Copilot).
    if (session.userId) {
      try {
        await requireMemoryWriteAccess(
          { db: ctx.db, userId: session.userId, roles: [] } as unknown as Context,
          hostMemoryId,
        );
        driverMayWrite = true;
      } catch (e) {
        if (!(e instanceof Error) || !/^(Forbidden|Unauthenticated)/.test(e.message)) throw e;
        driverMayWrite = false;
      }
    }
    if (!driverMayWrite) {
      throw new GraphQLError(
        app === null
          ? `Session "${sessionRef}" is bound to a worker, and its driver may not write this Channel's host memory — it cannot author here.`
          : `Session "${sessionRef}" is bound to a worker of another App, and its driver may not write this Channel's host memory — it cannot author here.`,
        // `appId` names the Channel's HOST App, so it is absent when there is
        // none — an omitted field, never a null one masquerading as an id.
        { extensions: { code: 'CHANNEL_HOST_NOT_WRITABLE', ...(app ? { appId: app.id } : {}), workerAppId: worker.appId } },
      );
    }
  }
  // #1540 — authoring through the session is its driver driving it. Every
  // gate above passed, so the session is live and may author here; keep it
  // alive. Without this a CLI-bound worker posting all day went
  // SESSION_NOT_LIVE one idle window after binding.
  //
  // Only on CURRENT eligibility to drive the worker (Codex-worker P1 on
  // #1542): the gates above judge the session's historical user and the
  // DESTINATION's host memory, so a cross-App or free-standing Channel post
  // could otherwise keep alive a session whose driver has since lost the
  // worker's own App. The post itself is authorized as before; only the
  // keep-alive is withheld.
  if (lapsed) {
    // #1617 B — this only decides that the post MAY resume the session; the
    // resume itself happens inside the append transaction (#1625 review,
    // Baloo P2-1), so a post refused anywhere after this point resumes nothing.
    const verdict = await lapsedResumeVerdict(ctx, session.id);
    if (verdict !== 'OK') throw sessionNotLiveError(sessionRef, verdict === 'DORMANT');
  } else if (await mayStillDriveWorkerApp(ctx, worker.appId)) {
    await touchLiveSession(ctx.db, session.id);
  }
  return { workerId: worker.id, agentId: session.agentId, name: worker.name, sessionId: session.id, workerAppId: worker.appId, crossApp, resume: lapsed };
}

/**
 * SESSION_NOT_LIVE for a post through a session that is lapsed and may not be
 * resumed (#1617 B). A DORMANT one (DY-5) keeps the same code, so clients that
 * already rebind on SESSION_NOT_LIVE keep working, and says why in
 * `extensions.reason`: only an explicit rebind by its holder brings it back.
 */
function sessionNotLiveError(sessionRef: string, dormant = false): GraphQLError {
  if (dormant) {
    return new GraphQLError(
      `Session "${sessionRef}" is DORMANT — nothing has driven it for longer than its App's dormancy threshold, ` +
        'so no agent act resumes it. Its holder must start a new session for this worker ' +
        '(CLI: `hadron team session start --as <worker>`; MCP: `hadron_start_session`), which ends this one as superseded.',
      { extensions: { code: 'SESSION_NOT_LIVE', reason: 'DORMANT' } },
    );
  }
  return new GraphQLError(
    `Session "${sessionRef}" is not live — nothing has driven it inside its idle window, and it cannot be resumed here. ` +
      'Only the person holding the worker\'s name can resume their own lapsed session, by posting, reading or marking read ' +
      'through it, and only while no other session on that worker is live. Otherwise start a new session for this worker ' +
      '(CLI: `hadron team session start --as <worker>`; MCP: `hadron_start_session`). While a session is live, ' +
      'posting, reading and marking read through it keep it live.',
    { extensions: { code: 'SESSION_NOT_LIVE' } },
  );
}

/**
 * Resolve a mentionsRef filter argument to the set of tokens it can appear as
 * in stored envelopes (#974 — mentions resolve against the App's WORKERS and
 * members, cor:agt:020:04): a worker ref (PK, or the worker's name — matched
 * case-insensitively against this App's own staff, retired included, since
 * history still carries their mentions) → the slug of its name (via
 * {@link mentionTokenOf} — the canonical mention atom), a user ref → their
 * handle. Returns null when the ref resolves to nothing OR to a principal
 * outside this App — the caller collapses both to the empty page identically.
 * The staff restriction is the anti-oracle guard (Codex P1 on PR #941): the
 * mention filter must not distinguish a foreign worker/user from a
 * nonexistent one, so a worker ref only resolves within THIS App's staff, and
 * a user ref only when the user is an AppMember of it (or the caller
 * themself).
 *
 * #2020: a worker ref also carries the worker's id, because what the filter
 * returns for a worker is what REACHES it ({@link reachesWorker}: its name and
 * replies, plus a broadcast stamped at post time, never its own post). A user
 * ref keeps matching the handle alone: S1 pushes only to workers.
 */
async function resolveMentionTokens(
  ctx: Context,
  appId: string,
  mentionsRef: string,
): Promise<{ tokens: string[]; workerId: string | null } | null> {
  // Worker path: the App's own staff only — matched in memory on PK or
  // case-insensitive name (never a LIKE-backed filter,
  // findings:prisma-string-filters-are-unescaped-like). The staff list of one
  // App is small by construction.
  const staff = await ctx.db.worker.findMany({
    where: { appId },
    select: { id: true, name: true },
  });
  const refLower = mentionsRef.trim().toLowerCase();
  const workerMatch = staff.find(
    (w) => w.id === mentionsRef.trim() || w.name.toLowerCase() === refLower,
  );
  if (workerMatch) {
    // A resolved worker whose name yields no token (e.g. "!!!") has no direct
    // name to match, but stamped broadcasts and replies-by-fold still reach it
    // (Riana §10 P2 on #2058) — so it is NOT the unresolved-ref empty page.
    const token = mentionTokenOf(workerMatch.name);
    return { tokens: token ? [token] : [], workerId: workerMatch.id };
  }
  // User path: accept an id, an hrn:user:<handle> URN, or (as a convenience
  // for the MCP tool) a BARE handle — resolveUserRef rejects a bare handle as
  // not fully qualified, so retry with the user URN prefix.
  const userCandidates = mentionsRef.includes(':')
    ? [mentionsRef]
    : [mentionsRef, `hrn:user:${mentionsRef}`];
  for (const candidate of userCandidates) {
    try {
      const { id } = await resolveUserRef(ctx.db, candidate);
      const isSelf = ctx.userId === id;
      const member = isSelf
        ? null
        : await ctx.db.appMember.findUnique({
            where: { appId_userId: { appId, userId: id } },
            select: { userId: true },
          });
      if (!isSelf && !member) return null;
      const user = await ctx.db.user.findUnique({ where: { id }, select: { handle: true } });
      const token = user?.handle ? mentionTokenOf(user.handle) : null;
      if (token) return { tokens: [token], workerId: null };
      return null;
    } catch {
      // try the next spelling
    }
  }
  return null;
}

/**
 * Spec 049 Phase 8 — the Channel-addressed core the team-chat convenience and
 * `channelMessages` / `createChannelMessage` share: ONE read, ONE post, ONE
 * gate, two entry points (plan §4.5, §5 Phase 8). `teamChatMessages` /
 * `createTeamChatMessage` are the `appRef → App.defaultChannel` convenience
 * over these.
 */
// #1196: `app` is NULLABLE — a Channel may be hosted in a memory that belongs
// to no App. Narrowing the type is the census: every consumer that assumed an
// App had to answer for it at the compiler rather than at runtime
// (hadron-portal's `review:narrowing-a-fetch-narrows-its-type`, same lesson).
type ChannelTarget = { channelId: string; lastSeq: number; app: AppRow | null; root: ChatRootRow; incarnation: ChannelIncarnation };

const channelNotFound = (ref: string): GraphQLError =>
  new GraphQLError(`No match for channelRef "${ref}".`, { extensions: { code: 'CHANNEL_NOT_FOUND', channelRef: ref } });

/**
 * May this caller READ the Channel's host memory? Since #1196 this is the whole
 * read gate — `cor:acl:030:01`'s rule made literal: *"a chat has no access layer
 * of its own … both are decided entirely by the memory that hosts it."*
 *
 * It used to short-circuit `true` for every principal carrying a `userId`,
 * narrowing only a pure App-key context bound to an end-user session (Codex P1
 * on PR #1169). That was survivable **only while a Channel could not exist
 * outside an app-class memory**: with the class gate gone, the short-circuit
 * means any AppMember of the host App reads a Channel in another user's
 * `personal` or `private` memory. It is the first row of #1196's table and the
 * reason that issue exists.
 *
 * The header this replaces said the team-chat audience is *deliberately WIDER*
 * than the node-content gate, because *"an org CONTRIBUTOR who is not an
 * AppMember reads the team chat and may not read its nodes."* That was true and
 * is no longer: it was the drift #1196 measured, and the App fold now
 * implements the participation audience `cor:acl:010:01` states
 * (`participantTeamSpaceFolds`). The two gates compute the same set for every
 * non-impersonated shape, which is what makes routing the chat through this one
 * a unification rather than a narrowing. `access-control.participation.test.ts`
 * pins them against each other.
 *
 * **One exception, and it narrows rather than widens: an IMPERSONATED session
 * on an App-hosted Channel.** `getAccessibleMemoryIds` drops ALL App-derived
 * reach for an impersonated caller — a deliberate support-session boundary, not
 * an oversight — so consulting it here would revoke the bounded team-chat read
 * that `requireTeamChatAccess` grants and `resolvers.teamChat.test.ts` pins.
 * That decision stays where it is: every caller runs `requireTeamChatAccess`
 * FIRST for an App-hosted Channel, and it bounds impersonation to the support
 * session's ONE shared org, refuses an org-less App outright, and never admits a
 * post. A Channel with NO App has no such gate and therefore no exception — an
 * impersonated caller falls through to the memory gate, which denies. That is
 * the right answer: a support session has no business in someone's personal
 * chat, and widening `getAccessibleMemoryIds` to reach it is a separate decision
 * about support-session reach, not a side effect of a chat change.
 *
 * Run as a POINT check (`onlyMemoryId`), never a materialised set (Copilot).
 */
async function hostMemoryReadable(
  ctx: Context,
  memoryId: string,
  app: AppRow | null,
): Promise<boolean> {
  if (ctx.impersonation && app) return true;
  const accessible = await getAccessibleMemoryIds(ctx, memoryId);
  return accessible === null || accessible.includes(memoryId);
}

/**
 * May this caller POST into the Channel's host memory?
 *
 * Split by host class, because `cor:acl:010:01` splits it — and this is the one
 * place #1196's *"write → `requireMemoryWriteAccess`"* shorthand does not hold:
 *
 *   - **App-hosted** → the App's participation gate. The generic app-class
 *     memory write gate now also grants human participants, but Channel
 *     addresses remain governed and can only be written through chat operations.
 *   - **No App** → the host memory's own per-class write rules. This is what
 *     closes the escalation #1196 names: posting was gated on a READ check, and
 *     `MemoryShare` has a `reader` role, so a reader-grantee could append. On
 *     `personal`/`private` `requireMemoryWriteAccess` is owner-or-`writer`-share,
 *     which is the answer that rule wanted.
 *
 * Impersonation never posts, on either arm. The App arm is refused inside
 * `requireTeamChatAccess`; the memory arm is refused HERE rather than left to
 * `requireMemoryWriteAccess`, which would fail OPEN — its personal/private
 * branch compares `memory.userId === ctx.userId`, and under impersonation
 * `ctx.userId` is the TARGET, so it would admit a support session into exactly
 * the chat it must never reach (#876 class).
 */
async function requireChannelPostAccess(
  ctx: Context,
  app: AppRow | null,
  memoryId: string,
): Promise<void> {
  if (app) {
    await requireTeamChatAccess(ctx, app, 'post');
    return;
  }
  if (ctx.impersonation) throw forbidden();
  await requireMemoryWriteAccess(ctx, memoryId);
}

/**
 * Resolve a Channel ref to its chat root and — when the host IS an App's team
 * space — that App. "No match" covers a missing Channel, a deleted one, and one
 * whose host memory the caller may not read, all identically (§8.6, no
 * existence oracle).
 *
 * #1196: a host with no App is now ORDINARY, not impossible. The returned `app`
 * is null for one, and null is also the answer for an APP-SCOPED memory of any
 * other class — `app` here means *"this Channel lives in the App's team space,
 * whose audience is participation"*, never merely *"this memory has an
 * appId"*. The previous contract said such a Channel could not exist (the
 * chat-host typology, plan §12.1); that typology was replaced rather than
 * implemented, so do not reintroduce `CHANNEL_HOST_NOT_APP` on its authority.
 */
async function resolveChannelTarget(ctx: Context, channelRef: string, mode: 'post' | 'read'): Promise<ChannelTarget> {
  const ref = (channelRef ?? '').trim();
  // #1171: id OR the chat root's node URN. A ref that resolves to nothing is
  // the SAME "no match" as a Channel you may not read — the widening adds an
  // address, never a way to tell those two apart (cor:api:140:02).
  const id = await resolveChannelRefId(ctx.db, ref);
  if (!id) throw channelNotFound(ref);
  const channel = await ctx.db.channel.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      memoryId: true,
      loc: true,
      chatRootNodeId: true,
      incarnation: true,
      lastSeq: true,
      memory: {
        select: {
          appId: true,
          class: true,
          deletedAt: true,
          // The discriminators that tell the team space apart from the OTHER
          // app-class row shapes — see `isTeamSpaceRow`.
          ownerUserId: true,
          userMemoryOfAgentId: true,
          workerOf: { select: { id: true }, take: 1 },
        },
      },
    },
  });
  if (!channel || channel.memory.deletedAt) throw channelNotFound(ref);
  // #1196 — a host with no App is no longer refused. `CHANNEL_HOST_NOT_APP` is
  // RETIRED rather than reordered: the ordering fix #1196 asked for ("throw it
  // after the read gate, so a Channel id cannot distinguish inaccessible from
  // missing") was the remedy for a refusal that had to exist. It does not, so
  // the existence oracle is removed by deleting the thing that leaked, which is
  // the stronger fix and leaves no refusal code outliving its refusal
  // (findings:removing-a-mechanism-leaves-prose-describing-it).
  //
  // **The App branch is the TEAM SPACE, and nothing else that carries an
  // `appId`.** `cor:acl:010:01` is blunt about this — *"`app` is a tenancy
  // bucket, not an audience … `appId + class='app'` selects all four roles and
  // must be narrowed"* — and this line took TWO review rounds to get there,
  // narrowing once per round:
  //
  //   1. `appId != null` (@codex P1). `chk_memory_class_app_id` — read off the
  //      live constraint, not assumed — makes `app_id` REQUIRED for
  //      `class='app'` and merely OPTIONAL for
  //      `knowledge`/`group`/`personal`/`private` (034, #653). So an APP-SCOPED
  //      personal memory, the ordinary `(app_id, user_id)` pivot, was reading
  //      as a team space.
  //   2. `class === 'app'` (@copilot). Still FOUR row shapes, and two of them
  //      answer to a narrower audience than App participation: a Worker's
  //      casting memory (`workerOf`) and a per-user/session memory
  //      (`userMemoryOfAgentId`). `getAppTeamSpaceAccess` excludes both, so the
  //      memory gate already refused them — but `hostMemoryReadable`'s
  //      impersonation shortcut keys on `app` ALONE, so a support session could
  //      read a Channel in an end-user's session memory.
  //
  // The discriminators are columns, not the class, which is the whole point of
  // that spec paragraph. Every other shape keeps the canonical per-class gates.
  const mem = channel.memory;
  // The App is loaded BEFORE the classification, because the classification
  // needs its ownership (@copilot round 6) — "is this the App's team space?" is
  // a question about the App, not about who is asking.
  const hostApp = mem.appId ? await ctx.db.app.findUniqueOrThrow({ where: { id: mem.appId } }) : null;
  const app =
    hostApp &&
    isTeamSpaceRow(mem, {
      appOwnerUserId: hostApp.ownerUserId,
      impersonating: !!ctx.impersonation,
    })
      ? hostApp
      : null;
  // The READ gate decides existence; a reader who may not post gets FORBIDDEN
  // on a post, never "no match" — the Channel is known to them.
  if (app) {
    // App-hosted: participation IS this memory's read audience
    // (`cor:acl:010:01`), and this gate carries the impersonation bound that
    // `hostMemoryReadable` defers to. It runs FIRST — that ordering is the
    // precondition of the impersonation exception documented there.
    try {
      await requireTeamChatAccess(ctx, app, 'read');
    } catch (e) {
      // Only the gate's refusal is "no match"; anything else is rethrown.
      if (e instanceof GraphQLError && e.extensions?.code === 'FORBIDDEN') throw channelNotFound(ref);
      throw e;
    }
  }
  // AND the host memory's own read gate, for every shape (#1196). For an
  // App-hosted Channel this is what keeps a pure App-key context carrying an
  // end-user session out of the team space (Codex P1 on PR #1169); for a host
  // with no App it is the ENTIRE gate, and the reason a Channel may now live in
  // a `personal` memory without every AppMember of some App reading it.
  if (!(await hostMemoryReadable(ctx, channel.memoryId, app))) throw channelNotFound(ref);
  if (mode === 'post') await requireChannelPostAccess(ctx, app, channel.memoryId);
  return {
    channelId: channel.id,
    lastSeq: channel.lastSeq,
    app,
    root: { id: channel.chatRootNodeId, memoryId: channel.memoryId, loc: channel.loc },
    incarnation: { id: channel.id, value: channel.incarnation },
  };
}

function assertBody(body: unknown): asserts body is string {
  if (typeof body !== 'string' || body.trim() === '') {
    throw new GraphQLError('body must be a non-empty string.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  if (body.length > TEAM_CHAT_BODY_MAX_CHARS) {
    throw new GraphQLError(
      `body exceeds the team-chat cap of ${TEAM_CHAT_BODY_MAX_CHARS} characters (got ${body.length}). Store large artifacts as their own node and link them.`,
      { extensions: { code: 'TEAM_CHAT_BODY_TOO_LARGE', maxChars: TEAM_CHAT_BODY_MAX_CHARS } },
    );
  }
}

/**
 * Post into a Channel's root — the one write path. Author derivation (#939,
 * re-keyed to the Worker by #974, widened by item J): sessionRef → the
 * session's bound Worker with the driving session stamped in the envelope;
 * no sessionRef → the calling human (the gate guarantees ctx.userId).
 * Mentions are extracted server-side at write time — ONE extractor for every
 * surface; readers filter on the stored envelope, never re-parse. The message
 * is written through `chatRoot.appendChatMessage` (atomic seq, #919) as the
 * Channel's own operation, wiring a `replies-to` edge for replyToSeq.
 */
async function postToChannelRoot(
  ctx: Context,
  // #1196: null for a Channel whose host memory belongs to no App. Used only to
  // answer item J's "is this Worker of THIS App?" — see `resolveSessionAuthor`.
  app: AppRow | null,
  root: ChatRootRow,
  incarnation: ChannelIncarnation,
  args: { body: string; replyToSeq: number | null; sessionRef: string | null },
  /** #1791: the platform's own post. No principal authors it, no mention in it expands, and no one is credited. */
  opts: { system?: boolean; claim?: (tx: Prisma.TransactionClient) => Promise<boolean> } = {},
): Promise<TeamChatMessageOut> {
  const { body, replyToSeq, sessionRef } = args;
  let envelope: Record<string, unknown>;
  let authorLabel: string;
  let authorAgentId: string | null = null;
  // #1617 B: the lapsed session this post resumes, inside its append transaction.
  let resumeSessionId: string | null = null;
  if (opts.system) {
    authorLabel = SYSTEM_AUTHOR_NAME;
    envelope = { authorSystem: true, authorName: SYSTEM_AUTHOR_NAME };
  } else if (sessionRef) {
    const author = await resolveSessionAuthor(ctx, app, root.memoryId, sessionRef);
    if (author.resume) resumeSessionId = author.sessionId;
    authorLabel = author.name;
    authorAgentId = author.agentId;
    envelope = {
      authorWorkerId: author.workerId,
      authorName: author.name,
      sessionId: author.sessionId,
      // Item J: a cross-App post records the Worker's App beside the Channel's,
      // so it is visible as one in the transcript.
      ...(author.crossApp ? { authorAppId: author.workerAppId } : {}),
    };
  } else {
    const user = await ctx.db.user.findUniqueOrThrow({
      where: { id: ctx.userId! },
      select: { handle: true },
    });
    authorLabel = user.handle;
    envelope = { authorUserId: ctx.userId, authorName: user.handle };
  }

  // A system post carries NO mentions, whatever its text says: the platform never pages anyone through a notice.
  // #1842: the body tokens are only HALF the notified set — inside the append
  // transaction the reply target's author joins it (cor:agt:020:04 rev17), so
  // `mentions` is finalized there, before authority, stamps and sealing.
  const useTeamTags = teamTagsEnabled();
  const metadataVisible = await canReadTeamMetadata(ctx, app?.id ?? null);
  const bodyMentions = opts.system ? [] : extractMentions(body);
  let mentions = bodyMentions;
  if (replyToSeq != null) envelope.replyToSeq = replyToSeq;

  const messagesLoc = `${root.loc}:messages`;
  const memEncInfo = await getMemoryEncryptionInfo(ctx.db, root.memoryId);
  // Loaded BEFORE the write (@codex P1, PR #1317): no fallible await may
  // follow the commit, or a transient failure reports an error for a message
  // that was written, and the client's retry posts it twice.
  const memBareUrn = await hostMemoryUrn(ctx, root.memoryId);

  const messageId = generateId();
  const createdBy = opts.system ? null : (ctx.userId ?? null);
  let messageLoc: string | null = null;
  // #2015: the admission instant of a worker's post, stamped into its createdAt below; null for a human or system post.
  let admittedAt: Date | null = null;
  let appended: { seq: number; inserted: Date };
  try {
  appended = await appendChatMessage(ctx.db, root, memEncInfo, async ({ tx, seq, msgNum }) => {
    // The Channel is re-checked LIVE under the lock (Copilot on PR #1169):
    // deleteChannel takes this same key, so a delete that committed between
    // resolving the target and acquiring it is seen here — a message is
    // never appended under a tombstoned Channel, and its watermark never
    // advanced.
    const live = await tx.channel.findFirst({
      where: { chatRootNodeId: root.id, deletedAt: null },
      select: { id: true, incarnation: true },
    });
    if (
      !live ||
      live.id !== incarnation.id ||
      live.incarnation !== incarnation.value
    ) {
      throw channelNotFound(root.loc);
    }
    // #1791: the platform's once-a-day claim is taken in THIS transaction, after the Channel is seen live, so the claim and
    // the notice commit together or not at all: an exit between them leaves neither.
    if (opts.claim && !(await opts.claim(tx))) throw new NoticeNotClaimed();
    // replyToSeq is validated INSIDE the allocating transaction, under the
    // chat lock, so the target can't be soft-deleted out from under us and
    // a reply can never cite its own (still-uncommitted) seq. #1842 moved the
    // resolution BEFORE mention authority, wake stamps and envelope sealing:
    // an invalid target now refuses before any stamp authority is taken, and
    // the target's author joins the notified set (cor:agt:020:04 rev17).
    let replyTarget: { id: string; loc: string; data: unknown } | null = null;
    if (replyToSeq != null) {
      replyTarget = await tx.node.findFirst({
        // nodeType-constrained (Copilot on PR #941): the generic write
        // surface may put off-road nodes under the prefix
        // (D-2026-08-10-003) — a reply must cite a canonical message.
        where: {
          memoryId: root.memoryId,
          loc: { startsWith: escapePrismaLikePattern(`${messagesLoc}:`) },
          nodeType: 'chat-message',
          seq: replyToSeq,
          deletedAt: null,
        },
        select: { id: true, loc: true, data: true },
      });
      if (!replyTarget) {
        throw new GraphQLError(
          `replyToSeq ${replyToSeq} does not name a message in this Channel.`,
          { extensions: { code: 'TEAM_CHAT_REPLY_NOT_FOUND', replyToSeq } },
        );
      }
    }
    // #2015 — a worker's admission: serialize this worker across Channels, read the ONE admission instant (the database
    // clock, after the Channel's lock and this one), and refuse an identical post it already made here inside ten minutes.
    // Before any stamp authority, session resume, seal, node or edge, so a refusal writes nothing: the throw rolls the
    // transaction back before the allocator's counter writes (they follow the closure). A genuine human post and the
    // platform's own carry no worker and are not judged.
    const postingWorkerId = !opts.system && typeof envelope.authorWorkerId === 'string' ? envelope.authorWorkerId : null;
    if (postingWorkerId) {
      await lockWorkerPostAdmission(tx, postingWorkerId);
      admittedAt = await admissionTime(tx);
      // An encrypted body is ciphertext at rest: no equality read can match, so none is made (no key plumbing, R13/R43).
      const earlierSeq = memEncInfo.isEncrypted
        ? null
        : await findEarlierDuplicate(tx, { memoryId: root.memoryId, channelId: incarnation.id, workerId: postingWorkerId, body, replyTargetId: replyTarget?.id ?? null, admittedAt });
      if (earlierSeq != null) {
        throw new GraphQLError(
          `Identical to your message #${earlierSeq} in this Channel, which was posted: do not retry. Say something different, or reply to #${earlierSeq}.`,
          { extensions: { code: 'TEAM_CHAT_DUPLICATE', earlierSeq, channelId: incarnation.id } },
        );
      }
      // #2014 — the rolling limits, counted under the same lock and clock, AFTER the duplicate rule: an identical post is refused as a
      // duplicate (do not retry) whatever the count, so it never raises the rate alarm. The refusal is thrown as a sentinel: it rolls this
      // transaction back (nothing is stored), and the caller raises the alarm in its OWN committed transaction.
      const broken = await findBrokenPostLimit(tx, postingWorkerId, admittedAt);
      if (broken) throw new PostRateLimited(postingWorkerId, broken.name, broken.resetsAt);
    }
    // #1842 — the reply-target fold (Holger, #10394): when the target was
    // authored by a WORKER, that worker counts as mentioned, recorded at
    // posting time into this message's mentions. Workers only (a human or
    // system target is never force-notified); no self-notification; the
    // DIRECT target only. The token is derived from the worker's CURRENT
    // name (not the envelope's authorName snapshot), because every reader
    // computes the worker's own token from the live name — a renamed worker
    // must still be notified.
    // #1874: an ENCRYPTED memory folds too (cor:agt:020:04 has no encrypted
    // exception): the stored target envelope is ciphertext there, so it is
    // decrypted with the SAME in-process session key the post itself already
    // requires for sealing — no new key acquisition. A decrypt failure (key
    // absent, or a corrupt envelope) skips the fold and NEVER refuses the
    // reply; the typed-field guards apply to the decrypted object exactly as
    // to a plaintext one.
    if (!opts.system && replyTarget) {
      let targetEnv: Record<string, unknown> | null = null;
      if (memEncInfo.isEncrypted) {
        try {
          const resolved = decryptNodeFields({ data: replyTarget.data }, memEncInfo).data;
          targetEnv = resolved && typeof resolved === 'object' ? (resolved as Record<string, unknown>) : null;
        } catch {
          targetEnv = null;
        }
      } else {
        const raw = replyTarget.data;
        targetEnv = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
      }
      const targetAuthorId = typeof targetEnv?.authorWorkerId === 'string' ? targetEnv.authorWorkerId : null;
      if (targetAuthorId && targetAuthorId !== envelope.authorWorkerId) {
        const targetAuthor = await tx.worker.findUnique({
          where: { id: targetAuthorId },
          select: { name: true },
        });
        const token = targetAuthor ? mentionTokenOf(targetAuthor.name) : null;
        // A token that is a BROADCAST word ('all'/'team' — a worker literally
        // named "All") is never folded (Riana §10, #10533): the fold's intent
        // is to notify ONE worker, but a stored broadcast token wakes everyone
        // (broadcastWakes + every mention-filtered reader matches it for every
        // worker) — a widening the ruling forbids. Such a worker is simply not
        // reply-notifiable; an explicit @all in the body keeps its existing
        // broadcast meaning, unchanged.
        if (
          token &&
          !(BROADCAST_MENTION_TOKENS as readonly string[]).includes(token) &&
          !mentions.includes(token)
        ) {
          mentions = [...mentions, token];
        }
      }
    }
    if (mentions.length > 0) {
      envelope.mentions = mentions;
    }
    // #1748 (N3): who may wake everyone is decided NOW, here, on live authority held through the commit, and
    // stamped; nothing re-decides it later. The authority is taken BEFORE the resume below (which locks the Worker
    // row FOR UPDATE) and the stamps after it, so the Worker row is never taken SHARE then upgraded (Diego, cycle 3).
    let teamGraphHeld = false;
    const holdTeamGraph = async () => { await lockAppReportsTo(tx, app!.id, 'shared'); teamGraphHeld = true; };
    const stampAuthority = mentions.length > 0 || (useTeamTags && app && !opts.system)
      ? { authority: await lockStampAuthority(ctx, tx, app, useTeamTags && app && !opts.system ? holdTeamGraph : undefined) } : null;
    if (useTeamTags && app && !opts.system && !teamGraphHeld) {
      throw new GraphQLError('Cannot post team metadata for an unavailable App.', { extensions: { code: 'APP_UNINSTALLED' } });
    }
    if (useTeamTags) {
      const workers = !opts.system && app ? await tx.worker.findMany({ where: { appId: app.id }, select: { id: true, name: true, reportsToWorkerId: true, retiredAt: true } }) : [];
      Object.assign(envelope, buildTeamSnapshot(workers, typeof envelope.authorWorkerId === 'string' ? envelope.authorWorkerId : null, mentions));
    }
    // #1617 B — resume the author's lapsed session in THIS transaction, so it
    // commits with the message or not at all (#1625 review, Baloo P2-1). Every
    // condition is re-decided under the App and Worker locks.
    if (resumeSessionId && !(await resumeOwnLapsedSessionInTx(ctx, tx, resumeSessionId))) {
      throw sessionNotLiveError(sessionRef!);
    }
    if (stampAuthority) {
      Object.assign(envelope, await wakeStampsFor(ctx, tx, app, typeof envelope.authorWorkerId === 'string' ? envelope.authorWorkerId : null, useTeamTags ? mentions.filter(token => token !== 'team') : mentions, stampAuthority));
    }
    // The envelope is sealed after the stamps are in it.
    const msgFields = translateSessionExpired(memEncInfo, () =>
      encryptNodeFields({ content: body, data: envelope }, memEncInfo),
    );
    // The random component is the #916 backstop, not the uniqueness carrier
    // (#919 makes seq unique); the suffix atom is the author label, a
    // display convenience in an address that lands in URNs and search.
    const loc = `${messagesLoc}:${msgNum}-${generateId().slice(-8)}-${sanitizeLocAtom(authorLabel).toLowerCase()}`;
    // #1061 — the loc is minted inside this transaction closure, but the
    // usage event is recorded after it COMMITS (a rolled-back append must
    // record nothing), so it has to escape.
    messageLoc = loc;
    const row = await tx.node.create({
      data: {
        id: messageId,
        memoryId: root.memoryId,
        loc,
        name: `${msgNum}-${authorLabel}`,
        nodeType: 'chat-message',
        content: msgFields.content ?? null,
        data: (msgFields.data ?? null) as InputJsonValue,
        seq,
        // #1430: Channel membership in the SAME append transaction — the
        // paged attention reader resolves this Channel's rows through
        // Node.messageChannelId, so an unstamped append would be invisible
        // to it forever (Andi #3280: fixtures stamping this field masked
        // the production path).
        messageChannelId: incarnation.id,
        // #1162: explicit sessionRef attribution must survive ciphertext and
        // must not inherit a different/absent ambient request Worker.
        createdByWorkerId: typeof envelope.authorWorkerId === 'string' ? envelope.authorWorkerId : null,
        createdByAgentId: authorAgentId,
        // #914: the SENDER's user id — for worker posts, the human driver.
        createdBy,
        // #2015: a worker's message is recorded at the instant it was admitted (see teamChatAdmission.ts).
        ...(admittedAt ? { createdAt: admittedAt } : {}),
      },
    });
    if (replyTarget) {
      await tx.edge.create({
        data: {
          id: generateId(),
          memoryId: root.memoryId,
          sourceId: messageId,
          targetId: replyTarget.id,
          loc: deriveEdgeLoc(loc, 'replies-to', replyTarget.loc),
          name: 'replies-to',
          createdBy,
        },
      });
    }
    return row.createdAt;
  }, { asChannel: true });
    } catch (e) {
      if (!(e instanceof PostRateLimited)) throw e;
      // #2014: the post is refused and nothing was stored; the alarm (once an hour) commits on its own.
      await raisePostLimitAlarm(ctx.db, e.workerId, e.limit);
      throw new GraphQLError(
        `Your message was NOT posted: you have reached the team-chat post limit (${e.limit}). Do not retry in a loop: wait until ${e.resetsAt.toISOString()}, then post once.`,
        { extensions: { code: 'TEAM_CHAT_POST_RATE_LIMITED', limit: e.limit, resetsAt: e.resetsAt.toISOString() } },
      );
    }
  const { seq, inserted: createdAt } = appended;

  // #1061 — a chat message IS a node, so posting one is a write on the team's
  // shared chat memory. This was one of the largest blind spots in the old
  // instrumentation: `hadron_team_chat_post` created more nodes on a busy day
  // than every instrumented write tool combined, and counted for none of it.
  if (!opts.system) {
    recordNodeWrite(
      ctx.db,
      messageLoc ? { id: messageId, loc: messageLoc, memoryId: root.memoryId } : null,
      ctx,
    );
  }

  return {
    nodeId: messageId,
    urn: messageUrn(memBareUrn, messageLoc),
    seq,
    body,
    at: createdAt,
    authorUserId: (envelope.authorUserId as string | undefined) ?? null,
    authorWorkerId: (envelope.authorWorkerId as string | undefined) ?? null,
    authorSystem: envelope.authorSystem === true,
    authorName: authorLabel,
    authorAppId: (envelope.authorAppId as string | undefined) ?? null,
    sessionId: (envelope.sessionId as string | undefined) ?? null,
    replyToSeq: replyToSeq ?? null,
    mentions,
    broadcastWakes: envelope.broadcastWakes === true,
    teamTagsVersion: envelope.teamTagsVersion as number | undefined,
    teamBroadcastWorkerIds: envelope.teamBroadcastWorkerIds as string[] | undefined,
    teamTags: metadataVisible ? (envelope.teamTags as TeamTagSnapshot[] | undefined) ?? null : null,
  };
}

/**
 * Post into an App's team chat AS THE PLATFORM (#1791, cor:agt:080:15). A system author that is neither a user nor a
 * worker: no principal is credited or checked, because none is acting — which is why this is a server-internal door,
 * never a resolver, and takes the database and an App id, not a request context. The text is plain: the post carries no
 * mentions, and any `@` in it is shown as a plain full-width sign. Returns false (posting nothing) when the App has no
 * team chat to post into or is gone; it never creates one.
 */
class NoticeNotClaimed extends Error {}

/** #2014: a worker's post refused by the rate limit; carries what the typed error and the alarm need. */
class PostRateLimited extends Error {
  constructor(readonly workerId: string, readonly limit: string, readonly resetsAt: Date) { super(limit); }
}

/**
 * Could a notice be posted into this App's team chat right now? (Read-only; nothing is created or restored.) Needs a
 * live root AND a live Channel, and a host memory the platform can write: an encrypted chat is skipped, because the
 * notice would have to be sealed with a session key this request did not carry (Rook #1799).
 */
export async function canPostSystemNotice(db: Context['db'], appId: string): Promise<boolean> {
  return (await systemNoticeTarget(db, appId)) !== null;
}

async function systemNoticeTarget(db: Context['db'], appId: string) {
  const app = await db.app.findUnique({ where: { id: appId } });
  if (!app || app.deletedAt || app.uninstalledAt) return null;
  const root = await locateTeamChatRoot({ db } as Context, app as AppRow);
  if (!root) return null;
  const channel = await db.channel.findFirst({ where: { chatRootNodeId: root.id, deletedAt: null }, select: { id: true, incarnation: true } });
  if (!channel) return null;
  if ((await getMemoryEncryptionInfo(db, root.memoryId)).isEncrypted) return null;
  return { app: app as AppRow, root, incarnation: { id: channel.id, value: channel.incarnation } };
}

/**
 * Post into an App's team chat AS THE PLATFORM (#1791, cor:agt:080:15). A system author that is neither a user nor a
 * worker: no principal is credited or checked, because none is acting — which is why this is a server-internal door,
 * never a resolver, and takes the database and an App id, not a request context. The text is plain: the post carries no
 * mentions, and any `@` in it is shown as a plain full-width sign. It posts only into the LIVE Channel that exists now,
 * and the append re-checks that under the Channel's lock, so it never creates, restores or revives a chat: a deleted one
 * stays deleted. Returns false (posting nothing) when there is no such chat, or when `claim` (run in the append's own
 * transaction) refuses.
 */
export async function postSystemNotice(
  db: Context['db'],
  appId: string,
  body: string,
  claim?: (tx: Prisma.TransactionClient) => Promise<boolean>,
): Promise<boolean> {
  const target = await systemNoticeTarget(db, appId);
  if (!target) return false;
  try {
    await postToChannelRoot(
      { db } as Context,
      target.app,
      target.root,
      target.incarnation,
      { body: body.replace(/@/g, '\uFF20'), replyToSeq: null, sessionRef: null },
      { system: true, claim },
    );
  } catch (e) {
    // The chat was deleted after we looked, or the claim was lost: nothing was written.
    if (e instanceof NoticeNotClaimed) return false;
    if (e instanceof GraphQLError && e.extensions?.code === 'CHANNEL_NOT_FOUND') return false;
    throw e;
  }
  return true;
}

/**
 * #2980 — batch size of the in-memory filter branch's bounded scan (`readChannelRoot` with `countAll: false`).
 * Mutable only so a test can exercise batch boundaries with a small Channel.
 */
export const CHAT_FILTER_SCAN = { batch: 200 };

/**
 * #2980 — the rows strictly past `after` in the read order (seq, createdAt, loc; descending when `backward`). A
 * keyset, not a Prisma cursor: it needs no row to still exist, and the three keys order every message totally
 * (loc is unique in a memory), so no row is read twice or skipped between batches.
 */
function keysetPast(after: { seq: number | null; createdAt: Date; loc: string }, backward: boolean): Prisma.NodeWhereInput {
  const op = backward ? 'lt' : 'gt';
  return {
    OR: [
      { seq: { [op]: after.seq } },
      { seq: after.seq, createdAt: { [op]: after.createdAt } },
      { seq: after.seq, createdAt: after.createdAt, loc: { [op]: after.loc } },
    ],
  };
}

/**
 * Read a Channel's root — the one read path (#939, #1116): seq-ordered
 * ascending as a uniform `{ items, total }` page. Without a cursor or offset,
 * select the newest page; `sinceSeq` is a forward watermark (strictly greater),
 * `beforeSeq` its backward mirror. An explicit offset retains the legacy
 * oldest-first selection for callers migrating to cursors. `mentionsRef`
 * filters on the STORED envelope mentions, resolved against the host App's
 * staff and members (an unresolvable or foreign ref collapses to the empty
 * page — never an existence oracle).
 */
async function canReadTeamMetadata(ctx: Context, appId: string | null): Promise<boolean> {
  if (!appId) return false;
  const app = await ctx.db.app.findUnique({ where: { id: appId } });
  if (!app || app.deletedAt) return false;
  try { await requireWorkerReadAccess(ctx, app); return true; } catch { return false; }
}

async function channelHoldsHeadStamp(ctx: Context, root: ChatRootRow, headId: string): Promise<boolean> {
  const where: Prisma.NodeWhereInput = { memoryId: root.memoryId, loc: { startsWith: escapePrismaLikePattern(`${root.loc}:messages:`) }, nodeType: 'chat-message', deletedAt: null };
  const enc = await getMemoryEncryptionInfo(ctx.db, root.memoryId);
  if (!enc.isEncrypted) {
    return !!(await ctx.db.node.findFirst({ where: { ...where, data: { path: ['teamHeadIds'], array_contains: [headId] } }, select: { id: true } }));
  }
  const urn = await hostMemoryUrn(ctx, root.memoryId);
  // Existence only: bound each fetch and stop at the first sealed stamp.
  // Even limit: 0 must validate the head; exhaust later batches before refusing.
  const batchSize = 100;
  let afterId: string | null = null;
  while (true) {
    const rows: MessageRow[] = await ctx.db.node.findMany({
      where: { ...where, ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: 'asc' },
      take: batchSize,
      select: { id: true, loc: true, seq: true, content: true, data: true, createdAt: true },
    });
    if (rows.some(r => projectMessage(r, enc, urn, true).teamTags?.some(t => t.headId === headId))) return true;
    if (rows.length < batchSize) return false;
    afterId = rows[rows.length - 1]!.id;
  }
}

async function readChannelRoot(
  ctx: Context,
  // #1196: null when the host memory belongs to no App. Used ONLY to resolve a
  // `mentionsRef` against that App's staff and members — an App-less host has
  // neither, so the ref resolves to nothing and the caller gets the empty page
  // the unresolvable-ref case already produces (the anti-oracle collapse, Codex
  // P1 on PR #941). Everything else this function does is memory-scoped.
  appId: string | null,
  root: ChatRootRow,
  args: { replyToSeq?: number | null; sinceSeq?: number | null; beforeSeq?: number | null; mentionsRef?: string | null; teamHeadRef?: string | null; untagged?: boolean | null; limit?: number | null; offset?: number | null },
  /**
   * #2980 — `countAll: false` says the caller will not show `total` (a GraphQL selection without it, `selectsField`).
   * Only the in-memory filter branch uses it: it then scans in batches in the paging direction and stops once the
   * page is known, and the returned `total` is exact only when that scan reached the end of the range. Otherwise it
   * is a lower bound strictly greater than `items.length`, which is all the own-read advance reads from it
   * (`total <= items.length` means exhausted). Every other caller keeps the default, an exact count
   * (cor:api:120:02, cor:agt:020:04).
   */
  opts: { countAll?: boolean } = {},
): Promise<{ items: TeamChatMessageOut[]; total: number }> {
  const { replyToSeq, sinceSeq, beforeSeq, mentionsRef, teamHeadRef, untagged, limit, offset } = args;
  // The outer resolver has already established read access. Validate independently of
  // cursor/mention filters: a missing target is a refusal, a valid empty thread is not.
  if (replyToSeq != null) {
    const target = await ctx.db.node.findFirst({
      where: { memoryId: root.memoryId,
        loc: { startsWith: escapePrismaLikePattern(`${root.loc}:messages:`) },
        nodeType: 'chat-message', deletedAt: null, seq: replyToSeq },
      select: { id: true },
    });
    if (!target) throw new GraphQLError(`replyToSeq ${replyToSeq} does not name a message in this Channel.`,
      { extensions: { code: 'TEAM_CHAT_REPLY_NOT_FOUND', replyToSeq } });
  }
  const metadataVisible = await canReadTeamMetadata(ctx, appId);
  const teamFiltered = teamHeadRef != null || untagged != null;
  if (teamFiltered && !metadataVisible) throw new GraphQLError('Team metadata is unavailable in this Channel.', { extensions: { code: 'TEAM_CHAT_TEAM_METADATA_FORBIDDEN' } });
  if (teamHeadRef != null && untagged != null) throw new GraphQLError('teamHeadRef and untagged are mutually exclusive.', { extensions: { code: 'BAD_USER_INPUT' } });
  let selectedHead: string | null = null;
  if (teamHeadRef != null) {
    // The wire accepts stable IDs only, including authorized retired identities.
    // A leaf or unknown id refuses the same way (byte-identical, App-scoped), through the write path's head predicate.
    const workers = await ctx.db.worker.findMany({ where: { appId: appId! }, select: { id: true, name: true, reportsToWorkerId: true, retiredAt: true } });
    // Reparenting keeps no history, so a head whose reports are gone is still one when this Channel holds a message stamped with it.
    if (!workers.some(w => w.id === teamHeadRef)
      || !(isReadableTeamHead(workers, teamHeadRef) || await channelHoldsHeadStamp(ctx, root, teamHeadRef))) throw teamHeadInvalid();
    selectedHead = teamHeadRef;
  }
  const memEncInfo = await getMemoryEncryptionInfo(ctx.db, root.memoryId);
  const memBareUrn = await hostMemoryUrn(ctx, root.memoryId);
  const take = clampListTake(limit);
  const skip = Math.max(0, offset ?? 0);
  const where: Prisma.NodeWhereInput = {
    memoryId: root.memoryId,
    loc: { startsWith: escapePrismaLikePattern(`${root.loc}:messages:`) },
    // Only canonical messages (Copilot on PR #941): the generic write
    // surface stays open (D-2026-08-10-003), so off-road nodes under the
    // prefix must not surface as fabricated transcript entries.
    nodeType: 'chat-message',
    deletedAt: null,
    ...(replyToSeq != null ? { NOT: { seq: replyToSeq } } : {}),
    // #1116: the two cursors are opposite ends of one range and compose —
    // sinceSeq is exclusive-above, beforeSeq exclusive-below, and passing
    // both reads a bounded slice. A team message always carries a seq, so
    // the not-null floor only applies when neither cursor narrows it.
    seq:
      sinceSeq != null || beforeSeq != null
        ? {
            ...(sinceSeq != null ? { gt: sinceSeq } : {}),
            ...(beforeSeq != null ? { lt: beforeSeq } : {}),
          }
        : { not: null },
  };
  // #919 reader order: seq is unique going forward; createdAt + loc break
  // ties on pre-fix rows so the order is at least stable between reads.
  const orderBy = [
    { seq: 'asc' as const },
    { createdAt: 'asc' as const },
    { loc: 'asc' as const },
  ];
  // #1116: `beforeSeq` pages backward. #1536: an unqualified read also takes
  // the newest page. A forward sinceSeq or explicit offset keeps its original
  // oldest-first selection. Every result is returned ascending for rendering.
  //
  // `offset` is deliberately IGNORED alongside `beforeSeq`: a cursor exists
  // because a position is unstable under concurrent posting, so honouring
  // both would reintroduce the race the cursor was added to remove. Stated
  // in the SDL rather than silently applied.
  const backward = beforeSeq != null || (sinceSeq == null && offset == null);
  const readOrder = backward
    ? [
        { seq: 'desc' as const },
        { createdAt: 'desc' as const },
        { loc: 'desc' as const },
      ]
    : orderBy;
  // `loc` feeds two things: the #1061 usage attribution (a UsageEvent without
  // a loc is far less legible in the raw event feed) and, since #1209, the
  // message's own URN — which no client can compose, because the loc carries a
  // random component.
  const select = {
    id: true, loc: true, seq: true, content: true, data: true, createdAt: true,
  };

  // #1061 — reading the transcript returns message CONTENT, so each message
  // handed back is a read. Recorded on the page actually returned, never on
  // the wider candidate set a mentions filter scans: `take: 0` (a pure count
  // probe) and a filtered-out message both correctly record nothing.
  const recordRead = (rows: readonly { id: string; loc: string }[]): void => {
    recordNodeUsage(
      ctx.db,
      'read',
      rows.map((r) => ({ id: r.id, loc: r.loc, memoryId: root.memoryId })),
      ctx,
    );
  };

  const envelopeFilters: Prisma.NodeWhereInput[] = [];
  if (replyToSeq != null && !memEncInfo.isEncrypted) {
    envelopeFilters.push({ data: { path: ['replyToSeq'], equals: replyToSeq } });
  }
  if (teamFiltered && !memEncInfo.isEncrypted) {
    const predicate: Prisma.NodeWhereInput = selectedHead
      ? { data: { path: ['teamHeadIds'], array_contains: [selectedHead] } }
      : { OR: [{ data: { path: ['teamHeadIds'], equals: Prisma.DbNull } }, { data: { path: ['teamHeadIds'], equals: Prisma.AnyNull } }, { data: { path: ['teamHeadIds'], equals: [] } }] };
    const noHeads = predicate;
    envelopeFilters.push(untagged === false ? { NOT: noHeads } : predicate);
  }
  if (envelopeFilters.length > 0) where.AND = envelopeFilters;
  if (mentionsRef || ((teamFiltered || replyToSeq != null) && memEncInfo.isEncrypted)) {
    const resolved = mentionsRef && appId !== null ? await resolveMentionTokens(ctx, appId, mentionsRef) : null;
    if (mentionsRef && !resolved) return { items: [], total: 0 };
    const { tokens, workerId } = resolved ?? { tokens: [], workerId: null };
    // #2020: a worker sees what reaches it (lib/mentionReach.ts); a user, its handle.
    const matches = (msg: TeamChatMessageOut): boolean =>
      (replyToSeq == null || msg.replyToSeq === replyToSeq) &&
      (!mentionsRef || (workerId !== null ? reachesWorker(msg, [workerId], tokens) : msg.mentions.some((t) => tokens.includes(t)))) && (!teamFiltered || !memEncInfo.isEncrypted || (selectedHead ? !!msg.teamTags?.some(t => t.headId === selectedHead) : untagged === false ? !!msg.teamTags?.length : !msg.teamTags?.length));
    type Hit = { row: MessageRow; msg: TeamChatMessageOut };
    let page: Hit[];
    let total: number;
    if (opts.countAll !== false || take === 0) {
      // An exact `total` needs every match in the range (and `limit: 0` is a pure count), so this path scans the
      // whole range. Scanned ASCENDING regardless of paging direction; the direction is applied to the RESULT below.
      const rows = await ctx.db.node.findMany({ where, orderBy, select });
      const matching = rows
        .map((r) => ({ row: r, msg: projectMessage(r, memEncInfo, memBareUrn, metadataVisible) }))
        .filter((m) => matches(m.msg));
      page =
        take === 0
          ? []
          : backward
            ? matching.slice(Math.max(0, matching.length - take))
            : matching.slice(skip, skip + take);
      total = matching.length;
    } else {
      // #2980: nobody will see `total`, so read only as far as the page needs: batches in the paging direction,
      // stopping at one match past the page, so a full page still says whether more exist. Same rows, same order
      // and the same filter as the full scan above, so `items` are identical (offset is ignored backward, as there).
      const want = (backward ? 0 : skip) + take + 1;
      const found: Hit[] = [];
      let after: { seq: number | null; createdAt: Date; loc: string } | null = null;
      for (;;) {
        const rows: MessageRow[] = await ctx.db.node.findMany({
          where: after ? { AND: [where, keysetPast(after, backward)] } : where,
          orderBy: readOrder,
          select,
          take: CHAT_FILTER_SCAN.batch,
        });
        for (const r of rows) {
          const msg = projectMessage(r, memEncInfo, memBareUrn, metadataVisible);
          if (matches(msg)) found.push({ row: r, msg });
          if (found.length >= want) break;
        }
        if (found.length >= want || rows.length < CHAT_FILTER_SCAN.batch) break;
        const last = rows[rows.length - 1]!;
        after = { seq: last.seq, createdAt: last.createdAt, loc: last.loc };
      }
      page = backward ? found.slice(0, take).reverse() : found.slice(skip, skip + take);
      total = found.length;
    }
    recordRead(page.map((m) => m.row));
    const out = { items: page.map((m) => m.msg), total };
    // #2018: the own-read advance moves marks only for the worker this page was filtered by.
    if (workerId !== null) recordMentionsWorker(out, workerId);
    return out;
  }

  const total = await ctx.db.node.count({ where });
  if (take === 0) return { items: [], total };
  const rows = await ctx.db.node.findMany({
    where,
    orderBy: readOrder,
    select,
    ...(backward ? {} : { skip }),
    take,
  });
  // Back to ascending: the window moved, the render order never does.
  if (backward) rows.reverse();
  // Project BEFORE recording (PR #1062 review — Copilot): `projectMessage`
  // decrypts, and on an encrypted memory with no live session key it throws
  // SESSION_EXPIRED — so recording first would count reads for a transcript
  // the caller never received. The mentions branch above already projects
  // first; this makes the two branches agree.
  const items = rows.map((r) => projectMessage(r, memEncInfo, memBareUrn, metadataVisible));
  recordRead(rows);
  return { items, total };
}

/**
 * #2299 — search ONE channel's history (cor:agt:020:04, "Searching a chat's history"). The caller has already passed the
 * read gate; this is everything after it. It matches against {@link projectMessage}, the same projection a read returns,
 * so nothing a read withholds can be matched, counted, shown or encoded in the cursor; and it returns references only
 * (no body, no snippet, no count). It writes nothing: no read mark, no usage, no heartbeat.
 *
 * A host in an encrypted memory is refused outright: its stored text is ciphertext, and decrypting a history to scan it
 * is not a read the caller asked for. An empty page therefore only ever means a completed search.
 */
async function searchChannelRoot(
  ctx: Context,
  root: ChatRootRow,
  channel: { id: string; incarnation: number },
  args: { query: string; limit: number; cursor: string | null },
): Promise<TeamChatSearchPageOut> {
  const memEncInfo = await getMemoryEncryptionInfo(ctx.db, root.memoryId);
  if (memEncInfo.isEncrypted) {
    throw new GraphQLError('This chat is hosted in an encrypted memory and cannot be searched.', { extensions: { code: 'TEAM_CHAT_SEARCH_ENCRYPTED' } });
  }
  const binding = searchBinding(args.query, channel.id, channel.incarnation, searchCallerKey(ctx));
  const before = args.cursor == null ? null : decodeSearchCursor(args.cursor, binding);
  const memBareUrn = await hostMemoryUrn(ctx, root.memoryId);
  const rows = await ctx.db.node.findMany({
    where: {
      memoryId: root.memoryId,
      loc: { startsWith: escapePrismaLikePattern(`${root.loc}:messages:`) },
      nodeType: 'chat-message',
      deletedAt: null,
      seq: before != null ? { lt: before } : { not: null },
    },
    orderBy: [{ seq: 'desc' }, { createdAt: 'desc' }, { loc: 'desc' }],
    select: { id: true, loc: true, seq: true, content: true, data: true, createdAt: true },
    take: TEAM_CHAT_SEARCH_SCAN_CAP,
  });
  const needle = args.query.toLowerCase();
  const items: TeamChatSearchPageOut['items'] = [];
  let filledAt = -1;
  for (let i = 0; i < rows.length; i++) {
    const msg = projectMessage(rows[i]!, memEncInfo, memBareUrn);
    if (!msg.body.toLowerCase().includes(needle)) continue;
    items.push({ nodeId: msg.nodeId, urn: msg.urn, seq: msg.seq, channelId: channel.id, channelIncarnation: channel.incarnation });
    if (items.length >= args.limit) { filledAt = i; break; }
  }
  // Fewer rows than the bound means the scan reached the start of the history; exactly the bound means it may not have.
  const reachedStart = rows.length < TEAM_CHAT_SEARCH_SCAN_CAP;
  const page = { items, channelId: channel.id, channelIncarnation: channel.incarnation };
  if (filledAt >= 0) {
    // A full page continues after the last match returned.
    if (filledAt === rows.length - 1 && reachedStart) return { ...page, complete: true, cursor: null };
    return { ...page, complete: false, cursor: encodeSearchCursor(binding, items[items.length - 1]!.seq) };
  }
  if (reachedStart) return { ...page, complete: true, cursor: null };
  // The scan bound fired first: resume just below the LAST SCANNED seq, so nothing is scanned twice or skipped.
  return { ...page, complete: false, cursor: encodeSearchCursor(binding, rows[rows.length - 1]!.seq ?? 0) };
}

type TeamChatSearchPageOut = {
  items: { nodeId: string; urn: string | null; seq: number; channelId: string; channelIncarnation: number }[];
  complete: boolean;
  cursor: string | null;
  channelId: string | null;
  channelIncarnation: number | null;
};

const EMPTY_COMPLETE_SEARCH: TeamChatSearchPageOut = { items: [], complete: true, cursor: null, channelId: null, channelIncarnation: null };

export const teamChatMutations = {
  /**
   * #939 — post a message into the team App's chat as a platform operation:
   * resolve the App (cor:api:140), gate on team membership, locate (or
   * bootstrap) the team chat, and post through the Channel core. Since spec
   * 049 Phase 8 this is the `appRef → App.defaultChannel` convenience over
   * `createChannelMessage` — one gate, two entry points.
   */
  createTeamChatMessage: async (
    _: unknown,
    {
      appRef,
      body,
      replyToSeq,
      sessionRef,
    }: { appRef: string; body: string; replyToSeq?: number | null; sessionRef?: string | null },
    ctx: Context,
  ): Promise<TeamChatMessageOut> => {
    requirePrincipal(ctx);
    assertBody(body);
    const { id: appId } = await resolveAppRef(ctx.db, appRef);
    const app = await ctx.db.app.findUniqueOrThrow({ where: { id: appId } });
    if (app.uninstalledAt) {
      throw new GraphQLError('Cannot post into an uninstalled App\'s team chat.', {
        extensions: { code: 'APP_UNINSTALLED', appId },
      });
    }
    await requireTeamChatAccess(ctx, app, 'post');

    const located = await locateTeamChatRoot(ctx, app);
    // Every existing root passes through the SAME locked creation/reuse core
    // before posting. Besides backfill-on-touch for a pre-Channel root, this
    // closes the locate→delete race: if deleteChannel tombstones the root after
    // locateTeamChatRoot's live read, the core re-reads it under the Channel
    // memory/path locks and performs the full clean-incarnation reset. Calling
    // ensureChannelRow directly here could resurrect only the Channel row,
    // leaving the root tombstoned and the old transcript exposed.
    let root: ChatRootRow;
    let incarnation: ChannelIncarnation;
    if (located) {
      const { channel, rootId } = await ensureChannelWithRoot(ctx.db, {
        memoryId: located.memoryId,
        loc: located.loc,
        name: DEFAULT_CHANNEL_NAME,
        description: `Team chat — ${app.name}`,
        createdBy: ctx.userId ?? null,
        asDefaultOfAppId: app.id,
        hostLabel: app.name,
      });
      root = { ...located, id: rootId };
      incarnation = { id: channel.id, value: channel.incarnation };
    } else {
      ({ root, incarnation } = await bootstrapTeamChat(ctx, app));
    }
    return postToChannelRoot(ctx, app, root, incarnation, { body, replyToSeq: replyToSeq ?? null, sessionRef: sessionRef ?? null });
  },

  /**
   * Spec 049 Phase 8 — post into ANY Channel by ref. The host App's team-chat
   * gate decides who may post; the author derivation is item J's: a session's
   * Worker authors here when its App is the Channel's, OR when its driver may
   * write the Channel's host memory (`CHANNEL_HOST_NOT_WRITABLE` otherwise).
   */
  createChannelMessage: async (
    _: unknown,
    {
      channelRef,
      body,
      replyToSeq,
      sessionRef,
    }: { channelRef: string; body: string; replyToSeq?: number | null; sessionRef?: string | null },
    ctx: Context,
  ): Promise<TeamChatMessageOut> => {
    assertBody(body);
    const target = await resolveChannelTarget(ctx, channelRef, 'post');
    // An App-less host has no App to be uninstalled — the check is about the
    // App, not about the Channel, so it simply does not apply (#1196).
    if (target.app?.uninstalledAt) {
      throw new GraphQLError('Cannot post into a Channel of an uninstalled App.', {
        extensions: { code: 'APP_UNINSTALLED', appId: target.app.id },
      });
    }
    return postToChannelRoot(ctx, target.app, target.root, target.incarnation, { body, replyToSeq: replyToSeq ?? null, sessionRef: sessionRef ?? null });
  },
};

/**
 * #2520 — the READ GATE of the App team chat, shared by `teamChatMessages` and the `team_chat_read` run tool so the
 * tool carries no copy of the predicate: principal, App ref, `requireTeamChatAccess`, the chat root, and the host
 * memory's own point check. `null` is the empty page (no chat yet, or an unreadable host memory), exactly what
 * `teamChatMessages` answers; every refusal (UNAUTHENTICATED, FORBIDDEN, not found) is thrown unchanged. No side
 * effect: nothing here touches a read mark, a check stamp or a session.
 */
export async function resolveTeamChatReadTarget(ctx: Context, appRef: string): Promise<{ appId: string; root: ChatRootRow } | null> {
  requirePrincipal(ctx);
  const { id: appId } = await resolveAppRef(ctx.db, appRef);
  const app = await ctx.db.app.findUniqueOrThrow({ where: { id: appId } });
  await requireTeamChatAccess(ctx, app, 'read');
  const root = await locateTeamChatRoot(ctx, app);
  if (!root) return null;
  // One gate, two entry points: the convenience runs the same host-memory
  // point check the Channel-addressed read runs (Copilot on PR #1169).
  if (!(await hostMemoryReadable(ctx, root.memoryId, app))) return null;
  return { appId, root };
}

/**
 * #2520 — read ONE page of a team chat (`appRef`) or a named Channel (`channelRef`) for a principal with NO read-state
 * side effect: no `maybeAdvanceOwnChannelRead`, no channel check, no heartbeat. The `team_chat_read` run tool is its only
 * caller; the resolvers keep their own advance calls and use the same two gate halves. The Channel address uses
 * `resolveChannelTarget` (no match: CHANNEL_NOT_FOUND), the App address `resolveTeamChatReadTarget` (no access:
 * FORBIDDEN; unreadable host: the empty page), each refusal byte-identical to the resolver's.
 */
export async function readChatPageWithoutAdvancing(
  ctx: Context,
  address: { appRef: string } | { channelRef: string; withinAppId: string },
  args: { sinceSeq?: number | null; mentionsRef?: string | null; limit?: number | null },
): Promise<{ items: TeamChatMessageOut[]; total: number }> {
  if ('channelRef' in address) {
    const target = await resolveChannelTarget(ctx, address.channelRef, 'read');
    // A run speaks for ONE App: a Channel outside that App's team space is no match, however much the
    // run's user could read elsewhere (a personal memory, another App). Same answer as an unreadable one.
    if (target.app?.id !== address.withinAppId) throw channelNotFound(address.channelRef);
    return readChannelRoot(ctx, target.app?.id ?? null, target.root, args);
  }
  const target = await resolveTeamChatReadTarget(ctx, address.appRef);
  if (!target) return { items: [], total: 0 };
  return readChannelRoot(ctx, target.appId, target.root, args);
}

export const teamChatQueries = {
  /**
   * #939 — read the team chat: the `appRef → App.defaultChannel` convenience
   * over `channelMessages` (spec 049 Phase 8). See `readChannelRoot`.
   * #1628: advanceReadState=false defers acknowledgement to the caller without
   * suppressing the owned-session heartbeat or read usage attribution.
   */
  teamChatMessages: async (
    _: unknown,
    {
      appRef,
      advanceReadState,
      ...args
    }: {
      appRef: string;
      advanceReadState?: boolean | null;
      replyToSeq?: number | null;
      sinceSeq?: number | null;
      beforeSeq?: number | null;
      mentionsRef?: string | null; teamHeadRef?: string | null; untagged?: boolean | null;
      limit?: number | null;
      offset?: number | null;
    },
    ctx: Context,
    info?: GraphQLResolveInfo,
  ): Promise<{ items: TeamChatMessageOut[]; total: number; channelId?: string | null; channelIncarnation?: number | null }> => {
    // #2520: the gate half is ONE function shared with the `team_chat_read` run tool.
    const target = await resolveTeamChatReadTarget(ctx, appRef);
    if (!target) {
      if (args.replyToSeq != null) throw new GraphQLError(`replyToSeq ${args.replyToSeq} does not name a message in this Channel.`,
        { extensions: { code: 'TEAM_CHAT_REPLY_NOT_FOUND', replyToSeq: args.replyToSeq } });
      return { items: [], total: 0 };
    }
    const { appId, root } = target;
    // The attention capture changes ordinary-read semantics only for a
    // caller's exact Worker session. Outside that boundary this extra lookup
    // is not even made (#1353: the pilot operator allowlist is gone; the
    // session-scoped guards below are the boundary).
    // The Worker session may belong to a different App that registered
    // this App's Channel. The helper verifies that session's App
    // participation and register entry before advancing; the Channel host
    // is not the key.
    // #2181: the channel is selected for every read now (the page names it), not only for a session's.
    const readChannel = await ctx.db.channel.findFirst({
      where: { chatRootNodeId: root.id, deletedAt: null },
      select: { id: true, lastSeq: true, incarnation: true },
    });
    const pilotChannel = ctx.sessionId || ctx.sessionBindingRefused ? readChannel : null;
    // #2980: a selection without `total` lets a filtered read stop once its page is full (no info: count exactly).
    const page = await readChannelRoot(ctx, appId, root, args, { countAll: selectsField(info, 'total') });
    // #2138 follow-up: a request that NAMED a session the server refused is served as a session-less read, so it can never
    // count as a check. Say so in the App log (reason code only); behaviour is unchanged.
    if (pilotChannel && !ctx.sessionId && ctx.sessionBindingRefused) {
      await recordCheckMiss(ctx.db, { channelId: pilotChannel.id, reason: 'BINDING_REFUSED', via: 'read' });
    }
    if (pilotChannel && ctx.sessionId) {
      try {
        await maybeAdvanceOwnChannelRead(ctx, {
          channelId: pilotChannel.id,
          capturedHead: pilotChannel.lastSeq,
          advanceReadState,
          ...args,
          page,
        });
      } catch (error) {
        // A cursor write failing must leave the transcript readable. The safe
        // failure mode is a duplicate future nudge, never hidden content.
        console.warn('[teamChatMessages] pilot read-state advance failed:', error);
      }
    }
    // The SAME object: the mentions read is recorded against this page's identity (recordMentionsWorker).
    return Object.assign(page, { channelId: readChannel?.id ?? null, channelIncarnation: readChannel?.incarnation ?? null });
  },

  /**
   * #2299 — search the team chat's history: the `appRef` convenience over the same search `channelMessageSearch` runs.
   * The two bound checks come first (fixed numbers, so the refusal is the same for everyone), then the read gate
   * `teamChatMessages` uses, then the search. No read-state side effect.
   */
  teamChatSearch: async (
    _: unknown,
    { appRef, query, limit, cursor }: { appRef: string; query: string; limit?: number | null; cursor?: string | null },
    ctx: Context,
  ): Promise<TeamChatSearchPageOut> => {
    assertSearchQuery(query);
    const take = searchPageSize(limit);
    const target = await resolveTeamChatReadTarget(ctx, appRef);
    if (!target) return EMPTY_COMPLETE_SEARCH;
    const channel = await ctx.db.channel.findFirst({ where: { chatRootNodeId: target.root.id, deletedAt: null }, select: { id: true, incarnation: true } });
    if (!channel) return EMPTY_COMPLETE_SEARCH;
    return searchChannelRoot(ctx, target.root, channel, { query, limit: take, cursor: cursor ?? null });
  },

  /** #2299 — search ANY Channel by ref, through the read gate `channelMessages` uses; unreadable is CHANNEL_NOT_FOUND. */
  channelMessageSearch: async (
    _: unknown,
    { channelRef, query, limit, cursor }: { channelRef: string; query: string; limit?: number | null; cursor?: string | null },
    ctx: Context,
  ): Promise<TeamChatSearchPageOut> => {
    assertSearchQuery(query);
    const take = searchPageSize(limit);
    const target = await resolveChannelTarget(ctx, channelRef, 'read');
    return searchChannelRoot(ctx, target.root, { id: target.channelId, incarnation: target.incarnation.value }, { query, limit: take, cursor: cursor ?? null });
  },

  /** Spec 049 Phase 8 — read ANY Channel by ref; a Channel the caller may not read is "no match". */
  channelMessages: async (
    _: unknown,
    {
      channelRef,
      expectedIncarnation,
      advanceReadState,
      ...args
    }: {
      channelRef: string;
      advanceReadState?: boolean | null;
      replyToSeq?: number | null;
      sinceSeq?: number | null;
      beforeSeq?: number | null;
      mentionsRef?: string | null; teamHeadRef?: string | null; untagged?: boolean | null;
      limit?: number | null;
      offset?: number | null;
      expectedIncarnation?: number | null;
    },
    ctx: Context,
    info?: GraphQLResolveInfo,
  ): Promise<{ items: TeamChatMessageOut[]; total: number; channelId: string; channelIncarnation: number }> => {
    const target = await resolveChannelTarget(ctx, channelRef, 'read');
    const pinned = expectedIncarnation != null;
    // #2181 (a): a pinned read that already names a different incarnation reads nothing.
    if (pinned && expectedIncarnation !== target.incarnation.value) {
      throw channelIncarnationChanged(target.channelId, target.incarnation.value);
    }
    const page = await readChannelRoot(ctx, target.app?.id ?? null, target.root, args, { countAll: selectsField(info, 'total') });
    // (c): incarnation only rises, so equality before and after proves no recreation happened while the page was read;
    // otherwise old contents would be emitted under new metadata.
    if (pinned) {
      const after = await ctx.db.channel.findUnique({ where: { id: target.channelId }, select: { incarnation: true, deletedAt: true } });
      if (!after || after.deletedAt) throw channelNotFound(channelRef);
      if (after.incarnation !== expectedIncarnation) throw channelIncarnationChanged(target.channelId, after.incarnation);
    }
    if (!ctx.sessionId && ctx.sessionBindingRefused) {
      await recordCheckMiss(ctx.db, { channelId: target.channelId, reason: 'BINDING_REFUSED', via: 'read' });
    }
    if (ctx.sessionId) {
      try {
        await maybeAdvanceOwnChannelRead(ctx, {
          channelId: target.channelId,
          capturedHead: target.lastSeq,
          expectedIncarnation,
          advanceReadState,
          ...args,
          page,
        });
      } catch (error) {
        // (d): the final fence (page check to effects) refuses with the typed error and no effects; anything else is a
        // cursor write failing, which must leave the transcript readable.
        if (pinned && error instanceof GraphQLError && ['CHANNEL_INCARNATION_CHANGED', 'CHANNEL_NOT_FOUND'].includes(String(error.extensions?.code))) throw error;
        console.warn('[channelMessages] pilot read-state advance failed:', error);
      }
    }
    return Object.assign(page, { channelId: target.channelId, channelIncarnation: pinned ? expectedIncarnation : target.incarnation.value });
  },
};
