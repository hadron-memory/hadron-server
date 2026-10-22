import { lockStopFence } from '../../../lib/stopSignals/state.js';
import { reconcileStopCoverage } from '../../../lib/stopSignals/lifecycle.js';
import { storedIncludeTags, syncDerivedIncludesEdges } from '../../../lib/includes/writeIncludes.js';
import { sessionEndReason } from '../../../lib/sessionEndReason.js';
// sessionMutations — extracted from resolvers.ts Mutation (split step 2). No behavior change.
import { ownsSession } from '../../../lib/sessionOwnership.js';
import { generateId } from '../../../lib/id.js';
import {
  buildNodeRevisionSnapshot,
  createNodeRevision,
  diffNodeChanges,
  editorFromAuth,
  ensureCurrentNodeRevisionInTransaction,
  revisionStateHashRefreshMarker,
} from '../../../lib/nodeRevisionSnapshot.js';
import { authoredContentChanged, clearNodeAuthorship } from '../../../lib/nodeAuthorship.js';
import { lockAncestorsForCreate, lockAncestorsForCreateMany } from '../../../lib/nodeSubtreeLock.js';
import { mintMemoryUrnV2 } from '../../../lib/mintMemoryUrnV2.js';
import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { canReadMemory, filterReadableMemoryIds } from '../../../mcp/access-control.js';
import { isAgentInstalled } from '../../../lib/appAgent.js';
import { hasRequestOperationKey, getRequestOperationKey } from '../../../lib/requestOperationKey.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { makeKeyVerifier, verifyDataKey } from '../../../lib/memoryUnlock.js';
import { decryptNodesBatch } from '../../../lib/nodeCrypto.js';
import {
  parseUrnInput,
  assertFullyQualifiedUrn,
  UrnNotQualifiedError,
  hasSchemePrefix,
  splitNodeUrn,
  normalizeUrnForLookup,
  legacyMemoryUrnToCanonical,
  agentSlugFromUrn,
} from '../../../lib/urn.js';
import { emitNodeUrnV2 } from '../../../lib/urnEmit.js';
import { resolveWorkerRef as resolveWorkerRefId } from '../../../lib/entityRef/workerRef.js';
import { isId } from '../../../lib/entityRef/shape.js';
import { resolveWorkerIdByNameGated, provisionWorkerMemory, requireWorkerReadAccess, resolveReportsToTarget } from './resolvers.worker.js';
import { lockAppReportsTo, writeReportsTo } from '../../../lib/workerReportsTo.js';
import { eventActor } from '../../../lib/agentTasks/events.js';
import { managesApp } from '../../../lib/auth/appManagement.js';
import { writeNodeCore } from './resolvers.mutation.node.js';
import { attributedRequestActivity, recordNodeUsage, toUsageNodeRefs, trackUsageWrite } from '../../../lib/usageRecorder.js';
import {
  HANDOFFS_PARENT_LOC,
  HANDOFF_SESSION_KEY,
  nextHandoffLoc,
  newestHandoff,
  handoffSessionId,
} from '../../../lib/workerHandoff.js';
import { assembleRunNodePrompt } from '../../../lib/runNodeRender.js';
import { deriveEdgeLoc } from '../../../lib/edgeLoc.js';
import { generateUniqueHandle } from '../../../lib/userHandle.js';
import { ensureUserPrincipal } from '../../../lib/principal/mintPrincipal.js';
import { isRoutingName, routingNameOf } from '../../../lib/runner/selectNextEdge.js';
import { compileTemplate } from '../../../lib/template.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveNodeRefForCaller } from './resolvers.nodeRefAccess.js';
import { NodeNotFoundError, AgentNotFoundError, AppNotFoundError } from '../../../lib/entityRef/errors.js';
import { triggerManualRun } from './resolvers.appRun.js';
import { GraphQLError } from 'graphql';
import { type InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import type { Prisma } from '../../../generated/prisma/index.js';
import { serializeJson } from '../../../integrations/db/provider.js';
import { deleteToolConnection, runEmailOperation, type ToolCalendarEvent } from '../../../lib/emailClient.js';
import {
  loadLastEventBySession,
  mostRecentlyActive,
  isSessionLive,
  usageEventCountsAsActivity,
  recentlyTouchedFilter,
  OPEN_SESSION_SCAN_CAP,
} from '../../../lib/sessionActivity.js';
import { splitWholeNodeUrn } from '../../../lib/splitNodeUrnTolerant.js';
import {
  type Context,
  isAppParticipant,
  requireRole,
  requireOrgRole,
  requireAgentAccess,
  resolveReadableAgentRef,
  requireOwnerOrOrgRole,
  requireSessionWriteAccess,
  resolveReadableNodeByLoc,
  SESSION_INCLUDE,
  mapToolCalendarEvent,
  runOwnedEmailOperation,
  requireEmailConnection,
  ConnectionNotFoundError,
  type SessionInput,
  type UsageEventInput,
} from './resolvers.helpers.js';
import { assertNoMintedSpecRemoval, assertNoMintedSpecUnmark } from '../../../lib/mintedSpecPermanence.js';
import { preserveHeartbeatIfLapsed } from '../../../lib/sessionActivity.js';
import { consumeGrant, failOperation, loadLiveGrant, sameHold, type LoadedGrant } from '../../../lib/hostOperations/launch.js';
import {
  consumeResumeClaim,
  liveClaimsOf,
  liveWorkerSessionsOf,
  nothingToResume,
  toCandidates,
  writeResumeClaim,
} from '../../../lib/resumeClaims.js';
import { lapsedResumeVerdict, resumeOwnLapsedSessionInTx } from '../../../lib/teamAttention.js';
import { liveTxContext, withAuthorizedTx } from './authorizedTx.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { lockAuthorityAnchors, type AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';
import { deriveFamily, normalizeFamily } from '../../../lib/agentTasks/family.js';

/**
 * Strip explicit GraphQL nulls from a CalendarEventTimeInput so the tool's
 * either/or schema sees absent fields, not null values (JSON.stringify drops
 * undefined but serializes null).
 */
function dropNulls(t: { dateTime?: string | null; date?: string | null; timeZone?: string | null }) {
  return {
    dateTime: t.dateTime ?? undefined,
    date: t.date ?? undefined,
    timeZone: t.timeZone ?? undefined,
  };
}

/** Both session writers must refuse writes through an uninstalled App. */
function requireSessionAppActive(
  app: { deletedAt: Date | null; uninstalledAt: Date | null } | null,
  appId: string,
): void {
  if (!app || app.deletedAt) {
    throw new GraphQLError('Cannot start a session in an App that no longer exists.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  if (app.uninstalledAt) {
    throw new GraphQLError('Cannot start a session in an uninstalled App.', {
      extensions: { code: 'APP_UNINSTALLED', appId },
    });
  }
}

/** Hold the live App row through the session write so uninstall cannot pass the check mid-flight. */
async function lockSessionAppActive(tx: Prisma.TransactionClient, appId: string): Promise<void> {
  const [app] = await tx.$queryRaw<Array<{ deletedAt: Date | null; uninstalledAt: Date | null }>>`
    SELECT deleted_at AS "deletedAt", uninstalled_at AS "uninstalledAt"
    FROM apps WHERE id = ${appId} FOR SHARE
  `;
  requireSessionAppActive(app ?? null, appId);
}

/**
 * Write a worker session's closing handoff (#1029).
 *
 * The agent supplies prose; this owns the ADDRESS — which is the whole reason
 * it is server-side rather than a `hadron_create_node` call the client
 * composes. Three things would otherwise be re-derived by every client (MCP,
 * CLI, portal): which memory, the `handoffs` parent, and the lexically-ordered
 * loc. That is #1028's finding — domain logic accreting on clients because the
 * server exposed a primitive instead of the intent.
 *
 * Delegates the node writes to `writeNodeCore`, never `db.node` directly, per
 * `findings:node-write-surface-invariants`: encryption, the revision snapshot,
 * the abstract-hash recompute and re-embedding all live there, and a bespoke
 * insert would silently skip every one of them.
 *
 * Throws typed `HANDOFF_WRITE_FAILED` on any failure, and the caller has NOT
 * ended the session at that point — see `endSession`.
 */
/**
 * Close a session, FIRST END WINS, and report what actually happened (#1053).
 *
 * Shared by both end paths — the GraphQL resolver and the MCP tool, which does
 * its own raw update — because a read-then-write here is racy against the
 * session reaper, and fixing that at one call site is fixing it on one surface
 * (`review:fix-at-the-call-site-is-a-fix-on-one-surface`).
 *
 * The race, which is why the guard is not decoration (PR #1055 review, Codex):
 * the reaper claims a session with its own atomic update, so between a caller's
 * `findUnique` and its `update` a session can go from live to reaped. Deciding
 * from the stale read then does two wrong things at once — it reports a clean
 * "ended" for a session the server had already expired, and it overwrites the
 * reaper's `endedAt` while leaving `autoExpiredAt` set, leaving a row that says
 * it auto-expired at one instant and ended at a later one.
 *
 * So the close is a guarded `updateMany` on `endedAt: null` — winning it IS the
 * proof this call did the ending — and the receipt is decided from the row as
 * it stands afterwards, never from the row as it was before.
 */
// ── #1709: redeeming a launch grant ────────────────────────────────────────

type LaunchCtx = { grant: LoadedGrant; issuedBy: 'platform' | 'manager'; hold: { holdUserId: string | null; holdAt: Date | null } };

const launchGrantInvalid = () =>
  new GraphQLError('This launch grant is not valid: unknown, expired, already used, or not yours.', { extensions: { code: 'LAUNCH_GRANT_INVALID' } });

/** startSession's answer for a worker ref that names nothing the caller may see: one envelope for absent and unreadable alike. */
const workerRefNotFound = (workerRef: string) =>
  new GraphQLError(`Worker not found: ${workerRef}`, { extensions: { code: 'WORKER_NOT_FOUND' } });

/**
 * #1937 — the worker read gate for an id/URN ref, collapsed: a caller who may not read the worker's App's staff
 * gets `workerRefNotFound`, byte-identical to an absent ref, as do a missing and a soft-deleted App. NARROW catch
 * (#1019, review:narrow-catch-blocks): only the gate's own FORBIDDEN collapses; anything else, a database failure
 * inside the participation lookup included, propagates, since reporting an outage as a missing worker is the one
 * thing this collapse must never hide.
 */
async function requireWorkerVisibleOrNotFound(ctx: Context, appId: string, workerRef: string): Promise<void> {
  const app = await ctx.db.app.findUnique({
    where: { id: appId },
    select: { id: true, name: true, urn: true, organizationId: true, ownerUserId: true, uninstalledAt: true, deletedAt: true },
  });
  if (!app) throw workerRefNotFound(workerRef);
  try {
    await requireWorkerReadAccess(ctx, app);
  } catch (e) {
    if (!(e instanceof GraphQLError && e.extensions?.code === 'FORBIDDEN')) throw e;
    throw workerRefNotFound(workerRef);
  }
}

/** The bind refusals that mean something changed since the start was issued: they fail the start (Holger via Vera #10775). */
const LAUNCH_STATE_REFUSALS: Record<string, string> = {
  LAUNCH_REFUSED: 'The hold changed after this start was issued.',
  WORKER_HELD: 'The hold changed after this start was issued.',
  WORKER_TAKEN: 'The worker already has a live session.',
  FORBIDDEN: 'The holder may no longer hold this worker.',
  WORKER_RETIRED: 'The worker was retired.',
  APP_UNINSTALLED: 'The App was uninstalled.',
};

/**
 * cor:agt:070:08 / Holger's ruling A (Vera #10761): a host-launched agent binds with its HOLDER's own token and the
 * grant its host was given. The grant is checked against the caller, never trusted for identity: only the holder it
 * was minted for redeems it, a pure App key (a host's among them) never does, and the takeover override cannot force
 * a launch. A bind refused because something changed since the start was issued (#10775) fails that start with the
 * reason and spends the grant; a grant that is unknown, expired, used or someone else's reads as one refusal and
 * changes nothing (no oracle, and no way to fail another's start).
 */
async function withLaunch<T>(given: SessionInput, ctx: Context, run: (input: SessionInput, launch: LaunchCtx | null) => Promise<T>): Promise<T> {
  if (given.launchGrant == null) return run(given, null);
  if (!ctx.userId || ctx.impersonation) throw launchGrantInvalid();
  if (given.force) {
    throw new GraphQLError('A launch cannot be forced: a worker with a live session is not started again.', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  const now = new Date();
  const grant = await loadLiveGrant(ctx.db, given.launchGrant, now);
  if (!grant || grant.holderUserId !== ctx.userId) throw launchGrantInvalid();
  const op = await ctx.db.hostOperation.findUniqueOrThrow({ where: { id: grant.operationId }, select: { issuedBy: true, holdUserId: true, holdAt: true } });
  const launch: LaunchCtx = {
    grant, issuedBy: op.issuedBy === 'platform' ? 'platform' : 'manager', hold: { holdUserId: op.holdUserId, holdAt: op.holdAt },
  };
  try {
    return await run({ ...given, workerRef: given.workerRef ?? grant.workerId }, launch);
  } catch (e) {
    const code = e instanceof GraphQLError ? String(e.extensions?.code ?? '') : '';
    const reason = LAUNCH_STATE_REFUSALS[code];
    if (!reason) throw e;
    // A concurrent redemption of the same grant that WON bound the session this one now finds live: that is a spent
    // grant, not a changed world, and must not fail the start that succeeded.
    if (await ctx.db.session.findUnique({ where: { launchOperationId: grant.operationId }, select: { id: true } })) throw launchGrantInvalid();
    await ctx.db.$transaction((tx) => failOperation(tx, grant.operationId, new Date(), reason));
    throw new GraphQLError(`This launch is refused: ${reason} The start has failed with that reason.`, {
      extensions: { code: 'LAUNCH_REFUSED', reason: code, operationId: grant.operationId },
    });
  }
}

export async function endSessionFirstWins(
  db: Context['db'],
  id: string,
  metrics: {
    summary?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    turnCount?: number | null;
    errorCount?: number | null;
  },
): Promise<{ endedByThisCall: boolean; endedAt: Date | null; autoExpiredAt: Date | null; endReason: ReturnType<typeof sessionEndReason> }> {
  const data = {
    ...(metrics.summary !== undefined ? { summary: metrics.summary } : {}),
    ...(metrics.inputTokens !== undefined ? { inputTokens: metrics.inputTokens } : {}),
    ...(metrics.outputTokens !== undefined ? { outputTokens: metrics.outputTokens } : {}),
    ...(metrics.turnCount !== undefined ? { turnCount: metrics.turnCount } : {}),
    ...(metrics.errorCount !== undefined ? { errorCount: metrics.errorCount } : {}),
  };
  const claimed = await db.session.updateMany({
    where: { id, endedAt: null },
    data: { ...data, endedAt: new Date(), endReason: 'ended' },
  });
  if (claimed.count === 0) {
    // Already ended — by an earlier call, or by the reaper a moment ago. The
    // metrics still land; the original end instant stands.
    await db.session.updateMany({ where: { id }, data });
  }
  const after = await db.session.findUnique({
    where: { id },
    select: { endedAt: true, autoExpiredAt: true, endReason: true },
  });
  // GraphQL and MCP close through this writer. Release this session's key
  // holdings only after its durable end is confirmed; other sessions holding
  // the same memory keep their independent references.
  if (after?.endedAt) sessionKeyCache.evict(id);
  return {
    endedByThisCall: claimed.count > 0,
    endReason: after ? sessionEndReason(after) : null,
    endedAt: after?.endedAt ?? null,
    autoExpiredAt: after?.autoExpiredAt ?? null,
  };
}

export async function writeSessionHandoff(
  ctx: Context,
  sessionId: string,
  workerId: string,
  body: string,
): Promise<void> {
  // Both guards live HERE, ahead of the try, rather than in either caller (PR
  // #1045 review, Codex P1 + P2). The GraphQL resolver had them and the MCP
  // tool — which reimplements the end with its own raw update — did not, so the
  // bug stayed live on the surface this team actually uses. A guard in the
  // shared writer is inherited by both, which is the only version of this that
  // cannot drift. They throw typed and are NOT wrapped in
  // HANDOFF_WRITE_FAILED: a refusal is an answer, not a failure to write.
  const session = await ctx.db.session.findUniqueOrThrow({
    where: { id: sessionId },
    select: { id: true, endedAt: true, workerId: true },
  });

  // Ending is retry-tolerant, the sequence is append-only. A retry of a call
  // that already succeeded would append a SECOND node — newest by loc, stamped
  // with this older session — and make a stale account read as CURRENT.
  if (session.endedAt) {
    throw new GraphQLError(
      `Session ${sessionId} already ended at ${session.endedAt.toISOString()}, and its handoff is already written. ` +
        'The sequence is append-only, so a second handoff for the same stint is refused — start a new session to record new state.',
      {
        extensions: {
          code: 'SESSION_ALREADY_ENDED',
          sessionId,
          endedAt: session.endedAt.toISOString(),
        },
      },
    );
  }

  // IDEMPOTENCE by session id, for the window the check above cannot see: the
  // handoff write and the session close are separate commits, so a crash
  // between them (or two ends racing past the `endedAt` check) leaves a handoff
  // written against a session still marked open. A retry would then append a
  // duplicate for one stint, which contradicts the retry-safety this
  // operation's whole ordering exists to provide.
  //
  // Checking the NEWEST child is sufficient: a retry lands immediately after
  // its own predecessor, so if this stint already wrote one it is the newest.
  // (An encrypted working memory would hide the envelope and re-write — worker
  // memories are provisioned unencrypted, and the same limitation already
  // applies to the continuity status.)
  const worker = await ctx.db.worker.findUniqueOrThrow({
    where: { id: workerId },
    select: { memoryId: true },
  });
  if (worker.memoryId) {
    const newest = await newestHandoff(ctx.db, worker.memoryId);
    if (newest && handoffSessionId(newest.data) === sessionId) return;
  }

  try {
    const worker = await ctx.db.worker.findUniqueOrThrow({
      where: { id: workerId },
      select: { id: true, name: true, slug: true, memoryId: true, appId: true },
    });

    // AUTHORITY. The caller has already cleared `requireSessionWriteAccess` on
    // the session being ended, and the target memory is DERIVED from the worker
    // that session is bound to — the caller names no memory, so this elevation
    // cannot be steered anywhere. Without it the operation refuses the very
    // principal it exists for: `requireMemoryWriteAccess` grants an org-owned
    // app-class memory to org CONTRIBUTORs, and an AppMember who is not an org
    // member is most of this team. That is the same gap `createTeamChatMessage`
    // meets and answers the same way (gate on the operation's own predicate,
    // then write); the difference is that it writes rows by hand, while this
    // delegates to `writeNodeCore` so encryption, the revision snapshot, the
    // abstract hash and re-embedding all still happen
    // (findings:node-write-surface-invariants).
    //
    // Deliberately does NOT reach a user-owned App's worker memory: strict
    // ownership (spec 047) refuses even a platform admin there, and it needs no
    // help — a user-owned App's workers are driven by its owner.
    const writerCtx: Context = { ...ctx, roles: ['ADMIN'] as Context['roles'] };

    // Provisioning is best-effort at cast time (the spec allows it lazily), so
    // a legally cast worker can reach here with no memory. Provision it now
    // rather than refusing: refusing would mean a worker unlucky at cast can
    // NEVER write a handoff, which is a permanent gap created by a transient
    // failure.
    let memoryId = worker.memoryId;
    if (!memoryId) {
      const app = await ctx.db.app.findUniqueOrThrow({
        where: { id: worker.appId },
        select: {
          id: true, name: true, urn: true,
          organizationId: true, ownerUserId: true, uninstalledAt: true,
        },
      });
      memoryId = await provisionWorkerMemory(ctx, app, worker);
      if (!memoryId) {
        throw new Error(`worker ${worker.id} has no working memory and provisioning it failed`);
      }
    }

    // The parent carries the convention for a human reading the sequence in the
    // portal. Created on first handoff, like the team chat's own root — and
    // `create` mode resurrects a soft-deleted one rather than colliding on
    // (loc, memoryId).
    // loc-scope-ok: scoped to one memory by id.
    const parent = await ctx.db.node.findFirst({
      where: { memoryId, loc: HANDOFFS_PARENT_LOC, deletedAt: null },
      select: { id: true },
    });
    if (!parent) {
      await writeNodeCore(
        {
          memoryId,
          loc: HANDOFFS_PARENT_LOC,
          name: 'handoffs',
          nodeType: 'record',
          description: `Handoff records for ${worker.name}, newest last — one per closed worker session.`,
          content:
            `# Handoffs — ${worker.name}\n\n` +
            'One child per closed worker session, newest last, written by ' +
            '`endSession(handoff:)`.\n\n' +
            'Starting a session as this worker returns the newest child ' +
            'automatically — binding is briefing, so binding is handoff. ' +
            'Reading the sequence by hand is for history, not for resuming.\n\n' +
            '**Never edit a child.** The sequence is the point, and an amended ' +
            'handoff destroys the record of what was believed at the time.\n\n' +
            'Ordering comes from the loc (`handoffs:<yyyy-mm-dd>-<hhmm>`, UTC, ' +
            'lexically sortable) — never from `seq`, which is a 32-bit Int a ' +
            'timestamp overflows.\n',
        },
        writerCtx,
        'create',
      );
    }

    const at = new Date();
    const loc = await nextHandoffLoc(ctx.db, memoryId, at);
    await writeNodeCore(
      {
        memoryId,
        loc,
        name: loc.slice(HANDOFFS_PARENT_LOC.length + 1),
        nodeType: 'record',
        description: `Handoff from ${worker.name}'s session ${sessionId.slice(0, 8)}.`,
        content: body,
        // The writing session, which is what lets a later bind tell a CURRENT
        // handoff from a stale one it never replaced.
        data: { [HANDOFF_SESSION_KEY]: sessionId },
      },
      writerCtx,
      'create',
    );
  } catch (e) {
    throw new GraphQLError(
      `The handoff could not be written, so the session was NOT ended — retry, or end without a handoff. Cause: ${
        e instanceof Error ? e.message : 'unknown'
      }`,
      { extensions: { code: 'HANDOFF_WRITE_FAILED', sessionId } },
    );
  }
}

// ── #2086 / #1931 / #1948: refresh a bound session's model and family ─────────────────────────────────────────
/** A supplied family must be a valid token; checked before any write (and, on a resume, before the claim is spent). */
function explicitFamilyOrThrow(family: string | null | undefined): string | null {
  const explicit = family != null ? normalizeFamily(family) : null;
  if (family != null && !explicit) {
    throw new GraphQLError('family must be a valid model-family token.', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  return explicit;
}

/**
 * What a binding-preserving flow writes back: an explicit family wins, otherwise a supplied model is read against
 * the session's STORED tool (never a transport's). Null/omitted input never clears, and a model nothing classifies
 * keeps the existing family rather than guessing one. Shared by updateSession and the resume of an open session,
 * so the two cannot drift.
 */
function modelFamilyRefresh(
  explicitFamily: string | null,
  llmModel: string | null | undefined,
  storedTool: string | null,
): { llmModel?: string; family?: string } {
  const family = explicitFamily ?? (llmModel != null ? deriveFamily({ llmModel, tool: storedTool }) : null);
  return { ...(llmModel != null ? { llmModel } : {}), ...(family != null ? { family } : {}) };
}

// ── #1956: resume claims ───────────────────────────────────────────────────

/** The optional provenance a redemption passes on when it must start the worker's next session. */
type ResumeSessionInput = {
  session?: string | null;
  description?: string | null;
  tool?: string | null;
  host?: string | null;
  llmModel?: string | null;
  family?: string | null;
  transcriptPath?: string | null;
};

/**
 * The session a caller may write a resume claim for: their OWN worker session, judged on the user, never an App
 * key or an impersonation. Anything else answers exactly as an absent session (the claim is the caller's own
 * recovery handle, so no one else's session is theirs to name).
 */
async function ownSessionForClaim(ctx: Context, sessionId: string) {
  const session = await ctx.db.session.findUnique({
    where: { id: sessionId },
    select: { id: true, userId: true, appId: true, workerId: true, endedAt: true, deletedAt: true },
  });
  if (!session || session.deletedAt || !ctx.userId || ctx.impersonation || session.userId !== ctx.userId || !session.appId) {
    throw new GraphQLError(`Session not found: ${sessionId}`, { extensions: { code: 'BAD_USER_INPUT' } });
  }
  if (!session.workerId) {
    throw new GraphQLError(
      'A resume claim recovers a worker, and this session is not bound to one.',
      { extensions: { code: 'SESSION_NOT_WORKER_BOUND', sessionId } },
    );
  }
  return { ...session, userId: ctx.userId, appId: session.appId, workerId: session.workerId };
}

/**
 * #1956 — the caller's own session exists but the shared lifecycle gate will not let it be resumed now. Told
 * plainly: every path here is keyed on the caller's own claims and sessions, so the reason leaks nothing.
 */
const resumeRefused = (dormant: boolean) =>
  new GraphQLError(
    dormant
      ? 'That session is dormant: it was idle past its App\'s dormancy period, so no act resumes it. Start the worker again by name.'
      : 'That session cannot be resumed now: the name is no longer yours, you can no longer drive its App, it is past ' +
        'its hard expiry or has ended, or another session of the worker is live. Nothing was bound.',
    { extensions: { code: 'RESUME_REFUSED', dormant } },
  );

const sessionEndedForClaim = (sessionId: string) =>
  new GraphQLError(
    'This session has ended. Write the claim before the end: endSession(resumeClaim: true) writes it with the handoff.',
    { extensions: { code: 'SESSION_ENDED', sessionId } },
  );

export const sessionMutations = {
    startSession: async (_: unknown, { input: given }: { input: SessionInput }, ctx: Context) => withLaunch(given, ctx, async (input, launch) => {
      // #928: optional persona link. `agentRef` (PK or URN, cor:api:140)
      // resolves to Session.agentId. Gate mirrors Query.agent's read gate —
      // a PUBLIC agent attaches for any caller, otherwise owner / org member
      // (READER) — so a session is never attributed to an agent the caller
      // cannot read. Resolution is not authorization (#554): the
      // resource-scoped gate runs on the RESOLVED agent.
      let agentId: string | undefined;
      // Trimmed: a whitespace-only ref is a trivial client bug and reads as
      // absent, not as a malformed URN (#929 review).
      const agentRef = input.agentRef?.trim();
      if (agentRef) {
        try {
          // #1944: Query.agent's read gate, shared, with a denial answered
          // exactly like an absent (or retired) Agent.
          agentId = (await resolveReadableAgentRef(ctx, agentRef)).id;
        } catch (e) {
          // A mutation input error surfaces loudly (contrast Query.agent,
          // which masks not-found to null); malformed URNs propagate their
          // own typed error from assertFullyQualifiedUrn.
          if (e instanceof AgentNotFoundError) {
            throw new GraphQLError(`Agent not found: ${agentRef}`, { extensions: { code: 'BAD_USER_INPUT' } });
          }
          throw e;
        }
      }

      // #943: optional App pivot. Before this, `Session.appId` was stamped
      // ONLY from `ctx.appId` (an App-key credential), so a user-authenticated
      // session — every CLI session — always had `appId: null` and could never
      // satisfy the team-chat authorship gate's "a session OF this App"
      // condition (cor:agt:020:04 (b) / SESSION_NOT_IN_APP). The gate is right;
      // the write path to satisfy it was missing.
      //
      // Same shape as `agentRef` above (cor:api:140, PK or URN): resolution is
      // NOT authorization (#554) — the gate runs on the RESOLVED App.
      let appId: string | null = ctx.appId ?? null;
      // #1037: WHERE the App came from decides what may override it. The same
      // `ctx.appId` field carries two different trust levels
      // (findings:auth-appid-credential-vs-selection): for a pure App-key
      // principal it is a CREDENTIAL — the caller IS that App — while for a
      // user it is the MCP active-App SELECTION, a convenience that a later
      // bind in another App silently re-points. An explicitly-qualified ref
      // must beat a selection; nothing beats a credential.
      let appSource: 'credential' | 'selection' | 'argument' | 'worker' | null =
        ctx.appId ? (ctx.userId ? 'selection' : 'credential') : null;
      const appRef = input.appRef?.trim();
      if (appRef) {
        let resolvedAppId: string;
        try {
          ({ id: resolvedAppId } = await resolveAppRef(ctx.db, appRef));
        } catch (e) {
          if (e instanceof AppNotFoundError) {
            throw new GraphQLError(`App not found: ${appRef}`, { extensions: { code: 'BAD_USER_INPUT' } });
          }
          throw e;
        }
        const app = await ctx.db.app.findUniqueOrThrow({
          where: { id: resolvedAppId },
          select: { id: true, organizationId: true, ownerUserId: true, deletedAt: true, uninstalledAt: true },
        });
        // resolveAppRef already excludes soft-deleted rows, and excludes
        // uninstalled ones on the URN path only — re-check both here so the ID
        // path can't attach a session to a dead App.
        //
        // The URN/PK asymmetry on APP_UNINSTALLED is deliberate, not an
        // oversight (#944 review): App URNs are unique only among ACTIVE rows
        // (spec 021 FR-027), so an uninstalled App's URN may name several dead
        // rows and/or belong to a different live App — "not found" is the only
        // honest answer there. By PK the row is unambiguous, so it earns the
        // more specific refusal. Both forms are tested.
        if (app.deletedAt) {
          throw new GraphQLError(`App not found: ${appRef}`, { extensions: { code: 'BAD_USER_INPUT' } });
        }
        if (app.uninstalledAt) {
          throw new GraphQLError('Cannot start a session in an uninstalled App.', {
            extensions: { code: 'APP_UNINSTALLED', appId: resolvedAppId },
          });
        }
        // Precedence (documented decision, #943): an App-key CREDENTIAL wins
        // over a caller-supplied ref. A pure App-key principal IS an App, so a
        // ref naming a different App is a client bug, not a widening — refuse
        // it typed rather than silently honouring one or the other.
        //
        // #1037: keyed on the ABSENCE of a userId, not on `ctx.appId` alone.
        // The comment always said "credential"; the check caught the MCP
        // active-App SELECTION too, so a user whose connection was pinned to B
        // could not deliberately start a session in A — the exact precedence
        // this PR promises, contradicted one level above where it is granted.
        // The distinction is spelled out in the very next comment block, which
        // is a good measure of how easily this field name misleads
        // (findings:auth-appid-credential-vs-selection). A user's selection
        // yields to the argument; the participant gate below still runs on the
        // resolved App, so yielding never widens reach.
        if (ctx.appId && !ctx.userId && ctx.appId !== resolvedAppId) {
          throw new GraphQLError(
            `appRef "${appRef}" does not name the App this request is authenticated for.`,
            { extensions: { code: 'SESSION_APP_MISMATCH', appId: ctx.appId } },
          );
        }
        // Authority. A pure App-key principal (no userId) needs no membership:
        // its credential IS the App. Everyone else — including a HYBRID
        // principal carrying MCP's active-App SELECTION, which is not a
        // credential (findings:auth-appid-credential-vs-selection) — must be a
        // member of the resolved App, the same predicate the team-chat gate
        // uses. Without this, any caller could stamp any App's id onto a
        // session and author into that team's chat as its persona.
        if (ctx.userId || !ctx.appId) {
          if (!(await isAppParticipant(ctx, app))) {
            throw new GraphQLError(
              'You are not a member of this App, so a session cannot be attributed to it.',
              { extensions: { code: 'FORBIDDEN' } },
            );
          }
        }
        appId = resolvedAppId;
        // An explicit argument outranks a selection but not a credential — the
        // credential branch above already refused a disagreeing ref.
        if (appSource !== 'credential') appSource = 'argument';
      }

      // #974: optional Worker binding (cor:agt:020:03) — the named identity
      // this session works as. An id or a `hrn:worker:…` URN (#991), whose leaf
      // is the derived slug — cor:agt:020:02 keeps the NAME out of URNs, and
      // the derived identifier never refuses. Gated: the worker must belong to the
      // session's App; with no App context yet, the worker's App becomes the
      // session's — behind the SAME participant predicate the appRef path
      // runs, so binding a worker never widens who can attribute a session to
      // an App. A retired worker refuses new bindings; a TAKEN worker (an
      // active session — honest since the #930 reaper) refuses WORKER_TAKEN
      // unless force (#940 — informed takeover moved server-side per the
      // thin-client directive; before this it was the CLI's contract only,
      // and this mutation was an ungated second surface in waiting).
      let workerId: string | undefined;
      // #1029 — the worker's previous stint, derived below when the caller
      // supplies no explicit chain link.
      let derivedPrevSessionId: string | undefined;
      // #1050 — set when this bind should claim an unheld name; executed inside
      // the session-creating transaction so the two commit together.
      let claimWorkerId: string | undefined;
      // #1625 review (Baloo P2-2): set when this bind names a worker, and
      // re-run inside the transaction under the Worker lock.
      let assertWorkerNotTaken: ((db: Context['db']) => Promise<void>) | null = null;
      // #1707 (cor:agt:060:04): the session's model family — given, or derived
      // from the model, then the tool. Refused before anything is written when
      // given in a shape no family has; a matching input, never authorization.
      let family: string | null = null;
      if (input.family != null && input.family.trim() !== '') {
        family = normalizeFamily(input.family);
        if (!family) {
          throw new GraphQLError(
            'family is a model family token: lowercase letters, digits, ".", "_" or "-", up to 64 characters (e.g. claude, codex, glm).',
            { extensions: { code: 'BAD_USER_INPUT' } },
          );
        }
      } else {
        family = deriveFamily({ llmModel: input.llmModel, tool: input.tool });
      }

      const workerRef = input.workerRef?.trim();
      if (workerRef) {
        // #991: a Worker id OR an hrn:worker:<root>:<app-slug>:<worker-slug>
        // URN, via the shared ref helper. #990 adds a third form: a worker
        // NAME ("Iris"), resolved within this session's App. Identity only —
        // every gate below (retirement, App match, participation,
        // WORKER_TAKEN) still runs on the RESOLVED row, so a ref buys
        // addressability, never access.
        //
        // The forms are told apart by SHAPE, not by trying each in turn: an id
        // or a scheme-prefixed URN is self-describing, and anything else is a
        // name. Falling back from URN-resolution failure to a name lookup would
        // make a typo'd URN silently search the roster.
        let resolvedWorkerId: string;
        if (isId(workerRef) || hasSchemePrefix(workerRef)) {
          try {
            ({ id: resolvedWorkerId } = await resolveWorkerRefId(ctx.db, workerRef));
          } catch {
            throw workerRefNotFound(workerRef);
          }
        } else {
          // NAME (#990). A name is unique only WITHIN an App, so this form
          // needs App context — which a bare-name caller always has, since it
          // comes from an App key, an explicit appRef, or an MCP active-App
          // selection. Without one there is nothing to scope the lookup to, and
          // guessing across the caller's Apps would resolve one name to
          // several workers.
          if (appId === null) {
            throw new GraphQLError(
              `workerRef "${workerRef}" is a worker name, which is only unique within an App — pass appRef (or select an App), or use the worker's id or URN.`,
              { extensions: { code: 'SESSION_WORKER_NAME_NEEDS_APP', workerRef } },
            );
          }
          // App lifecycle, checked here and not only at the gate (PR #996
          // review, Copilot). When `appId` came from `appRef` these were
          // already enforced above, and the worker-DERIVED path enforces them
          // below — but when it came from `ctx.appId` (an MCP active-App
          // SELECTION or an App key) this is the only lifecycle check before
          // `session.create`. A stale selection pointing at an uninstalled App
          // must not be able to resolve a name and open a session there.
          //
          // This stays HERE rather than inside the shared resolver (#1015):
          // uninstall bars starting a session, but not READING the roster —
          // Worker rows outlive their App's uninstall — so the two callers
          // genuinely differ, and only on this point.
          const lifecycle = await ctx.db.app.findUnique({
            where: { id: appId },
            select: { uninstalledAt: true },
          });
          if (lifecycle?.uninstalledAt) {
            throw new GraphQLError('Cannot start a session in an uninstalled App.', {
              extensions: { code: 'APP_UNINSTALLED', appId },
            });
          }
          // The staff read gate runs BEFORE the lookup, not after, and a denial
          // is reported as WORKER_NOT_FOUND — the shared
          // `resolveWorkerIdByNameGated` owns that ordering (#1015) so this
          // resolver and `Query.worker` cannot drift on it. A missing App, a
          // soft-deleted App, a refused caller and an absent name all return
          // null there and collapse into the one refusal below.
          //
          // In practice a caller who reached here via `appRef` has ALREADY
          // cleared `isAppParticipant` above, the same predicate that gate
          // uses, so an outsider is refused FORBIDDEN before any name is looked
          // up. The gate is therefore defense in depth, not the only barrier —
          // and deliberately so: `appId` can also arrive from an App-key
          // credential (which skips that membership branch), so the name branch
          // must be self-sufficient rather than relying on an ordering above it
          // that a later change could reshuffle.
          const byName = await resolveWorkerIdByNameGated(ctx, appId, workerRef);
          if (!byName) throw workerRefNotFound(workerRef);
          resolvedWorkerId = byName;
        }
        const worker = await ctx.db.worker.findUnique({
          where: { id: resolvedWorkerId },
          select: {
            id: true, appId: true, agentId: true, retiredAt: true,
            name: true, heldByUserId: true, heldAt: true,
          },
        });
        if (!worker) throw workerRefNotFound(workerRef);
        // #1937 (cor:agt:020:03, the #1742 oracle class): an id or URN names a worker in ANY App, so before any
        // refusal below can answer differently for a worker that exists, the caller must be able to read that
        // App's workers. Every downstream refusal (the grant mismatch, WORKER_RETIRED with its id,
        // SESSION_WORKER_NOT_IN_APP with both Apps' ids, the participant FORBIDDEN) is therefore reachable only
        // by a reader; anyone else gets exactly the absent ref's envelope. One exception: the worker a launch
        // grant names, whose holder the grant has already told it exists. A holder who has since lost the App
        // must still reach the FORBIDDEN that fails the start (#10775), not a not-found that leaves it hanging. The
        // accepted marginal (#1945): that holder can also learn their own grant's worker was retired, and no other's.
        if (!(launch && worker.id === launch.grant.workerId)) await requireWorkerVisibleOrNotFound(ctx, worker.appId, workerRef);
        // #1709: a grant starts the worker it names, and no other; checked before any gate whose refusal would
        // fail the start, so a mismatched ref is the caller's mistake, never a change in the world.
        if (launch && worker.id !== launch.grant.workerId) throw launchGrantInvalid();
        if (worker.retiredAt) {
          throw new GraphQLError(
            'This worker is retired — its name stays reserved, but it takes no new sessions.',
            { extensions: { code: 'WORKER_RETIRED', workerId: worker.id } },
          );
        }
        // #1037: an explicitly-qualified ref beats connection state.
        //
        // An id or a `hrn:worker:…` URN NAMES ITS OWN App — that is the whole
        // reason the URN form exists, and both the tool description and
        // `tasks:start-worker-session-desktop` promise it needs no
        // `hadron_set_active_app` first. But `appId` may already hold the MCP
        // active-App SELECTION, which any earlier bind in another App silently
        // re-points — so a worker following the documented path, from a
        // connection that has ever touched a second App, was refused on account
        // of state it never set and could not see. That also defeats the
        // premise #1038 was closed on: that a URN is safe BECAUSE its meaning
        // cannot be changed by someone else's action.
        //
        // A selection therefore yields to the ref; a CREDENTIAL never does (a
        // pure App-key principal IS its App, so a ref naming another is a
        // client bug), and neither does an explicit `appRef` argument, where
        // two deliberate statements genuinely disagree.
        const refNamesItsOwnApp = isId(workerRef) || hasSchemePrefix(workerRef);
        if (appId !== null && appId !== worker.appId && refNamesItsOwnApp && appSource === 'selection') {
          // Re-gate on the App we are adopting rather than the one we are
          // leaving: yielding to the ref must never widen who may attribute a
          // session to an App. The `appId === null` branch below runs the same
          // predicate, so clearing this makes the two paths converge.
          appId = null;
          appSource = 'worker';
        }
        if (appId !== null && appId !== worker.appId) {
          const held = await ctx.db.app.findUnique({
            where: { id: appId },
            select: { urn: true },
          });
          const source =
            appSource === 'credential'
              ? 'the App key this request is authenticated with'
              : appSource === 'argument'
                ? 'the appRef argument'
                : 'the active-App selection on this connection';
          throw new GraphQLError(
            `workerRef "${workerRef}" names a worker of a different App than this session is attributed to. ` +
              `This session is being attributed to ${held?.urn ?? appId}, from ${source}. ` +
              (appSource === 'credential'
                ? 'An App key can only open sessions in its own App.'
                : 'Pass an appRef naming the worker\'s App, or drop it and let the worker\'s own App decide.'),
            {
              extensions: {
                code: 'SESSION_WORKER_NOT_IN_APP',
                workerId: worker.id,
                appId,
                appSource,
                workerAppId: worker.appId,
              },
            },
          );
        }
        if (appId === null) {
          const app = await ctx.db.app.findUniqueOrThrow({
            where: { id: worker.appId },
            select: { id: true, organizationId: true, ownerUserId: true, deletedAt: true, uninstalledAt: true },
          });
          if (app.deletedAt) throw workerRefNotFound(workerRef);
          if (app.uninstalledAt) {
            throw new GraphQLError('Cannot start a session in an uninstalled App.', {
              extensions: { code: 'APP_UNINSTALLED', appId: worker.appId },
            });
          }
          if (ctx.userId || !ctx.appId) {
            if (!(await isAppParticipant(ctx, app))) {
              throw new GraphQLError(
                'You are not a member of this worker\'s App, so a session cannot be attributed to it.',
                { extensions: { code: 'FORBIDDEN' } },
              );
            }
          }
          appId = worker.appId;
        }
        // #1050 — a NAME is HELD by a person until released. This gate runs
        // before the liveness one below and is not forceable, because the two
        // answer different questions and only one of them is a judgement call:
        //
        //   HELD   — "this name is someone's." The remedy is to cast your own
        //            worker, never to adjudicate whether the holder is really
        //            gone. There is no correct way to make that call from a
        //            session row, which is exactly what hadron-cli#492 proved:
        //            an agent judged a session abandoned, ENDED it, and bound
        //            as that worker while its driver was mid-PR — every step
        //            following the documented procedure.
        //   TAKEN  — "a live session already exists." Only ever a question
        //            about your OWN worker now, and still forceable, because
        //            the driver deciding is the driver affected.
        //
        // The hold does not depend on session state, so expiry, a reap, or a
        // closed chat session never free it. That also removes the asymmetry
        // in #1036/#484 where a timer could silently de-authorise a live
        // driver.
        // Note the absence of a `ctx.userId &&` guard (PR #1052 review, Codex +
        // Copilot P1): with one, a pure App-key principal — whose `ctx.userId`
        // is undefined — sailed straight past this and could bind a name held
        // by a human. A hold is the single source of truth for whose name it
        // is, so it refuses EVERY principal but the holder; an App key is not
        // a person and can hold nothing, so it is always the wrong one.
        if (worker.heldByUserId && worker.heldByUserId !== ctx.userId) {
          const holder = await ctx.db.user.findUnique({
            where: { id: worker.heldByUserId },
            select: { handle: true, githubUsername: true },
          });
          const who = holder?.handle ?? holder?.githubUsername ?? worker.heldByUserId;
          throw new GraphQLError(
            `The name "${worker.name}" is held by ${who}. A held name is not freed by a worker session ending, ` +
              'and this cannot be forced — cast your own worker instead ' +
              '(the holder, or an App/org admin, can release it).',
            {
              extensions: {
                code: 'WORKER_HELD',
                workerId: worker.id,
                heldBy: worker.heldByUserId,
                heldByName: who,
                heldAt: worker.heldAt?.toISOString() ?? null,
              },
            },
          );
        }
        // #940 (cor:agt:020:03 — informed takeover, never silent): binding a
        // worker that already has an ACTIVE session refuses typed, carrying
        // who last drove it and when — everything the takeover prompt needs
        // in one round trip — unless the caller explicitly forces. Ordering
        // is load-bearing: this runs AFTER the App/participant gates above,
        // because WORKER_TAKEN discloses the driver's identity and an
        // unauthorized caller must hit FORBIDDEN first. Best-effort by
        // design: there is no lease (liveness stays derivable from active
        // sessions), so two concurrent starts can both pass — the contract
        // is informed consent, not mutual exclusion.
        // #1625 review (Baloo P2-2): the WORKER_TAKEN decision runs here for the
        // early, rich refusal AND again inside the bind transaction under the
        // Worker lock, so it is decided on state no concurrent bind or resume
        // can change before the insert commits.
        const takenWorker = worker;
        assertWorkerNotTaken = async (db: Context['db']) => {
          // ALL active sessions, not the newest-created (PR #983 review,
          // Copilot): force allows several to coexist, and the most recent
          // ACTIVITY can be on an older one — the takeover prompt must name
          // whoever actually drove the worker last.
          const nowForLiveness = new Date();
          const openSessions = await db.session.findMany({
            // #1120 review (Codex P2): BOUNDED. Nothing closes abandoned
            // sessions any more, so open rows accumulate per worker and an
            // unbounded scan — plus every id in an `IN (...)` — grows with the
            // worker's whole history. The filter drops rows that cannot be
            // live under ANY type's window; the cap is only a backstop behind
            // it, because a cap alone could drop the live row itself.
            where: {
              workerId: takenWorker.id, endedAt: null, deletedAt: null,
              ...recentlyTouchedFilter(nowForLiveness),
            },
            // ORDERED BY HEARTBEAT, not by bind time (#1120 review, Codex P2).
            // The cap keeps a prefix, so what the prefix is ordered BY decides
            // what survives it. `startedAt` is when a stint began, which says
            // nothing about who drove it last — so an older-started session
            // with a fresh heartbeat could be cut, and `mostRecentlyActive`
            // would then name the wrong driver in the refusal. That is the
            // hadron-cli#492 harm arriving inside the message written to
            // prevent it.
            //
            // RESIDUAL, stated rather than papered over: `updatedAt` is two of
            // the three heartbeat inputs, and the third (the latest attributed
            // UsageEvent) cannot be an `orderBy` without a join. So a session
            // winning purely on a usage event, behind more than
            // OPEN_SESSION_SCAN_CAP others with newer `updatedAt`, can still be
            // cut. That needs >200 CONCURRENTLY LIVE sessions on one worker —
            // reachable only through repeated explicit `force`, each of which
            // takes a human override — and it costs a misnamed driver in a
            // refusal, never a wrong allow/deny. The gate itself is unaffected:
            // ANY live session refuses.
            orderBy: [
              { updatedAt: { sort: 'desc' as const, nulls: 'last' as const } },
              { startedAt: 'desc' as const },
            ],
            take: OPEN_SESSION_SCAN_CAP,
            select: {
              id: true, userId: true, startedAt: true, updatedAt: true,
              // #1114: liveness is DERIVED, so the gate needs the inputs.
              type: true, autoExpiredAt: true, endedAt: true, expiresAt: true,
            },
          });
          // #1114 — AN OPEN SESSION IS NOT A LIVE ONE. Nothing ends a session
          // for inactivity any more (silence is not evidence of abandonment),
          // so `endedAt IS NULL` alone would refuse a bind forever on any
          // worker whose driver simply walked away — leaving `force: true` as
          // the only route, which is the reflexive override this refusal exists
          // to prevent.
          //
          // The predicate is the SHARED one (`isSessionLive`), not a second
          // reading of the same idea: `cor:agt:020:11` requires that what a
          // roster SHOWS and what a bind ENFORCES be one computation, and the
          // roster's copy lives in SQL because it must aggregate. Two
          // derivations that must agree are pinned by a differential test
          // rather than by hoping.
          const lastEventForLiveness = await loadLastEventBySession(
            db as never,
            openSessions.map((s) => s.id),
          );
          const activeSessions = openSessions.filter((s) =>
            isSessionLive(s, lastEventForLiveness.get(s.id), nowForLiveness),
          );
          if (activeSessions.length > 0) {
            // lastSeenAt mirrors the #930 reaper's activity derivation:
            // greatest of startedAt, updatedAt (the explicit heartbeat), and
            // the latest attributed UsageEvent — computed per session, then
            // the most recently active session wins.
            //
            // Both steps now come from `lib/sessionActivity.ts` (hadron-cli#487):
            // the same derivation had to answer `Worker.lastActiveAt`, and a
            // third hand-written copy of "when was this last driven" is how the
            // takeover prompt and the roster start disagreeing about the same
            // worker in the same second.
            const lastEventBySession = await loadLastEventBySession(
              db as never,
              activeSessions.map((s) => s.id),
            );
            const best = mostRecentlyActive(activeSessions, lastEventBySession);
            const active = best?.session ?? activeSessions[0];
            const lastSeenAt = best?.at ?? active.startedAt;
            const driver = active.userId
              ? await db.user.findUnique({
                  where: { id: active.userId },
                  select: { handle: true, githubUsername: true },
                })
              : null;
            const lastDriver = driver?.handle ?? driver?.githubUsername ?? active.userId ?? null;
            // #1034: this refusal is where the worker-session/chat-session
            // collision surfaces to a human, and it is the specific failure a
            // team new to the surface walks into — archive the window, assume
            // the worker came free, meet a takeover prompt with no way to read
            // it. Two things the old wording left the reader to infer wrongly:
            // WHOSE the open session is (it may be the caller's own, which the
            // old "show the user who is driving it" sent them hunting a
            // colleague for), and that `last seen` says whether anyone is
            // actually there (it does not — it is worker-session activity, and
            // a worker session outlives its chat session).
            //
            // What the server must NOT do is guess WHY it is open. It knows the
            // row exists; it has no signal tying that row to a closed chat
            // session, so "probably abandoned" would be an unsupported claim
            // pushing the reader toward force — the hadron-cli#492 harm, in the
            // message meant to prevent it. Both possibilities, then the
            // confirmation step (PR #1056 review, Copilot + Codex).
            const isOwnSession = !!ctx.userId && active.userId === ctx.userId;
            // Three arms, because "who is driving it" has three different
            // answers and two of them were previously collapsed into the
            // wrong one (PR #1056 review, Codex + Copilot). A pure App-key
            // bind attaches NO person, so `lastDriver` is null and telling the
            // caller to go ask the driver names somebody who does not exist —
            // the same defect as the old self-case wording, one arm over.
            const takenBy = isOwnSession
              ? 'That worker session is YOUR OWN and is still open — either you are still working in it from another chat session, or it was left behind by one that ended (ending a chat session never ends a worker session). The server cannot tell which. Confirm with the user that nothing is still running in it, then pass force: true.'
              : lastDriver
                ? 'Show the user who is driving it, and pass force: true only on their explicit override.'
                : 'No person is attached to that worker session — it was opened by an App key, so there is nobody to ask. Confirm with the user that the automation holding it is not mid-task, then pass force: true.';
            throw new GraphQLError(
              `This worker is taken: worker session ${active.id}${lastDriver ? ` (last driven by ${lastDriver})` : ''}, last seen ${lastSeenAt.toISOString()}. ` +
                takenBy +
                (isOwnSession
                  ? ''
                  : ' Note "last seen" is worker-session activity, not presence: a worker session outlives the chat session that started it, so an idle-looking one may still have someone behind it.'),
              {
                extensions: {
                  code: 'WORKER_TAKEN',
                  workerId: takenWorker.id,
                  sessionId: active.id,
                  lastDriver,
                  lastSeenAt: lastSeenAt.toISOString(),
                },
              },
            );
          }
                };
        if (!input.force) await assertWorkerNotTaken(ctx.db);
        // Session.agentId keeps recording the ROLE-agent behind the casting
        // (cor:agt:020:03); an agentRef naming a DIFFERENT agent is a client
        // bug, refused rather than silently overridden.
        if (agentId !== undefined && agentId !== worker.agentId) {
          throw new GraphQLError(
            'agentRef and workerRef disagree — the worker casts a different agent. Omit agentRef; it is derived from the worker.',
            { extensions: { code: 'BAD_USER_INPUT' } },
          );
        }
        agentId = worker.agentId;
        workerId = worker.id;
        // #1050 — an UNHELD name is held by the person who binds it. That is
        // the claim path: casting holds nothing, so a fresh roster, a released
        // name, or one cast by an App key all find their holder here.
        //
        // DEFERRED into the session-creating transaction below rather than done
        // here (PR #1052 review, Codex P2): as a separate write it committed
        // before `session.create` ran, so a create that then failed — a retried
        // duplicate id, an invalid relation — left the caller holding a name
        // they never bound. Claim and bind are one act and now commit together.
        //
        // Set for an App-KEY binder too, which claims nothing: it marks the
        // worker as needing a re-check inside the transaction, so a key cannot
        // bind a name a human claimed in the meantime.
        if (!worker.heldByUserId) claimWorkerId = worker.id;
        // #1029: wire the continuity chain. `prevSessionId` and
        // `parentSessionId` have been in the schema since the beginning and
        // unused, so the chain primitive existed with nothing writing it. An
        // explicit input still wins: a caller stitching a sub-agent chain knows
        // something this default does not.
        //
        // Deliberately the most recent ENDED session, matching
        // Worker.continuity's definition of "previous" — with `force`, two
        // stints can overlap, and chaining to a still-open one would record
        // that a session succeeded another that had not finished.
        if (input.prevSessionId === undefined || input.prevSessionId === null) {
          const previous = await ctx.db.session.findFirst({
            where: { workerId: worker.id, endedAt: { not: null }, deletedAt: null },
            orderBy: { endedAt: 'desc' as const },
            select: { id: true },
          });
          if (previous) derivedPrevSessionId = previous.id;
        }
      }

      // #1726: `reportsTo` at bind names a worker of the session's App (id,
      // URN or name). Resolved here; written in the bind's transaction below.
      const reportsToRef = input.reportsTo?.trim();
      let reportsToId: string | null = null;
      if (reportsToRef) {
        if (!workerId || !appId) {
          throw new GraphQLError('reportsTo needs a worker bind (workerRef).', { extensions: { code: 'BAD_USER_INPUT' } });
        }
        // Within the session's App only: another App's worker reads as missing (#1737 QA, Chip's P2).
        reportsToId = await resolveReportsToTarget(ctx, appId, reportsToRef);
      }

      // #1617 C: sessions this bind ended as superseded. Their cached keys
      // are evicted only after the transaction commits, as endSessionFirstWins
      // does for an explicit end.
      let supersededIds: string[] = [];
      // #1883 review (Diego delta P2): a launch's re-check of the holder's standing runs under the authority anchors
      // its revokers take exclusively (removeAppMember and org-role changes: the App, its org and owner; updateUserRoles:
      // the user), read before the transaction so they can be taken first, before any row.
      const launchAnchors: AuthorityAnchor[] = [];
      if (launch && appId && ctx.userId) {
        const anchorApp = await ctx.db.app.findUnique({ where: { id: appId }, select: { organizationId: true, ownerUserId: true } });
        launchAnchors.push(
          { kind: 'app', id: appId },
          ...(anchorApp?.organizationId ? [{ kind: 'org' as const, id: anchorApp.organizationId }] : []),
          ...(anchorApp?.ownerUserId ? [{ kind: 'user' as const, id: anchorApp.ownerUserId }] : []),
          { kind: 'user', id: ctx.userId },
        );
      }
      const bound = await ctx.db.$transaction(async (tx) => {
        if (launchAnchors.length) await lockAuthorityAnchors(tx, launchAnchors, 'shared');
        // #1001: appId may have come only from an App key or an MCP active-App
        // selection, so neither the appRef nor Worker branches necessarily
        // checked lifecycle. Recheck the settled App in the transaction before
        // claiming a name or inserting a session. An explicit Worker ref may
        // have replaced a stale selection above; only the final App matters.
        // #2022 (Diego #2166 P2-2): a bind that sets reportsTo is a stop-coverage writer, so it takes the App's stop
        // fence EXCLUSIVE before any row lock, the App row included: an App-row writer (setTeamPause, under the
        // App's anchors) holds the fence shared before it updates that row, so taking the fence after the App row
        // here was a real deadlock (40P01). This path takes no authority anchors, so the fence is its first lock.
        if (reportsToId && appId) await lockStopFence(tx, appId, 'exclusive');
        if (appId) {
          await lockSessionAppActive(tx, appId);
        }
        // #1726: a bind that sets reportsTo is a reportsTo WRITER. It takes the
        // App's graph lock, then holds the caller's own authority rows (users,
        // app_members, org_members) FOR SHARE, all BEFORE the worker row below
        // (the lock protocol, src/lib/workerReportsTo.ts; #1737 review, Diego
        // P2-2, Rook P2-1). A demotion or role removal then commits first and is
        // seen, or waits for this bind.
        if (reportsToId && appId) {
          await lockAppReportsTo(tx, appId);
          if (ctx.userId) {
            await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${ctx.userId} FOR SHARE`;
            await tx.$queryRaw`SELECT 1 FROM app_members WHERE app_id = ${appId} AND user_id = ${ctx.userId} FOR SHARE`;
            await tx.$queryRaw`
              SELECT 1 FROM org_members m JOIN apps a ON a.organization_id = m.organization_id
              WHERE a.id = ${appId} AND m.user_id = ${ctx.userId} FOR SHARE OF m`;
          }
        }
        // #1625 review (Baloo P2-2, P2-3): EVERY worker bind takes the Worker
        // row lock, the same lock a lapsed-session resume takes (after the App
        // lock, in the same order), including a bind of a name the caller
        // already holds. Everything this bind decides about the worker's
        // sessions — WORKER_TAKEN and the superseded set — is re-read below,
        // after it, so two binds, or a bind and a resume, of one worker
        // serialize instead of each deciding on a stale view.
        // #1883 review (Diego P2-3): a launch binds on the holder's behalf, so the holder's standing in the App is
        // held for the bind like a reportsTo writer's (#1726 protocol): their user row and membership rows FOR SHARE,
        // BEFORE the worker row. A removal or demotion committed first and is seen by the re-check below, or waits.
        if (launch && appId && ctx.userId && !reportsToId) {
          await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${ctx.userId} FOR SHARE`;
          await tx.$queryRaw`SELECT 1 FROM app_members WHERE app_id = ${appId} AND user_id = ${ctx.userId} FOR SHARE`;
          await tx.$queryRaw`
            SELECT 1 FROM org_members m JOIN apps a ON a.organization_id = m.organization_id
            WHERE a.id = ${appId} AND m.user_id = ${ctx.userId} FOR SHARE OF m`;
        }
        // #1883 review (Riana P2): the bind and the host's report of the same start serialize on the OPERATION row,
        // taken before the worker row (collection's order: operation, then worker). A report that marked the start
        // failed first is seen here and the grant is spent; a report that comes later waits for this bind, then finds
        // its session and records the start as succeeded. Without it both could commit: a failed start beside its
        // launched session.
        if (launch) {
          const [op] = await tx.$queryRaw<Array<{ status: string }>>`
            SELECT status FROM host_operations WHERE id = ${launch.grant.operationId} FOR SHARE`;
          if (op?.status !== 'collected') throw launchGrantInvalid();
        }
        if (workerId) {
          const [locked] = await tx.$queryRaw<Array<{ name: string; held_by_user_id: string | null; held_at: Date | null; retired_at: Date | null }>>`
            SELECT name, held_by_user_id, held_at, retired_at FROM workers WHERE id = ${workerId} FOR UPDATE`;
          // #1625 review (Baloo, residual P2): the HOLD and retirement are
          // re-validated under the lock for EVERY bind, force included. The
          // checks far above read a snapshot; a release, a claim by someone
          // else, or a retirement can land during the lock wait, and a bind
          // must not proceed on the name as it was.
          if (!locked || locked.retired_at) {
            throw new GraphQLError(
              'This worker is retired — its name stays reserved, but it takes no new sessions.',
              { extensions: { code: 'WORKER_RETIRED', workerId } },
            );
          }
          if (locked.held_by_user_id && locked.held_by_user_id !== ctx.userId) {
            const holder = await tx.user.findUnique({
              where: { id: locked.held_by_user_id },
              select: { handle: true, githubUsername: true },
            });
            const who = holder?.handle ?? holder?.githubUsername ?? locked.held_by_user_id;
            throw new GraphQLError(
              `The name "${locked.name}" was taken by ${who} while this bind waited. ` +
                'This cannot be forced — cast your own worker instead.',
              { extensions: { code: 'WORKER_HELD', workerId, heldBy: locked.held_by_user_id, heldByName: who } },
            );
          }
          // #1709 (Holger via Vera #10775): a launch binds only a worker its
          // holder still holds. A hold released or moved since the start was
          // issued refuses the bind (never a claim), and nothing forces it.
          if (launch && (locked.held_by_user_id !== ctx.userId ||
              !sameHold(launch.hold, { userId: locked.held_by_user_id, at: locked.held_at }))) {
            // Diego P2-1: not only the holder, the very hold the start was issued under (a release and re-hold, or
            // a move and back, is a changed hold).
            throw new GraphQLError('The hold changed after this start was issued.', { extensions: { code: 'LAUNCH_REFUSED', reason: 'hold-changed' } });
          }
          if (launch && appId) {
            // Diego P2-3: the holder must still be able to hold this worker, judged on the transaction's view under
            // the rows held above: a participant, and on a user-owned App its owner or whoever manages it (#1764).
            // Diego delta P2: a LIVE context, not a copy of the request's: caches dropped and platform roles re-read
            // from the user row under the user anchor held above (the #1859 pattern), so a demotion that committed
            // while this bind waited is seen; a deleted user or revoked key reads as not permitted.
            const txCtx = await liveTxContext(ctx, tx).catch((e: unknown) => {
              if (e instanceof Error && e.message === 'Forbidden') return null;
              throw e;
            });
            const bindApp = await tx.app.findUnique({ where: { id: appId }, select: { id: true, organizationId: true, ownerUserId: true } });
            const may = !!txCtx && !!bindApp && (await isAppParticipant(txCtx, bindApp)) &&
              (bindApp.ownerUserId === null || ctx.userId === bindApp.ownerUserId || (await managesApp(txCtx, bindApp)));
            if (!may) {
              throw new GraphQLError('The holder may no longer hold this worker.', { extensions: { code: 'FORBIDDEN' } });
            }
          }
          // Released during the wait: an unheld name is claimed by this bind,
          // through the same compare-and-set path as a never-held one.
          if (!locked.held_by_user_id) claimWorkerId = workerId;
          if (!input.force && assertWorkerNotTaken) {
            await assertWorkerNotTaken(tx as unknown as Context['db']);
          }
        }
        // Everything about the hold is settled INSIDE this transaction, so the
        // decision and the session insert commit together. The row read far
        // above is a snapshot; by now another bind may have claimed the name.
        if (claimWorkerId) {
          const refuseHeld = async (heldByUserId: string, note: string): Promise<never> => {
            const [worker, holder] = await Promise.all([
              tx.worker.findUnique({ where: { id: claimWorkerId! }, select: { name: true } }),
              tx.user.findUnique({
                where: { id: heldByUserId },
                select: { handle: true, githubUsername: true },
              }),
            ]);
            throw new GraphQLError(
              `The name "${worker?.name ?? claimWorkerId}" ${note} ` +
                `${holder?.handle ?? holder?.githubUsername ?? heldByUserId}. ` +
                'Cast your own worker instead.',
              {
                extensions: {
                  code: 'WORKER_HELD',
                  workerId: claimWorkerId,
                  heldBy: heldByUserId,
                },
              },
            );
          };

          if (ctx.userId) {
            // PARTICIPATION is rechecked immediately before the hold is granted
            // (PR #1052 review, Codex P1). When `appId` came from an MCP
            // active-App SELECTION and the worker is of that same App, neither
            // gate above re-runs `isAppParticipant` — so a member whose access
            // was revoked while their connection stayed open could still take a
            // name and block the people who do belong. That is #1037's own rule
            // ("deriving scope re-authorizes, it never assumes") applied to the
            // write this PR adds, and a hold is standing, not just scope.
            const app = await tx.app.findUnique({
              where: { id: appId! },
              select: { id: true, organizationId: true, ownerUserId: true },
            });
            if (!app || !(await isAppParticipant({ ...ctx, db: tx as unknown as Context['db'] }, app))) {
              throw new GraphQLError(
                'You are not a member of this worker\'s App, so you cannot take one of its names.',
                { extensions: { code: 'FORBIDDEN' } },
              );
            }

            // #1764 (Rook P2, #8886; Ada's interim (b), #8897): on a USER-owned App, being a participant does not make
            // you a holder. A worker carries its holder's working memory, posting identity and grants, and a user-owned
            // App's participants now include every member at any role; so taking a name there needs the owner or
            // whoever manages the App (managesApp: the owner-role AppMember arm included). Org-owned Apps are unchanged.
            // Whether members may hold the owner's workers at all is Holger's call (#8897); until he rules, the gate.
            if (app.ownerUserId !== null && ctx.userId !== app.ownerUserId &&
                !(await managesApp({ ...ctx, db: tx as unknown as Context['db'] }, app))) {
              throw new GraphQLError(
                'Only the owner of this App, or whoever manages it, can take one of its worker names.',
                { extensions: { code: 'FORBIDDEN' } },
              );
            }

            // A SOFT-DELETED claimant must not take a name (Codex P2): a start
            // already in flight when `deleteUserAccount` runs could otherwise
            // land its claim after the deletion released everything, leaving an
            // unauthenticatable tombstone holding the worker. The User row
            // survives a soft delete, so the FK cannot catch this.
            const claimant = await tx.user.findUnique({
              where: { id: ctx.userId },
              select: { deletedAt: true },
            });
            if (claimant?.deletedAt) {
              throw new GraphQLError('This account is deleted and cannot take a worker name.', {
                extensions: { code: 'FORBIDDEN' },
              });
            }

            const claimed = await tx.worker.updateMany({
              where: { id: claimWorkerId, heldByUserId: null },
              data: { heldByUserId: ctx.userId, heldAt: new Date() },
            });
            // LOSING the race must refuse, not proceed. Both callers read
            // `heldByUserId: null` and cleared the liveness check; the
            // compare-and-set is what decides which took the name, and ignoring
            // its result let the loser open a session as a name someone else
            // now holds.
            if (claimed.count === 0) {
              const winner = await tx.worker.findUnique({
                where: { id: claimWorkerId },
                select: { heldByUserId: true },
              });
              if (winner?.heldByUserId && winner.heldByUserId !== ctx.userId) {
                await refuseHeld(winner.heldByUserId, 'was claimed a moment before this bind by');
              }
            }
          } else {
            // An App-KEY binder claims nothing — it is not a person and can
            // hold no name — but it must still lose the race rather than sit
            // outside it (Codex P1). Without this re-read, a human claiming
            // between the snapshot above and this transaction left the App key
            // free to bind a name that had just become held.
            const now = await tx.worker.findUnique({
              where: { id: claimWorkerId },
              select: { heldByUserId: true },
            });
            if (now?.heldByUserId) {
              await refuseHeld(now.heldByUserId, 'was claimed before this bind by');
            }
          }
        }
        // #1617 C (Holger, 2026-10-05, team chat #6568): binding a worker ENDS
        // the same person's other open sessions on it, the lapsed ones and the
        // one a `force` displaces. Before this a rebind left the old row open
        // forever (#1114 stopped anything else closing it), so every quiet
        // night added one more open-but-not-live session per worker. Ending
        // here is not an inference from silence: the rebind is the act, and
        // the same person is on both sides of it. Only the caller's OWN rows
        // on THIS worker: another person's session and an App-key session are
        // never touched. They end without a handoff, marked superseded in
        // `summary`, and the new session chains to the newest of them.
        const supersedes = workerId && ctx.userId && !ctx.impersonation
          ? await tx.session.findMany({
              where: {
                workerId, userId: ctx.userId, endedAt: null, deletedAt: null,
                ...(input.id ? { id: { not: input.id } } : {}),
              },
              orderBy: { startedAt: 'desc' as const },
              select: { id: true },
            })
          : [];
        const created = await tx.session.create({
        data: {
          id: input.id,
          type: (input.type as any) ?? 'DEVELOPER',
          appId,
          agentId,
          workerId,
          // #929 review P1: attribute the session to the calling user (the
          // schema documents userId as "the developer in a DEVELOPER
          // session"). Without it a session started outside any App context
          // (appId null — the CLI coding case) was invisible to its own
          // creator through both session read gates.
          userId: ctx.userId ?? null,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
          plan: input.plan,
          repo: input.repo,
          branch: input.branch,
          prNumber: input.prNumber,
          customerId: input.customerId,
          language: input.language,
          llmModel: input.llmModel,
          parentSessionId: input.parentSessionId,
          prevSessionId: input.prevSessionId ?? supersedes[0]?.id ?? derivedPrevSessionId,
          // #928 coding-session provenance.
          transcriptPath: input.transcriptPath,
          host: input.host,
          tool: input.tool,
          family,
          // #1709 (cor:agt:070:08): the launch, recorded on the session; the hold is unchanged.
          ...(launch ? {
            launchHostId: launch.grant.hostId,
            launchOperationId: launch.grant.operationId,
            launchTaskId: launch.grant.taskId,
            launchIssuedBy: launch.issuedBy,
          } : {}),
        },
        include: SESSION_INCLUDE,
        });
        // #1709: the grant is spent by THIS bind, atomically: of two concurrent redemptions one loses here, and its
        // whole bind rolls back.
        if (launch && !(await consumeGrant(tx, launch.grant.id, created.id, new Date()))) throw launchGrantInvalid();
        // #1726: set who the worker reports to, in one step with the bind (a
        // spawn brief). Only onto a worker that reports to nobody, or to the
        // same worker (nothing to do): naming a different one would move a
        // claimed worker, which takes whoever manages the App
        // (WORKER_REPORTS_TO_HELD otherwise). A person must be behind the bind.
        if (reportsToId && workerId && appId) {
          const bindAppId = appId;
          await writeReportsTo(tx, {
            workerId, appId: bindAppId, to: reportsToId, actor: eventActor(ctx.userId), setBy: 'bind',
            authorize: async (from) => {
              if (!ctx.userId || ctx.impersonation) {
                throw new GraphQLError('reportsTo at bind needs a person behind the request.', { extensions: { code: 'WORKER_REPORTS_TO_FORBIDDEN', workerId } });
              }
              if (from === null) return 'bind';
              const bindApp = await tx.app.findUniqueOrThrow({ where: { id: bindAppId }, select: { id: true, ownerUserId: true, organizationId: true } });
              // Platform roles as the user row holds them now (held FOR SHARE
              // above), never the request's: a stale token grants nothing.
              const me = await tx.user.findUnique({ where: { id: ctx.userId }, select: { roles: true, deletedAt: true } });
              const roles = me && !me.deletedAt ? (me.roles as Context['roles']) : [];
              if (await managesApp({ ...ctx, roles, db: tx }, bindApp)) return 'app-manager';
              throw new GraphQLError(
                'This worker already reports to another worker. Its current one hands it over (setWorkerReportsTo), or whoever manages the App changes it.',
                { extensions: { code: 'WORKER_REPORTS_TO_HELD', workerId, reportsTo: from } },
              );
            },
          });
          // #2022 (R95): a team signal covers the worker from the moment it joins the team.
          await reconcileStopCoverage(tx, bindAppId, new Date());
        }
        if (supersedes.length > 0) {
          const ids = supersedes.map((r) => r.id).filter((id) => id !== created.id);
          const endedAt = new Date();
          // A driver-written summary is kept; an empty one records why it ended.
          await tx.session.updateMany({
            where: { id: { in: ids }, endedAt: null, summary: null },
            data: { summary: `superseded by session ${created.id}` },
          });
          await tx.session.updateMany({
            where: { id: { in: ids }, endedAt: null },
            data: { endedAt, endReason: 'superseded' },
          });
          supersededIds = ids;
        }
        return created;
      });
      for (const id of supersededIds) sessionKeyCache.evict(id);
      return bound;
    }),

    // #931: set a live session's mutable provenance fields mid-session — a PR
    // usually gets opened AFTER startSession already ran, so prNumber needs a
    // write path that doesn't wait for endSession. Explicit null clears,
    // omitted preserves. Deliberately id-only (sessions have no URN, so there
    // is no ref form to accept — cor:api:140's "genuine PK" case). Any
    // authorized update also bumps updatedAt, which is the liveness heartbeat
    // the #930 inactivity reaper counts (an empty update is a valid "touch").
    // Updates on an ENDED session stay allowed: a PR merge lands after the
    // session ends, and late attribution is better than none.
    updateSession: async (
      _: unknown,
      { id, prNumber, branch, llmModel, family }: { id: string; prNumber?: number | null; branch?: string | null; llmModel?: string | null; family?: string | null },
      ctx: Context,
    ) => {
      const session = await ctx.db.session.findUnique({ where: { id } });
      if (!session || session.deletedAt) {
        throw new GraphQLError(`Session not found: ${id}`, { extensions: { code: 'BAD_USER_INPUT' } });
      }
      await requireSessionWriteAccess(ctx, session);
      // #1931: refresh a binding without guessing a model family from its host.
      // Null/omitted metadata never clears an existing family during recovery.
      const refresh = modelFamilyRefresh(explicitFamilyOrThrow(family), llmModel, session.tool);
      return ctx.db.session.update({
        where: { id },
        data: {
          ...(prNumber !== undefined ? { prNumber } : {}),
          ...(branch !== undefined ? { branch } : {}),
          ...refresh,
          updatedBy: ctx.userId ?? ctx.clientId ?? null,
          // #1543 — a pr/branch edit must not revive a lapsed session.
          ...(await preserveHeartbeatIfLapsed(ctx.db as never, id)),
        },
        include: SESSION_INCLUDE,
      });
    },

    endSession: async (
      _: unknown,
      {
        id,
        summary,
        handoff,
        inputTokens,
        outputTokens,
        turnCount,
        errorCount,
        resumeClaim,
      }: { id: string; summary?: string; handoff?: string; inputTokens?: number; outputTokens?: number; turnCount?: number; errorCount?: number; resumeClaim?: boolean | null },
      ctx: Context,
    ) => {
      // #931: same write gate as updateSession — this was previously ungated,
      // so any authenticated principal holding a session id could end it and
      // overwrite its summary (and free another driver's persona, since
      // "taken" derives from active sessions post-#928).
      const session = await ctx.db.session.findUnique({ where: { id } });
      if (!session || session.deletedAt) {
        throw new GraphQLError(`Session not found: ${id}`, { extensions: { code: 'BAD_USER_INPUT' } });
      }
      await requireSessionWriteAccess(ctx, session);

      // #1029: the closing handoff, written BEFORE the end and only for a
      // worker-bound session. Ordering is the whole safety property here — if
      // this throws, the session is still open and the caller can retry or end
      // without a handoff deliberately. Ending first and losing the prose is
      // unrecoverable: the context that composed it is gone with the stint.
      // #1956: a claim's eligibility is judged BEFORE the handoff is written, so a refused claim leaves no handoff
      // behind for a stint that did not end. The claim itself is written after the handoff, before the end.
      const claimOwner = resumeClaim ? await ownSessionForClaim(ctx, id) : null;
      if (claimOwner?.endedAt) throw sessionEndedForClaim(id);

      const handoffBody = handoff?.trim();
      if (handoffBody) {
        if (!session.workerId) {
          throw new GraphQLError(
            'A handoff belongs to a worker\'s continuity sequence, and this session is not bound to a worker.',
            { extensions: { code: 'SESSION_NOT_WORKER_BOUND', sessionId: id } },
          );
        }
        // The already-ended refusal and the per-session idempotence both live
        // in writeSessionHandoff, so the MCP end path inherits them instead of
        // reimplementing them (PR #1045 review).
        await writeSessionHandoff(ctx, session.id, session.workerId, handoffBody);
      }

      // #1956: the resume claim, written with the handoff and before the end, so the fresh context of a rotation
      // can start the worker's next stint with one no-argument resumeSession. Only the session's own driver, and
      // only while it is open: the claim is a promise about this stint, not a key to an ended one.
      if (claimOwner) {
        await writeResumeClaim(ctx.db, { sessionId: id, appId: claimOwner.appId, workerId: claimOwner.workerId, holderUserId: claimOwner.userId });
      }

      // FIRST END WINS, decided by a guarded write rather than by the row read
      // above: `endedAt` orders the continuity chain (both `Worker.continuity`'s
      // "previous" and startSession's `prevSessionId` derivation key on it), so
      // a late retry — or the reaper landing between this handler's read and
      // its write — must not re-order a worker's history around a stint that
      // finished long ago.
      await endSessionFirstWins(ctx.db, id, {
        summary, inputTokens, outputTokens, turnCount, errorCount,
      });
      return ctx.db.session.findUniqueOrThrow({ where: { id }, include: SESSION_INCLUDE });
    },

    /**
     * #1956 (cor:agt:020:03) — write a resume claim for the caller's own open worker session, before a deliberate
     * context reset that keeps the session (a shed). Redeemable by resumeSession for RESUME_CLAIM_TTL_MS (60 s),
     * once, and only by this caller. Replaces any unused claim for the same session. The receipt names no claim id:
     * redemption is judged by the caller's token, so there is nothing to present.
     */
    createResumeClaim: async (_: unknown, { sessionId }: { sessionId: string }, ctx: Context) => {
      const own = await ownSessionForClaim(ctx, sessionId);
      if (own.endedAt) throw sessionEndedForClaim(sessionId);
      const { expiresAt } = await writeResumeClaim(ctx.db, { sessionId, appId: own.appId, workerId: own.workerId, holderUserId: own.userId });
      return { sessionId, workerId: own.workerId, expiresAt };
    },

    /**
     * #1956 (cor:agt:020:03; Vera's proposal on hadron-cli#842) — recover a worker binding after a context reset,
     * with one call and no arguments. Judged entirely on the caller's own user id, so a non-holder, an App key or
     * an impersonation gets the same NOTHING_TO_RESUME as a caller with nothing (no oracle, gate invariant b):
     *  - one live claim: consumed by a guarded update and bound (RESUMED for an open session, STARTED for an ended
     *    one: the worker's next session, through startSession's own gates, inheriting the handoff);
     *  - several: CHOOSE, listing the worker and session for each, consuming nothing;
     *  - none: the fast path over the caller's own LIVE worker sessions, one RESUMED, several CHOOSE;
     *  - `session` picks one of the listed sessions.
     * A redemption that loses the consume race is refused rather than falling through to the fast path, so two
     * contexts never both take one claim. Resuming an open session goes through the shared lifecycle gate, so a
     * moved name, lost App eligibility, a hard expiry, dormancy or another live session refuses RESUME_REFUSED
     * (#1966 review, Anne P2-1); a STARTED redemption that startSession refuses surfaces that refusal. Either way
     * the claim is spent. A fast-path pool too large to decide on refuses RESUME_AMBIGUOUS rather than guessing.
     * Nothing is ever posted or recorded on a refusal.
     */
    resumeSession: async (_: unknown, { input }: { input?: ResumeSessionInput | null }, ctx: Context) => {
      const given = input ?? {};
      if (!ctx.userId || ctx.impersonation) throw nothingToResume();
      const userId = ctx.userId;
      // #2086: a bad family refuses BEFORE any claim is read or spent. It sits after the NOTHING_TO_RESUME line
      // above, so an App key or an impersonation learns nothing about the value either way.
      const explicitFamily = explicitFamilyOrThrow(given.family);
      const now = new Date();
      const claims = await liveClaimsOf(ctx.db, userId, now);

      const resumed = async (sessionId: string, outcome: 'RESUMED' | 'STARTED') => ({
        outcome,
        session: await ctx.db.session.findUniqueOrThrow({ where: { id: sessionId }, include: SESSION_INCLUDE }),
        candidates: [],
      });
      /**
       * Resume an open session through the shared lifecycle gate (#1966 review, Anne P2-1), in ONE transaction with
       * the claim's consume when there is one: the gate re-reads ownership, the hold, current App eligibility, the
       * hard expiry, dormancy and "no other live session" under the App→Worker locks a bind takes, and its touch is
       * guarded. A claim is spent even when the gate refuses (it was redeemed; the answer is the refusal).
       * A claim lost to a racing replacement or redemption rolls the whole act back and answers NOTHING_TO_RESUME.
       */
      const resumeOpen = async (sessionId: string, claimId: string | null) => {
        // The gate runs FIRST and the claim is consumed LAST (Anne's P2-4): App -> Worker -> Session -> Claim, the
        // order the claim writer's Session -> Claim agrees with. A claim that turns out spent (a replacement or a
        // racing redemption won) rolls the gate's touch back with it.
        const lost = new Error('resume claim lost');
        let verdict: 'OK' | 'REFUSED' | 'GONE';
        try {
          verdict = await ctx.db.$transaction(async (tx) => {
            const ok = await resumeOwnLapsedSessionInTx(ctx, tx, sessionId);
            // #2086: only after the gate permits, inside its transaction, so a refusal or a lost claim writes nothing.
            if (ok) {
              const stored = await tx.session.findUniqueOrThrow({ where: { id: sessionId }, select: { tool: true } });
              const refresh = modelFamilyRefresh(explicitFamily, given.llmModel, stored.tool);
              if (Object.keys(refresh).length) await tx.session.update({ where: { id: sessionId }, data: { ...refresh, updatedBy: userId } });
            }
            if (claimId) {
              if (!(await consumeResumeClaim(tx, claimId, userId))) throw lost;
              if (ok) await tx.resumeClaim.update({ where: { id: claimId }, data: { resumedSessionId: sessionId } });
            }
            return ok ? ('OK' as const) : ('REFUSED' as const);
          });
        } catch (e) {
          if (e !== lost) throw e;
          verdict = 'GONE';
        }
        if (verdict === 'GONE') throw nothingToResume();
        if (verdict === 'REFUSED') throw resumeRefused((await lapsedResumeVerdict(ctx, sessionId)) === 'DORMANT');
        return resumed(sessionId, 'RESUMED');
      };
      const redeem = async (c: (typeof claims)[number]) => {
        const claimed = await ctx.db.session.findUnique({ where: { id: c.sessionId }, select: { endedAt: true, deletedAt: true } });
        // A shed: the session is still open, so it is resumed, never replaced.
        if (claimed && !claimed.deletedAt && !claimed.endedAt) return resumeOpen(c.sessionId, c.id);
        // A rotation: the claimed stint ended, so the worker's next one starts through startSession's own gates
        // (hold, retirement, App, WORKER_TAKEN), which derive prevSessionId and deliver the handoff at bind.
        if (!(await consumeResumeClaim(ctx.db, c.id, userId))) throw nothingToResume();
        const started = await sessionMutations.startSession({}, {
          input: {
            id: generateId(),
            appRef: c.appId,
            workerRef: c.workerId,
            plan: given.description ?? undefined,
            tool: given.tool ?? undefined,
            host: given.host ?? undefined,
            llmModel: given.llmModel ?? undefined,
            family: given.family ?? undefined,
            transcriptPath: given.transcriptPath ?? undefined,
          } as SessionInput,
        }, ctx);
        await ctx.db.resumeClaim.update({ where: { id: c.id }, data: { resumedSessionId: started.id } });
        return resumed(started.id, 'STARTED');
      };
      const resumeLive = (sessionId: string) => resumeOpen(sessionId, null);

      if (given.session) {
        const picked = claims.find((c) => c.sessionId === given.session);
        if (picked) return redeem(picked);
        const live = await liveWorkerSessionsOf(ctx.db, userId, now);
        if (live.some((l) => l.id === given.session)) return resumeLive(given.session);
        throw nothingToResume();
      }
      if (claims.length === 1) return redeem(claims[0]);
      if (claims.length > 1) {
        return {
          outcome: 'CHOOSE',
          session: null,
          candidates: await toCandidates(ctx.db, claims.map((c) => ({ sessionId: c.sessionId, workerId: c.workerId, source: 'CLAIM' as const, expiresAt: c.expiresAt }))),
        };
      }
      const live = await liveWorkerSessionsOf(ctx.db, userId, now);
      if (live.length === 1) return resumeLive(live[0].id);
      if (live.length > 1) {
        return {
          outcome: 'CHOOSE',
          session: null,
          candidates: await toCandidates(ctx.db, live.map((l) => ({ sessionId: l.id, workerId: l.workerId!, source: 'LIVE_SESSION' as const, expiresAt: null }))),
        };
      }
      throw nothingToResume();
    },

    recordUsage: async (_: unknown, { event }: { event: UsageEventInput }, ctx: Context) => {
      // #825: attribution must never name a node the caller cannot read.
      // `nodeLoc` is a bare loc, and loc is unique per MEMORY rather than
      // globally, so the old unscoped `findFirst` resolved to an arbitrary
      // tenant's node and stamped ITS memoryId onto the row — landing in that
      // org's usage analytics (#796/#799 scope on UsageEvent.memoryId).
      //
      // Resolution now runs through the shared read gate, so the candidate set
      // is exactly what this caller may read. An unreadable or absent loc
      // yields no attribution (nodeId/memoryId stay null) rather than an error:
      // the raw `nodeLoc` string is still recorded, and denied and missing stay
      // indistinguishable, so this can't be used to probe what exists.
      requireRole(ctx, 'READER');
      const node = event.nodeLoc
        ? await resolveReadableNodeByLoc(ctx, event.nodeLoc)
        : null;

      // #1660 review (local P2-2): the insert IS this act, so an App-key resume
      // it earns commits in the SAME transaction (rolled back if the insert
      // fails), and the row is stamped at the instant activity was judged
      // (local P2-1).
      await ctx.db.$transaction(async (tx) => {
        // The App-key resume must run BEFORE any Session share lock: it takes
        // App SHARE → Worker UPDATE → Session UPDATE, like bind. Taking
        // Session SHARE first inverts that order and concurrent resumes also
        // deadlock while upgrading their share locks (#1741, Bob P2).
        if (event.sessionId && !ctx.userId && ctx.appId && !ctx.impersonation) {
          await attributedRequestActivity(ctx.db, ctx, event.sessionId, { tx });
        }
        // #1662: denied, missing and deleted refs all record without a session.
        // Hold the row through the insert so deletion/account reassignment
        // cannot invalidate ownership between the check and attribution.
        let sessionId: string | null = null;
        if (event.sessionId) {
          await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${event.sessionId} FOR SHARE`;
          const session = await tx.session.findUnique({
            where: { id: event.sessionId },
            select: { userId: true, appId: true, deletedAt: true, launchOperationId: true },
          });
          if (session && !session.deletedAt && ownsSession(ctx, session)) sessionId = event.sessionId;
        }
        // Re-judge activity under the ownership row hold without attempting
        // another resume (which could acquire a Worker after the Session).
        const at = new Date();
        const countsAsActivity = await usageEventCountsAsActivity(tx as never, ctx, sessionId, at);
        return tx.usageEvent.create({
          data: {
            type: event.type,
            nodeLoc: event.nodeLoc,
            nodeId: node?.id,
            // #796: derived from the same row `nodeId` comes from — now a row the
            // caller demonstrably can read, so the memory attribution is theirs
            // to make. Keeping it derived leaves UsageEventInput unchanged.
            memoryId: node?.memoryId,
            actionArgs: serializeJson(event.actionArgs) as InputJsonValue | undefined,
            appId: ctx.appId,
            // Attribution from auth (spec 046 FR-001), as the MCP recorders do.
            // This path only ever set the audit `createdBy` string, so a signed-in
            // user's reads/writes recorded here were invisible to any query
            // filtering on `userId` — including #796's own-activity scope.
            userId: ctx.userId ?? null,
            createdBy: ctx.userId ?? ctx.clientId ?? null,
            sessionId,
            // #1653 / DY-2: the session id here is CLIENT-SUPPLIED, so it counts
            // as activity only for a live session this caller owns. Before this,
            // any reader could keep someone else's session live, or revive it,
            // by recording usage against its id.
            countsAsActivity,
            createdAt: at,
            model: event.model,
            tokensIn: event.tokensIn,
            tokensOut: event.tokensOut,
          },
        });
      });
      return true;
    },

    startAgentSession: async (
      _: unknown,
      { agentId, externalUserId, sessionTimeoutSeconds }: {
        agentId: string;
        externalUserId?: string;
        sessionTimeoutSeconds?: number;
      },
      ctx: Context,
    ) => {
      const appId = ctx.appId;
      if (!appId) throw new Error('Forbidden: App Key required');
      const hasSuppliedKey = hasRequestOperationKey();
      // Lock the App before provisioning any dependent row. The lock and all
      // writes commit together, so uninstall cannot pass the check mid-flight.
      const { session, memoryId, parsedKey } = await ctx.db.$transaction(async (tx) => {
        await lockSessionAppActive(tx, appId);
        const app = await tx.app.findUniqueOrThrow({ where: { id: appId } });

        // 008: App→Agent is a direct FK; the App can operate exactly the Agent
        // referenced by App.agent_id (no AppAgent join). Orphan Apps (agent_id
        // IS NULL) cannot operate any agent.
        // 023-app-shape Phase 2b: App↔Agent goes through AppAgent. Check
        // that the requested Agent is installed in the calling App.
        if (!(await isAgentInstalled(tx, app.id, agentId))) {
          throw new Error('Forbidden: App is not allowed to operate this agent');
        }

        const agent = await tx.agent.findUniqueOrThrow({ where: { id: agentId } });
        if (agent.deletedAt) throw new Error('Agent not found');
        // Per-user/anonymous session memories are provisioned under the
        // Agent's owning org (their URN is derived from the org's URN) — not
        // yet modeled for a user-owned Agent.
        if (!agent.organizationId) {
          throw new GraphQLError('startAgentSession is not supported for a user-owned Agent yet.', { extensions: { code: 'BAD_USER_INPUT' } });
        }

        // SECRET mode requires a supplied key; USER_ID mode rejects it.
        if (app.identifyUserMethod === 'SECRET' && !hasSuppliedKey) {
          throw new GraphQLError('A supplied operation key is required in SECRET mode.', { extensions: { code: 'BAD_UNLOCK_INPUT' } });
        }
        if (app.identifyUserMethod === 'USER_ID' && hasSuppliedKey) {
          throw new GraphQLError('An operation key is only accepted in SECRET mode.', { extensions: { code: 'BAD_UNLOCK_INPUT' } });
        }

        // #1796: consume request-only supply before any provisioning writes.
        const parsedKey = getRequestOperationKey();

        // Resolve user (optional — null means anonymous session)
        let userId: string | null = null;
        if (externalUserId) {
          let user = await tx.user.findFirst({
            where: { externalAppId: appId, externalId: externalUserId, deletedAt: null },
          });
          if (!user) {
            if (app.createUserPermission !== 'IMPLICIT') {
              throw new Error('User not found. Call createAppUser first or set createUserPermission=IMPLICIT.');
            }
            // Handle is NOT NULL (spec 047). An implicitly-provisioned app
            // end-user gets a RANDOM handle — it's addressed by (externalAppId,
            // externalId), not by handle, and its externalId must not leak into a
            // global handle.
            const appUserHandle = await generateUniqueHandle(tx);
            user = await tx.user.create({
              data: {
                externalAppId: appId,
                externalId: externalUserId,
                identityProvider: 'APP',
                handle: appUserHandle,
                createdBy: appId,
              },
            });
            await ensureUserPrincipal(tx, user); // #692: pool principal
          }
          userId = user.id;
        }

        // 005-agent-subscription FR-002: auto-provision an AgentSubscription
        // on the first user-attributed contact for (user, agent). Ignore a
        // duplicate without aborting this PostgreSQL transaction.
        if (userId) {
          await tx.agentSubscription.createMany({
            data: { userId, agentId, activatedAt: new Date() },
            skipDuplicates: true,
          });
        }

        // Find or lazily provision the user memory for (agent, user)
        let memoryId: string;
        let memoryIsEncrypted = false;
        if (userId) {
          const existing = await tx.memory.findFirst({
            where: { userMemoryOfAgentId: agentId, createdBy: userId, deletedAt: null },
          });
          if (existing) {
            memoryId = existing.id;
            memoryIsEncrypted = existing.isEncrypted;
          } else {
            const org = await tx.organization.findUniqueOrThrow({
              where: { id: agent.organizationId }, select: { urn: true },
            });
            const opaqueId = generateId();
            // #697 Stage 3: mint a FLAT single-atom v2 urn (`<org>:<opaqueId>`) —
            // the `app-user` scope now lives in the row columns (class/userId/
            // userMemoryOfAgentId/appId), not the URN path, so node URNs in this
            // memory round-trip through splitNodeUrn. The opaque id can't collide,
            // so this stores `<org>:<opaqueId>` unaliased.
            const memoryUrn = await mintMemoryUrnV2(tx, {
              root: org.urn,
              desiredSlug: opaqueId,
              authorRoot: agentSlugFromUrn(agent.urn),
            });
            const created = await tx.memory.create({
              data: {
                organizationId: agent.organizationId,
                urn: memoryUrn,
                name: `User memory (${agent.name})`,
                // 005-agent-subscription: per-user memory keyed on userId.
                // Bidirectional CHECK constraint requires class IN
                // (personal,private) ⇔ userId IS NOT NULL.
                userId,
                // 041 (#516): 'private' is the ONLY encryptable class. In SECRET
                // mode we birth the memory encrypted, so it must be born 'private'
                // (owner-only, caller-held key — that IS the private threat model).
                // Plaintext USER_ID memories stay 'personal'. Both satisfy the
                // bidirectional CHECK class IN (personal,private) ⇔ userId IS NOT NULL.
                class: parsedKey !== null ? 'private' : 'personal',
                // 035-visibility-enum-cleanup: personal/private privacy is
                // class-driven; visibility is NULL (was PERSONAL).
                visibility: null,
                userMemoryOfAgentId: agentId,
                // 008-agent-installation: personal memories pivot on
                // (app_id, user_id). The chk_memory_class_app_id constraint
                // requires app_id when class IN ('app', 'personal').
                appId,
                // New user memories in SECRET mode are encrypted from creation.
                isEncrypted: parsedKey !== null,
                keyVerifier: parsedKey ? makeKeyVerifier(parsedKey) : null,
                createdBy: userId,
              },
            });
            memoryId = created.id;
            memoryIsEncrypted = parsedKey !== null;
          }
        } else {
          // Anonymous session — create a scratch memory with expiry. Anonymous
          // memories are always plaintext until linkMemoryToUser promotes them.
          const org = await tx.organization.findUniqueOrThrow({
            where: { id: agent.organizationId }, select: { urn: true },
          });
          const opaqueId = generateId();
          const agentSlug = agentSlugFromUrn(agent.urn);
          // #697 Stage 3: flat single-atom v2 urn (`<org>:<opaqueId>`) — the anon
          // scope lives in the row columns, not the URN path (see the app-user
          // branch above). Fresh opaque id ⇒ no collision, stored unaliased.
          const memoryUrn = await mintMemoryUrnV2(tx, {
            root: org.urn,
            desiredSlug: opaqueId,
            authorRoot: agentSlug,
          });
          const expires = new Date(Date.now() + app.anonymousTtlDays * 24 * 60 * 60 * 1000);
          const created = await tx.memory.create({
            data: {
              organizationId: agent.organizationId,
              urn: memoryUrn,
              name: `Anonymous session (${agent.name})`,
              // Anonymous: no userId yet (linkMemoryToUser later may set
              // it); class is 'app' since the data belongs to the App's
              // bucket of records-through-this-agent until promoted.
              class: 'app',
              // 035-visibility-enum-cleanup: app-class visibility is NULL.
              visibility: null,
              userMemoryOfAgentId: agentId,
              // 008-agent-installation: app-class memories require app_id
              // (chk_memory_class_app_id).
              appId,
              anonymousExpiresAt: expires,
              createdBy: appId,
            },
          });
          memoryId = created.id;
          memoryIsEncrypted = false;
        }

        // If the memory is encrypted, the caller must provide a matching key.
        // (In SECRET mode we already required a supplied key above; this check also
        // handles a later call with USER_ID mode on an already-encrypted mem.)
        if (memoryIsEncrypted && !parsedKey) {
          throw new GraphQLError('A supplied operation key is required for the encrypted memory.', { extensions: { code: 'BAD_UNLOCK_INPUT' } });
        }
        if (memoryIsEncrypted && parsedKey) {
          const keyProof = await tx.memory.findUniqueOrThrow({
            where: { id: memoryId }, select: { keyVerifier: true },
          });
          if (!keyProof.keyVerifier) {
            throw new GraphQLError('Encrypted memory has no stored key verifier for safe session unlock.', {
              extensions: { code: 'BAD_UNLOCK_INPUT', memoryId },
            });
          }
          if (!verifyDataKey(keyProof.keyVerifier, parsedKey)) {
            throw new GraphQLError('Wrong key for encrypted memory.', { extensions: { code: 'WRONG_KEY' } });
          }
        }

        // Clamp session timeout to the app's configured maximum (ceiling).
        // Ruling DY-3: an App with `agentSessionsExpire: false` stamps NO hard
        // expiry unless the call asks for one; a requested timeout is still
        // capped by the App ceiling. Inactivity never ends a session (#1114);
        // a forgotten one is bounded by DY-5 instead: past the App's
        // `sessionDormancyDays` it no longer binds (`bindSession`).
        const expiresAt = !app.agentSessionsExpire && sessionTimeoutSeconds == null
          ? null
          : new Date(Date.now() + Math.min(
              sessionTimeoutSeconds ?? app.sessionTimeoutSeconds,
              app.sessionTimeoutSeconds,
            ) * 1000);

        const session = await tx.session.create({
          data: {
            id: generateId(),
            type: 'CHATBOT',
            appId,
            userId: userId ?? null,
            agentId,
            memoryId,
            expiresAt,
            createdBy: appId,
          },
        });

        return { session, memoryId, parsedKey };
      });

      // The cache must only observe a committed session.
      if (parsedKey) sessionKeyCache.set(session.id, memoryId, parsedKey);
      return session;
    },

    endAgentSession: async (_: unknown, { sessionId }: { sessionId: string }, ctx: Context) => {
      if (!ctx.appId) throw new Error('Forbidden: App Key required');
      const session = await ctx.db.session.findUnique({ where: { id: sessionId } });
      if (!session || session.appId !== ctx.appId) {
        throw new Error('Session not found');
      }
      if (session.endedAt) {
        sessionKeyCache.evict(sessionId); // defensive — idempotent
        return true;
      }
      // #1156 / cor:dmo:070:05: share first-end-wins with explicit closes;
      // an expiry or another end may have won since the read above.
      await endSessionFirstWins(ctx.db, sessionId, {});
      // Evict the data key from the in-memory cache. Ref counting means the
      // key stays available to any other active session on the same memory.
      sessionKeyCache.evict(sessionId);
      return true;
    },

    createRevision: async (
      _: unknown,
      { agentId, description }: { agentId: string; description?: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      // #1944: through the read gate, so an unreadable Agent answers as absent.
      const agent = await resolveReadableAgentRef(ctx, agentId);
      const resolvedAgentId = agent.id;
      await requireAgentAccess(ctx, agent, 'ADMIN');
      const sysMemId = (agent as any).systemMemoryId as string;
      if (!sysMemId) throw new Error('Agent has no system memory');

      // Snapshot all non-revision nodes + edges in the system memory
      const nodes = await ctx.db.node.findMany({
        where: { memoryId: sysMemId, deletedAt: null, NOT: { loc: { startsWith: 'revisions' } } },
        select: { loc: true, name: true, nodeType: true, description: true, content: true, data: true, tags: true },
      });
      const nodeIds = (await ctx.db.node.findMany({
        where: { memoryId: sysMemId, deletedAt: null, NOT: { loc: { startsWith: 'revisions' } } },
        select: { id: true },
      })).map((n) => n.id);
      const edges = await ctx.db.edge.findMany({
        // Derived INCLUDE edges (#2040) are not snapshotted: restore re-derives them from content.
        where: { sourceId: { in: nodeIds }, deletedAt: null, governedKind: null },
        include: { source: { select: { loc: true } }, target: { select: { loc: true } } },
      });
      const edgeSnapshots = edges.map((e) => ({
        sourceLoc: e.source.loc,
        targetLoc: e.target.loc,
        loc: e.loc,
        name: e.name,
        description: e.description,
        isRunnable: e.isRunnable,
        data: e.data,
      }));

      // Count existing revisions to auto-increment
      const existingRevisions = await ctx.db.node.count({
        where: { memoryId: sysMemId, loc: { startsWith: 'revisions:' }, deletedAt: null },
      });
      const revNum = existingRevisions + 1;
      const label = `rev-${revNum}`;
      const revLoc = `revisions:${label}`;

      // Ensure revisions parent exists
      try {
        await ctx.db.node.upsert({
          where: { loc_memoryId: { loc: 'revisions', memoryId: sysMemId } },
          create: { id: generateId(), memoryId: sysMemId, loc: 'revisions', name: 'revisions', nodeType: 'system' },
          update: {},
        });
      } catch { /* exists */ }

      // #664/#752: revLoc is `revisions:<label>`, so a concurrent non-recursive
      // delete of the `revisions` parent could count zero descendants and then
      // orphan this row. Hold the ancestor-path lock across the insert (advisory
      // before row; READ COMMITTED so the delete's count sees this post-commit).
      await ctx.db.$transaction(async (tx) => {
        await lockAncestorsForCreate(tx, sysMemId, revLoc);
        await tx.node.create({
          data: {
            id: generateId(), memoryId: sysMemId, loc: revLoc, name: label,
            nodeType: 'system',
            description: description ?? `Revision ${revNum}`,
            data: {
              revision: revNum,
              label,
              published: false,
              createdBy: ctx.userId ?? null,
              snapshot: { nodes: nodes.map((n) => ({ ...n, tags: n.tags ?? [] })), edges: edgeSnapshots },
            } as InputJsonValue,
          },
        });
      });

      return { revisionLoc: revLoc, label, published: false, createdAt: new Date().toISOString() };
    },

    publishRevision: async (
      _: unknown,
      { agentId, revisionLoc, versionLabel }: { agentId: string; revisionLoc: string; versionLabel?: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      // #1944: through the read gate, so an unreadable Agent answers as absent.
      const agent = await resolveReadableAgentRef(ctx, agentId);
      const resolvedAgentId = agent.id;
      await requireAgentAccess(ctx, agent, 'ADMIN');
      const sysMemId = (agent as any).systemMemoryId as string;
      if (!sysMemId) throw new Error('Agent has no system memory');

      const revNode = await ctx.db.node.findFirst({
        where: { memoryId: sysMemId, loc: revisionLoc, deletedAt: null },
      });
      if (!revNode) throw new Error(`Revision "${revisionLoc}" not found`);

      const revData = (revNode.data as Record<string, unknown>) ?? {};
      const label = versionLabel ?? (revData.label as string) ?? revisionLoc;

      // Mark as published
      await ctx.db.node.update({
        where: { id: revNode.id },
        data: { data: { ...revData, published: true, publishedAt: new Date().toISOString(), versionLabel: label } as InputJsonValue },
      });

      // Update agent to point to this revision
      await ctx.db.agent.update({
        where: { id: resolvedAgentId },
        data: { publishedRevisionLoc: revisionLoc },
      });

      return { revisionLoc, label, published: true, createdAt: new Date().toISOString() };
    },

    restoreRevision: async (
      _: unknown,
      { agentId, revisionLoc }: { agentId: string; revisionLoc: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      // #1944: through the read gate, so an unreadable Agent answers as absent.
      const agent = await resolveReadableAgentRef(ctx, agentId);
      const resolvedAgentId = agent.id;
      await requireAgentAccess(ctx, agent, 'ADMIN');
      const sysMemId = (agent as any).systemMemoryId as string;
      if (!sysMemId) throw new Error('Agent has no system memory');

      const revNode = await ctx.db.node.findFirst({
        where: { memoryId: sysMemId, loc: revisionLoc, deletedAt: null },
      });
      if (!revNode) throw new Error(`Revision "${revisionLoc}" not found`);

      const revData = (revNode.data as Record<string, unknown>) ?? {};
      const snapshot = revData.snapshot as { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } | undefined;
      if (!snapshot) throw new Error('Revision has no snapshot data');

      // Auto-save current state before restoring
      await sessionMutations.createRevision({}, { agentId: resolvedAgentId, description: `Auto-save before restoring ${revisionLoc}` }, ctx);

      // Restore is ATOMIC (#752 review, Codex P1): the destructive soft-deletes
      // AND the snapshot restore run in ONE transaction, so any failure — the
      // interactive-transaction timeout included — rolls the whole thing back
      // rather than leaving the system memory emptied by the preamble. Advisory
      // locks come first (#664 — a concurrent non-recursive ancestor-delete
      // can't miss the restored rows, and advisory-before-row ordering avoids a
      // lock-order inversion with the delete path). The generous timeout covers
      // a large snapshot; READ COMMITTED (the default) gives each statement a
      // fresh snapshot after the lock is granted.
      const locToId = new Map<string, string>();
      await ctx.db.$transaction(
        async (tx) => {
          await lockAncestorsForCreateMany(
            tx,
            sysMemId,
            snapshot.nodes.map((n) => n.loc as string).filter((l) => typeof l === 'string' && l !== ''),
          );

          // Delete all current non-revision nodes in the system memory.
          //
          // #1468 (Codex on #1475) — a system memory can hold a minted corpus
          // (createAgent may promote one into it). A live minted spec the
          // snapshot does not restore is a removal; one it restores must not
          // come back without its marker. Both are checked under the guard's
          // row locks, and only the locked rows are tombstoned.
          const live = await tx.node.findMany({
            where: { memoryId: sysMemId, deletedAt: null, NOT: { loc: { startsWith: 'revisions' } } },
            select: { id: true, loc: true },
          });
          const snapshotTags = new Map(snapshot.nodes.map((n) => [n.loc as string, (n.tags as string[]) ?? []]));
          await assertNoMintedSpecRemoval(
            tx, sysMemId, live.filter((n) => !snapshotTags.has(n.loc)).map((n) => n.id), 'restore a snapshot that drops',
          );
          await assertNoMintedSpecUnmark(
            tx, sysMemId,
            live.filter((n) => snapshotTags.has(n.loc)).map((n) => ({ id: n.id, tags: snapshotTags.get(n.loc)! })),
            'restore a snapshot of',
          );
          await tx.node.updateMany({
            where: { id: { in: live.map((n) => n.id) }, deletedAt: null },
            data: { deletedAt: new Date() },
          });

          // Delete all edges in the system memory
          const currentNodeIds = (await tx.node.findMany({
            where: { memoryId: sysMemId },
            select: { id: true },
          })).map((n) => n.id);
          await tx.edge.updateMany({
            where: { sourceId: { in: currentNodeIds }, deletedAt: null, governedKind: null },
            data: { deletedAt: new Date() },
          });

          // Restore nodes from snapshot (upsert to handle soft-deleted rows
          // that still hold the unique (loc, memoryId) constraint).
          //
          // #1323 (@copilot, PR #1339): restoring OVER an existing row is an
          // authoring write, so each takes the revision protocol — row lock,
          // drift reconciled as its own revision, the real predecessor
          // snapshotted, the fingerprint refreshed. Rows are taken in loc
          // order so two concurrent restores lock in the same sequence.
          const restoreOrder = [...snapshot.nodes].sort((a, b) =>
            (a.loc as string) < (b.loc as string) ? -1 : (a.loc as string) > (b.loc as string) ? 1 : 0,
          );
          for (const n of restoreOrder) {
            const loc = n.loc as string;
            let clearRestoredAuthorship = false;
            const nodeData = {
              name: n.name as string,
              nodeType: (n.nodeType as string) ?? 'system',
              description: (n.description as string) ?? null,
              content: (n.content as string) ?? null,
              data: (n.data ?? null) as InputJsonValue,
              tags: (n.tags as string[]) ?? [],
              deletedAt: null,
            };
            const prior = await tx.node.findUnique({
              where: { loc_memoryId: { loc, memoryId: sysMemId } },
              select: { id: true },
            });
            if (prior) {
              await ensureCurrentNodeRevisionInTransaction(tx, prior.id, { expectedMemoryId: sysMemId });
              const current = await tx.node.findUniqueOrThrow({ where: { id: prior.id } });
              // Found by (loc, memory), locked by id: a row that moved in
              // between aborts the restore (it is atomic) rather than being
              // snapshotted while the upsert creates a duplicate at the old
              // address (@copilot, PR #1339). Its deletedAt was just set by the
              // soft-delete above, so liveness is not part of this check.
              if (current.loc !== loc || current.memoryId !== sysMemId) {
                throw new Error(`restoreRevision: "${loc}" moved during the restore; retry.`);
              }
              const changes = diffNodeChanges(current, nodeData);
              // Agent snapshots predate #1326 and contain no attribution.
              // Restoring their authored fields cannot inherit the current
              // live row's task claim; the snapshot below keeps that claim in
              // history, and the restored live state becomes unknown.
              clearRestoredAuthorship = authoredContentChanged(changes);
              if (changes.length > 0) {
                await createNodeRevision(
                  tx,
                  buildNodeRevisionSnapshot(current, editorFromAuth(ctx), {
                    revLabel: 'Restored from a published agent snapshot',
                    changes,
                  }),
                );
              }
            }
            const upserted = await tx.node.upsert({
              where: { loc_memoryId: { loc, memoryId: sysMemId } },
              create: { id: generateId(), memoryId: sysMemId, loc, ...nodeData },
              update: {
                ...nodeData,
                ...(clearRestoredAuthorship ? clearNodeAuthorship() : {}),
                revisionContentHash: revisionStateHashRefreshMarker(),
              },
            });
            locToId.set(loc, upserted.id);
            // #2040 — re-derive the include edges from the restored content. No
            // refusal here: the snapshot was valid when taken, and the walk would
            // see a half-restored graph.
            await syncDerivedIncludesEdges(tx, upserted, storedIncludeTags(nodeData.content), [sysMemId]);
          }

          // Restore edges from snapshot. Spec 037: derive loc when an older
          // snapshot predates the edge `loc`/`name` fields (it would carry the
          // legacy `label`); memoryId is the system memory being restored into.
          for (const e of snapshot.edges) {
            const sourceId = locToId.get(e.sourceLoc as string);
            const targetId = locToId.get(e.targetLoc as string);
            if (sourceId && targetId) {
              const edgeName = ((e.name ?? e.label) as string | null) ?? null;
              const edgeLoc = (e.loc as string | undefined)
                ?? deriveEdgeLoc(e.sourceLoc as string, edgeName, e.targetLoc as string);
              const edgeFields = {
                sourceId,
                targetId,
                name: edgeName,
                description: (e.description as string | null) ?? null,
                isRunnable: (e.isRunnable as boolean | null) ?? null,
                data: (e.data ?? null) as InputJsonValue,
              };
              // Upsert, not create: the edge soft-delete above leaves the
              // (loc, memoryId) slot occupied (Edge @@unique([loc, memoryId]) is
              // unfiltered), so a plain create would hit the unique index for any
              // graph that already had an edge at this loc (Copilot review). The
              // update branch RESURRECTS that soft-deleted row — mirrors the node
              // upsert above.
              await tx.edge.upsert({
                where: { loc_memoryId: { loc: edgeLoc, memoryId: sysMemId } },
                create: { id: generateId(), memoryId: sysMemId, loc: edgeLoc, ...edgeFields },
                update: { ...edgeFields, deletedAt: null },
              });
            }
          }
        },
        { timeout: 30_000, maxWait: 10_000 },
      );

      return { revisionLoc, label: (revData.label as string) ?? revisionLoc, published: false, createdAt: new Date().toISOString() };
    },

    // ── Editor lock ────────────────────────────────────────────────────

    acquireEditorLock: async (
      _: unknown,
      { agentId }: { agentId: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      // #1944: through the read gate, so an unreadable Agent answers as absent.
      const agent = await resolveReadableAgentRef(ctx, agentId);
      const resolvedAgentId = agent.id;
      await requireAgentAccess(ctx, agent, 'ADMIN');

      const now = new Date();
      const lockExpiry = (agent as any).editorLockExpiresAt as Date | null;
      const lockUser = (agent as any).editorLockUserId as string | null;

      // If locked by someone else and not expired, reject
      if (lockUser && lockUser !== ctx.userId && lockExpiry && lockExpiry > now) {
        return { locked: false, lockedBy: lockUser, expiresAt: lockExpiry.toISOString() };
      }

      // Acquire or renew lock (5 minutes)
      const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
      await ctx.db.agent.update({
        where: { id: resolvedAgentId },
        data: { editorLockUserId: ctx.userId, editorLockExpiresAt: expiresAt },
      });

      return { locked: true, lockedBy: ctx.userId, expiresAt: expiresAt.toISOString() };
    },

    releaseEditorLock: async (
      _: unknown,
      { agentId }: { agentId: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      // #1944: through the read gate, so an unreadable Agent answers as absent.
      const agent = await resolveReadableAgentRef(ctx, agentId);
      const resolvedAgentId = agent.id;
      await requireAgentAccess(ctx, agent, 'ADMIN');

      await ctx.db.agent.update({
        where: { id: resolvedAgentId },
        data: { editorLockUserId: null, editorLockExpiresAt: null },
      });
      return true;
    },

    // ── Chat ownership mutations ────────────────────────────────────

    deleteExchangeConnection: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const connection = await ctx.db.exchangeConnection.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, connection.organizationId, 'ADMIN');
      await withAuthorizedTx(
        ctx,
        [{ kind: 'connection', id }, { kind: 'org', id: connection.organizationId }],
        (txCtx) => requireOrgRole(txCtx, connection.organizationId, 'ADMIN'),
        (tx) => tx.exchangeConnection.update({
          where: { id },
          data: { deletedAt: new Date(), deletedBy: ctx.userId ?? ctx.clientId ?? null },
        }),
        {
          lockMode: 'exclusive',
          afterLock: async (tx) => {
            await tx.$queryRaw`SELECT id FROM exchange_connections WHERE id = ${id} FOR UPDATE`;
          },
        },
      );
      // Tear down the provider tool's side (token + Graph subscriptions) —
      // best-effort fire-and-forget (deleteToolConnection never throws); the
      // soft-delete above already committed and must not wait on the tool.
      if (connection.toolConnectionId) {
        void deleteToolConnection(connection.provider, connection.toolConnectionId);
      }
      return true;
    },

    /**
     * Probe the owner's connection and record the outcome (hadron-internal#18).
     * The gate runs first and alone: a denied, missing or deleted connection is
     * the same typed FORBIDDEN, with no provider call and no write. The probe's
     * own error, typed by the email client, reaches the caller unchanged. Each
     * status write re-runs the gate under the connection fence that delete and
     * grant revocation take, so authority lost during the probe writes nothing.
     */
    testExchangeConnection: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const operation = 'list-messages';
      let connection: Awaited<ReturnType<typeof requireEmailConnection>>;
      try {
        connection = await requireEmailConnection(ctx, id, operation);
      } catch (err) {
        if (err instanceof ConnectionNotFoundError) throw authorizationDenied();
        throw err;
      }
      const recordStatus = async (data: { syncStatus: 'OK' | 'ERROR'; lastError: string | null; lastSyncAt?: Date }) => {
        try {
          await withAuthorizedTx(
            ctx,
            [{ kind: 'connection', id: connection.id }],
            async (txCtx) => { await requireEmailConnection(txCtx, connection.id, operation); },
            (tx) => tx.exchangeConnection.updateMany({ where: { id: connection.id, deletedAt: null }, data }),
            { afterLock: async (tx) => {
              await tx.$queryRaw`SELECT id FROM exchange_connections WHERE id = ${connection.id} FOR UPDATE`;
            } },
          );
        } catch (err) {
          // Authority lost during the probe: record nothing. Anything else is a fault.
          if (err instanceof ConnectionNotFoundError) return;
          if (err instanceof GraphQLError && err.extensions?.code === 'FORBIDDEN') return;
          throw err;
        }
      };
      try {
        await runEmailOperation(connection.provider, operation, { top: 1, connectionId: connection.toolConnectionId });
      } catch (err: unknown) {
        await recordStatus({ syncStatus: 'ERROR', lastError: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      await recordStatus({ syncStatus: 'OK', lastError: null, lastSyncAt: new Date() });
      return true;
    },

    exchangeReply: async (
      _: unknown,
      { connectionId, messageId, body }: { connectionId: string; messageId: string; body: string },
      ctx: Context,
    ) => {
      await runOwnedEmailOperation(ctx, connectionId, 'reply-to-message', {
        messageId,
        bodyHtml: body,
      });
      return true;
    },

    exchangeMoveMessage: async (
      _: unknown,
      { connectionId, messageId, folderId }: { connectionId: string; messageId: string; folderId: string },
      ctx: Context,
    ) => {
      await runOwnedEmailOperation(ctx, connectionId, 'move-message', {
        messageId,
        destinationFolderId: folderId,
      });
      return true;
    },

    // ── spec 002 email operations (provider-neutral names) ─────────────
    // The drafts/flag/read-status capabilities the ms-exchange tool added.
    // All owner-only via requireEmailConnection; `idempotencyKey` rides
    // through to the tool's reservation-based replay (at-least-once callers).
    // The legacy exchange* names above stay as portal-compatible shims until
    // the portal migrates to this surface (#396 follow-up).

    emailSaveDraft: async (
      _: unknown,
      {
        connectionRef,
        replyToMessageId,
        to,
        subject,
        bodyHtml,
        idempotencyKey,
      }: {
        connectionRef: string;
        replyToMessageId?: string | null;
        to?: string[] | null;
        subject?: string | null;
        bodyHtml: string;
        idempotencyKey?: string | null;
      },
      ctx: Context,
    ) => {
      return runOwnedEmailOperation<{ draftId: string; conversationId: string | null }>(
        ctx,
        connectionRef,
        'save-draft',
        {
          // JSON.stringify drops undefined values, so plain fields suffice.
          replyToMessageId: replyToMessageId ?? undefined,
          to: to?.length ? to : undefined,
          subject: subject ?? undefined,
          bodyHtml,
          idempotencyKey: idempotencyKey ?? undefined,
        },
      );
    },

    emailUpdateDraft: async (
      _: unknown,
      { connectionRef, draftId, bodyHtml }: { connectionRef: string; draftId: string; bodyHtml: string },
      ctx: Context,
    ) => {
      await runOwnedEmailOperation(ctx, connectionRef, 'update-draft', { draftId, bodyHtml });
      return true;
    },

    emailSendDraft: async (
      _: unknown,
      {
        connectionRef,
        draftId,
        idempotencyKey,
      }: { connectionRef: string; draftId: string; idempotencyKey?: string | null },
      ctx: Context,
    ) => {
      await runOwnedEmailOperation(ctx, connectionRef, 'send-draft', {
        draftId,
        idempotencyKey: idempotencyKey ?? undefined,
      });
      return true;
    },

    emailDeleteMessage: async (
      _: unknown,
      { connectionRef, messageId }: { connectionRef: string; messageId: string },
      ctx: Context,
    ) => {
      await runOwnedEmailOperation(ctx, connectionRef, 'delete-message', { messageId });
      return true;
    },

    emailMarkRead: async (
      _: unknown,
      { connectionRef, messageId, isRead }: { connectionRef: string; messageId: string; isRead?: boolean | null },
      ctx: Context,
    ) => {
      await runOwnedEmailOperation(ctx, connectionRef, 'mark-read', {
        messageId,
        isRead: isRead ?? true,
      });
      return true;
    },

    emailFlagMessage: async (
      _: unknown,
      {
        connectionRef,
        messageId,
        flag,
      }: { connectionRef: string; messageId: string; flag?: 'FLAGGED' | 'NONE' | 'COMPLETE' | null },
      ctx: Context,
    ) => {
      await runOwnedEmailOperation(ctx, connectionRef, 'flag-message', {
        messageId,
        flag: (flag ?? 'FLAGGED').toLowerCase(),
      });
      return true;
    },

    emailCategorizeMessage: async (
      _: unknown,
      {
        connectionRef,
        messageId,
        categories,
      }: { connectionRef: string; messageId: string; categories: string[] },
      ctx: Context,
    ) => {
      await runOwnedEmailOperation(ctx, connectionRef, 'categorize-message', {
        messageId,
        categories,
      });
      return true;
    },

    // ── Calendar mutations (hadrontool-google-cal) ─────────────────────
    // All owner-only in v1: no OPERATION_SCOPES entry maps to these, so an
    // App/headless caller is denied fail-closed even with a grant. The tool
    // validates the either/or event-boundary shape and the response
    // vocabulary; its typed validation_error passes through verbatim.

    calendarCreateEvent: async (
      _: unknown,
      {
        connectionRef,
        calendarId,
        title,
        description,
        location,
        start,
        end,
        attendees,
        notifyAttendees,
        idempotencyKey,
      }: {
        connectionRef: string;
        calendarId?: string | null;
        title: string;
        description?: string | null;
        location?: string | null;
        start: { dateTime?: string | null; date?: string | null; timeZone?: string | null };
        end: { dateTime?: string | null; date?: string | null; timeZone?: string | null };
        attendees?: string[] | null;
        notifyAttendees?: boolean | null;
        idempotencyKey?: string | null;
      },
      ctx: Context,
    ) => {
      const { event } = await runOwnedEmailOperation<{ event: ToolCalendarEvent }>(
        ctx,
        connectionRef,
        'create-event',
        {
          calendarId: calendarId ?? undefined,
          title,
          description: description ?? undefined,
          location: location ?? undefined,
          start: dropNulls(start),
          end: dropNulls(end),
          attendees: attendees?.length ? attendees : undefined,
          notifyAttendees: notifyAttendees ?? undefined,
          idempotencyKey: idempotencyKey ?? undefined,
        },
      );
      return mapToolCalendarEvent(event);
    },

    calendarUpdateEvent: async (
      _: unknown,
      {
        connectionRef,
        eventId,
        calendarId,
        title,
        description,
        location,
        start,
        end,
        attendees,
        notifyAttendees,
        idempotencyKey,
      }: {
        connectionRef: string;
        eventId: string;
        calendarId?: string | null;
        title?: string | null;
        description?: string | null;
        location?: string | null;
        start?: { dateTime?: string | null; date?: string | null; timeZone?: string | null } | null;
        end?: { dateTime?: string | null; date?: string | null; timeZone?: string | null } | null;
        attendees?: string[] | null;
        notifyAttendees?: boolean | null;
        idempotencyKey?: string | null;
      },
      ctx: Context,
    ) => {
      const { event } = await runOwnedEmailOperation<{ event: ToolCalendarEvent }>(
        ctx,
        connectionRef,
        'update-event',
        {
          eventId,
          calendarId: calendarId ?? undefined,
          title: title ?? undefined,
          description: description ?? undefined,
          location: location ?? undefined,
          start: start ? dropNulls(start) : undefined,
          end: end ? dropNulls(end) : undefined,
          // An explicit empty list is a real patch value (clear the set).
          attendees: attendees ?? undefined,
          notifyAttendees: notifyAttendees ?? undefined,
          idempotencyKey: idempotencyKey ?? undefined,
        },
      );
      return mapToolCalendarEvent(event);
    },

    calendarDeleteEvent: async (
      _: unknown,
      {
        connectionRef,
        eventId,
        calendarId,
        notifyAttendees,
        idempotencyKey,
      }: {
        connectionRef: string;
        eventId: string;
        calendarId?: string | null;
        notifyAttendees?: boolean | null;
        idempotencyKey?: string | null;
      },
      ctx: Context,
    ) => {
      await runOwnedEmailOperation(ctx, connectionRef, 'delete-event', {
        eventId,
        calendarId: calendarId ?? undefined,
        notifyAttendees: notifyAttendees ?? undefined,
        idempotencyKey: idempotencyKey ?? undefined,
      });
      return true;
    },

    calendarRespondToEvent: async (
      _: unknown,
      {
        connectionRef,
        eventId,
        response,
        calendarId,
      }: {
        connectionRef: string;
        eventId: string;
        response: 'ACCEPTED' | 'DECLINED' | 'TENTATIVE' | 'NONE';
        calendarId?: string | null;
      },
      ctx: Context,
    ) => {
      // NONE exists in the enum for READS (invited, not yet answered) but is
      // not a settable response for ANY provider — reject in core with a
      // stable code rather than leaning on the tool's validation wording
      // (PR-638 Copilot review). Unlike EmailFlag's COMPLETE, this is not
      // provider-dependent, so core is the right layer.
      if (response === 'NONE') {
        throw new GraphQLError('NONE is not a settable response — use ACCEPTED, DECLINED, or TENTATIVE.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      const { event } = await runOwnedEmailOperation<{ event: ToolCalendarEvent }>(
        ctx,
        connectionRef,
        'respond-to-event',
        {
          eventId,
          calendarId: calendarId ?? undefined,
          response: response.toLowerCase(),
        },
      );
      return mapToolCalendarEvent(event);
    },

    runTask: async (
      _: unknown,
      {
        nodeRef,
        args: argsInput,
        appRef,
        runAsSelf,
      }: {
        nodeRef: string;
        args?: unknown;
        appRef?: string | null;
        runAsSelf?: boolean | null;
      },
      ctx: Context,
    ) => {
      // #542 — the task node is identified by a single `nodeRef` (ID or a
      // fully-qualified node URN), resolved by the shared `resolveNodeRef`
      // (spec 007) exactly like every other `<object>Ref` arg. The loose
      // `task`/`memory` hint-matching + candidate-listing UX lives in the MCP
      // `hadron_run_task` tool (spec cor:api:060), which resolves to a concrete
      // node before delegating here — the GraphQL surface takes a definite ref.
      const ref = typeof nodeRef === 'string' ? nodeRef.trim() : '';
      // Normalize inputs defensively.
      const args =
        argsInput && typeof argsInput === 'object' && !Array.isArray(argsInput)
          ? (argsInput as Record<string, unknown>)
          : undefined;

      // Normalize args to string values ({{key}} substitution requires strings).
      const stringArgs = args
        ? Object.fromEntries(
            Object.entries(args).map(([k, v]) => [k, String(v ?? '')]),
          )
        : undefined;

      // Helper to load a node by URN and render it.
      const auth = {
        clientId: ctx.clientId,
        userId: ctx.userId,
        appId: ctx.appId,
        sessionId: ctx.sessionId,
        roles: ctx.roles,
        organizationId: ctx.organizationId,
        impersonation: ctx.impersonation,
      };

      const loadAndRender = async (targetNodeUrn: string) => {
        try {
          assertFullyQualifiedUrn(targetNodeUrn, 'node');
        } catch (e) {
          if (e instanceof UrnNotQualifiedError) {
            throw new GraphQLError(e.message, {
              extensions: { code: e.name },
            });
          }
          throw e;
        }

        const { memoryUrn: resolvedMemoryUrn, loc } = splitWholeNodeUrn(targetNodeUrn);

        // Find the memory by URN using case-insensitive matching (legacy `:` and canonical `::` forms).
        const parsedMemUrn = parseUrnInput(resolvedMemoryUrn.trim());
        const normalizedMemUrn = normalizeUrnForLookup(parsedMemUrn.value);
        // Build the canonical form from the normalized (legacy) form. #352:
        // shared marker-aware helper so `app-user`/`anon` ids keep their
        // `marker:id` boundary instead of being severed.
        const canonicalMemUrn = legacyMemoryUrnToCanonical(normalizedMemUrn);

        const memory = await ctx.db.memory.findFirst({
          where: {
            OR: [
              { urn: normalizedMemUrn },
              { urn: canonicalMemUrn },
            ],
            deletedAt: null,
          },
          select: { id: true, urn: true },
        });

        if (!memory || !(await canReadMemory(ctx.db, auth, memory.id))) {
          throw new GraphQLError(`Memory not found: "${resolvedMemoryUrn}".`, {
            extensions: { code: 'NOT_FOUND' },
          });
        }

        const node = await ctx.db.node.findUnique({
          where: { loc_memoryId: { loc, memoryId: memory.id } },
          include: { outgoingEdges: { where: { deletedAt: null, target: { deletedAt: null } }, include: { target: true } } },
        });
        if (!node) {
          throw new GraphQLError(`Node "${targetNodeUrn}" not found.`, {
            extensions: { code: 'NOT_FOUND' },
          });
        }

        // #1719/#1730: reference edges are reads of their target memory.
        // A run fails loudly rather than executing a silently shortened flow;
        // interactive render omits unreadable targets as the preview does.
        const readableTargets = await filterReadableMemoryIds(ctx.db, auth,
          node.outgoingEdges.flatMap(e => e.target ? [e.target.memoryId] : []));
        if (isRunPrincipal(auth) && node.outgoingEdges.some(e => e.target &&
            !isRoutingName(routingNameOf(e, loc)) && !readableTargets.has(e.target.memoryId))) {
          throw new GraphQLError('Referenced dependency is not readable by the run principal; the run was refused.', { extensions: { code: 'FORBIDDEN' } });
        }
        node.outgoingEdges = node.outgoingEdges.filter(e => e.target && readableTargets.has(e.target.memoryId));

        // Decrypt the node and its outgoing edge targets if the memory is encrypted.
        // An edge whose target was deleted can surface a null `target`; filter
        // those out so decryptNodesBatch never dereferences null.
        const nodesToDecrypt = [
          node,
          ...node.outgoingEdges
            .map((e) => e.target)
            .filter((t): t is NonNullable<typeof t> => t != null),
        ];
        await decryptNodesBatch(ctx.db, nodesToDecrypt);

        // #818 review: this assembly is now `assembleRunNodePrompt` in
        // src/lib/runNodeRender.ts, shared with the GraphQL `renderRunNode`
        // preview so a dry run predicts THIS prompt rather than approximating
        // it. Behavior here is unchanged — the Mustache compile, the
        // routing-edge skip and the dangling-target skip all moved verbatim.
        // #1061 — the targets the assembler actually INLINED (routing edges and
        // empty-content targets are skipped), so the read events below describe
        // what crossed the boundary rather than what the node links to.
        const inlined: unknown[] = [];
        const assembled = await assembleRunNodePrompt(
          { ...node, loc },
          stringArgs ?? undefined,
          {
            memoryUrnOf: async (memoryId) =>
              (await ctx.db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { urn: true } })).urn,
            compileTemplate: (content, data, memoryId) =>
              compileTemplate(content, data, memoryId, ctx.db, {}),
            includeTarget: target => !!target && readableTargets.has(target.memoryId),
            onTargetInlined: (target) => inlined.push(target),
          },
        );
        // #1061 — the render-only branch of runTask (`!appRef`) returns the
        // assembled bundle to the caller, so it is a read of the run node and
        // of every dependency inlined into it — the same treatment the
        // `renderRunNode` preview gets. The `action-run` event below is a
        // separate question (how often was this run?), not a substitute
        // (PR #1062 review — Codex).
        recordNodeUsage(ctx.db, 'read', toUsageNodeRefs([node, ...inlined]), ctx);

        // Record usage event (fire-and-forget). #1653 / DY-2: it counts as
        // activity only for a live session the caller owns.
        const runAt = new Date();
        trackUsageWrite(ctx.db, attributedRequestActivity(ctx.db, ctx, ctx.sessionId, { at: runAt }).then((countsAsActivity) => ctx.db.usageEvent
          .create({
            data: {
              id: generateId(),
              createdAt: runAt,
              type: 'action-run',
              nodeLoc: loc,
              nodeId: node.id,
              memoryId: node.memoryId, // #796
              appId: ctx.appId ?? null,
              // Same attribution gap as recordUsage above: action-run isn't
              // counted by usageActivity today, but the bucket surface is meant
              // to grow to other event types, and the MCP action-run recorder
              // already sets this.
              userId: ctx.userId ?? null,
              createdBy: ctx.userId ?? null,
              sessionId: ctx.sessionId ?? null,
              countsAsActivity,
              actionArgs: stringArgs,
            },
          })
          .catch(() => {})));

        return assembled;
      };

      // #529 — when an `appRef` is supplied, EXECUTE the task instead of merely
      // rendering it: mint a MANUAL AppRun for the resolved task node under that
      // App and return the run id (poll `appRun(ref:)` for status + output). The
      // App-run kernel re-renders the same task via this resolver's assemble
      // path, so the two modes stay in lockstep. Without `appRef`, behavior is
      // unchanged — the rendered prompt is returned for an LLM agent to run.
      const dispatch = async (nodeUrn: string): Promise<string> => {
        if (!appRef) return loadAndRender(nodeUrn);
        assertFullyQualifiedUrn(nodeUrn, 'node');
        const run = await triggerManualRun(ctx, {
          appRef,
          entryNodeUrn: nodeUrn,
          // Pass the ORIGINAL structured args (not stringArgs) so eventData keeps
          // its JSON shape for audit + downstream consumers — the assemble path
          // stringifies for Mustache when it renders (#531 review, Copilot).
          eventData: args,
          runAsSelf,
        });
        return run.id;
      };

      if (!ref) {
        throw new GraphQLError('nodeRef is required.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }

      // Resolve the ref (ID or fully-qualified node URN) to a definite node.
      // No `contextMemoryId` at the API boundary (spec 022 FR-007a) — a bare
      // loc without a memory rejects as UrnNotQualifiedError.
      let resolvedNodeId: string;
      try {
        ({ id: resolvedNodeId } = await resolveNodeRefForCaller(ctx, ref));
      } catch (e) {
        if (e instanceof NodeNotFoundError || e instanceof UrnNotQualifiedError) {
          throw new GraphQLError(e.message, { extensions: { code: 'NOT_FOUND' } });
        }
        throw e;
      }

      // Compose the canonical node URN and hand off to the shared dispatch,
      // which enforces read access (canReadMemory) and renders or executes.
      const resolved = await ctx.db.node.findUnique({
        where: { id: resolvedNodeId },
        select: { loc: true, memory: { select: { urn: true } } },
      });
      if (!resolved) {
        throw new GraphQLError(`Node "${ref}" not found.`, {
          extensions: { code: 'NOT_FOUND' },
        });
      }
      return dispatch(emitNodeUrnV2(resolved.memory.urn, resolved.loc));
    },
};
