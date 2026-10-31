import { appendDeliveryPending } from '../lib/tickers/deliveryPending.js';
import { mcpRequestSessionContext } from './requestSession.js';
import { liveTxContext, liveReadSnapshotContext } from '../api/graphql/schema/authorizedTx.js';
import { withReconciledNodeRead } from '../lib/includes/reconciledNodeRead.js';
import { stampEmbeddingObligation } from '../services/embedding/obligation.js';
import { assertBootPromptWriteAllowed, assertNoBootPromptRows, isBootPromptRole } from '../lib/bootPrompt.js';
import { sessionEndReason } from '../lib/sessionEndReason.js';
import { governedKindAnnotation } from '../lib/edgeGovernedKind.js';
import { GraphQLError } from 'graphql';
import { writeResumeClaim, type ResumeCandidate } from '../lib/resumeClaims.js';
import { registerAutomationPinTools } from './automationPinTools.js';
import { registerAgentDefinitionTools } from './agentDefinitionTools.js';
import { effectiveScope, findEffectiveNodeIdByLoc, markInherited, resolveInheritedEdges, retainEffective, stillInherited, type InheritedFrom } from '../lib/effectiveSystemMemory.js';
import { chatByline } from './chatByline.js';
import { boundSessionPrivacyFilter } from '../lib/auth/sessionPrivacy.js';
import { whoamiSessionFilter } from './whoamiSessionFilter.js';
import { appPrincipalSessionWriteAllowed } from '../lib/sessionOwnership.js';
import { createHmac, randomUUID } from 'crypto';
// Spec 049 S4 — the protected-loc gate on hadron_update_node (no lock on that path).
import { COMMENT_NODE_TYPE, assertNotCommentWrite, commentGovernedError, isCommentGovernedError } from '../lib/comments/index.js';
import { commentHitInfo, commentHitLabel } from '../lib/comments/hitLabel.js';
import { commentIdsAmong, hardDeleteThreadsOfTargets, softDeleteThreadsOfTargets } from '../lib/comments/lifecycle.js';
import { decisionContainedError, decisionFamilyAmong, isDecisionFamilyRole, refuseDecisionFamily } from '../lib/decisions/index.js';
import { assertLocWritable, LocProtectedError } from '../lib/protectedLoc.js';
import {
  assertGovernedWrite,
  assertRoleDeclaredForWrite,
  RoleNotDeclaredError,
  governedKindsOf,
  roleIsOrDescendsFrom,
  type GovernedKind,
  mergedGovernedState,
  RoleGovernedError,
  GOVERNED_KINDS,
} from '../lib/governedRole.js';
import { assertEdgeSourceWritersById, assertRoleWritersForNodes, assertRoleWritersForWrite, roleWriterRefusalText } from '../lib/nodeRoleWriters.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { generateId } from '../lib/id.js';
import {
  type UsageNodeRef,
  recordNodeRead,
  recordNodeUsage,
  recordNodeWrite,
  trackUsageWrite,
  toUsageNodeRefs,
} from '../lib/usageRecorder.js';
import {
  buildNodeRevisionSnapshot,
  revisionStateHashRefreshMarker,
  ensureCurrentNodeRevisionInTransaction,
  createNodeRevision,
  editorFromAuth,
  diffNodeChanges,
} from '../lib/nodeRevisionSnapshot.js';
import { authoredContentChanged, clearNodeAuthorship } from '../lib/nodeAuthorship.js';
import {
  parseUrnInput,
  assertFullyQualifiedUrn,
  splitNodeUrn,
  validateUrnType,
  normalizeUrnForLookup,
  hasSchemePrefix,
  parseUrnV2,
  composeUrnV2,
  UrnNotQualifiedError,
} from '../lib/urn.js';
import { composeWorkerUrn } from '../lib/entityRef/workerRef.js';
import { currentActorAmbiguity, publishActor, publishAmbiguousActor, publishUser, runInChildActorScope } from '../lib/requestActor.js';
import {
  emitEntityUrnV2,
  emitNodeUrnV2,
  emitActionUrnV2,
  registerEntryCode,
  nodeUrnRoundTrips,
  safeNodeUrnV2,
  safeNodeUrnV2Result,
  safeEdgeUrnV2,
  type SafeUrnEmission,
} from '../lib/urnEmit.js';
import { portalUrlForUrn } from '../lib/portalUrl.js';
import { userUrn } from '../lib/userHandle.js';
import { registerCommentTools } from './commentTools.js';
import { registerAssetTools } from './assetTools.js';
import { signingSurfacePolicy, switchCapabilities } from '../lib/signing/surface.js';
import { registerSigningTools } from './signingTools.js';
import { registerAgentTaskTools } from './agentTaskTools.js';
import { registerTickerTools } from './tickerTools.js';
import { registerStopSignalTools } from './stopSignalTools.js';
import { openThreadCounts, type CommentCounts } from '../lib/comments/summary.js';
import { loadSignatureStatuses, type NodeSignatureStatusView } from '../lib/signing/status.js';
import { nodeContentValidationState } from '../lib/nodeContentValidation.js';
import { findLiveUrnAliasTargets, dedupeById } from '../lib/urnAlias.js';
import { validateParentRel, InvalidParentRelError } from '../lib/parentRel.js';
import type { NodeWhere } from '../lib/retrieval/nodeWhere.js';
import { NodeSchemaViolation } from '../lib/validateNodeAgainstSchema.js';
import { normalizeObjectType, normalizeRole, validateNodeSchemaOnWrite } from '../lib/enforceNodeSchema.js';
import { validateLoc, InvalidLocError } from '../lib/validateLoc.js';
import { deriveEdgeLoc } from '../lib/edgeLoc.js';
import { archiveTombstone, discoverArchivePlan, validateArchivePlan, withArchivePlanRetries, ArchivePlanExhaustedError } from '../lib/tombstoneArchive.js';
import { deletePendingEdgesTargetingNodes, promotePendingEdgeForTarget, reconcilePendingEdgeCounts } from '../lib/pendingEdgePromotion.js';
import {
  liveEdgeEndpointSet,
  lockEdgeEndpointMemories,
  lockLiveEdgeEndpoints,
} from '../lib/edgeEndpointLock.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { db } from '../integrations/db/client.js';
import { foreignEdgeMemoryIds } from '../lib/foreignEdgeMemories.js';
import { acquireLockSet, ancestorLocs, lockAncestorsForCreate, lockLocForWrite, lockNodeForDelete } from '../lib/nodeSubtreeLock.js';
import { lockMemoryForChannelChange } from '../lib/channels.js';
import { assertNoMintedSpecRemoval, assertNoMintedSpecUnmark, SPEC_MINTED_PERMANENT } from '../lib/mintedSpecPermanence.js';
import { governedAmong, governedRemovalError, lockGovernedRowsIn, lockRemovalRows } from '../lib/governedRemoval.js';
import { escapePrismaLikePattern } from '../lib/literalLocPrefix.js';
import {
  moveNodeSubtree,
  SubtreeMoveCollisionError,
  SubtreeMoveIntoSelfError,
  SubtreeMoveSourceChangedError,
  CrossMemoryMoveUnsupportedError,
  SubtreeMoveSchemaViolationError,
  type MoveNodeSubtreeResult,
} from '../lib/nodeSubtreeMove.js';
import { mirrorNodeMoveToGit } from '../integrations/github/mirrorNodeMove.js';
import { mirrorEdgeSourceAfterCommit } from '../integrations/github/mirrorEdgeSource.js';
import {
  oauthSurfaceRefusal,
  oauthSurfaceRefusalMessage,
  getCurrentUserRoles,
  resolveAuthContext,
  validateSessionBinding,
  type AuthContext,
} from '../middleware/auth.js';
import {
  resolveAppForRequest,
  resolveAppIdentifier,
  resolveUserAppsWithMeta,
  type AppResolution,
} from '../auth/user-app-resolution.js';
import { getServerOrigin } from '../auth/oauth.js';
import {
  APP_SELECTION_ERROR_CODES,
  appSelectionError,
  type AppSelectionErrorEnvelope,
} from './app-selection-errors.js';
import { mcpLog } from './mcp-log.js';
import {
  CAP_RETRY_AFTER_SECONDS,
  SWEEP_INTERVAL_MS,
  idleTtlMs,
  maxSessionsPerPrincipal,
  mcpPrincipalKey,
  releaseOnceOnResponseEnd,
} from './transportBounds.js';
import { refusalResult, toolErrorResult, withToolErrorBoundary } from './toolError.js';
import { textResult } from './textResult.js';
import { tagsInputSchema } from './tagsInput.js';
import { foreignIdentityScopedMemoryFilter } from '../lib/auth/memoryOwnership.js';

// Spec 025-oauth-for-mcp / research §R-6: error_description in the
// 409 multi-App response links to a docs page that explains the
// situation + (eventually) lists the App-identification regimes
// added by the sibling spec 02X-app-identification-regimes. The
// page doesn't exist yet (T056 in Polish phase); the URL is
// env-overrideable so docs reorganization doesn't require a code
// change.
const MULTIPLE_APPS_DOCS_URL =
  process.env.HADRON_MULTIPLE_APPS_DOCS_URL ??
  'https://hadronmemory.com/docs/auth/multiple-apps-resolved';
import {
  canReadMemory,
  canWriteToMemory,
  EXPLICIT_REF,
  explainWriteRefusal,
  filterReadableMemoryIds,
  getAccessibleMemoryIds,
  getMemoryAccess,
  isWriteBeyondRead,
} from './access-control.js';
import { globalSearch } from '../lib/global-search/index.js';
import {
  normalizeEntityTypes,
  normalizeFields,
  type SearchPrincipal,
} from '../lib/global-search/index.js';
import { getMemberOrgIds } from '../lib/auth/memberOrgIds.js';
import { lockAgentDefinitionAuthority } from '../lib/auth/managedSystemMemory.js';
import { sessionScopedMemoryIds } from '../lib/auth/sessionScopedMemoryIds.js';
import { publishNodeWritten } from '../lib/events/nodeWritten.js';
import { computeContentHash, isAbstractUnverified } from '../lib/contentHash.js';
import { validateMemoryNodes, formatFindingLine } from '../lib/memoryValidation.js';
import { assertRootAllocationAllowed, lockRootSiblings, nextSiblingSeq } from '../lib/nodeSeq.js';
import { BATCH_READ_MAX_NODES, BATCH_READ_MAX_BYTES } from '../lib/batchRead.js';
import { isCiphertext } from '../lib/crypto.js';
import { enqueueNodeEmbedding, pendingAtForRevival } from '../services/embedding/enqueue.js';
import { sessionKeyCache, SessionKeyConflictError } from '../lib/sessionKeyCache.js';
import {
  isSessionLive,
  loadLastEventBySession,
  recentlyTouchedFilter,
  sessionLapsesAt,
  OPEN_SESSION_SCAN_CAP,
} from '../lib/sessionActivity.js';
import {
  decryptNodeFieldsWithKey,
  encryptNodeFieldsWithKey,
} from '../lib/nodeCrypto.js';
import { resolveSuppliedKey, MemoryUnlockError } from '../lib/memoryUnlock.js';
import { resolveNodeRef, isConcealedNodeRefAmbiguity } from '../lib/entityRef/nodeRef.js';
import { resolveChannelRefId } from '../lib/entityRef/channelRef.js';
import { sortSiblings } from '../lib/siblingOrder.js';
import { renderRunNodeBundle } from '../lib/runNodeRender.js';
import {
  NodeNotFoundError,
  AmbiguousLegacyUrnError,
  NodeAbstractTooLongError,
  InvalidContentScopeError,
} from '../lib/entityRef/errors.js';
import { isId } from '../lib/entityRef/shape.js';
import { resolveLegacyAlias } from '../lib/entityRef/legacyAlias.js';
import { resolveAppRef } from '../lib/entityRef/appRef.js';
import { resolveAgentRef } from '../lib/entityRef/agentRef.js';
import { resolveWorkerRef } from '../lib/entityRef/workerRef.js';
import {
  AgentNotFoundError,
  AppNotFoundError,
  MemoryNotFoundError,
  OrganizationNotFoundError,
  WorkerNotFoundError,
} from '../lib/entityRef/errors.js';
import {
  renderWorkerContinuity,
  type RenderableContinuity,
} from '../lib/workerHandoff.js';
import {
  writeSessionHandoff,
  endSessionFirstWins,
} from '../api/graphql/schema/resolvers.mutation.session.js';
import { HADRON_SERVER_VERSION, MCP_SURFACE_CAPABILITIES, getDeploymentInfo } from './deploymentInfo.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { locateTeamChatChannel } from '../api/graphql/schema/resolvers.teamChat.js';
// #1005: the SHARED App-participation predicate (#943) — reused here so
// reconnect recovery admits exactly whom startSession admitted, rather than a
// narrower member-row copy that would drift from it.
import { resolveNodeContent } from '../lib/includes/resolveNodeContent.js';
import { lintWarningPageForNodeId, renderLintWarnings } from '../lib/bootPromptLint.js';

/** Most changed nodes whose lint one hadron_replace_text result checks; the rest are disclosed, never silently dropped. */
const REPLACE_LINT_MAX_NODES = 100;
import { safePlainPinWarnings, renderIncludePinWarnings, includePinWarningsFor } from '../lib/includes/plainPinWarnings.js';
import { assertIncludesWritable, includeRefusalText, syncDerivedIncludesEdges } from '../lib/includes/writeIncludes.js';
import { isAppParticipant, getAccessibleMemoryIds as gqlAccessibleMemoryIds, safeCanonicalUrn, isOwnerOrOrgMember } from '../api/graphql/schema/resolvers.helpers.js';
import { composeWorkerPrompt, describeServedWorker, loadAppWorkerActivity, loadAppWorkerCheckStatuses, maySeeWorkerInternals } from '../api/graphql/schema/resolvers.worker.js';
import { renderCheckStatusLong, renderCheckStatusShort, type WorkerCheckStatus } from '../lib/workerCheckStatus.js';
import { splitNodeUrnTolerant, nodeFragmentRefusal } from '../lib/splitNodeUrnTolerant.js';
import { safeEqual } from '../lib/constantTime.js';

/** Keep alias ambiguity concealed from callers who cannot read any claimant. */
async function resolveNodeRefForAuth(
  ref: string,
  auth: AuthContext,
  contextMemoryId?: string,
): Promise<{ id: string }> {
  try {
    return await resolveNodeRef(db, ref, contextMemoryId);
  } catch (error) {
    if (await isConcealedNodeRefAmbiguity(db, error,
      (memoryId) => canReadMemory(db, auth, memoryId))) {
      throw new NodeNotFoundError(ref);
    }
    throw error;
  }
}

/**
 * Annotate a node projection that was reached through a `#<fragment>` URN.
 *
 * #696: the fragment addresses a resource OF the node, and neither read tool
 * projects one separately — so returning the parent's projection unannotated
 * answers a question the caller did not ask (hadron-server#994's harm on a read
 * surface). ONE spelling, shared by hadron_get_node and hadron_get_nodes,
 * because cor:api:040:01 makes their per-node output the same thing and two
 * copies of a notice drift (PR #1088 review, Codex P2 — the batch dropped it).
 */
function noteFragment(projection: string, fragment: string | undefined): string {
  return fragment
    ? `Note: "#${fragment}" addresses this node's ${fragment}, which this tool does not project separately — showing the node itself.\n\n${projection}`
    : projection;
}
// #1012 — durable per-client MCP selections (active App / active memory).
import {
  CLIENT_KEY_HEADER,
  normalizeClientKey,
  loadMcpSessionState,
  saveActiveApp,
  saveActiveMemory,
  saveActiveOrg,
  saveActiveScope,
} from '../lib/mcpSessionState.js';
// Spec 049 Phase 1 — the active-organization ladder (D-2026-09-13-003).
import { resolveActiveOrg, type ActiveOrgResolution } from '../lib/auth/activeOrg.js';
// Spec 049 Phase 2 — the scope tools translate resolver refusals by their code.
import { GraphQLError as ScopeGraphQLError } from 'graphql';
// Spec 049 Phase 3 — the search ladder on MCP.
import { resolveSearchScope, canReadScope, resolveScopeByNameInApp, type SearchScopeResolution } from '../lib/scopes.js';
// Spec 049 Phase 6 — the register block on hadron_whoami's bound rows.
import { resolveRegister, renderDerivedBlocks } from '../lib/resolveRegister.js';
import { attendeeMentionTokens } from '../lib/channelReadState.js';
import { mentionReach } from '../lib/mentionReach.js';
import {
  markOwnTeamChatRead,
  maybeAdvanceOwnChannelRead,
  resumableOwnWorkerIds,
  teamAttentionAvailable,
} from '../lib/teamAttention.js';
import { resolveOrgRef } from '../lib/entityRef/orgRef.js';
import { edgeDisplayOrder, edgeRunOrder } from '../lib/edgeOrder.js';
import { Prisma, type PrismaClient, type SessionType, type NodeContentValidationOutcome } from '../generated/prisma/index.js';
import { memoryIsVectorIndexed } from '../lib/embedding/indexing.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A duration as "Nd Nh", "Nh Nm" or "Nm", for a human reading a deadline. */
function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * #1617 — one open session's liveness, as `hadron_whoami` prints it: live with
 * the instant it lapses, or lapsed since when. `lapsesAt` comes from
 * `sessionLapsesAt`, the computation the post and bind gates enforce.
 */
function renderSessionLiveness(lapsesAt: Date | null, now: Date, expiresAt?: Date | null): string {
  if (expiresAt && now.getTime() >= expiresAt.getTime()) {
    return `liveness: EXPIRED at ${expiresAt.toISOString()} — its holder must start a new session for this worker; no force override is required for their own session`;
  }
  if (!lapsesAt) return 'liveness: not live';
  const delta = lapsesAt.getTime() - now.getTime();
  return delta >= 0
    ? `liveness: LIVE until ${lapsesAt.toISOString()} (${formatDuration(delta)} left) unless driven first; ` +
        (expiresAt ? `driving it may renew the idle deadline, never its hard expiry ${expiresAt.toISOString()}` :
          'any attributed read, post or mark-read through it renews it')
    : `liveness: LAPSED at ${lapsesAt.toISOString()} (${formatDuration(-delta)} ago) — nothing drove it inside its ` +
        'idle window. It is still OPEN. If you hold this worker\'s name and no other session on it is live, your next ' +
        'team-chat post, read or mark-read through it RESUMES it (#1617); otherwise start a new session for this ' +
        'worker, which ends this one as superseded';
}

/** One operator can monitor this many live Workers in one poll. */
const TEAM_CHAT_MONITOR_MAX_TARGETS = 20;

interface TeamChatMonitorCheckpoint {
  v: 1;
  appId: string;
  channelId: string;
  workerId: string;
  seq: number;
}

/** Sign the exact attendee/Channel watermark the server scanned and returned. */
function signTeamChatMonitorCheckpoint(payload: TeamChatMonitorCheckpoint): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required for team-chat monitor checkpoints.');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

/** Verify a server-bound checkpoint; caller-authored or damaged values are null. */
function verifyTeamChatMonitorCheckpoint(token: string): TeamChatMonitorCheckpoint | null {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required for team-chat monitor checkpoints.');
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, suppliedSignature] = parts;
  const expectedSignature = createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(suppliedSignature, expectedSignature)) return null;
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<TeamChatMonitorCheckpoint>;
    if (
      value.v !== 1 ||
      typeof value.appId !== 'string' ||
      typeof value.channelId !== 'string' ||
      typeof value.workerId !== 'string' ||
      !Number.isInteger(value.seq) ||
      (value.seq ?? -1) < 0
    ) return null;
    return value as TeamChatMonitorCheckpoint;
  } catch {
    return null;
  }
}

// Server-identity / deployment-info surface lives in ./deploymentInfo.js so
// the GraphQL resolvers (which this module imports, line ~77) can read it
// without a circular import. Imported above for the internal MCP uses below;
// other modules import the symbols straight from ./deploymentInfo.js.

/**
 * Test-only harness — invoke a registered MCP tool by name without
 * spinning up an HTTP transport. Behavioral tests use this to exercise
 * the full closure inside `createMcpServerInstance` (including `auth`
 * binding) while skipping the transport, JSON-RPC framing, and zod
 * validation that the SDK does in production.
 *
 * The SDK's `_registeredTools` is `private` at the type level but is a
 * plain object at runtime. Coupling is deliberately narrow — if the SDK
 * renames the field, this single helper breaks loudly, rather than
 * every behavioral test in the suite.
 */
export interface TestableMcpServer {
  callTool(
    name: string,
    args?: unknown,
  ): Promise<{ content: Array<{ type: string; text: string }> }>;
  callToolText(name: string, args?: unknown): Promise<string>;
  /**
   * A registered tool's DESCRIPTION — the prose an LLM reads when choosing the
   * tool, which is the only part of a tool that can rot with nothing going red
   * (#1034). Throws on an unregistered name rather than returning undefined, so
   * a renamed tool fails the assertion loudly instead of vacuously passing.
   */
  toolDescription(name: string): string;
  /** A parameter's registered zod schema — see the implementation (#1301). */
  toolParamSchema(name: string, param: string): { parse: (v: unknown) => unknown };
  toolParamDescription(name: string, param: string): string;
  /**
   * Every registered tool name (#1141).
   *
   * Exists so a test can assert an ABSENCE across the whole manifest rather
   * than name-by-name: `toolDescription` throws on an unregistered name, which
   * pins the eleven removed chatbot tools but says nothing about a twelfth one
   * being added later. A removal that can be undone by writing a new tool with
   * a new name is not a removal.
   */
  toolNames(): string[];
}

/**
 * #1301 — the generic node-write fields a governed MCP door tool can ALSO
 * carry (its `governedDoorArgs`), so a refusal only advertises the door when
 * the refused call could be replayed through it (@codex, PR #1305). A test
 * pins every entry to the registered door schemas, so the two cannot drift.
 */
export const GOVERNED_MCP_DOOR_FIELDS: readonly string[] = [
  'name', 'description', 'abstract', 'content', 'tags', 'nodeType', 'seq', 'properties', 'data',
];

/**
 * Whether a generic MCP node write could be replayed through `kind`'s door
 * (`op`): every field it sets is one that door carries, and it clears neither
 * `content` nor `abstract` (the doors take strings only).
 *
 * The kind SIGNALS are door-specific (@copilot + @codex, PR #1305): only the
 * task update door carries `isRunnable`, only the review update door carries
 * `role`, and the create doors carry neither: they SET their own signal. So a
 * signal is replayable only through its own kind's door, and on a create only
 * as the value that door sets. Other kinds (spec) have no MCP door, so the
 * question is moot and answered true.
 */
export function mcpDoorCanReplay(
  fields: Record<string, unknown>,
  kind: GovernedKind,
  op: 'create' | 'update',
): boolean {
  if (kind !== 'task' && kind !== 'review') return true;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    // #937 — a revision precondition replays through governed UPDATE doors,
    // but is intentionally absent from every CREATE door.
    if (key === 'expectedRevision') {
      if (op !== 'update') return false;
      continue;
    }
    if (key === 'isRunnable') {
      if (kind !== 'task' || (op === 'create' && value !== true)) return false;
      continue;
    }
    if (key === 'role') {
      // #1345 review (@codex): the review CREATE door now sets any role in the
      // review family it is asked for (`review` or a dotted `review.*`), so a
      // generic create of `review.security` replays there.
      if (kind !== 'review' || (op === 'create' && !(typeof value === 'string' && roleIsOrDescendsFrom(value, 'review')))) {
        return false;
      }
      // The review door refuses ANOTHER governed family ("spec" and every
      // `spec.*` sub-role have their own door), while `review.*` remains owned
      // by this door (#1322). Null and ordinary open roles also replay.
      if (
        typeof value === 'string' &&
        governedKindsOf({ role: value }).some((entry) => entry.kind !== 'review')
      ) return false;
      continue;
    }
    if (!GOVERNED_MCP_DOOR_FIELDS.includes(key)) return false;
    if ((key === 'content' || key === 'abstract') && value === null) return false;
  }
  // The create doors require a non-blank name (callGovernedDoor), which the
  // generic create tool does not (@codex, PR #1305).
  if (op === 'create' && (typeof fields.name !== 'string' || fields.name.trim() === '')) return false;
  return true;
}


/** Cap on any one JSON field hadron_get_run renders, so a large envelope or trail cannot blow the MCP result ceiling (#1041). */
const RUN_FIELD_RENDER_CAP = 20_000;

/** Render one JSON field for hadron_get_run, capped with an honest truncation note. */
function renderRunJson(label: string, value: unknown): string {
  if (value === null || value === undefined) return `${label}: (none)`;
  const text = JSON.stringify(value, null, 2);
  if (text.length <= RUN_FIELD_RENDER_CAP) return `${label}:\n${text}`;
  return `${label} (truncated to ${RUN_FIELD_RENDER_CAP} of ${text.length} characters; read it in full via GraphQL appRun(ref:)):\n${text.slice(0, RUN_FIELD_RENDER_CAP)}`;
}

/** #1561 — the plain-text view of an AppRun row that hadron_get_run returns. */
function renderAppRun(run: Record<string, unknown>): string {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ?? '—');
  const hops = Array.isArray(run.hops) ? run.hops : null;
  const lines = [
    `Run ${run.id}${run.urn ? ` (${run.urn})` : ''}`,
    `Status: ${run.status}`,
    `Entry: ${run.entryNodeUrn}`,
    `Current node: ${run.curNodeUrn ?? '—'}`,
    `Trigger: ${run.triggerKind}${run.parentRunId ? ` · spawned by run ${run.parentRunId}` : ''}`,
    `Started: ${iso(run.startedAt)} · Finished: ${iso(run.finishedAt)} · Attempts: ${run.attempts ?? 0}`,
    // Codex-worker P2 (Jane): budgetTokens/budgetActions are REMAINING
    // balances, decremented as the run spends, so the denominator is the
    // initial budget; and a null spend means unknown (legacy runs), never 0.
    // A legacy run with no initial-budget column has an UNKNOWN budget: the
    // remaining balance is not the budget (Copilot on #1565).
    `Spent: ${run.tokensSpent ?? 'unknown'} tokens of ${run.budgetTokensInitial ?? 'unknown'} · ` +
      `${run.actionsSpent ?? 'unknown'} actions of ${run.budgetActionsInitial ?? 'unknown'}`,
    renderRunJson('Failure', run.failure),
    renderRunJson('Data (run envelope)', run.data),
    renderRunJson(`Hops${hops ? ` (${hops.length} completed)` : ''}`, run.hops),
  ];
  return lines.join('\n');
}

export function createTestableMcpServer(
  auth: AuthContext,
  opts?: {
    sessionId?: string;
    cachedAppResolution?: AppResolution | null;
    /** #1009 — simulate a session rebuilt from a stale id (a client reconnect). */
    isReconnect?: boolean;
    /** #1012 — the client instance id whose durable selections apply. */
    clientKey?: string | null;
    /** #1012 — a pre-authorized active-memory URN, as the boundary restores it. */
    restoredMemoryUrn?: string;
    /** Spec 049 Phase 1 — a re-authorized explicit active-org selection, as the boundary restores it. */
    restoredOrgId?: string;
    /** Spec 049 Phase 3 — a re-authorized active-scope selection, as the boundary restores it. */
    restoredScopeId?: string;
  },
): TestableMcpServer {
  const server = createMcpServerInstance(
    auth,
    () => opts?.sessionId,
    opts?.cachedAppResolution ?? null,
    {
      isReconnect: opts?.isReconnect,
      clientKey: opts?.clientKey,
      restoredMemoryUrn: opts?.restoredMemoryUrn,
      restoredOrgId: opts?.restoredOrgId,
      restoredScopeId: opts?.restoredScopeId,
    },
  );
  const tools = (server as unknown as {
    _registeredTools: Record<
      string,
      {
        handler: (
          args: unknown,
          extra: unknown,
        ) => Promise<{ content: Array<{ type: string; text: string }> }>;
        enabled: boolean;
        description?: string;
      }
    >;
  })._registeredTools;

  return {
    async callTool(name: string, args: unknown = {}) {
      const tool = tools[name];
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      if (!tool.enabled) throw new Error(`Tool disabled: ${name}`);
      return tool.handler(args, {});
    },
    toolDescription(name: string) {
      const tool = tools[name];
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      return tool.description ?? '';
    },
    toolNames() {
      return Object.keys(tools);
    },
    /**
     * A single PARAMETER's description (#1100).
     *
     * Tool descriptions were already testable; parameter descriptions were not,
     * and this repo leans on them heavily — `hadron_end_session.summary` read
     * "Summary of what was accomplished" while being display-only, which is a
     * footgun no test could see. Reads the registered zod shape rather than the
     * source text, so it tests what the CLIENT receives.
     *
     * Tolerates both shapes the SDK has used: an `inputSchema` ZodObject (has
     * `.shape`) and a bare raw-shape record. Throws rather than returning ''
     * for an unknown param — an empty string would make a missing description
     * indistinguishable from a wrong one, and this exists to catch wrong ones.
     */
    toolParamDescription(name: string, param: string) {
      const tool = tools[name] as unknown as {
        inputSchema?: { shape?: Record<string, { description?: string }> } & Record<
          string,
          unknown
        >;
      };
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      const schema = tool.inputSchema;
      const shape = (schema?.shape ?? schema) as
        | Record<string, { description?: string }>
        | undefined;
      const entry = shape?.[param];
      if (!entry) throw new Error(`Tool "${name}" has no parameter "${param}"`);
      return entry.description ?? '';
    },
    /**
     * A single parameter's registered zod SCHEMA. `callTool` invokes the
     * handler directly and skips the SDK's argument parsing, so a test that
     * needs to know what a tool ACCEPTS (a preprocessed shape such as
     * comma-separated tags) asks the schema instead (#1301).
     */
    toolParamSchema(name: string, param: string): { parse: (v: unknown) => unknown } {
      const tool = tools[name] as unknown as { inputSchema?: { shape?: Record<string, unknown> } & Record<string, unknown> };
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      const shape = (tool.inputSchema?.shape ?? tool.inputSchema) as Record<string, { parse: (v: unknown) => unknown }> | undefined;
      const entry = shape?.[param];
      if (!entry) throw new Error(`Tool "${name}" has no parameter "${param}"`);
      return entry;
    },
    async callToolText(name: string, args: unknown = {}) {
      const result = await this.callTool(name, args);
      return result.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
    },
  };
}

/** A single resolved edge ready to be written to the database (spec 037). */
export type ResolvedEdge = {
  targetNodeId: string;
  /** Target node's loc — used to derive the edge loc when none is authored. */
  targetLoc: string;
  /** Target memory participates in the Channel-reuse lock set. */
  targetMemoryId: string;
  name: string | null;
  /** Author-supplied loc, or null to derive from endpoints + name at write. */
  loc: string | null;
  description: string | null;
  isRunnable: boolean | null;
};

/**
 * Resolve every edge `targetId` through `resolveNodeRef` (spec 007)
 * so all four supported reference shapes — bare ID, full `urn:node:`
 * URN, memory-prefixed loc, and short loc within `sourceMemoryId` —
 * work uniformly.
 *
 * Pure read; writes nothing. Returns the resolved edges on success,
 * or `{ error: <user-facing string> }` when any ref doesn't resolve.
 * Callers run this BEFORE mutating the source node, so an unresolvable
 * target aborts the mutation cleanly without committing the source
 * upsert/update.
 *
 * Issue #107: prior inline logic in hadron_create_node / hadron_update_node used a
 * `targetId.includes(':')` heuristic plus `findFirst({loc})` (no
 * memory scope), which silently no-op'd memory-prefixed/URN forms and
 * FK-errored on single-segment short locs.
 *
 * Security (#755): target-memory read access is checked with `canReadMemory`,
 * exactly as the single-edge `addEdge` path does. `resolveNodeRef` is a pure
 * DB lookup with no auth context, so without this gate `hadron_create_node` /
 * `hadron_update_node` could point an edge at a node in a memory the caller
 * cannot read — both a foreign-memory existence oracle and, once the edge is
 * hydrated through `Edge.target`, a cross-tenant content read. The
 * unauthorized-target branch reuses the genuine-miss wording to keep that
 * channel closed.
 */
export async function resolveEdgeRefs(
  edges: Array<{
    targetId: string;
    name?: string | null;
    loc?: string | null;
    description?: string | null;
    isRunnable?: boolean | null;
  }>,
  sourceMemoryId: string,
  auth: AuthContext,
): Promise<{ resolved: ResolvedEdge[] } | { error: string }> {
  const resolved: ResolvedEdge[] = [];
  for (const edge of edges) {
    try {
      const { id: targetNodeId } = await resolveNodeRefForAuth(edge.targetId, auth, sourceMemoryId);
      // Fetch the target's loc so the edge loc can be derived at write time.
      const tgt = await db.node.findUnique({
        where: { id: targetNodeId },
        select: { loc: true, memoryId: true },
      });
      if (!tgt || !(await canReadMemory(db, auth, tgt.memoryId, EXPLICIT_REF))) {
        return { error: `Edge target not found: "${edge.targetId}"` };
      }
      resolved.push({
        targetNodeId,
        targetLoc: tgt.loc,
        targetMemoryId: tgt.memoryId,
        name: edge.name ?? null,
        loc: edge.loc ?? null,
        description: edge.description ?? null,
        isRunnable: edge.isRunnable ?? null,
      });
    } catch (err) {
      if (err instanceof NodeNotFoundError) {
        return { error: `Edge target not found: "${err.ref}"` };
      }
      throw err;
    }
  }
  return { resolved };
}

/**
 * Add a single outgoing edge from `sourceUrn` to `targetUrn`, non-
 * destructively (other edges on the source are left alone) and
 * idempotently (re-running the same edge at the same loc is a no-op;
 * an occupied loc with different endpoints or payload is refused). Backs the
 * `hadron_create_edge` MCP tool — extracted so the auth-gated flow (resolve
 * source → check write → resolve target → check read → insert/verify) is
 * directly testable without wiring a full MCP transport handshake.
 *
 * Returns either a `{ urn }`-shaped success carrying the canonical
 * URNs of both endpoints (useful for cross-memory edges where the
 * target's memory differs from the source's), or a `{ error }`-shaped
 * miss with a caller-facing message. Errors use the same wording the
 * tool surface emits, so the helper IS the contract for the MCP
 * response text.
 *
 * Security: target-memory read access is checked explicitly with
 * `canReadMemory` — `resolveNodeRef` is a pure DB lookup with no
 * auth context, so without this gate a caller could probe foreign-
 * memory node existence via the `Edge target not found` vs success
 * distinction. The unauthorized-target branch returns the same
 * `Edge target not found` wording as the genuine miss to keep the
 * channel closed.
 */
export type AddEdgeResult =
  | { error: string }
  | { sourceUrn: string; targetUrn: string; edgeUrn: string; name: string | null; loc: string };

export async function addEdge(args: {
  sourceUrn: string;
  targetUrn: string;
  name?: string | null;
  loc?: string | null;
  description?: string | null;
  isRunnable?: boolean | null;
  auth: AuthContext;
}): Promise<AddEdgeResult> {
  const {
    sourceUrn: rawSource,
    targetUrn: rawTarget,
    name = null,
    loc: authoredLoc = null,
    description = null,
    isRunnable = null,
    auth,
  } = args;

  // #322: the source may be an ID-shape PK *or* a fully-qualified URN.
  // PKs are immutable across move/rename, so referencing the source by id
  // survives a URN change (the incident in #322); a URN is the fallback.
  // A URN must be fully qualified (we recover the memory from it for the
  // write check); a bare PK is unambiguous, needs no qualification, and
  // can't reintroduce the spec-022 silent-routing hazard (that only
  // applies to context-relative locs, never to a PK lookup). The target
  // likewise accepts a PK or a fully-qualified URN — the gate below
  // enforces qualification for any non-ID target (no short-loc dispatch).
  try {
    if (!isId(rawTarget)) {
      assertFullyQualifiedUrn(rawTarget, 'node');
    }
  } catch (e) {
    if (e instanceof UrnNotQualifiedError) return { error: `Target: ${e.message}` };
    throw e;
  }

  // Resolve source strictly — hadron_create_edge never auto-creates the
  // source (use hadron_create_node for that). Both branches yield the
  // node's id + loc + memoryId; downstream is identifier-agnostic.
  let sourceNode: { id: string; loc: string; memoryId: string };
  if (isId(rawSource)) {
    const found = await db.node.findUnique({
      where: { id: rawSource },
      select: { id: true, loc: true, memoryId: true, deletedAt: true },
    });
    // #1316: a node in a memory hidden from this caller answers as a missing one.
    if (!found || found.deletedAt || (await isMemoryHiddenFrom(auth, found.memoryId, 'write'))) {
      return { error: `Source node not found: "${rawSource}".` };
    }
    sourceNode = { id: found.id, loc: found.loc, memoryId: found.memoryId };
  } else {
    try {
      assertFullyQualifiedUrn(rawSource, 'node');
    } catch (e) {
      if (e instanceof UrnNotQualifiedError) return { error: `Source: ${e.message}` };
      throw e;
    }
    const { memoryUrn: sourceMemoryUrn, loc: sourceLoc, fragment: sourceFrag } =
      splitNodeUrn(rawSource);
    // An edge is drawn between NODES: a fragment source would silently anchor
    // it to the parent and bake that into a derived edge loc.
    const sourceFragRefusal = nodeFragmentRefusal(rawSource, sourceFrag);
    if (sourceFragRefusal) return { error: `Source: ${sourceFragRefusal}` };
    // #1316: hidden from this caller ⇒ the missing branch, BEFORE the node
    // lookup — otherwise a missing loc answers "Source node not found" and so
    // confirms the memory exists.
    const sourceMem = await resolveVisibleMemoryByUrn(auth, sourceMemoryUrn, 'write');
    if (!sourceMem) {
      return { error: `Source memory not found: "${sourceMemoryUrn}".` };
    }
    const found = await db.node.findUnique({
      where: { loc_memoryId: { loc: sourceLoc, memoryId: sourceMem.id } },
      select: { id: true, loc: true, memoryId: true, deletedAt: true },
    });
    if (!found || found.deletedAt) {
      return { error: `Source node not found: "${rawSource}".` };
    }
    sourceNode = { id: found.id, loc: found.loc, memoryId: found.memoryId };
  }

  if (!(await canWriteToMemory(db, auth, sourceNode.memoryId, EXPLICIT_REF))) {
    return { error: `Write access denied for source memory.${await explainWriteRefusal(db, auth, sourceNode.memoryId)}` };
  }

  let targetNodeId: string;
  try {
    ({ id: targetNodeId } = await resolveNodeRefForAuth(rawTarget, auth, sourceNode.memoryId));
  } catch (e) {
    if (e instanceof NodeNotFoundError) {
      return { error: `Edge target not found: "${e.ref}"` };
    }
    throw e;
  }

  // Fetch the target's memory + loc once; reused for the
  // canReadMemory gate AND the success-message URN rendering.
  const target = await db.node.findUnique({
    where: { id: targetNodeId },
    select: { loc: true, memoryId: true },
  });
  if (!target || !(await canReadMemory(db, auth, target.memoryId, EXPLICIT_REF))) {
    return { error: `Edge target not found: "${rawTarget}"` };
  }

  // Spec 037: the edge's identity is its loc within the source memory.
  // Author-supplied loc is validated; otherwise derive it deterministically
  // so re-running with the same endpoints + name stays idempotent.
  const edgeLoc =
    authoredLoc != null && authoredLoc !== '' ? authoredLoc : deriveEdgeLoc(sourceNode.loc, name, target.loc);
  try {
    validateLoc(edgeLoc);
  } catch (e) {
    if (e instanceof InvalidLocError) return { error: `Invalid edge loc: ${e.message}` };
    throw e;
  }

  const writeError = await db.$transaction(async (tx): Promise<string | null> => {
    const locked = await lockLiveEdgeEndpoints(
      tx,
      sourceNode,
      { id: targetNodeId, loc: target.loc, memoryId: target.memoryId },
    );
    if (!locked.source) return `Source node not found: "${rawSource}".`;
    if (!locked.target) return `Edge target not found: "${rawTarget}"`;

    // Ownership may transfer after preflight while this transaction waits on
    // the endpoint keys. Fence both Memories through the insert, then rerun
    // the same source-write and target-read gates on the transaction client.
    for (const memoryId of [...new Set([sourceNode.memoryId, target.memoryId])].sort()) {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR SHARE`;
    }
    if (!(await canReadMemory(tx as typeof db, auth, sourceNode.memoryId, EXPLICIT_REF))) {
      return `Source node not found: "${rawSource}".`;
    }
    if (!(await canWriteToMemory(tx as typeof db, auth, sourceNode.memoryId, EXPLICIT_REF))) {
      return `Write access denied for source memory.${await explainWriteRefusal(tx as typeof db, auth, sourceNode.memoryId)}`;
    }
    if (!(await canReadMemory(tx as typeof db, auth, target.memoryId, EXPLICIT_REF))) {
      return `Edge target not found: "${rawTarget}"`;
    }
    // Writer level of the source node, on the locked source.
    try {
      await assertEdgeSourceWritersById(tx, auth, locked.source.id);
    } catch (e) {
      const text = roleWriterRefusalText(e);
      if (text) return text;
      throw e;
    }

    // ON CONFLICT DO NOTHING is race-safe for simultaneous first creates.
    // A skipped insert proves only that the ADDRESS exists, not that the
    // requested relation was saved (#1469). Verify the occupying row before
    // issuing a success receipt; a tombstone cannot satisfy the request.
    const { count } = await tx.edge.createMany({
      data: [{
        id: generateId(),
        memoryId: locked.source.memoryId,
        sourceId: locked.source.id,
        targetId: locked.target.id,
        loc: edgeLoc,
        name,
        description,
        isRunnable,
        createdBy: auth.clientId ?? null,
      }],
      skipDuplicates: true,
    });
    if (count === 0) {
      const occupant = await tx.edge.findUnique({
        where: { loc_memoryId: { loc: edgeLoc, memoryId: locked.source.memoryId } },
      });
      // condition/priority/data are not accepted by this MCP tool, so a new
      // edge gets the database defaults. An existing edge with different
      // behavior is not an idempotent replay, even if its endpoints match.
      if (!occupant || occupant.deletedAt || occupant.sourceId !== locked.source.id ||
          occupant.targetId !== locked.target.id || occupant.name !== name ||
          occupant.description !== description || occupant.isRunnable !== isRunnable ||
          occupant.condition !== null || occupant.priority !== 0 || occupant.data !== null) {
        return `[edge_loc_conflict] Edge loc "${edgeLoc}" is occupied; choose another loc.`;
      }
    }
    return null;
  });
  if (writeError) return { error: writeError };

  // #1061 — an edge write is a graph write, attributed to the SOURCE node (the
  // edge lives in the source's memory and UsageEvent has no edge dimension —
  // same rule as the GraphQL createEdge). This helper also backs the edge set
  // hadron_update_node replaces, but that path already records its own write on
  // the node, so it is called only from hadron_create_edge.
  recordNodeWrite(db, sourceNode, auth);
  await mirrorEdgeSourceAfterCommit(db, sourceNode, auth.clientId);

  const savedSourceUrn = await nodeUrn(sourceNode.loc, sourceNode.memoryId);
  const savedTargetUrn = await nodeUrn(target.loc, target.memoryId);
  const savedEdgeUrn = await edgeUrn(edgeLoc, sourceNode.memoryId);
  return { sourceUrn: savedSourceUrn, targetUrn: savedTargetUrn, edgeUrn: savedEdgeUrn, name, loc: edgeLoc };
}

/**
 * Replace the outgoing edges of `sourceNodeId` with `resolved`, in a
 * single `$transaction` so we never observe a state where the
 * existing edges are gone but the new ones are missing.
 *
 * Caller must have already validated targets via `resolveEdgeRefs`. The
 * endpoint snapshots are revalidated under the Channel-reuse memory keys
 * before replacement. Each row gets an explicit
 * UUIDv7 from `generateId()` because the Prisma client extension at
 * `src/integrations/db/client.ts` only auto-injects IDs on `create`
 * and `upsert`, not on `createMany`.
 */
export async function replaceOutgoingEdges(args: {
  sourceNodeId: string;
  sourceLoc: string;
  sourceMemoryId: string;
  resolved: ResolvedEdge[];
  createdBy: string | null;
}): Promise<string | null> {
  try {
    return await db.$transaction(async (tx) => {
      await lockOutgoingEdgeMemories(tx, args.sourceMemoryId, args.resolved);
      return replaceOutgoingEdgesInTransaction(tx, args);
    });
  } catch (e) {
    if (e instanceof EdgeLocConflictError) return e.message;
    throw e;
  }
}

class InlineEdgeEndpointError extends Error {}
class EdgeLocConflictError extends Error {}
/** The target moved, was deleted or changed memory while this write waited for its row lock (PR #1339 review). */
class NodeMovedDuringWriteError extends Error {}
class MemoryEncryptionChangedDuringWriteError extends Error {}
class MemoryWriteAccessChangedDuringWriteError extends Error {}

async function assertLockedMemoryWriteAccess(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  memoryId: string,
): Promise<void> {
  if (!(await canWriteToMemory(tx as typeof db, auth, memoryId, EXPLICIT_REF))) {
    throw new MemoryWriteAccessChangedDuringWriteError(
      '[node_write_conflict] Memory write access changed while this write waited — re-read and retry.',
    );
  }
}

/** Serialize the memory's encryption and write authority with a prepared node write. */
async function assertMemoryEncryptionStateForWrite(
  tx: Prisma.TransactionClient,
  memoryId: string,
  expectedEncrypted: boolean,
  auth: AuthContext,
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "memories" WHERE "id" = ${memoryId} FOR SHARE`;
  const current = await tx.memory.findUniqueOrThrow({
    where: { id: memoryId }, select: { isEncrypted: true },
  });
  if (current.isEncrypted !== expectedEncrypted) {
    throw new MemoryEncryptionChangedDuringWriteError(
      '[node_write_conflict] Memory encryption changed while this write waited — re-read and retry.',
    );
  }
  // A transfer may have committed after the preflight gate. Re-read through
  // the transaction client while the Memory row is held, then keep that lock
  // through commit so the destination tenant cannot inherit a late write.
  await assertLockedMemoryWriteAccess(tx, auth, memoryId);
}

async function lockOutgoingEdgeMemories(
  tx: Prisma.TransactionClient,
  sourceMemoryId: string,
  resolved: readonly ResolvedEdge[],
): Promise<void> {
  await lockEdgeEndpointMemories(tx, [
    sourceMemoryId,
    ...resolved.map((edge) => edge.targetMemoryId),
  ]);
}

/**
 * #2040 — include tags: refuse a bad one and sync the derived INCLUDE edges, in
 * the writer's own transaction on the plaintext it holds, so a refusal rolls
 * back the content, revision and edges together.
 */
async function applyIncludesInTransaction(
  tx: Prisma.TransactionClient,
  node: { id: string; loc: string; memoryId: string },
  plaintextContent: string | null,
  auth: AuthContext,
  storedPlaintext: string | null,
): Promise<void> {
  // #2041 S2b — `storedPlaintext` is the node's plaintext from the row this
  // write locked and revalidated, before its update (null for a create).
  const readable = plaintextContent?.includes('{{>') ? await getAccessibleMemoryIds(db, auth) : null;
  const stored = { storedPlaintext };
  const tags = await assertIncludesWritable(tx, node, plaintextContent, readable, undefined, stored);
  await syncDerivedIncludesEdges(tx, node, tags, readable, stored);
}

async function replaceOutgoingEdgesInTransaction(
  tx: Prisma.TransactionClient,
  args: {
    sourceNodeId: string;
    sourceLoc: string;
    sourceMemoryId: string;
    resolved: ResolvedEdge[];
    createdBy: string | null;
  },
): Promise<string | null> {
  const source = {
    id: args.sourceNodeId,
    loc: args.sourceLoc,
    memoryId: args.sourceMemoryId,
  };
  const targets = args.resolved.map((edge) => ({
    id: edge.targetNodeId,
    loc: edge.targetLoc,
    memoryId: edge.targetMemoryId,
  }));
  const live = await liveEdgeEndpointSet(tx, [source, ...targets]);
  if (!live.has(source.id)) return `Source node not found: "${source.id}".`;
  const missing = args.resolved.find((edge) => !live.has(edge.targetNodeId));
  if (missing) return `Edge target not found: "${missing.targetNodeId}"`;

  // Derived INCLUDE edges (#2040) belong to the content writer.
  await tx.edge.deleteMany({ where: { sourceId: args.sourceNodeId, governedKind: null } });
  await tx.pendingEdge.deleteMany({ where: { sourceId: args.sourceNodeId } });
  if (args.resolved.length > 0) {
    const { count } = await tx.edge.createMany({
      data: args.resolved.map((e) => ({
        id: generateId(),
        memoryId: args.sourceMemoryId,
        sourceId: args.sourceNodeId,
        targetId: e.targetNodeId,
        loc: e.loc ?? deriveEdgeLoc(args.sourceLoc, e.name, e.targetLoc),
        name: e.name,
        description: e.description,
        isRunnable: e.isRunnable,
        createdBy: args.createdBy,
      })),
      skipDuplicates: true,
    });
    // createMany's skipped rows may belong to another source or be duplicate
    // locs in this request. Abort the enclosing node+edge transaction so the
    // old outgoing set and any node edit remain intact.
    if (count !== args.resolved.length) {
      throw new EdgeLocConflictError('[edge_loc_conflict] An edge loc is already occupied; choose unique edge locs.');
    }
  }
  return null;
}

/**
 * v2 entity URN for user-facing MCP tool text (#697 emission flip). Falls back
 * to the raw stored bare urn if a row can't compose to v2 — display strings must
 * never crash a tool (serve-and-fall-back).
 */
function safeEmitEntityUrnV2(type: 'memory' | 'app' | 'agent' | 'org', bareUrn: string): string {
  try {
    return emitEntityUrnV2(type, bareUrn);
  } catch {
    return bareUrn;
  }
}

/**
 * The portal link for a worker URN, or null (#1026).
 *
 * ONE resolver for every MCP surface that prints a worker URN — the cast
 * receipt, the bind receipt, the roster, the single read, and `hadron_whoami`.
 * The rule those surfaces now share is flat: **wherever a worker URN is
 * printed, the link that opens it is printed with it**, so an agent never has
 * to assemble `<origin>/app/u/<urn>` itself. That is the same instruction every
 * role-agent prompt already gives for node reads (#881), and #1008's identity
 * signature was the one place the platform could not honour it.
 *
 * Takes the URN the caller ALREADY has rather than re-resolving through
 * `Worker.portalUrl`: the field resolver would repeat the App lookup that
 * produced that URN, and `portalUrlForUrn` is the same pure function it ends in
 * — so this cannot drift from the GraphQL field, and costs nothing.
 *
 * Null for a null URN (an App URN the fixed arity cannot take) and for an unset
 * or malformed `FRONTEND_URL`. Callers omit the line entirely rather than emit
 * a guess: a link to the wrong host is worse than no link (lib/portalUrl.ts).
 *
 * Returns the URL rather than a formatted line because the surfaces disagree on
 * framing — the block reads print `URL: <x>` on its own line, the list reads
 * indent it under their item — and a helper that owned both shapes would take a
 * format argument to save nothing.
 */
function workerPortalUrl(urn: string | null | undefined): string | null {
  return urn ? portalUrlForUrn(urn) : null;
}

/** Read the current stored Memory URN; a rename may come through GraphQL or another process. */
async function loadMemoryUrn(memoryId: string): Promise<string> {
  const mem = await db.memory.findUnique({ where: { id: memoryId }, select: { urn: true } });
  return mem?.urn ?? memoryId;
}

/** Share one Memory lookup only among projections within the same render. */
function memoizedMemoryUrnLookup(): (memoryId: string) => Promise<string> {
  const pending = new Map<string, Promise<string>>();
  return (memoryId) => {
    let lookup = pending.get(memoryId);
    if (!lookup) {
      lookup = loadMemoryUrn(memoryId);
      pending.set(memoryId, lookup);
    }
    return lookup;
  };
}

/** Build a full urn:node: URN from a loc and the current Memory URN. */
async function nodeUrn(
  loc: string, memoryId: string, memoryUrnOf = loadMemoryUrn,
): Promise<string> {
  const memUrn = await memoryUrnOf(memoryId);
  // Grammar-v2 node URN (#697 emission flip). Shared with the global-search
  // node adapter via urnEmit (src/lib/urnEmit.ts) so the two surfaces can't
  // drift on node-URN shape. The SAFE variant is load-bearing here: this is
  // called once per rendered node AND once per edge neighbour, so a single
  // corrupt stored loc would otherwise fail the entire tool response.
  return safeNodeUrnV2(memUrn, loc);
}

/**
 * {@link nodeUrn} for the SUBJECT of a projection, reporting whether the URN is
 * the unvalidated best-effort fallback. Only needed where the URN becomes a
 * portal LINK — a fallback URN can carry `/`, `?`, or `#` straight out of a
 * corrupt stored loc, and `portalUrlForUrn` interpolates the URN raw, so the
 * emitted href could point somewhere other than the node being displayed.
 * Edge-neighbour URNs are display-only and use the plain string form.
 */
async function nodeUrnResult(
  loc: string, memoryId: string, memoryUrnOf = loadMemoryUrn,
): Promise<SafeUrnEmission> {
  const memUrn = await memoryUrnOf(memoryId);
  return safeNodeUrnV2Result(memUrn, loc);
}

/** Build a full hrn:edge: URN from an edge loc and its memoryId (spec 037). */
async function edgeUrn(loc: string, memoryId: string): Promise<string> {
  const memUrn = await loadMemoryUrn(memoryId);
  return safeEdgeUrnV2(memUrn, loc);
}

// The `hadron_find_nodes` tool delegates retrieval to resolvers.Query.findNodes
// (PR2 #403), so the keyword/expand search helpers are no longer imported here;
// they live in src/lib/search.ts, consumed by the findNodes resolver.

// Loc validation moved to src/lib/validateLoc.ts so the GraphQL
// upsertNode resolver and the MCP tool surface share the same rule
// and produce the same typed InvalidLocError.

/**
 * Resolve subtree selectors for both tree tools (#2512/#2526).
 * Explicit references identify a memory independently of discovery, then pass
 * the shared read gate (cor:acl:010:02). Missing/unreadable references share a
 * result kind so each tool preserves its envelope (cor:api:140:03).
 * Bare unscoped locs remain discovery; they never acquire explicit authority.
 */
async function resolveParentForRead(
  parentRel: string,
  memoryUrn: string | undefined,
  accessibleMemoryIds: string[] | null,
  auth: AuthContext,
  sessionMemoryIds: Set<string> | null = null,
): Promise<
  | { ok: true; loc: string; memoryId?: string }
  | { ok: false; kind: 'invalid' | 'notFound'; message: string }
> {
  const missing = () => ({ ok: false as const, kind: 'notFound' as const, message: `Node "${parentRel}" not found.` });
  const readable = async (id: string) =>
    await canReadMemory(db, auth, id, EXPLICIT_REF) && (!sessionMemoryIds || sessionMemoryIds.has(id));
  try {
    const qualified = parseUrnInput(parentRel).type === 'node';
    if (hasSchemePrefix(parentRel) && !qualified) {
      return { ok: false, kind: 'invalid', message: 'parentRel must be a node URN or a bare loc.' };
    }
    if (memoryUrn) assertFullyQualifiedUrn(memoryUrn, 'memory');
    let resolved: { loc: string; memoryId?: string };
    if (qualified || memoryUrn) {
      const parent = qualified ? splitNodeUrn(parentRel) : { memoryUrn: memoryUrn!, loc: parentRel };
      const mem = await resolveMemoryByUrn(parent.memoryUrn);
      if (!mem) return missing();
      resolved = { loc: parent.loc, memoryId: mem.id };
    } else {
      resolved = await resolveLocFromUrn(parentRel, accessibleMemoryIds);
    }
    if (resolved.memoryId && !await readable(resolved.memoryId)) return missing();
    // Both references authorize before mismatch diagnostics can reveal identity.
    if (qualified && memoryUrn) {
      const scoped = await resolveMemoryByUrn(memoryUrn);
      if (!scoped || !await readable(scoped.id)) return missing();
      if (scoped.id !== resolved.memoryId) {
        return { ok: false, kind: 'invalid', message: 'parentRel and memoryUrn must name the same memory.' };
      }
    }
    return { ok: true, ...resolved };
  } catch (e) {
    if (e instanceof UrnNotQualifiedError) return { ok: false, kind: 'invalid', message: e.message };
    throw e;
  }
}

/**
 * If the user passes a full URN (e.g. "hadronmemory.com:dev:architecture"),
 * try to strip the memory URN prefix and return just the loc.
 * Also returns the matched memoryId for scoping.
 */
async function resolveLocFromUrn(
  rawInput: string,
  accessibleMemoryIds: string[] | null,
): Promise<{ loc: string; memoryId?: string }> {
  // For an explicit `urn:node:<org>::<memory>::<loc>` input (canonical
  // OR legacy hierarchy), route through splitNodeUrn so the memory/loc
  // boundary is recovered correctly. The fallback prefix-strip below
  // uses `mem.urn + ':'` to detect the boundary, which mis-parses
  // canonical inputs in two ways:
  //   - If Memory.urn is legacy (`acme.com:dev`), the input
  //     `acme.com::dev::loc` doesn't start with `acme.com:dev:` and
  //     never matches.
  //   - If Memory.urn is canonical (`acme.com::dev`), the input
  //     starts with `acme.com::dev:` (one trailing colon, not two),
  //     so the strip leaves a leading `:` in the returned loc.
  // Either way, callers (hadron_list_nodes / hadron_find_nodes) end up with a
  // bogus prefix that breaks depth math and `startsWith(prefix + ':')`
  // scoping. splitNodeUrn handles both grammars uniformly.
  const parsed = parseUrnInput(rawInput);
  if (parsed.type === 'node') {
    try {
      const { memoryUrn, loc } = splitNodeUrn(rawInput);
      const mem = await resolveMemoryByUrn(memoryUrn);
      if (mem && (!accessibleMemoryIds || accessibleMemoryIds.includes(mem.id))) {
        return { loc, memoryId: mem.id };
      }
      // Memory unknown / inaccessible — fall through to the legacy
      // best-effort path below so behavior degrades gracefully for the
      // (rare) caller passing a stale or out-of-scope URN.
    } catch (err) {
      // ONLY splitNodeUrn's malformed-input rejection degrades to the
      // best-effort path below. Anything else — an AmbiguousLegacyUrnError from
      // the #697 alias fallback in resolveMemoryByUrn, a DB failure — must
      // escape: silently falling through would answer a genuinely ambiguous
      // reference with unrelated best-effort loc matches instead of failing
      // loudly, which is the one outcome the alias map is designed to prevent
      // (PR #963 review).
      if (!(err instanceof UrnNotQualifiedError)) throw err;
    }
  }

  const input = parsed.value;

  // First, try as-is — it might already be a valid loc
  const directWhere: Record<string, unknown> = { loc: input };
  if (accessibleMemoryIds) directWhere.memoryId = { in: accessibleMemoryIds };
  const direct = await db.node.findFirst({ where: directWhere, select: { id: true } });
  if (direct) return { loc: input };

  // Try stripping known memory URN prefixes
  // Load accessible memories and check if input starts with any URN
  const memoryFilter = accessibleMemoryIds ? { id: { in: accessibleMemoryIds } } : {};
  const memories = await db.memory.findMany({ where: memoryFilter, select: { id: true, urn: true } });
  for (const mem of memories) {
    const prefix = mem.urn + ':';
    if (input.startsWith(prefix)) {
      const loc = input.slice(prefix.length);
      return { loc, memoryId: mem.id };
    }
  }

  // No match — return as-is
  return { loc: input };
}

/**
 * Look up a Memory by a user-supplied URN that may be canonical
 * (`urn:memory:foo:bar`) or bare (`foo:bar`). Memory.urn is stored bare,
 * so a prefixed input must be stripped before the DB lookup. A wrong-type
 * URN prefix (`urn:agent:`, `urn:org:`, etc.) returns null so the caller
 * can surface a clean error rather than silently coerce — see #100 #3
 * (the memory-scoped read-after-write asymmetry traced to this exact
 * normalization gap).
 *
 * Soft-deleted memories are treated as not found, matching the convention
 * in `resolveMemoryRef` and the entity-ref helpers under `src/lib/entityRef/`.
 *
 * #697 STORED ALIAS MAP: after the primary `urn` lookup misses, a URN that
 * addressed this row BEFORE the grammar-v2 migration re-minted it is redirected
 * via `legacyUrn` — the same fallback `resolveMemoryRef` already had, and the
 * whole reason the migration records the old value instead of rewriting
 * references. Every MCP memory-scope path (all 22 call sites: the `memoryUrn` /
 * `memoryUrns` scopes, node reads that split a node URN, edge endpoints, move,
 * sync) funnels through here, so its absence made a re-minted memory
 * unreachable by any stored reference to its old URN — which is exactly what a
 * user hits after #723 flattens their team memory (found running the prod
 * backfill: `hadron_find_nodes memoryUrn:'<old compound urn>'` answered "Memory
 * not found" the moment the row was re-minted).
 *
 * Ambiguity (two live rows claiming the same `legacyUrn`) throws
 * `AmbiguousLegacyUrnError` rather than picking one — the #697 rule is fail
 * loudly, never silently resolve to the wrong tenant's row.
 */
async function resolveMemoryByUrn(
  rawUrn: string,
): Promise<{ id: string; urn: string } | null> {
  const parsed = parseUrnInput(rawUrn.trim());
  if (parsed.type !== 'memory' && parsed.type !== 'unknown') return null;
  if (!parsed.value) return null;
  // Spec 021 migration window: Memory.urn rows may be stored in either
  // legacy (`acme.com:dev`) or canonical (`acme.com::dev`) form. Match
  // BOTH so a canonical-form input doesn't miss a legacy-stored row and
  // vice versa. Previously this normalized to legacy only and used an
  // equality lookup — that broke for the canonical-stored case, which
  // the resolveNodeRef tests in this PR already exercise (and the
  // hadron_create_edge source path inherits the same hazard via splitNodeUrn).
  const legacyForm = normalizeUrnForLookup(parsed.value);
  const canonicalForm = legacyForm.includes(':')
    ? legacyForm.split(':').join('::')
    : legacyForm;
  const direct = await db.memory.findFirst({
    where: {
      deletedAt: null,
      OR: [{ urn: legacyForm }, { urn: canonicalForm }],
    },
    select: { id: true, urn: true },
  });
  if (direct) return direct;
  // Alias fallback, from BOTH sources: the #697 `legacy_urn` column and the
  // #1079 rename map.
  //
  // The rename map arm is not optional here (PR #1080 review, Copilot P2).
  // Every MCP memory / node / edge scope funnels through this one function
  // rather than through `resolveMemoryRef`, so without it a memory renamed
  // through #1079 — and every node and edge URN beneath it — still answered
  // "not found" over MCP while resolving fine over GraphQL. Two surfaces, two
  // answers, which is the drift #1079 exists to remove.
  const [legacyRows, aliasRows] = await Promise.all([
    db.memory.findMany({
      where: { deletedAt: null, legacyUrn: { in: [legacyForm, canonicalForm] } },
      select: { id: true, urn: true },
      take: 2,
    }),
    // Through the shared PAGED walk, not the one-page primitive (PR #1080
    // third review, Codex P2). Calling `findUrnAliasTargetIds` directly took
    // only its first page before liveness, so a live claimant sitting past
    // page one resolved over GraphQL and 404'd over MCP — reintroducing, on
    // this surface alone, the very drift wiring MCP up was meant to remove.
    // Liveness is re-applied inside the walk and never read off the alias
    // (cor:urn:030:02).
    (async () => {
      const perForm = await Promise.all(
        [legacyForm, canonicalForm].map((u) =>
          findLiveUrnAliasTargets(db, 'MEMORY', u, (ids) =>
            db.memory.findMany({
              where: { deletedAt: null, id: { in: ids } },
              select: { id: true, urn: true },
            }),
          ),
        ),
      );
      return perForm.flat();
    })(),
  ]);
  // Deduplicated by id before the ambiguity check: the two alias sources overlap
  // by construction, and the two URN spellings can resolve the same row twice.
  const candidates = dedupeById(legacyRows, aliasRows);
  const aliased = resolveLegacyAlias(rawUrn, candidates);
  return aliased ? (candidates.find((m) => m.id === aliased.id) ?? null) : null;
}

/**
 * Resolve a memory URN exactly as a tool's MISSING branch sees it (#1316):
 * null when no such memory exists, and ALSO null when it exists but is hidden
 * from this caller — so the tool's own `if (!memory) return <missing text>`
 * answers both, byte for byte, from the same line.
 *
 * Folding the check into resolution, rather than refusing later, is the
 * point. Each tool used to resolve first (only a missing memory refused
 * there) and deny afterwards with its own text, so "exists but not yours"
 * differed from "no such memory" — and memory URNs are guessable. A refusal
 * placed any later than the missing branch leaks through whatever runs in
 * between: loc validation, a node lookup, the other end of a move.
 *
 * Hidden means:
 *   - `'read'`  — the caller cannot read the memory (`canReadMemory`).
 *   - `'write'` — the caller can neither write NOR read it. A caller who may
 *     read it already knows it exists and keeps the tool's actionable write
 *     denial; a caller who may write is never narrowed, even without read.
 */
async function resolveVisibleMemoryByUrn(
  auth: AuthContext,
  rawUrn: string,
  need: 'read' | 'write',
): Promise<{ id: string; urn: string } | null> {
  const memory = await resolveMemoryByUrn(rawUrn);
  if (!memory) return null;
  return (await isMemoryHiddenFrom(auth, memory.id, need)) ? null : memory;
}

/**
 * The predicate behind {@link resolveVisibleMemoryByUrn}, for a tool whose
 * missing branch answers after a lookup by some other key (a node PK): true
 * when this memory must be treated as absent for this caller (#1316).
 */
async function isMemoryHiddenFrom(
  auth: AuthContext,
  memoryId: string,
  need: 'read' | 'write',
): Promise<boolean> {
  // A no-op TODAY, and deliberately kept: every branch of the MCP gates has
  // write ⇒ read, so a writer is also a reader and the read check alone would
  // admit them. This makes "never narrow a writer" hold by construction instead
  // of by that implication, which lives in another file and nothing pins. A
  // mutant deleting this line therefore survives — that is expected, not a gap.
  // Both callers hand in a memory the request named (a URN, or a node looked up
  // by a caller-supplied key), so this is an explicit reference (#1503).
  if (need === 'write' && (await canWriteToMemory(db, auth, memoryId, EXPLICIT_REF))) return false;
  return !(await canReadMemory(db, auth, memoryId, EXPLICIT_REF));
}

// Access control lives in ./access-control.ts.

/**
 * Shared single-node read projection — the meta block + contentScope-driven
 * body that `hadron_get_node` returns. Extracted so `hadron_get_nodes` (batch) emits
 * the *identical* per-node projection (spec cor:api:040:01 — "the per-node
 * projection is identical to the single-node read"); the two surfaces share
 * one renderer and cannot drift. Pure formatting — the caller fetches the
 * node (with outgoing/incoming edges + `memory.isEncrypted`), validates
 * `contentScope`, and fires any usage event; this only renders. Response
 * matrix: spec cor:api:020:03 (harvested from specs 031 + 032).
 */
type ReadProjectionNode = {
  id: string;
  revSeq: number;
  // #1610 agent attribution.
  createdByWorkerId: string | null;
  createdByAgentId: string | null;
  updatedByWorkerId: string | null;
  updatedByAgentId: string | null;
  authorshipKind: 'TASK' | 'HUMAN' | null;
  authoredByTask: string | null;
  authoredByRevision: number | null;
  authoredByHuman: string | null;
  authoredAt: Date | null;
  /** #1591 — the latest approval on record. */
  approvedRevNo: number | null;
  /** #1611 — the revision the approval-hashed fields last changed at. */
  contentRevSeq: number;
  approvedBy: string | null;
  approvedByInfo: string | null;
  approvedAt: Date | null;
  /** #1838 — null once the approval ended on encrypted entry; a hashless record authorizes nothing. */
  approvalHash?: string | null;
  /** #1591 — the mint record. */
  mintedAt: Date | null;
  mintedBy: string | null;
  mintedByInfo: string | null;
  mintedRevNo: number | null;
  name: string;
  loc: string;
  memoryId: string;
  description: string | null;
  nodeType: string;
  /** #1201 — governed kind markers, rendered so a reader can tell which door applies. */
  role: string | null;
  isRunnable: boolean | null;
  tags: string[];
  seq: number | null;
  properties: unknown;
  data: unknown;
  content: string | null;
  /** Only plaintext, raw abstract reads without an origin fingerprint use this. */
  contentPresent?: boolean;
  abstract: string | null;
  abstractOriginHash: string | null;
  memory: { isEncrypted: boolean };
  outgoingEdges: Array<{ name: string | null; loc: string; governedKind?: unknown; target: { id: string; loc: string; memoryId: string; name: string } }>;
  incomingEdges: Array<{ name: string | null; loc: string; governedKind?: unknown; source: { id: string; loc: string; memoryId: string; name: string } }>;
};

const readProjectionInclude = {
  outgoingEdges: { include: { target: { select: { id: true, loc: true, memoryId: true, name: true } } }, where: { target: { deletedAt: null } }, orderBy: edgeDisplayOrder() },
  incomingEdges: { include: { source: { select: { id: true, loc: true, memoryId: true, name: true } } }, where: { source: { deletedAt: null } }, orderBy: edgeDisplayOrder() },
  memory: { select: { isEncrypted: true } },
} as const;

/** Reconcile and fetch the complete projection while the node row stays locked. */
async function loadCurrentReadProjection(
  nodeId: string,
  authorizedMemoryId: string,
  auth: AuthContext,
  readViaMemoryId: string = authorizedMemoryId,
  mode: 'body' | 'metadata' | 'abstract-raw' | 'abstract-expanded' = 'body',
): Promise<ReadProjectionNode | null> {
  return withReconciledNodeRead(db, nodeId, authorizedMemoryId, async (tx, mayReconcile) => {
    let fresh: Context;
    try {
      fresh = await (mayReconcile ? liveTxContext : liveReadSnapshotContext)({ ...auth, db }, tx);
    } catch (error) {
      // Credential/actor refusal is concealed like an unreadable memory. DB
      // faults and transaction-mode errors remain errors, never "not found".
      if (error instanceof GraphQLError && error.extensions.code === 'FORBIDDEN') return false;
      throw error;
    }
    return canReadMemory(tx as unknown as typeof db, { ...auth, roles: fresh.roles }, readViaMemoryId, EXPLICIT_REF);
  }, async (tx) => {
    const args = { where: { id: nodeId, deletedAt: null }, include: readProjectionInclude };
    // The batch provenance pass retains only metadata. Its render pass reads
    // one current body under the same reconciliation and authorization gate.
    if (mode === 'body') return tx.node.findFirst(args) as Promise<ReadProjectionNode | null>;
    const row = await tx.node.findFirst({ ...args, omit: { content: true } });
    if (!row) return null;
    if (mode === 'metadata' || !row.abstract) return { ...row, content: null };
    if (mode === 'abstract-raw' && !row.memory.isEncrypted && row.abstractOriginHash == null) {
      // Presence is enough for the existing missing-fingerprint marker. Read
      // it under this node's lock; never trust the earlier metadata snapshot.
      const presence = await tx.$queryRaw<Array<{ present: boolean }>>`
        SELECT (content IS NOT NULL AND octet_length(content) > 0) AS present
        FROM nodes WHERE id = ${nodeId} AND memory_id = ${authorizedMemoryId} AND deleted_at IS NULL`;
      return presence[0] ? { ...row, content: null, contentPresent: presence[0].present } : null;
    }
    // Fingerprinted, encrypted and expanded abstracts retain their exact
    // plaintext predicate. Only one such body survives to the next render.
    return tx.node.findFirst(args) as Promise<ReadProjectionNode | null>;
  }, { timeoutMs: 5_000, maxWaitMs: 2_000 });
}

/**
 * Spec 041 (PR-2, #206): decrypt a fetched node in place when this process
 * holds the memory's key (MCP session unlock / any live session), or mark
 * it locked. On 'unlocked' the projection is plaintext and downstream logic
 * (staleness hash, fallbacks) behaves exactly like a plaintext memory — the
 * helper flips the projection's isEncrypted flag to say so. On 'locked' the
 * encrypted fields are BLANKED (a `Locked:` meta line replaces enc:v1 noise).
 */
function mcpDecryptOrMark(
  node: Pick<ReadProjectionNode, 'memoryId' | 'content' | 'abstract' | 'data' | 'memory'>,
): 'plaintext' | 'unlocked' | 'locked' {
  if (!node.memory.isEncrypted) return 'plaintext';
  const key = sessionKeyCache.getByMemoryId(node.memoryId);
  if (key) {
    decryptNodeFieldsWithKey(node, key);
    node.memory = { isEncrypted: false }; // projection-local: it IS plaintext now
    return 'unlocked';
  }
  node.content = null;
  node.abstract = null;
  node.data = null;
  return 'locked';
}

type ReadValidationReport = {
  nodeId: string;
  nodeRevSeq: number;
  validationTaskId: string;
  validationTaskRevSeq: number;
  outcome: NodeContentValidationOutcome;
};

/**
 * One report lookup for an MCP batch, with each node's OWN current revision
 * and memory. DISTINCT ON over all reports would pick a future revision for
 * some nodes; the lateral index lookup keeps single-node selection semantics.
 */
async function batchValidationReports(nodes: readonly ReadProjectionNode[]): Promise<Map<string, ReadValidationReport>> {
  if (nodes.length === 0) return new Map();
  const values = Prisma.join(nodes.map((n) => Prisma.sql`(${n.id}::text, ${n.memoryId}::text, ${n.revSeq}::integer)`));
  const rows = await db.$queryRaw<ReadValidationReport[]>(Prisma.sql`
    WITH wanted(node_id, memory_id, rev_seq) AS (VALUES ${values})
    SELECT w.node_id AS "nodeId", r.node_rev_seq AS "nodeRevSeq",
           r.validation_task_id AS "validationTaskId",
           r.validation_task_rev_seq AS "validationTaskRevSeq", r.outcome
    FROM wanted w
    JOIN LATERAL (
      SELECT node_rev_seq, validation_task_id, validation_task_rev_seq, outcome
      FROM node_content_validation_reports
      WHERE node_id = w.node_id AND memory_id = w.memory_id AND node_rev_seq <= w.rev_seq
      ORDER BY node_rev_seq DESC, reported_at DESC, id DESC
      LIMIT 1
    ) r ON TRUE
  `);
  return new Map(rows.map((row) => [row.nodeId, row]));
}

async function batchReadableTaskRefs(
  nodes: readonly ReadProjectionNode[],
  reports: ReadonlyMap<string, ReadValidationReport>,
  auth: AuthContext,
  memoryUrnOf: (memoryId: string) => Promise<string>,
): Promise<Map<string, string | null>> {
  const ids = [...new Set([
    ...nodes.map((n) => n.authoredByTask),
    ...[...reports.values()].map((r) => r.validationTaskId),
  ].filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const tasks = await db.node.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, loc: true, memoryId: true },
  });
  // Resolve all referenced memories through the shared bulk gate. Calling
  // canReadMemory once per task memory rebuilds the caller's access map for
  // every distinct memory in a large batch.
  const readable = await filterReadableMemoryIds(db, auth, tasks.map((task) => task.memoryId));
  const refs = await Promise.all(tasks.map(async (task) => [
    task.id,
    readable.has(task.memoryId) ? await nodeUrn(task.loc, task.memoryId, memoryUrnOf) : null,
  ] as const));
  return new Map(refs);
}

async function batchHumanNames(nodes: readonly ReadProjectionNode[], extraUserIds: readonly string[] = []): Promise<Map<string, string>> {
  // #1591: approvers render by handle too, from the same lookup; #1632 signers too.
  const ids = [...new Set([...nodes.flatMap((n) => [n.authoredByHuman, n.approvedBy, n.mintedBy]), ...extraUserIds].filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const users = await db.user.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, handle: true } });
  return new Map(users.filter((user) => !!user.handle).map((user) => [user.id, user.handle!]));
}

const SIGNATURE_LINE_ORDER = ['CURRENT', 'PENDING', 'EARLIER', 'CANCELLED'] as const;

/**
 * #1632 (cor:dmo:130:06) — `Signatures:` for an MCP node read. Current and
 * pending signers are named (user URN by handle, the revision, the passkey
 * label only, JSON-escaped so a label can never forge another line); earlier
 * and cancelled ones are counted. Integrity problems are reported, never shown
 * as signatures (#9853).
 */
async function renderSignatureLine(status: NodeSignatureStatusView, names?: ReadonlyMap<string, string>): Promise<string> {
  if (status.signatures.length === 0 && status.integrityProblems === 0) return 'Signatures: none';
  const missing = status.signatures.map((sig) => sig.signerId).filter((id) => !names?.has(id));
  const looked = missing.length
    ? new Map((await db.user.findMany({ where: { id: { in: missing }, deletedAt: null }, select: { id: true, handle: true } }))
      .filter((u) => !!u.handle).map((u) => [u.id, u.handle!]))
    : new Map<string, string>();
  const who = (id: string) => {
    const handle = names?.get(id) ?? looked.get(id);
    return (handle ? userUrn(handle) : null) ?? 'a former user';
  };
  const parts: string[] = [];
  for (const state of SIGNATURE_LINE_ORDER) {
    const sigs = status.signatures.filter((sig) => sig.state === state);
    if (sigs.length === 0) continue;
    const label = state.toLowerCase();
    parts.push(state === 'CURRENT' || state === 'PENDING'
      ? `${sigs.length} ${label} — ${sigs.map((sig) => `${who(sig.signerId)} (r${sig.revision}, ${JSON.stringify(sig.passkeyLabel)}${state === 'PENDING' ? ', first passkey in its window' : ''})`).join(', ')}`
      : `${sigs.length} ${label}`);
  }
  const problems = status.integrityProblems
    ? `${status.integrityProblems} integrity problem${status.integrityProblems === 1 ? '' : 's'} (a signature record failed verification)`
    : '';
  return `Signatures: ${[parts.join('; '), problems].filter(Boolean).join(' · ')}`;
}

// #1610: one name/URN lookup per actor per batch read.
const actorLabelCaches = new WeakMap<object, Map<string, Promise<string | null>>>();

/** The Worker (else Agent) behind a write, as `name (urn)`; '' when none. */
async function actorMetaLine(
  client: typeof db,
  label: string,
  workerId: string | null,
  agentId: string | null,
  batch?: object,
): Promise<string> {
  const kind = workerId ? 'worker' : agentId ? 'agent' : null;
  const id = workerId ?? agentId;
  if (!kind || !id) return '';
  const lookup = async (): Promise<string | null> => {
    if (kind === 'worker') {
      const w = await client.worker.findUnique({
        where: { id }, select: { name: true, slug: true, app: { select: { urn: true } } },
      });
      if (!w) return null;
      let urn: string | null = null;
      try { urn = composeWorkerUrn(normalizeUrnForLookup(w.app.urn), w.slug); } catch { urn = null; }
      return urn ? `${w.name} (${urn})` : w.name;
    }
    const a = await client.agent.findUnique({ where: { id }, select: { name: true, urn: true } });
    return a ? `${a.name} (${safeCanonicalUrn('agent', a.urn)})` : null;
  };
  let pending: Promise<string | null>;
  if (batch) {
    let cache = actorLabelCaches.get(batch);
    if (!cache) { cache = new Map(); actorLabelCaches.set(batch, cache); }
    pending = cache.get(`${kind}:${id}`) ?? lookup();
    cache.set(`${kind}:${id}`, pending);
  } else {
    pending = lookup();
  }
  const name = await pending;
  return name ? `${label}: ${kind} ${name}` : '';
}

/** #1885 — an inherited node's read row: its content, without its edges or the people behind it. */
function inheritedReadRow<T extends ReadProjectionNode>(node: T): T {
  return {
    ...node,
    outgoingEdges: [],
    incomingEdges: [],
    createdByWorkerId: null,
    createdByAgentId: null,
    updatedByWorkerId: null,
    updatedByAgentId: null,
    authorshipKind: null,
    authoredByTask: null,
    authoredByRevision: null,
    authoredByHuman: null,
    authoredAt: null,
    approvedBy: null,
    approvedByInfo: null,
    mintedBy: null,
    mintedByInfo: null,
  };
}

/**
 * #1647 (cor:api:140:03, concealment): a readable near endpoint does not authorize returning an unreadable far
 * endpoint's metadata. Drops edges whose far node lives in another memory the caller cannot read, as if absent, so the
 * far URN, id and name never reach the projection. Same-memory edges ride the near node's own gate.
 */
async function concealUnreadableEdgeEnds<N extends {
  memoryId: string;
  outgoingEdges: Array<{ target: { memoryId: string } }>;
  incomingEdges: Array<{ source: { memoryId: string } }>;
}>(auth: AuthContext | undefined, node: N): Promise<N> {
  const foreign = new Set<string>();
  for (const e of node.outgoingEdges) if (e.target.memoryId !== node.memoryId) foreign.add(e.target.memoryId);
  for (const e of node.incomingEdges) if (e.source.memoryId !== node.memoryId) foreign.add(e.source.memoryId);
  if (foreign.size === 0) return node;
  const readable = new Set<string>();
  if (auth) {
    for (const id of foreign) if (await canReadMemory(db, auth, id, EXPLICIT_REF)) readable.add(id);
  }
  const ok = (memoryId: string) => memoryId === node.memoryId || readable.has(memoryId);
  return {
    ...node,
    outgoingEdges: node.outgoingEdges.filter((e) => ok(e.target.memoryId)),
    incomingEdges: node.incomingEdges.filter((e) => ok(e.source.memoryId)),
  };
}

/**
 * #2610 — the register entry's action address (`hrn:action:<root>:<agent-slug>:<code>`)
 * for the read projection's `Action URN:` line. Non-null only for a `register:<code>`
 * node in a LIVE Agent's system memory — the MCP spelling of Node.actionUrn
 * (resolvers.types.ts), computed the same way so the two surfaces cannot drift:
 * null, never a throw, on an unemittable stored code atom; a `register:` loc in a
 * memory no live Agent holds names no entry.
 *
 * #2972 — entry-hood is `registerEntryCode`'s call: a NESTED `register:a:b` loc
 * is a writable namespace loc, not an entry, and nulls QUIETLY (no repair warn);
 * the null-and-log below is reachable only for a single-atom code the emitter
 * refuses.
 */
async function actionUrnForRegisterLoc(loc: string, memoryId: string): Promise<string | null> {
  const code = registerEntryCode(loc);
  if (code === null) return null;
  const agent = await db.agent.findFirst({
    where: { systemMemoryId: memoryId, deletedAt: null },
    select: { urn: true },
  });
  if (!agent) return null;
  try {
    return emitActionUrnV2(agent.urn, code);
  } catch (err) {
    console.warn(
      `[Action URN:] register code ${JSON.stringify(code)} in memory ${memoryId} is not ` +
        'emittable as an action URN; omitting the line. The STORED loc needs repair — this is ' +
        'not a malformed caller request:',
      err,
    );
    return null;
  }
}

/**
 * The batch's action addresses in ONE grouped agent lookup (the per-node
 * `Action URN:` line needs the holding Agent's urn, and cor:api:040:01 makes the
 * batch projection the same thing as the single read's). Absent from the map —
 * like a null from the single-node path — means no line. #2972: only
 * single-atom `register:` locs are entries (`registerEntryCode`); a nested
 * `register:a:b` loc never reaches the emitter, so it can neither warn nor
 * render a line.
 */
async function batchActionUrns(nodes: ReadProjectionNode[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const entries = nodes.filter((n) => registerEntryCode(n.loc) !== null);
  if (!entries.length) return out;
  const agents = await db.agent.findMany({
    where: { systemMemoryId: { in: [...new Set(entries.map((n) => n.memoryId))] }, deletedAt: null },
    select: { systemMemoryId: true, urn: true },
  });
  const urnByMemory = new Map(agents.map((a) => [a.systemMemoryId as string, a.urn]));
  for (const n of entries) {
    const agentUrn = urnByMemory.get(n.memoryId);
    if (!agentUrn) continue; // no live Agent holds this memory — no line
    const code = registerEntryCode(n.loc) as string; // non-null: the filter kept only entries
    try {
      out.set(n.id, emitActionUrnV2(agentUrn, code));
    } catch {
      out.set(n.id, null); // unemittable stored code — same posture as the single read
    }
  }
  return out;
}

async function renderNodeReadProjection(
  node: ReadProjectionNode,
  scope: 'content' | 'abstract' | 'all',
  opts: {
    locked?: boolean;
    encryptedMemory?: boolean;
    auth?: AuthContext;
    batch?: {
      reports: ReadonlyMap<string, ReadValidationReport>;
      taskRefs: ReadonlyMap<string, string | null>;
      humanNames: ReadonlyMap<string, string>;
      /** #1609 — comment counts per node, one grouped query for the batch. */
      feedback: ReadonlyMap<string, CommentCounts>;
      /** #1632 — signature status per node, one batched load. */
      signatures?: ReadonlyMap<string, NodeSignatureStatusView>;
      /** #2610 — action addresses per node, one batched agent lookup; absent = no line. */
      actionUrns?: ReadonlyMap<string, string | null>;
    };
    memoryUrnOf?: (memoryId: string) => Promise<string>;
  } = {},
): Promise<string> {
  // #1885 (cor:dmo:050:14) — a node read through a child's effective system
  // memory is the base tenant's: its content is served, its edges and the
  // people and records behind it are not (resolvers.inheritedNode.ts has the
  // GraphQL side and the reasons). Stripped here, once, before any line reads them.
  const inheritedFrom = (node as { inheritedFrom?: InheritedFrom }).inheritedFrom;
  if (inheritedFrom) {
    // #1893 — its edges come through the child it was read through, resolved
    // like bare-loc links; never the base's raw edges.
    const via = inheritedFrom.via;
    const canRead = (memoryId: string) =>
      opts.auth ? canReadMemory(db, opts.auth, memoryId, EXPLICIT_REF) : Promise.resolve(false);
    const resolve = (direction: 'out' | 'in') => via
      ? resolveInheritedEdges(db, { nodeId: node.id, via, direction, canReadMemory: canRead, endpointMetadataOnly: true })
      : Promise.resolve([]);
    const [outgoing, incoming] = await Promise.all([resolve('out'), resolve('in')]);
    node = {
      ...inheritedReadRow(node),
      outgoingEdges: outgoing.map(({ edge, endpoint }) => ({ ...edge, target: endpoint })),
      incomingEdges: incoming.map(({ edge, endpoint }) => ({ ...edge, source: endpoint })),
    } as typeof node;
  }
  node = await concealUnreadableEdgeEnds(opts.auth, node);
  const revision = node.revSeq;
  const memoryUrnOf = opts.memoryUrnOf ?? memoizedMemoryUrnLookup();
  const { urn, fellBack: urnFellBack } = await nodeUrnResult(node.loc, node.memoryId, memoryUrnOf);
  const outgoingLines = await Promise.all(
    node.outgoingEdges.map(async (e) => {
      const targetUrn = await nodeUrn(e.target.loc, e.target.memoryId, memoryUrnOf);
      // #322: surface the target's stable PK alongside the URN so callers can
      // reference it by id (immutable across move/rename) instead of the URN.
      return `  - ${targetUrn} (id: ${e.target.id}) (${e.target.name}) — ${e.name ?? e.loc}${governedKindAnnotation(e.governedKind)}`;
    }),
  );
  const incomingLines = await Promise.all(
    node.incomingEdges.map(async (e) => {
      const sourceUrn = await nodeUrn(e.source.loc, e.source.memoryId, memoryUrnOf);
      return `  - ${sourceUrn} (id: ${e.source.id}) (${e.source.name}) — ${e.name ?? e.loc}${governedKindAnnotation(e.governedKind)}`;
    }),
  );

  const hasContent = !!(node.content && node.content.length > 0);
  const hasAbstract = !!(node.abstract && node.abstract.length > 0);
  const isFallback = scope === 'content' && !hasContent && hasAbstract;

  // Spec 032 FR-010 — `Source: abstract-stale` marker. Encryption gate:
  // since spec 041 PR-2 the MCP read path decrypts when the session holds
  // the key — mcpDecryptOrMark flips the projection's isEncrypted to false
  // on success, so the predicate below runs on PLAINTEXT for unlocked
  // memories and is (correctly) skipped only while locked. Scope gate:
  // the marker only fires under scopes that surface the abstract (`abstract` /
  // `all`); the default `content` scope omits it (the abstract isn't in the
  // response).
  //
  // #1128 removed the `abstractOriginHash != null` guard this comment used to
  // describe as load-bearing. It WAS, when every row predated spec 032; it had
  // since become the reason a never-fingerprinted abstract could not be
  // flagged. The predicate now lives in isAbstractUnverified — ONE home for
  // all four surfaces — and arms on a missing fingerprint as well as a
  // disagreeing one. The encryption and scope gates stay here: they are
  // properties of this call, not of the node.
  const shouldCheckStale = scope === 'abstract' || scope === 'all';
  const includeStaleMarker =
    shouldCheckStale && !node.memory.isEncrypted && isAbstractUnverified(node, node.contentPresent);

  // #881: the node's portal URL, ready to hand a human. Emitted so no agent
  // ever *constructs* one — constructing means guessing which URN spelling
  // /app/u/<urn> resolves, and an agent that has been reading `::` forms all
  // session guesses wrong (see src/lib/portalUrl.ts). Omitted when no portal
  // origin is configured — and when the URN is the best-effort fallback for a
  // corrupt stored loc, since that string is unvalidated and could carry URL
  // structure (`/`, `?`, `#`) into the href. Same rule as a malformed base
  // URL: a link that points somewhere other than the node is worse than none.
  const portalUrl = urnFellBack ? null : portalUrlForUrn(urn);

  // #2610 — the entry's action address (`hrn:action:<root>:<agent-slug>:<code>`),
  // when this row IS one: a `register:<code>` node in a live Agent's system
  // memory. Address-class like the URL line (#1885 pin: content, served on an
  // inherited read too, keyed on the row's own — the holding base Agent's —
  // memory). Batched callers hand it in one grouped lookup (cor:api:040:01).
  const actionUrn = opts.batch
    ? (opts.batch.actionUrns?.get(node.id) ?? null)
    : await actionUrnForRegisterLoc(node.loc, node.memoryId);

  // #1326: a source node may be readable while its author/validator task
  // lives in another tenant's memory. Resolve task addresses only after that
  // memory's own content gate; never print the stored task id as a fallback.
  const readableTask = async (id: string | null): Promise<string | null> => {
    if (!id || !opts.auth) return null;
    if (opts.batch) return opts.batch.taskRefs.get(id) ?? null;
    const task = await db.node.findUnique({
      where: { id }, select: { loc: true, memoryId: true, deletedAt: true },
    });
    if (!task || task.deletedAt || !(await canReadMemory(db, opts.auth, task.memoryId))) return null;
    return nodeUrn(task.loc, task.memoryId, memoryUrnOf);
  };
  let authorshipLine = '';
  if (node.authorshipKind === 'TASK') {
    const taskRef = await readableTask(node.authoredByTask);
    authorshipLine = taskRef && node.authoredByRevision != null
      ? `Authored by task: ${taskRef} @ revision ${node.authoredByRevision}`
      : 'Authored by task: restricted';
  } else if (node.authorshipKind === 'HUMAN' && node.authoredByHuman) {
    const handle = opts.batch
      ? opts.batch.humanNames.get(node.authoredByHuman)
      : (await db.user.findFirst({
          where: { id: node.authoredByHuman, deletedAt: null }, select: { handle: true },
        }))?.handle;
    authorshipLine = handle ? `Authored by human: ${userUrn(handle)}` : 'Authored by human';
  }
  const report = opts.batch
    ? (opts.batch.reports.get(node.id) ?? null)
    : await db.nodeContentValidationReport.findFirst({
        where: { nodeId: node.id, memoryId: node.memoryId, nodeRevSeq: { lte: revision } },
        orderBy: [{ nodeRevSeq: 'desc' }, { reportedAt: 'desc' }, { id: 'desc' }],
      });
  const validationState = nodeContentValidationState(revision, report);
  const validatorRef = report ? await readableTask(report.validationTaskId) : null;
  const validationLine = inheritedFrom
    // The base's report names its validator and records: state only (P2-2).
    ? `Validation: ${validationState.toLowerCase()}`
    : report
    ? `Validation: ${validationState.toLowerCase()} (node revision ${report.nodeRevSeq}; validator ${validatorRef ? `${validatorRef} @ revision ${report.validationTaskRevSeq}` : 'restricted'})`
    : 'Validation: unvalidated';

  // #1591: the approval line. Approver by handle when a user is known, else
  // the stored principal info.
  let approvalLine = opts.encryptedMemory ? 'Approval: not applicable (encrypted memory)' : `Approval: not approved (r${revision})`;
  if (!opts.encryptedMemory && node.approvedRevNo != null && node.approvedAt && node.approvalHash !== null) {
    const handle = node.approvedBy
      ? (opts.batch
        ? opts.batch.humanNames.get(node.approvedBy)
        : (await db.user.findFirst({ where: { id: node.approvedBy, deletedAt: null }, select: { handle: true } }))?.handle)
      : null;
    // userUrn is null for a grandfathered, non-URN-legal handle (@copilot, PR #1592).
    const approver = (handle ? userUrn(handle) : null) ?? node.approvedByInfo ?? 'a former user';
    const record = `r${node.approvedRevNo} by ${approver} at ${node.approvedAt.toISOString()}`;
    // #1611: valid until the hashed text changes; metadata-only revisions keep it.
    approvalLine = node.contentRevSeq <= node.approvedRevNo
      ? `Approval: approved ${record}${node.approvedRevNo === revision ? '' : ` (text unchanged through r${revision})`}`
      : `Approval: not approved (r${revision}; last approved ${record})`;
  }

  if (inheritedFrom) {
    approvalLine = node.approvedRevNo != null && node.approvalHash !== null && node.contentRevSeq <= node.approvedRevNo
      ? `Approval: approved r${node.approvedRevNo}`
      : `Approval: not approved (r${revision})`;
  }

  // #1591: the mint line. A node backfilled as minted has no minted revision.
  let mintLine = opts.encryptedMemory ? 'Minted: not applicable (encrypted memory)' : 'Minted: no';
  if (!opts.encryptedMemory && node.mintedAt) {
    const at = node.mintedAt.toISOString();
    if (node.mintedRevNo == null) {
      mintLine = `Minted: at ${at} (backfilled)`;
    } else {
      const handle = node.mintedBy
        ? (opts.batch
          ? opts.batch.humanNames.get(node.mintedBy)
          : (await db.user.findFirst({ where: { id: node.mintedBy, deletedAt: null }, select: { handle: true } }))?.handle)
        : null;
      const minter = (handle ? userUrn(handle) : null) ?? node.mintedByInfo ?? 'a former user';
      mintLine = `Minted: r${node.mintedRevNo} at ${at} by ${minter}`;
    }
  }
  if (inheritedFrom) mintLine = node.mintedAt ? (node.mintedRevNo == null ? 'Minted: yes' : `Minted: r${node.mintedRevNo}`) : 'Minted: no';

  // #1632 (cor:dmo:130:06): the signatures line, beside Approval. An encrypted
  // node loads nothing (no hash-dependent work there).
  const signatureLine = inheritedFrom || !signingSurfacePolicy().signing
    ? ''
    : opts.encryptedMemory
    ? 'Signatures: not applicable (encrypted memory)'
    : renderSignatureLine(
      opts.batch?.signatures?.get(node.id) ?? (await loadSignatureStatuses(db, [node.id])).get(node.id)!,
      opts.batch?.humanNames,
    );

  // #1609: the unresolved-feedback cue (cor:dmo:110:07), so an agent reading a
  // node knows a discussion exists beside it without being told to look. The
  // counts are metadata (no comment text), and only live comments count — the
  // same predicate as Node.commentSummary. Omitted when there are none. A
  // comment read through the generic node tools says what it is instead.
  let feedbackLine = '';
  if (inheritedFrom) {
    // The base's comment threads are the base tenant's; none are shown.
  } else if (node.nodeType === COMMENT_NODE_TYPE) {
    feedbackLine = 'Feedback: this node is a comment — reader feedback on another node, not authoritative content (read it with hadron_get_comment)';
  } else {
    const counts = opts.batch ? opts.batch.feedback.get(node.id) : (await openThreadCounts(db, [node.id])).get(node.id);
    if (counts && counts.comments > 0) {
      feedbackLine = `Feedback: ${counts.openThreads} open thread${counts.openThreads === 1 ? '' : 's'}, `
        + `${counts.resolvedThreads} resolved, ${counts.comments} comment${counts.comments === 1 ? '' : 's'} — `
        + 'reader feedback beside this node, not part of its content (read with hadron_list_comments)';
    }
  }

  // #1610: the Worker (else the Agent) behind the node's creation and its
  // last authored edit. Omitted when none was; the user is not repeated here.
  const createdByLine = await actorMetaLine(db, 'Created by', node.createdByWorkerId, node.createdByAgentId, opts.batch);
  const updatedByLine = await actorMetaLine(db, 'Last edited by', node.updatedByWorkerId, node.updatedByAgentId, opts.batch);

  // #186: surface nodeType so callers can tell `parent` from `info`.
  const meta = [
    `**${node.name}**`,
    urn,
    // #322: the node's stable PK. URNs are mutable (move/rename changes the
    // loc), so edges/replies created against a URN break when it changes;
    // the id never does. Surfaced so callers can prefer it as the reference.
    `ID: ${node.id}`,
    `Revision: ${revision}`,
    portalUrl ? `URL: ${portalUrl}` : '',
    actionUrn ? `Action URN: ${actionUrn}` : '',
    inheritedFrom
      ? `Inherited from: ${emitEntityUrnV2('agent', inheritedFrom.agentUrn)} (a base of the Agent read; its edges and records are not shown)`
      : '',
    authorshipLine,
    validationLine,
    approvalLine,
    await signatureLine,
    mintLine,
    feedbackLine,
    createdByLine,
    updatedByLine,
    node.description ? `> ${node.description}` : '',
    `Type: ${node.nodeType}`,
    // #1201 (@codex P2, PR #1203). Without these a governed node reads as an
    // ordinary one, so a caller cannot tell which door applies until a write
    // fails — the field would not round-trip through the primary agent API it
    // is written from. Omitted when unset, like every other optional meta line;
    // `Runnable:` only when true, matching the frontmatter convention that
    // false and null are one state.
    node.role ? `Role: ${node.role}` : '',
    node.isRunnable ? 'Runnable: true' : '',
    opts.locked
      ? 'Locked: encrypted memory — call hadron_unlock_memory to read/write its content (spec 041)'
      : '',
    isFallback ? 'Source: abstract-fallback' : '',
    includeStaleMarker ? 'Source: abstract-stale' : '',
    node.tags.length ? `Tags: ${node.tags.join(', ')}` : '',
    node.seq !== null ? `Seq: ${node.seq}` : '',
    node.properties ? `Properties: ${JSON.stringify(node.properties)}` : '',
    node.data ? `Data: ${JSON.stringify(node.data)}` : '',
    outgoingLines.length ? `Related:\n${outgoingLines.join('\n')}` : '',
    incomingLines.length ? `Referenced by:\n${incomingLines.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  // Response matrix: spec cor:api:020:03.
  if (scope === 'abstract') {
    // meta + abstract (no `---`, no body). Meta alone when abstract null.
    return hasAbstract ? `${meta}\n\n${node.abstract}` : meta;
  }
  if (scope === 'all') {
    //   both present  → meta + abstract + --- + content
    //   only abstract → meta + abstract  (no `---`)
    //   only content  → meta + --- + content
    //   both null     → meta alone
    const parts: string[] = [meta];
    if (hasAbstract) parts.push(node.abstract!);
    if (hasContent) parts.push(`---\n\n${node.content}`);
    return parts.join('\n\n');
  }
  // scope === 'content' (default) — body is content, else abstract (fallback),
  // else empty (byte-identical pre-spec when content AND abstract are null).
  const body = hasContent ? node.content! : isFallback ? node.abstract! : '';
  return meta + '\n\n---\n\n' + body;
}

// ---------------------------------------------------------------------------
// MCP Server factory — one McpServer per transport session
// ---------------------------------------------------------------------------


/**
 * #1057 — the ONE statement of what an edge's `description` is for. `name` is
 * the label every agent read renders ("Related:" / "Referenced by:" on node
 * reads, per #721); `description` is carried for API consumers and is NOT
 * shown there. Undocumented, the field that is called "description" is where
 * an agent puts the text it wants seen, and it vanishes.
 */
export const EDGE_DESCRIPTION_DOC =
  'Longer gloss carried for API consumers (GraphQL, `hadron edge list --json`). NOT rendered on node reads: '
  + 'Related:/Referenced by: show the edge `name`, so put the label you want seen in `name`.';

/** The stored fields an edge-update receipt reports. */
export interface EdgeUpdateReadback {
  loc: string;
  name: string | null;
  description?: string | null;
  isRunnable?: boolean | null;
  priority?: number | null;
  condition?: unknown;
  data?: unknown;
}

const clip = (text: string, max = 80): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * #1057 — describe what an edge update changed: one entry per field the
 * caller PASSED (undefined means left alone), each showing the value the
 * store now holds. Structured fields report set or cleared rather than
 * their contents.
 */
export function describeEdgeUpdate(
  passed: { name?: unknown; loc?: unknown; description?: unknown; isRunnable?: unknown; priority?: unknown; condition?: unknown; data?: unknown },
  e: EdgeUpdateReadback,
): string {
  const parts: string[] = [];
  const text = (field: string, value: string | null | undefined) =>
    parts.push(value == null ? `${field} cleared` : `${field} → "${clip(value)}"`);
  if (passed.name !== undefined) text('name', e.name);
  if (passed.loc !== undefined) text('loc', e.loc);
  if (passed.description !== undefined) text('description', e.description);
  if (passed.isRunnable !== undefined) parts.push(`isRunnable → ${e.isRunnable ?? false}`);
  if (passed.priority !== undefined) parts.push(`priority → ${e.priority ?? 'unset'}`);
  if (passed.condition !== undefined) parts.push(e.condition == null ? 'condition cleared' : 'condition set');
  if (passed.data !== undefined) parts.push(e.data == null ? 'data cleared' : 'data set');
  return parts.length ? parts.join('; ') : 'no fields were passed, so nothing changed';
}

export function createMcpServerInstance(
  auth: AuthContext,
  getSessionId: () => string | undefined,
  cachedAppResolution: AppResolution | null,
  opts: {
    isReconnect?: boolean;
    clientKey?: string | null;
    /** #1012 — an already-re-authorized active-memory URN to start from. */
    restoredMemoryUrn?: string;
    /** Spec 049 Phase 1 — an already-re-authorized explicit active-org selection to start from. */
    restoredOrgId?: string;
    /** Spec 049 Phase 3 — an already-re-authorized active-scope selection to start from. */
    restoredScopeId?: string;
  } = {},
): McpServer {
  /**
   * #1012 — this client instance's stable id (`X-Hadron-Client-Id`), or null
   * when the client did not send one. Null means "do not persist": that client
   * keeps the pre-#1012 in-memory-only behaviour, so opting out costs nothing.
   */
  const clientKey = opts.clientKey ?? null;

  /**
   * #1009 — this MCP session replaced one the client had already been using
   * (it presented a session id this server did not know and re-initialized).
   *
   * Every piece of per-session state below was reset by that, and the client
   * does not surface the reconnect to the agent driving it. So a refusal that
   * follows one is not the same event as a refusal on a genuinely fresh
   * session, and saying which it is turns "this tool is broken" into "say that
   * one thing again".
   */
  const isReconnect = opts.isReconnect ?? false;

  /**
   * Appended to per-session-state refusals so the cause is never guessed at.
   *
   * Phrased conditionally ("any … you had selected") because the detection
   * behind it is a deliberate over-approximation — see `isLikelyReconnect`.
   * Under a false positive this still says nothing untrue to a caller who had
   * no selection to lose.
   */
  const RECONNECT_NOTE =
    ' Note: this MCP connection was re-established (the previous session ended, ' +
    'typically because the server restarted). That RESET any active App or active ' +
    'memory you had selected — selections live only for the current connection, ' +
    'and clients re-connect without mentioning it. This is not a client ' +
    'limitation and nothing you did is wrong: re-select and continue.';
  const server = new McpServer(
    { name: 'hadron', version: HADRON_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  /**
   * "Worker Name (session <id>)" for each session, in order — for refusals and
   * receipts that must let the caller recognise which binding is theirs.
   */
  const describeBoundSessions = async (sessionIds: readonly string[]): Promise<string> => {
    const rows = await db.session.findMany({
      where: { id: { in: [...sessionIds] } },
      select: { id: true, worker: { select: { name: true } }, agent: { select: { name: true } } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return sessionIds
      .map((id) => {
        const r = byId.get(id);
        const who = r?.worker?.name ?? (r?.agent?.name ? `agent ${r.agent.name}` : r ? 'no worker (plain session)' : 'unknown');
        return `${who} (session ${id})`;
      })
      .join(', ');
  };

  /**
   * #1701 — the start-session receipt's warning when this bind left the
   * connection bound to MORE than one actor. Best-effort: it runs after the
   * session committed, so a failure costs the note, never the session id.
   */
  const sharedConnectionWarning = async (mcpSessionId: string, startedId: string): Promise<string> => {
    try {
      const live = await liveConnectionBindings(mcpSessionId, auth);
      if (!connectionIsAmbiguous(mcpSessionId, live)) return '';
      const others = live.filter((b) => b.sessionId !== startedId).map((b) => b.sessionId);
      const already = others.length
        ? `was already bound to ${await describeBoundSessions(others)}`
        : 'has carried other callers whose sessions have since ended';
      return (
        `\n\n⚠ SHARED CONNECTION: this MCP connection ${already}. ` +
        'Your host is carrying more than one chat session over it, so it can no longer tell which of them sends ' +
        `a request. Pass session: "${startedId}" on EVERY write (node, edge, comment, task and object tools, ` +
        'team chat, worklog). A write without it is refused SESSION_AMBIGUOUS rather than credited to the wrong ' +
        'worker (#1701). Reads need nothing.'
      );
    } catch {
      return '';
    }
  };

  // ── #1701: the caller-session gate on every writing tool ─────────────────
  //
  // The connection binding (DAC) credits writes to the worker a connection is
  // bound to. A host that multiplexes several chat sessions over ONE
  // connection breaks that silently: every chat session's writes went to
  // whichever worker bound last. So every tool that can write takes an
  // optional `session` — the caller saying who it is, validated by the same
  // shared gate as the X-Hadron-Session header — and, on a connection bound
  // to more than one actor, a writing call that does not say is REFUSED
  // instead of guessed at.
  //
  // FAIL-CLOSED by construction: a tool is gated unless it is listed below as
  // one that writes nothing on the caller's behalf. A new tool therefore gets
  // the gate without anyone remembering to add it; forgetting the other way
  // only costs an ambiguous caller one `session` argument.
  const ACTOR_NEUTRAL_TOOLS = new Set([
    // Reads and searches.
    'hadron_search', 'hadron_list_memories', 'hadron_server_info', 'hadron_list_apps', 'hadron_list_scopes',
    'hadron_scope_explain', 'hadron_list_channels', 'hadron_register_list', 'hadron_find_nodes', 'hadron_get_node',
    'hadron_get_nodes', 'hadron_get_next_node', 'hadron_list_nodes', 'hadron_get_object', 'hadron_find_objects',
    'hadron_get_run', 'hadron_whoami', 'hadron_channel_read', 'hadron_team_chat_read', 'hadron_team_chat_search', 'hadron_team_attention',
    'hadron_team_attention_page', 'hadron_list_workers', 'hadron_get_worker', 'hadron_team_work_items',
    'hadron_list_comments', 'hadron_get_comment', 'hadron_team_chat_mark_read',
    'hadron_list_recovery_nodes', 'hadron_list_recovery_edges', 'hadron_get_recovery_node',
    // #1705 — agent-task reads (each takes its own optional session).
    'hadron_task_get', 'hadron_task_list', 'hadron_team_events',
    // #1706 — availability read (its own optional session).
    'hadron_team_availability',
    // #1707 — the team roster read (its own optional session).
    'hadron_team_roster',
    // #1926 — the stall schedule read (its own optional session).
    'hadron_stall_schedule_get',
    // #1747 — ticker reads (each takes its own optional session; wake settings enforces the write rule itself).
    'hadron_ticker_list', 'hadron_worker_wake_settings', 'hadron_due_wakes', 'hadron_delivery_settings_get',
    // #2024 — the Agent ticker-template list (a read through the Agent's own gate).
    'hadron_agent_ticker_template_list',
    // #2022 — the stop-signal list (its own optional session).
    'hadron_stop_signal_list',
    // Per-connection selections and key handling: nothing authored.
    'hadron_set_active_memory', 'hadron_set_active_app', 'hadron_set_active_org', 'hadron_set_active_scope',
    'hadron_unlock_memory', 'hadron_lock_memory',
    // Binding itself: it is how a caller SAYS who it is.
    'hadron_start_session',
    // #1956 — recovering a binding is binding: it is how a fresh context says who it is.
    'hadron_resume_session',
  ]);
  /** Tools whose own required argument names the caller's session under another name. */
  const SESSION_ARGUMENT: Record<string, string> = { hadron_end_session: 'id' };
  /**
   * #1697 — tools with an explicit "write as the HUMAN" argument. `true`
   * there (with no session named) answers the ambiguity question itself: the
   * caller chose nobody, so the call proceeds with the actor cleared rather
   * than refused SESSION_AMBIGUOUS on a shared connection. It picks no
   * worker and changes no credential or session scope (`auth` is untouched).
   * A session named alongside it is settled as usual, and the tool refuses
   * the conflict.
   */
  const EXPLICIT_HUMAN_ARGUMENT: Record<string, string> = { hadron_channel_post: 'asMe', hadron_team_chat_post: 'asMe' };

  /**
   * Settle the actor for one tool call (#1701). A named session that validates
   * becomes the actor; a named session that does not is refused when the
   * argument is the gate's own, and left to the tool when the tool defines it
   * (its handler already refuses an unusable session) — either way the call
   * never writes as the connection's worker. With no session named, an
   * ambiguous connection refuses. Returns a refusal, or null to proceed.
   */
  const settleCallerSession = async (
    toolName: string,
    named: unknown,
    toolOwnsArgument: boolean,
    onBound?: (id: string) => void,
  ): Promise<{ isError: true; content: Array<{ type: 'text'; text: string }> } | null> => {
    if (typeof named === 'string' && named.length > 0) {
      const valid = await validateSessionBinding(db, auth, named);
      if (valid) {
        onBound?.(valid.sessionId);
        publishActor(valid.actor);
        return null;
      }
      publishActor({ workerId: null, agentId: null });
      if (toolOwnsArgument) return null;
      return {
        isError: true as const,
        content: [{
          type: 'text' as const,
          text:
            `[session_not_bound] ${toolName}: session "${named}" is not one of your open sessions that can ` +
            'attribute a write (it may have ended, gone dormant, or belong to someone else). Nothing was ' +
            'written. Check hadron_whoami for your open sessions, or omit session to write as yourself on a ' +
            'connection that is not shared.',
        }],
      };
    }
    const ambiguous = currentActorAmbiguity();
    if (!ambiguous) return null;
    return {
      isError: true as const,
      content: [{
        type: 'text' as const,
        text:
          `[session_ambiguous] ${toolName}: this MCP connection carries live sessions for ` +
          `${await describeBoundSessions(ambiguous)}, and has carried more than one caller (a chat session ` +
          'whose own session has ended may still be calling). Your host is sharing one connection between ' +
          'several chat sessions, so the server cannot tell which of them sent this call, and will not guess. Nothing ' +
          'was written. Pass session: "<your session id>" (hadron_whoami lists yours; it is the id ' +
          'hadron_start_session returned to YOU), or end the sessions that are no longer in use (#1701).',
      }],
    };
  };

  {
    type ToolCallback = (args: unknown, extra: unknown) => unknown;
    const sdkRegisterTool = server.tool.bind(server) as (...args: unknown[]) => unknown;
    // Every registered handler (including reads and caller-session settlement)
    // gets this outer boundary before the SDK can stringify a database fault.
    const registerTool = (...args: unknown[]) => {
      const cbIndex = args.length - 1;
      args[cbIndex] = withToolErrorBoundary(args[0] as string, args[cbIndex] as ToolCallback);
      return sdkRegisterTool(...args);
    };
    (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (...args: unknown[]) => {
      const name = args[0] as string;
      if (ACTOR_NEUTRAL_TOOLS.has(name)) {
        const index = args.length - 1;
        const callback = args[index] as ToolCallback;
        const shape = args.find((a, i) => i > 0 && i < index && typeof a === 'object' && a !== null) as Record<string, unknown> | undefined;
        args[index] = async (input: unknown, extra: unknown) => {
          // Preserve the neutral callback's original actor scope. Only the optional finalizer gets a child scope.
          const result = await callback(input, extra);
          const named = shape && 'session' in shape ? (input as Record<string, unknown> | undefined)?.session : undefined;
          return runInChildActorScope(() => appendDeliveryPending(result, {
            ...scopeCtx(), ...mcpRequestSessionContext(auth), appKeyId: auth.appKeyId ?? undefined,
            impersonation: auth.impersonation ?? undefined,
          }, typeof named === 'string' && named.length > 0 ? named : undefined));
        };
        return registerTool(...args);
      }
      const cbIndex = args.length - 1;
      const callback = args[cbIndex] as ToolCallback;
      // The parameter shape is the first plain object after the name (a
      // description string may precede it; annotations may follow it).
      const shapeIndex = args.findIndex((a, i) => i > 0 && i < cbIndex && typeof a === 'object' && a !== null);
      if (shapeIndex < 0) {
        throw new Error(`#1701: tool ${name} is gated as a writer but declares no parameter shape to carry session`);
      }
      const argumentName = SESSION_ARGUMENT[name] ?? 'session';
      const shape = args[shapeIndex] as Record<string, unknown>;
      const toolOwnsArgument = argumentName in shape;
      if (!toolOwnsArgument) {
        args[shapeIndex] = withSessionField(shape);
      }
      // Each call settles its actor in a scope of its OWN (PR #1702 review,
      // Codex P1): the SDK dispatches a JSON-RPC batch's calls concurrently
      // under the POST's one holder, so publishing into that holder let one
      // call's named session stamp a sibling's write, or clear the ambiguity
      // an unnamed sibling was about to be refused on.
      args[cbIndex] = (input: unknown, extra: unknown) =>
        runInChildActorScope(async () => {
          // #2176: this tool call's own validated user (auth is the connection's, refreshed per request),
          // published in the call's own scope like its Worker, so a batch sibling cannot overwrite it.
          publishUser(auth.userId ?? null);
          const named = (input as Record<string, unknown> | undefined)?.[argumentName];
          const humanArgument = EXPLICIT_HUMAN_ARGUMENT[name];
          const asHuman = humanArgument !== undefined && (input as Record<string, unknown> | undefined)?.[humanArgument] === true;
          if (asHuman && !(typeof named === 'string' && named.length > 0)) {
            publishActor({ workerId: null, agentId: null });
            return await callback(input, extra);
          }
          let footerSession = typeof named === 'string' && named.length ? undefined : mcpRequestSessionContext(auth).sessionId;
          const refusal = await settleCallerSession(name, named, toolOwnsArgument, id => { footerSession = id; });
          if (refusal) return refusal;
          // #1769: the gate's own argument is spent once the actor is settled.
          // A tool that spreads its args into a write (the governed doors) would
          // otherwise carry it into the node row. Only when the gate added it:
          // a tool that declares the argument itself still receives it.
          if (!toolOwnsArgument && input && typeof input === 'object') {
            const { [argumentName]: _settled, ...rest } = input as Record<string, unknown>;
            return await appendDeliveryPending(await callback(rest, extra), {
              ...scopeCtx(), ...mcpRequestSessionContext(auth), sessionId: footerSession ?? undefined, appKeyId: auth.appKeyId ?? undefined,
              impersonation: auth.impersonation ?? undefined,
            });
          }
          return await appendDeliveryPending(await callback(input, extra), {
            ...scopeCtx(), ...mcpRequestSessionContext(auth), sessionId: footerSession ?? undefined, appKeyId: auth.appKeyId ?? undefined,
            impersonation: auth.impersonation ?? undefined,
          });
        });
      return registerTool(...args);
    };
  }

  // Per-session state — this server instance is built once per MCP session
  // (see the createMcpServerInstance call sites), so this closure variable is
  // genuinely per-session. Set via `hadron_set_active_memory`. Spec 022 D4a kept it
  // advisory; spec cor:api:060 (hadron_run_task) is its first server-side reader,
  // consuming it as the default memory scope when a by-name run gives no
  // `memory` hint. Spec-022 URN-input tools still MUST NOT fall back to it —
  // they require a fully-qualified URN.
  // #1012: seeded from this client's durable selection when it sent an
  // X-Hadron-Client-Id and the memory still passes the read gate. Undefined
  // otherwise, which is the pre-#1012 behaviour.
  let activeMemoryUrn: string | undefined = opts.restoredMemoryUrn;

  // Spec 049 Phase 1 — the EXPLICITLY selected active organization
  // (`hadron_set_active_org`). Rung 3 of the ladder in lib/auth/activeOrg.ts:
  // a named org and an org-owned active App both outrank it, so it is only
  // consulted when neither applies. Seeded from the client's durable selection
  // (re-authorized at the boundary) like the memory above; undefined otherwise.
  let activeOrgId: string | undefined = opts.restoredOrgId;

  // Spec 049 Phase 3 — the session's ACTIVE SCOPE (`hadron_set_active_scope`):
  // rung 2 of the search ladder, outranked only by a scope named in the call.
  // Seeded from the client's durable selection (re-authorized at the boundary).
  let activeScopeId: string | undefined = opts.restoredScopeId;

  /**
   * The MCP search ladder (D-2026-09-13-002): a scope named in the call › the
   * session's active scope › the active App (`app`) › the active organization
   * (`global`) › the user-owned view.
   *
   * An EXPLICIT memory selector in the call (memoryUrn / memoryUrns /
   * allMemories / parentRel) is a per-call choice and outranks the AMBIENT
   * rungs — a caller who named a memory must not have an ambient default
   * silently shrink it to nothing (`cor:acl:020:03` rule 5's surprise, and the
   * `hadron_find_nodes(memoryUrn: …)` call every project's CLAUDE.md makes) —
   * but a scope NAMED in the same call still applies and intersects.
   */
  const mcpSearchScope = async (
    scopeArg: string | undefined,
    hasExplicitSelector: boolean,
  ): Promise<SearchScopeResolution | null> => {
    if (!scopeArg && hasExplicitSelector) return null;
    // A pure App key's organization is its credential (cor:api:100) — the same
    // answer hadron_server_info gives it — so `global` resolves to it rather
    // than to the user-owned view (Codex + Copilot on PR #1161).
    let activeOrg: ActiveOrgResolution | null = null;
    if (auth.userId && !auth.impersonation) {
      activeOrg = await currentActiveOrg();
    } else if (auth.appId && !auth.userId) {
      const app = await db.app.findUnique({ where: { id: auth.appId }, select: { organizationId: true } });
      activeOrg = app?.organizationId ? { kind: 'org', organizationId: app.organizationId, source: 'app' } : { kind: 'user-owned' };
    }
    return resolveSearchScope(scopeCtx(), {
      scopeArg,
      appId: auth.appId ?? null,
      storedScopeId: activeScopeId ?? null,
      ambient: true,
      activeOrg,
    });
  };

  /** The `scope:` line every scoped search result starts with (plan §2 S3). */
  const scopeNoteLine = (r: SearchScopeResolution): string => {
    const what =
      r.kind === 'scope'
        ? `scope "${r.label}"${r.ownerUrn ? ` (owned by ${r.ownerUrn})` : ''}`
        : r.kind === 'app'
          ? `app ${safeEmitEntityUrnV2('app', r.label)} — its attached memories`
          : r.kind === 'global'
            ? `global — organization ${safeEmitEntityUrnV2('org', r.label)}`
            : 'your user-owned memories (no organization)';
    const dropped =
      r.droppedCount > 0
        ? ` — ${r.droppedCount} ${r.droppedCount === 1 ? 'memory' : 'memories'} in this scope are not readable by you and were dropped. [degraded:scope_narrowed]`
        : '';
    return `scope: ${what} (via ${r.source}). Pass scope: "global" for your whole organization, or a scope id / name.${dropped}`;
  };

  /**
   * Resolve the caller's active organization by the shared ladder, with this
   * session's inputs: the pinned App (`auth.appId`, which for a user principal
   * is the selection and for an App key is the credential) and the explicit
   * selection above. Phase 3's scope ladder consumes this; Phase 1 reports it.
   */
  const currentActiveOrg = (namedOrgId?: string | null) =>
    resolveActiveOrg(db, {
      userId: auth.userId!,
      namedOrgId,
      activeAppId: auth.appId ?? null,
      selectedOrgId: activeOrgId ?? null,
      restrictToOrgId: auth.impersonation?.orgId,
    });

  /**
   * Member orgs as `- <urn> (<name>)` lines, for surfaces that must say what IS
   * available. #1412 review hardening, two ways tenant-editable text can abuse
   * a diagnostic an agent reads on every connection:
   * - `Organization.name` accepts CR/LF, and these lines ride inside
   *   line-parsed output (`server_info`, the ORG_REQUIRED/org_not_found
   *   refusals) — control characters collapse to a space so one org can never
   *   forge an extra line (e.g. a second `server:` row).
   * - Memberships and names are unbounded, so the block AND its query are
   *   capped: findMany takes MEMBER_ORG_LINES rows (name-ascending,
   *   deterministic) with a sibling count() for the exact omitted figure,
   *   each name at ORG_NAME_RENDER_MAX chars — a connection-time diagnostic
   *   must not scale its database transfer with the membership count.
   */
  const MEMBER_ORG_LINES = 10;
  const ORG_NAME_RENDER_MAX = 100;
  const renderMemberOrgs = async (orgIds: string[]): Promise<string> => {
    if (orgIds.length === 0) return '  (no organization memberships)';
    const where = { id: { in: orgIds }, deletedAt: null };
    const [orgs, total] = await Promise.all([
      db.organization.findMany({
        where,
        select: { urn: true, name: true },
        orderBy: { name: 'asc' },
        take: MEMBER_ORG_LINES,
      }),
      db.organization.count({ where }),
    ]);
    const oneLine = (name: string) => {
      const flat = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
      return flat.length > ORG_NAME_RENDER_MAX ? `${flat.slice(0, ORG_NAME_RENDER_MAX - 1)}…` : flat;
    };
    const lines = orgs.map((o) => `  - ${safeEmitEntityUrnV2('org', o.urn)} (${oneLine(o.name)})`);
    if (total > orgs.length) {
      lines.push(`  … and ${total - orgs.length} more not shown`);
    }
    return lines.join('\n');
  };

  // Spec 026 — has the session called `hadron_list_apps` or `hadron_set_active_app`,
  // or had a regime-(b) `initialize` envelope attempted? Toggles which
  // error fires when a multi-App user calls an App-scoped tool without
  // selection: typed `no_active_app` (new) vs. legacy
  // `multiple_apps_resolved` text (FR-016 fall-through for un-migrated
  // clients). The legacy text is preserved verbatim in the helper so
  // SC-003 can track adoption — operators watching for the legacy phrase
  // in logs / client traces see the migration trend.
  let engagedWithNewSurface = false;

  /** Restore connection selection without auto-selecting or requiring one (#1597). */
  function restoreSelectedApp(): void {
    if (auth.appId || !auth.userId) return;
    const sid = getSessionId();
    const sel = sid ? activeAppByMcpSession.get(sid) : undefined;
    if (sel) {
      auth.appId = sel.appId;
      auth.organizationId = sel.organizationId ?? undefined;
    }
  }

  /**
   * Spec 026 — resolve the active App for an App-scoped tool call.
   * Returns `null` when the caller can proceed (auth.appId set, possibly
   * via a freshly applied session-scoped selection). Returns an MCP
   * tool-error envelope when the caller has no App scope.
   *
   * Mutates `auth.appId` / `auth.organizationId` when a session-scoped
   * selection becomes active — so the existing tools' `if (!auth.appId)`
   * checks downstream pass without per-tool plumbing.
   */
  function requireAppScope(): AppSelectionErrorEnvelope | null {
    restoreSelectedApp();
    if (auth.appId) return null;
    if (!auth.userId) return null; // truly unauth — let existing checks handle it
    const sid = getSessionId();

    if (cachedAppResolution?.kind === 'multi-app') {
      // TODO(US3 — revocation cascade): cachedAppResolution is captured at
      // session-init and may go stale within a long-lived session. A user
      // whose multi-App status changes mid-session (one revocation reduces
      // them to single-App; new install widens them to multi-App) won't
      // see the cache invalidate. US3's revocation work is the natural
      // place to add a per-call re-resolve OR an invalidation hook on
      // AppMember mutations.
      if (engagedWithNewSurface) {
        const message =
          `No active Hadron App. Call hadron_list_apps to see options, then hadron_set_active_app with the one you want. If you're calling from a project directory, set 'app' in '.hadron/config.json'.` +
          (isReconnect ? RECONNECT_NOTE : '');
        mcpLog('warn', 'no_active_app_typed_error', {
          userId: auth.userId,
          mcpSessionId: sid,
          // #1009: `engaged` is emitted as a FIELD on both branches so SC-003's
          // adoption metric can be read off structured logs. Inferring it from
          // which error TEXT fired is biased: `engagedWithNewSurface` is
          // per-transport-session and a reconnect resets it, so a migrated
          // client that reconnects is counted as un-migrated — and the longer a
          // client runs, the more often it is miscounted.
          engaged: true,
          reconnect: isReconnect,
        });
        return appSelectionError(APP_SELECTION_ERROR_CODES.NO_ACTIVE_APP, message);
      }
      // FR-016 fall-through for un-engaged callers. The MULTIPLE_APPS_RESOLVED
      // code carries the literal `multiple_apps_resolved` token in the
      // envelope's `[<code>]` prefix so SC-003's production-log grep
      // continues to work even when the legacy spec-025 HTTP 409 path is
      // gone.
      const message =
        `User has more than one Hadron App; this MCP client does not support App selection. See ${MULTIPLE_APPS_DOCS_URL} for guidance. Or call hadron_list_apps to see your accessible Apps and hadron_set_active_app to pick one.` +
        (isReconnect ? RECONNECT_NOTE : '');
      mcpLog('warn', 'multiple_apps_resolved_fallthrough', {
        userId: auth.userId,
        mcpSessionId: sid,
        // See the sibling branch: `engaged` is the metric, not the phrase. On a
        // RECONNECT this false is untrustworthy as an adoption signal — the
        // flag was reset with the session, not by an un-migrated client — so
        // SC-003 should read `engaged` and exclude `reconnect: true` rows.
        engaged: false,
        reconnect: isReconnect,
      });
      return appSelectionError(APP_SELECTION_ERROR_CODES.MULTIPLE_APPS_RESOLVED, message);
    }

    return null; // zero-App or other path — fall through
  }

  /**
   * #1005 — make an App the session's active one, for both the in-process
   * selection map and this closure's `auth`.
   *
   * Extracted from `hadron_set_active_app` so every pinning path writes the
   * SAME two places. A path that set only `auth.appId` would work until the
   * next tool call re-entered `requireAppScope` on a different code path, and
   * one that set only the map would leave `auth.appId` unset for the delegating
   * resolvers — both are silent half-fixes.
   */
  function pinActiveApp(
    appId: string,
    organizationId: string | null,
    reason: 'selection' | 'worker_bind' | 'session',
  ): void {
    const sid = getSessionId();
    if (sid) activeAppByMcpSession.set(sid, { appId, organizationId });
    auth.appId = appId;
    auth.organizationId = organizationId ?? undefined;
    mcpLog('info', 'active_app_pinned', { userId: auth.userId, mcpSessionId: sid, appId, reason });
  }

  /**
   * #1005 — recover App scope from a Hadron session the caller names.
   *
   * The active-App selection is per-MCP-TRANSPORT-session in-process state
   * (`activeAppByMcpSession`, keyed on the transport's session id, cleared on
   * close). MCP transport sessions are re-created transparently under the
   * client — a server restart answers a stale id with the recoverable 404 and
   * the client silently re-initializes (findings:mcp-stale-session-400-vs-404).
   * The selection does NOT survive that, so a multi-App user's App-scoped calls
   * succeed for a while and then start failing mid-conversation with
   * `multiple_apps_resolved`, with nothing in the transcript to explain it.
   *
   * A Hadron `Session` row is the durable anchor the agent still holds across
   * that reconnect: it carries `appId`, and the agent has its id because it
   * started it. So when a tool is handed one, resolve the App from it rather
   * than declaring the user's App set ambiguous.
   *
   * Gated, not inferred, on three things:
   *
   *   1. the session is the CALLER'S OWN (`session.userId === auth.userId` — an
   *      App-key-created session has a null userId and never matches), so a
   *      session id is not a capability someone else can quote;
   *   2. the App is still live (not soft-deleted, not uninstalled — the same
   *      lifecycle filter `resolveUserApps` applies);
   *   3. the caller is STILL a participant, re-checked through
   *      `isAppParticipant` — the SAME predicate `startSession` used to admit
   *      them (#943). Re-checked rather than trusted from the session row,
   *      because the row records where the session was attributed and outlives
   *      the authorization that permitted it (#475 — revoked membership must
   *      not authorize).
   *
   * Gate 3 is the shared predicate rather than a direct `AppMember` lookup on
   * purpose (PR #1007 review, Codex + Copilot): participation also admits an
   * org CONTRIBUTOR+ and the owner of a user-owned App, so a bespoke
   * member-row check would let those callers start a session and pin an App,
   * then silently refuse to restore it after a reconnect — a gate that drifts
   * from the one beside it, which is the failure AGENTS.md's first
   * authorization invariant names.
   *
   * So this can only re-establish scope the caller could have set by hand with
   * `hadron_set_active_app`; it never widens reach. A no-op when there is no
   * session argument, when the session already names the pinned App, or when
   * any gate fails — the caller then falls through to `requireAppScope`'s
   * normal error.
   *
   * #1037: it also OVERRIDES an existing pin, which it previously deferred to.
   * The pin is the user's active-App SELECTION, and any later bind in another
   * App silently re-points it — so `hadron_record_work` compared a Hadron Dev
   * Team session against Micromentor Eng Team and refused, blaming the session,
   * which was the one part that was correct. An explicitly-passed session names
   * its App unambiguously through its worker; connection state is the fallback
   * for callers who named nothing, and must never outrank a caller who did.
   * Every gate below still runs, so adopting the session's App cannot reach an
   * App the caller could not have selected by hand.
   *
   * Deliberately confined to `auth.userId` callers. For a pure App-key
   * principal `auth.appId` is a CREDENTIAL, not a selection
   * (findings:auth-appid-credential-vs-selection) — it IS that App, and no
   * session argument may re-point it.
   */
  /**
   * #1081 — touch a session the caller just drove, so the reaper counts it live.
   *
   * ## Why this exists
   *
   * The reaper measures last activity as the greatest of `startedAt`,
   * `updatedAt`, and the newest UsageEvent attributed to the session
   * (`reapSessions.ts`). On the MCP desktop track a user-credential caller
   * usually has NO transport binding — the worker session is created by
   * `hadron_start_session` mid-conversation, long after the HTTP connection was
   * established, so it can never appear in an `X-Hadron-Session` header. With
   * `auth.sessionId` null, every usage event is unattributed and nothing bumps
   * `updatedAt`.
   *
   * The result was a heartbeat by ACCIDENT: the only MCP-path write that
   * touched the Session row was `hadron_record_work(kind:'pr')` denormalizing
   * `Session.prNumber` — a display-only field update. So a worker who opens PRs
   * stayed alive and a worker who does not, notably a COORDINATOR who reads
   * chat and dispatches all day, was reaped ~24h after binding no matter how
   * hard they worked. That is 7-of-8 coordinator stints ending with no #1029
   * handoff, and it is why three different reaper ceilings (24h / 27h / 43.6h)
   * were each reported and each contradicted: one regime, different tool mixes.
   *
   * This makes the touch EXPLICIT and puts it on every tool handed a live
   * session id, which is what the reaper's own docstring already claims happens
   * ("a session log / chat post touches liveness … for free").
   *
   * ## What keeps it from being a hole
   *
   * - **Ownership is re-checked, never assumed.** A user principal may only
   *   touch a session attributed to them; a pure App-key caller only its App's.
   *   Otherwise any caller could keep an arbitrary session alive by naming it.
   * - **It cannot revive the dead.** Guarded on `endedAt: null`, so a heartbeat
   *   racing `endSession` or the reaper updates zero rows rather than
   *   resurrecting a closed session — and never clears `autoExpiredAt`.
   * - **It cannot revive the lapsed either (#1543).** It touches only a session
   *   `isSessionLive` still holds for. An open session nobody drove inside its
   *   idle window is left as it is; its next tool call meets the handler's own
   *   gate instead of being silently resurrected (another driver may have
   *   bound the worker since). Same rule as the GraphQL door (#1540).
   * - **It cannot fail a tool call.** A heartbeat is bookkeeping; a caller's
   *   read must not 500 because liveness bookkeeping had a bad day.
   */
  async function heartbeatSession(sessionRef?: string | null): Promise<void> {
    // Defensive normalization: `createTestableMcpServer` bypasses zod, so a
    // non-string here would throw out of `.trim()` and fail the whole tool call
    // — the one thing this function promises never to do (PR #1082 review,
    // Copilot). Same reason the handlers re-validate contentScope.
    const id = typeof sessionRef === 'string' ? sessionRef.trim() : '';
    if (!id) return;
    // Scope to what the caller demonstrably owns. A pure App-key caller has no
    // userId by construction; a user principal is judged on the user (the #932
    // rule), so an impersonated support session cannot heartbeat its target.
    const owner = auth.userId
      ? { userId: auth.userId }
      : auth.appId
        ? { appId: auth.appId }
        : null;
    if (!owner || auth.impersonation) return;
    // CURRENT eligibility, not historical (PR #1082 review, Codex P1).
    // Ownership alone is a HISTORICAL fact: `Session.userId` is stamped at bind
    // and never revoked, so a user removed from the App or the org still
    // satisfies it with a perfectly valid credential. They could then keep an
    // old worker session — and the worker it holds — alive indefinitely by
    // issuing tool calls that are themselves denied, since this touch runs
    // before any of the handlers' own gates. "Revoked membership must not
    // authorize" applies to keeping something alive exactly as it applies to
    // reading it.
    try {
      // INSIDE the try (PR #1082 review, Copilot): this is a DB lookup, and it
      // sat outside while the docstring two paragraphs up promised the
      // heartbeat "cannot fail a tool call". A transient error here would have
      // broken that promise — the same claim-wider-than-the-code defect this
      // PR's own commit messages keep naming. Either step throwing means no
      // heartbeat, which is the safe direction: the session simply ages.
      if (auth.userId && !(await callerStillDrives(id))) return;
      // #1543 — keep a LIVE session alive; never revive a lapsed one. A
      // session nobody drove inside its idle window may already have been
      // bound by another driver (the bind gate is derived, #1114), so reviving
      // it here would silently put a second live session on that worker. The
      // handler then meets its own gate (SESSION_NOT_LIVE on a post), exactly
      // as the GraphQL door does since #1540.
      const row = await db.session.findFirst({
        where: { id, endedAt: null, deletedAt: null, ...owner },
        select: { type: true, startedAt: true, updatedAt: true, autoExpiredAt: true, endedAt: true, expiresAt: true },
      });
      if (!row) return;
      const lastEvent = (await loadLastEventBySession(db as never, [id])).get(id);
      if (!isSessionLive(row, lastEvent, new Date())) return;
      const now = new Date();
      await db.session.updateMany({
        where: { id, endedAt: null, deletedAt: null, ...owner, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        data: { updatedAt: now },
      });
    } catch (err) {
      // Deliberately swallowed — see the docstring. Logged, not raised.
      console.warn('[heartbeatSession] touch failed:', err);
    }
  }

  /**
   * #2493 (cor:dmo:050:11): the explicit `session` argument of a recovery read, as the session the caller is acting as.
   * A reconnecting principal carries no `auth.sessionId`, yet its open session finishes under the agent and role it was
   * bound with, so the argument selects that placement. It is never trusted as a bare id: it must pass
   * `validateSessionBinding` (the one check behind X-Hadron-Session and the connection binding) and, as a user, the
   * caller must still be entitled to drive it, as the heartbeat above requires. Anything else is no session.
   */
  async function explicitActingSessionId(sessionRef?: string | null): Promise<string | undefined> {
    const id = typeof sessionRef === 'string' ? sessionRef.trim() : '';
    if (!id) return undefined;
    try {
      // The ONE binding check (#934): open, not hard-expired, not dormant, the caller's own, never under impersonation.
      const bound = await validateSessionBinding(db, auth, id);
      if (!bound) return undefined;
      if (auth.userId && !(await callerStillDrives(id))) return undefined;
      return bound.sessionId;
    } catch {
      // Unrecoverable here: serve the live row, the same answer as no session.
      return undefined;
    }
  }

  /**
   * Is this user-principal caller STILL entitled to drive this session?
   *
   * Shares its predicate with `adoptAppFromSession` deliberately: that function
   * already establishes "this session is mine and its App still admits me", and
   * two copies of that question would drift — which is how a revoked member ends
   * up refused on one surface and served on another (the `effectiveAccess` tell,
   * #362). This one answers the question WITHOUT pinning the App, because a
   * heartbeat must not silently re-scope a caller who passed `app` explicitly.
   *
   * A session with `appId: null` is a self-attributed user-credential coding
   * session (#934) — there is no App to be a member of, so ownership is the
   * whole gate and there is nothing further to revoke.
   */
  async function callerStillDrives(sessionId: string): Promise<boolean> {
    if (!auth.userId) return false;
    const session = await db.session.findUnique({
      where: { id: sessionId },
      select: { appId: true, userId: true },
    });
    if (!session || session.userId !== auth.userId) return false;
    if (!session.appId) return true;
    const app = await db.app.findFirst({
      where: { id: session.appId, deletedAt: null, uninstalledAt: null },
      select: { id: true, organizationId: true, ownerUserId: true },
    });
    if (!app) return false;
    return isAppParticipant(
      {
        db,
        clientId: auth.clientId ?? undefined,
        userId: auth.userId,
        roles: auth.roles as Context['roles'],
        organizationId: auth.organizationId ?? undefined,
      } as Context,
      app,
    );
  }

  async function adoptAppFromSession(sessionRef?: string | null): Promise<boolean> {
    if (!auth.userId || !sessionRef) return false;

    const session = await db.session.findUnique({
      where: { id: sessionRef.trim() },
      select: { appId: true, userId: true },
    });
    if (!session?.appId || session.userId !== auth.userId) return false;

    // NO early return for "the pin already matches the session" (PR #1051
    // review, Codex P2). It was a harmless short-circuit while this function
    // returned void; the moment it reports whether scope is ESTABLISHED, that
    // shortcut asserts something it never checked. A long-lived connection
    // pinned to App A whose caller has since lost membership — or whose App was
    // uninstalled — would report success on the strength of the stale pin
    // alone, skipping both checks below, suppressing the worker-derived
    // fallback, and running the query against an App the caller may no longer
    // read. "Revoked membership must not authorize" is the invariant, and a
    // matching pin is not evidence of anything.
    //
    // The cost is two queries on the common single-App path. The saving they
    // replace was a log line.
    const app = await db.app.findFirst({
      where: { id: session.appId, deletedAt: null, uninstalledAt: null },
      select: { id: true, organizationId: true, ownerUserId: true },
    });
    if (!app) return false;

    // The participant check runs against the caller as they are NOW, with no
    // App selection in hand — which is the state this function exists to
    // repair, and exactly the shape isAppParticipant judges (the USER branch).
    const participates = await isAppParticipant(
      {
        db,
        clientId: auth.clientId ?? undefined,
        userId: auth.userId,
        roles: auth.roles as Context['roles'],
        organizationId: auth.organizationId ?? undefined,
      } as Context,
      app,
    );
    if (!participates) return false;

    // Only pin when it actually changes — no log line implying a switch that
    // did not happen. Success is reported either way: scope is established and
    // it is the session's, now VERIFIED rather than assumed.
    if (app.id !== auth.appId) pinActiveApp(app.id, app.organizationId, 'session');
    return true;
  }

  /**
   * `adoptAppFromSession`'s sibling for a SELF-DESCRIBING worker ref (#1037,
   * extended by PR #1051 review — Codex P2).
   *
   * A worker id or `hrn:worker:…` URN names its own App, exactly as it does at
   * bind. A tool that takes one and still resolves scope from the ambient pin
   * therefore answers "No App context" for an unpinned caller, or an empty page
   * from the WRONG App for a pinned one — while advertising id/URN support.
   * That is the same defect #1037 fixed for `hadron_start_session` and
   * `hadron_get_worker`, reappearing in a tool that grew a worker argument
   * afterwards, which is precisely how a convention decays one tool at a time.
   *
   * A bare NAME is deliberately NOT adopted: a name is unique only within an
   * App, so there is nothing to derive scope FROM — it needs scope to resolve.
   * The shape test below is a FAST PATH and a statement of intent, not a
   * load-bearing guard: `resolveWorkerRef` rejects a name anyway, so removing
   * it changes no outcome (verified by mutation — it stays green). It earns its
   * place by matching the shape dispatch the resolver itself uses, so the two
   * cannot disagree about what counts as self-describing.
   *
   * Same gates as the session sibling, so this can only re-establish scope the
   * caller could have set by hand: the App must be live, and the caller must
   * still be a participant. Confined to `auth.userId` callers — an App key's
   * `appId` is a CREDENTIAL and is never re-pointed by an argument.
   */
  async function adoptAppFromWorker(workerRef?: string | null): Promise<void> {
    if (!auth.userId || !workerRef) return;
    const trimmed = workerRef.trim();
    if (!isId(trimmed) && !hasSchemePrefix(trimmed)) return;

    let workerId: string;
    try {
      ({ id: workerId } = await resolveWorkerRef(db, trimmed));
    } catch (e) {
      // NARROW (review:narrow-catch-blocks; PR #1051 review, Codex — the THIRD
      // instance of this class in one PR, and the second one I wrote while
      // fixing the first). A ref that names nothing leaves scope alone, and the
      // tool's own not-found path answers. A DATABASE failure must not be
      // reported as "no active App", which sends the caller to fix their
      // selection while the server is down.
      if (!(e instanceof WorkerNotFoundError)) throw e;
      return;
    }
    const worker = await db.worker.findUnique({
      where: { id: workerId },
      select: { appId: true },
    });
    if (!worker || worker.appId === auth.appId) return;

    const app = await db.app.findFirst({
      where: { id: worker.appId, deletedAt: null, uninstalledAt: null },
      select: { id: true, organizationId: true, ownerUserId: true },
    });
    if (!app) return;

    const participates = await isAppParticipant(
      {
        db,
        clientId: auth.clientId ?? undefined,
        userId: auth.userId,
        roles: auth.roles as Context['roles'],
        organizationId: auth.organizationId ?? undefined,
      } as Context,
      app,
    );
    if (!participates) return;

    pinActiveApp(app.id, app.organizationId, 'session');
  }

  // ── hadron_search ─────────────────────────────────────────────────────────────

  server.tool(
    'hadron_search',
    "Global cross-entity search across organizations, memories, nodes, agents, apps, AI service configs, and users — returns one ranked, flat list. By default the query shape is smart-sniffed: a PK-shaped input does an exact id lookup, a URN-shaped input matches URNs, free text matches name + URN. Pass `fields` to force which fields to match (overrides the sniff) and `entityTypes` to restrict the kinds. `pk` is exact-match; the rest are case-insensitive substring — including `content` (node bodies), which is a LITERAL substring match (NOT stemmed): 'report abuse' won't match 'reports abusive behavior'. `content` is opt-in and skips encrypted memories. For a stemmed, ranked, concept/multi-word search over node text — and the cross-memory 'does anyone know about X?' probe — use hadron_find_nodes (keyword mode, allMemories: true) instead; this tool is best for locating a known entity by name/URN/id across kinds.",
    SHAPE_HADRON_SEARCH,
    async ({ query, entityTypes, fields, limit, scope }) => {
      if (!auth.clientId && !auth.appId && !auth.userId) return refusalResult('Not authenticated.');

      // createTestableMcpServer bypasses zod — normalize args defensively.
      const q = typeof query === 'string' ? query : '';
      const types = normalizeEntityTypes(entityTypes);
      const flds = normalizeFields(fields);
      const lim = typeof limit === 'number' ? limit : undefined;

      // Same access gates as the GraphQL globalSearch resolver — see the
      // rationale there. App-Key callers (no userId) get no org-read → [].
      const isPlatformAdmin = !!auth.roles?.includes('ADMIN') || !!auth.roles?.includes('OWNER');
      const accessibleMemoryIds = await getAccessibleMemoryIds(db, auth);
      // The caller's own member orgs (admin or not) — the org allow-list for
      // non-admins, and the #609 hidden-org carve-out for admins.
      const memberOrgIds = auth.userId ? await getMemberOrgIds(db, auth.userId) : [];
      const orgIds = isPlatformAdmin ? null : memberOrgIds;
      // Spec 049 Phase 3 — the ladder narrows the memory + node slices; a
      // scope's list is already ∩ access (S2), so handing it over narrows only.
      let scopeRes: SearchScopeResolution | null = null;
      try {
        scopeRes = await mcpSearchScope(scope, false);
      } catch (e) {
        if (e instanceof ScopeGraphQLError) return refusalResult(`[${String(e.extensions?.code ?? 'error').toLowerCase()}] ${e.message}`);
        throw e;
      }
      const principal: SearchPrincipal = {
        viewerUserId: auth.userId ?? null,
        isPlatformAdmin,
        accessibleMemoryIds: scopeRes?.memoryIds ?? accessibleMemoryIds,
        orgIds: scopeRes?.kind === 'global' && scopeRes.orgScopeId ? [scopeRes.orgScopeId] : orgIds,
        viewerOrgIds: memberOrgIds,
        orgScopeId: scopeRes?.kind === 'global' ? scopeRes.orgScopeId : null,
      };

      const { hits, degraded } = await globalSearch(
        db,
        { query: q, entityTypes: types, fields: flds, limit: lim },
        principal,
      );

      const scopeNote = scopeRes ? `${scopeNoteLine(scopeRes)}\n\n` : '';
      const note = degraded.length
        ? `\n\n${degraded.map((d) => `[degraded] ${d}`).join('\n')}`
        : '';
      if (hits.length === 0) {
        return textResult(`${scopeNote}No results for "${q}".${note}`);
      }
      const lines = hits.map((h) => {
        const label = h.urn ?? h.id;
        const name = h.name ? ` — ${h.name}` : '';
        return `- [${h.entityType}] **${label}**${name} (matched ${h.matchedField}, score ${h.score.toFixed(2)})`;
      });
      return textResult(
        `${scopeNote}${hits.length} result${hits.length === 1 ? '' : 's'} for "${q}":\n\n${lines.join('\n')}${note}`,
      );
    },
  );

  // ── hadron_list_memories ──────────────────────────────────────────────────────

  server.tool(
    'hadron_list_memories',
    'List all memories this caller has access to, with URN and access level (read-only or read-write).',
    {},
    async () => {
      // Spec 026 / D-2026-05-21-003: hadron_list_memories is advisory — it
      // works without an active App. When auth.appId is unset but
      // auth.userId is set (multi-App OAuth caller without selection),
      // getMemoryAccess unions memory access across the user's
      // accessible Apps. No requireAppScope() gate on purpose.
      if (!auth.clientId && !auth.appId && !auth.userId) return refusalResult('Not authenticated.');

      // Effective access level per memory. The App/org access map is
      // personal-free by design (it also backs getAccessibleMemoryIds, which
      // other tools rely on staying personal-free), so we start from it and
      // then fold in the caller's own personal/private memories below.
      const levels = new Map<string, string>(await getMemoryAccess(db, auth));

      // #282: a user's own personal/private memories are reachable per-node via
      // canReadMemory but absent from the access map — so without this they
      // can't be *discovered* over MCP, the CLI-vs-MCP asymmetry #282 reported.
      // Fold them in here, gated on auth.userId: App-Key callers (no userId)
      // get none, preserving per-App isolation. canReadMemory / canWriteToMemory
      // are the canonical gates, so the listing can never disagree with what
      // hadron_get_node allows — including per-App isolation for app-scoped personal
      // rows and the spec-034 free-standing owner-only case.
      if (auth.userId) {
        const owned = await db.memory.findMany({
          where: {
            userId: auth.userId,
            class: { in: ['personal', 'private'] },
            deletedAt: null,
          },
          select: { id: true },
        });
        // Each memory is independent and keyed by a unique id, so run the gate
        // checks concurrently rather than as a serial 2N+1 round-trip when a
        // user owns many personal memories. The synchronous `levels.set`
        // between awaits is race-free: the ids are distinct, so no two
        // callbacks ever touch the same key.
        await Promise.all(
          owned.map(async ({ id }) => {
            if (levels.has(id)) return;
            if (!(await canReadMemory(db, auth, id))) return;
            levels.set(id, (await canWriteToMemory(db, auth, id)) ? 'READ_WRITE' : 'READ_ONLY');
          }),
        );
      }

      // Surface the active scope so a narrow list isn't silently mistaken for
      // "no access" (#282; also the #187/#190 dual-namespace confusion) — an
      // App-Key session is intentionally narrower than a user session.
      let scope: string;
      if (auth.appId) {
        const app = await db.app.findUnique({ where: { id: auth.appId }, select: { urn: true } });
        const who = app ? safeEmitEntityUrnV2('app', app.urn) : auth.appId;
        scope = auth.userId
          ? `Scope: user · active App ${who} — this App's agent memories + org-readable memories + your personal memories scoped to this App.`
          : `Scope: App key · ${who} (App-scoped) — this App's agent memories only; personal and org-readable memories require user authentication and are not shown to an App key.`;
      } else if (auth.userId) {
        scope = `Scope: user · no active App — the union across your Apps + org-readable memories + all your personal memories. Select one with hadron_set_active_app to narrow the view.`;
      } else {
        scope = `Scope: ${auth.clientId ?? 'authenticated caller'}.`;
      }

      if (levels.size === 0) {
        return textResult(`${scope}\n\nNo memories accessible. Subscribe to an agent with memories first.`);
      }

      const memoryIds = [...levels.keys()];
      const memories = await db.memory.findMany({
        where: { id: { in: memoryIds } },
        select: { id: true, urn: true, name: true, data: true, schema: true, class: true },
      });

      // #339: the displayed level MUST equal what mutating ops enforce.
      // canWriteToMemory grants global ADMIN/OWNER an unconditional write
      // bypass on every NON-personal memory (access-control.ts), but
      // getMemoryAccess — which `levels` is built from — never encodes that
      // bypass (it tops out at READ_ONLY for org-readable knowledge/group/
      // public rows). Without folding the bypass in here, an admin sees their
      // org's memories labeled read-only while hadron_create_node into them
      // succeeds — the exact list-vs-enforce divergence #339 reported. The
      // bypass is non-personal only; personal/private rows keep the strict-
      // ownership level the owned fold above already computed via
      // canWriteToMemory, so this can't wrongly upgrade another user's
      // (unreachable) personal memory.
      const isSuperWriter = !!auth.roles?.includes('ADMIN') || !!auth.roles?.includes('OWNER');

      const lines = memories.map((m) => {
        const isPersonal = m.class === 'personal' || m.class === 'private';
        const writable =
          levels.get(m.id) === 'READ_WRITE' || (isSuperWriter && !isPersonal);
        const level = writable ? 'read-write' : 'read-only';
        // Tag personal/private rows so it's clear *why* an otherwise-private
        // memory shows up (it's the caller's own); knowledge/app/group rows
        // keep the bare `(level)` form they've always had.
        const cls = isPersonal ? `${m.class}, ` : '';
        const head = `- **${safeEmitEntityUrnV2('memory', m.urn)}** — ${m.name} (${cls}${level})`;
        // Free-form metadata bag (no server-side semantics). Surfaced
        // read-only on its own indented line, only when non-null so the
        // listing stays scannable — mirrors hadron_get_node's `Data: <json>`
        // idiom. Writing `data` is a GraphQL-only path: the MCP surface has
        // no memory-mutation tool (memories are created/edited via
        // createMemory / updateMemory). MCP also bypasses encryption (#206),
        // but `data` is plaintext-by-design metadata, so there's no
        // decrypt-parity gap to bridge here.
        // #725 — surface the property schema read-only for discovery (which
        // collections + typed fields this memory declares), so an agent knows
        // what objectType/where to query. Authoring stays GraphQL-only.
        const dataLine = m.data != null ? `\n  data: ${JSON.stringify(m.data)}` : '';
        const schemaLine = m.schema != null ? `\n  schema: ${JSON.stringify(m.schema)}` : '';
        return `${head}${dataLine}${schemaLine}`;
      });

      return textResult(`${scope}\n\n${memories.length} accessible memories:\n\n${lines.join('\n')}`);
    },
  );

  // ── hadron_set_active_memory ──────────────────────────────────────────────────

  server.tool(
    'hadron_set_active_memory',
    'Set the active memory for this session. Subsequent tree tools will use this as the default scope. Scoped to THIS MCP connection and not persisted: if the connection is re-established (which clients do transparently, e.g. after a server restart), the selection is reset and must be set again — tools will behave as though none was ever chosen rather than erroring.',
    SHAPE_HADRON_SET_ACTIVE_MEMORY,
    async ({ memoryUrn }) => {
      // #100 #3: Memory.urn is stored bare — 'hadronmemory.com:dev' in
      // grammar v2, though pre-flip rows may still hold the v1
      // 'hadronmemory.com::dev' form, which is why resolveMemoryByUrn above
      // matches BOTH separators rather than assuming a normalized DB. Storing
      // the caller-supplied string verbatim makes every downstream
      // findFirst({urn:activeMemoryUrn}) silently miss when the caller passed
      // the canonical 'urn:memory:' form. Writes have fallback paths
      // (single-writable-memory, parent-node lookup) and so still land on
      // the right memory; reads do not. Result: writes succeed, reads see
      // an inconsistent / empty scope, which is the read-after-write
      // asymmetry reported in issue #100.
      const parsed = parseUrnInput(memoryUrn.trim());
      if (parsed.type !== 'memory' && parsed.type !== 'unknown') {
        const prefix = parsed.type === 'loc' ? 'loc:' : `hrn:${parsed.type}:`;
        return textResult(
          `Expected a memory URN, got '${prefix}'. Pass 'hadronmemory.com:dev' or 'hrn:mem:hadronmemory.com:dev'.`,
        );
      }

      // Resolve via the shared helper — soft-delete filtering, trimming, and
      // bare-URN normalization all live in one place so every read-side
      // scoping point behaves consistently.
      // #1316: an unreadable memory takes the missing branch, not "Access denied".
      const mem = await resolveVisibleMemoryByUrn(auth, memoryUrn, 'read');
      if (!mem) {
        return refusalResult(`Memory not found: '${memoryUrn}'. Use hadron_list_memories to see what's available.`);
      }

      // Store the bare URN from the DB row (the canonical form for downstream
      // findFirst({urn:activeMemoryUrn}) lookups).
      activeMemoryUrn = mem.urn;
      // #1012: persist by PK, not URN — a rename must not strand the selection.
      // This is the surface with no other remedy: unlike the App selection,
      // active-memory has no Hadron session to recover from (#1009), so before
      // this a reconnect meant re-selecting, every restart, forever.
      await saveActiveMemory(db, auth, clientKey, mem.id);

      // #187 / #190 — include the bound deployment URL + server version
      // in the success message so an agent (or a transcript reader) can
      // notice they've reached the wrong hadron-server when two
      // namespaces (`mcp__hadron__*` vs `mcp__claude_ai_Hadron__*`) are
      // bound to different deployments. Cheap to surface, hard to
      // ignore in transcripts. Full diagnostic dump lives on
      // hadron_server_info; this is the inline hint.
      const dep = getDeploymentInfo();
      return textResult(
        `Active memory set to: ${safeEmitEntityUrnV2('memory', mem.urn)} ` +
          `(server: ${dep.baseUrl}, version: ${dep.version}).`,
      );
    },
  );

  // ── hadron_create_memory (#2511) ──────────────────────────────────────────────
  //
  // A thin door onto the createMemory mutation: it calls the resolver, so the
  // class allowlist, the memory.create grant, the live-org-membership rule for
  // org-anchored personal/private, the owner/visibility invariants and the
  // group-owner bootstrap have ONE implementation and MCP can never do what the
  // API refuses. It takes no owner, App or agent argument, selects nothing and
  // is not createMemoryInApp: an App-key caller has no user to own a personal
  // memory, so the mutation refuses it exactly as it does over GraphQL.

  server.tool(
    'hadron_create_memory',
    "Create a memory. `memoryClass` is 'knowledge' (default), 'group', 'personal' or 'private'. knowledge and group are shared with an organization, so they need `org` and the organization's memory.create permission (a group's creator becomes its first owner). personal and private are owner-only: omit `org` to create one in your own namespace, or pass `org` to create it in an organization you belong to. Exactly the same rules as the createMemory GraphQL mutation. System and App memories are not created here. This does not select the new memory: pass its URN to hadron_set_active_memory.",
    SHAPE_HADRON_CREATE_MEMORY,
    async ({ name, memoryClass, org, shortDescription, description, tags, visibility }) => {
      const ctx: Context = {
        db,
        clientId: auth.clientId ?? undefined,
        userId: auth.userId ?? undefined,
        apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId, // #1868: the shared authorized tx re-checks the presented key
        appId: auth.appId ?? undefined,
        sessionId: auth.sessionId ?? undefined,
        roles: auth.roles as Context['roles'],
        organizationId: auth.organizationId ?? undefined,
      };
      try {
        const created = await resolvers.Mutation.createMemory(
          {},
          { name, memoryClass, orgId: org, shortDescription, description, tags, visibility },
          ctx,
        );
        return textResult(
          `Memory created: ${safeEmitEntityUrnV2('memory', created.urn)} (class: ${created.class}, id: ${created.id}). ` +
            'Use hadron_set_active_memory to work in it.',
        );
      } catch (e) {
        return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : 'create failed'}`, 'hadron_create_memory:resolver');
      }
    },
  );

  // #2661: one creation policy, delegated to the GraphQL resolver.
  server.tool(
    'hadron_create_app_memory',
    'Create a NEW app-class memory in an App with an installed Agent. Requires the owning org ADMIN/OWNER or the actual owner of a user-owned App acting as themselves, outside a worker session. App keys, runs and impersonation are refused. No existing-memory attachment. App participants read and write it; the Agent owner gains no access. Does not select the new memory.',
    SHAPE_HADRON_CREATE_APP_MEMORY,
    async ({ app, name, shortDescription, description, tags }) => {
      const ctx: Context = {
        db, userId: auth.userId, clientId: auth.clientId,
        appId: auth.appId, appKeyId: auth.appKeyId,
        ...mcpRequestSessionContext(auth),
        apiKeyId: auth.apiKeyId, signInId: auth.signInId,
        roles: auth.roles, organizationId: auth.organizationId,
        impersonation: auth.impersonation,
      };
      try {
        const created = await resolvers.Mutation.createAppMemory({}, { appRef: app, name, shortDescription, description, tags }, ctx);
        return textResult(`Memory created: ${safeEmitEntityUrnV2('memory', created.urn)} (class: app, id: ${created.id}).`);
      } catch (e) {
        return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : 'create failed'}`, 'hadron_create_app_memory:resolver');
      }
    },
  );

  // ── hadron_server_info ────────────────────────────────────────────────────────
  //
  // #187 / #190 — exposes the bound deployment URL + hadron-server
  // version so an agent can answer "which server am I talking to?"
  // without needing to issue any other tool calls. Doesn't require an
  // active App, doesn't require an active memory, doesn't even require
  // read access on any memory — it returns server identity only, never
  // any per-tenant data. The one #1372 exception: an authenticated
  // caller with memberships and no resolved active org also gets their
  // OWN selectable organizations (urn + display name, the same
  // authorized candidate set hadron_set_active_org refuses with), so
  // discovery doesn't require a deliberately wrong selection.
  //
  // Auth layering — the tool itself does NOT add gating because the MCP
  // transport already requires a valid AuthContext (App Key, User API Key,
  // or JWT bearer) to reach any tool invocation. handleMcpRequest at the
  // /mcp boundary rejects requests with no auth principal via a 401 +
  // RFC 9728 protected-resource metadata. So "no tool-level auth gate" is
  // a deliberate layering choice (gate at the transport, not per-tool),
  // not an exposure. The unit test pinning the "works for unauthenticated-
  // shape caller" case bypasses the transport on purpose — it pins that a
  // future "require active App" decoration on this tool can't silently
  // break the transcript-reader use case after auth succeeds upstream.
  //
  // Intentionally does NOT include DATABASE_URL (may carry credentials).
  // If a future need arises to disambiguate two deployments that share
  // a BASE_URL but point at different DBs, the helper's docstring
  // explains how to add a path-only `dbName` field.

  server.tool(
    'hadron_server_info',
    'Returns the identity of the hadron-server this MCP session is bound to: deployment URL, server version, the CAPABILITY tokens this build supports, and whether this connection was re-established. Useful when a caller has two MCP namespaces wired up and needs to know which one a tool call landed on (#190), and to check a feature is actually present BEFORE relying on it — a deployment behind the docs silently ignores arguments it does not know (#1006). Test for a capability token, not a version number; if the capabilities line is missing entirely the server predates this field and should not be trusted to bind workers. No arguments. Returns plain key:value lines — plus, for an authenticated caller whose active organization is unresolved (several memberships, none selected), a `Your memberships:` block listing the selectable organizations as `- <org URN> (<display name>)` per line: the happy-path discovery surface feeding hadron_set_active_org (#1372). Does NOT require an active App or any memory access.',
    {},
    async () => {
      const dep = getDeploymentInfo();
      const lines = [
        `server: ${dep.baseUrl}`,
        `version: ${dep.version}`,
        `capabilities: ${[
          ...MCP_SURFACE_CAPABILITIES,
          // #1925: the same function GET /capabilities answers from, so the two cannot disagree.
          ...switchCapabilities(),
          // Probed exactly as the tools will admit the call: allowlists, a
          // live App and current participation (#1362 review).
          ...(auth.appId && (await teamAttentionAvailable(chatCtx(), auth.appId))
            ? ['team-attention', 'team-attention-paged']
            : []),
        ].join(', ')}`,
      ];
      // Spec 049 Phase 1: the resolved active organization and which rung of
      // the ladder chose it — the one place a caller can ASK which tenancy the
      // scope ladder (Phase 3) will run an org-scoped read against, rather than
      // inferring it from results. Phase 1 reports; nothing narrows on it yet.
      if (auth.userId && !auth.impersonation) {
        const r = await currentActiveOrg();
        if (r.kind === 'org') {
          const o = await db.organization.findUnique({ where: { id: r.organizationId }, select: { urn: true } });
          lines.push(`active organization: ${o ? safeEmitEntityUrnV2('org', o.urn) : r.organizationId} (via ${r.source})`);
        } else if (r.kind === 'user-owned') {
          lines.push('active organization: none — no memberships; the org view is your user-owned memories');
        } else {
          // #1372: name the candidates, not just the count — until here, the
          // only MCP enumeration of a caller's memberships was the
          // org_not_found refusal of a DELIBERATELY wrong selection.
          // renderMemberOrgs is the sanctioned renderer (the same authorized
          // member set hadron_set_active_org refuses with), so this lists
          // options without widening anything.
          lines.push(
            `active organization: unresolved — ${r.memberOrgIds.length} memberships and none selected; the scope ladder will refuse org-scoped reads with org_required until hadron_set_active_org or the call names one. Your memberships:\n${await renderMemberOrgs(r.memberOrgIds)}`,
          );
        }
      } else if (auth.appId && !auth.userId) {
        // A pure App key cannot call hadron_set_active_org — its organization
        // IS the credential (cor:api:100) — so it must be able to read it here
        // (Codex on PR #1158). A user-owned App has none.
        const app = await db.app.findUnique({
          where: { id: auth.appId },
          select: { organization: { select: { urn: true } } },
        });
        lines.push(
          app?.organization
            ? `active organization: ${safeEmitEntityUrnV2('org', app.organization.urn)} (via credential — the App key's own organization)`
            : 'active organization: none — this App key belongs to a user-owned App, which has no organization',
        );
      }
      // #1009: the one place an agent can ASK whether its bearings were reset,
      // rather than inferring it from a tool that stopped working.
      if (isReconnect) {
        lines.push(
          'connection: re-established (the previous MCP session ended; any active App ' +
            'or active memory selection was reset)',
        );
      }
      return textResult(lines.join('\n'));
    },
  );

  // ── hadron_list_apps (spec 026 regime c) ──────────────────────────────────────

  server.tool(
    'hadron_list_apps',
    'List the Hadron Apps you have access to. Use this to find an App to pass to hadron_set_active_app, or to check what an `app` field in `.hadron/config.json` resolves to.',
    {},
    async () => {
      // Auth gate first; only then mark the session "engaged" so an
      // unauthenticated call can't flip the flag and influence a later
      // re-authed request.
      if (!auth.userId && !auth.clientId && !auth.appId) {
        return refusalResult('Not authenticated.');
      }
      engagedWithNewSurface = true;
      // AppKey callers (appId set, no userId) — list returns the single App
      // they're scoped to, for parity with the user-credential path.
      if (auth.appId && !auth.userId) {
        const app = await db.app.findUnique({
          where: { id: auth.appId },
          select: { id: true, urn: true, name: true },
        });
        if (!app) return textResult('No accessible apps.');
        return textResult(
          `1 accessible app:\n\n- **${safeEmitEntityUrnV2('app', app.urn)}** — ${app.name} (via App Key)`,
        );
      }

      // Reaching here means we passed the auth gate AND are not AppKey-
      // scoped. In all current auth paths, that implies auth.userId is
      // set (OAuth bearer + portal-issued user-API-key both populate
      // userId). The clientId-only-no-userId case is unreachable in
      // production today; guard defensively so a future auth path that
      // populates clientId without userId can't crash here.
      if (!auth.userId) return textResult('No accessible apps.');
      const apps = await resolveUserAppsWithMeta(auth.userId, db);
      if (apps.length === 0) {
        return textResult(
          'No accessible apps. Ask an App owner to add you, or visit the Hadron portal to create one.',
        );
      }
      const lines = apps.map(
        (a) => `- **${safeEmitEntityUrnV2('app', a.urn)}** — ${a.name} (role: ${a.role})`,
      );
      const header =
        apps.length === 1
          ? `1 accessible app:`
          : `${apps.length} accessible apps:`;
      const trailer =
        apps.length === 1
          ? `\n\n(You only have one App, so hadron_set_active_app isn't required — it's already the active one by default.)`
          : '';
      return textResult(`${header}\n\n${lines.join('\n')}${trailer}`);
    },
  );

  // ── hadron_set_active_app (spec 026 regime c) ─────────────────────────────────

  server.tool(
    'hadron_set_active_app',
    "Set the active Hadron App for this session. Subsequent tools (hadron_find_nodes, hadron_create_node, etc.) will use this as the App scope. Pass the App URN (e.g. 'hrn:app:acme-corp:notes') or an App name that matches exactly one App you have access to. Use hadron_list_apps to see options.",
    SHAPE_HADRON_SET_ACTIVE_APP,
    async ({ app }) => {
      // Auth gate first; mark engaged only on real authenticated calls.
      if (auth.appId && !auth.userId) {
        // AppKey caller — App identity is in the credential. Return an
        // error envelope (not a plain text result) so disciplined clients
        // can programmatically distinguish misuse from a successful no-op.
        return appSelectionError(
          APP_SELECTION_ERROR_CODES.APP_NOT_FOUND,
          'AppKey callers already carry App identity in the credential; hadron_set_active_app is not applicable.',
        );
      }
      if (!auth.userId) {
        return refusalResult('Not authenticated.');
      }
      engagedWithNewSurface = true;

      const r = await resolveAppIdentifier(app, auth.userId, db);
      const sid = getSessionId();

      switch (r.kind) {
        case 'resolved': {
          pinActiveApp(r.app.id, r.app.organizationId, 'selection');
          // #1012: remember it for this client instance, so the next reconnect
          // restores it instead of silently dropping it.
          await saveActiveApp(db, auth, clientKey, r.app.id);
          mcpLog('info', 'regime_c_selection_set', {
            userId: auth.userId,
            mcpSessionId: sid,
            appId: r.app.id,
            appUrn: r.app.urn,
          });
          return textResult(
            `Active App set to: **${safeEmitEntityUrnV2('app', r.app.urn)}** (${r.app.name}). Subsequent App-scoped tools will operate against this App. Call hadron_set_active_app again with a different identifier to switch, or hadron_list_apps to see other options.`,
          );
        }
        case 'ambiguous': {
          const candidatesText = r.candidates
            .map((c) => `  - ${safeEmitEntityUrnV2('app', c.urn)}`)
            .join('\n');
          mcpLog('warn', 'app_identifier_ambiguous', {
            userId: auth.userId,
            mcpSessionId: sid,
            submittedIdentifier: app,
            candidateCount: r.candidates.length,
          });
          return appSelectionError(
            APP_SELECTION_ERROR_CODES.APP_IDENTIFIER_AMBIGUOUS,
            `Multiple Apps match '${app}'. Try the URN form to disambiguate:\n${candidatesText}`,
          );
        }
        case 'unavailable': {
          return appSelectionError(
            APP_SELECTION_ERROR_CODES.APP_UNAVAILABLE,
            `App '${app}' is no longer available (${r.reason}). Ask the App owner to reinstall, or pick another with hadron_list_apps.`,
          );
        }
        case 'not-member': {
          return appSelectionError(
            APP_SELECTION_ERROR_CODES.APP_NOT_FOUND,
            `No accessible App matches '${app}'. Use hadron_list_apps to see what's available.`,
          );
        }
        case 'not-found': {
          return appSelectionError(
            APP_SELECTION_ERROR_CODES.APP_NOT_FOUND,
            `No accessible App matches '${app}'. Use hadron_list_apps to see what's available.`,
          );
        }
      }
    },
  );

  // ── hadron_set_active_org (spec 049 Phase 1, D-2026-09-13-003) ──────────────

  server.tool(
    'hadron_set_active_org',
    'Set — or with clear:true, drop — the active ORGANIZATION for this client (spec 049 / D-2026-09-13-003): the tenancy an org-scoped read runs against (the cor:api:100 org view), persisted per client instance like hadron_set_active_app. You need it only when you belong to SEVERAL organizations and neither the call nor an org-owned active App names one; the resolution ladder is: an org named in the call › the active App\'s organization when that App is org-owned (a personal App has none) › this selection › your single membership › no membership at all ⇒ your own user-owned memories. With two or more memberships and none of those, org-scoped reads refuse with ORG_REQUIRED and list your memberships. Selecting an organization is not a search scope and attaches nothing: the org picks the tenancy, a scope (spec 049 Phase 3) picks the view. AppKey callers carry their org in the credential and cannot use this. hadron_server_info reports the currently resolved organization and which rung chose it — and, while yours is unresolved, lists your selectable organizations (#1372).',
    SHAPE_HADRON_SET_ACTIVE_ORG,
    async ({ org, clear }) => {
      if (auth.appId && !auth.userId) {
        return appSelectionError(
          APP_SELECTION_ERROR_CODES.ORG_NOT_FOUND,
          'AppKey callers carry their organization in the credential; hadron_set_active_org is not applicable.',
        );
      }
      if (!auth.userId) return refusalResult('Not authenticated.');
      // A support view sees into ONE org already and must not re-point itself
      // (belt and braces — /mcp rejects impersonation at session init).
      if (auth.impersonation) {
        return refusalResult('Not available in an impersonation session.');
      }
      const sid = getSessionId();

      if (!org) {
        if (clear) {
          activeOrgId = undefined;
          await saveActiveOrg(db, auth, clientKey, null);
          mcpLog('info', 'active_org_cleared', { userId: auth.userId, mcpSessionId: sid });
          const now = await currentActiveOrg();
          return textResult(
            `Active organization selection cleared. ` +
              (now.kind === 'org'
                ? `The ladder now resolves to ${await renderOrgLine(now.organizationId)} (via ${now.source}).`
                : now.kind === 'user-owned'
                  ? 'You belong to no organization, so org-scoped reads use your own user-owned memories.'
                  : `You belong to ${now.memberOrgIds.length} organizations and none is selected, so the scope ladder will refuse org-scoped reads with org_required until one is named or selected:\n${await renderMemberOrgs(now.memberOrgIds)}`),
          );
        }
        return appSelectionError(
          APP_SELECTION_ERROR_CODES.ORG_NOT_FOUND,
          'Pass org (an organization URN or id you are a member of), or clear: true.',
        );
      }

      // Resolve the ref, then gate on CURRENT membership through the shared
      // ladder — the same predicate the org-scoped queries use, so a caller can
      // select exactly the orgs those queries would admit. A nonexistent org and
      // a foreign one answer identically: no existence disclosure.
      let namedOrgId: string | null = null;
      try {
        ({ id: namedOrgId } = await resolveOrgRef(db, org));
      } catch (e) {
        // Only "no such org" and "not a well-formed ref" are the caller's
        // input; anything else (a DB failure, an ambiguous legacy alias) must
        // surface rather than read as org_not_found (Copilot on PR #1158).
        if (!(e instanceof OrganizationNotFoundError) && !(e instanceof UrnNotQualifiedError)) throw e;
        namedOrgId = null;
      }
      const r = namedOrgId
        ? await currentActiveOrg(namedOrgId)
        : ({ kind: 'required', reason: 'named_not_member', memberOrgIds: [] } as const);
      if (r.kind !== 'org') {
        mcpLog('warn', 'active_org_not_member', { userId: auth.userId, mcpSessionId: sid, submitted: org });
        const members = await getMemberOrgIds(db, auth.userId);
        return appSelectionError(
          APP_SELECTION_ERROR_CODES.ORG_NOT_FOUND,
          `No organization you are a member of matches '${org}'. Your memberships:\n${await renderMemberOrgs(members)}`,
        );
      }

      activeOrgId = r.organizationId;
      await saveActiveOrg(db, auth, clientKey, r.organizationId);
      mcpLog('info', 'active_org_set', { userId: auth.userId, mcpSessionId: sid, organizationId: r.organizationId });

      // Say when the selection is NOT what decides — an org-owned active App
      // outranks it, and a caller who just selected B while App-pinned to A
      // would otherwise read A's results as B's.
      const effective = await currentActiveOrg();
      const outranked =
        effective.kind === 'org' && effective.organizationId !== r.organizationId
          ? ` Note: your active App is owned by ${await renderOrgLine(effective.organizationId)}, which outranks this selection while it is active — the ladder resolves to that organization until you switch or clear the App.`
          : '';
      return textResult(
        `Active organization set to ${await renderOrgLine(r.organizationId)} and stored for this client. It is the ladder's third rung: a call that names an organization, or an org-owned active App, outranks it. hadron_server_info reports what currently resolves; the scope ladder (spec 049 Phase 3) is the read surface that consumes it.${outranked}`,
      );
    },
  );

  /** `<urn> (<name>)` for one org, for receipts. */
  async function renderOrgLine(orgId: string): Promise<string> {
    const o = await db.organization.findUnique({ where: { id: orgId }, select: { urn: true, name: true } });
    return o ? `**${safeEmitEntityUrnV2('org', o.urn)}** (${o.name})` : orgId;
  }

  // ── #1609 — comment nodes (cor:dmo:110): thin over the GraphQL comment resolvers ──
  registerCommentTools(server, { db, auth });
  registerAssetTools(server, { db, auth });

  // ── #1632 — signing requests (cor:dmo:130): request and read, never sign ──
  registerSigningTools(server, { db, auth });

  // ── #1705 — agent tasks (cor:agt:050): thin over the GraphQL agent-task resolvers ──
  registerAgentTaskTools(server, { db, auth });
  registerTickerTools(server, { db, auth });
  registerStopSignalTools(server, { db, auth });
  registerAutomationPinTools(server, { db, auth });
  // #1892 — an Agent's task and process lists (cor:dmo:050:15, :16).
  registerAgentDefinitionTools(server, { db, auth });

  // ── Spec 049 Phase 2 — scopes: list / create / update / delete / explain ──────
  //
  // Thin over the SAME resolvers GraphQL serves (`resolvers.scope.ts` →
  // `lib/scopes.ts`): the desktop track needs CRUD on MCP (#1150), and two
  // entry points over one computation is how the two surfaces stay in parity.

  /** GraphQL Context for the scope tools — appId + sessionId are load-bearing (#206). */
  const scopeCtx = (): Context => ({
    db,
    clientId: auth.clientId ?? undefined,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId, // #1868: the shared authorized tx re-checks the presented key
    appId: auth.appId ?? undefined,
    sessionId: auth.sessionId ?? undefined,
    roles: auth.roles as Context['roles'],
    organizationId: auth.organizationId ?? undefined,
  });

  // #2175: explicit recovery twins delegate to the same writer-plus-reader resolver gate.
  const recoveryCtx = (): Context => ({ ...scopeCtx(), appKeyId: auth.appKeyId ?? undefined,
    impersonation: auth.impersonation ?? undefined });
  const recoveryCall = async (work: () => Promise<ReturnType<typeof textResult>>) => {
    try { return await work(); }
    catch (error) {
      return { ...toolErrorResult(error, () => {
        if (error instanceof ScopeGraphQLError) return `[${String(error.extensions.code ?? 'ERROR').toLowerCase()}] ${error.message}`;
        if (error instanceof MemoryNotFoundError) return '[not_found] Memory not found.';
        if (error instanceof UrnNotQualifiedError) return `[bad_user_input] ${error.message}`;
        throw error;
      }, 'node_recovery'), isError: true as const };
    }
  };
  server.tool('hadron_list_recovery_nodes', 'List retained deleted nodes in one live memory that you can read and write. Ordinary reads return live nodes only.',
    recoveryPageArgs, async (args) => recoveryCall(async () => textResult(JSON.stringify(await resolvers.Query.recoveryNodes({}, args, recoveryCtx())))));
  server.tool('hadron_list_recovery_edges', 'Inspect live edges and accessible deleted endpoints in one memory that you can read and write. Unavailable endpoints are excluded from the page and total.',
    recoveryEdgesArgs, async (args) => recoveryCall(async () => textResult(JSON.stringify(await resolvers.Query.recoveryEdges({}, args, recoveryCtx())))));
  server.tool('hadron_get_recovery_node', 'Read retained deleted-node content in a live memory that you can read and write. Returns the stored body without expanding templates or includes.',
    SHAPE_HADRON_GET_RECOVERY_NODE, async (args) => recoveryCall(async () => {
      const ctx = recoveryCtx();
      const retained = await resolvers.Query.recoveryNode({}, args, ctx);
      if (!retained) return { ...textResult('[not_found] No deleted node you can recover at that reference.'), isError: true as const };
      const { _retainedNode: _internal, ...dto } = retained;
      const content = await resolvers.RecoveryNode.content(retained as never, {}, ctx);
      return textResult(JSON.stringify({ ...dto, content }));
    }));
  server.tool('hadron_restore_node', 'Restore one retained deleted node in a live memory that you can read and write. Restore deleted ancestors first. Governed nodes, comments, compiled boot prompts and protected internal addresses refuse. Does not restore descendants or revisions.',
    SHAPE_HADRON_RESTORE_NODE, async (args) => recoveryCall(async () => {
      const restored = await resolvers.Mutation.restoreNode({}, args, recoveryCtx());
      return textResult(JSON.stringify({ id: restored.id, loc: restored.loc, memoryId: restored.memoryId, deletedAt: restored.deletedAt }));
    }));

  /** A resolver refusal as `[<code>] <message>` text, the app-selection envelope convention. */
  const scopeErrorText = (e: unknown) => {
    if (e instanceof ScopeGraphQLError) {
      return refusalResult(`[${String(e.extensions?.code ?? 'ERROR').toLowerCase()}] ${e.message}`);
    }
    // A ref that names nothing is the caller's input, not a server fault
    // (Copilot on PR #1160): keep it inside the `[code]` envelope.
    if (
      e instanceof AppNotFoundError ||
      e instanceof AgentNotFoundError ||
      e instanceof OrganizationNotFoundError ||
      e instanceof MemoryNotFoundError
    ) {
      return refusalResult(`[not_found] No match for "${(e as { ref?: string }).ref ?? ''}".`);
    }
    if (e instanceof UrnNotQualifiedError) return refusalResult(`[bad_user_input] ${e.message}`);
    throw e;
  };

  type ScopeRow = { id: string; name: string; description: string | null; organizationId: string | null; agentId: string | null; appId: string | null };

  /**
   * A PAGE of scopes rendered for the caller — owner, id, readable memories in
   * order, hidden count — in a fixed number of queries whatever the page size:
   * one for the join rows (live memories only), one for their memories, one per
   * owner kind, and the accessible set computed ONCE (Copilot on PR #1160: the
   * per-scope field resolvers recomputed it twice per row, ~5 queries × 200).
   */
  async function renderScopes(ctx: Context, scopes: ScopeRow[]): Promise<string[]> {
    if (scopes.length === 0) return [];
    const ids = scopes.map((s) => s.id);
    const [joins, accessible, orgs, agents, apps] = await Promise.all([
      db.scopeMemory.findMany({
        where: { scopeId: { in: ids }, memory: { deletedAt: null } },
        orderBy: { position: 'asc' },
        select: { scopeId: true, memoryId: true, position: true, memory: { select: { urn: true } } },
      }),
      // The GraphQL gate, not the MCP one: the Scope field resolvers project
      // through it, and the two surfaces must render one list (the MCP gate
      // still denies an owner's app-scoped personal memory — the known parity
      // gap, `feedback:memory-access-gate-parity`).
      gqlAccessibleMemoryIds(ctx),
      db.organization.findMany({ where: { id: { in: scopes.map((s) => s.organizationId).filter((x): x is string => !!x) } }, select: { id: true, urn: true } }),
      db.agent.findMany({ where: { id: { in: scopes.map((s) => s.agentId).filter((x): x is string => !!x) } }, select: { id: true, urn: true } }),
      db.app.findMany({ where: { id: { in: scopes.map((s) => s.appId).filter((x): x is string => !!x) } }, select: { id: true, urn: true } }),
    ]);
    const readable = accessible === null ? null : new Set(accessible);
    const urnOf = { org: new Map(orgs.map((o) => [o.id, o.urn])), agent: new Map(agents.map((a) => [a.id, a.urn])), app: new Map(apps.map((a) => [a.id, a.urn])) };
    return scopes.map((s) => {
      const kind = s.appId ? 'app' : s.agentId ? 'agent' : 'org';
      const ownerId = (s.appId ?? s.agentId ?? s.organizationId) as string;
      const ownerUrn = urnOf[kind].get(ownerId);
      const ownerLabel = ownerUrn ? safeEmitEntityUrnV2(kind, ownerUrn) : ownerId;
      const mine = joins.filter((j) => j.scopeId === s.id);
      const shown = mine.filter((j) => readable === null || readable.has(j.memoryId));
      const hidden = mine.length - shown.length;
      const lines = [
        `**${s.name}** — ${kind === 'org' ? 'organization' : kind}-owned by ${ownerLabel} · id ${s.id}` + (s.description ? ` — ${s.description}` : ''),
        ...shown.map((j) => `  ${j.position + 1}. ${safeEmitEntityUrnV2('memory', j.memory.urn)}`),
      ];
      if (hidden > 0) lines.push(`  (+${hidden} ${hidden === 1 ? 'memory' : 'memories'} you cannot read)`);
      return lines.join('\n');
    });
  }
  const renderScope = async (ctx: Context, s: ScopeRow): Promise<string> => (await renderScopes(ctx, [s]))[0];

  server.tool(
    'hadron_list_scopes',
    'List the named search scopes ("lenses", spec 049) you may read — an ORDERED memory list with exactly one owner (organization | Agent | App). With no filter, lists the active App\'s resolution CONTEXT: the App\'s own scopes, its installed Agents\', and its organization\'s — what a bare scope name resolves against there (App › Agent › organization, never unioned). A scope never grants: each shows only the memories YOU may read, plus a count of the rest. Names `global` and `app` are the ladder\'s built-in views, not scopes.',
    SHAPE_HADRON_LIST_SCOPES,
    async ({ app, ownerType, ownerRef, name, limit, offset }) => {
      if (!auth.userId && !auth.appId) return refusalResult('Not authenticated.');
      const ctx = scopeCtx();
      const appRef = app ?? (ownerRef ? undefined : auth.appId);
      try {
        const page = await resolvers.Query.scopes({}, { filter: { appRef, ownerType, ownerRef, name }, limit, offset }, ctx);
        if (page.items.length === 0) {
          return textResult(
            page.total === 0
              ? `No scopes${appRef ? ' in this App\'s context' : ''}. Create one with hadron_create_scope; \`app\` and \`global\` are always available as the ladder\'s built-in views.`
              : `${page.total} scope(s), none on this page.`,
          );
        }
        const rendered = await renderScopes(ctx, page.items);
        return textResult(`${page.total} scope(s)${appRef ? ' in this App\'s context' : ''}:\n\n${rendered.join('\n\n')}`);
      } catch (e) {
        return scopeErrorText(e);
      }
    },
  );

  server.tool(
    'hadron_create_scope',
    'Create a named search scope (spec 049): an ORDERED list of memories owned by exactly one of an organization, an Agent, or an App. Pass one owner ref, or none to own it by the active App. Every memory must be one you can read (an unreadable one reads as "no match"). Names: 1–64 of [a-z0-9_-], unique per owner; `global` and `app` are reserved. Auth: organization CONTRIBUTOR+; App / Agent ADMIN of the owning org or the owner of a user-owned one.',
    SHAPE_HADRON_CREATE_SCOPE,
    async ({ name, memoryUrns, description, organizationRef, agentRef, appRef }) => {
      if (!auth.userId) return refusalResult('Not authenticated — scopes are created by a user, not an App key.');
      const ctx = scopeCtx();
      const owner = { organizationRef, agentRef, appRef: appRef ?? (organizationRef || agentRef ? undefined : auth.appId) };
      if (!owner.organizationRef && !owner.agentRef && !owner.appRef) {
        return refusalResult('[bad_user_input] No owner: pass organizationRef, agentRef or appRef, or select an App with hadron_set_active_app first.');
      }
      try {
        const scope = await resolvers.Mutation.createScope({}, { input: { name, description, ...owner, memoryRefs: memoryUrns } }, ctx);
        return textResult(`Created.\n\n${await renderScope(ctx, scope)}\n\nSelect it for searches with hadron_set_active_scope (spec 049 Phase 3) or name it per call once that lands.`);
      } catch (e) {
        return scopeErrorText(e);
      }
    },
  );

  server.tool(
    'hadron_update_scope',
    'Update a scope you may write (auth as hadron_create_scope): rename, re-describe, or REPLACE its ordered memory list.',
    SHAPE_HADRON_UPDATE_SCOPE,
    async ({ scope, name, description, memoryUrns }) => {
      if (!auth.userId) return refusalResult('Not authenticated.');
      const ctx = scopeCtx();
      try {
        const updated = await resolvers.Mutation.updateScope({}, { ref: scope, input: { name, description, memoryRefs: memoryUrns } }, ctx);
        return textResult(`Updated.\n\n${await renderScope(ctx, updated)}`);
      } catch (e) {
        return scopeErrorText(e);
      }
    },
  );

  server.tool(
    'hadron_delete_scope',
    'Soft-delete a scope you may write; its name is free again at once. Deleting a scope attaches or detaches nothing — it was only ever a lens.',
    SHAPE_HADRON_DELETE_SCOPE,
    async ({ scope }) => {
      if (!auth.userId) return refusalResult('Not authenticated.');
      try {
        await resolvers.Mutation.deleteScope({}, { ref: scope }, scopeCtx());
        return textResult(`Scope ${scope} deleted.`);
      } catch (e) {
        return scopeErrorText(e);
      }
    },
  );

  server.tool(
    'hadron_scope_explain',
    'Explain what a scope resolves to FOR YOU (spec 049): the readable memories in scope order, how many were dropped for access (a count — a lens never grants and never names what you cannot read), which owner tier won when resolved by NAME in an App\'s context (App › Agent › organization, never unioned; two installed Agents each owning the name is ambiguous and you choose by id), the scopes it shadowed, and — with `loc` — which memory would win for that address.',
    SHAPE_HADRON_SCOPE_EXPLAIN,
    async ({ scope, name, app, loc }) => {
      if (!auth.userId && !auth.appId) return refusalResult('Not authenticated.');
      const ctx = scopeCtx();
      try {
        const ex = await resolvers.Query.scopeExplain({}, { scopeRef: scope, name, appRef: app ?? auth.appId, loc }, ctx);
        if (!ex) return textResult(`No readable scope matches${name ? ` "${name}" in this App's context` : ''}.`);
        const lines = [
          `**${ex.scope.name}** resolved via ${ex.resolvedVia.toLowerCase()} owner · id ${ex.scope.id}`,
          ...ex.memories.map((m, i) => `  ${i + 1}. ${safeEmitEntityUrnV2('memory', m.urn)}`),
        ];
        if (ex.droppedCount > 0) lines.push(`  (${ex.droppedCount} ${ex.droppedCount === 1 ? 'memory' : 'memories'} dropped — not readable by you)`);
        if (ex.shadowed.length) lines.push(`shadowed: ${ex.shadowed.map((s) => `${s.id} (${resolvers.Scope.ownerType(s).toLowerCase()})`).join(', ')}`);
        if (loc) lines.push(ex.winner ? `winner for "${loc}": ${safeEmitEntityUrnV2('memory', ex.winner.urn)}` : `winner for "${loc}": none — no readable memory in this scope holds that address`);
        return textResult(lines.join('\n'));
      } catch (e) {
        return scopeErrorText(e);
      }
    },
  );

  // ── Channels (spec 049 Phase 4, D-2026-09-13-006) ───────────────────────────

  /** One Channel as a line: id · name · loc · host memory · watermark. */
  const renderChannels = async (ctx: Context, rows: Array<{ id: string; name: string; loc: string; memoryId: string; lastSeq: number; lastMessageAt: Date | null; description: string | null }>) => {
    const memories = await ctx.db.memory.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.memoryId))] } },
      select: { id: true, urn: true },
    });
    const urnOf = new Map(memories.map((m) => [m.id, safeEmitEntityUrnV2('memory', m.urn)]));
    // #1171: the chat root's node URN is the Channel's ADDRESS — every
    // channelRef accepts it, so print it rather than leaving the id as the
    // only thing a caller can pass back. A host memory whose stored urn
    // predates v2 has no address that round-trips, and says so rather than
    // printing one the server would reject (Copilot on PR #1172).
    const bareUrnOf = new Map(memories.map((m) => [m.id, m.urn]));
    const addressLine = (memoryId: string, loc: string) => {
      const bare = bareUrnOf.get(memoryId);
      if (bare === undefined) return [];
      return nodeUrnRoundTrips(bare, loc)
        ? [`  address: ${safeNodeUrnV2(bare, loc)}`]
        : ['  address: none emitted — no flat-v2 address is safe to advertise for this host memory; address it by id'];
    };
    return rows.map((r) =>
      [
        `- ${r.name} (${r.loc}) — id ${r.id}`,
        ...addressLine(r.memoryId, r.loc),
        `  memory: ${urnOf.get(r.memoryId) ?? r.memoryId}`,
        `  messages: seq ≤ ${r.lastSeq}${r.lastMessageAt ? `, last ${r.lastMessageAt.toISOString()}` : ''}`,
        ...(r.description ? [`  ${r.description}`] : []),
      ].join('\n'),
    );
  };

  server.tool(
    'hadron_list_channels',
    'List the Channels (spec 049 — durable, server-ordered message streams; each hosted at ONE reserved address in ONE memory) whose host memory you may read. Default: the active App\'s. Every App has a default Channel `team` at chats:team — what hadron_team_chat_post writes to. A Channel\'s address is PROTECTED: generic node writes under it are refused ([loc_protected]).',
    SHAPE_HADRON_LIST_CHANNELS,
    async ({ app, memory, limit, offset }) => {
      if (!auth.userId && !auth.appId) return refusalResult('Not authenticated.');
      const ctx = scopeCtx();
      const appRef = memory ? undefined : (app ?? auth.appId ?? undefined);
      if (!appRef && !memory) return refusalResult('[bad_user_input] Pass app or memory, or select an App with hadron_set_active_app first.');
      try {
        const page = await resolvers.Query.channels({}, { filter: { appRef, memoryRef: memory }, limit, offset }, ctx);
        if (page.total === 0) return textResult('No channels you may read there.');
        const lines = await renderChannels(ctx, page.items);
        return textResult(`${page.total} channel${page.total === 1 ? '' : 's'}:\n\n${lines.join('\n')}`);
      } catch (e) {
        return scopeErrorText(e);
      }
    },
  );

  server.tool(
    'hadron_create_channel',
    'Create a named Channel WITH its chat root (spec 049), in ANY memory class you may write — the host memory\'s own audience decides who reads and posts (cor:acl:030:01), so a Channel in a private memory is private. `loc` is the reserved address (e.g. chats:release) — it must not overlap an existing Channel\'s. Every App already has `team` at chats:team. Creating at a DELETED Channel\'s address reuses it and starts CLEAN: the old transcript is tombstoned, the empty Channel watermarks reset, and its first new message resumes above the old seq maximum so old read cursors cannot hide it (#1226).',
    SHAPE_HADRON_CREATE_CHANNEL,
    async ({ memory, loc, name, description }) => {
      if (!auth.userId) return refusalResult('Not authenticated — Channels are created by a user, not an App key.');
      const ctx = scopeCtx();
      try {
        const row = await resolvers.Mutation.createChannel({}, { input: { memoryRef: memory, loc, name, description } }, ctx);
        const lines = await renderChannels(ctx, [row]);
        return textResult(`Created.\n\n${lines.join('\n')}\n\nThe address ${row.loc} is now protected: only the Channel's own operations write there.`);
      } catch (e) {
        return scopeErrorText(e);
      }
    },
  );

  // ── The chat register (spec 049 Phase 5, D-2026-09-13-007) ──────────────────

  /**
   * Register rows as lines: owner · channel · attendee · role. The Channel's
   * name and address are shown only when the caller may read its host memory
   * — the same gate `RegisterEntry.channel` applies (Codex P1 on PR #1166: an
   * owner-side reader gets the row, never a foreign Channel's details).
   * Attendees are batch-loaded, one query per kind (Copilot).
   */
  const renderRegisterRows = async (
    ctx: Context,
    rows: Array<{ id: string; organizationId: string | null; appId: string | null; channelId: string; attendeeWorkerId: string | null; attendeeAgentId: string | null; role: string; mentionOnly: boolean; installDefault: boolean; description: string | null }>,
  ) => {
    const accessible = await gqlAccessibleMemoryIds(ctx);
    const channels = new Map(
      (await ctx.db.channel.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.channelId))] } }, select: { id: true, name: true, loc: true, memoryId: true } })).map((c) => [c.id, c]),
    );
    const workerIds = [...new Set(rows.map((r) => r.attendeeWorkerId).filter((x): x is string => !!x))];
    const agentIds = [...new Set(rows.map((r) => r.attendeeAgentId).filter((x): x is string => !!x))];
    const workers = new Map(
      (workerIds.length
        ? await ctx.db.worker.findMany({ where: { id: { in: workerIds } }, select: { id: true, slug: true, app: { select: { urn: true } } } })
        : []
      ).map((w) => [w.id, w]),
    );
    const agents = new Map(
      (agentIds.length ? await ctx.db.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, urn: true } }) : []).map((a) => [a.id, a]),
    );
    const attendeeOf = (r: { attendeeWorkerId: string | null; attendeeAgentId: string | null }) => {
      if (r.attendeeWorkerId) {
        const w = workers.get(r.attendeeWorkerId);
        try {
          return w ? composeWorkerUrn(normalizeUrnForLookup(w.app.urn), w.slug) : r.attendeeWorkerId;
        } catch {
          return r.attendeeWorkerId;
        }
      }
      if (r.attendeeAgentId) return agents.get(r.attendeeAgentId)?.urn ?? r.attendeeAgentId;
      return 'every attendee';
    };
    return rows.map((r) => {
      const ch = channels.get(r.channelId);
      const readable = !!ch && (accessible === null || accessible.includes(ch.memoryId));
      const channel = readable ? `${ch!.name} (${ch!.loc})` : `channel ${r.channelId} (host memory not readable to you)`;
      return `- ${channel} ← ${attendeeOf(r)} — ${r.role}${r.mentionOnly ? ', mention-only' : ''}${r.installDefault ? ', install default' : ''}\n  owner: ${r.appId ? `App ${r.appId}` : `organization ${r.organizationId}`} · id ${r.id}${r.description ? `\n  ${r.description}` : ''}`;
    });
  };

  server.tool(
    'hadron_register_list',
    'List the chat REGISTER (spec 049): which attendee (a Worker, or an Agent in an App — or everyone in the owner\'s context) takes part in which Channel, as declared by the App or its organization. Intent, never permission: what an attendee may actually read or post is the Channel\'s host memory\'s decision. Default: the active App\'s rows. Every install carries a materialised default row for the App\'s `team` Channel.',
    SHAPE_HADRON_REGISTER_LIST,
    async ({ owner, channel, attendee, limit, offset }) => {
      if (!auth.userId && !auth.appId) return refusalResult('Not authenticated.');
      const ctx = scopeCtx();
      const ownerRef = owner ?? (channel || attendee ? undefined : (auth.appId ?? undefined));
      if (!ownerRef && !channel && !attendee) return refusalResult('[bad_user_input] Pass owner, channel or attendee, or select an App with hadron_set_active_app first.');
      try {
        const page = await resolvers.Query.registerEntries({}, { filter: { ownerRef, channelRef: channel, attendeeRef: attendee }, limit, offset }, ctx);
        if (page.total === 0) return textResult('No register entries you may read there.');
        const lines = await renderRegisterRows(ctx, page.items);
        return textResult(`${page.total} register entr${page.total === 1 ? 'y' : 'ies'}:\n\n${lines.join('\n')}`);
      } catch (e) {
        return scopeErrorText(e);
      }
    },
  );

  server.tool(
    'hadron_register_add',
    'Declare that an attendee takes part in a Channel (spec 049 register). Owner: an App (org ADMIN, or the owner of a user-owned App) or an organization (CONTRIBUTOR+); defaults to the active App. attendee: a Worker or an Agent in the owner\'s context; omit it for every attendee there. Intent, never permission — the row grants nothing.',
    SHAPE_HADRON_REGISTER_ADD,
    async ({ channel, attendee, owner, role, mentionOnly, description }) => {
      if (!auth.userId) return refusalResult('Not authenticated — register rows are written by a user, not an App key.');
      const ctx = scopeCtx();
      const ownerRef = owner ?? auth.appId;
      if (!ownerRef) return refusalResult('[bad_user_input] No owner: pass owner, or select an App with hadron_set_active_app first.');
      try {
        const row = await resolvers.Mutation.createRegisterEntry(
          {},
          { input: { ownerRef, channelRef: channel, attendeeRef: attendee, role, mentionOnly, description } },
          ctx,
        );
        const lines = await renderRegisterRows(ctx, [row]);
        return textResult(`Added.\n\n${lines.join('\n')}`);
      } catch (e) {
        return scopeErrorText(e);
      }
    },
  );

  server.tool(
    'hadron_register_remove',
    'Remove a register entry you own (spec 049): each owner removes its own rows — an App may remove its install-created default, never an organization\'s row.',
    SHAPE_HADRON_REGISTER_REMOVE,
    async ({ entry }) => {
      if (!auth.userId) return refusalResult('Not authenticated — register rows are written by a user, not an App key.');
      try {
        await resolvers.Mutation.deleteRegisterEntry({}, { ref: entry }, scopeCtx());
        return textResult('Removed.');
      } catch (e) {
        return scopeErrorText(e);
      }
    },
  );

  // ── hadron_set_active_scope (spec 049 Phase 3, D-2026-09-13-002) ────────────

  server.tool(
    'hadron_set_active_scope',
    'Set — or with clear:true, drop — the ACTIVE SCOPE for this client (spec 049): the named search scope hadron_find_nodes / hadron_search run under when the call names no scope and no memory. Rung 2 of the ladder: a scope named in the call › this › the active App (`app`, its attached memories) › the active organization (`global`) › your user-owned memories. Persisted per client instance like hadron_set_active_app and re-authorized on restore. A scope never grants: results are its memories ∩ what you may read, and every result says which scope it ran under.',
    SHAPE_HADRON_SET_ACTIVE_SCOPE,
    async ({ scope, clear }) => {
      if (!auth.userId) return refusalResult('Not authenticated — an App key\'s scope is its App.');
      if (auth.impersonation) return refusalResult('Not available in an impersonation session.');
      const ctx = scopeCtx();
      if (!scope) {
        if (!clear) return refusalResult('[bad_user_input] Pass scope (an id or a name), or clear: true.');
        activeScopeId = undefined;
        await saveActiveScope(db, auth, clientKey, null);
        const now = await mcpSearchScope(undefined, false).catch(() => null);
        return textResult(`Active scope cleared.${now ? ` Searches now run under: ${scopeNoteLine(now)}` : ''}`);
      }
      let row = await db.scope.findFirst({ where: { id: scope.trim(), deletedAt: null } });
      if (!row && auth.appId) {
        const r = await resolveScopeByNameInApp(ctx, scope.trim(), auth.appId);
        if (r.ambiguousAmong.length) {
          return refusalResult(`[scope_name_ambiguous] "${scope}" is owned by ${r.ambiguousAmong.length} Agents installed in this App; pass an id: ${r.ambiguousAmong.map((s) => s.id).join(', ')}.`);
        }
        row = r.winner;
      }
      if (!row || !(await canReadScope(ctx, row))) {
        return refusalResult(`[not_found] No readable scope matches "${scope}"${auth.appId ? '' : ' — a bare name needs an active App; pass the scope id or select an App first'}. See hadron_list_scopes.`);
      }
      activeScopeId = row.id;
      await saveActiveScope(db, auth, clientKey, row.id);
      mcpLog('info', 'active_scope_set', { userId: auth.userId, mcpSessionId: getSessionId(), scopeId: row.id });
      const now = await mcpSearchScope(undefined, false);
      return textResult(`Active scope set to "${row.name}" (id ${row.id}) and stored for this client.${now ? `\n${scopeNoteLine(now)}` : ''}`);
    },
  );

  // ── hadron_create_parent_node ───────────────────────────────────────────────────

  server.tool(
    'hadron_create_parent_node',
    'Create a parent (section/category) node in the memory graph. Lightweight container for organizing nodes. The URN MUST be fully qualified (hrn:node:<root>:<memory>:<loc>).',
    SHAPE_HADRON_CREATE_PARENT_NODE,
    async ({ urn: rawUrn, name: rawName, description, tags }) => {
      // Spec 022: qualification at the API boundary.
      try {
        assertFullyQualifiedUrn(rawUrn, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return refusalResult(e.message);
        throw e;
      }

      const { memoryUrn, loc, fragment } = splitNodeUrn(rawUrn);
      const fragRefusal = nodeFragmentRefusal(rawUrn, fragment);
      if (fragRefusal) return refusalResult(fragRefusal);
      // #1316: hidden from this caller ⇒ the missing branch; a reader keeps the denial.
      const memory = await resolveVisibleMemoryByUrn(auth, memoryUrn, 'write');
      if (!memory) {
        return refusalResult(`Memory not found: "${memoryUrn}".`);
      }
      const memoryId = memory.id;
      // Default name to the last loc atom (e.g. `services:db-helpers` → `db-helpers`).
      const name = rawName ?? loc.split(':').pop()!;
      const content = description ?? `Section: ${name}`;

      try {
        validateLoc(loc);
      } catch (e) {
        return e instanceof InvalidLocError ? refusalResult(e.message) : toolErrorResult(e, () => (e as Error).message, 'hadron_create_parent_node:validateLoc');
      }

      if (!(await canWriteToMemory(db, auth, memoryId, EXPLICIT_REF))) {
        return refusalResult(`Write access denied for this memory.${await explainWriteRefusal(db, auth, memoryId)}`);
      }

      const parentMemoryState = await db.memory.findUniqueOrThrow({
        where: { id: memoryId }, select: { isEncrypted: true },
      });
      const parentKey = parentMemoryState.isEncrypted
        ? sessionKeyCache.getByMemoryId(memoryId) : null;
      if (parentMemoryState.isEncrypted && !parentKey) {
        return textResult('This memory is encrypted and locked — call hadron_unlock_memory first (spec 041).');
      }
      const storedParentContent = parentKey
        ? encryptNodeFieldsWithKey({ content }, parentKey).content : content;

      // #1201 (@copilot, PR #1203 round 2). This helper writes through a RAW
      // upsert whose update branch preserves omitted fields, so pointed at an
      // existing review or runnable task it rewrites the node while keeping its
      // governed signals — a generic MCP surface editing a governed node, which
      // is the thing the gate exists to stop.
      //
      // It never SETS a governed signal (its create branch has neither), so the
      // only reachable case is the one above: an existing governed node. The
      // merge is still written as a merge rather than a bare read, because the
      // rule is "what does this write PRODUCE" and a shortcut here would be the
      // next thing to drift.
      const parentGovernedProbe = await db.node.findUnique({
        where: { loc_memoryId: { loc, memoryId } },
        select: { role: true, isRunnable: true, nodeType: true },
      });
      try {
        // #1606 (cor:dmo:110:04) — a comment is never rewritten as a section.
        assertNotCommentWrite(parentGovernedProbe?.nodeType, undefined, 'update');
        // #2043 — the same boot-prompt guards the shared writer applies.
        assertBootPromptWriteAllowed(parentGovernedProbe, {}, 'update');
        assertGovernedWrite(
          parentGovernedProbe,
          mergedGovernedState(parentGovernedProbe, {}),
          'update',
          // No route: a parent (section) write is not an edit the kind's
          // door performs.
        );
      } catch (e) {
        if (e instanceof RoleGovernedError || isCommentGovernedError(e)) return refusalResult(`[role_governed] ${(e as Error).message}`);
        throw e;
      }

      const upsertArgs = {
        where: { loc_memoryId: { loc, memoryId } },
        create: {
          id: generateId(),
          memoryId,
          loc,
          name,
          nodeType: 'info',
          description: description ?? null,
          content: storedParentContent,
          tags: tags ?? [],
          createdBy: auth.clientId ?? null,
        },
        update: {
          name,
          nodeType: 'info',
          description: description ?? null,
          content: storedParentContent,
          tags: tags ?? [],
        },
      };
      // #664 (Model A — see nodeSubtreeLock.ts): a section node is a hierarchy
      // parent, so creating it under a concurrently-deleted grandparent is
      // exactly the orphan race. Serialize against an ancestor-delete by holding
      // advisory locks on the ancestor path across the upsert, matching the
      // hadron_create_node / createNode paths. A root-level loc takes no
      // ancestor lock, but still goes through the helper: it is also the
      // spec 049 S4 protected-loc gate, and a root-level Channel address
      // was otherwise overwritable here (Codex P1 on PR #1165).
      let sectionId: string;
      let sectionContentSaved = false;
      let sectionPinStoredContent: string | null = null;
      try {
        sectionId = await db.$transaction(async (tx) => {
          // #2206 (Xan's parity ruling on #2233): an Agent definition's authority before any memory/node/loc lock.
          await lockAgentDefinitionAuthority(tx, auth.userId ?? null, memoryId);
          await lockAncestorsForCreate(tx, memoryId, loc);
          // #1323 (@copilot, PR #1339): re-saving an EXISTING live section is
          // an authoring write of name/description/content/tags, so it takes
          // the same revision protocol as hadron_update_node — row lock,
          // drift reconciled as its own revision, the real predecessor
          // snapshotted — instead of a bare upsert whose change the next read
          // would misattribute to a raw writer. A new row is baselined by the
          // insert trigger; a tombstone is left as the upsert leaves it.
          const prior = await tx.node.findUnique({
            where: { loc_memoryId: { loc, memoryId } },
            select: { id: true, deletedAt: true, role: true, isRunnable: true },
          });
          let sectionChanged = false;
          // #1331 — an existing section keeps its role through this write, so the
          // role's writer level applies to the edit (and to reviving a tombstone).
          if (prior) {
            // Lock the section row first (live or tombstone: node before rulebook), then judge its locked state. The
            // probe above is only a fast refusal; the generic owning-operation refusal is re-applied on the locked row.
            await tx.$queryRaw`SELECT "id" FROM "nodes" WHERE "id" = ${prior.id} FOR UPDATE`;
            const lockedSection = await tx.node.findUniqueOrThrow({
              where: { id: prior.id },
              select: { loc: true, memoryId: true, role: true, isRunnable: true, nodeType: true },
            });
            if (lockedSection.loc !== loc || lockedSection.memoryId !== memoryId) {
              throw new NodeMovedDuringWriteError(
                `[write_conflict] the section at "${loc}" moved while this write waited — re-read and retry.`,
              );
            }
            assertNotCommentWrite(lockedSection.nodeType, undefined, 'update');
            assertGovernedWrite(lockedSection, mergedGovernedState(lockedSection, {}), 'update');
            await assertRoleWritersForWrite(tx, auth, memoryId, {
              priorRole: lockedSection.role, nextRole: lockedSection.role,
              priorRunnable: lockedSection.isRunnable, nextRunnable: lockedSection.isRunnable,
            });
          }
          let storedForIncludes: string | null = null;
          if (prior && !prior.deletedAt) {
            await tx.$queryRaw`SELECT "id" FROM "nodes" WHERE "id" = ${prior.id} FOR UPDATE`;
            await assertMemoryEncryptionStateForWrite(tx, memoryId, parentMemoryState.isEncrypted, auth);
            // Reconcile only while the row is still in this memory.
            await ensureCurrentNodeRevisionInTransaction(tx, prior.id, { expectedMemoryId: memoryId });
            const current = await tx.node.findUniqueOrThrow({ where: { id: prior.id } });
            // Found by (loc, memory), locked by id: a row that moved or was
            // deleted in between refuses (@copilot, PR #1339).
            if (current.loc !== loc || current.memoryId !== memoryId || current.deletedAt) {
              throw new NodeMovedDuringWriteError(
                `[write_conflict] the section at "${loc}" moved while this write waited — re-read and retry.`,
              );
            }
            // #1468 — a re-save writes omitted tags as [], which must not
            // strip the marker off a minted spec.
            await assertNoMintedSpecUnmark(tx, memoryId, [{ id: current.id, tags: upsertArgs.update.tags }], 're-save');
            // Compare logical plaintext. Fresh AES-GCM ciphertext differs on
            // every save even when the section body is unchanged.
            const currentForDiff = parentKey
              ? decryptNodeFieldsWithKey({ ...current }, parentKey)
              : current;
            storedForIncludes = (currentForDiff.content as string | null) ?? null;
            const changes = diffNodeChanges(currentForDiff, {
              ...upsertArgs.update, content,
            });
            if (changes.length === 0) return current.id;
            sectionChanged = authoredContentChanged(changes);
            await createNodeRevision(tx, {
              id: generateId(),
              ...buildNodeRevisionSnapshot(current, editorFromAuth(auth), { changes }),
            });
          }
          if (prior?.deletedAt) {
            // #1468 — the upsert rewrites a tombstone's tags too (keeping it
            // deleted), and a post-mint spec tombstone must stay marked.
            await assertNoMintedSpecUnmark(tx, memoryId, [{ id: prior.id, tags: upsertArgs.update.tags }], 're-save');
          }
          if (!prior || prior.deletedAt) {
            await assertMemoryEncryptionStateForWrite(tx, memoryId, parentMemoryState.isEncrypted, auth);
          }
          const row = await tx.node.upsert({
            ...upsertArgs,
            update: { ...upsertArgs.update, ...(sectionChanged ? clearNodeAuthorship() : {}), revisionContentHash: revisionStateHashRefreshMarker() },
          });
          await applyIncludesInTransaction(tx, row, content, auth, storedForIncludes);
          sectionContentSaved = true;
          sectionPinStoredContent = storedForIncludes;
          return row.id;
        });
      } catch (e) {
        if (e instanceof LocProtectedError) return refusalResult(`[loc_protected] ${e.message}`);
        if (e instanceof NodeMovedDuringWriteError) return refusalResult(e.message);
        if (e instanceof MemoryEncryptionChangedDuringWriteError) return refusalResult(e.message);
        if (e instanceof MemoryWriteAccessChangedDuringWriteError) return refusalResult(e.message);
        if (e instanceof RoleGovernedError || isCommentGovernedError(e)) return refusalResult(`[role_governed] ${(e as Error).message}`);
        const includeText = includeRefusalText(e);
        if (includeText) return refusalResult(includeText);
        const writerRefusal = roleWriterRefusalText(e);
        if (writerRefusal) return refusalResult(writerRefusal);
        if (e instanceof ScopeGraphQLError && e.extensions?.code === SPEC_MINTED_PERMANENT) {
          return refusalResult(`[spec_minted_permanent] ${e.message}`);
        }
        throw e;
      }

      // #1061 — a section node is a node; creating or re-saving one is a write,
      // recorded exactly as hadron_create_node's is.
      recordNodeWrite(db, { id: sectionId, loc, memoryId }, auth);

      const urn = await nodeUrn(loc, memoryId);
      return textResult(`Node saved: ${urn}${sectionContentSaved ? renderIncludePinWarnings(await safePlainPinWarnings(scopeCtx(), { memoryId }, content, sectionPinStoredContent)) : ''}`);
    },
  );

  // ── hadron_find_nodes ─────────────────────────────────────────────────────────

  server.tool(
    'hadron_find_nodes',
    'Relevance-ranked full-text search across nodes. Keyword mode (default) runs Postgres full-text search: terms are STEMMED (so "running" matches "run"), results are RANKED by field-weighted relevance (name/alias > loc/tags > description/abstract > body/data), and BODY + abstract ARE indexed. Boolean operators are supported — `(banana OR apple) AND shake`, quoted phrases, and `-term` / `NOT term` — operator words are UPPERCASE-ONLY (lowercase and/or/not are plain terms, so natural phrases search literally), and malformed boolean syntax degrades to a literal phrase search instead of erroring. A plain multi-word query ANDs its terms; if that matches nothing, the search auto-relaxes to OR (any term) and flags [degraded:and_relaxed_to_or] — so a single off-corpus word doesn\'t dead-end the query. Pass `query: "*"` (or `""`) to list every node (survey mode) — useful as a first pass before adding to a memory. mode:vector / mode:hybrid run semantic search over the memory\'s vector index; mode:regex matches a POSIX regular expression against node text. To browse the tree structure, use `hadron_list_nodes` instead. Scope with `parentRel` (a subtree), `memoryUrn` (one memory), or `memoryUrns` (a set); pass `allMemories: true` to search EVERY memory you can read — the stemmed, ranked org-wide "does anyone know about X?" probe (this is the right tool for cross-memory concept/content questions; hadron_search matches literal substrings only). Each scored hit shows its score as a percentage of the top hit; when many hits sit in a narrow band the result carries a [weak_results] note, meaning the ranking found nothing clearly relevant — treat that as "the answer is probably not here" rather than reading the whole list. Use `minScore` to drop weak hits and `limit` to widen the default 10-hit page. Soft-deleted nodes are excluded. Each hit in the default view carries a `URL:` line — the node\'s portal link; copy it verbatim when citing a source to a human rather than building a link from the URN (`brief: true` omits it, as it omits the abstract).',
    SHAPE_HADRON_FIND_NODES,
    async ({ query, mode, parentRel, memoryUrn, memoryUrns, allMemories, isRunnable, role, objectType, nodeType, nodeKind, brief, limit, minScore, expand, granularity, where, scope }) => {
      try {
        validateParentRel(parentRel);
      } catch (e) {
        if (e instanceof InvalidParentRelError) return refusalResult(e.message);
        throw e;
      }

      // PR2 (#403): delegate retrieval to resolvers.Query.findNodes (the unified
      // cor:api:090 engine) instead of re-implementing keyword/vector/hybrid
      // inline. This is what adopts the Postgres FTS keyword semantics (stemmed,
      // relevance-ranked, boolean operators, body + abstract indexed) on the MCP
      // surface. Scope resolution + the BOLA gates below stay HERE (the MCP
      // surface's memoryUrn / parentRel resolution, canReadMemory checks, and the
      // exact "not found" strings are its contract); the resolved scope is handed
      // to findNodes as filter.memoryIds / filter.locPrefix, and the envelope is
      // re-rendered into the tool's text output.
      const effectiveMode = mode ?? 'keyword';

      // Spec 033 US2 — chunk granularity requires explicit mode:vector. MCP's
      // default mode is keyword (no chunks); hybrid's RRF is node-level.
      if (granularity === 'chunk' && effectiveMode !== 'vector') {
        return textResult(
          `granularity:chunk requires mode:vector (got mode:${effectiveMode}). Hybrid + chunk passages is out of v1.`,
        );
      }

      // Survey mode: "*" / "" lists every node in the lexical modes, but is
      // meaningless to a vector embedder — reject it up front for vector/hybrid
      // (preserves the pre-delegation [empty_vector_query] contract). For the
      // lexical modes it maps to a query-omitted findNodes call (filtered list).
      // createTestableMcpServer bypasses zod validation (the test-parity gap),
      // so coerce a non-string query before .trim() rather than crash.
      const safeQuery = typeof query === 'string' ? query : '';
      const trimmedQuery = safeQuery.trim();
      const isSurvey = trimmedQuery === '' || trimmedQuery === '*';
      if (isSurvey && (effectiveMode === 'vector' || effectiveMode === 'hybrid')) {
        return textResult(
          `Note: empty or "*" queries are keyword-only (survey mode); supply a natural-language query for mode:${effectiveMode}. [empty_vector_query]\n\nFound 0 node(s).`,
        );
      }

      const trimmedParentRel = parentRel?.trim();
      const accessibleMemoryIds = await getAccessibleMemoryIds(db, auth);

      // App Key + active session hard-isolates reads to the session's memory
      // (+ the agent's system memory) — findNodes enforces this downstream
      // (getAccessibleMemoryIds, checked first, ahead of any role). The
      // pre-scope memoryUrn / parentRel gates enforce the SAME boundary and
      // preserve the contract's not-found envelope for a denied selector.
      // The MCP point-read map also applies the session scope (#324); this
      // explicit check keeps the envelope stable even if that map changes.
      let sessionMemoryIds: Set<string> | null = null;
      // #934: pure App-key shape only (`!auth.userId`) — mirrors the resolver
      // branch's guard: a user-credential caller's session binding is
      // heartbeat attribution, never a scope change.
      if (auth.appId && auth.sessionId && !auth.userId) {
        // #945: was a hand-copied duplicate of the resolver branch, so the
        // admissibility fix would have landed on one surface only. Both now
        // share `sessionScopedMemoryIds` — a foreign PUBLIC agent bound to the
        // session no longer drags its system memory into scope here either.
        sessionMemoryIds = new Set<string>(
          await sessionScopedMemoryIds(db, auth.appId, auth.sessionId),
        );
      }

      // Resolved scope handed to findNodes. When neither memoryUrn nor a
      // memory-resolvable parentRel is supplied, both stay undefined and
      // findNodes falls back to its own accessible-set scoping.
      let filterMemoryIds: string[] | undefined;
      let filterLocPrefix: string | undefined;

      // #498 — at most one memory selector. memoryUrn (single), memoryUrns (a
      // set), and allMemories (everything accessible) are three ways to say
      // "where"; combining them is ambiguous. allMemories needs no scope work —
      // leaving filterMemoryIds undefined makes findNodes use the accessible set
      // (session-scoped downstream); it exists as the explicit, discoverable
      // form of "omit the scope" so agents reach for the org-wide probe.
      const memSelectors = [
        memoryUrn ? 'memoryUrn' : null,
        memoryUrns && memoryUrns.length > 0 ? 'memoryUrns' : null,
        allMemories ? 'allMemories' : null,
      ].filter(Boolean);
      if (memSelectors.length > 1) {
        return textResult(
          `Pass only one memory scope — got ${memSelectors.join(' + ')}. Use memoryUrn (one), memoryUrns (a set), or allMemories (everything you can read).`,
        );
      }

      // Scope to memory URN if provided. Spec 022 (FR-003): no fallback to the
      // active memory — the caller supplies a fully-qualified URN. #188: route
      // through canReadMemory so personal/private memories (FR-016 strict
      // ownership; ADMIN/OWNER do NOT bypass) and non-admin scope gating both
      // apply. Match hadron_get_node's "not found" phrasing so absence and
      // denial are indistinguishable.
      if (memoryUrn) {
        try {
          assertFullyQualifiedUrn(memoryUrn, 'memory');
        } catch (e) {
          if (e instanceof UrnNotQualifiedError) return refusalResult(e.message);
          throw e;
        }
        const mem = await resolveMemoryByUrn(memoryUrn);
        if (
          !mem ||
          !(await canReadMemory(db, auth, mem.id, EXPLICIT_REF)) ||
          (sessionMemoryIds && !sessionMemoryIds.has(mem.id))
        ) {
          return textResult(
            `Memory not found or invalid: '${memoryUrn}'. Use hadron_list_memories to see what is available.`,
          );
        }
        filterMemoryIds = [mem.id];
      }

      // Scope to a SET of memories (#498). Each URN gets the SAME gates as the
      // single-memory path (qualification + canReadMemory + session boundary),
      // so absence and denial stay indistinguishable per the memoryUrn contract.
      // Dedup + resolve in parallel (#567 review, Gemini); surface the first
      // failure in input order.
      if (memoryUrns && memoryUrns.length > 0) {
        const resolved = await Promise.all(
          [...new Set(memoryUrns)].map(async (urn): Promise<{ id: string } | { error: string }> => {
            try {
              assertFullyQualifiedUrn(urn, 'memory');
            } catch (e) {
              if (e instanceof UrnNotQualifiedError) return { error: e.message };
              throw e;
            }
            const mem = await resolveMemoryByUrn(urn);
            if (
              !mem ||
              !(await canReadMemory(db, auth, mem.id, EXPLICIT_REF)) ||
              (sessionMemoryIds && !sessionMemoryIds.has(mem.id))
            ) {
              return {
                error: `Memory not found or invalid: '${urn}'. Use hadron_list_memories to see what is available.`,
              };
            }
            return { id: mem.id };
          }),
        );
        const bad = resolved.find((r): r is { error: string } => 'error' in r);
        if (bad) return refusalResult(bad.error);
        filterMemoryIds = resolved.map((r) => (r as { id: string }).id);
      }

      // Explicit org-wide scope (#498). Materialize the readable set so
      // SYSTEM-class memories are included: findNodes hides class='system' on a
      // scope-less broad search, but explicit ids bypass that (#567 review,
      // Codex), so a bare undefined here would silently drop the agent's own
      // system memory despite "every memory you can read". accessibleMemoryIds
      // is null for see-all admins → materialize every live memory so "all"
      // really means all. The resolver re-gates whatever ids we pass, so this
      // cannot broaden beyond the caller's actual reach.
      if (allMemories) {
        filterMemoryIds =
          accessibleMemoryIds ??
          (
            await db.memory.findMany({ where: { deletedAt: null }, select: { id: true } })
          ).map((m) => m.id);
      }

      // #2526: the explicit-parent gate is shared with list_nodes; discovery
      // cannot hide a directly readable owner memory before authorization.
      if (trimmedParentRel) {
        const parent = await resolveParentForRead(trimmedParentRel, memoryUrn, accessibleMemoryIds, auth, sessionMemoryIds);
        if (!parent.ok) {
          return parent.kind === 'notFound'
            ? textResult(`No nodes found matching "${safeQuery}".`)
            : refusalResult(parent.message);
        }
        filterLocPrefix = parent.loc;
        if (parent.memoryId) filterMemoryIds = [parent.memoryId];
      }

      // Build a GraphQL Context from the MCP auth, including appId + sessionId so
      // access scoping resolves the same way it does for the other delegating
      // tools. Both fields are load-bearing and were once omitted — the #206
      // finding. (The `gqlCtx` helper that omitted them is gone with the
      // chatbot tools, #1141; the requirement it got wrong is not.)
      const ctx: Context = {
        db,
        clientId: auth.clientId ?? undefined,
        userId: auth.userId ?? undefined,
        apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId, // #1868: the shared authorized tx re-checks the presented key
        appId: auth.appId ?? undefined,
        sessionId: auth.sessionId ?? undefined,
        roles: auth.roles as Context['roles'],
        organizationId: auth.organizationId ?? undefined,
      };

      // Spec 049 Phase 3 — the ladder. An explicit selector above outranks the
      // ambient rungs; a scope named in the call intersects with it.
      let scopeRes: SearchScopeResolution | null = null;
      let scopeOrgId: string | undefined;
      try {
        scopeRes = await mcpSearchScope(scope, memSelectors.length > 0 || !!trimmedParentRel);
      } catch (e) {
        if (e instanceof ScopeGraphQLError) return refusalResult(`[${String(e.extensions?.code ?? 'error').toLowerCase()}] ${e.message}`);
        throw e;
      }
      if (scopeRes?.memoryIds) {
        const inScope = new Set(scopeRes.memoryIds);
        filterMemoryIds = filterMemoryIds ? filterMemoryIds.filter((id) => inScope.has(id)) : scopeRes.memoryIds;
        if (filterMemoryIds.length === 0) {
          return textResult(`${scopeNoteLine(scopeRes)}\n\nFound 0 node(s) — ${memSelectors.length ? 'the memories you named are outside this scope' : 'this scope lists no memory you can read'}.`);
        }
      }
      // #1987: as in the resolver, the global view's materialised list still
      // takes the org narrowing (App-memory exclusion of the runnable catalogue).
      if (scopeRes?.kind === 'global') scopeOrgId = scopeRes.orgScopeId ?? undefined;
      // Every scoped return below — passages, the vector diagnostics, the node
      // list — starts with the disclosure (Codex + Copilot on PR #1161).
      const scopePrefix = scopeRes ? `${scopeNoteLine(scopeRes)}\n\n` : '';

      let result: Awaited<ReturnType<typeof resolvers.Query.findNodes>>;
      try {
        result = await resolvers.Query.findNodes(
          {},
          {
            // Survey mode → omit query so findNodes returns the filtered list
            // (subsumes the old matchesQuery "*" / "" path).
            query: isSurvey ? undefined : safeQuery,
            mode: effectiveMode,
            orgId: scopeOrgId,
            filter: {
              memoryIds: filterMemoryIds,
              isRunnable: isRunnable ?? undefined,
              role: role ?? undefined,
              contentScope: nodeKind ?? undefined, // #1678: MCP nodeKind → GraphQL contentScope
              objectType: objectType ?? undefined,
              nodeType: nodeType ?? undefined, // #331: exact-match pass-through to NodeFilter.nodeType
              locPrefix: filterLocPrefix,
              // #719 — structured JSONB predicate; findNodes validates it and
              // throws BAD_USER_INPUT on a malformed/oversized tree (surfaced as
              // tool-error text by the catch below).
              where: (where ?? undefined) as NodeWhere | undefined,
            },
            expand: expand ?? undefined,
            granularity: granularity ?? undefined,
            // #497 — a query defaults to a tight page (10); an agent iterating
            // search shouldn't pay 20 full abstracts of context per call. Survey
            // mode ("*"/"") is a deliberate full listing, so it gets a wider page (20). The
            // minScore floor never applies to survey (those hits are unscored).
            limit: limit ?? (isSurvey ? 20 : 10),
            minScore: isSurvey ? undefined : minScore,
          },
          ctx,
        );
      } catch (e) {
        // findNodes throws BAD_USER_INPUT for a malformed boolean query, an
        // invalid regex, etc. The MCP contract surfaces tool errors as text.
        if (e instanceof ScopeGraphQLError && e.extensions?.code === 'BAD_USER_INPUT') return refusalResult(e.message);
        // #415: anything else, such as a regex statement the database
        // cancelled at its budget, goes through the #1695 boundary, so a
        // Prisma message (driver internals, the SQL shape) never reaches the
        // caller.
        return toolErrorResult(e, () => (e instanceof Error ? e.message : 'Search failed.'), 'hadron_find_nodes');
      }
      const memoryUrnOf = memoizedMemoryUrnLookup();

      // ── Chunk (passage) rendering ──────────────────────────────────────────
      // findNodes passages carry parentNodeId + parentNodeUrn; re-fetch the
      // parent so the URN is emitted in canonical form (nodeUrn) and the node
      // name is shown, matching the pre-delegation output.
      if (granularity === 'chunk') {
        const passages = result.passages ?? [];
        if (passages.length === 0) return textResult(`${scopePrefix}Found 0 passage(s).`);
        const parentIds = [...new Set(passages.map((p) => p.parentNodeId))];
        const parentNodes = await db.node.findMany({
          where: { id: { in: parentIds } },
          select: { id: true, name: true, loc: true, memoryId: true },
        });
        const parentById = new Map(parentNodes.map((n) => [n.id, n]));
        const passageComments = await commentHitInfo(db, parentIds); // #1608
        const lines: string[] = [];
        for (const p of passages) {
          const parent = parentById.get(p.parentNodeId);
          const urn = parent ? await nodeUrn(parent.loc, parent.memoryId, memoryUrnOf) : p.parentNodeUrn;
          const name = parent?.name ?? '';
          // Guard the score like renderHit does — a passage without a numeric
          // score renders without the trailing marker rather than crashing.
          const scoreStr = p.score != null ? `  (score ${p.score.toFixed(3)})` : '';
          const header = `- **${urn}** [chunk ${p.chunkIndex} @ chars ${p.charStart}-${p.charEnd}] — ${name}${scoreStr}`;
          const bodyLines = p.text.split(/\r?\n/).map((l) => `  ${l}`);
          const asComment = passageComments.get(p.parentNodeId);
          const label = asComment
            ? [commentHitLabel(asComment, (await nodeUrnResult(asComment.targetLoc, asComment.targetMemoryId, memoryUrnOf)).urn)]
            : [];
          lines.push([header, ...label, ...bodyLines].join('\n'));
        }
        return textResult(`${scopePrefix}Found ${lines.length} passage(s):\n\n${lines.join('\n')}`);
      }

      // ── Diagnostic states → text notes (FR-021) ────────────────────────────
      // Map findNodes's reason/degraded codes back to the tool's note lines.
      // A vector-mode `reason` is terminal (empty envelope); a hybrid `degraded`
      // note is prepended to the keyword-only results.
      if (result.reason === 'no_vector_index') {
        return textResult(
          `${scopePrefix}Note: this memory has no vector index — enable it on the memory to use mode:vector. [no_vector_index]\n\nFound 0 node(s).`,
        );
      }
      if (result.reason === 'embedding_unavailable') {
        // findNodes collapses "no endpoint configured" and "embed() failed" into
        // one code, so the note names both causes (the pre-delegation surface
        // had separate messages).
        return textResult(
          `${scopePrefix}Note: vector search is unavailable — no embedding endpoint is configured or embed() failed. [embedding_unavailable]\n\nFound 0 node(s).`,
        );
      }
      // `degraded` may carry MULTIPLE comma-separated flags (PR-482 — e.g.
      // 'no_vector_index,literal_fallback'), so parse the set instead of
      // comparing the whole string.
      const degradedFlags = new Set((result.degraded ?? '').split(',').filter(Boolean));
      const noteLines: string[] = [];
      if (degradedFlags.has('no_vector_index')) {
        noteLines.push(
          'Note: vector half unavailable (no vector index); showing keyword results only. [degraded:no_vector_index]',
        );
      }
      if (degradedFlags.has('embedding_unavailable')) {
        // findNodes sets this code both when no endpoint is configured AND when
        // embed() throws — name both causes rather than assert one.
        noteLines.push(
          'Note: vector half unavailable — no embedding endpoint is configured or embed() failed; showing keyword results only. [degraded:embedding_unavailable]',
        );
      }
      if (degradedFlags.has('literal_fallback')) {
        noteLines.push(
          'Note: the query was not valid boolean syntax, so it ran as a literal phrase search. Operators are UPPERCASE-only (AND/OR/NOT). [degraded:literal_fallback]',
        );
      }
      if (degradedFlags.has('and_relaxed_to_or')) {
        noteLines.push(
          'Note: no node matched ALL of your terms (keyword search ANDs them), so the search was relaxed to ANY term (OR). These hits each match at least one term — a single missing word likely zeroed the strict search; drop or change it to narrow back down. [degraded:and_relaxed_to_or]',
        );
      }
      // Spec 049: every scoped result says which scope it ran under, first.
      if (scopeRes) noteLines.unshift(scopeNoteLine(scopeRes));
      const note: string | null = noteLines.length ? noteLines.join('\n') : null;

      // ── Node rendering ─────────────────────────────────────────────────────
      // #497 — the top score of the result set, used to show each hit's score as
      // a fraction of the best hit. Relative score is mode-independent (it
      // normalizes within one result set), so an agent can judge "is anything
      // here actually strong?" without knowing each mode's absolute score scale.
      // Unscored expand-neighbours carry score null and are excluded.
      const scores = (result.hits ?? [])
        .map((h) => h.score)
        .filter((s): s is number => typeof s === 'number');
      // Reduce, not Math.max(...scores): `limit` is caller-controlled, so a huge
      // page would spread too many args into Math.max and throw RangeError.
      const topScore = scores.length ? scores.reduce((m, s) => (s > m ? s : m), -Infinity) : null;
      // #1608 — what each comment hit is about, so its line says it is feedback.
      const commentInfo = await commentHitInfo(db, (result.hits ?? [])
        .filter((h: { node: { nodeType?: string } }) => h.node.nodeType === COMMENT_NODE_TYPE)
        .map((h: { node: { id: string } }) => h.node.id));
      const renderHit = async (hit: {
        node: {
          id: string;
          loc: string;
          memoryId: string;
          nodeType?: string;
          name: string;
          description: string | null;
          abstract: string | null;
          abstractOriginHash: string | null;
          content: string | null;
          tags: string[] | null;
          outgoingEdges?: Array<{
            target: { loc: string; memoryId: string; deletedAt: Date | null } | null;
            name: string | null;
            loc: string;
          }>;
        };
        score: number | null;
      }): Promise<string> => {
        const n = hit.node;
        const { urn, fellBack: urnFellBack } = await nodeUrnResult(n.loc, n.memoryId, memoryUrnOf);
        const score = hit.score;
        // #497: show the score relative to the top hit (mode-independent signal).
        const relStr =
          score != null && topScore != null && topScore > 0
            ? `, ${Math.round((score / topScore) * 100)}% of top`
            : '';
        // #322: surface the stable PK so callers can reference this node by id.
        const parts = [
          score != null
            ? `- **${urn}** (id: ${n.id}) — ${n.name}  (score ${score.toFixed(3)}${relStr})`
            : `- **${urn}** (id: ${n.id}) — ${n.name}`,
        ];
        const asComment = commentInfo.get(n.id);
        if (asComment) {
          const target = await nodeUrnResult(asComment.targetLoc, asComment.targetMemoryId, memoryUrnOf);
          parts.push(commentHitLabel(asComment, target.urn));
        }
        // Spec 033 FR-023 — `Source: abstract-stale` on a ranked hit whose stored
        // abstract no longer matches the current (plaintext) content. Unscored
        // expand-neighbours are skipped (they weren't matched via an abstract).
        const isStale =
          score != null &&
          n.content != null &&
          !isCiphertext(n.content) &&
          isAbstractUnverified(n);
        if (isStale) parts.push('  Source: abstract-stale');
        // #881 — the hit's portal URL, so an agent citing a search result hands
        // over a working link instead of assembling one from the URN above.
        // Excluded from `brief` mode for the same reason the abstract is: brief
        // stays terse (cor:api:020:03). Omitted when no portal origin is set.
        // Omitted for a best-effort fallback URN — see renderNodeReadProjection.
        if (!brief && !urnFellBack) {
          const hitPortalUrl = portalUrlForUrn(urn);
          if (hitPortalUrl) parts.push(`  URL: ${hitPortalUrl}`);
        }
        // #1885 — a hit read through a child's effective system memory names
        // its base, and shows none of the base's edges.
        const hitInheritedFrom = (n as { inheritedFrom?: InheritedFrom }).inheritedFrom;
        if (hitInheritedFrom) parts.push(`  Inherited from: ${emitEntityUrnV2('agent', hitInheritedFrom.agentUrn)}`);
        if (n.description) parts.push(`  ${n.description}`);
        // Spec 031 US2 — surface the abstract as a two-space-indented block
        // beneath the description (excluded from brief mode). `/\r?\n/` so
        // CRLF-terminated lines don't leave a trailing `\r` mid-output.
        if (!brief && n.abstract) {
          for (const absLine of n.abstract.split(/\r?\n/)) parts.push(`  ${absLine}`);
        }
        if (n.tags?.length) parts.push(`  Tags: ${n.tags.join(', ')}`);
        // Brief edge rendering — hide edges whose target is soft-deleted
        // (#180 Bug 2); findNodes includes them, so filter here.
        if (brief) {
          // #1893 — an inherited hit's edges come through its child, never raw.
          const edges = hitInheritedFrom
            ? (hitInheritedFrom.via
              ? (await resolveInheritedEdges(db, {
                  nodeId: n.id,
                  via: hitInheritedFrom.via,
                  direction: 'out',
                  canReadMemory: (memoryId) => canReadMemory(db, auth, memoryId, EXPLICIT_REF),
                })).map(({ edge, endpoint }) => ({ ...edge, target: endpoint }))
              : [])
            : (n.outgoingEdges ?? []).filter(
                (e) => e.target && e.target.deletedAt == null,
              );
          if (edges.length) {
            const edgeStrs = await Promise.all(
              edges.map(async (e) => {
                const targetUrn = await nodeUrn(e.target!.loc, e.target!.memoryId, memoryUrnOf);
                return `→ ${targetUrn} (${e.name ?? e.loc})${governedKindAnnotation((e as { governedKind?: unknown }).governedKind)}`;
              }),
            );
            parts.push(`  Edges: ${edgeStrs.join(', ')}`);
          }
        }
        return parts.join('\n');
      };

      const lines = await Promise.all((result.hits ?? []).map(renderHit));
      if (lines.length === 0) {
        // Preserve the byte-identical "no match" output for the lexical path —
        // when hybrid degraded to keyword AND found nothing, prepend the note.
        const baseMsg = `No nodes found matching "${safeQuery}".`;
        return textResult(note ? `${note}\n\n${baseMsg}` : baseMsg);
      }

      // #497 — "weak results" heuristic. When several scored hits all sit in a
      // narrow band just below the top (the weakest is still a large fraction of
      // the best), the ranking failed to single out a clear match — the classic
      // "the answer isn't here, but the search dumped 50 plausible-looking rows
      // anyway" failure. Flag it so an agent can rule the query out without
      // reading the whole tail. Advisory only: it annotates, never drops (that's
      // what minScore is for). The band is measured over the shown scored hits,
      // and relative (fraction of top), so it's sound across every mode.
      let weakNote: string | null = null;
      if (scores.length >= 5 && topScore != null && topScore > 0) {
        const lo = scores.reduce((m, s) => (s < m ? s : m), Infinity); // reduce, not spread (see topScore)
        const relLo = lo / topScore;
        if (relLo >= 0.6) {
          weakNote =
            `Note: these ${scores.length} hits sit in a narrow score band ` +
            `(${lo.toFixed(3)}–${topScore.toFixed(3)}; the weakest is ${Math.round(relLo * 100)}% of the top), ` +
            `so the ranking did not single out a clear best match — what you're looking for may not be present. ` +
            `Verify the top hits directly, or try a narrower query / different mode before trusting the full list. [weak_results]`;
        }
      }

      const body = `Found ${lines.length} node(s):\n\n${lines.join('\n')}`;
      const notes = [note, weakNote].filter(Boolean).join('\n\n');
      return textResult(notes ? `${notes}\n\n${body}` : body);
    },
  );

  // ── hadron_get_node ──────────────────────────────────────────────────────────

  /** An action URN — a register entry's second address (#2610, cor:urn:010:01). */
  const ACTION_REF_RE = /^(?:hrn|urn):action:/;

  /**
   * #2610 — resolve `hrn:action:<root>:<agent-slug>:<code>` to its register
   * entry: the SAME steps as resolveUrn's action arm (resolvers.query.node.ts),
   * with this surface's gate spellings. The root + slug name the ONE Agent whose
   * system memory holds the entry at `register:<code>` — no nearest-first chain
   * fallthrough (a child's override entry addresses under its own slug). The
   * `agent` arm's gate verbatim (PUBLIC resolves for anyone, #551; otherwise
   * owner-or-org-member), then the system memory's read gate, then the entry
   * through resolveNodeRefForAuth so the live lookup, the rename alias heal
   * (cor:urn:030:01) and ambiguity concealment are the SAME implementation the
   * node form below uses. Returns null for EVERY refusal — other tenant,
   * unreadable memory, unknown agent, missing or malformed code — the arm's
   * uniform-refusal rule, worn here as the same single not-found message the
   * node form serves. A globally-ambiguous historical entry address stays a
   * LOUD refusal (AmbiguousLegacyUrnError escapes), exactly as in the arm.
   *
   * `agentGate: false` (#2718, Vera's ruling (a), cor:agt:110:04) drops the
   * `agent` arm's gate and keeps only the memory gates: the RUN surface applies
   * the node-URN spelling's gate (`loadNodeForRun` -> `canReadMemory`), so a
   * participant who reads the entry's memory runs it under either address. The
   * default (true) is the READ surface's, unchanged.
   */
  const resolveActionEntryRef = async (
    rawUrn: string,
    opts: { agentGate?: boolean } = {},
  ): Promise<{ id: string; memoryId: string; loc: string } | null> => {
    let agentId: string;
    let code: string;
    try {
      const parsed = parseUrnV2(rawUrn); // fixed 'action' arity: [agent-slug, code]
      [code] = parsed.segments.slice(1);
      ({ id: agentId } = await resolveAgentRef(
        db,
        composeUrnV2('agent', parsed.root, parsed.segments[0]!),
      ));
    } catch {
      // Malformed leaf (charset/length/arity) or an unknown/renamed-away agent
      // — both name nothing (the arm's uniform refusal).
      return null;
    }
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { organizationId: true, visibility: true, ownerUserId: true, systemMemoryId: true },
    });
    if (!agent?.systemMemoryId) return null;
    // D-1 (Rico §10 delta): carry impersonation into the gate — scopeCtx()
    // alone omits it, so an impersonated session's org-membership check would
    // admit what the GraphQL arm (ctx.impersonation-aware) refuses.
    // recoveryCtx() is the established shape for this.
    if (
      opts.agentGate !== false &&
      agent.visibility !== 'PUBLIC' &&
      !(await isOwnerOrOrgMember({ ...scopeCtx(), impersonation: auth.impersonation ?? undefined }, agent))
    ) {
      return null;
    }
    if (!(await canReadMemory(db, auth, agent.systemMemoryId, EXPLICIT_REF))) return null;
    let entryId: string;
    try {
      ({ id: entryId } = await resolveNodeRefForAuth(
        emitNodeUrnV2(await loadMemoryUrn(agent.systemMemoryId), `register:${code}`),
        auth,
      ));
    } catch (error) {
      if (error instanceof AmbiguousLegacyUrnError) throw error;
      return null;
    }
    const entry = await db.node.findFirst({
      where: { id: entryId, deletedAt: null },
      select: { id: true, memoryId: true, loc: true },
    });
    if (!entry) return null;
    // The content gate on the memory the entry ACTUALLY lives in — an alias
    // heal can cross memories (PR #2711 §10, P3-2): the caller reads where it
    // lives, not the system memory the ref started from.
    if (!(await canReadMemory(db, auth, entry.memoryId, EXPLICIT_REF))) return null;
    return entry;
  };

  /**
   * The read tail shared by hadron_get_node's two address forms — the node URN
   * path and the #2610 action-URN path — so one projection, one reconcile, one
   * usage event and one lint pass serve both of a node's addresses and cannot
   * drift (the same rule cor:api:040:01 holds the batch to).
   */
  const serveNodeReadProjection = async (
    node: { id: string; memoryId: string; loc: string },
    o: {
      rawUrn: string;
      contentScope?: 'content' | 'abstract' | 'all';
      raw?: boolean;
      inheritedFrom?: InheritedFrom | null;
      fragment?: string;
      matchedLiteral?: boolean;
    },
  ) => {
      // Spec 031 — contentScope-driven response shape. Default 'content'
      // preserves pre-spec output byte-for-byte. Defensive enum check: zod
      // validates the same set at the MCP transport boundary, but direct-
      // handler callers (createTestableMcpServer's _registeredTools shortcut)
      // bypass that parsing, so re-validate here. InvalidContentScopeError is
      // the single source of truth for the message (and any future GraphQL
      // `extensions.code` mapping). MCP convention: return error text, not throw.
      if (
        o.contentScope !== undefined &&
        o.contentScope !== 'content' &&
        o.contentScope !== 'abstract' &&
        o.contentScope !== 'all'
      ) {
        const err = new InvalidContentScopeError(String(o.contentScope));
        return refusalResult(err.message);
      }
      const scope = o.contentScope ?? 'content';
      // Reconcile + fetch under one row lock. The first lookup selects the
      // address and authorizes its memory; it must not supply the body after a
      // reconciliation advanced the counter.
      const current = await loadCurrentReadProjection(node.id, node.memoryId, auth, o.inheritedFrom?.via ?? node.memoryId);
      if (
        !current ||
        current.memoryId !== node.memoryId ||
        current.loc !== node.loc ||
        // An inherited node was admitted through the child's memory above.
        (!o.inheritedFrom && !(await canReadMemory(db, auth, current.memoryId, EXPLICIT_REF)))
      ) {
        return refusalResult(`Node "${o.rawUrn}" not found.`);
      }
      // The version actually served must still be the child's to show
      // (Diego, #1891 P2-1): not turned boot prompt, not overridden since.
      if (o.inheritedFrom && !(await stillInherited(db, o.inheritedFrom, current))) {
        return refusalResult(`Node "${o.rawUrn}" not found.`);
      }
      if (o.inheritedFrom) markInherited([current], new Map([[current.memoryId, o.inheritedFrom]]));
      // Spec 041: decrypt when this session holds the key; mark locked
      // otherwise (blanked fields + Locked meta line, never raw ciphertext).
      const lockState = mcpDecryptOrMark(current);
      // Shared with hadron_get_nodes (batch) so the per-node projection can never
      // drift between the single-read and batch-read surfaces (cor:api:040:01).
      // #2041 — include tags resolve with the caller's own read access; `raw` skips it.
      const served = lockState === 'locked' || o.raw
        ? current
        : { ...current, content: await resolveNodeContent(scopeCtx(), current, { raw: o.raw }) };
      const projection = await renderNodeReadProjection(served, scope, {
        locked: lockState === 'locked',
        encryptedMemory: lockState !== 'plaintext',
        auth,
      });

      // Record usage event (fire-and-forget), AFTER the projection is in hand:
      // the defensive contentScope check above returns an error for a direct
      // handler call with a bad scope, and recording first would count a read
      // for content never returned (PR #1062 review — Copilot).
      //
      // #796: `memoryId` is attributed directly so the event stays counted for
      // this memory after the node is deleted (nodeId is SetNull).
      //
      // #930 (PR-933 Codex P1): the shared recorder attributes the event to the
      // bound session. `auth.sessionId` is a validated Session.id — an App-key
      // caller's X-Hadron-Session, checked in resolveAppKey for existence, App
      // ownership, not-ended and not-past-expiry — so this is a real FK, not the
      // MCP transport session id. It was hardcoded null in all five MCP usage
      // writers, which meant MCP work produced no session heartbeat at all: the
      // #930 reaper counts the latest attributed UsageEvent as liveness, so a
      // The residual this comment used to describe — "user-credential MCP
      // callers cannot bind a session today" — was CLOSED by #934 four days
      // after it was written: `bindSession` takes both principal shapes, and a
      // user principal binds a session attributed to them. The real gap was
      // narrower and outlived it: a desktop caller's session is created
      // mid-conversation by `hadron_start_session`, so it can never reach an
      // `X-Hadron-Session` header on a connection that already exists, leaving
      // `auth.sessionId` null and every event here unattributed. #1081 gives
      // that caller an explicit heartbeat instead (`heartbeatSession`).
      //
      // A LOCKED node still records: the projection is what crossed the
      // boundary, and the caller did read this node's addressable state.
      // An alias read names the node at its CURRENT address; never pair the
      // historical input loc with the target memory in the usage event.
      recordNodeRead(db, { id: current.id, loc: current.loc, memoryId: current.memoryId }, auth);

      // #696: `#data` addresses the node's DATA, not the node — and before the
      // urn-lib-js 0.0.15 bump the fragment stayed glued to the loc, so such a
      // read simply missed. Now it decomposes, and returning the parent's
      // projection with no word said would answer a question the caller did not
      // ask — the hadron-server#994 harm (resolving to the parent) arriving on
      // a read surface. This tool has no data view, so it serves the node and
      // SAYS which resource that is; `resolveUrn` tags its result the same way.
      // No notice when the LITERAL row matched: nothing was resolved away, the
      // caller got exactly the loc they named.
      // #2048 (cor:agt:040:13 R19): the warnings that hold for this boot-prompt source now, recomputed on every read.
      const lint = lockState === 'locked' || !isBootPromptRole(current.role) ? '' : renderLintWarnings(await lintWarningPageForNodeId(scopeCtx(), current.id));
      return textResult(noteFragment(projection, o.matchedLiteral ? undefined : o.fragment) + lint);
  };

  server.tool(
    'hadron_get_node',
    "Read a node by its fully-qualified URN. The URN MUST be fully qualified (hrn:node:<root>:<memory>:<loc>). An action URN (hrn:action:<root>:<agent-slug>:<code>) is also accepted — the register entry's SECOND address, resolved to that entry and served as the same projection. Optional `contentScope` selects what the response includes: 'content' (default) — meta block + body, with the abstract substituted into the body slot when content is null/empty (a `Source: abstract-fallback` line then appears in the meta block); 'abstract' — meta block + abstract, no body; 'all' — meta block + abstract + body. When the abstract is in the response and its origin hash disagrees with the current content's hash, the meta block also carries a `Source: abstract-stale` line — treat the abstract as a possibly-outdated preview (spec 032 FR-010; on encrypted memories only while unlocked — spec 041). It means the content changed after the abstract was written, NOT that the abstract is known to be wrong. To clear it: read both, then either rewrite the abstract, or — if it still describes the node — re-save the identical text via hadron_update_node (or assert `abstractStillAccurate`). Rewriting an abstract you have not first found inaccurate is the wrong move; the marker is a prompt to check, not a verdict. Spec 031 + 032. The meta block also carries a `URL:` line — the node's portal link. To refer a human to this node, COPY that URL verbatim; never build a link yourself and never put a bare `hrn:` URN in a markdown href (it renders as a link and resolves to nothing). When the line is absent this deployment has no portal configured, so there is no link to give. A node that is an action's register entry also carries an `Action URN:` line — its action address; cite THAT (not the node URN) when naming the action.",
    SHAPE_HADRON_GET_NODE,
    async ({ urn: rawUrn, contentScope, raw }) => {
      // #2610 — an action URN is a register entry's SECOND address, not a node
      // URN: the node-qualification gate below would refuse it as a wrong-kind
      // prefix. Resolve it through the action arm's steps and serve the ENTRY's
      // projection — one projection for both of a node's addresses, so the
      // surfaces cannot drift.
      if (ACTION_REF_RE.test(rawUrn)) {
        const entry = await resolveActionEntryRef(rawUrn);
        if (!entry) return refusalResult(`Node "${rawUrn}" not found.`);
        return serveNodeReadProjection(entry, { rawUrn, contentScope, raw });
      }

      // Spec 022: qualification at the API boundary.
      try {
        assertFullyQualifiedUrn(rawUrn, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return refusalResult(e.message);
        throw e;
      }

      // Tolerant of an already-corrupt stored loc containing `#`: reads are
      // how a bad row is discovered, so the decomposer refusing one would make
      // exactly the row you need to see the one row you cannot read (urn-lib-js
      // 0.0.14 → 0.0.15 bump). `#data` still decomposes normally and is
      // reported below rather than silently serving the parent.
      const { memoryUrn, loc, fragment, literalLoc } = splitNodeUrnTolerant(rawUrn);
      // A historical memory prefix may itself have several holders. For a
      // NODE read, defer that ambiguity to resolveNodeRefForAuth, which checks
      // the current node claimants before exposing any error.
      const memory = await resolveMemoryByUrn(memoryUrn).catch((error) => {
        if (error instanceof AmbiguousLegacyUrnError) return null;
        throw error;
      });
      const sourceReadable = !!memory && await canReadMemory(db, auth, memory.id, EXPLICIT_REF);
      const missing = () => refusalResult(sourceReadable
        ? `Node "${rawUrn}" not found.`
        : `Memory not found: "${memoryUrn}".`);

      // The projection's include, named so the two candidate lookups below
      // cannot drift apart.
      const nodeReadInclude = readProjectionInclude;

      // A LITERAL match wins over the fragment reading. `#data` decomposes to
      // parent + fragment, but a row's stored loc can BE `foo#data` (it
      // predates loc validation), and only the database can tell which was
      // meant — so the exact loc is tried first and the parent is the fallback
      // (PR #1088 review, Codex P2). Without this the read either misses or
      // returns a different node that happens to exist under the parent loc.
      //
      // #180 Bug 2: soft-deleted nodes are not addressable via read —
      // findFirst with an explicit `deletedAt: null` rather than findUnique, so
      // a tombstoned row returns "not found" instead of leaking its last
      // content.
      let matchedLiteral = false;
      let node = sourceReadable && memory
        ? await db.node.findFirst({
            where: { loc: literalLoc ?? loc, memoryId: memory.id, deletedAt: null },
            include: nodeReadInclude,
          })
        : null;
      if (node && literalLoc) matchedLiteral = true;
      if (!node && literalLoc && sourceReadable && memory) {
        node = await db.node.findFirst({
          where: { loc, memoryId: memory.id, deletedAt: null },
          include: nodeReadInclude,
        });
      }
      let inheritedFrom: InheritedFrom | null = null;
      let movedId: string | undefined;
      if (!node) {
        // #1391 — the old memory or loc can have vanished on a move. Resolve
        // the full address (LIVE first, alias on miss) before gating the node
        // at its CURRENT memory. Even when the old memory is unreadable, a live
        // occupant there must beat a historical alias to another node.
        const aliasRefs = literalLoc && fragment
          ? [rawUrn, rawUrn.slice(0, rawUrn.lastIndexOf('#'))]
          : [rawUrn];
        for (const aliasRef of aliasRefs) {
          try {
            ({ id: movedId } = await resolveNodeRefForAuth(aliasRef, auth));
            if (aliasRef === rawUrn && literalLoc) matchedLiteral = true;
            break;
          } catch (e) {
            if (e instanceof NodeNotFoundError) continue;
            throw e;
          }
        }
        if (!movedId) {
          // #1885 (cor:dmo:050:14) — no node of its own at the loc, and none
          // moved from it: an Agent's system memory reads through to the
          // nearest base that passes one down (GraphQL's node(ref:) resolves
          // in the same order). The answer keeps the base's address and says
          // it is inherited.
          const effective = sourceReadable && memory
            ? await findEffectiveNodeIdByLoc(db, memory.id, literalLoc ?? loc)
            : null;
          if (!effective?.inheritedFrom) return missing();
          node = await db.node.findFirst({ where: { id: effective.id, deletedAt: null }, include: nodeReadInclude });
          if (!node) return missing();
          inheritedFrom = effective.inheritedFrom;
        }
      }
      if (!node && movedId) {
        const target = await db.node.findFirst({
          where: { id: movedId, deletedAt: null },
          select: { memoryId: true },
        });
        if (!target || !(await canReadMemory(db, auth, target.memoryId, EXPLICIT_REF))) return missing();
        node = await db.node.findFirst({
          where: { id: movedId, memoryId: target.memoryId, deletedAt: null },
          include: nodeReadInclude,
        });
        if (!node) return missing();
      }
      if (!node) return missing();

      return serveNodeReadProjection(node, { rawUrn, contentScope, raw, inheritedFrom, fragment, matchedLiteral });
    },
  );

  // ── hadron_get_nodes (batch multi-node read) ──────────────────────────────────

  server.tool(
    'hadron_get_nodes',
    "Batch read — return the full per-node projection (meta + edges + contentScope body, identical to hadron_get_node) for MANY nodes in one call. Two mutually-exclusive forms: (1) `refs` — an explicit list of node references, returned in input order; (2) `memoryUrn` + `locPrefix` — every readable node whose loc starts with the prefix in one memory, returned in loc order. Each `refs` entry is a node's primary key OR its fully-qualified URN, so a caller holding either form reads in ONE call. Optional `contentScope` ('content' default | 'abstract' | 'all') applies to every node, so abstract-only triage is cheap. Per-node authorization: unreadable or non-existent refs are reported in a separate Unavailable list (denied and not-found are indistinguishable) and never fail the batch. A ref whose SHAPE is wrong (relative/unqualified, or a URN of another entity kind) is a loud error instead — a caller mistake never hides among denials. Bounded by hard caps — exceeding the node-count cap is a loud error; exceeding the response-size cap returns a partial result flagged `truncated` (never a silent short read). Spec cor:api:040.",
    SHAPE_HADRON_GET_NODES,
    async ({ refs, memoryUrn, locPrefix, contentScope, raw }) => {
      // Defensive contentScope validation — parity with hadron_get_node (covers
      // direct-handler callers that bypass the transport's zod parsing).
      if (
        contentScope !== undefined &&
        contentScope !== 'content' &&
        contentScope !== 'abstract' &&
        contentScope !== 'all'
      ) {
        return refusalResult(new InvalidContentScopeError(String(contentScope)).message);
      }
      const scope = contentScope ?? 'content';

      const hasSet = Array.isArray(refs) && refs.length > 0;
      // locPrefix '' is a valid "whole memory" prefix — test for presence, not
      // truthiness, so an empty prefix isn't mistaken for the absent form.
      const hasPrefix = memoryUrn !== undefined && locPrefix !== undefined;
      // Exactly one form (FR-002: both capabilities exist; one tool, two modes).
      if (hasSet === hasPrefix) {
        return textResult(
          'hadron_get_nodes: provide EITHER `refs` (an explicit set) OR `memoryUrn` + `locPrefix` (a subtree) — not both, not neither.',
        );
      }

      // Authorized, existing nodes in caller-meaningful order, plus the refs we
      // couldn't return — denied OR not-found, reported indistinguishably so the
      // result never discloses whether an unreadable node exists (cor:api:040:03).
      const ordered: Array<ReadProjectionNode & { id: string }> = [];
      /** node id -> the fragment its ref named, for the shared notice below. */
      const fragmentByNodeId = new Map<string, string>();
      /** resolved node id -> caller ref; prefix reads naturally fall back to id. */
      const echoByNodeId = new Map<string, string>();
      const unavailable: string[] = [];
      let prefixInheritance: Awaited<ReturnType<typeof effectiveScope>> | null = null;
      let prefixReadMemoryId: string | undefined;

      if (hasPrefix) {
        // ── Prefix subtree (one memory, gated once) ──────────────────────────
        const mem = await resolveMemoryByUrn(memoryUrn!);
        if (!mem || !(await canReadMemory(db, auth, mem.id, EXPLICIT_REF))) {
          // Don't leak existence — mirror the single read's phrasing.
          return refusalResult(`Memory not found: "${memoryUrn}".`);
        }
        prefixReadMemoryId = mem.id;
        // Count cap (cor:api:040:02): take MAX+1 to detect overflow, then fail
        // loud rather than silently returning a truncated subtree.
        // #1885 (cor:dmo:050:14) — the subtree of an Agent's system memory
        // reads as its effective memory, as hadron_list_nodes does.
        const inheritance = await effectiveScope(db, [mem.id]);
        prefixInheritance = inheritance;
        const rows = await db.node.findMany({
          where: {
            memoryId: { in: inheritance.memoryIds },
            loc: { startsWith: locPrefix! },
            deletedAt: null,
            ...(inheritance.excludeNodeIds.length > 0 ? { id: { notIn: inheritance.excludeNodeIds } } : {}),
          },
          orderBy: { loc: 'asc' },
          take: BATCH_READ_MAX_NODES + 1,
          include: readProjectionInclude,
          omit: { content: true },
        });
        markInherited(rows, inheritance.inheritedFrom);
        if (rows.length > BATCH_READ_MAX_NODES) {
          return textResult(
            `hadron_get_nodes: prefix "${locPrefix}" matches more than the ${BATCH_READ_MAX_NODES}-node cap. Narrow the prefix (or page by sub-prefix); the batch read does not silently truncate.`,
          );
        }
        ordered.push(...(rows as unknown as Array<ReadProjectionNode & { id: string }>));
      } else {
        // ── Explicit set (mixed-memory; per-node gate) ───────────────────────
        // Count cap up front — the caller knows the count, so fail loud before
        // any work (cor:api:040:02).
        if (refs!.length > BATCH_READ_MAX_NODES) {
          return textResult(
            `hadron_get_nodes: ${refs!.length} refs exceeds the ${BATCH_READ_MAX_NODES}-node cap. Split into smaller batches; the batch read does not silently truncate.`,
          );
        }
        // Dedup the input strings up front so a repeated ref isn't rendered (and
        // billed via a UsageEvent) twice. This only collapses byte-identical
        // repeats; the load-bearing dedup is on the RESOLVED node below, since a
        // PK and that node's URN are different strings naming one node.
        // First-occurrence order is preserved.
        const uniqueRefs = [...new Set(refs!)];

        // A ref is a PK or a fully-qualified node URN (cor:api:140). Splitting by
        // shape keeps the URN path's group-by-memory fetch — one gate + one query
        // per distinct memory, not N lookups — while a PK needs no resolution at
        // all: it IS the node id, and the gate below still decides readability.
        //
        // A ref whose SHAPE is wrong fails the whole call. Filing it under
        // `unavailable` next to genuinely-denied nodes is what let this tool's
        // missing PK capability sit unnoticed: the symptom was indistinguishable
        // from a legitimate access outcome (#822, mirroring #813 on GraphQL).
        type UrnRef = { raw: string; memoryUrn: string; loc: string; literalLoc?: string };
        // A `#data` ref reaches its PARENT node, and the projection must say so
        // exactly as the single read does (cor:api:040:01). Keyed by raw ref,
        // then re-keyed to node id below, because one node can be named twice
        // in a batch — once by PK and once by a fragment URN.
        const fragmentByRef = new Map<string, string>();
        const urnRefs: UrnRef[] = [];
        const pkRefs: string[] = [];
        for (const raw of uniqueRefs) {
          if (isId(raw)) {
            pkRefs.push(raw);
            continue;
          }
          // A wrong-type URN (`hrn:mem:…`, `hrn:app:…`) is a coercion bug, not a
          // miss — the same screen hadron_get_node and nodeBatch(refs:) apply.
          const typeErr = validateUrnType(parseUrnInput(raw), 'node');
          if (typeErr) {
            return textResult(`hadron_get_nodes: ${typeErr} (ref "${raw}")`);
          }
          try {
            assertFullyQualifiedUrn(raw, 'node');
            // Tolerant, exactly as hadron_get_node is: cor:api:040:01 promises
            // this batch produces the SAME per-node projection as the single
            // read, and a corrupt stored loc containing `#` readable one way
            // and a "malformed ref" the other breaks that promise for the rows
            // most likely to be looked up in bulk (PR #1088 review, Codex P2).
            const { memoryUrn: mu, loc, fragment, literalLoc } = splitNodeUrnTolerant(raw);
            if (fragment) fragmentByRef.set(raw, fragment);
            urnRefs.push({ raw, memoryUrn: mu, loc, literalLoc });
          } catch {
            return textResult(
              `hadron_get_nodes: "${raw}" is neither a node id nor a fully-qualified node URN (hrn:node:<root>:<memory>:<loc>). A relative or malformed ref is a caller error, not an access outcome, so it is reported here rather than in the Unavailable list.`,
            );
          }
        }

        // The per-node projection every fetch below must produce, identical to
        // hadron_get_node's (cor:api:040:01) — kept in one place so the PK and
        // URN paths cannot drift apart.
        const projectionInclude = readProjectionInclude;

        const nodeByRef = new Map<string, ReadProjectionNode & { id: string }>();
        const movedFallbacks: UrnRef[] = [];

        // URN refs: group by memory so each distinct memory is gated + fetched
        // once (not N findFirsts).
        const byMemory = new Map<string, UrnRef[]>();
        for (const r of urnRefs) {
          const arr = byMemory.get(r.memoryUrn);
          if (arr) arr.push(r);
          else byMemory.set(r.memoryUrn, [r]);
        }
        for (const [mu, group] of byMemory) {
          const mem = await resolveMemoryByUrn(mu).catch((error) => {
            if (error instanceof AmbiguousLegacyUrnError) return null;
            throw error;
          });
          if (!mem || !(await canReadMemory(db, auth, mem.id, EXPLICIT_REF))) {
            movedFallbacks.push(...group);
            continue;
          }
          // Both candidates for a fragmented ref, in ONE query: the literal
          // stored loc (`foo#data`, a row predating loc validation) and the
          // decomposed parent. The literal wins where it exists — same rule as
          // the single read, since only the database can tell which was meant
          // (PR #1088 review, Codex P2).
          const wanted = new Set<string>();
          for (const r of group) {
            wanted.add(r.loc);
            if (r.literalLoc) wanted.add(r.literalLoc);
          }
          const rows = await db.node.findMany({
            where: { memoryId: mem.id, loc: { in: [...wanted] }, deletedAt: null },
            include: projectionInclude, omit: { content: true },
          });
          const rowByLoc = new Map(rows.map((r) => [r.loc, r]));
          for (const r of group) {
            const literal = r.literalLoc ? rowByLoc.get(r.literalLoc) : undefined;
            const row = literal ?? rowByLoc.get(r.loc);
            if (!row) {
              movedFallbacks.push(r);
              continue;
            }
            // A literal match resolved nothing away, so it carries no notice.
            if (literal) fragmentByRef.delete(r.raw);
            nodeByRef.set(r.raw, row as unknown as ReadProjectionNode & { id: string });
          }
        }

        // #1391: old addresses are a fallback only after the grouped live
        // lookup missed. Bound resolver concurrency, then coalesce the target
        // liveness probes, memory gates and projections for the WHOLE fallback
        // set. Without this, 200 historical refs did their target gate and
        // projection serially, turning a batch read back into N+1 round trips.
        const movedIdByRef = new Map<string, string>();
        let nextFallback = 0;
        const resolveFallbackWorker = async () => {
          while (nextFallback < movedFallbacks.length) {
            const r = movedFallbacks[nextFallback++];
            const aliasRefs = r.literalLoc && fragmentByRef.has(r.raw)
              ? [r.raw, r.raw.slice(0, r.raw.lastIndexOf('#'))]
              : [r.raw];
            for (const aliasRef of aliasRefs) {
              try {
                const { id } = await resolveNodeRefForAuth(aliasRef, auth);
                movedIdByRef.set(r.raw, id);
                if (aliasRef === r.raw && r.literalLoc) fragmentByRef.delete(r.raw);
                break;
              } catch (e) {
                if (e instanceof NodeNotFoundError) continue;
                if (e instanceof AmbiguousLegacyUrnError) {
                  // One bad historical address cannot suppress unrelated
                  // readable results in an explicit batch (cor:api:040:03).
                  break;
                }
                throw e;
              }
            }
          }
        };
        await Promise.all(Array.from(
          { length: Math.min(8, movedFallbacks.length) },
          () => resolveFallbackWorker(),
        ));
        const movedIds = [...new Set(movedIdByRef.values())];
        const movedProbes = movedIds.length
          ? await db.node.findMany({
              where: { id: { in: movedIds }, deletedAt: null, memory: { deletedAt: null } },
              select: { id: true, memoryId: true },
            })
          : [];
        const readableMemory = new Map<string, boolean>();
        await Promise.all([...new Set(movedProbes.map((n) => n.memoryId))].map(async (memoryId) => {
          readableMemory.set(memoryId, await canReadMemory(db, auth, memoryId, EXPLICIT_REF));
        }));
        const allowedProbes = movedProbes.filter((n) => readableMemory.get(n.memoryId));
        const movedRows = allowedProbes.length
          ? await db.node.findMany({
              where: { OR: allowedProbes.map((n) => ({ id: n.id, memoryId: n.memoryId })), deletedAt: null },
              include: projectionInclude, omit: { content: true },
            })
          : [];
        const movedRowById = new Map(movedRows.map((n) => [n.id, n]));
        // #1885 (cor:dmo:050:14) — a ref with no live node and no moved one
        // reads through an Agent's system memory to the nearest base that
        // passes one down, exactly as hadron_get_node does (cor:api:040:01).
        const childReadable = new Map<string, string | null>();
        for (const r of movedFallbacks) {
          const id = movedIdByRef.get(r.raw);
          const row = id && movedRowById.get(id);
          if (row) {
            nodeByRef.set(r.raw, row as unknown as ReadProjectionNode & { id: string });
            continue;
          }
          if (!childReadable.has(r.memoryUrn)) {
            const mem = await resolveMemoryByUrn(r.memoryUrn).catch(() => null);
            childReadable.set(r.memoryUrn, mem && (await canReadMemory(db, auth, mem.id, EXPLICIT_REF)) ? mem.id : null);
          }
          const childId = childReadable.get(r.memoryUrn);
          const effective = childId ? await findEffectiveNodeIdByLoc(db, childId, r.literalLoc ?? r.loc) : null;
          const inherited = effective?.inheritedFrom
            ? await db.node.findFirst({ where: { id: effective.id, deletedAt: null }, include: projectionInclude, omit: { content: true } })
            : null;
          if (inherited && effective?.inheritedFrom) {
            markInherited([inherited], new Map([[inherited.memoryId, effective.inheritedFrom]]));
            nodeByRef.set(r.raw, inherited as unknown as ReadProjectionNode & { id: string });
          } else {
            unavailable.push(r.raw);
          }
        }

        // PK refs: gate BEFORE fetching the projection, mirroring the URN path
        // above (which gates a memory, then reads only inside it). A PK carries
        // no memory, so that takes two queries: a cheap id+memoryId probe to
        // learn each row's memory, then the full projection for the readable
        // subset only. Fetching everything first and filtering after would pull
        // denied nodes' content and edges into memory just to discard them —
        // wasted work on a 200-ref batch, and content the caller was refused
        // has no reason to be materialized at all (PR #824 review, Copilot).
        //
        // A PK naming an unreadable node and a PK naming nothing both land in
        // `unavailable`, indistinguishably — the same answer the URN path gives
        // (cor:api:040:03).
        if (pkRefs.length > 0) {
          const probes = await db.node.findMany({
            where: { id: { in: pkRefs }, deletedAt: null },
            select: { id: true, memoryId: true },
          });
          const readable = new Map<string, boolean>();
          for (const memId of new Set(probes.map((p) => p.memoryId))) {
            readable.set(memId, await canReadMemory(db, auth, memId, EXPLICIT_REF));
          }
          const allowedIds = probes.filter((p) => readable.get(p.memoryId)).map((p) => p.id);
          const rowById = new Map(
            (allowedIds.length > 0
              ? await db.node.findMany({
                  where: { id: { in: allowedIds } },
                  include: projectionInclude, omit: { content: true },
                })
              : []
            ).map((r) => [r.id, r]),
          );
          for (const pk of pkRefs) {
            const row = rowById.get(pk);
            if (row) {
              nodeByRef.set(pk, row as unknown as ReadProjectionNode & { id: string });
            } else {
              unavailable.push(pk);
            }
          }
        }

        // Reassemble in input order (cor:api:040:01), deduping on the RESOLVED
        // node so a PK and that node's URN in one call render — and bill — once.
        const seenIds = new Set<string>();
        for (const raw of uniqueRefs) {
          const n = nodeByRef.get(raw);
          if (!n) continue;
          // Recorded BEFORE the seen-check: one node can be named twice in a
          // batch — once by PK, once by a #data URN — and skipping first drops
          // the notice whenever the plain ref happens to come earlier. My last
          // commit claimed to have handled exactly this and did not
          // (PR #1088 review, Copilot).
          const frag = fragmentByRef.get(raw);
          if (frag && !fragmentByNodeId.has(n.id)) fragmentByNodeId.set(n.id, frag);
          if (seenIds.has(n.id)) continue;
          seenIds.add(n.id);
          echoByNodeId.set(n.id, raw);
          ordered.push(n);
        }
      }

      // Render in order, packing until the response-size cap. Over the cap we
      // stop and flag `truncated` (cor:api:040:02) — never a silent short read.
      // At least one node always renders so a single oversize node still
      // returns. One `read` UsageEvent per RETURNED node (cor:api:040:01 —
      // per-node parity with hadron_get_node).
      const blocks: string[] = [];
      const omitted: string[] = [];
      const readEvents: UsageNodeRef[] = [];
      let bytes = 0;
      let truncated = false;
      const visible: ReadProjectionNode[] = [];
      for (const selected of ordered) {
        // #1885 — recheck the child through which the inherited row was admitted.
        const inheritedFrom = (selected as { inheritedFrom?: InheritedFrom }).inheritedFrom;
        const n = await loadCurrentReadProjection(selected.id, selected.memoryId, auth, inheritedFrom?.via ?? prefixReadMemoryId ?? selected.memoryId, 'metadata');
        if (
          !n ||
          n.memoryId !== selected.memoryId ||
          n.loc !== selected.loc ||
          (!inheritedFrom && !(await canReadMemory(db, auth, n.memoryId, EXPLICIT_REF)))
        ) {
          unavailable.push(echoByNodeId.get(selected.id) ?? selected.id);
          continue;
        }
        // Re-check the version actually served (Diego, #1891 P2-1): a single
        // ref against the child it came through, a prefix row against the
        // prefix's whole scope.
        const stillShown = !inheritedFrom
          || (inheritedFrom.via
            ? await stillInherited(db, inheritedFrom, n)
            : prefixInheritance !== null && (await retainEffective(db, [n], prefixInheritance)).length === 1);
        if (!stillShown) {
          unavailable.push(echoByNodeId.get(selected.id) ?? selected.id);
          continue;
        }
        if (inheritedFrom) markInherited([n], new Map([[n.memoryId, inheritedFrom]]));
        visible.push(n);
      }
      // #1326: the single-node renderer queries one latest report and up to
      // two task refs per node. At the 200-node batch cap those lookups were
      // serialized inside this loop. Prefetch only after reconciliation, so
      // each report is judged against the revision the batch will actually
      // render, and gate each distinct task memory before exposing its URN.
      const reports = await batchValidationReports(visible);
      const memoryUrnOf = memoizedMemoryUrnLookup();
      // #1632: signatures for the batch in one load; their signers join the
      // one human-name lookup. #1885: never for an inherited node, whose line
      // is blank, so the base's signers are not even looked up.
      const signatures = signingSurfacePolicy().signing
        ? await loadSignatureStatuses(db, visible
          .filter((n) => !(n as { inheritedFrom?: InheritedFrom }).inheritedFrom)
          .map((n) => n.id))
        : new Map<string, NodeSignatureStatusView>();
      const signerIds = [...signatures.values()].flatMap((st) => st.signatures.map((sig) => sig.signerId));
      const [taskRefs, humanNames, feedback, actionUrns] = await Promise.all([
        batchReadableTaskRefs(visible, reports, auth, memoryUrnOf),
        batchHumanNames(visible, signerIds),
        openThreadCounts(db, visible.map((n) => n.id)),
        batchActionUrns(visible),
      ]);
      const batchProvenance = { reports, taskRefs, humanNames, feedback, signatures, actionUrns };
      const batchReadCtx = scopeCtx(); // one memo for the whole call (#2041)
      for (const metadata of visible) {
        if (truncated) {
          omitted.push(await nodeUrn(metadata.loc, metadata.memoryId, memoryUrnOf));
          continue;
        }
        const inheritedFrom = (metadata as { inheritedFrom?: InheritedFrom }).inheritedFrom;
        const via = inheritedFrom?.via ?? prefixReadMemoryId ?? metadata.memoryId;
        const mode = scope === 'abstract' ? (raw ? 'abstract-raw' : 'abstract-expanded') : 'body';
        const n = await loadCurrentReadProjection(metadata.id, metadata.memoryId, auth, via, mode);
        if (!n || n.memoryId !== metadata.memoryId || n.loc !== metadata.loc
          || (!inheritedFrom && !(await canReadMemory(db, auth, n.memoryId, EXPLICIT_REF)))
          || (inheritedFrom && !(inheritedFrom.via
            ? await stillInherited(db, inheritedFrom, n)
            : prefixInheritance !== null && (await retainEffective(db, [n], prefixInheritance)).length === 1))) {
          unavailable.push(echoByNodeId.get(metadata.id) ?? metadata.id);
          continue;
        }
        if (inheritedFrom) markInherited([n], new Map([[n.memoryId, inheritedFrom]]));
        // A concurrent revision after metadata prefetch must not pair the new
        // body with provenance selected for an older revision. Only raced rows
        // fall back to the single renderer's current provenance reads.
        const provenance = n.revSeq === metadata.revSeq ? batchProvenance : undefined;
        const lockState = mcpDecryptOrMark(n); // spec 041 — same posture as hadron_get_node
        const served = lockState === 'locked' || raw
          ? n
          : { ...n, content: await resolveNodeContent(batchReadCtx, n, { raw }) };
        const projection = await renderNodeReadProjection(served, scope, {
          locked: lockState === 'locked',
          encryptedMemory: lockState !== 'plaintext',
          auth,
          batch: provenance,
          memoryUrnOf,
        });
        // Measured on the ANNOTATED block, which is what actually ships: sizing
        // the bare projection and pushing the annotated one lets a block cross
        // the advertised hard cap and leaves every later check counting from an
        // undercounted total (PR #1088 review, Codex P2).
        const block = noteFragment(projection, fragmentByNodeId.get(n.id));
        const size = Buffer.byteLength(block, 'utf8');
        if (blocks.length > 0 && bytes + size > BATCH_READ_MAX_BYTES) {
          truncated = true;
          omitted.push(await nodeUrn(n.loc, n.memoryId, memoryUrnOf));
          continue;
        }
        blocks.push(block);
        bytes += size;
        readEvents.push({ id: n.id, loc: n.loc, memoryId: n.memoryId });
      }
      // One batched insert for all returned nodes' read events, fire-and-forget
      // (parity with hadron_get_node's non-blocking single create). A per-node
      // create loop would fire up to BATCH_READ_MAX_NODES concurrent unawaited
      // inserts and pressure the connection pool — createMany is one round-trip
      // (PR #283 review). Only nodes that made it into the response are pushed
      // above, so a node the byte cap omitted records no read.
      recordNodeUsage(db, 'read', readEvents, auth);

      const headerParts = [`returned ${blocks.length} node(s)`];
      if (unavailable.length) headerParts.push(`${unavailable.length} unavailable`);
      if (truncated) headerParts.push(`truncated: response-size cap reached, ${omitted.length} omitted`);
      const parts: string[] = [`Batch read — ${headerParts.join('; ')}.`];
      if (blocks.length) {
        parts.push(blocks.join('\n\n────────────────────────────────────────\n\n'));
      }
      if (unavailable.length) {
        parts.push(
          `Unavailable (denied or not found):\n${unavailable.map((u) => `  - ${u}`).join('\n')}`,
        );
      }
      if (truncated) {
        parts.push(
          `Omitted (response-size cap — re-request with contentScope: 'abstract' or a narrower set):\n${omitted
            .map((u) => `  - ${u}`)
            .join('\n')}`,
        );
      }
      return textResult(parts.join('\n\n'));
    },
  );

  // ── hadron_get_next_node ─────────────────────────────────────────────────────

  server.tool(
    'hadron_get_next_node',
    'Read the next sibling node under a parent, ordered by `seq`. Returns the first child if current is omitted. The URN MUST be fully qualified (hrn:node:<root>:<memory>:<loc>).',
    SHAPE_HADRON_GET_NEXT_NODE,
    async ({ parent: rawParent, current: rawCurrent, raw }) => {
      // Spec 022: qualification at the API boundary.
      try {
        assertFullyQualifiedUrn(rawParent, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return refusalResult(`Parent: ${e.message}`);
        throw e;
      }
      if (rawCurrent) {
        try {
          assertFullyQualifiedUrn(rawCurrent, 'node');
        } catch (e) {
          if (e instanceof UrnNotQualifiedError) return refusalResult(`Current: ${e.message}`);
          throw e;
        }
      }

      const { memoryUrn, loc: parentLoc } = splitNodeUrn(rawParent);
      const memory = await resolveMemoryByUrn(memoryUrn);
      if (!memory) {
        return refusalResult(`Memory not found: "${memoryUrn}".`);
      }
      if (!(await canReadMemory(db, auth, memory.id, EXPLICIT_REF))) {
        return refusalResult(`Memory not found: "${memoryUrn}".`);
      }
      const prefix = parentLoc + ':';

      const allNodes = await db.node.findMany({
        // #180 Bug 2: skip tombstoned children so `next` doesn't land on
        // a soft-deleted row and either error or expose stale content.
        where: { memoryId: memory.id, loc: { startsWith: prefix }, deletedAt: null },
        orderBy: { loc: 'asc' },
      });
      // Direct children only (no further colons after prefix)
      // #857 review: the comparator is SHARED with the GraphQL `nextNode`
      // query (src/lib/siblingOrder.ts) so the two surfaces cannot present
      // different reading orders. Behavior is unchanged here — that file is
      // this logic, lifted, with the equal-seq loc tiebreak made explicit
      // rather than relying on Array.sort stability over a loc-ordered fetch.
      const children = sortSiblings(
        allNodes.filter((n) => !n.loc.slice(prefix.length).includes(':')),
      );

      if (children.length === 0) {
        return textResult(`No children found under "${parentLoc}".`);
      }

      let next;
      if (!rawCurrent) {
        next = children[0];
      } else {
        const { memoryUrn: currentMemoryUrn, loc: currentLoc } = splitNodeUrn(rawCurrent);
        if (currentMemoryUrn !== memoryUrn) {
          return textResult(`Current URN's memory (${currentMemoryUrn}) doesn't match parent's memory (${memoryUrn}).`);
        }
        const idx = children.findIndex((n) => n.loc === currentLoc);
        if (idx === -1) {
          return refusalResult(`Current node "${currentLoc}" not found among children of "${parentLoc}".`);
        }
        if (idx + 1 >= children.length) {
          return textResult(`No more nodes after "${currentLoc}".`);
        }
        next = children[idx + 1];
      }

      const nextRow = await db.node.findUnique({
        where: { id: next.id },
        include: {
          // #180 Bug 2: hide edges whose other end is tombstoned.
          outgoingEdges: {
            include: { target: true },
            where: { target: { deletedAt: null } },
            orderBy: edgeDisplayOrder(),
          },
          incomingEdges: {
            include: { source: true },
            where: { source: { deletedAt: null } },
            orderBy: edgeDisplayOrder(),
          },
        },
      });
      if (!nextRow) return refusalResult('Node not found.');
      const node = await concealUnreadableEdgeEnds(auth, nextRow); // #1647

      // #1061 — this tool returns the node's full content, exactly as
      // hadron_get_node does, so it records the same single read. Its GraphQL
      // twin (`nextNode`) gets there by delegating to `node(ref:)`; this one has
      // its own projection, so it records here.
      recordNodeRead(db, { id: node.id, loc: node.loc, memoryId: node.memoryId }, auth);

      const memoryUrnOf = memoizedMemoryUrnLookup();
      const { urn, fellBack: urnFellBack } = await nodeUrnResult(node.loc, node.memoryId, memoryUrnOf);
      const outEdgeLines = await Promise.all(node.outgoingEdges.map(async (e) => {
        const targetUrn = await nodeUrn(e.target.loc, (e.target as any).memoryId, memoryUrnOf);
        // #322: surface the target's stable PK alongside the URN.
        return `  - ${targetUrn} (id: ${e.target.id}) (${e.target.name}) — ${e.name ?? e.loc}${governedKindAnnotation((e as { governedKind?: unknown }).governedKind)}`;
      }));
      // #186: nodeType in the meta block, mirroring hadron_get_node's format.
      // #881 — parity with hadron_get_node, including the fallback-URN omission.
      const nextPortalUrl = urnFellBack ? null : portalUrlForUrn(urn);
      const meta = [
        `**${node.name}**`,
        urn,
        // #322: stable PK (immutable across move/rename) — see hadron_get_node.
        `ID: ${node.id}`,
        nextPortalUrl ? `URL: ${nextPortalUrl}` : '',
        node.description ? `> ${node.description}` : '',
        `Type: ${node.nodeType}`,
        node.tags.length ? `Tags: ${node.tags.join(', ')}` : '',
        node.seq !== null ? `Seq: ${node.seq}` : '',
        outEdgeLines.length ? `Related:\n${outEdgeLines.join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      const body = raw ? node.content : await resolveNodeContent(scopeCtx(), node, { raw });
      return textResult(meta + '\n\n---\n\n' + (body || ''));
    },
  );

  // ── hadron_list_nodes ─────────────────────────────────────────────────────────

  server.tool(
    'hadron_list_nodes',
    'Browse the tree structure of a Hadron memory. Returns an indented tree view.',
    SHAPE_HADRON_LIST_NODES,
    async ({ parentRel, memoryUrn, depth, isRunnable }) => {
      try {
        validateParentRel(parentRel);
      } catch (e) {
        if (e instanceof InvalidParentRelError) return refusalResult(e.message);
        throw e;
      }

      // Normalize parentRel once (matches the hadron_find_nodes pattern).
      const trimmedParentRel = parentRel?.trim();

      // Spec 022 (FR-003): no fallback to `activeMemoryUrn`. Caller MUST
      // supply either `memoryUrn` or `parentRel`.
      if (!memoryUrn && !trimmedParentRel) {
        return textResult('Please provide a memoryUrn or parentRel.');
      }

      const memoryIds = await getAccessibleMemoryIds(db, auth);
      const maxDepth = depth ?? 1;

      // Resolve the parent prefix
      let prefix: string;
      let memoryId: string | undefined;
      if (trimmedParentRel) {
        const parent = await resolveParentForRead(trimmedParentRel, memoryUrn, memoryIds, auth);
        if (!parent.ok) return refusalResult(parent.message);
        prefix = parent.loc;
        memoryId = parent.memoryId;
      } else {
        prefix = '';
        // Find memory by URN. #100 #3: route through resolveMemoryByUrn so
        // a canonical 'urn:memory:' input doesn't miss against bare-stored
        // Memory.urn. Spec 022: require qualification at this boundary.
        if (memoryUrn) {
          try {
            assertFullyQualifiedUrn(memoryUrn, 'memory');
          } catch (e) {
            if (e instanceof UrnNotQualifiedError) return refusalResult(e.message);
            throw e;
          }
          const mem = await resolveMemoryByUrn(memoryUrn);
          if (!mem) {
            return textResult(
              `Memory not found or invalid: '${memoryUrn}'. Use hadron_list_memories to see what is available.`,
            );
          }
          // #188 (Gemini): canReadMemory gate — same shape as the
          // hadron_find_nodes memoryUrn branch.
          if (!(await canReadMemory(db, auth, mem.id, EXPLICIT_REF))) {
            return textResult(
              `Memory not found or invalid: '${memoryUrn}'. Use hadron_list_memories to see what is available.`,
            );
          }
          memoryId = mem.id;
        }
      }

      // #180 Bug 2: tombstoned nodes are not part of the live tree, so
      // they shouldn't show up in browse output. (Their absence also
      // means a parent ceases to be "implicit" once its only child is
      // soft-deleted — the synthesize-parent pass below operates on the
      // filtered set.)
      // #1608 (cor:dmo:110:08) — the content tree: comments are feedback beside
      // it, found with hadron_find_nodes nodeKind COMMENTS (GraphQL contentScope).
      const where: Record<string, unknown> = { deletedAt: null, nodeType: { not: COMMENT_NODE_TYPE } };
      if (prefix) where.loc = { startsWith: prefix + ':' };
      if (memoryId) where.memoryId = memoryId;
      else if (memoryIds) where.memoryId = { in: memoryIds };
      else {
        // memoryIds === null ⇒ ADMIN/OWNER "see all", and no single memory was
        // resolved (bare parentRel loc). WITHOUT this carve-out the query would
        // browse EVERY memory at the loc prefix, exposing another user's
        // personal/private nodes (FR-016) AND (spec 047) user-owned nodes to a
        // platform admin — the canReadMemory gate above only fires when a
        // memoryId resolved. Mirror the globalSearch admin carve-out (codex
        // review, #676).
        where.memory = {
          NOT: foreignIdentityScopedMemoryFilter(auth.userId),
        };
      }
      // NB: the runnable filter (cor:api:060) is applied IN-MEMORY below, not
      // here — see the realByKey/nodes split. Filtering it into this DB query
      // would hide real-but-non-runnable ancestors (parent nodes are usually
      // isRunnable=null), so the synthesize-parent walk would mislabel them as
      // "(missing — materialize)" even though they exist.

      // #1885 (cor:dmo:050:14) — one memory listed reads as its effective
      // memory: an Agent's system memory gains its bases' inherited nodes,
      // without their overridden nodes or boot prompts. They are listed in the
      // child's tree, under their own URNs, marked (realMemoryId below).
      const inheritance = memoryId ? await effectiveScope(db, [memoryId]) : null;
      if (inheritance && inheritance.memoryIds.length > 1) {
        where.memoryId = { in: inheritance.memoryIds };
        if (inheritance.excludeNodeIds.length > 0) where.id = { notIn: inheritance.excludeNodeIds };
      }

      let allNodes: Array<Awaited<ReturnType<typeof db.node.findMany>>[number] & { realMemoryId?: string; inheritedFrom?: InheritedFrom }> =
        await db.node.findMany({ where, orderBy: { loc: 'asc' } });
      // The exclusion list was a snapshot: re-check what was read (P2-1).
      if (inheritance && inheritance.inheritedFrom.size > 0) allNodes = await retainEffective(db, allNodes, inheritance);
      if (inheritance && memoryId && inheritance.inheritedFrom.size > 0) {
        allNodes = allNodes.map((n) => {
          const from = inheritance.inheritedFrom.get(n.memoryId);
          return from ? { ...n, memoryId, realMemoryId: n.memoryId, inheritedFrom: from } : n;
        });
      }

      // A bare parentRel can match the same loc in more than one memory. For
      // An unpinned parent can match the same loc in more than one memory. The
      // query above is only a coarse candidate filter, for both ADMIN/OWNER
      // callers (`memoryIds === null`) and ordinary callers (whose App-derived
      // allow-list can contain legacy/directly-created rows). Re-run the
      // canonical gate for every candidate memory before rendering:
      // personal/private access also depends on identity, the selected App and,
      // for legacy rows, the installed Agent + active subscription.
      if (!memoryId) {
        const readableMemoryIds = await filterReadableMemoryIds(
          db,
          auth,
          allNodes.map((node) => node.memoryId),
        );
        allNodes = allNodes.filter((node) => readableMemoryIds.has(node.memoryId));
      }

      // Deduplicate by (memoryId, loc): prefer canonical (isLink=false)
      // over link nodes. Multi-memory listings (memoryUrn unset, parentRel
      // resolving without a memoryId) can legitimately have the same loc
      // in two different memories, so the key MUST include memoryId.
      const dedupKey = (memId: string, loc: string) => `${memId}::${loc}`;
      const byKey = new Map<string, typeof allNodes[0]>();
      for (const n of allNodes) {
        const k = dedupKey(n.memoryId, n.loc);
        const existing = byKey.get(k);
        if (!existing || (existing.isLink && !n.isLink)) byKey.set(k, n);
      }
      const allDeduped = Array.from(byKey.values());
      // Runnable filter (cor:api:060) — prune the VISIBLE rows + child counts
      // to (non-)task nodes. `realByKey` is intentionally built from the
      // UNFILTERED set so the synthesize-parent walk renders a real-but-non-
      // runnable ancestor (typical parent node: isRunnable=null) as the node it
      // is, rather than a misleading "(missing — materialize)" gap. An implicit
      // parent still surfaces only when a matching descendant keeps it in view.
      const realByKey = new Map(
        allDeduped.map((n) => [dedupKey(n.memoryId, n.loc), n] as const),
      );
      const nodes =
        isRunnable != null
          ? allDeduped.filter((n) => n.isRunnable === isRunnable)
          : allDeduped;

      // Depth math: prefix has `prefixDepth` segments; a node's depth-
      // relative-to-prefix is the number of segments BEYOND the prefix
      // (1 = direct child).
      const prefixDepth = prefix ? prefix.split(':').length : 0;
      const depthRelative = (loc: string) => loc.split(':').length - prefixDepth;
      const isWithinScope = (loc: string) =>
        !prefix || loc === prefix || loc.startsWith(prefix + ':');

      // Issue #183 (#3, #4): render a true tree rather than a flat
      // depth-from-colons list.
      //   - Indent reflects actual parent depth in this view (a depth-2
      //     loc following an unrelated depth-1 loc no longer LOOKS like
      //     a child of it — the previous renderer indented purely by
      //     colon count, which made orphaned subtrees appear nested
      //     under the previous row).
      //   - Missing intermediate parents are synthesized so a node
      //     added bottom-up (e.g. `data-model:entities:user` with no
      //     `data-model:entities`) shows the gap explicitly instead of
      //     leaving the descendant visually floating.
      interface TreeRow {
        loc: string;
        depth: number;
        node: typeof allNodes[0] | null; // null = synthesized intermediate
        memoryId: string;
      }
      const visibleByKey = new Map<string, TreeRow>();

      for (const n of nodes) {
        const d = depthRelative(n.loc);
        if (d <= 0) continue;
        const k = dedupKey(n.memoryId, n.loc);
        // Only nodes within the depth window become visible rows; deeper
        // nodes still feed the synthesize-parent walk so their in-window
        // ancestors materialize (#185 F4 — a depth-2 orphan must surface
        // its missing depth-1 parent at maxDepth=1).
        if (d <= maxDepth) {
          visibleByKey.set(k, { loc: n.loc, depth: d, node: n, memoryId: n.memoryId });
        }

        // Walk up the parent chain WITHIN this memory and add missing
        // intermediates as synthesized rows for ancestors that fall in
        // the depth window. Before #185 F4 this loop early-exited any
        // node deeper than maxDepth, so implicit parents at depth=1
        // with only depth=2+ children rendered as gaps — agents read
        // those gaps as "data lost."
        let cur = n.loc;
        while (true) {
          const idx = cur.lastIndexOf(':');
          if (idx === -1) break;
          cur = cur.substring(0, idx);
          const pd = depthRelative(cur);
          if (pd <= 0) break;
          if (!isWithinScope(cur)) break;
          if (pd > maxDepth) continue; // ancestor out of window; keep walking up
          const pk = dedupKey(n.memoryId, cur);
          if (visibleByKey.has(pk)) break;
          const real = realByKey.get(pk) ?? null;
          visibleByKey.set(pk, { loc: cur, depth: pd, node: real, memoryId: n.memoryId });
        }
      }

      if (visibleByKey.size === 0) {
        return textResult(`No child nodes found under "${prefix || memoryUrn}".`);
      }

      // Sort so parents render before children. Across memories, sort
      // by memoryId first to keep each memory's subtree contiguous.
      // Within a memory, compare loc SEGMENT-BY-SEGMENT instead of
      // running localeCompare on the full string: `:` is ASCII 58, so
      // a sibling like `services-helper` (ASCII `-` = 45) or any digit
      // sorts BEFORE `services:db` (a child of `services`) under a
      // naive string compare, splitting parents from their descendants
      // in the rendered tree. Segment-by-segment compare keeps the
      // hierarchy intact: same prefix → shorter path wins (parent
      // first), then break the tie at the first differing segment.
      const compareLocs = (a: string, b: string): number => {
        const aParts = a.split(':');
        const bParts = b.split(':');
        const minLen = Math.min(aParts.length, bParts.length);
        for (let i = 0; i < minLen; i++) {
          if (aParts[i] !== bParts[i]) return aParts[i].localeCompare(bParts[i]);
        }
        return aParts.length - bParts.length;
      };
      const sortedRows = Array.from(visibleByKey.values()).sort((a, b) => {
        if (a.memoryId !== b.memoryId) return a.memoryId.localeCompare(b.memoryId);
        return compareLocs(a.loc, b.loc);
      });

      const memoryUrnOf = memoizedMemoryUrnLookup();
      const lines = await Promise.all(sortedRows.map(async (row) => {
        const indent = '  '.repeat(row.depth - 1);
        // Direct-child count uses the full node set (not just visible
        // rows) so the hint reflects what's actually in the memory,
        // even when the depth window hides them.
        const childPrefix = row.loc + ':';
        const rowSegCount = row.loc.split(':').length;
        const childCount = nodes.filter((c) =>
          c.memoryId === row.memoryId &&
          c.loc.startsWith(childPrefix) &&
          c.loc.split(':').length === rowSegCount + 1,
        ).length;
        const childInfo = childCount > 0 ? ` (${childCount} children)` : '';
        const real = row.node as { realMemoryId?: string; inheritedFrom?: InheritedFrom } | null | undefined;
        const nUrn = await nodeUrn(row.loc, real?.realMemoryId ?? row.memoryId, memoryUrnOf);
        if (row.node) {
          const inherited = real?.inheritedFrom ? ` (inherited from ${emitEntityUrnV2('agent', real.inheritedFrom.agentUrn)})` : '';
          return `${indent}├── ${nUrn} — ${row.node.name} [${(row.node as { nodeType?: string }).nodeType ?? 'info'}]${inherited}${childInfo}`;
        }
        // Synthesized intermediate. Surface the gap explicitly rather
        // than silently rendering it as a real row.
        return `${indent}├── ${nUrn} — (missing — use hadron_create_parent_node to materialize)${childInfo}`;
      }));

      const header = `Tree: ${prefix || memoryUrn}`;
      return textResult(`${header}\n${lines.join('\n')}`);
    },
  );

  // Spec 031 — normalize an inbound `abstract` value before the DB write.
  // Length cap on the raw input; then trim-then-check (empty AND
  // whitespace-only collapse to null; non-empty trimmed values persist
  // untrimmed so intentional surrounding whitespace on real paragraphs
  // is lossless). `undefined` (key absent on hadron_update_node) is passed
  // through unchanged so the caller can implement "omitted = preserve"
  // by spreading conditionally. The throw is the typed-error class —
  // the MCP transport catches and surfaces the error message to the
  // caller as a tool-result error.
  function normalizeAbstract(raw: string | null | undefined): string | null | undefined {
    if (raw === undefined) return undefined;
    if (raw === null) return null;
    if (raw.length > 2000) {
      throw new NodeAbstractTooLongError(raw.length);
    }
    if (raw.trim() === '') return null;
    return raw;
  }

  // ── hadron_unlock_memory / hadron_lock_memory (spec 041 PR-2, closes #206) ──

  server.tool(
    'hadron_unlock_memory',
    'Unlock an encrypted PRIVATE memory for THIS MCP session (spec 041). Supply exactly one of passphrase / dataKey; owner-only. While unlocked, reads return plaintext and writes encrypt; other sessions are unaffected. The key lives only in server memory — never on disk — and is dropped when the session closes, via hadron_lock_memory, or after the memory goes UNUSED for the key-cache idle window (#1114; 24h by default, and every read or write refreshes it, so an unlock you are actually using does not expire under you). That last case is the one to expect: after a long quiet stretch a read may report the memory locked again with no lock and no disconnect having happened — call this tool again. Key material outliving all use is a worse failure than an extra unlock, which is why the expiry exists rather than the promise being unconditional.',
    SHAPE_HADRON_UNLOCK_MEMORY,
    async ({ memoryUrn, passphrase, dataKey }) => {
      // Owner-only, mirroring the GraphQL header-unlock rule (PR-514):
      // private memories are owner-only by class; an App-key session has no
      // business unlocking them, and unowned refs get a uniform not-found.
      if (!auth.userId) {
        return refusalResult('hadron_unlock_memory requires a user-authenticated MCP connection.');
      }
      const sid = getSessionId();
      if (!sid) return textResult('No active MCP session.');
      // #2122: these two tools accept IDs per Vera's disposition (cor:api:010:01);
      // keep other tools on their existing URN-only resolver and preserve the owner gate below.
      const mem = isId(memoryUrn)
        ? await db.memory.findFirst({ where: { id: memoryUrn, deletedAt: null }, select: { id: true, urn: true } })
        : await resolveMemoryByUrn(memoryUrn);
      const row = mem
        ? await db.memory.findUnique({
            where: { id: mem.id },
            select: {
              id: true, urn: true, userId: true, isEncrypted: true,
              kdfSalt: true, kdfParams: true, keyVerifier: true,
            },
          })
        : null;
      if (!row || row.userId !== auth.userId) {
        return refusalResult(`Memory "${memoryUrn}" not found.`);
      }
      if (!row.isEncrypted) {
        return textResult(`Memory "${row.urn}" is not encrypted.`);
      }
      try {
        const key = await resolveSuppliedKey(row, { passphrase, dataKey });
        sessionKeyCache.set(`mcp:${sid}`, row.id, key);
      } catch (err) {
        if (err instanceof MemoryUnlockError || err instanceof SessionKeyConflictError) return refusalResult(err.message);
        // Anything not typed is a fault (#1789).
        return toolErrorResult(err, () => String((err as Error).message), 'hadron_unlock_memory');
      }
      return textResult(
        `Memory unlocked for this session: ${row.urn}. Reads now return plaintext; writes encrypt. ` +
          'The key is dropped when this session ends (or call hadron_lock_memory).',
      );
    },
  );

  server.tool(
    'hadron_lock_memory',
    'Drop THIS MCP session\'s key for an encrypted memory (spec 041) — reads return to locked markers, writes to it are rejected. Other sessions holding the key are unaffected.',
    SHAPE_HADRON_LOCK_MEMORY,
    async ({ memoryUrn }) => {
      const sid = getSessionId();
      if (!sid) return textResult('No active MCP session.');
      // Same owner gate + uniform not-found as hadron_unlock_memory
      // (PR-517 review, Codex P2): without it, the existing-vs-missing
      // response split makes lock an existence oracle for private URNs.
      if (!auth.userId) {
        return refusalResult('hadron_lock_memory requires a user-authenticated MCP connection.');
      }
      // #2122: these two tools accept IDs per Vera's disposition (cor:api:010:01);
      // keep other tools on their existing URN-only resolver and preserve the owner gate below.
      const mem = isId(memoryUrn)
        ? await db.memory.findFirst({ where: { id: memoryUrn, deletedAt: null }, select: { id: true, urn: true } })
        : await resolveMemoryByUrn(memoryUrn);
      const row = mem
        ? await db.memory.findUnique({ where: { id: mem.id }, select: { id: true, userId: true } })
        : null;
      if (!row || row.userId !== auth.userId) {
        return refusalResult(`Memory "${memoryUrn}" not found.`);
      }
      sessionKeyCache.release(`mcp:${sid}`, row.id);
      return textResult(`Memory locked for this session: ${memoryUrn}.`);
    },
  );

  // #2044 (cor:agt:040:06): `install: { app, agent }` on hadron_create_node / hadron_update_node
  // targets an App's install memory. Both delegate to the GraphQL createNode / updateNode, so the
  // first-customisation create, the authority anchors and the gates are the ones the portal uses.
  const writeInstallNodeViaGraphql = async (
    op: 'create' | 'update',
    install: { app: string; agent: string },
    fields: Record<string, unknown>,
  ) => {
    const ctx: Context = {
      db,
      transport: 'mcp',
      governedCanReplay: () => true,
      clientId: auth.clientId ?? undefined,
      userId: auth.userId ?? undefined,
      apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId,
      appId: auth.appId ?? undefined,
      sessionId: auth.sessionId ?? undefined,
      roles: auth.roles as Context['roles'],
      organizationId: auth.organizationId ?? undefined,
    };
    const input = { ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), install: { appRef: install.app, agentRef: install.agent } };
    try {
      const node = op === 'create'
        ? await resolvers.Mutation.createNode({}, { input: input as never }, ctx)
        : await resolvers.Mutation.updateNode({}, { input: input as never }, ctx);
      const urn = await nodeUrn(node.loc, node.memoryId);
      return textResult(`${op === 'create' ? 'Node created' : 'Node updated'} in the App's install memory: ${urn} (id: ${node.id})${renderIncludePinWarnings(await includePinWarningsFor(ctx, node))}`);
    } catch (e) {
      return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : `${op} failed`}`, `hadron_${op}_node:install`);
    }
  };

  // ── hadron_create_node ───────────────────────────────────────────────────────────

  server.tool(
    'hadron_create_node',
    'Add a NEW node to the memory graph. The URN MUST be fully qualified (hrn:node:<root>:<memory>:<loc>). Requires write access to the memory. CREATE-ONLY: a loc that already holds a live node is REFUSED, not overwritten — use hadron_update_node to edit an existing node (#1181; same contract as the GraphQL createNode mutation). A loc holding a SOFT-DELETED node is the one exception: that row is resurrected and rewritten, so an omitted `description`, `abstract`, `content` or `tags` is CLEARED rather than carried over from the tombstone (the other fields — nodeType, objectType, isRunnable, seq, properties, data, llmModel, aiAgent — are kept when omitted). Resurrection snapshots the prior state to revision history first (#976), and encryption is honored.',
    SHAPE_HADRON_CREATE_NODE,
    async ({ urn: rawUrn, name, nodeType, objectType, isRunnable, role: rawRole, description, abstract, content, seq, tags, properties, data: nodeData, llmModel, aiAgent, edges, install }) => {
      // #2044: an App's install memory is written through the GraphQL operation (one write path
      // for the first-customisation create), not this inline parity writer.
      if (install) {
        if (edges || isRunnable) return textResult('`install` does not support `edges` or `isRunnable`; write those with a plain memory node.');
        return writeInstallNodeViaGraphql('create', install, {
          loc: rawUrn, name, nodeType, objectType, role: rawRole, description, abstract, content, seq, tags: tags as never,
          properties, data: nodeData, llmModel, aiAgent,
        });
      }
      // #1219 — this tool is an inline parity writer, NOT a writeNodeCore
      // delegate (#206), so the core's role normalization does not reach it:
      // normalize here, before the governance probe and the payload build.
      const role = normalizeRole(rawRole);
      // Spec 022: enforce qualification at the API boundary. Relative-form
      // URNs (e.g., `review:sort-imports` without org+memory) reject here
      // before any DB lookup runs.
      try {
        assertFullyQualifiedUrn(rawUrn, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return refusalResult(e.message);
        throw e;
      }

      // Split into memory URN + loc and resolve the memory.
      const { memoryUrn, loc, fragment } = splitNodeUrn(rawUrn);
      const fragRefusal = nodeFragmentRefusal(rawUrn, fragment);
      if (fragRefusal) return refusalResult(fragRefusal);
      // #1316: hidden from this caller ⇒ the missing branch; a reader keeps the denial.
      const memory = await resolveVisibleMemoryByUrn(auth, memoryUrn, 'write');
      if (!memory) {
        return refusalResult(`Memory not found: "${memoryUrn}".`);
      }
      const memoryId = memory.id;

      try {
        validateLoc(loc);
      } catch (e) {
        return e instanceof InvalidLocError ? refusalResult(e.message) : toolErrorResult(e, () => (e as Error).message, 'hadron_create_node:validateLoc');
      }

      if (!(await canWriteToMemory(db, auth, memoryId, EXPLICIT_REF))) {
        return refusalResult(`Write access denied for this memory.${await explainWriteRefusal(db, auth, memoryId)}`);
      }

      // #1201 — the GOVERNED-KIND gate, on the state this create would PRODUCE.
      // Inline here for the same reason as on hadron_update_node: this handler
      // is a parity implementation of writeNodeCore (#206), not a delegate, and
      // MCP is the surface an agent actually reaches — which makes it the
      // threat this mechanism exists for rather than an afterthought. No
      // ownsKind is ever passed: there is deliberately no MCP door, and that
      // absence is what keeps the agent surface on the refused path.
      //
      // MERGED with whatever is at the loc, tombstone included (@copilot,
      // PR #1203 round 2) — the identical defect to the one fixed in
      // writeNodeCore, left behind here because this handler is a PARITY
      // implementation and I fixed one consumer of the shared rule and not the
      // other. This tool resurrects a soft-deleted row and preserves the fields
      // the caller omits, so the resulting state can be governed while the
      // input names nothing.
      //
      // The probe is read AFTER this point in the handler, so it is read here
      // instead; it is the same stale-read-for-payload-purposes row, and the
      // authoritative decision for a RACE is the one writeNodeCore takes under
      // the lock. What this closes is the ordinary, unraced case.
      const governedProbe = await db.node.findUnique({
        where: { loc_memoryId: { loc, memoryId } },
        select: { role: true, isRunnable: true, deletedAt: true, nodeType: true },
      });
      try {
        // #1606 (cor:dmo:110:04) — no generic create makes or resurrects a comment.
        assertNotCommentWrite(governedProbe?.nodeType, nodeType, 'create');
        assertBootPromptWriteAllowed(governedProbe, { nodeType, role: normalizeRole(role) }, 'create');
        assertGovernedWrite(
          governedProbe,
          mergedGovernedState(governedProbe, { role, isRunnable }),
          'create',
          undefined,
          // A LIVE node at this loc makes any create a NODE_LOC_CONFLICT, the
          // create doors included (@codex, PR #1305).
          // …and only when that kind's door could replay this exact call.
          // Not for a RESURRECTION either (@codex, PR #1305 round 6): this
          // tool CLEARS the fields a resurrecting call omits, while the doors
          // PRESERVE them, so no door replays it. A route is offered only when
          // the loc holds no row at all — the conservative rule, closing the
          // class rather than chasing each field.
          governedProbe
            ? {}
            : {
                context: 'node-write',
                surface: 'mcp',
                canReplay: (kind) =>
                  mcpDoorCanReplay({ name, nodeType, objectType, isRunnable, role, description, abstract, content, seq, tags, properties, data: nodeData, llmModel, aiAgent, edges }, kind, 'create'),
              },
        );
      } catch (e) {
        if (e instanceof RoleGovernedError || isCommentGovernedError(e)) return refusalResult(`[role_governed] ${(e as Error).message}`);
        throw e;
      }

      // Resolve edge targets BEFORE the source upsert so an
      // unresolvable target rolls back cleanly with no source-node
      // mutation (parallel to the GraphQL upsertNode resolver from
      // #106). Issue #107 review feedback.
      //
      // Spec 022: each edge target MUST be a fully-qualified URN (or an
      // ID-shape value via spec 007 dispatch). Pre-validate so short-loc
      // targets reject at the API boundary, before resolveEdgeRefs.
      let resolvedEdges: ResolvedEdge[] | null = null;
      if (edges) {
        for (const edge of edges) {
          try {
            if (!isId(edge.targetUrn)) {
              assertFullyQualifiedUrn(edge.targetUrn, 'node');
            }
          } catch (e) {
            if (e instanceof UrnNotQualifiedError) {
              return textResult(`Edge target: ${e.message}`);
            }
            throw e;
          }
        }
        const r = await resolveEdgeRefs(
          edges.map((e) => ({
            targetId: e.targetUrn,
            name: e.name ?? null,
            loc: e.loc ?? null,
            description: e.description ?? null,
            isRunnable: e.isRunnable ?? null,
          })),
          memoryId,
          auth,
        );
        if ('error' in r) return refusalResult(r.error);
        resolvedEdges = r.resolved;
      }

      // A STALE read, kept for PAYLOAD PREPARATION only — never for a decision.
      // It supplies the create-payload `id`, the auto-assigned `seq` for a new
      // node, and the preserve-on-omit fallbacks for `objectType` / `properties`.
      // It is read before the loc write lock is taken, so it may be out of date
      // by the time anything is written; treat it as "what was probably there",
      // not as the state of the row.
      const existing = await db.node.findUnique({ where: { loc_memoryId: { loc, memoryId } } });

      // Issue #1181 — a LIVE node at (loc, memoryId) REFUSES rather than being
      // overwritten, which is parity with the two sibling surfaces: the GraphQL
      // `createNode` mutation (writeNodeCore mode 'create', spec 039 Phase 0 D1,
      // resolvers.mutation.node.ts) and the runner's own hadron_create_node tool
      // (src/lib/runner/tools/nodeTools.ts). Until that gate existed, one tool
      // name had two opposite behaviours on the operation that decides whether
      // the node at an address is still the same node — and the overwriting one
      // was the surface AGENTS drive, i.e. the callers least able to notice.
      //
      // That gate is NOT here, and no refusal short-circuits at this point: the
      // handler enters the transaction below for a free loc and an occupied one
      // alike, and the authoritative decision is a re-read taken there under the
      // loc's write lock. `existing` cannot make it — being pre-lock, two racing
      // calls both see no row. An early-out here would pass every test the real
      // gate passes while doing nothing in the one case that matters, so it is
      // deliberately absent rather than kept as a "fast path": a redundant check
      // that no test can distinguish from the authoritative one is how the
      // authoritative one gets deleted later.
      //
      // To be explicit for anyone pruning: the probe above still earns its
      // keep for the payload reasons listed on it. It is the GATE that is
      // absent here, not the READ.
      //
      // Issue #543 — hadron_create_node resurrects a SOFT-DELETED node at the
      // target loc (the gate tests liveness, so a tombstone falls through).
      // Writing to it must clear deletedAt/deletedBy, matching the GraphQL
      // createNode contract (resolvers.mutation.node.ts `isResurrect`). Note
      // this flag is derived from the STALE probe and is overridden inside the
      // transaction from the authoritative row. Without this the
      // update branch below writes the new fields but leaves the row flagged
      // deleted — the "worst of both worlds": findable nowhere, yet still
      // feeding compiled reads only via stale paths.
      const isResurrect = !!existing?.deletedAt;

      // Spec 031 — length-cap + trim-then-check the abstract before write.
      let normalizedAbstract: string | null;
      try {
        normalizedAbstract = normalizeAbstract(abstract) ?? null;
      } catch (e) {
        if (e instanceof NodeAbstractTooLongError) return refusalResult(e.message);
        throw e;
      }

      // Spec 032 — every call that REACHES a write writes the full set of
      // provided fields, so there is no field-level merge to reason about.
      // Since #1181 the calls that reach one are a fresh create and a
      // soft-deleted-node resurrection; a live loc returns before any write, so
      // read "every call writes" as scoped to those two rather than as the old
      // upsert-semantics claim. If the caller is supplying an abstract, the hash
      // is recomputed from the supplied content (FR-003). Null/empty content
      // with an abstract yields null hash (FR-007). No abstract → no hash
      // (FR-006). Hash is computed on plaintext content (FR-009).
      const nextAbstractOriginHash: string | null =
        normalizedAbstract !== null ? computeContentHash(content ?? null) : null;

      // Spec: cor:dmo:020:01 (Node ordering).
      // Auto-assign `seq` for a NEW node joining an already-ordered sibling
      // list (parity with the GraphQL upsertNode resolver). Create-only; an
      // explicit `seq` arg wins; an unordered / empty list leaves it null.
      // #443: root and nested allocation both read inside the write transaction (root under K).
      const createSeq = seq !== undefined ? seq : null;

      // Spec 041 (PR-2, closes #206 write-side): on an encrypted memory,
      // encrypt with this session's key — or REJECT when locked. Pre-041 the
      // MCP path silently stored plaintext rows into encrypted memories.
      // abstractOriginHash above is computed on PLAINTEXT (FR-009), before
      // this envelope; the enqueueNodeEmbedding call below keeps the
      // in-closure plaintext (FR-027 prompt-drain).
      const memEncRow = await db.memory.findUnique({
        where: { id: memoryId },
        select: { isEncrypted: true, schema: true },
      });
      // Payload diff hint only. #1186 validates resulting schema fields from
      // the locked row in snapshotOverwrittenNode, never from this probe.
      const resultObjectType =
        objectType !== undefined ? (objectType.trim() || null) : (existing?.objectType ?? null);
      let storedContent = content ?? null;
      let storedAbstract = normalizedAbstract;
      let storedData = (nodeData ?? undefined) as unknown;
      if (memEncRow?.isEncrypted) {
        const key = sessionKeyCache.getByMemoryId(memoryId);
        if (!key) {
          return textResult(
            'This memory is encrypted and locked — call hadron_unlock_memory first (spec 041).',
          );
        }
        const enc = encryptNodeFieldsWithKey(
          { content: storedContent, abstract: storedAbstract, data: storedData ?? null },
          key,
        );
        storedContent = enc.content ?? null;
        storedAbstract = enc.abstract ?? null;
        storedData = enc.data ?? undefined;
      }

      const upsertArgs = {
        where: { loc_memoryId: { loc, memoryId } },
        create: {
          id: existing?.id ?? generateId(),
          memoryId,
          loc,
          name,
          nodeType: nodeType ?? 'info',
          objectType: objectType?.trim() || null,
          isRunnable: isRunnable ?? null,
          role: role ?? null,
          description: description ?? null,
          abstract: storedAbstract,
          abstractOriginHash: nextAbstractOriginHash,
          content: storedContent,
          revisionContentHash: revisionStateHashRefreshMarker(),
          seq: createSeq,
          tags: tags ?? [],
          properties: properties as any ?? undefined,
          data: storedData as any ?? undefined,
          llmModel: llmModel ?? null,
          aiAgent: aiAgent ?? null,
          createdBy: auth.clientId ?? null,
        },
        update: {
          name,
          ...(nodeType ? { nodeType } : {}),
          ...(objectType !== undefined ? { objectType: objectType.trim() || null } : {}),
          ...(isRunnable !== undefined ? { isRunnable } : {}),
          ...(role !== undefined ? { role } : {}),
          description: description ?? null,
          abstract: storedAbstract,
          abstractOriginHash: nextAbstractOriginHash,
          content: storedContent,
          revisionContentHash: revisionStateHashRefreshMarker(),
          // seq is structural ordering, not content: preserve it on update when
          // omitted (parity with the upsertNode resolver) so a content-only
          // re-write doesn't wipe a node out of its ordered list (PR #309 review).
          ...(seq !== undefined ? { seq } : {}),
          tags: tags ?? [],
          ...(properties !== undefined ? { properties: properties as any } : {}),
          ...(nodeData !== undefined ? { data: storedData as any } : {}),
          ...(llmModel ? { llmModel } : {}),
          ...(aiAgent ? { aiAgent } : {}),
          // Resurrect a soft-deleted node on write (#543).
          ...(isResurrect ? { deletedAt: null, deletedBy: null } : {}),
          updatedBy: auth.clientId ?? null,
        } as any,
      };

      /**
       * #976 — snapshot the row this "create" is about to OVERWRITE.
       * hadron_create_node WAS create-OR-update (#543), and its update branch
       * used to write no NodeRevision at all, so re-minting an existing loc
       * destroyed the prior content with no recoverable history — while every
       * sibling surface snapshots (hadron_update_node, hadron_replace_text and
       * hadron_update_node_data via the resolver, hadron_move_node, and
       * writeNodeCore's own `if (existing)` branch).
       *
       * Since #1181 a LIVE row is refused before reaching here, so the only row
       * this can still overwrite is a SOFT-DELETED one being resurrected. That
       * narrows what it protects but does not retire it: a tombstone's content
       * is still real content, and losing it silently was the #976 defect.
       *
       * The create-vs-overwrite decision is made HERE, under the loc's write
       * lock — never from the `existing` probe above, which is read before the
       * transaction and can be stale by the time we write (PR #977 review, both
       * bots: two concurrent calls both see no row, one creates, and the other
       * would overwrite it believing it created it). Returns the pre-write row
       * so the caller can also derive the resurrect decision from it.
       *
       * On an encrypted memory this stores the at-rest CIPHERTEXT row,
       * deliberately — same contract as hadron_update_node. `changes` compares
       * against the values this upsert will actually write, which for the
       * clobber-semantics fields (description/abstract/content/tags) is the
       * resolved `?? null` / `?? []` value, not the raw argument.
       */
      const snapshotOverwrittenNode = async (tx: Prisma.TransactionClient) => {
        const prior = await tx.node.findUnique({
          where: { loc_memoryId: { loc, memoryId } },
          select: { id: true },
        });
        if (prior) await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${prior.id} FOR UPDATE`;
        let pre = prior ? await tx.node.findUnique({ where: { id: prior.id } }) : null;
        if (pre && (pre.loc !== loc || pre.memoryId !== memoryId)) {
          throw new NodeMovedDuringWriteError(
            `[write_conflict] the node at "${loc}" moved while this write waited — re-read and retry.`,
          );
        }
        if (pre && !pre.deletedAt) throw LIVE_LOC_CONFLICT;
        // #1186: use the locked tombstone, or the new-row input when absent,
        // before reconciliation/snapshot can produce any revision side effect.
        await validateNodeSchemaOnWrite(
          tx, memoryId,
          objectType !== undefined ? (objectType.trim() || null) : pre?.objectType,
          properties !== undefined ? properties : pre?.properties,
        );
        if (!pre) return null;
        await ensureCurrentNodeRevisionInTransaction(tx, pre.id, { expectedMemoryId: memoryId });
        pre = await tx.node.findUniqueOrThrow({ where: { id: pre.id } });
        await createNodeRevision(tx, {
          id: generateId(),
          ...buildNodeRevisionSnapshot(pre, editorFromAuth(auth), {
            changes: diffNodeChanges(pre, {
              name,
              nodeType,
              objectType: resultObjectType,
              isRunnable,
              description: description ?? null,
              abstract: storedAbstract,
              content: storedContent,
              // #1127 review — an overwrite that only re-stamps the
              // fingerprint is still a change to restorable state, so this
              // snapshot reports it. NOT every diff caller passes this field
              // (@copilot, same review): the move paths omit it because a move
              // cannot change the hash, `restoreNodeRevision` already carries
              // it via restorableNodeFields, and the GraphQL upsert computes
              // its hash AFTER its diff — the same ordering this tool had. That
              // last one is a cosmetic omission rather than the defect fixed
              // here: with no `abstractStillAccurate` on that surface, a hash
              // change always rides along with an abstract or content change
              // the diff already names, so `changes` is never empty there.
              abstractOriginHash: nextAbstractOriginHash,
              seq,
              tags: tags ?? [],
              properties,
              data: storedData,
              llmModel,
              aiAgent,
            }),
          }),
        });
        return pre;
      };

      // #664 (Model A — see nodeSubtreeLock.ts): serialize this create against a
      // concurrent ancestor-delete by holding advisory locks on the node's
      // ancestor path across the upsert, matching the GraphQL createNode path.
      // READ COMMITTED (the default) is required so the delete's descendant
      // count sees this row once our commit releases the lock.
      //
      // #976: EVERY write takes the transaction now, root-level locs included.
      // Two reasons, both about the snapshot: it must commit with the write it
      // records (else a failed upsert leaves an orphan revision —
      // hadron_move_node is the precedent), and the create-vs-overwrite
      // decision must be made under the loc's own write lock. Deciding from the
      // pre-transaction `existing` probe lost a revision under concurrency: two
      // calls both saw no row, one created it, the other overwrote it on the
      // create branch (PR #977 review, both bots). lockLocForWrite takes the
      // same key as an ancestor-create and as lockNodeForDelete. This path
      // declares ancestors plus own-loc together, then re-enters only subsets (#2054).
      // #1181 — thrown from INSIDE the transaction by the authoritative gate
      // below and mapped to a refusal outside it. A sentinel rather than a
      // string match: throwing aborts the transaction, which is exactly what we
      // want (no revision written, no upsert), and identity comparison cannot
      // be confused with a genuine Prisma error.
      const LIVE_LOC_CONFLICT = Symbol('live-loc-conflict');

      let upserted;
      try {
        upserted = await db.$transaction(async (tx) => {
          // #443: a second root allocation in one transaction is refused before ANY lock of its own is taken.
          if (seq === undefined && !loc.includes(':')) await assertRootAllocationAllowed(tx, memoryId);
          // #2206 (Xan's parity ruling on #2233): an Agent definition's authority before any memory/node/loc lock.
          await lockAgentDefinitionAuthority(tx, auth.userId ?? null, memoryId);
          if (resolvedEdges !== null) {
            await lockOutgoingEdgeMemories(tx, memoryId, resolvedEdges);
          }
          await acquireLockSet(tx, [...ancestorLocs(loc), loc].map(loc => ({ memoryId, loc })));
          await lockAncestorsForCreate(tx, memoryId, loc); // subset; no-op at a root-level loc
          await lockLocForWrite(tx, memoryId, loc);

          // #1181 — THE AUTHORITATIVE live-collision gate, and the ONLY one.
          // The pre-transaction `existing` probe far above is payload
          // preparation, not a first line of defence: it is read before this
          // lock, so two racing calls both see no row (the same staleness #977
          // fixed for the snapshot decision, one line below, for the same
          // reason). Re-reading here, under the loc's own write lock, is what
          // makes the refusal true: the second caller sees the first's
          // committed row and is told, instead of overwriting it through the
          // upsert's update branch.
          //
          // This is what makes create-over-a-live-loc genuinely unreachable
          // rather than merely unlikely, and it is the property #1178 needs from
          // a citation allocator — one attempt, a typed refusal, no lease.
          const authoritative = await tx.node.findUnique({
            where: { loc_memoryId: { loc, memoryId } },
          });
          if (authoritative && !authoritative.deletedAt) throw LIVE_LOC_CONFLICT;

          if (authoritative) {
            await tx.$queryRaw`SELECT "id" FROM "nodes" WHERE "id" = ${authoritative.id} FOR UPDATE`;
            // #1468 — reviving a spec tombstone kept for recovery after the
            // mint must not also strip its marker. Parity with writeNodeCore.
            await assertNoMintedSpecUnmark(tx, memoryId, [{ id: authoritative.id, tags: tags ?? [], role }], 'overwrite');
          }
          await assertMemoryEncryptionStateForWrite(tx, memoryId, memEncRow?.isEncrypted ?? false, auth);

          const pre = await snapshotOverwrittenNode(tx);

          // #1330 — H1 strict sub-roles, as writeNodeCore judges them (this
          // handler is its parity implementation, so the gate is repeated here).
          // Judged on `pre`, the tombstone as LOCKED by the snapshot, not on the
          // unlocked `authoritative` read: a writer that takes no loc lock (git
          // sync) could change the tombstone's role in between, and a stale
          // prior role would make an undeclared one read as unchanged (#1400
          // review). A refusal rolls the snapshot back with everything else.
          await assertRoleDeclaredForWrite(tx, memoryId, {
            role: role === undefined ? (pre?.role ?? null) : role,
            priorRole: pre?.role ?? null,
            runnableAfter: mergedGovernedState(pre, { role, isRunnable }).isRunnable,
          });
          // #1331 — the writer level of the role before AND after, on the locked tombstone.
          await assertRoleWritersForWrite(tx, auth, memoryId, {
            priorRole: pre?.role ?? null,
            nextRole: role === undefined ? (pre?.role ?? null) : role,
            priorRunnable: pre?.isRunnable ?? null,
            nextRunnable: mergedGovernedState(pre, { role, isRunnable }).isRunnable,
          });
          // #1460 — the locked tombstone can retain vectors from its old
          // plaintext. Purge both kinds before the upsert makes it searchable.
          if (pre?.deletedAt) {
            await tx.nodeEmbedding.deleteMany({ where: { nodeId: pre.id } });
          }
          // Invalidate an old in-flight embed before the asynchronous enqueue
          // restamps the marker after commit.
          const indexed = pre?.deletedAt
            ? await tx.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { vectorIndexEnabled: true, class: true } })
            : null;
          const revivedPendingAt = pre?.deletedAt
            ? pendingAtForRevival(pre.embeddingPendingAt, memoryIsVectorIndexed(indexed!))
            : undefined;
          // #443: nested siblings already share the held immediate-parent key.
          // Allocate on this writing transaction only after that wait.
          // A ROOT has no parent key: it takes K (held to commit) before the read.
          // Keyed on the AUTHORITATIVE read under the locks, not the stale pre-transaction probe: a row that appeared after
          // the probe must not make this root take K after its FOR UPDATE and revision writes.
          const autoSeq = seq === undefined && pre == null;
          if (autoSeq && !loc.includes(':')) await lockRootSiblings(tx, memoryId);
          const nestedSeq = autoSeq ? await nextSiblingSeq(tx, memoryId, loc) : null;
          const written = await tx.node.upsert({
            ...upsertArgs,
            create: { ...upsertArgs.create, ...(nestedSeq != null ? { seq: nestedSeq } : {}) },
            // Resurrect (#543) on the authoritative row, not the stale probe: a
            // tombstone that appeared after it would otherwise stay flagged
            // deleted while taking the new content.
            update: {
              ...upsertArgs.update,
              ...(pre ? clearNodeAuthorship() : {}),
              ...(pre?.deletedAt ? { deletedAt: null, deletedBy: null, embeddingPendingAt: revivedPendingAt } : {}),
            } as any,
          });
          if (resolvedEdges !== null) {
            const edgeError = await replaceOutgoingEdgesInTransaction(tx, {
              sourceNodeId: written.id,
              sourceLoc: written.loc,
              sourceMemoryId: written.memoryId,
              resolved: resolvedEdges,
              createdBy: auth.clientId ?? null,
            });
            if (edgeError) throw new InlineEdgeEndpointError(edgeError);
          }
          await applyIncludesInTransaction(tx, written, content ?? null, auth, null);
          written.embeddingWorkToken = await stampEmbeddingObligation(tx, written.id, written.memoryId);
          return written;
        });
      } catch (e) {
        if (e instanceof NodeSchemaViolation) return refusalResult(`Schema violation: ${e.message}`);
        if (e === LIVE_LOC_CONFLICT) {
          return refusalResult(`Node already exists at "${rawUrn}" — use hadron_update_node.`);
        }
        if (e instanceof RoleNotDeclaredError) return refusalResult(`[role_not_declared] ${e.message}`);
        const includeText = includeRefusalText(e);
        if (includeText) return refusalResult(includeText);
        const writerRefusal = roleWriterRefusalText(e);
        if (writerRefusal) return refusalResult(writerRefusal);
        if (e instanceof InlineEdgeEndpointError) return refusalResult(e.message);
        if (e instanceof EdgeLocConflictError) return refusalResult(e.message);
        if (e instanceof MemoryEncryptionChangedDuringWriteError) return refusalResult(e.message);
        if (e instanceof MemoryWriteAccessChangedDuringWriteError) return refusalResult(e.message);
        if (e instanceof ScopeGraphQLError && e.extensions?.code === SPEC_MINTED_PERMANENT) {
          return refusalResult(`[spec_minted_permanent] ${e.message}`);
        }
        throw e;
      }

      // Resolve any PendingEdges waiting for this node (by ID or loc).
      // Spec 037: the promoted Edge lives in its SOURCE node's memory and
      // gets a loc (the pending edge's authored loc, else derived from the
      // source loc + name + this newly-arrived target's loc).
      const pendingByLoc = await db.pendingEdge.findMany({ where: { targetId: loc } });
      const pendingById = await db.pendingEdge.findMany({ where: { targetId: upserted.id } });
      const pendingIds = new Set([...pendingByLoc, ...pendingById].map((pending) => pending.id));
      for (const pendingId of pendingIds) {
        await promotePendingEdgeForTarget(pendingId, upserted.id);
      }

      // Record usage event (#796 memoryId + 046 FR-001 attribution, as in
      // hadron_get_node's event — see the shared recorder).
      recordNodeWrite(db, { id: upserted.id, loc, memoryId }, auth);

      // Announce the write (event pivot): the git mirror subscriber re-reads
      // and mirrors — this replaced the re-fetch + direct writeNodeToGit.
      // Note: on an ENCRYPTED memory the subscriber punts, so MCP writes
      // (which store plaintext on the row, #206) no longer git-mirror there —
      // acceptable in the #206 gray zone and safer than pushing maybe-mixed
      // rows.
      void publishNodeWritten({
        nodeId: upserted.id,
        memoryId,
        ownerRepo: '',
        clientId: auth.clientId,
      });

      // 033 — (re-)embed on write. MCP stores plaintext on the row (#206), and
      // `content`/`normalizedAbstract` are plaintext here.
      void enqueueNodeEmbedding(db, {
        nodeId: upserted.id,
        workToken: upserted.embeddingWorkToken,
        memoryId,
        plaintext: { content: content ?? null, abstract: normalizedAbstract },
      });

      const savedUrn = await nodeUrn(loc, memoryId);
      // #322: return the stable PK too — edges/replies created against the URN
      // break if the node is later moved/renamed; the id never changes.
      // #2048 (cor:agt:040:13): a boot-prompt source's link-lint warnings ride on the result; they never block the write.
      return textResult(`Node saved: ${savedUrn} (id: ${upserted.id})${renderIncludePinWarnings(await safePlainPinWarnings(scopeCtx(), { memoryId }, content))}${renderLintWarnings(await lintWarningPageForNodeId(scopeCtx(), upserted.id))}`);
    },
  );

  // ── hadron_update_node ────────────────────────────────────────────────────────

  server.tool(
    'hadron_update_node',
    'Partially update an existing node. Only the fields you provide are changed — everything else is preserved. The URN MUST be fully qualified (hrn:node:<root>:<memory>:<loc>). Pass expectedRevision from hadron_get_node to refuse atomically if the node changed since you read it.',
    SHAPE_HADRON_UPDATE_NODE,
    async ({ urn: rawUrn, expectedRevision, name, nodeType, objectType, isRunnable, role: rawRole, description, abstract, content, abstractStillAccurate, seq, tags, properties, data: nodeData, llmModel, aiAgent, edges, reason, install }) => {
      if (install) {
        if (edges || isRunnable || abstractStillAccurate) return textResult('`install` does not support `edges`, `isRunnable` or `abstractStillAccurate`.');
        return writeInstallNodeViaGraphql('update', install, {
          loc: rawUrn, expectedRevision, name, nodeType, objectType, role: rawRole, description, abstract, content, seq, tags: tags as never,
          properties, data: nodeData, llmModel, aiAgent, reason,
        });
      }
      // #1219 — inline parity writer, not a writeNodeCore delegate (#206):
      // normalize before mergedGovernedState, the door replay and the payload.
      const role = normalizeRole(rawRole);
      // Spec 022: qualification at the API boundary.
      try {
        assertFullyQualifiedUrn(rawUrn, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return refusalResult(e.message);
        throw e;
      }

      const { memoryUrn, loc, fragment } = splitNodeUrn(rawUrn);
      const fragRefusal = nodeFragmentRefusal(rawUrn, fragment);
      if (fragRefusal) return refusalResult(fragRefusal);
      // #1316: hidden from this caller ⇒ the missing branch; a reader keeps the denial.
      const memory = await resolveVisibleMemoryByUrn(auth, memoryUrn, 'write');
      if (!memory) {
        return refusalResult(`Memory not found: "${memoryUrn}".`);
      }

      // Auth BEFORE any node-existence probe: returning "not found" for an
      // existing-but-forbidden node while "access denied" for others would be
      // a membership oracle (Gemini review). Gate on the resolved memory.id
      // first — matches hadron_create_node's auth-first ordering.
      if (!(await canWriteToMemory(db, auth, memory.id, EXPLICIT_REF))) {
        return refusalResult(`Write access denied for this memory.${await explainWriteRefusal(db, auth, memory.id)}`);
      }
      // Spec 049 S4: an in-place update takes no lock, so the gate is explicit.
      try {
        await assertLocWritable(db, memory.id, loc, 'update');
      } catch (e) {
        if (e instanceof LocProtectedError) return refusalResult(`[loc_protected] ${e.message}`);
        if (e instanceof NodeMovedDuringWriteError) return refusalResult(e.message);
        throw e;
      }

      const existing = await db.node.findUnique({
        where: { loc_memoryId: { loc, memoryId: memory.id } },
      });

      // #1201 — the GOVERNED-KIND gate, on the RESULTING state. This handler is
      // an INLINE parity implementation of writeNodeCore (#206), not a delegate,
      // so the gate has to be here too: MCP is the surface an agent actually
      // reaches, which makes it the threat this mechanism exists for rather
      // than an afterthought. Never passes an ownsKind — there is no MCP door,
      // by design.
      try {
        // #1606 (cor:dmo:110:04) — no generic update edits, makes or unmakes a comment.
        assertNotCommentWrite(existing?.nodeType, nodeType, 'update');
        assertBootPromptWriteAllowed(existing, { nodeType, role: normalizeRole(role) }, 'update');
        assertGovernedWrite(
          existing,
          mergedGovernedState(existing, { role, isRunnable }),
          'update',
          undefined,
          // A route only for a LIVE node (a tombstone is NODE_NOT_FOUND to the
          // update doors too) and a call the door could replay (@codex, #1305).
          existing && existing.deletedAt == null
            ? {
                context: 'node-write',
                surface: 'mcp',
                canReplay: (kind) =>
                  mcpDoorCanReplay({ name, nodeType, objectType, isRunnable, role, description, abstract, content, abstractStillAccurate, seq, tags, properties, data: nodeData, llmModel, aiAgent, edges, reason, expectedRevision }, kind, 'update'),
              }
            : {},
        );
      } catch (e) {
        if (e instanceof RoleGovernedError || isCommentGovernedError(e)) return refusalResult(`[role_governed] ${(e as Error).message}`);
        throw e;
      }

      // A soft-deleted node is treated as not-found here (#543), mirroring the
      // GraphQL update-mode contract (resolvers.mutation.node.ts) and every MCP
      // read/find/list path, which all exclude deletedAt. hadron_update_node is
      // a partial update, not a resurrect — a caller who wants a deleted loc
      // back must recreate it via hadron_create_node (which resurrects).
      if (!existing || existing.deletedAt) {
        return refusalResult(`Node not found: "${rawUrn}"`);
      }

      // Resolve edge targets BEFORE the revision snapshot + node update
      // so an unresolvable target rolls back cleanly with no source-
      // node mutation. Issue #107 review feedback.
      //
      // Spec 022: pre-validate edge URN qualification (matches hadron_create_node).
      let resolvedEdges: ResolvedEdge[] | null = null;
      if (edges !== undefined) {
        for (const edge of edges) {
          try {
            if (!isId(edge.targetUrn)) {
              assertFullyQualifiedUrn(edge.targetUrn, 'node');
            }
          } catch (e) {
            if (e instanceof UrnNotQualifiedError) {
              return textResult(`Edge target: ${e.message}`);
            }
            throw e;
          }
        }
        const r = await resolveEdgeRefs(
          edges.map((e) => ({
            targetId: e.targetUrn,
            name: e.name ?? null,
            loc: e.loc ?? null,
            description: e.description ?? null,
            isRunnable: e.isRunnable ?? null,
          })),
          existing.memoryId,
          auth,
        );
        if ('error' in r) return refusalResult(r.error);
        resolvedEdges = r.resolved;
      }

      // Spec 031 — length-cap + trim-then-check the abstract BEFORE the
      // revision snapshot, so an over-cap abstract aborts cleanly without
      // mutating either the row or the revision history.
      let normalizedAbstract: string | null | undefined;
      try {
        normalizedAbstract = normalizeAbstract(abstract);
      } catch (e) {
        if (e instanceof NodeAbstractTooLongError) return refusalResult(e.message);
        throw e;
      }

      // Spec 041 (PR-2, PR-517 review): the encrypted-memory gate runs
      // BEFORE any side effect — a locked rejection must leave NO trace,
      // including the revision-history row below (Codex P2).
      const updMemEnc = await db.memory.findUnique({
        where: { id: existing.memoryId },
        select: { isEncrypted: true, schema: true },
      });
      // #1186: resulting-state schema validation runs under the row lock.
      const updKey = updMemEnc?.isEncrypted
        ? sessionKeyCache.getByMemoryId(existing.memoryId)
        : null;
      if (updMemEnc?.isEncrypted && !updKey) {
        return textResult(
          'This memory is encrypted and locked — call hadron_unlock_memory first (spec 041).',
        );
      }

      // Spec 041 (PR-517 review, Codex P2): decrypt `existing` in place NOW
      // — everything below (the abstractOriginHash matrix, the embedding
      // enqueue's fallback plaintext) treats existing.content/abstract as
      // PLAINTEXT. Without this, an abstract-only update hashes ciphertext
      // (false-stale forever) and a content-only update embeds ciphertext.
      if (updKey) {
        decryptNodeFieldsWithKey(existing, updKey);
      }

      // Spec 032 — abstractOriginHash partial-update matrix (10 rows from
      // the contract; #1126 added the abstractStillAccurate row). Drives off whether `normalizedAbstract` was
      // supplied (undefined = preserve, null = clear, string = set).
      // Hash always computed on plaintext per FR-009 (existing.* is
      // plaintext here — decrypted above for encrypted memories).
      let nextAbstractOriginHash: string | null | undefined;
      if (normalizedAbstract === undefined) {
        // #1126 — the caller's assertion that the EXISTING abstract survives
        // this edit. Row 2 (content updated, abstract absent) arms staleness
        // on purpose, and that is right by default: the server cannot know
        // whether an abstract written against the old content still describes
        // the new one. `abstractStillAccurate` is the caller saying they
        // checked — so this re-fingerprints the abstract already on the node
        // against the content this call is writing, exactly as re-saving that
        // identical text would (row 4). It writes no text of its own.
        //
        // Guarded on the node ACTUALLY having an abstract: FR-006/FR-007 hold
        // that no abstract means no hash, and an unguarded assertion here
        // would mint a ghost hash on an abstract-less node — a fingerprint
        // for a thing that does not exist, which later reads would compare
        // against and quietly trust.
        const hasStoredAbstract =
          typeof existing.abstract === 'string' && existing.abstract.trim() !== '';
        if (abstractStillAccurate === true && hasStoredAbstract) {
          const nextContent = content !== undefined ? content : existing.content;
          // computeContentHash(null) is null, so clearing content through this
          // path lands on FR-007's "abstract but no content ⇒ no hash" rather
          // than needing its own branch.
          nextAbstractOriginHash = computeContentHash(nextContent ?? null);
        } else {
          nextAbstractOriginHash = undefined;
        }
      } else if (normalizedAbstract === null) {
        nextAbstractOriginHash = null;
      } else {
        // `abstract` supplied: this already re-fingerprints against the new
        // content, so `abstractStillAccurate` is redundant here and ignored
        // rather than rejected — both spellings mean the same thing and the
        // outcome is identical either way.
        const nextContent = content !== undefined ? content : existing.content;
        nextAbstractOriginHash = computeContentHash(nextContent ?? null);
      }

      // The authoritative at-rest snapshot and its #620 diff are built under
      // the address lock below, after this plaintext-derived hash is known.
      // Build partial update — only fields that were provided
      const data: Record<string, unknown> = {};
      if (name !== undefined) data.name = name;
      if (nodeType !== undefined) data.nodeType = nodeType;
      if (objectType !== undefined) data.objectType = objectType.trim() || null;
      if (isRunnable !== undefined) data.isRunnable = isRunnable;
      // #1201 — null CLEARS, omit preserves, matching every other partial field here.
      if (role !== undefined) data.role = role;
      if (description !== undefined) data.description = description;
      if (normalizedAbstract !== undefined) data.abstract = normalizedAbstract;
      if (nextAbstractOriginHash !== undefined) data.abstractOriginHash = nextAbstractOriginHash;
      if (content !== undefined) data.content = content;
      if (seq !== undefined) data.seq = seq;
      if (tags !== undefined) data.tags = tags;
      if (properties !== undefined) data.properties = properties as any;
      if (nodeData !== undefined) data.data = nodeData as any;
      if (llmModel !== undefined) data.llmModel = llmModel;
      if (aiAgent !== undefined) data.aiAgent = aiAgent;
      // Keep the authored plaintext projection for the row-lock comparison.
      // The write payload below may become fresh randomized ciphertext.
      const plaintextUpdates = { ...data };

      // Spec 041 (PR-2): encrypted memory — encrypt the provided encrypted-
      // envelope fields with this session's key (gate + key resolved above,
      // before the revision snapshot).
      if (updKey) {
        const enc = encryptNodeFieldsWithKey(
          {
            content: (data.content as string | null | undefined) ?? null,
            abstract: (data.abstract as string | null | undefined) ?? null,
            data: (data.data as unknown) ?? null,
          },
          updKey,
        );
        if (data.content !== undefined) data.content = enc.content ?? null;
        if (data.abstract !== undefined) data.abstract = enc.abstract ?? null;
        if (data.data !== undefined) data.data = (enc.data ?? null) as never;
      }

      let includePinContentSaved = false;
      let includePinPriorContent: string | null = null;
      if (Object.keys(data).length > 0 || resolvedEdges !== null || expectedRevision !== undefined) {
        // Spec 049 S4: the write holds the address lock and the gate runs
        // under it — the check above is the fast refusal, this the
        // authoritative one (Copilot on PR #1165).
        try {
          await db.$transaction(async (tx) => {
            // #2206 (Xan's parity ruling on #2233): an Agent definition's authority before any memory/node/loc lock.
            await lockAgentDefinitionAuthority(tx, auth.userId ?? null, existing.memoryId);
            if (resolvedEdges !== null) {
              await lockOutgoingEdgeMemories(tx, existing.memoryId, resolvedEdges);
            }
            await lockLocForWrite(tx, memory.id, loc);
            // #1072/#1185/#1323 — read and snapshot only after the address
            // lock, in the SAME transaction as the visible update. The old
            // no-edge branch snapshotted on the base client and swallowed any
            // failure, leaving phantom/consumed revisions and stale concurrent
            // pre-states.
            // Row lock BEFORE the authoritative read (@codex P1, PR #1339): the
            // address lock above binds only writers that take it, so without
            // this a non-participating writer could commit between this read
            // and the update, and the refreshed fingerprint would then hide it.
            // Same order as the GraphQL update path.
            await tx.$queryRaw`SELECT "id" FROM "nodes" WHERE "id" = ${existing.id} FOR UPDATE`;
            await assertMemoryEncryptionStateForWrite(tx, memory.id, updMemEnc?.isEncrypted ?? false, auth);
            // Read the locked row before validation and drift reconciliation.
            let current = await tx.node.findUnique({
              where: { id: existing.id },
            });
            // The address lock above guards (memory, loc), but this write goes
            // by id: a move that committed between the pre-lock probe and the
            // row lock would otherwise have this edit — authorized, encrypted
            // and schema-checked for the OLD address — land wherever the row
            // went (@copilot, PR #1339). Same re-check as the GraphQL path.
            if (!current || current.deletedAt || current.memoryId !== memory.id || current.loc !== loc) {
              throw new NodeMovedDuringWriteError(
                `[write_conflict] ${rawUrn} moved, was deleted or changed memory while this update waited — re-read it and retry.`,
              );
            }
            // #1186 / cor:dmo:020:05 — omitted fields come from the locked
            // row, not the probe, and a refusal leaves no reconciliation.
            await validateNodeSchemaOnWrite(
              tx, memory.id,
              objectType !== undefined ? (objectType.trim() || null) : current.objectType,
              properties !== undefined ? properties : current.properties,
            );
            await ensureCurrentNodeRevisionInTransaction(tx, existing.id, { expectedMemoryId: memory.id });
            current = await tx.node.findUniqueOrThrow({ where: { id: existing.id } });
            // #1468 — dropping the spec marker would make a minted spec deletable.
            await assertNoMintedSpecUnmark(tx, memory.id, [{ id: current.id, tags, role }], 'update');
            // #937 — bind a client-side read/modify/write to the Revision it
            // actually read. The row lock + #1339 reconciliation above make
            // this the same atomic revSeq guard used by writeNodeCore. Do not
            // include the current value in the refusal: write authority is not
            // necessarily read authority, and a conflict must not become a
            // revision oracle.
            if (expectedRevision !== undefined && current.revSeq !== expectedRevision) {
              throw new ScopeGraphQLError(
                `Node at loc "${loc}" changed since it was read — re-read and retry.`,
                { extensions: { code: 'NODE_WRITE_CONFLICT', loc, memoryId: memory.id } },
              );
            }
            // #1330 — H1 strict sub-roles on the locked row, as writeNodeCore.
            await assertRoleDeclaredForWrite(tx, memory.id, {
              role: role === undefined ? current.role : role,
              priorRole: current.role,
              runnableAfter: mergedGovernedState(current, { role, isRunnable }).isRunnable,
            });
            // #1331 — the writer level of the role before AND after, on the locked row.
            await assertRoleWritersForWrite(tx, auth, memory.id, {
              priorRole: current.role,
              nextRole: role === undefined ? current.role : role,
              priorRunnable: current.isRunnable,
              nextRunnable: mergedGovernedState(current, { role, isRunnable }).isRunnable,
            });
            // A guard-only call is a useful no-op check and must not manufacture
            // a history row or advance the live revision.
            if (Object.keys(data).length === 0 && resolvedEdges === null) return;
            // Snapshot the ciphertext row, but compare the caller's plaintext
            // with a decrypted copy. An identical encrypted save is a no-op.
            const currentForDiff = updKey
              ? decryptNodeFieldsWithKey({ ...current }, updKey)
              : current;
            const changedFields = diffNodeChanges(currentForDiff, plaintextUpdates);
            if (changedFields.length === 0 && resolvedEdges === null) return;
            await createNodeRevision(tx, {
              id: generateId(),
              ...buildNodeRevisionSnapshot(current, editorFromAuth(auth), {
                revLabel: reason,
                changes: changedFields,
              }),
            });
            if (authoredContentChanged(changedFields)) Object.assign(data, clearNodeAuthorship());
            data.revisionContentHash = revisionStateHashRefreshMarker();
            const updated = Object.keys(data).length > 0
              ? await tx.node.update({ where: { id: existing.id }, data })
              : existing;
            if (resolvedEdges !== null) {
              const edgeError = await replaceOutgoingEdgesInTransaction(tx, {
                sourceNodeId: updated.id,
                sourceLoc: updated.loc,
                sourceMemoryId: updated.memoryId,
                resolved: resolvedEdges,
                createdBy: auth.clientId ?? null,
              });
              if (edgeError) throw new InlineEdgeEndpointError(edgeError);
            }
            if (content !== undefined) {
              await applyIncludesInTransaction(tx, updated, content, auth, (currentForDiff.content as string | null) ?? null);
              includePinContentSaved = true;
              includePinPriorContent = (currentForDiff.content as string | null) ?? null;
            }
            existing.embeddingWorkToken = await stampEmbeddingObligation(tx, updated.id, updated.memoryId);
            const embeddedPlaintext = updKey ? decryptNodeFieldsWithKey({ ...updated }, updKey) : updated;
            existing.content = embeddedPlaintext.content;
            existing.abstract = embeddedPlaintext.abstract;
          });
        } catch (e) {
          if (e instanceof NodeSchemaViolation) return refusalResult(`Schema violation: ${e.message}`);
          if (e instanceof LocProtectedError) return refusalResult(`[loc_protected] ${e.message}`);
          if (e instanceof NodeMovedDuringWriteError) return refusalResult(e.message);
          if (e instanceof MemoryEncryptionChangedDuringWriteError) return refusalResult(e.message);
          if (e instanceof MemoryWriteAccessChangedDuringWriteError) return refusalResult(e.message);
          if (e instanceof InlineEdgeEndpointError) return refusalResult(e.message);
          if (e instanceof EdgeLocConflictError) return refusalResult(e.message);
          if (e instanceof RoleNotDeclaredError) return refusalResult(`[role_not_declared] ${e.message}`);
          const includeText = includeRefusalText(e);
        if (includeText) return refusalResult(includeText);
        const writerRefusal = roleWriterRefusalText(e);
          if (writerRefusal) return refusalResult(writerRefusal);
          if (e instanceof ScopeGraphQLError && e.extensions?.code === SPEC_MINTED_PERMANENT) {
            return refusalResult(`[spec_minted_permanent] ${e.message}`);
          }
          if (e instanceof ScopeGraphQLError && e.extensions?.code === 'NODE_WRITE_CONFLICT') {
            return refusalResult(`[node_write_conflict] ${e.message}`);
          }
          throw e;
        }
      }

      // Record usage event (#796 memoryId + 046 FR-001 attribution, as in
      // hadron_get_node's event — see the shared recorder).
      recordNodeWrite(db, { id: existing.id, loc, memoryId: existing.memoryId }, auth);

      // Announce the write (event pivot): the git mirror subscriber re-reads
      // and mirrors (encrypted memories punt there — see hadron_create_node).
      void publishNodeWritten({
        nodeId: existing.id,
        memoryId: existing.memoryId,
        ownerRepo: '',
        clientId: auth.clientId,
      });

      // 033 — re-embed when content or abstract changed (existing.* is plaintext
      // on the MCP path, #206). Other-field-only updates don't touch the index.
      if (content !== undefined || normalizedAbstract !== undefined) {
        void enqueueNodeEmbedding(db, {
          nodeId: existing.id,
          workToken: existing.embeddingWorkToken,
          memoryId: existing.memoryId,
          plaintext: {
            content: content !== undefined ? content : existing.content,
            abstract: normalizedAbstract !== undefined ? normalizedAbstract : existing.abstract,
          },
        });
      }

      const updatedUrn = await nodeUrn(loc, existing.memoryId);
      // #322: surface the stable PK (immutable across move/rename).
      return textResult(`Node updated: ${updatedUrn} (id: ${existing.id})${includePinContentSaved ? renderIncludePinWarnings(await safePlainPinWarnings(scopeCtx(), { memoryId: existing.memoryId }, content, includePinPriorContent)) : ''}${renderLintWarnings(await lintWarningPageForNodeId(scopeCtx(), existing.id))}`);
    },
  );

  // ── the GOVERNED-KIND doors: hadron_create_task / _review and their updates ──
  //
  // #1201. `hadron_create_node` and `hadron_update_node` REFUSE a write that
  // would produce a governed node; these are how an agent produces one
  // deliberately. They delegate to the kind's GraphQL door rather than
  // reimplementing the write, so the exemption is decided server-side per kind
  // and there is exactly one place it lives.
  //
  // WHY THESE ARE ON THE AGENT SURFACE AT ALL, since the doors were originally
  // specified as absent from it. The absence rule was written for one threat —
  // an agent reaching for the GENERIC tool by habit — and it is still exactly
  // right for `spec`, whose authoring surface is `hadron spec` in the CLI and
  // which therefore gets NO tool here. It is wrong for these two:
  //
  //   - TASK's threat is a PRINCIPAL, not a tool (#1202: a memory shared with
  //     someone who authors a runnable node that reads the owner's data when
  //     the OWNER runs it). A door no legitimate surface can reach does not
  //     mitigate that; it just removes the ability to author tasks, which is
  //     how this platform's own task corpus is written.
  //   - REVIEW is now a component of any task or run rather than a coding
  //     convenience (@Holger, 2026-09-18) — work results should be reviewed, so
  //     the agent doing the work needs to be able to author the review.
  //
  // What still protects them is unchanged: the GENERIC surface refuses, so
  // producing a governed node takes a deliberate switch of tool. These are that
  // switch. The principal check lands on the same doors in #1202.
  //
  // Named `create`/`update`, not `author`: six `create_*` tools and six
  // `update_*` tools already exist here and zero `author_*` ones, and
  // `hadron_run_task` already establishes "task" as a noun on this surface.
  // A second verb for the same act buys nothing a reader can act on.

  /** The GraphQL context for a delegated door call — same shape as chatCtx below. */
  const doorCtx = (canReplay?: Context['governedCanReplay']): Context => ({
    db,
    // #1301: a refusal from the delegated door addresses an MCP caller, and
    // names an MCP door only if this call could be replayed through it.
    transport: 'mcp',
    ...(canReplay ? { governedCanReplay: canReplay } : {}),
    clientId: auth.clientId ?? undefined,
    userId: auth.userId ?? undefined,
    // #1868: the presented hdr_user_ key, for any gate on the door's path that
    // re-checks it (consistency with the other delegating contexts).
    apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId,
    appId: auth.appId ?? undefined,
    sessionId: auth.sessionId ?? undefined,
    roles: auth.roles as Context['roles'],
    organizationId: auth.organizationId ?? undefined,
  });

  /** One handler shape for all four tools — the kind and the mode are the only variables. */
  async function callGovernedDoor(
    kind: 'task' | 'review',
    mode: 'create' | 'update',
    shape: Record<string, unknown>,
    args: Record<string, unknown>,
  ): Promise<{ content: { type: 'text'; text: string }[] }> {
    const entry = GOVERNED_KINDS.find((e) => e.kind === kind)!;
    const doorName = entry.doors[mode];
    const { urn: rawUrn, ...rest } = args as { urn: string } & Record<string, unknown>;
    // #1769: these doors hand `fields` to the resolver directly, so GraphQL's
    // input type never filters them. Admit only what this tool advertises, so
    // a stray key (the settlement `session`, or one that happens to match a
    // real node column) is dropped instead of written or crashing the upsert.
    const fields: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      if (key !== 'urn' && key !== 'session' && key in rest) fields[key] = rest[key];
    }
    let memoryUrn: string;
    let loc: string;
    let fragment: string | undefined;
    try {
      assertFullyQualifiedUrn(rawUrn, 'node');
      ({ memoryUrn, loc, fragment } = splitNodeUrn(rawUrn));
    } catch (e) {
      return toolErrorResult(e, () => (e as Error).message, `hadron_${mode}_${kind}:parseUrn`);
    }
    const fragRefusal = nodeFragmentRefusal(rawUrn, fragment);
    if (fragRefusal) return refusalResult(fragRefusal);
    // #1316: hidden from this caller ⇒ the missing branch. Before this the door's
    // own concealment answered instead, echoing the RESOLVED id it was handed —
    // the victim memory's internal id, to a caller who cannot read it.
    const memory = await resolveVisibleMemoryByUrn(auth, memoryUrn, 'write');
    if (!memory) return refusalResult(`Memory not found: "${memoryUrn}".`);
    try {
      validateLoc(loc);
    } catch (e) {
      return e instanceof InvalidLocError ? refusalResult(e.message) : toolErrorResult(e, () => (e as Error).message, `hadron_${mode}_${kind}:validateLoc`);
    }

    // `name` is optional in the shared arg set because an UPDATE preserves it,
    // but a CREATE requires it — and these tools call the resolver directly, so
    // GraphQL's `String!` never gets a chance to say so (@copilot, PR #1203).
    // Without this the omission surfaces from somewhere deeper as a Prisma or
    // validation error that names neither the field nor the tool.
    if (mode === 'create' && (typeof fields.name !== 'string' || fields.name.trim() === '')) {
      return textResult(`hadron_create_${kind}: "name" is required when creating a node.`);
    }

    // On CREATE the governed signal is set BY THE DOOR, never by the caller:
    // the tool IS the statement of intent, so asking for it again would let the
    // two disagree — a node authored as one kind and labelled another.
    //
    // On UPDATE the door must NOT force it, or a governed node can never be
    // RETIRED: clearing `isRunnable` is how a task stops being runnable, and
    // that is legitimate — it just belongs to the task's own door rather than
    // to the generic surface, which is exactly what the before-union-after gate
    // now requires. Omitted still preserves, so an ordinary edit is unaffected.
    //
    // #1345 review (@codex): a role-governed kind is a FAMILY since #1322, so
    // the review create door sets the family member the caller names
    // (`review.security`) — defaulting to the base `review` — and refuses one
    // outside the family. Without this, `review.*` was governed away from the
    // generic tool with no MCP route left to author it.
    let signal: Record<string, unknown> = {};
    if (mode === 'create') {
      if (entry.signal.field === 'isRunnable') {
        signal = { isRunnable: true };
      } else {
        const asked = fields.role;
        if (asked != null && !(typeof asked === 'string' && roleIsOrDescendsFrom(asked, entry.signal.value))) {
          return textResult(
            `hadron_create_${kind}: "role" must be "${entry.signal.value}" or a dotted "${entry.signal.value}.<sub-role>" (got ${JSON.stringify(asked)}).`,
          );
        }
        signal = { role: typeof asked === 'string' ? asked : entry.signal.value };
      }
    }

    try {
      const ctx = doorCtx((k) => mcpDoorCanReplay(fields, k, mode));
      const node = await (
        resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<{ id: string }>>
      )[doorName](
        {},
        { input: { memoryId: memory.id, loc, ...fields, ...signal } },
        ctx,
      );
      return textResult(`${kind} node ${mode === 'create' ? 'created' : 'updated'}: ${rawUrn} (id: ${node.id})${renderIncludePinWarnings(await includePinWarningsFor(ctx, node))}`);
    } catch (e) {
      return toolErrorResult(e, () => {
        const code = (e as { extensions?: { code?: string } }).extensions?.code;
        return code ? `[${String(code).toLowerCase()}] ${(e as Error).message}` : `Error: ${(e as Error).message}`;
      }, `hadron_${mode}_${kind}:resolver`);
    }
  }

  server.tool(
    'hadron_create_task',
    'Create a RUNNABLE node — a task `hadron_run_task` can execute. This is the only way to author one: `hadron_create_node` refuses a write that would produce a runnable node, because authoring something the platform will EXECUTE is not the same act as writing prose. The runnable flag is set by this tool, so you do not pass it. Use it when you are deliberately writing a procedure for an agent to run; for ordinary notes, docs or findings use hadron_create_node.',
    governedDoorArgs,
    async (args) => callGovernedDoor('task', 'create', governedDoorArgs, args),
  );

  server.tool(
    'hadron_update_task',
    'Edit an existing RUNNABLE node. Needed because `hadron_update_node` refuses ANY edit whose result is still a runnable node — including one that changes only prose — so that a procedure the platform executes cannot be rewritten through the generic surface. Omitted fields are preserved. Pass isRunnable: false to RETIRE the task.',
    taskUpdateArgs,
    async (args) => callGovernedDoor('task', 'update', taskUpdateArgs, args),
  );

  server.tool(
    'hadron_create_review',
    'Create a REVIEW node — a check on work performed. Reviews are not coding-specific: any work can be reviewed, and a review may be a SAFETY check, which is why removing or rewriting one is treated as an attack and why `hadron_create_node` refuses to author one. The review role is set by this tool: "review" by default, or pass a dotted review sub-role such as "review.security". Reach for this when recording what must be verified about a piece of work, not when writing up the work itself.',
    reviewCreateArgs,
    async (args) => callGovernedDoor('review', 'create', reviewCreateArgs, args),
  );

  server.tool(
    'hadron_update_review',
    'Edit an existing REVIEW node. Needed because `hadron_update_node` refuses any edit whose result is still a review node — a safety check must not be rewritable through the generic surface. Omitted fields are preserved. Pass role: null to RETIRE the node from the review kind.',
    reviewUpdateArgs,
    async (args) => callGovernedDoor('review', 'update', reviewUpdateArgs, args),
  );

  // ── hadron_update_node_data ───────────────────────────────────────────
  //
  // Shallow-MERGE a JSON patch into a node's `data` bag (issue #366).
  // Distinct from hadron_update_node's `data` arg, which REPLACES the whole
  // bag — use this when you want to set/overwrite a few keys and keep the
  // rest. Delegates to the GraphQL updateNodeData resolver so the single-write
  // invariants (per-memory auth, encryption, revision history, git mirror) have
  // ONE implementation; like hadron_replace_text (and unlike the inline write
  // tools, #206) the delegated path encrypts/decrypts correctly.

  server.tool(
    'hadron_update_node_data',
    "Merge a JSON object into a node's `data` bag, preserving keys you don't mention. The patch's top-level keys are written over the node's existing data (the patch wins on collision); other keys stay as they were; a node with no data yet takes the patch as-is. The merge is SHALLOW — a nested object value is replaced wholesale, not deep-merged. Use this for partial data edits; to REPLACE the whole `data` bag instead, use hadron_update_node's `data` argument. Honors write permissions, revision history, and encryption.",
    SHAPE_HADRON_UPDATE_NODE_DATA,
    async ({ nodeUrn: rawNodeUrn, data }) => {
      // Build a GraphQL Context from the MCP auth, including appId + sessionId
      // so app-keyed write authorization resolves the same way it does for
      // hadron_update_node. Both fields are load-bearing and were once omitted
      // — the #206 finding. (The `gqlCtx` helper that omitted them is gone with
      // the chatbot tools, #1141; the requirement it got wrong is not.)
      const ctx: Context = {
        db,
        // #1301: a refusal from the delegated resolver addresses an MCP caller;
        // a door takes a whole `data` object, so the replace it names replays.
        transport: 'mcp',
        governedCanReplay: () => true,
        clientId: auth.clientId ?? undefined,
        userId: auth.userId ?? undefined,
        apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId, // #1868: the shared authorized tx re-checks the presented key
        appId: auth.appId ?? undefined,
        sessionId: auth.sessionId ?? undefined,
        roles: auth.roles as Context['roles'],
        organizationId: auth.organizationId ?? undefined,
      };

      try {
        const node = await resolvers.Mutation.updateNodeData(
          {},
          { nodeRef: rawNodeUrn, data },
          ctx,
        );
        const urn = await nodeUrn(node.loc, node.memoryId);
        return textResult(`Node data merged: ${urn} (id: ${node.id})${renderLintWarnings(await lintWarningPageForNodeId(scopeCtx(), node.id))}`);
      } catch (e) {
        return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : 'update failed'}`, 'hadron_update_node_data:resolver');
      }
    },
  );

  // ── Object store (#745): hadron_create_object / _get_object / _update_object
  //    / _delete_object / _find_objects ─────────────────────────────────────
  //
  // The legible sugar surface over structured storage — an object IS a node.
  // Each tool delegates to a GraphQL object resolver (createObject / object /
  // updateObject / deleteObject / findObjects), which is itself a thin
  // projection over the node write/read paths, so auth, encryption, schema
  // conformance, revisions and the atomic merge have ONE implementation.
  // Objects are flat JSON records { id, type, ...fields }.

  const objectCtx = (): Context => ({
    db,
    clientId: auth.clientId ?? undefined,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId, // #1868: the shared authorized tx re-checks the presented key
    appId: auth.appId ?? undefined,
    sessionId: auth.sessionId ?? undefined,
    roles: auth.roles as Context['roles'],
    organizationId: auth.organizationId ?? undefined,
  });

  server.tool(
    'hadron_create_object',
    'Create a structured object (record) in a collection — the object store\'s legible surface over structured storage. `type` is the collection (e.g. "competitor"); `fields` are the flat, typed properties. On a memory with a declared schema for the collection, the fields are validated against it (an error is returned on a violation). The node loc/name are auto-derived and hidden; pass `key` for a human-meaningful id. Returns the flat object { id, type, ...fields }. "id" and "type" are reserved and cannot be field names.',
    SHAPE_HADRON_CREATE_OBJECT,
    async ({ memoryUrn, type, fields, key, name }) => {
      try {
        const obj = await resolvers.Mutation.createObject(
          {},
          { memoryRef: memoryUrn, type, fields: fields ?? {}, key, name },
          objectCtx(),
        );
        return textResult(JSON.stringify(obj, null, 2));
      } catch (e) {
        return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : 'create failed'}`, 'hadron_create_object:resolver');
      }
    },
  );

  server.tool(
    'hadron_get_object',
    'Read one object by id (or node URN) from the object store, as a flat JSON record { id, type, ...fields }. Returns "Object not found." when it does not exist, is inaccessible, or the node is not an object (has no collection).',
    SHAPE_HADRON_GET_OBJECT,
    async ({ ref }) => {
      try {
        const obj = await resolvers.Query.object({}, { ref }, objectCtx());
        return obj ? textResult(JSON.stringify(obj, null, 2)) : refusalResult('Object not found.');
      } catch (e) {
        return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : 'read failed'}`, 'hadron_get_object:resolver');
      }
    },
  );

  server.tool(
    'hadron_update_object',
    'Merge fields into an existing object (server-side ATOMIC shallow merge — the patch wins on key collision, unmentioned fields preserved). On a schema-governed collection the merged result is validated. Returns the updated flat object. "id" and "type" are reserved and cannot be field names.',
    SHAPE_HADRON_UPDATE_OBJECT,
    async ({ ref, fields, reason }) => {
      try {
        const obj = await resolvers.Mutation.updateObject({}, { ref, fields: fields ?? {}, reason }, objectCtx());
        return textResult(JSON.stringify(obj, null, 2));
      } catch (e) {
        return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : 'update failed'}`, 'hadron_update_object:resolver');
      }
    },
  );

  server.tool(
    'hadron_delete_object',
    'Delete an object (soft by default — it disappears from reads/queries; pass hard:true to permanently remove the row).',
    SHAPE_HADRON_DELETE_OBJECT,
    async ({ ref, hard }) => {
      try {
        await resolvers.Mutation.deleteObject({}, { ref, hard }, objectCtx());
        return textResult(`Object deleted${hard ? ' (hard)' : ''}: ${ref}`);
      } catch (e) {
        return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : 'delete failed'}`, 'hadron_delete_object:resolver');
      }
    },
  );

  server.tool(
    'hadron_find_objects',
    'Query a collection in a memory. Returns { objects, total } — objects of `type` as flat records, plus the full match count for paging with limit/offset. `match` is an equality shorthand ({ field: value }) with each field\'s cast inferred from the memory schema; `where` is the full #719 structured predicate (ANDed with match; same grammar as hadron_find_nodes\' where); `sort` is a single-field shorthand ({ field: "asc" | "desc" }).',
    SHAPE_HADRON_FIND_OBJECTS,
    async ({ memoryUrn, type, match, where, sort, limit, offset }) => {
      try {
        const result = await resolvers.Query.findObjects(
          {},
          { memoryRef: memoryUrn, type, match: match ?? undefined, where: (where ?? undefined) as NodeWhere | undefined, sort: sort ?? undefined, limit, offset },
          objectCtx(),
        );
        // Return { objects, total } so agents can page deterministically with limit/offset.
        return textResult(JSON.stringify({ objects: result.objects, total: result.total }, null, 2));
      } catch (e) {
        return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : 'query failed'}`, 'hadron_find_objects:resolver');
      }
    },
  );

  // ── hadron_replace_text ──────────────────────────────────────────────
  //
  // Bulk literal/regex search-and-replace across many nodes at once. Delegates
  // to the GraphQL searchReplaceInNodes resolver so there is ONE implementation
  // of the write invariants (per-memory auth, encryption, revision history,
  // abstract-staleness, re-embedding, git mirror). Unlike the other MCP write
  // tools (#206), the delegated path encrypts/decrypts correctly because the
  // resolver owns that logic.

  server.tool(
    'hadron_replace_text',
    "Search-and-replace a piece of text across MANY nodes in one call. Selection is the union of explicit node URNs and whole memories (memoryUrns), optionally narrowed to a subtree by 'prefix' (a parent loc — matches that node plus its descendants on ':' path boundaries, so 'auth' matches 'auth' and 'auth:tokens' but not 'authoring'; requires memoryUrns). Searches the chosen text fields (content, name, alias, description, abstract, tags); JSON fields are not touched. Literal substring match by default; set regex:true to treat oldText as a regular expression and newText as a replacement pattern (supports $1/$& backrefs). ALWAYS run with dryRun:true first to preview match counts before writing — this tool can rewrite a lot of nodes at once. Governed nodes and Channel addresses are protected and reported as skipped rather than searched. Multi-node runs are all-or-nothing: a node whose edited field would violate a field cap (e.g. the 2000-character abstract cap, whose refusal reports the edit's delta and remaining headroom) refuses the WHOLE batch before any write — nothing is partially applied; fix the edit and re-run. Honors write permissions, revision history (each change is undoable), and re-embeds changed nodes.",
    SHAPE_HADRON_REPLACE_TEXT,
    async ({ oldText, newText, nodeUrns, memoryUrns, prefix, fields, caseInsensitive, regex, dryRun }) => {
      // Build a GraphQL Context from the MCP auth. Include appId + sessionId so
      // app-keyed write authorization (requireMemoryWriteAccess) resolves the
      // same way it does for hadron_create_node / hadron_update_node.
      const ctx: Context = {
        db,
        clientId: auth.clientId ?? undefined,
        userId: auth.userId ?? undefined,
        apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId, // #1868: the shared authorized tx re-checks the presented key
        appId: auth.appId ?? undefined,
        sessionId: auth.sessionId ?? undefined,
        roles: auth.roles as Context['roles'],
        organizationId: auth.organizationId ?? undefined,
      };

      // The resolver accepts IDs OR URNs for both selectors, so URNs pass
      // through unchanged.
      try {
        const result = await resolvers.Mutation.searchReplaceInNodes(
          {},
          {
            input: {
              oldText,
              newText,
              nodeIds: nodeUrns,
              memoryIds: memoryUrns,
              prefix,
              fields,
              caseInsensitive: caseInsensitive ?? false,
              regex: regex ?? false,
              dryRun: dryRun ?? false,
            },
          } as never,
          ctx,
        );

        // Render a compact, URN-addressed summary.
        const memoryUrnOf = memoizedMemoryUrnLookup();
        const lines = await Promise.all(
          result.results.map(async (r: { loc: string; memoryId: string; replacements: number; fields: Array<{ field: string; matches: number }> }) => {
            const urn = await nodeUrn(r.loc, r.memoryId, memoryUrnOf);
            const breakdown = r.fields.map((f) => `${f.field}×${f.matches}`).join(', ');
            return `  - ${urn} (${r.replacements}: ${breakdown})`;
          }),
        );

        const verb = result.dryRun ? 'Would replace' : 'Replaced';
        const header =
          `${verb} ${result.totalReplacements} occurrence(s) across ` +
          `${result.nodesChanged} of ${result.nodesScanned} node(s) scanned` +
          (result.dryRun ? ' (dry run — nothing written).' : '.');

        const coverage =
          `Coverage: ${result.nodesSelected} selected; ${result.nodesScanned} scanned; ` +
          `${result.nodesSkipped} skipped/protected ` +
          `(${result.skipCounts.governed} governed, ` +
          `${result.skipCounts.protectedAddress} protected address).`;

        // #2285: explain the existing aggregate skip, without inferring or
        // exposing a selected node's kind or changing the resolver's gates.
        const guidance: string[] = [];
        if (result.nodesScanned === 0 && result.nodesSkipped > 0) {
          guidance.push('Selected nodes were skipped before text scanning; 0 scanned does not mean those selected nodes were not found.');
        }
        if (result.skipCounts.governed > 0) {
          guidance.push('Governed nodes require their own update door: tasks use hadron_update_task; reviews use hadron_update_review; specs use the CLI hadron spec commands (no MCP spec door). Other governed kinds require their owning operation. Generic full-content node updates are not a workaround.');
        }
        // #2048: lint warnings of each boot-prompt source this call changed (a dry run changed nothing).
        const lintLines: string[] = [];
        for (const item of result.results) {
          const warning = renderIncludePinWarnings(await includePinWarningsFor(ctx, item));
          if (warning) lintLines.push(warning);
        }
        if (!result.dryRun) {
          const changed = result.results.filter((x: { replacements: number }) => x.replacements > 0);
          for (const r of changed.slice(0, REPLACE_LINT_MAX_NODES)) {
            const text = renderLintWarnings(await lintWarningPageForNodeId(scopeCtx(), { memoryId: r.memoryId, loc: r.loc }));
            if (text) lintLines.push(`${await nodeUrn(r.loc, r.memoryId, memoryUrnOf)}:${text}`);
          }
          if (changed.length > REPLACE_LINT_MAX_NODES) {
            lintLines.push(`Lint warnings not checked for ${changed.length - REPLACE_LINT_MAX_NODES} of ${changed.length} changed node(s); read a boot-prompt node with hadron_get_node to see its lint warnings.`);
          }
        }
        return textResult([header, coverage, ...guidance, ...lines, ...lintLines].join('\n'));
      } catch (e) {
        return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : 'search-and-replace failed'}`, 'hadron_replace_text:resolver');
      }
    },
  );

  // ── hadron_create_edge ───────────────────────────────────────────────────────────
  //
  // Issue #183 — hadron_update_node.edges replaces the full outgoing-edge set,
  // which means the only way to add a single edge to an existing node
  // without hadron_create_edge is to re-send EVERY existing edge plus the new
  // one. Easy to drop edges by accident. This tool fills that gap with
  // an idempotent single-edge insert that leaves all other edges alone.

  server.tool(
    'hadron_create_edge',
    'Add a single outgoing edge from one node to another. Non-destructive — leaves all other edges on the source node intact (unlike hadron_update_node, which replaces the full edge set). Idempotent: re-running the same edge at the same loc is a no-op (loc is the edge identity; omit it and the same source/target/name always derive the same loc). An occupied loc with different endpoints or metadata returns [edge_loc_conflict]. Both endpoints may be given as an ID-shape PK OR a fully-qualified node URN (hrn:node:<root>:<memory>:<loc>). Prefer the PK: it is immutable, so an edge created against it survives a later move/rename of the node, whereas a URN does not (#322). Both endpoints must already exist — use hadron_create_node first to create them. Cross-memory edges are supported, but the caller must have read access on the target memory.',
    SHAPE_HADRON_CREATE_EDGE,
    async ({ sourceUrn, targetUrn, name, loc, description, isRunnable }) => {
      const result = await addEdge({ sourceUrn, targetUrn, name, loc, description, isRunnable, auth });
      if ('error' in result) return refusalResult(result.error);
      return textResult(
        `Edge saved: ${result.edgeUrn}${result.name ? ` (${result.name})` : ''}\n  ${result.sourceUrn} → ${result.targetUrn}`,
      );
    },
  );

  // ── hadron_update_edge / hadron_delete_edge (#835) ───────────────────────────
  //
  // GraphQL has had full edge CRUD since spec 037; MCP exposed only
  // hadron_create_edge. So an agent wanting to change ONE edge's name had
  // exactly one route: hadron_update_node(edges:), which REPLACES the node's
  // whole outgoing set — a whole-set overwrite to express a single-edge intent.
  // It returns "Node updated" and reports nothing about the edges it dropped.
  //
  // These are thin wrappers over the GraphQL resolvers (the delegate-don't-
  // reimplement rule in findings:node-write-surface-invariants), so the
  // memory-scoped write gate, loc validation, condition validation and
  // revision behavior are the resolver's, not a second copy.

  server.tool(
    'hadron_update_edge',
    'Change ONE existing edge\'s METADATA in place — its name, loc, description, runnability, routing priority, routing condition, or data. Non-destructive: every other edge on the source node is left alone. This is the tool to reach for when you want to relabel a single relationship; do NOT use hadron_update_node(edges:) for that, as it replaces the node\'s entire outgoing edge set and silently deletes the edges you did not re-supply. Only the fields you pass are changed; pass null to CLEAR a nullable field. This tool canNOT move an edge to a different source or target — endpoints are fixed at creation, so re-point a relationship by deleting the edge and creating a new one. The edge may be given as an ID-shape PK or a fully-qualified edge URN (hrn:edge:<root>:<memory>:<loc>).',
    SHAPE_HADRON_UPDATE_EDGE,
    async ({ edgeRef, name, loc, description, isRunnable, priority, condition, data }) => {
      try {
        const edge = await resolvers.Mutation.updateEdge(
          {},
          // Spread through as-is: `undefined` means "leave alone" and an
          // explicit `null` means "clear", which is exactly the contract
          // Mutation.updateEdge implements (`name !== undefined ? name ?? null`).
          { edgeRef, name, loc, description, isRunnable, priority, condition, data },
          objectCtx(),
        );
        const e = edge as EdgeUpdateReadback & { memoryId: string };
        // #1057: echo what changed, read back from the STORED edge, not the
        // untouched name. A receipt that repeats a field you did not write
        // makes a correct write read as a no-op, and the next move is a retry.
        return textResult(
          `Edge updated: ${await edgeUrn(e.loc, e.memoryId)} — ${describeEdgeUpdate(
            { name, loc, description, isRunnable, priority, condition, data },
            e,
          )}`,
        );
      } catch (err) {
        return roleWriterRefusalText(err) !== null ? refusalResult(roleWriterRefusalText(err) as string) : toolErrorResult(err, () => String((err as Error)?.message ?? err), 'hadron_update_edge');
      }
    },
  );

  server.tool(
    'hadron_delete_edge',
    'Delete ONE edge. Non-destructive to everything else: the source and target nodes and all their other edges are untouched. Use this rather than hadron_update_node(edges:) with the edge omitted — that argument replaces the whole set and would delete the node\'s other edges too. The edge may be given as an ID-shape PK or a fully-qualified edge URN.',
    SHAPE_HADRON_DELETE_EDGE,
    async ({ edgeRef }) => {
      try {
        await resolvers.Mutation.deleteEdge({}, { edgeRef }, objectCtx());
        return textResult(`Edge deleted: ${edgeRef}`);
      } catch (err) {
        return roleWriterRefusalText(err) !== null ? refusalResult(roleWriterRefusalText(err) as string) : toolErrorResult(err, () => String((err as Error)?.message ?? err), 'hadron_delete_edge');
      }
    },
  );

  // ── hadron_delete_node ────────────────────────────────────────────────────────
  //
  // #180 Bug 1 — agents had no way to remove a node they created in error.
  // Soft-delete is the default; `hard: true` opts into the row delete.
  //
  // Refuses if the node has descendants (by URN hierarchy) unless the
  // caller passes `recursive: true`. The refusal envelope includes the
  // descendant count so agents can decide what to do. Safest default —
  // an `archive` node with 19 children should not vanish as a side-
  // effect of a single delete call.
  //
  // Hard-delete cascade (per Node FK relations in prisma/schema.prisma):
  //   - Edge (source + target): onDelete: Cascade.
  //   - PendingEdge (source): onDelete: Cascade for the SOURCE side
  //     only. The targetId column is INTENTIONALLY NOT a foreign key
  //     (it points at nodes that don't exist yet), so the target side
  //     does NOT cascade — we delete those rows explicitly inside the
  //     transaction below. Caught in PR-189 review.
  //   - NodeRevision: onDelete: Cascade.
  //   - UsageEvent.nodeId: SetNull — audit history preserved.
  //
  // Cross-memory edge gate (hard-delete only): if any edge bridges this
  // memory to another and either endpoint is in the to-be-deleted set,
  // the call refuses without `cascadeCrossMemoryEdges: true`. The caller
  // has write access here but NOT necessarily to the other memory;
  // cascading would silently mutate data the caller doesn't own.
  //
  // Atomicity: descendant-count → refuse-or-act runs inside a single
  // transaction (#664) so a descendant created mid-flight either appears in the
  // recursive scope or causes the refusal to fire — never a half-complete state
  // where the descendant is silently orphaned. An advisory lock on this node's
  // loc (taken first, keyed identically to the lock every descendant-create
  // holds on it as an ancestor — see nodeSubtreeLock.ts) closes the
  // count-then-act race: a concurrent descendant-create either commits before
  // the lock (counted → refused) or waits until this delete commits (create
  // after delete — tolerated). READ COMMITTED (the default) is required so the
  // count runs on a fresh snapshot taken after the lock is granted.

  server.tool(
    'hadron_delete_node',
    `Delete a node. Soft-delete by default (sets deletedAt; node disappears from find/read/list and is excluded from Related / Referenced-by edge surfaces). Pass \`hard: true\` to remove the row entirely.

Hard-delete cascades to Edge (both directions) and NodeRevision via FK. PendingEdge source-side rows also cascade via FK, but the target-side column is intentionally not a foreign key — those rows are deleted explicitly inside the same transaction. UsageEvent.nodeId is SetNull so audit history is preserved.

Refuses if the node has descendants under its URN prefix unless \`recursive: true\`. Hard-delete additionally refuses if any edge bridges this memory to another (the caller doesn't necessarily own the other memory) unless \`cascadeCrossMemoryEdges: true\`. The URN MUST be fully qualified (hrn:node:<root>:<memory>:<loc>).`,
    SHAPE_HADRON_DELETE_NODE,
    async ({ urn: rawUrn, hard, recursive, cascadeCrossMemoryEdges }) => {
      try {
        assertFullyQualifiedUrn(rawUrn, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return refusalResult(e.message);
        throw e;
      }

      const { memoryUrn, loc, fragment } = splitNodeUrn(rawUrn);
      const fragRefusal = nodeFragmentRefusal(rawUrn, fragment);
      if (fragRefusal) return refusalResult(fragRefusal);
      const memory = await resolveMemoryByUrn(memoryUrn);
      if (!memory) {
        return refusalResult(`Node "${rawUrn}" not found.`);
      }
      if (!(await canWriteToMemory(db, auth, memory.id, EXPLICIT_REF))) {
        // Match the "not found" phrasing used elsewhere on access denial
        // so the response doesn't distinguish absence from denial.
        return refusalResult(`Node "${rawUrn}" not found.`);
      }

      // Find the node by (loc, memoryId). Already-tombstoned nodes are
      // treated as not-found for soft-delete (idempotent no-op shape) but
      // are addressable for hard-delete so callers can compact them.
      const existing = await db.node.findUnique({
        where: { loc_memoryId: { loc, memoryId: memory.id } },
      });
      if (!existing) return refusalResult(`Node "${rawUrn}" not found.`);
      if (existing.deletedAt && !hard) {
        return textResult(
          `Node "${rawUrn}" is already soft-deleted. Pass hard: true to remove the row entirely.`,
        );
      }

      type DeleteResult =
        | { refused: 'descendants'; count: number }
        | { refused: 'crossMem'; count: number }
        | { refused: 'crossMemAccess' }
        | { refused: 'changed' }
        | { refused: 'access' }
        | { refused: 'mintedSpec'; message: string }
        | { refused: 'comment'; message: string }
        | { refused: 'decision'; message: string }
        | { refused: 'governed'; message: string }
        | { refused: 'writerLevel'; message: string }
        | { ok: true; descendantCount: number };

      // #449 — source memories whose pending-edge count a hard delete changed.
      let pendingSourceMemories: string[] = [];
      const result: DeleteResult = await db.$transaction(async (tx) => {
        // Keep the dead-Channel cleanup verdict stable through the delete.
        // Channel resurrection takes this same key before any loc key.
        await lockMemoryForChannelChange(tx, memory.id);
        await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memory.id} FOR SHARE`;
        if (!(await canWriteToMemory(tx as typeof db, auth, memory.id, EXPLICIT_REF))) {
          return { refused: 'access' };
        }
        // lockNodeForDelete acquires the loc lock and then re-runs the
        // protected-loc gate on a fresh snapshot. While this memory lock is
        // held, a reuse that already won is visible and a later reuse cannot
        // invalidate the verdict.
        await lockNodeForDelete(tx, memory.id, loc);
        // A stable node id can move while this request waits on the old loc.
        // Abort instead of deleting that id at its new address/memory.
        const current = await tx.node.findUnique({
          where: { id: existing.id },
          select: { memoryId: true, loc: true },
        });
        if (!current || current.memoryId !== memory.id || current.loc !== loc) {
          return { refused: 'changed' };
        }
        // Descendants by URN hierarchy: loc startsWith node.loc + ':'.
        // Soft-delete refuses based on LIVE descendants; hard-delete
        // refuses based on the union (a tombstoned descendant still has
        // an FK that the row delete would cascade through, surprising
        // for the caller).
        const descendantWhere = {
          memoryId: memory.id,
          loc: { startsWith: escapePrismaLikePattern(loc + ':') },
          ...(hard ? {} : { deletedAt: null }),
        };
        const descendantCount = await tx.node.count({ where: descendantWhere });
        if (descendantCount > 0 && !recursive) {
          return { refused: 'descendants', count: descendantCount };
        }

        // #1468 — the complete removal scope, under the loc lock above. A hard
        // delete also removes tombstones; a soft delete removes live rows. Hard
        // deletes reuse these ids for the cross-memory check + PendingEdge
        // cleanup.
        const affectedIds =
          recursive && descendantCount > 0
            ? (await tx.node.findMany({
                where: {
                  memoryId: memory.id,
                  ...(hard ? {} : { deletedAt: null }),
                  OR: [{ id: existing.id }, { loc: { startsWith: escapePrismaLikePattern(loc + ':') } }],
                },
                select: { id: true },
              })).map((n) => n.id)
            : [existing.id];
        // Refused before any write, so returning (not throwing) commits nothing.
        try {
          await assertNoMintedSpecRemoval(tx, memory.id, affectedIds, hard ? 'hard-delete' : 'delete');
        } catch (e) {
          if (e instanceof ScopeGraphQLError && e.extensions?.code === SPEC_MINTED_PERMANENT) {
            return { refused: 'mintedSpec', message: e.message };
          }
          throw e;
        }
        // #1606 (cor:dmo:110:04/05) — a comment is removed only by the comment
        // path's thread delete; a target takes its threads with it.
        if ((await commentIdsAmong(tx, affectedIds)).length > 0) {
          return { refused: 'comment', message: commentGovernedError('delete', 'removes').message };
        }
        await assertNoBootPromptRows(tx, affectedIds, 'delete');
        // #1641 §3.2 — a decision is withdrawn, never deleted.
        const decisions = await decisionFamilyAmong(tx, affectedIds);
        if (decisions.length > 0) {
          return { refused: 'decision', message: decisionContainedError('Deleting this node', decisions.map((d) => d.loc)).message };
        }
        // A governed node is removed only after its marker is cleared through
        // the kind's door: the whole affected set is judged on locked rows.
        const removed = await lockRemovalRows(tx, memory.id, affectedIds, { hard: !!hard });
        const governedHits = governedAmong(removed);
        if (governedHits.length > 0) {
          return { refused: 'governed', message: governedRemovalError(governedHits, 'mcp').message };
        }
        // cor:acl:130:07 — removing a node writes it: each removed row needs its
        // writer level, judged on the rows locked above.
        try {
          await assertRoleWritersForNodes(tx, auth, removed, { from: memory.id });
        } catch (e) {
          const text = roleWriterRefusalText(e);
          if (text) return { refused: 'writerLevel', message: text };
          throw e;
        }
        if (hard) await hardDeleteThreadsOfTargets(tx, affectedIds);
        else await softDeleteThreadsOfTargets(tx, affectedIds, { deletedBy: auth.userId ?? auth.clientId ?? null, at: new Date() });

        if (hard) {

          if (!cascadeCrossMemoryEdges) {
            const crossMemEdges = await tx.edge.count({
              where: {
                OR: [
                  { targetId: { in: affectedIds }, source: { memoryId: { not: memory.id } } },
                  { sourceId: { in: affectedIds }, target: { memoryId: { not: memory.id } } },
                ],
              },
            });
            if (crossMemEdges > 0) {
              return { refused: 'crossMem', count: crossMemEdges };
            }
          }          // #1647: acknowledging the cascade is not write authority over the other holdings it edits. Refused atomically.
          for (const other of await foreignEdgeMemoryIds(tx, affectedIds, memory.id)) {
            if (!(await canWriteToMemory(tx as typeof db, auth, other, EXPLICIT_REF))) return { refused: 'crossMemAccess' };
          }

          // PendingEdge target-side cleanup — NOT a FK, so the cascade
          // misses these (PR-189 review caught this), in both node-keyed forms (#449).
          pendingSourceMemories = await deletePendingEdgesTargetingNodes(tx, affectedIds);

          if (recursive && descendantCount > 0) {
            await tx.node.deleteMany({
              where: {
                memoryId: memory.id,
                OR: [{ id: existing.id }, { loc: { startsWith: escapePrismaLikePattern(loc + ':') } }],
              },
            });
          } else {
            await tx.node.delete({ where: { id: existing.id } });
          }
        } else {
          const now = new Date();
          const deletedBy = auth.userId ?? auth.clientId ?? null;
          if (recursive && descendantCount > 0) {
            await tx.node.updateMany({
              where: {
                memoryId: memory.id,
                deletedAt: null,
                OR: [{ id: existing.id }, { loc: { startsWith: escapePrismaLikePattern(loc + ':') } }],
              },
              data: { deletedAt: now, deletedBy },
            });
          } else {
            await tx.node.update({
              where: { id: existing.id },
              data: { deletedAt: now, deletedBy },
            });
          }
        }

        return { ok: true, descendantCount };
      // #1619 — the 5 s default expires on a large cascade. Same accepted pool/lock
      // trade-off as GraphQL deleteNode (see the comment there).
      }, { timeout: 120_000 });
      await reconcilePendingEdgeCounts(db, pendingSourceMemories).catch((err) =>
        console.warn('[hadron_delete_node] pending-edge count reconcile failed (the periodic repair will fix it):', err),
      );

      if ('refused' in result) {
        if (result.refused === 'access') {
          return refusalResult(`Node "${rawUrn}" not found.`);
        }
        if (result.refused === 'crossMemAccess') {
          return textResult(
            'Hard-delete refused: it would remove edges held by a memory you cannot write. Nothing was deleted.',
          );
        }
        if (result.refused === 'changed') {
          return textResult(`Node "${rawUrn}" moved while this delete waited; re-read it and retry.`);
        }
        if (result.refused === 'mintedSpec') {
          return refusalResult(`[spec_minted_permanent] ${result.message}`);
        }
        if (result.refused === 'comment') {
          return refusalResult(`[role_governed] ${result.message}`);
        }
        if (result.refused === 'decision') {
          return refusalResult(`[decision_contained] ${result.message}`);
        }
        if (result.refused === 'governed') {
          return refusalResult(`[role_governed] ${result.message}`);
        }
        if (result.refused === 'writerLevel') {
          return textResult(result.message);
        }
        if (result.refused === 'descendants') {
          const mode = hard ? 'hard delete' : 'soft delete';
          return textResult(
            `Node "${rawUrn}" has ${result.count} descendant(s). ` +
              `${mode} refuses without recursive: true. ` +
              `Pass recursive: true to apply the same ${hard ? 'hard' : 'soft'} delete to every descendant.`,
          );
        }
        return textResult(
          `Hard-delete refused: ${result.count} edge(s) bridge this memory to another. ` +
            `Pass cascadeCrossMemoryEdges: true to acknowledge that cascading will remove those edges ` +
            `(the other memory's view loses them with no further notice).`,
        );
      }

      // #1061 — a delete is a write, on the addressed node only (a recursive
      // delete's descendants are not counted individually, matching the GraphQL
      // deleteNode). A HARD delete records nothing: the row is gone, so the
      // event's `nodeId` FK has nothing to point at — and unlike the soft case
      // there is no surviving node whose usage series the event belongs to.
      if (!hard) {
        recordNodeWrite(
          db,
          { id: existing.id, loc: existing.loc, memoryId: existing.memoryId },
          auth,
        );
      }

      const totalAffected = (recursive ? result.descendantCount : 0) + 1;
      const mode = hard ? 'Hard-deleted' : 'Soft-deleted';
      const suffix =
        recursive && result.descendantCount > 0
          ? ` (1 node + ${result.descendantCount} descendant(s) = ${totalAffected} total)`
          : '';
      return textResult(`${mode} "${rawUrn}"${suffix}.`);
    },
  );

  // ── hadron_move_node ──────────────────────────────────────────────────────────

  server.tool(
    'hadron_move_node',
    `Move or rename a node, optionally across memories. The node keeps its stable ID so all edge references remain valid. Both URNs MUST be fully qualified (hrn:node:<root>:<memory>:<loc>).

Collision policy: if a live node already occupies \`targetUrn\`, the call refuses with a URN_ALREADY_EXISTS error. Pass \`overwrite: true\` to soft-delete the existing target first; the evicted row is re-stamped to \`<loc>__deleted-<full-id>\` so the unique \`(loc, memoryId)\` constraint doesn't block. Hard-overwrite isn't supported — call hadron_delete_node (hard: true) on the target first if you need that.

Descendants move WITH the node (#768): a node's loc-subtree (every node whose loc is prefixed by \`<loc>:\`) is rebased onto the new loc, so children's URNs follow the parent. This works within one memory OR across memories (#781) — a different memory in \`targetUrn\` relocates the whole subtree there, carrying the moved nodes' embeddings and rewriting the edges whose source moved to the destination memory. A boundary edge to a node left behind becomes a cross-memory edge (its far endpoint is access-gated on read). A same-memory move leaves edge locs untouched (a derived denormalization; keep addressing those edges by their existing URN). A collision at any DESCENDANT slot refuses the whole move (overwrite only evicts the explicitly-named target loc).

The node's \`name\` (its human-authored display title) is PRESERVED — a move changes the address, not the title, exactly as the GraphQL \`moveNode\` mutation does (#1017). Pass \`renameToLeaf: true\` if you want the name re-derived from the new loc's terminal atom instead. Descendants' names are never rewritten either way.

Atomicity: collision-evict → per-node NodeRevision snapshot → subtree move all run inside a single db.$transaction so a partial failure cannot leave the URN slot empty.

On success returns the moved node's record: new URN, name, type, tags, edge counts, and immediate-child count (empty sections omitted). A cross-memory move also reports raw relative content links that now miss or point to a different node; content is not rewritten.`,
    SHAPE_HADRON_MOVE_NODE,
    async ({ urn: rawFrom, targetUrn: rawTo, overwrite, renameToLeaf }) => {
      // Spec 022: qualification at the API boundary for both source and target.
      try {
        assertFullyQualifiedUrn(rawFrom, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return refusalResult(`Source: ${e.message}`);
        throw e;
      }
      try {
        assertFullyQualifiedUrn(rawTo, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return refusalResult(`Target: ${e.message}`);
        throw e;
      }

      const { memoryUrn: fromMemoryUrn, loc: fromLoc, fragment: fromFrag } =
        splitNodeUrn(rawFrom);
      const { memoryUrn: toMemoryUrn, loc: toLoc, fragment: toFrag } = splitNodeUrn(rawTo);
      // BOTH ends: a fragment on the destination would move the node to the
      // parent's loc and silently drop the "#data" the caller wrote.
      const moveRefusal =
        nodeFragmentRefusal(rawFrom, fromFrag) ?? nodeFragmentRefusal(rawTo, toFrag);
      if (moveRefusal) return refusalResult(moveRefusal);

      // #1316: BOTH ends conceal at the point their missing branch answers —
      // a later refusal would leak through the loc validation and the source
      // node lookup that run in between.
      const fromMemory = await resolveVisibleMemoryByUrn(auth, fromMemoryUrn, 'write');
      // #2206 (B): a move carries the node's content (and its render, below) to the caller, so a source memory the
      // caller may write but not read answers as one it cannot see.
      if (!fromMemory || (await isWriteBeyondRead(db, auth, fromMemory.id))) {
        return refusalResult(`Source memory not found: "${fromMemoryUrn}".`);
      }
      const toMemory = await resolveVisibleMemoryByUrn(auth, toMemoryUrn, 'write');
      if (!toMemory) {
        return refusalResult(`Target memory not found: "${toMemoryUrn}".`);
      }

      try {
        validateLoc(toLoc);
      } catch (e) {
        return e instanceof InvalidLocError ? refusalResult(e.message) : toolErrorResult(e, () => (e as Error).message, 'hadron_move_node:validateLoc');
      }

      const existing = await db.node.findUnique({
        where: { loc_memoryId: { loc: fromLoc, memoryId: fromMemory.id } },
      });
      if (!existing) return refusalResult(`Node "${rawFrom}" not found.`);

      if (!(await canWriteToMemory(db, auth, fromMemory.id, EXPLICIT_REF))) {
        return refusalResult(`Write access denied for source memory.${await explainWriteRefusal(db, auth, fromMemory.id)}`);
      }
      if (toMemory.id !== fromMemory.id && !(await canWriteToMemory(db, auth, toMemory.id, EXPLICIT_REF))) {
        return refusalResult(`Write access denied for target memory.${await explainWriteRefusal(db, auth, toMemory.id)}`);
      }

      const isSameSlot = toLoc === fromLoc && toMemory.id === fromMemory.id;

      // Transactional core. Collision-check, eviction-re-stamp, NodeRevision
      // snapshot, and the row move all run inside one transaction. The move
      // itself targets the row BY ID (not by composite key) so the post-
      // move record fetch can't race against a concurrent move into the
      // same slot — `id` is stable across moves.
      type MoveResult =
        | { refused: 'urn-exists'; targetUrn: string }
        | {
            ok: true;
            moved: {
              name: string;
              description: string | null;
              nodeType: string;
              tags: string[];
              outgoingEdges: Array<{ id: string }>;
              incomingEdges: Array<{ id: string }>;
            };
            childCount: number;
          };

      let result: MoveResult;
      // #1095 — the relocated set (each node's id + the loc it LEFT), captured
      // inside the transaction so the git mirror can run after it commits. Empty
      // for the same-slot no-op branch, which relocates nothing.
      let relocated: MoveNodeSubtreeResult['moved'] = [];
      let linkWarnings: MoveNodeSubtreeResult['linkWarnings'] = [];
      try {
        const completed = await withArchivePlanRetries(async (timeout) => {
          let relocated: MoveNodeSubtreeResult['moved'] = [];
          let linkWarnings: MoveNodeSubtreeResult['linkWarnings'] = [];
          const attemptResult = await db.$transaction<MoveResult>(async (tx) => {
            let attemptAuth = auth;
            const authorizeAttempt = async () => {
              if (auth.userId) {
                const user = await tx.user.findUnique({ where: { id: auth.userId }, select: { roles: true, deletedAt: true } });
                if (!user || user.deletedAt) throw new MemoryWriteAccessChangedDuringWriteError('[node_write_conflict] Memory write access changed while this write waited — re-read and retry.');
                attemptAuth = { ...auth, roles: auth.impersonation ? [] : user.roles };
              }
              await assertLockedMemoryWriteAccess(tx, attemptAuth, fromMemory.id);
              await assertLockedMemoryWriteAccess(tx, attemptAuth, toMemory.id);
            };
            // #2206 (#2233): an Agent definition's authority, at either end, before any loc or row lock.
            await lockAgentDefinitionAuthority(tx, auth.userId ?? null, [fromMemory.id, toMemory.id]);
            await authorizeAttempt();
            // #664/#752: moving a node INTO a subtree is the same orphan vector as
            // creating there — lock the destination's ancestor path first (matching
            // the GraphQL moveNode resolver and hadron_delete_node's own-loc lock),
            // so a concurrent non-recursive delete of a destination ancestor can't
            // count zero descendants and then let this move land under it. Taken
            // before any row-locking statement to keep advisory-before-row ordering
            // consistent with the delete path (no lock-order inversion).
            // #1187 (@codex + @copilot on PR #1211) — DECLARE the complete key
            // set first, in the one global order, exactly as the GraphQL
            // `moveNode` resolver does. This surface was missed when that
            // protocol landed: it took the destination ancestors here and reached
            // the source path only later, inside `moveNodeSubtree`
            // (`lockSourceForMove`). For source `a` and destination `z:child`
            // that is `z` then `a`, while the GraphQL path takes `a` then `z` —
            // so the two SURFACES could deadlock against each other, and two MCP
            // moves with opposing paths against themselves.
            //
            // Enumerating the multi-key callers from the GraphQL resolvers alone
            // is how this was missed; the writers are enumerated by STATE (who
            // takes two keys), never by the call sites one happens to know.
            // #1466: an edge writer holds this memory key across endpoint
            // validation and insertion. Take it before any loc lock so an edge
            // cannot land after archiveTombstone enumerates the target's edges.
            await lockEdgeEndpointMemories(tx, [toMemory.id]);
            const archivePlan = await discoverArchivePlan(tx, toMemory.id, toLoc);
            await acquireLockSet(tx, [
              ...archivePlan.descendantLocs.map(loc => ({ memoryId: toMemory.id, loc })),
              ...ancestorLocs(toLoc).map((loc) => ({ memoryId: toMemory.id, loc })),
              ...ancestorLocs(fromLoc).map((loc) => ({ memoryId: fromMemory.id, loc })),
              { memoryId: fromMemory.id, loc: fromLoc },
              { memoryId: toMemory.id, loc: toLoc },
            ]);
            await lockAncestorsForCreate(tx, toMemory.id, toLoc);
            await authorizeAttempt();
            await validateArchivePlan(tx, archivePlan);

            if (isSameSlot) {
              // Same-slot "move": source and target address are identical, so the
              // ONLY thing left to do is the opt-in leaf rename (#1017). Without
              // it this is a literal no-op — writing a NodeRevision for it would
              // record a change that did not happen, and on a memory with a
              // maxRevCount cap it would evict real history to store nothing.
              //
              // The rename is itself skipped when the name ALREADY equals the
              // leaf (PR #1018 review, Copilot): re-stamping an identical value
              // is the same no-op-history problem one line up, and a same-slot
              // call is exactly where it is most likely — a caller normalizing a
              // name that is already normalized.
              const newName = toLoc.split(':').pop()!;
              if (renameToLeaf === true && existing.name !== newName) {
                // Row lock + drift reconciled as its own revision, then the
                // authoritative re-read the snapshot is built from — the rule on
                // every single-row revisioned writer (PR #1339 review).
                // Re-validate BEFORE reconciling (@copilot, PR #1339): the row
                // must still be the live node at the authorized (memory, loc),
                // or this would reconcile — and then rename — a row that moved.
                await tx.$queryRaw`SELECT "id" FROM "nodes" WHERE "id" = ${existing.id} FOR UPDATE`;
                // This direct same-slot rename bypasses moveNodeSubtree but still
                // snapshots history. Hold the source encryption flag before it.
                await tx.$queryRaw`SELECT "id" FROM "memories" WHERE "id" = ${fromMemory.id} FOR SHARE`;
                await assertLockedMemoryWriteAccess(tx, attemptAuth, fromMemory.id);
                const still = await tx.node.findUnique({
                  where: { id: existing.id },
                  select: { memoryId: true, loc: true, deletedAt: true },
                });
                if (!still || still.deletedAt || still.memoryId !== fromMemory.id || still.loc !== fromLoc) {
                  throw new SubtreeMoveSourceChangedError(existing.id);
                }
                await ensureCurrentNodeRevisionInTransaction(tx, existing.id, { expectedMemoryId: fromMemory.id });
                const locked = await tx.node.findUniqueOrThrow({ where: { id: existing.id } });
                // #1641 — a decision's name is its rendered `<code>: <title>`,
                // which its approval covers; only the decision doors change it.
                if (isDecisionFamilyRole(locked.role)) throw decisionContainedError('Renaming this node', [locked.loc]);
                await createNodeRevision(tx, {
                  id: generateId(),
                  ...buildNodeRevisionSnapshot(locked, editorFromAuth(auth), {
                    changes: diffNodeChanges(locked, { loc: toLoc, name: newName, memoryId: toMemory.id }),
                  }),
                });
                await tx.node.update({
                  where: { id: existing.id },
                  data: {
                    loc: toLoc,
                    name: newName,
                    memoryId: toMemory.id,
                    ...clearNodeAuthorship(),
                    revisionContentHash: revisionStateHashRefreshMarker(),
                  },
                });
              }
            } else {
              const crossMemory = toMemory.id !== fromMemory.id;

              // Collision policy for the EXPLICITLY-named target loc: a live
              // occupant refuses unless overwrite:true, which soft-deletes it and
              // re-stamps its loc out of the way so the (loc, memoryId) unique
              // doesn't block. Use the FULL id in the archived loc — UUIDv7's first
              // 6 bytes are the ms timestamp, so an 8-char slice was timestamp-only
              // entropy (PR-189). Descendant-slot collisions are always refused —
              // moveNodeSubtree throws SubtreeMoveCollisionError (caught below).
              const existingTarget = await tx.node.findUnique({
                where: { loc_memoryId: { loc: toLoc, memoryId: toMemory.id } },
              });
              if (existingTarget && !existingTarget.deletedAt && !overwrite) {
                const targetUrn = await nodeUrn(toLoc, toMemory.id);
                return { refused: 'urn-exists', targetUrn };
              }
              // #1331 — overwriting evicts the occupant: its role's writer level applies.
              if (existingTarget && !existingTarget.deletedAt) {
                await assertRoleWritersForNodes(tx, attemptAuth, [existingTarget], { from: toMemory.id });
              }
              if (existingTarget) {
                if (!existingTarget.deletedAt) {
                  await tx.node.update({
                    where: { id: existingTarget.id },
                    data: { deletedAt: new Date(), deletedBy: auth.userId ?? auth.clientId ?? null },
                  });
                }
                // #1466: the old node's edges keep locs derived from this address.
                // Rekey them with the tombstone inside the same move transaction,
                // before the mover takes the address and can create its own edges.
                await archiveTombstone(tx, existingTarget, archivePlan);
              }

              // #768/#781: rebase the whole loc-subtree via the shared helper (the
              // ONE implementation the GraphQL moveNode resolver also uses) — SAME-
              // memory or CROSS-memory (destMemoryId carries nodes + embeddings +
              // outgoing edges across). It locks + revalidates the source and
              // writes a NodeRevision per moved node.
              //
              // #1017: renameSourceLeaf is now the CALLER's choice, defaulting off.
              // It used to be hardcoded true, which silently overwrote the moved
              // node's human-authored `name` with the target loc's terminal atom —
              // unconditional, undocumented, and the opposite of what the GraphQL
              // `moveNode` resolver does with the same helper. Two surfaces of one
              // operation disagreeing is bad enough; the tool's own description
              // enumerated what survives a move (id, edges, descendants) and never
              // mentioned `name`, so the contract actively taught the wrong thing.
              // The damage was quiet, too — loc and name are usually similar
              // enough that a clobbered title still reads plausibly.
              const subtreeResult = await moveNodeSubtree(tx, {
                source: existing,
                destLoc: toLoc,
                destMemoryId: crossMemory ? toMemory.id : undefined,
                editor: editorFromAuth(auth),
                renameSourceLeaf: renameToLeaf === true,
                authorizeLockedMemory: (memoryId) => assertLockedMemoryWriteAccess(tx, attemptAuth, memoryId),
                principal: attemptAuth,
              });
              relocated = subtreeResult.moved;
              linkWarnings = subtreeResult.linkWarnings;
              // #1468 — evicting the destination occupant removes it from its
              // corpus and hands its citation to another node: refused for a
              // minted spec. Checked AFTER the helper on purpose: it already holds
              // the occupant row (the eviction update) and the destination memory
              // FOR NO KEY UPDATE, so the guard takes nothing new; checking first
              // would take that memory FOR SHARE and then upgrade it inside the
              // helper, the deadlock its header warns about. A refusal rolls the
              // whole transaction back.
              if (existingTarget) {
                await assertNoMintedSpecRemoval(tx, toMemory.id, [existingTarget.id], 'overwrite');
                // #1641 §3.2 — evicting a decision would delete it.
                await refuseDecisionFamily(tx, [existingTarget.id], 'Overwriting this node');
                // Evicting a live occupant is a removal: a governed occupant is
                // replaced only after its marker is cleared through the kind's
                // door. A tombstoned occupant is only re-keyed.
                if (!existingTarget.deletedAt) {
                  const governedOccupant = await lockGovernedRowsIn(tx, toMemory.id, [existingTarget.id]);
                  if (governedOccupant.length > 0) throw governedRemovalError(governedOccupant, 'mcp', 'overwrite');
                }
              }
            }

            // Move BY ID — id is stable across moves, so this refetch can't race a
            // concurrent move into the same slot.
            const moved = await tx.node.findUniqueOrThrow({
              where: { id: existing.id },
              include: {
                outgoingEdges: {
                  where: { target: { deletedAt: null } },
                  select: { id: true },
                },
                incomingEdges: {
                  where: { source: { deletedAt: null } },
                  select: { id: true },
                },
              },
            });

            // Immediate children now living under the destination loc (the moved
            // descendants plus any that were pre-staged there).
            const childCount = await tx.node.count({
              where: {
                memoryId: toMemory.id,
                loc: { startsWith: toLoc + ':' },
                deletedAt: null,
              },
            });

            return { ok: true, moved, childCount };
          },
          // A large same-memory subtree touches many rows (two updates + a revision
          // per node); the default 5s interactive-txn timeout is too tight — match
          // the GraphQL moveNode path so inputs that succeed there don't time out
          // here (mirrors extractParentNodeGraph / cloneMemory).
          { timeout });
          return { result: attemptResult, relocated, linkWarnings };
        });
        result = completed.result;
        relocated = completed.relocated;
        linkWarnings = completed.linkWarnings;
      } catch (e) {
        if (e instanceof ArchivePlanExhaustedError) return refusalResult('The node was moved concurrently; re-read it and retry.');
        if (e instanceof MemoryWriteAccessChangedDuringWriteError) return refusalResult(e.message);
        // A descendant-slot collision (or a move-into-own-subtree) aborts the
        // whole transaction — including any overwrite eviction — and surfaces as
        // a refusal, not a partial move.
        if (e instanceof SubtreeMoveCollisionError) {
          return textResult(
            `URN_ALREADY_EXISTS: A node already occupies loc "${e.loc}" in the destination memory ` +
              `(a descendant slot of this move). Free it first, then retry.`,
          );
        }
        if (e instanceof SubtreeMoveIntoSelfError) {
          return refusalResult('Cannot move a node into its own subtree.');
        }
        if (e instanceof ScopeGraphQLError && e.extensions?.code === SPEC_MINTED_PERMANENT) {
          return refusalResult(`[spec_minted_permanent] ${e.message}`);
        }
        if (e instanceof ScopeGraphQLError && e.extensions?.code === 'ROLE_GOVERNED' && e.extensions?.op === 'overwrite') {
          return refusalResult(`[role_governed] ${e.message}`);
        }
        if (e instanceof SubtreeMoveSourceChangedError) {
          return textResult('The node was moved concurrently; re-read it and retry.');
        }
        const includeText = includeRefusalText(e);
        if (includeText) return refusalResult(includeText);
        const writerRefusal = roleWriterRefusalText(e);
        if (writerRefusal) return refusalResult(writerRefusal);
        if (
          e instanceof CrossMemoryMoveUnsupportedError ||
          e instanceof SubtreeMoveSchemaViolationError
        ) {
          return textResult(e.message);
        }
        throw e;
      }

      const fromUrn = await nodeUrn(fromLoc, fromMemory.id);
      const toUrn = await nodeUrn(toLoc, toMemory.id);

      if ('refused' in result) {
        return textResult(
          `URN_ALREADY_EXISTS: A live node already occupies "${result.targetUrn}". ` +
            `Pass overwrite: true to soft-delete it first and move into its place, ` +
            `or use hadron_delete_node (hard: true) to compact it before retrying.`,
        );
      }

      const { moved, childCount } = result;

      // #1061 — a move is a write, recorded at the node's POST-move address
      // (matching the GraphQL moveNode); rebased descendants are not counted
      // individually. The PK comes from `existing` rather than `moved` because
      // the transaction's declared return shape omits it — and a move never
      // changes the PK, which is the whole point of relocating in place.
      recordNodeWrite(db, { id: existing.id, loc: toLoc, memoryId: toMemory.id }, auth);

      // #1095 — mirror the move into the affected repos (destination gains the
      // files, source loses them). Fired after the commit and NOT awaited: a
      // mirror never fails a write that already landed. Same call the GraphQL
      // moveNode resolver makes, so the two surfaces mirror identically.
      void mirrorNodeMoveToGit(db, {
        srcMemoryId: fromMemory.id,
        destMemoryId: toMemory.id,
        moved: relocated,
        clientId: auth.clientId ?? null,
      });

      // Empty sections omitted, matching hadron_get_node's pattern (PR-189
      // review feedback).
      const lines: string[] = [
        `Moved "${fromUrn}" → "${toUrn}".`,
        ``,
        `**${moved.name}**`,
        toUrn,
      ];
      if (moved.description) lines.push(`> ${moved.description}`);
      lines.push(`Type: ${moved.nodeType}`);
      if (moved.tags.length) lines.push(`Tags: ${moved.tags.join(', ')}`);
      const outgoing = moved.outgoingEdges.length;
      const incoming = moved.incomingEdges.length;
      if (outgoing + incoming > 0) {
        lines.push(`Edges: ${outgoing} outgoing, ${incoming} incoming.`);
      }
      if (childCount > 0) {
        lines.push(`Children: ${childCount} immediate descendant(s).`);
      }
      if (linkWarnings.length > 0) {
        lines.push('', `Broken content links (${linkWarnings.length}):`);
        for (const warning of linkWarnings) {
          lines.push(
            `${warning.nodeLoc}: ${warning.raw} — ` +
              (warning.status === 'MISSING'
                ? 'missing in destination'
                : warning.status === 'AMBIGUOUS'
                  ? 'ambiguous in destination'
                  : 'points to a different node in destination'),
          );
        }
      }

      return textResult(lines.join('\n'));
    },
  );

  // ── hadron_run_action ─────────────────────────────────────────────────────────

  server.tool(
    'hadron_run_action',
    'Load an action node and resolve its dependencies. Returns the action instructions with all referenced node content. The URN MUST be fully qualified (hrn:node:<root>:<memory>:<loc>). An action URN (hrn:action:<root>:<agent-slug>:<code>) is also accepted: it is a register entry\'s second address, resolved to that entry and run exactly as by its node URN, under the same read gate, so both spellings give the same outcome for every caller.',
    SHAPE_HADRON_RUN_ACTION,
    async ({ urn: rawUrn, args }) => {
      // #2718 — an action URN is a register entry's SECOND address. Resolve it
      // with the memory gates only (no `agent` arm gate: ruling (a)), then run
      // the entry through the SAME loader the node spelling uses, so the final
      // gate and the rendered bundle are one implementation. Every refusal is
      // ONE message naming nothing (cor:api:140:03): other tenant, unreadable
      // memory, unknown Agent, missing or malformed code all read alike.
      if (ACTION_REF_RE.test(rawUrn)) {
        const unreadable = () => refusalResult(`Node "${rawUrn}" not found.`);
        const entry = await resolveActionEntryRef(rawUrn, { agentGate: false });
        if (!entry) return unreadable();
        let entryUrn: string;
        try {
          entryUrn = emitNodeUrnV2(await loadMemoryUrn(entry.memoryId), entry.loc);
        } catch {
          return unreadable(); // an unemittable stored loc names no runnable address
        }
        const viaEntry = await loadNodeForRun(entryUrn);
        if ('error' in viaEntry) return unreadable();
        return textResult(await renderRunNode(viaEntry.node, viaEntry.loc, args));
      }
      // Spec 022 qualification + loading + rendering are shared with hadron_run_task
      // (cor:api:060) via loadNodeForRun / renderRunNode below.
      const loaded = await loadNodeForRun(rawUrn);
      if ('error' in loaded) return refusalResult(loaded.error);
      return textResult(await renderRunNode(loaded.node, loaded.loc, args));
    },
  );

  // ── Shared run core (hadron_run_action + hadron_run_task, spec cor:api:060) ──────────
  //
  // Loading a node for execution and rendering its run-bundle are factored out
  // so the direct-URN runner (hadron_run_action, above) and the by-name runner
  // (hadron_run_task, below) produce a byte-identical bundle and record the same
  // action-run usage event. These are hoisted function declarations, so the
  // thinned hadron_run_action handler above resolves them at call time.

  type RunNode = Prisma.NodeGetPayload<{
    include: { outgoingEdges: { include: { target: true } } };
  }>;

  // Qualify (spec 022) + read-gate the URN, then fetch the node with its
  // dependency edges. Returns the node or a user-facing error string.
  async function loadNodeForRun(
    rawUrn: string,
  ): Promise<{ node: RunNode; loc: string } | { error: string }> {
    try {
      assertFullyQualifiedUrn(rawUrn, 'node');
    } catch (e) {
      if (e instanceof UrnNotQualifiedError) return { error: e.message };
      throw e;
    }
    const { memoryUrn, loc, fragment } = splitNodeUrn(rawUrn);
    const actionFragRefusal = nodeFragmentRefusal(rawUrn, fragment);
    if (actionFragRefusal) return { error: actionFragRefusal };
    const memory = await resolveMemoryByUrn(memoryUrn);
    if (!memory || !(await canReadMemory(db, auth, memory.id))) {
      return { error: `Memory not found: "${memoryUrn}".` };
    }
    const node = await db.node.findUnique({
      where: { loc_memoryId: { loc, memoryId: memory.id } },
      // #1063 — the same edge filter the GraphQL `renderRunNode` query uses.
      // Without it a soft-deleted edge kept carrying its target, and a
      // soft-deleted NODE kept being served through any edge pointing at it —
      // so deleting a node did not stop it being read. Soft-delete is the
      // product's delete; a read surface that ignores it has not deleted
      // anything.
      include: {
        outgoingEdges: {
          where: { deletedAt: null, target: { deletedAt: null } },
          include: { target: true },
          // #2967 — run resolution order (cor:dmo:060:03): priority, loc, id.
          orderBy: edgeRunOrder(),
        },
      },
    });
    if (!node) return { error: `Node "${rawUrn}" not found.` };
    return { node, loc };
  }

  // {{arg}} substitution + inlined edge-linked node content + one action-run
  // usage event. Returns the rendered markdown bundle.
  //
  // #818: the SUBSTITUTION + INLINING is now `renderRunNodeBundle` in
  // src/lib/runNodeRender.ts, shared with the GraphQL `renderRunNode` query so
  // a preview cannot disagree with what actually executes. The `action-run`
  // UsageEvent stays HERE — it meters a tool invocation, and the read-only
  // GraphQL preview must not inflate the ledger with one.
  async function renderRunNode(
    node: RunNode,
    loc: string,
    args?: Record<string, string>,
  ): Promise<string> {
    // #1061 — collected by the renderer itself (see its `onTargetInlined`
    // note): it inlines a target only when that target HAS content, so a list
    // built from `node.outgoingEdges` here would record reads for nodes the
    // bundle never carried (PR #1062 review — Copilot).
    const inlined: unknown[] = [];
    // #1063 — per-target memory-read gate, memoized for this render on TWO
    // levels, because a bundle can span many memories and each level costs
    // something different (PR #1144 review — @codex P2):
    //
    //  - the caller's access MAP is built once and threaded through
    //    `canReadMemory`'s `access` option. Without it, every DISTINCT target
    //    memory rebuilds the caller's whole App/org access graph, so the cost
    //    is (distinct memories x access graph) on a surface with no edge cap.
    //    Built lazily, so a run node with no dependencies pays nothing.
    //  - the per-memory ANSWER is memoized, since dependencies frequently
    //    share a memory and each check is still a `Memory` row read.
    //
    // The map is only ever `getMemoryAccess(db, auth)`'s own output — the
    // option's contract is that a hand-built map is not acceptable.
    let accessMap: Promise<Map<string, string>> | undefined;
    const readable = new Map<string, Promise<boolean>>();
    const canRead = (memoryId: string): Promise<boolean> => {
      let pending = readable.get(memoryId);
      if (!pending) {
        accessMap ??= getMemoryAccess(db, auth);
        pending = accessMap.then((access) => canReadMemory(db, auth, memoryId, { access }));
        readable.set(memoryId, pending);
      }
      return pending;
    };
    const rendered = await renderRunNodeBundle(node, args, {
      memoryUrnOf: memoizedMemoryUrnLookup(),
      // The run node's OWN memory was gated by loadNodeForRun; this gates each
      // dependency separately, because an edge can cross memories (#781).
      includeTarget: (target) => canRead(target.memoryId),
      onTargetInlined: (target) => inlined.push(target),
    });
    trackUsageWrite(db, db.usageEvent
      .create({
        data: {
          id: generateId(),
          type: 'action-run',
          nodeLoc: loc,
          nodeId: node.id,
          memoryId: node.memoryId, // #796 (as in hadron_get_node's event)
          appId: auth.appId ?? null,
          // 046-usage-metering FR-001 (as in hadron_get_node's event).
          userId: auth.userId ?? null,
          createdBy: auth.clientId ?? null,
          sessionId: auth.sessionId ?? null,
          actionArgs: (args ?? undefined) as Record<string, string> | undefined,
        },
      })
      .catch(() => {}));
    // #1061 — the `action-run` event above meters an INVOCATION; it is not a
    // read, and no read/write chart counts it. But the bundle also hands back
    // the run node's content AND every dependency node inlined into it, so
    // those are reads on the same footing as any other. Recorded separately so
    // the two questions ("how often was this run?" and "how much of the graph
    // was read?") stay separately answerable.
    //
    // Since #1063 the renderer applies the same per-target read gate the
    // GraphQL preview does, so `inlined` is the readable, non-deleted subset —
    // which is what makes these events describe exactly what crossed the
    // boundary. (Before that, this recorded an honest count of a bundle that
    // should not have contained what it did.)
    recordNodeUsage(db, 'read', toUsageNodeRefs([node, ...inlined]), auth);
    return rendered;
  }

  // ── hadron_run_task name resolution (spec cor:api:060) ─────────────────────────

  type RunTaskMem = { id: string; urn: string; name: string };
  type RunTaskNode = {
    id: string;
    loc: string;
    name: string;
    alias: string | null;
    description: string | null;
  };
  type ToolText = ReturnType<typeof textResult>;
  // cor:api:060:03 tunable — max candidates to offer before asking to narrow.
  const RUN_TASK_PICK_CAP = 25;

  // Rank runnable candidates against a loose hint: case-insensitive, matching
  // name/alias/loc/description, exact > prefix > substring. Pure (cor:api:060:02
  // — substring today; a semantic name index can swap in here later).
  function rankByHint<
    T extends { name: string; alias?: string | null; loc: string; description?: string | null },
  >(items: T[], hint: string): T[] {
    const h = hint.trim().toLowerCase();
    if (!h) return [];
    const scored: Array<{ item: T; score: number }> = [];
    for (const item of items) {
      const name = item.name.toLowerCase();
      const alias = (item.alias ?? '').toLowerCase();
      const loc = item.loc.toLowerCase();
      const desc = (item.description ?? '').toLowerCase();
      let score = 0;
      if (name === h || alias === h) score = 100;
      else if (name.startsWith(h) || alias.startsWith(h) || loc === h || loc.endsWith(`:${h}`))
        score = 80;
      else if (name.includes(h) || alias.includes(h) || loc.includes(h)) score = 60;
      else if (desc.includes(h)) score = 40;
      if (score > 0) scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
    return scored.map((s) => s.item);
  }

  function clientSupportsElicitation(): boolean {
    try {
      return !!server.server.getClientCapabilities()?.elicitation;
    } catch {
      return false;
    }
  }

  // Ask the client to pick one option. Returns the chosen value, or null on
  // decline/cancel. Throws if the transport can't service the request — callers
  // fall back to the list relay (cor:api:060:03).
  async function elicitSelect(
    options: Array<{ const: string; title: string }>,
    message: string,
  ): Promise<string | null> {
    const result = await server.server.elicitInput({
      mode: 'form',
      message,
      requestedSchema: {
        type: 'object',
        properties: {
          selection: { type: 'string', title: 'Selection', oneOf: options },
        },
        required: ['selection'],
      },
    });
    if (result.action === 'accept' && typeof result.content?.selection === 'string') {
      return result.content.selection;
    }
    return null;
  }

  // The caller's readable memory set for task discovery: the App/org access map
  // PLUS the caller's own personal/private memories (which the access map
  // excludes — their owner-only gate lives in canReadMemory), so free-standing
  // personal memories stay reachable by hint (cor:api:060:02).
  async function listRunnableMemories(): Promise<RunTaskMem[]> {
    const byId = new Map<string, RunTaskMem>();
    const ids = await getAccessibleMemoryIds(db, auth);
    if (ids === null) {
      // ADMIN/OWNER "see all" — minus other users' personal/private memories
      // AND (spec 047) other users' user-owned memories (strictly owner-only).
      // Filter in the DB (not in-memory) so it leverages the userId/ownerUserId
      // indexes and mirrors the globalSearch admin carve-out (gemini review,
      // #676). The NOT/OR keeps the caller's OWN strict-owner rows in view.
      const all = await db.memory.findMany({
        where: {
          deletedAt: null,
          NOT: foreignIdentityScopedMemoryFilter(auth.userId),
        },
        select: { id: true, urn: true, name: true },
      });
      for (const m of all) byId.set(m.id, { id: m.id, urn: m.urn, name: m.name });
    } else if (ids.length > 0) {
      const mems = await db.memory.findMany({
        where: { id: { in: ids }, deletedAt: null },
        select: { id: true, urn: true, name: true },
      });
      for (const m of mems) byId.set(m.id, m);
    }
    if (auth.userId) {
      const own = await db.memory.findMany({
        where: {
          userId: auth.userId,
          class: { in: ['personal', 'private'] },
          deletedAt: null,
        },
        select: { id: true, urn: true, name: true },
      });
      for (const m of own) byId.set(m.id, m);
    }
    // The queries above deliberately over-select so their indexed predicates
    // remain cheap. Ownership is only one part of the real gate: an App-scoped
    // personal/private memory must match the selected App, and legacy rows also
    // require an installed Agent plus an active subscription. Apply that gate
    // in one batch before exposing memory or task names through discovery.
    const readableIds = await filterReadableMemoryIds(db, auth, byId.keys());
    return [...byId.values()].filter((memory) => readableIds.has(memory.id));
  }

  function loadRunnableNodes(memoryId: string): Promise<RunTaskNode[]> {
    return db.node.findMany({
      where: { memoryId, isRunnable: true, deletedAt: null },
      select: { id: true, loc: true, name: true, alias: true, description: true },
      orderBy: [{ seq: 'asc' }, { loc: 'asc' }],
    });
  }

  // Build a canonical node URN from a memory's stored URN + a node loc, so
  // loadNodeForRun → splitNodeUrn (and, in execute mode, resolveNodeRef)
  // recovers the same memory. Delegates to the shared emitNodeUrnV2 (#697
  // emission flip), which composes the flat grammar-v2 node URN from the
  // stored bare urn — accepting BOTH legacy `org:memory` (single colon) and
  // migrated `org::memory` shapes. This is the same composer the GraphQL
  // runTask path uses.
  function nodeUrnFromMem(memUrn: string, loc: string): string {
    return emitNodeUrnV2(memUrn, loc);
  }

  type RunTaskCandidate = { urn: string; label: string; description: string | null };

  /**
   * A picker entry, or `null` when the node's loc has no v2 URN.
   *
   * Dropping it is deliberate, and is NOT the same call as the read path's
   * best-effort fallback. Here the URN is an execution identity — it round-trips
   * through `splitNodeUrn`/`resolveNodeRef` to load the node — so a best-effort
   * string is worse than nothing: `splitNodeUrn` takes the first two atoms as
   * the memory, so a malformed URN can silently resolve a DIFFERENT node. A
   * candidate we cannot address is one we cannot run, so offering it would
   * present an action that must fail.
   *
   * Dropping one candidate also beats the status quo, where a single
   * un-emittable loc anywhere in the match set throws and takes down the whole
   * hadron_run_task call.
   */
  function runTaskCandidate(mem: RunTaskMem, node: RunTaskNode): RunTaskCandidate | null {
    try {
      return { urn: nodeUrnFromMem(mem.urn, node.loc), label: node.name, description: node.description };
    } catch (err) {
      console.warn(
        `[hadron_run_task] skipping candidate ${JSON.stringify(node.loc)} in memory ` +
          `"${mem.urn}" — its loc has no v2 URN, so it cannot be addressed to run:`,
        err,
      );
      return null;
    }
  }

  /**
   * Build the picker list. Returns how many entries were dropped so the caller
   * can SAY so — a silently shortened list reads as "these are all the tasks".
   */
  function buildCandidates(
    pairs: Array<{ mem: RunTaskMem; node: RunTaskNode }>,
  ): { usable: RunTaskCandidate[]; skipped: number } {
    const usable: RunTaskCandidate[] = [];
    let skipped = 0;
    for (const { mem, node } of pairs) {
      const candidate = runTaskCandidate(mem, node);
      if (candidate) usable.push(candidate);
      else skipped++;
    }
    return { usable, skipped };
  }

  /** Header suffix disclosing dropped candidates; empty when none were. */
  function skippedNote(skipped: number): string {
    if (skipped === 0) return '';
    return ` (${skipped} unaddressable task${skipped === 1 ? '' : 's'} hidden — see server logs)`;
  }

  // Present candidates and run the chosen one: an interactive single-select
  // where the client supports elicitation, otherwise a numbered list the agent
  // relays for re-invocation by `urn` (cor:api:060:03).
  async function presentAndRun(
    candidates: Array<{ urn: string; label: string; description: string | null }>,
    header: string,
    run: (nodeUrn: string) => Promise<ToolText>,
  ): Promise<ToolText> {
    if (candidates.length > RUN_TASK_PICK_CAP) {
      return textResult(
        `${header}\n\n${candidates.length} matches — too many to list. Narrow it with a more specific \`task\` or \`memory\` hint.`,
      );
    }
    if (clientSupportsElicitation()) {
      try {
        const choice = await elicitSelect(
          candidates.map((c) => ({ const: c.urn, title: c.label })),
          header,
        );
        if (choice === null) return textResult('No task selected — nothing run.');
        return run(choice);
      } catch {
        // Transport can't service the picker — fall back to the list relay.
      }
    }
    const lines = candidates.map(
      (c, i) => `${i + 1}. ${c.label}${c.description ? ` — ${c.description}` : ''}\n   urn: ${c.urn}`,
    );
    return textResult(
      `${header}\n\n${lines.join('\n')}\n\nRe-run hadron_run_task with \`urn\` set to your choice.`,
    );
  }

  // Resolve the target memory from a loose hint, the active memory, or a pick.
  async function resolveRunTaskMemory(
    hint: string,
  ): Promise<{ memory: RunTaskMem } | { done: ToolText }> {
    const mems = await listRunnableMemories();
    if (mems.length === 0) {
      return {
        done: textResult('No memories you can read. Use hadron_list_memories to see what is available.'),
      };
    }
    const asRankable = (m: RunTaskMem) => ({ ...m, alias: null, loc: m.urn, description: null });

    if (hint) {
      const matches = rankByHint(mems.map(asRankable), hint);
      if (matches.length === 1) return { memory: matches[0] };
      if (matches.length === 0) {
        return {
          done: textResult(
            `No memory matching "${hint}". Use hadron_list_memories to see what is available.`,
          ),
        };
      }
      if (clientSupportsElicitation()) {
        try {
          const choice = await elicitSelect(
            matches.map((m) => ({ const: m.urn, title: m.name })),
            `Multiple memories match "${hint}" — pick the one with your task:`,
          );
          if (choice === null) return { done: textResult('No memory selected — nothing run.') };
          const chosen = matches.find((m) => m.urn === choice);
          if (chosen) return { memory: chosen };
        } catch {
          // fall through to the list relay
        }
      }
      const lines = matches.map((m, i) => `${i + 1}. ${m.name}\n   memory: ${m.urn}`);
      return {
        done: textResult(
          `Multiple memories match "${hint}":\n\n${lines.join('\n')}\n\nRe-run hadron_run_task with \`memory\` set to one of these.`,
        ),
      };
    }

    // No memory hint — default to the session's active memory (cor:api:060:02).
    if (activeMemoryUrn) {
      const active = mems.find((m) => m.urn === activeMemoryUrn);
      if (active) return { memory: active };
    }
    if (mems.length === 1) return { memory: mems[0] };
    if (clientSupportsElicitation() && mems.length <= RUN_TASK_PICK_CAP) {
      try {
        const choice = await elicitSelect(
          mems.map((m) => ({ const: m.urn, title: m.name })),
          'Which memory holds the task you want to run?',
        );
        if (choice === null) return { done: textResult('No memory selected — nothing run.') };
        const chosen = mems.find((m) => m.urn === choice);
        if (chosen) return { memory: chosen };
      } catch {
        // fall through
      }
    }
    const names = mems.slice(0, RUN_TASK_PICK_CAP).map((m) => m.name).join(', ');
    return {
      done: textResult(
        `Pass a \`memory\` hint (or set an active memory with hadron_set_active_memory). You can reach: ${names}.` +
          // #1009: the active-memory selection is per-connection, so after a
          // transparent reconnect this refusal appears for a caller who DID set
          // one. Without this line the only reading available is "the tool
          // forgot for no reason".
          (isReconnect
            ? ' Note: this connection was re-established, which reset any active memory you had selected.'
            : ''),
      ),
    };
  }

  // Find runnable nodes matching `hint` across the caller's OTHER readable
  // memories — the conservative widening of cor:api:060:02 (never auto-runs;
  // surfaces matches for an explicit pick).
  async function searchRunnableAcross(
    hint: string,
    excludeMemoryId: string,
  ): Promise<Array<{ mem: RunTaskMem; node: RunTaskNode }>> {
    const mems = (await listRunnableMemories()).filter((m) => m.id !== excludeMemoryId);
    const memById = new Map(mems.map((m) => [m.id, m]));
    if (memById.size === 0) return [];
    const nodes = await db.node.findMany({
      where: { memoryId: { in: [...memById.keys()] }, isRunnable: true, deletedAt: null },
      select: { id: true, loc: true, name: true, alias: true, description: true, memoryId: true },
    });
    return rankByHint(nodes, hint).map((n) => ({ mem: memById.get(n.memoryId)!, node: n }));
  }

  // ── hadron_run_task ─────────────────────────────────────────────────────────────

  // ── hadron_get_run ──────────────────────────────────────────────────────────

  /**
   * #1561 — read an app run: the counterpart of hadron_run_task, which starts
   * one and replies with its id. Delegates to GraphQL `appRun(ref:)`
   * (findings:node-write-surface-invariants: MCP tools delegate, never
   * re-implement), so the gate is exactly that resolver's: a platform admin, a
   * READER in the run's organization, the run's own App key, or a user with a
   * live App relationship for a run on their behalf or a MANUAL run they
   * started (`mayReadAppRunWithoutOrgRole`). A denial reads as not found, the
   * same answer as a missing run, so the tool is no existence oracle.
   */
  server.tool(
    'hadron_get_run',
    "Read an app run you started (or may read): its status, where it is or stopped (curNodeUrn), why it failed (failure), what it extracted (data, the run envelope) and the path it walked (hops: one entry per completed hop, with the edge it took). Pass the run id or hrn:apprun URN that hadron_run_task printed. Gated like appRun: you may read a run if you are a READER in its organization; if it runs on your behalf or you started it manually, while you keep a live relationship with its App (App member or active subscriber); or if you hold that App's own key. A run you cannot read answers 'not found', the same as one that does not exist. Read-only.",
    SHAPE_HADRON_GET_RUN,
    async ({ ref }) => {
      if (!auth.userId && !auth.appId) return refusalResult('Not authenticated.');
      const runRef = typeof ref === 'string' ? ref.trim() : '';
      if (!runRef) return textResult('Pass the run id or hrn:apprun URN that hadron_run_task printed.');
      let run: Record<string, unknown> | null;
      try {
        run = (await resolvers.Query.appRun({}, { ref: runRef }, chatCtx())) as Record<string, unknown> | null;
      } catch (e) {
        // A denied read is indistinguishable from a missing run (no oracle).
        if (/^(Forbidden|Unauthenticated)/.test((e as Error)?.message ?? '')) run = null;
        else throw e;
      }
      if (!run) return refusalResult(`Run "${runRef}" not found.`);
      return textResult(renderAppRun(run));
    },
  );

  server.tool(
    'hadron_run_task',
    "Render or execute a node. By-name task discovery, resolution and listing require isRunnable=true (hrn:node:hadronmemory.com:specs:cor:api:060:01); an explicit fully-qualified `urn` skips resolution and does not require that flag. Give `task` (and optionally `memory`); the server resolves both against what you can read and runs the match. When a name is ambiguous or omitted you get a list to choose from (an interactive picker where the client supports it, otherwise a numbered list to re-invoke with `urn`). Pass a fully-qualified `urn` to skip resolution and run directly. By DEFAULT this RENDERS the task — returns the assembled instructions ({{arg}} substitution + inlined dependencies) for YOU to execute. Pass `appRef` to EXECUTE server-side instead (#529): the server mints a MANUAL app run and returns the run id to poll. Spec cor:api:060.",
    SHAPE_HADRON_RUN_TASK,
    async (rawArgs) => {
      // createTestableMcpServer bypasses zod — normalize args defensively.
      const a = (rawArgs ?? {}) as {
        task?: unknown;
        memory?: unknown;
        urn?: unknown;
        args?: unknown;
        appRef?: unknown;
        agentRef?: unknown;
        runAsSelf?: unknown;
      };
      const taskHint = typeof a.task === 'string' ? a.task.trim() : '';
      const memoryHint = typeof a.memory === 'string' ? a.memory.trim() : '';
      const directUrn = typeof a.urn === 'string' ? a.urn.trim() : '';
      const args =
        a.args && typeof a.args === 'object' && !Array.isArray(a.args)
          ? (a.args as Record<string, string>)
          : undefined;
      const appRef = typeof a.appRef === 'string' && a.appRef.trim() ? a.appRef.trim() : undefined;
      const agentRef = typeof a.agentRef === 'string' && a.agentRef.trim() ? a.agentRef.trim() : undefined;
      const runAsSelf = a.runAsSelf === true;

      // Single run chokepoint: MCP resolves the task to a concrete node URN via
      // its own fuzzy-match + interactive picker (below), then this runs it.
      // #542 — in EXECUTE mode (appRef set) delegate to the GraphQL runTask
      // resolver with the resolved `nodeRef`, which mints a MANUAL app run via
      // the spec-040 kernel and returns the run id (#529). Without appRef,
      // RENDER the assembled prompt like hadron_run_action. Both modes now share
      // MCP's resolution UX — execute mode gets the picker too.
      const runOrRender = async (nodeUrn: string): Promise<ToolText> => {
        if (!auth.clientId && !auth.appId && !auth.userId) return refusalResult('Not authenticated.');
        if (appRef) {
          const ctx: Context = {
            db,
            clientId: auth.clientId ?? undefined,
            userId: auth.userId ?? undefined,
            apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId, // #1868: the shared authorized tx re-checks the presented key
            appId: auth.appId ?? undefined,
            sessionId: auth.sessionId ?? undefined,
            roles: auth.roles as Context['roles'],
            organizationId: auth.organizationId ?? undefined,
          };
          try {
            const runId = await resolvers.Mutation.runTask(
              {},
              { nodeRef: nodeUrn, args, appRef, agentRef, runAsSelf },
              ctx,
            );
            return textResult(
              `Run started: ${runId}\nRead its status, output and path with hadron_get_run(ref: "${runId}").`,
            );
          } catch (err) {
            // #2735: the one typed refusal an agent must be able to act on by name.
            const typed = (err as { extensions?: { code?: unknown } }).extensions?.code === 'RUN_AGENT_REQUIRED' ? '[RUN_AGENT_REQUIRED] ' : '';
            return toolErrorResult(err, () => `Could not start run: ${typed}${(err as Error).message}`, 'hadron_run_task');
          }
        }
        const loaded = await loadNodeForRun(nodeUrn);
        if ('error' in loaded) return refusalResult(loaded.error);
        return textResult(await renderRunNode(loaded.node, loaded.loc, args));
      };

      // URN bypass — run directly, exactly like hadron_run_action (cor:api:060:02).
      if (directUrn) {
        return runOrRender(directUrn);
      }

      if (!auth.clientId && !auth.appId && !auth.userId) return refusalResult('Not authenticated.');

      const mem = await resolveRunTaskMemory(memoryHint);
      if ('done' in mem) return mem.done;
      const memory = mem.memory;

      const runnable = await loadRunnableNodes(memory.id);

      if (taskHint) {
        const matches = rankByHint(runnable, taskHint);
        if (matches.length === 1) {
          return runOrRender(nodeUrnFromMem(memory.urn, matches[0].loc));
        }
        if (matches.length > 1) {
          const { usable, skipped } = buildCandidates(matches.map((n) => ({ mem: memory, node: n })));
          if (usable.length === 0) {
            return textResult(
              `Tasks matching "${taskHint}" in ${memory.name} exist, but none can be addressed to run ` +
                '(their locs have no URN). See server logs.',
            );
          }
          return presentAndRun(
            usable,
            `Multiple tasks match "${taskHint}" in ${memory.name} — pick one:${skippedNote(skipped)}`,
            runOrRender,
          );
        }
        // Miss in the resolved memory — widen, but never auto-run elsewhere.
        const wide = await searchRunnableAcross(taskHint, memory.id);
        if (wide.length === 0) {
          return textResult(`No runnable task matching "${taskHint}" in ${memory.name}.`);
        }
        const wideBuilt = buildCandidates(wide.map((w) => ({ mem: w.mem, node: w.node })));
        if (wideBuilt.usable.length === 0) {
          return textResult(
            `No runnable task matching "${taskHint}" in ${memory.name}. Matches exist in other ` +
              'memories but none can be addressed to run (their locs have no URN). See server logs.',
          );
        }
        return presentAndRun(
          wideBuilt.usable,
          `No match in ${memory.name}, but "${taskHint}" matches runnable tasks in other memories — ` +
            `pick one:${skippedNote(wideBuilt.skipped)}`,
          runOrRender,
        );
      }

      // No task hint — offer the memory's runnable tasks.
      if (runnable.length === 0) return textResult(`No runnable tasks in ${memory.name}.`);
      if (runnable.length === 1) {
        return runOrRender(nodeUrnFromMem(memory.urn, runnable[0].loc));
      }
      const listed = buildCandidates(runnable.map((n) => ({ mem: memory, node: n })));
      if (listed.usable.length === 0) {
        return textResult(
          `No runnable tasks in ${memory.name} can be addressed to run (their locs have no URN). ` +
            'See server logs.',
        );
      }
      return presentAndRun(
        listed.usable,
        `Tasks in ${memory.name} — pick one to run:${skippedNote(listed.skipped)}`,
        runOrRender,
      );
    },
  );

  /**
   * Everything a worker bind does after the session exists, shared by hadron_start_session and #1956's
   * hadron_resume_session so a resumed binding is pinned, remembered and briefed exactly like a started one:
   * pin the session's App, remember the binding on this connection, and render the briefing and handoff.
   * Returns the receipt suffix. Never throws: the session is already bound, and its id is what the caller cannot
   * recover on its own.
   */
  async function bindReceipt(
    session: { id: string; appId: string | null; workerId: string | null; agentId: string | null; llmModel?: string | null },
    mcpCtx: Context,
  ): Promise<string> {
    // #1005: pin the session's App as this MCP session's active App.
    //
    // The App is settled the moment the session exists — `startSession`
    // stamps `appId` from the worker's casting when it had no App context,
    // and from the caller's scope otherwise — so every App-scoped tool
    // afterwards has an unambiguous answer. Before this, a multi-App user
    // following the documented path (start_session with workerRef → team
    // chat read/post → record_work) had to have called
    // `hadron_set_active_app` first, and the failure for not doing so was
    // DEFERRED: it surfaced on whichever later call happened to need App
    // scope, reading as a client limitation rather than a missed step.
    //
    // Gated on `auth.userId`: an App-key caller's App identity comes from
    // its credential and must never be re-pointed by a session argument.
    // A no-op when it already matches, which is the single-App case.
    //
    // BEST-EFFORT (PR #1007 review, Codex P1): this read runs AFTER
    // startSession has committed, so a transient failure here must never be
    // reported as a failed start. Falling through to the outer catch would
    // return "Error: …" and withhold the session id — and the client's
    // retry would then hit WORKER_TAKEN for the very session it was told
    // had failed, unable to either continue or end it. Same reasoning, and
    // the same remedy, as the briefing block below (PR #996 review). A
    // missed pin costs one hadron_set_active_app; a withheld id is
    // unrecoverable.
    if (auth.userId && session.appId && session.appId !== auth.appId) {
      try {
        const boundApp = await db.app.findUnique({
          where: { id: session.appId },
          select: { id: true, organizationId: true },
        });
        if (boundApp) pinActiveApp(boundApp.id, boundApp.organizationId, 'worker_bind');
      } catch {
        // Swallowed deliberately — the session IS started and bound.
      }
    }

    // DAC: bind this MCP connection to the new session, so every later
    // write on it is attributed to its Worker / Agent (#1610). Only a
    // session with someone behind it; plain sessions attribute nothing.
    //
    // #1701: the binding is APPENDED to the connection's list, never
    // swapped in for the previous one — a host may be multiplexing
    // several chat sessions over this one connection, and the previous
    // binder may be another of them, still at work. When that leaves the
    // connection bound to more than one actor, the receipt says so, since
    // it is the one moment the caller is certain to read.
    //
    // A PLAIN session (no worker, no agent) is appended too, as a binding
    // whose actor is nobody (#1702 QA, Cody P2). It used to REPLACE the
    // connection's bindings (#1665 review), which on a shared connection
    // let one chat session silently strip every other chat session's
    // worker: their unnamed writes then landed as the human alone. A
    // plain start does still stop a previous worker's credit, as #1665
    // wanted, but by making the connection ambiguous, so the next
    // unnamed write is refused rather than quietly re-attributed.
    let sharedConnectionNote = '';
    {
      const sid = getSessionId();
      if (sid) {
        rememberConnectionBinding(sid, session.id, { workerId: session.workerId ?? null, agentId: session.agentId ?? null });
        sharedConnectionNote = await sharedConnectionWarning(sid, session.id);
      }
    }

    // #990: when a worker is bound, ALWAYS return its resolved boot
    // briefing. Binding IS briefing — an MCP host has no discovery surface
    // to go looking for the prompt afterwards, and nothing routes it to one
    // (hadron_server_info returns deployment identity only). Returning it
    // live also removes the reason to publish briefing NODES into the Team
    // Agent's memory (hadron-cli#443): those are copies of the briefing
    // that nothing recomputes, so they go stale silently the moment a role
    // agent's prompt changes.
    //
    // Resolved through the SAME field resolver GraphQL serves
    // (Worker.prompt), so the two surfaces cannot drift — and that resolver
    // self-guards behind the worker read gate, so this cannot widen access.
    //
    // SELF-CONTAINED failure handling (PR #996 review, Codex P2): these are
    // reads that run AFTER startSession has already committed the session,
    // so a transient failure here must never be reported as a failed start.
    // It used to fall through to the outer catch, which returned "Error: …"
    // and withheld the id — and the client's retry would then hit
    // WORKER_TAKEN for the very session it was told had failed, unable to
    // either continue or end it. The session id is the thing the caller
    // cannot recover on its own; the briefing it can ask for again.
    let workerLine = '';
    if (session.workerId) {
      try {
        const worker = await db.worker.findUnique({ where: { id: session.workerId } });
        // #1090: the composition itself carries the freshness facts, so
        // the stamps describe the text printed below (one agent read — no
        // parallel lookup that could race a template edit).
        const briefing = worker
          ? await composeWorkerPrompt({ ...mcpCtx, sessionId: session.id }, worker, { llmModel: session.llmModel }) // the session being returned, so its record (not the current approval) is read
          : { text: null as string | null, renderedAt: null as Date | null, roleAgentUpdatedAt: null as Date | null };
        const prompt = briefing.text;
        // #1029: the previous stint's handoff, delivered with the briefing
        // rather than left to be discovered. A fresh session does not know
        // there is anything to look for, so a design that requires it to go
        // looking fails — binding is briefing, so binding is handoff. The
        // session just created is still open and so is never its own
        // "previous" (Worker.continuity keys on ENDED sessions).
        const continuity = worker
          ? await resolvers.Worker.continuity(worker, {}, mcpCtx)
          : null;
        // #1026 — the bind is where a worker FIRST needs its own identity,
        // and it printed neither the URN nor a link. #1008 asks every
        // worker to sign what it publishes with a hyperlinked URN, so the
        // briefing had to send it to hadron_get_worker for a string the
        // bind already had in hand. Emitting both here removes that round
        // trip at exactly the moment the need arises, and removes the
        // reason the prompts carve out an exception to "never hand-build a
        // portal link".
        const boundUrn = worker
          ? ((await resolvers.Worker.urn(worker, {}, mcpCtx)) as string | null)
          : null;
        const boundUrl = workerPortalUrl(boundUrn);
        workerLine =
          `\nWorking as ${worker?.name ?? 'worker'} (worker id: ${session.workerId}).` +
          (boundUrn ? `\n${boundUrn}` : '') +
          (boundUrl ? `\nURL: ${boundUrl}` : '') +
          // A worker with no servable prompt has no briefing — say so, rather
          // than emitting a bare heading.
          (prompt
            ? `\n\nBoot briefing — adopt this for the rest of the session:` +
              `\nrendered at: ${briefing.renderedAt!.toISOString()}` +
              `\nrole Agent updated at: ${briefing.roleAgentUpdatedAt ? briefing.roleAgentUpdatedAt.toISOString() : 'not recorded'} (generic Agent row update)` +
              `\n\n${prompt}`
            : '\n\n(No boot briefing: no boot prompt is served to this worker.)') +
          renderWorkerContinuity(continuity as RenderableContinuity | null);
      } catch {
        workerLine =
          `\nWorking as worker (worker id: ${session.workerId}).` +
          '\n\n(The boot briefing could not be rendered just now — the session IS started and bound. Retry with hadron_get_node on the role agent, or start again after ending this session; do NOT retry hadron_start_session, which would refuse WORKER_TAKEN.)';
      }
    }
    // #1599: the session argument is never the adjacent worker identity.
    const sessionLabel = session.workerId ? 'Worker session id' : 'Session id';
    return `${sharedConnectionNote}\n${sessionLabel}: ${session.id} (pass as \`session\` to team tools)${workerLine}`;
  }

  // ── hadron_start_session ──────────────────────────────────────────────────────

  server.tool(
    'hadron_start_session',
    'Start a session — and when workerRef is passed, a WORKER SESSION: the binding that makes work attributable to that named teammate. Two different things are called a session: the WORKER SESSION is this binding, held server-side; your CHAT SESSION is the conversation you are in — the Claude Desktop window, the Claude Code session, the IDE chat. ENDING YOUR CHAT SESSION DOES NOT END A WORKER SESSION (#1034): closing, archiving or losing the conversation leaves this binding open until hadron_end_session. Since #1114 the reaper no longer ends a session for inactivity — silence is not evidence of abandonment. What DOES change while it sits idle is how it is DESCRIBED: liveness is derived from recent driving, so a session that remains untouched past its idle window reads as not-live and stops blocking a bind, WITHOUT being ended and with its handoff still unwritten rather than lost. That changes no HOLD: a human-held name stays held until explicit release, so only its holder can bind it again. All subsequent tool calls can reference this session ID for attribution. A worker or agent session also BINDS THIS MCP CONNECTION (DAC): every later node write on it records that Worker / Agent as its author beside you (Node.createdByWorker / updatedByWorker), checked afresh on each call, so ending the session stops it at once; a reconnect starts unbound until you start or name a session again. A host may carry SEVERAL chat sessions over one connection (#1701): binding a second worker there (or starting a plain session) does not displace the first, and once more than one worker has been bound on the connection (a plain session counting as a binding to no worker), even one after another, the server cannot tell which chat session is calling, so every writing tool takes an optional `session` argument — pass the id this call returned on each write, or the write is refused SESSION_AMBIGUOUS rather than credited to the wrong worker. The receipt warns you when this bind made the connection shared. Starting a session PINS its App as this session\'s active App, so no hadron_set_active_app is needed afterwards; if the MCP connection is later re-established (which happens transparently), pass the session id back to the team tools to restore that App context. Pass workerRef — the worker\'s NAME ("Iris", resolved within the active App when selected), its id, or its URN (hrn:worker:<root>:<app-slug>:<slug>) — to work AS that named casting, which is required for worker-attributed team chat posts and worklog records. An id or URN workerRef names its own App, so it needs no App selected first; with no App selected, a bare NAME searches only Apps you may bind into: one non-retired match binds, several are listed with App, role and holder and nothing binds. Choose an id or URN to disambiguate; a selected App is never bypassed. On success the worker\'s resolved BOOT BRIEFING comes back with the session: adopt it for the rest of this stint, and never cache or copy it — it is rendered live from the role agent\'s prompt template, so a copy goes stale silently. Binding a worker someone is actively DRIVING refuses WORKER_TAKEN (#1114: an OPEN session is not necessarily a live one — a session whose most recent activity is outside its idle window is not being driven, so that session does not refuse) with who last drove it and when (informed takeover, cor:agt:020:03) — note an open worker session does not by itself mean someone is at the keyboard, since it outlives the chat session that started it; retry with force: true ONLY after surfacing that to the user and getting an explicit override. Binding a worker ENDS your own other open sessions on that same worker (#1617), the lapsed ones and any a force displaces: they are marked "superseded by session <new id>" and end WITHOUT a handoff, so write the handoff with hadron_end_session first if one is owed. Do not bind a second session to recover from a context compaction; recover the existing one with hadron_whoami. A LAPSED session of yours does not need a rebind at all: if you hold the name and nobody else is driving the worker, your next team-chat post, read or mark-read through it resumes it.',
    SHAPE_HADRON_START_SESSION,
    async ({ description, type, repo, branch, prNumber, customerId, language, llmModel, family, parentSessionId, prevSessionId, workerRef, reportsTo, force, launchGrant }) => {
      // Spec 026 / D-2026-05-21-003 strict tool: session-start needs App
      // context to attribute the session. Errors with typed [no_active_app]
      // envelope for multi-App OAuth callers without selection.
      //
      // #1005: EXCEPT when the workerRef is self-describing. A worker id or an
      // `hrn:worker:<root>:<app-slug>:<slug>` URN names exactly one worker, and
      // a worker belongs to exactly one App — so the App is already known, and
      // demanding a prior `hadron_set_active_app` asks the caller to state
      // something the argument settles. `startSession` already derives the App
      // from the worker when it has no App context, behind the same participant
      // predicate the appRef path runs, so this widens nothing: it lets the
      // resolver's existing branch be reached instead of erroring above it.
      //
      // #1597: any nonblank worker ref delegates to the shared resolver. A
      // bare name without an App is resolved there across bind-authorized Apps;
      // id/URN forms retain their own shape dispatch. Plain sessions still need
      // the existing App-selection behavior.
      restoreSelectedApp();
      if (!workerRef?.trim() && !launchGrant) {
        const appScopeError = requireAppScope();
        if (appScopeError) return appScopeError;
      }

      // #940: delegate to the GraphQL resolver (findings:node-write-surface-
      // invariants — MCP tools delegate, never re-implement), so the worker
      // binding runs the ONE gated path: App-membership checks, WORKER_RETIRED,
      // SESSION_WORKER_NOT_IN_APP, and the WORKER_TAKEN informed-takeover
      // refusal (cor:agt:020:03) are all the server's, and this surface can
      // never drift from the GraphQL one. The direct db.session.create this
      // replaces predated the worker model; the resolver stamps the same
      // appId/userId attribution (#931) from the same ctx fields.
      // Hoisted so the briefing lookup below resolves Worker.prompt under the
      // SAME principal that started the session — the prompt is gated, and
      // re-deriving a context risks the two diverging.
      const mcpCtx: Context = {
        db,
        clientId: auth.clientId ?? undefined,
        userId: auth.userId ?? undefined,
        apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId, // #1868: the shared authorized tx re-checks the presented key
        appId: auth.appId ?? undefined,
        sessionId: auth.sessionId ?? undefined,
        roles: auth.roles as Context['roles'],
        organizationId: auth.organizationId ?? undefined,
      };
      try {
        const session = await resolvers.Mutation.startSession(
          {},
          {
            input: {
              id: generateId(),
              type: type ?? undefined,
              plan: description,
              repo: repo ?? undefined,
              branch: branch ?? undefined,
              prNumber: prNumber ?? undefined,
              customerId: customerId ?? undefined,
              language: language ?? undefined,
              llmModel: llmModel ?? undefined,
              family: family ?? undefined,
              parentSessionId: parentSessionId ?? undefined,
              prevSessionId: prevSessionId ?? undefined,
              workerRef: workerRef ?? undefined,
              reportsTo: reportsTo ?? undefined,
              force: force ?? undefined,
              launchGrant: launchGrant ?? undefined,
            },
          },
          mcpCtx,
        );

        const receipt = await bindReceipt(session, mcpCtx);
        return textResult(`Session started: ${session.id}\n> ${description}${receipt}`);
      } catch (e) {
        return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : 'session start failed'}`, 'hadron_start_session');
      }
    },
  );

  // ── #1956: resume claims ──────────────────────────────────────────────────────

  server.tool(
    'hadron_create_resume_claim',
    '#1956 (cor:agt:020:03): before a deliberate context reset that KEEPS your worker session open (a shed, a /clear), write a resume claim so the fresh context recovers this worker with hadron_resume_session and no arguments — no binding file, no worker name to remember. The claim is single use, lives 60 seconds from this call, and is redeemable only by you (judged by your credential; it has no id to copy). Write it as the LAST step before the reset, after your handoff or shed note. For a rotation that ENDS the session, pass resumeClaim: true to hadron_end_session instead.',
    SHAPE_HADRON_CREATE_RESUME_CLAIM,
    async ({ session }) => {
      const mcpCtx: Context = {
        db,
        clientId: auth.clientId ?? undefined,
        userId: auth.userId ?? undefined,
        apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId,
        appId: auth.appId ?? undefined,
        sessionId: auth.sessionId ?? undefined,
        roles: auth.roles as Context['roles'],
        organizationId: auth.organizationId ?? undefined,
        impersonation: auth.impersonation ?? undefined,
      } as Context;
      try {
        const r = await resolvers.Mutation.createResumeClaim({}, { sessionId: session }, mcpCtx);
        return textResult(
          `Resume claim written for session ${r.sessionId}. After the reset, call hadron_resume_session with no arguments ` +
            `before ${r.expiresAt.toISOString()} (60 seconds, once). Only you can redeem it.`,
        );
      } catch (e) {
        const code = e instanceof ScopeGraphQLError ? String(e.extensions?.code ?? '') : '';
        return toolErrorResult(e, () => `Error${code ? ` [${code}]` : ''}: ${e instanceof Error ? e.message : 'the claim could not be written'}`, 'hadron_create_resume_claim');
      }
    },
  );

  server.tool(
    'hadron_resume_session',
    '#1956 (cor:agt:020:03): recover your worker binding after a context reset — call this FIRST, with no arguments, when you do not know which worker session you are. One unused resume claim of yours binds it and returns the boot briefing and handoff, exactly as hadron_start_session would: the same open session after a shed, or the worker\'s next session after a rotation that ended the last one. Several claims are LISTED (worker name, description, session id) and nothing is bound: ask the human which, then call again with session. With no claim, if exactly one of your worker sessions is live it is resumed; several are listed, never guessed. Nothing to resume refuses NOTHING_TO_RESUME and binds nothing — then ask the human which worker you are and use hadron_start_session. A claim never overrides the worker\'s current state: if the name moved, you lost the App, or another session of the worker is live, it refuses RESUME_REFUSED. This never posts or records anything as you or anyone else.',
    SHAPE_HADRON_RESUME_SESSION,
    async ({ session, description, llmModel, family }) => {
      const mcpCtx: Context = {
        db,
        clientId: auth.clientId ?? undefined,
        userId: auth.userId ?? undefined,
        apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId,
        appId: auth.appId ?? undefined,
        sessionId: auth.sessionId ?? undefined,
        roles: auth.roles as Context['roles'],
        organizationId: auth.organizationId ?? undefined,
        impersonation: auth.impersonation ?? undefined,
      } as Context;
      let r: Awaited<ReturnType<typeof resolvers.Mutation.resumeSession>>;
      try {
        r = await resolvers.Mutation.resumeSession(
          {},
          { input: { session: session ?? null, description: description ?? null, llmModel: llmModel ?? null, family: family ?? null, tool: 'mcp' } },
          mcpCtx,
        );
      } catch (e) {
        const code = e instanceof ScopeGraphQLError ? String(e.extensions?.code ?? '') : '';
        return toolErrorResult(e, () => `Error${code ? ` [${code}]` : ''}: ${e instanceof Error ? e.message : 'resume failed'}`, 'hadron_resume_session');
      }
      if (r.outcome === 'CHOOSE') {
        const lines = (r.candidates as ResumeCandidate[]).map(
          (c) =>
            `- ${c.workerName}: session ${c.sessionId}${c.description ? ` — ${c.description}` : ''}` +
            (c.source === 'CLAIM' ? ` (resume claim, until ${c.expiresAt?.toISOString()})` : ' (live session)'),
        );
        return textResult(
          `Several workers could be yours, so nothing was bound. Ask the human which one you are, then call ` +
            `hadron_resume_session with session set to its id:\n${lines.join('\n')}`,
        );
      }
      const bound = r.session!;
      const receipt = await bindReceipt(bound, mcpCtx);
      return textResult(
        `${r.outcome === 'STARTED' ? 'Session started' : 'Session resumed'}: ${bound.id}` +
          (bound.plan ? `\n> ${bound.plan}` : '') +
          receipt,
      );
    },
  );

  // ── hadron_end_session ────────────────────────────────────────────────────────

  server.tool(
    'hadron_end_session',
    'End a session, and for a worker-bound one write its closing HANDOFF (#1029) — the record the next stint of this worker inherits automatically at bind. This is the CLIENT operation that ends a WORKER SESSION. The reaper can also end a session whose non-null hard expiry passes, but hadron_start_session does not set one: its worker sessions remain OPEN until this tool is called. Ending your CHAT SESSION does not end a worker session (#1034). It ends the SESSION, not any HOLD: if a person bound the worker, the name stays theirs until released (#1050) and only they can bind it again. An App-key BIND takes no hold — a fact about the bind, not a promise about the worker afterwards, since an eligible user may have forced a binding meanwhile and taken the name. Archiving the Desktop window, closing the Claude Code session, or losing the conversation any other way leaves this binding open server-side until you call this tool. While open and recently active inside its idle window, it reads LIVE and adds the WORKER_TAKEN bind block. After the idle window, that session block falls away; any human HOLD remains independent until explicit release. Call this tool deliberately when you stop working, not when the window closes — by then it is too late to write a handoff, because the context that would compose one has gone. Pass `handoff` whenever you are stopping deliberately: what landed, what is open, what is blocked, what the next driver should not repeat. Route rather than restate — point at the live artifacts instead of summarizing them, since a restatement drifts while a pointer does not. The server owns where it goes; you supply the prose. A failed handoff write REFUSES the end and leaves the session open, so retrying is safe; ending with no handoff is a deliberate choice, and the next driver is told the stint ended without one.',
    SHAPE_HADRON_END_SESSION,
    async ({ id, summary, handoff, resumeClaim, inputTokens, outputTokens, turnCount, errorCount }) => {
      // Spec 026 / D-2026-05-21-003 strict tool: paired with hadron_start_session.
      //
      // #1009: `id` IS the session, so scope is recoverable here with no new
      // argument at all. This is the tool the gap stranded most sharply — after
      // a reconnect a multi-App caller could neither continue the session nor
      // END it, leaving the worker session open and blocking another bind while
      // it still read live.
      await adoptAppFromSession(id);
      const appScopeError = requireAppScope();
      if (appScopeError) return appScopeError;

      const session = await db.session.findUnique({ where: { id } });
      if (!session) return refusalResult(`Session "${id}" not found.`);
      // #931: same write gate as the GraphQL endSession — previously this raw
      // update was ungated, so any App-scoped caller holding a session id
      // could end another App's (or user's) session. Allowed: a PURE App-key
      // principal for its own App's sessions, or the authenticated user the
      // session is attributed to. The App branch requires the ABSENCE of a
      // userId (#932 Codex P1): for OAuth/user callers requireAppScope()
      // fills auth.appId from the user's active-App SELECTION, and that must
      // not let co-members of an App end each other's sessions.
      // #1934 (cor:agt:070:04): the App branch is the SHARED predicate the
      // GraphQL gate uses — an App key ends only user-less sessions (#11860),
      // never a host-launched one, and a key that ever held host:operate ends
      // none — so the two cannot drift again.
      const mayEnd = auth.userId
        ? session.userId === auth.userId
        : await appPrincipalSessionWriteAllowed(db, auth, session); // #1969: a host key's refusal is recorded
      if (!mayEnd) {
        return refusalResult(`Forbidden: session "${id}" belongs to a different App or user.`);
      }

      // #1956: a resume claim needs the caller's own open worker session. Judged BEFORE the handoff is written, so a
      // refused claim leaves the session open with no handoff behind it; the claim is written after the handoff.
      const claimRefused =
        !!resumeClaim &&
        (!auth.userId || !!auth.impersonation || session.userId !== auth.userId || !session.workerId || !session.appId || !!session.endedAt || !!session.deletedAt);
      if (claimRefused) {
        return textResult(
          `No resume claim was written, so the session is STILL OPEN and was not ended: a claim needs your own open worker session. ` +
            'End it without resumeClaim, or start the next stint by naming the worker.',
        );
      }

      // #1029: the handoff goes through the SAME writer the GraphQL endSession
      // uses, so the loc convention, the parent bootstrap and the session
      // stamping cannot drift between the two surfaces. This tool does its own
      // raw update rather than delegating to that resolver, which is exactly
      // how two surfaces come apart — sharing the writer is what stops it here.
      //
      // Ordering is the safety property: written BEFORE the end, so a failure
      // leaves the session open and retryable. Ending first and losing the
      // prose is unrecoverable — the context that composed it ends with the
      // stint.
      const handoffBody = handoff?.trim();
      if (handoffBody) {
        if (!session.workerId) {
          return textResult(
            `Session "${id}" is not bound to a worker, so there is no continuity sequence to write a handoff to. ` +
              'End it without one, or bind a worker next time.',
          );
        }
        const mcpCtx: Context = {
          db,
          clientId: auth.clientId ?? undefined,
          userId: auth.userId ?? undefined,
          apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId, // #1868: the shared authorized tx re-checks the presented key
          appId: auth.appId ?? undefined,
          sessionId: auth.sessionId ?? undefined,
          roles: auth.roles as Context['roles'],
          organizationId: auth.organizationId ?? undefined,
        };
        try {
          await writeSessionHandoff(mcpCtx, session.id, session.workerId, handoffBody);
        } catch (e) {
          // The session-still-open guidance stays; the Cause is shown only for a typed refusal, never a fault's detail (#1789).
          const failure = toolErrorResult(e, () => e instanceof Error ? e.message : 'unknown', 'hadron_end_session:handoff');
          return {
            ...failure,
            content: [{ type: 'text' as const, text:
              `The handoff could not be written, so the session is STILL OPEN and was not ended — retry, or end without a handoff. ` +
              `Cause: ${failure.content[0].text}` }],
          };
        }
      }

      // #1956: the resume claim, after the handoff and before the end, through the same writer as the GraphQL
      // endSession. Eligibility was judged above, before the handoff.
      let claimNote = '';
      if (resumeClaim && auth.userId && session.workerId && session.appId) {
        const { expiresAt } = await writeResumeClaim(db, { sessionId: id, appId: session.appId, workerId: session.workerId, holderUserId: auth.userId });
        claimNote = `\nResume claim written: the next context recovers this worker with hadron_resume_session (no arguments) until ${expiresAt.toISOString()} (60 seconds, once).`;
      }

      // FIRST END WINS, through the SHARED writer the GraphQL resolver uses
      // (#1050, hardened by PR #1055 review). Two reasons it is shared rather
      // than reimplemented here: this tool having its own raw update is exactly
      // how the guard ended up on one surface last time, and the decision
      // cannot be made from the row read above — the reaper claims sessions
      // with its own atomic update, so between that read and this write a
      // session can go from live to reaped. Deciding from the stale read would
      // report a clean end for a session the server had already expired AND
      // overwrite the reaper's endedAt while leaving autoExpiredAt set.
      const closed = await endSessionFirstWins(db as unknown as Context['db'], id, {
        summary: summary ?? null,
        inputTokens: inputTokens ?? null,
        outputTokens: outputTokens ?? null,
        turnCount: turnCount ?? null,
        errorCount: errorCount ?? null,
      });

      // #1053: an ALREADY-ended session must not read as a fresh close —
      // otherwise the receipt is a second false liveness signal, in the tool
      // the guidance names as the loud one.
      return textResult(
        (!closed.endedByThisCall
          ? `Session ${id} had ALREADY ended${closed.endedAt ? ` at ${closed.endedAt.toISOString()}` : ''}` +
            ` (end reason: ${closed.endReason}).` +
            ' Metrics were updated; the original end time stands. You were not bound when you' +
            ' made this call — hadron_whoami lists what you are actually driving.'
          : // #1034: name the KIND of session that just ended. This receipt is
            // the last thing a driver reads before closing the window, and the
            // failure it is placed against is the reverse order — closing the
            // window and assuming this happened.
            `${session.workerId ? 'Worker session' : 'Session'} ended: ${id} (end reason: ${closed.endReason})`) +
          (handoffBody
            ? '\nHandoff written — the next worker session bound to this worker receives it automatically.'
            : session.workerId && closed.endedByThisCall
              ? // #1100: a worker-bound end with `summary` set and `handoff`
                // absent is almost certainly the mistake this receipt exists to
                // catch — the caller wrote a closing note into a field no
                // continuity path reads.
                //
                // Said HERE because it is the last moment the prose still
                // EXISTS. This stint can no longer take a handoff (the sequence
                // is append-only and the session has ended, so re-ending is
                // refused — pinned by a test), but the caller can still bind
                // again and end THAT session with it. Once the context goes,
                // nothing can reconstruct it.
                //
                // My first draft of this told the caller to re-end the same
                // session; the test written to pin that advice is what proved
                // it refused (PR #1135). A remedy in a message is a promise —
                // it needs a test like any other.
                //
                // Distinguished from an ordinary no-handoff end, which is a
                // legitimate choice and keeps its quieter wording.
                summary?.trim()
                ? '\n⚠ No handoff written, but a `summary` was supplied — and `summary` is display-only.' +
                  '\n  The next driver of this worker will receive NOTHING.' +
                  '\n  This stint can no longer take one: the handoff sequence is append-only and this' +
                  '\n  session has ended, so re-ending it is refused. If that prose was meant for whoever' +
                  '\n  comes next, bind the worker again and end THAT session with `handoff` — while you' +
                  '\n  still have the prose. See #1100.'
                : '\n(No handoff written. The next driver will be told this stint ended without one.)'
              : '') +
          claimNote,
      );
    },
  );

  // ── hadron_whoami ─────────────────────────────────────────────────────────────

  server.tool(
    'hadron_whoami',
    'Answer "what am I driving right now?" — your own OPEN sessions. Optional app and workerRef filters narrow the complete authorized set before paging; omit both for the existing view. Every successful answer opens with an `active memory:` line naming the memory selected on this connection, or `none` when none is set or it is no longer readable (#2515); it describes the connection, not any session row, and is not a guarantee of where a write lands. Each session shows its App, when it started, and the worker it is bound to IF it is bound (#1016). Not every row is a worker session: a session started without workerRef is listed too and says "working as: nobody", which is the shape in which work goes unattributed, so it is shown rather than hidden. This is also the tool that tells you a WORKER SESSION outlived the CHAT SESSION it was started from: the two are independent, and ending a chat session never ends a worker session (#1034), so a bound row here may well be one whose Desktop window or Claude Code session is long gone. For a BOUND row, its session id is the only handle that makes that work attributable, and nothing on the wire carries it: there is no worktree file to read it back from, so a host that loses it to a context compaction loses attribution with it. The chat tools no longer hide the loss: since #1967, hadron_team_chat_post (like hadron_channel_post) refuses a post that names no session on a connection with no bound worker [authorship_required] instead of recording it under the human\'s name, so a lost id surfaces as that refusal — come here for the id. Do NOT read a successful call as evidence your binding is alive: hadron_record_work accepts an ended session on purpose (late attribution, cor:agt:020:05) and hadron_end_session is idempotent, so neither refuses one — both now SAY so in their receipt instead. The team chat is the only surface that refuses outright, because authoring as a worker needs a live session. This tool is the direct answer, and the one to trust. Call this whenever you are unsure which session you are driving, or after any context loss, and pass back a row that is BOUND and still OPEN — with includeEnded this list also returns bound rows marked [ENDED], and team chat refuses an unbound row (SESSION_NOT_WORKER_BOUND) and an ended one (SESSION_ENDED) rather than silently attributing either. Read-only, and scoped to sessions you started — it is not a presence board for the team (use hadron_list_workers to see who is taken).',
    SHAPE_HADRON_WHOAMI,
    async ({ limit, includeEnded, app, workerRef }) => {
      // Scoped by IDENTITY, deliberately narrower than the GraphQL `sessions`
      // query's `sessionScopeFilter` — which also admits any org member, and so
      // answers "sessions I may READ" rather than "sessions I am DRIVING". The
      // question here is the latter, and the answer must not turn into a roster
      // of colleagues' activity. Two principal shapes have an honest answer:
      //
      //   - a USER caller owns the sessions attributed to them (`userId`), which
      //     is the same self branch sessionScopeFilter and hadron_end_session's
      //     write gate use; and
      //   - a PURE App-key caller (no userId) owns its App's sessions — again
      //     exactly what hadron_end_session already lets it end.
      //
      // A hybrid user+App-selection principal is judged on the USER, never the
      // selection: an active-App choice must not turn co-members' sessions into
      // "mine" (the #932 Codex P1 rule that hadron_end_session encodes).
      //
      // Impersonation is a read-only support view of someone else's work, so
      // "what am I driving" has no meaning there — and answering with the
      // target's sessions would hand a support session the ids needed to post
      // as their workers. Refused outright. Belt and braces: /mcp already
      // rejects an impersonation JWT at session init, so this is unreachable
      // today — it is here so the identity scoping stays self-sufficient rather
      // than depending on a gate two layers up (the #876 sweep's lesson:
      // ctx.userId = target fails OPEN against identity-keyed predicates, and
      // `{ userId: auth.userId }` below is exactly such a predicate).
      if (auth.impersonation) {
        return textResult(
          'Not available in an impersonation session — this answers what YOU are driving, and a support view drives nothing.',
        );
      }
      const scope = auth.userId
        ? { userId: auth.userId }
        : auth.appId
          ? { appId: auth.appId, userId: null }
          : null;
      if (!scope) return refusalResult('Not authenticated — no sessions to report.');

      // createTestableMcpServer bypasses zod — normalize defensively (a NaN
      // would reach Prisma's `take` as a raw driver error rather than a clamp).
      const take = Math.max(1, Math.min(typeof limit === 'number' && Number.isFinite(limit) ? limit : 10, 50));
      // #1133 — the count runs under the IDENTICAL where as the rows (one
      // object, used by both queries), so the truncation disclosure cannot
      // leak a session count the caller may not read: whatever scopes the
      // rows scopes the total, by construction rather than by re-statement.
      const authorizedWhere = {
        AND: [scope, boundSessionPrivacyFilter(auth)],
        deletedAt: null,
        // "Open" is `endedAt IS NULL` — the ONE active predicate the platform
        // uses everywhere (#930: the reaper stamps endedAt AND autoExpiredAt
        // together precisely so this stays a single test).
        ...(includeEnded ? {} : { endedAt: null }),
      };
      // Both reads share ONE repeatable-read snapshot (Codex P2 + Copilot on
      // the first head): as independent READ COMMITTED statements they could
      // straddle a concurrent hadron_start_session — count sees 10, the insert
      // lands, findMany then returns a DIFFERENT 10 that quietly drops the
      // oldest while total === length reports "not truncated". That is the
      // absence-as-reaped ambiguity this tool exists to kill, reopened in a
      // race window; one snapshot closes it.
      const [sessions, total, selectionProblem] = await db.$transaction(
        async (tx) => {
          const selection = await whoamiSessionFilter(tx, authorizedWhere, { app, workerRef });
          if (selection.kind !== 'matched') return [[], 0, selection.kind] as const;
          const where = selection.where;
          const rows = await tx.session.findMany({
            where,
            orderBy: { startedAt: 'desc' },
            take,
            select: {
              id: true, startedAt: true, endedAt: true, endReason: true, type: true, plan: true,
              appId: true, workerId: true,
              // #1617: the liveness inputs, so each open row can say whether it
              // is live and when it lapses — before a post is refused, not after.
              updatedAt: true, autoExpiredAt: true, expiresAt: true,
            },
          });
          const count = await tx.session.count({ where });
          return [rows, count, null] as const;
        },
        { isolationLevel: 'RepeatableRead' },
      );
      if (selectionProblem === 'ambiguous') {
        return { ...textResult('[ambiguous_ref] More than one match among your sessions. Specify an App or use an exact App/Worker ID or URN.'), isError: true as const };
      }
      // #2515 — this connection's active-memory selection, re-authorized now
      // through the same read gate hadron_set_active_memory uses. Read-only: a
      // gone or unreadable selection answers `none` and is neither cleared nor
      // replaced. A genuine infrastructure error propagates as a tool failure.
      const activeMemoryLine = await (async () => {
        const mem = activeMemoryUrn ? await resolveVisibleMemoryByUrn(auth, activeMemoryUrn, 'read') : null;
        if (!mem) return 'active memory: none\n';
        const named = await db.memory.findUnique({ where: { id: mem.id }, select: { name: true } });
        return `active memory: ${safeEmitEntityUrnV2('memory', mem.urn)}${named?.name ? ` (${named.name})` : ''}\n`;
      })();
      if (sessions.length === 0 && (app !== undefined || workerRef !== undefined)) {
        return textResult(`${activeMemoryLine}No matching session.`);
      }
      if (sessions.length === 0) {
        return textResult(
          activeMemoryLine +
          (includeEnded
            ? 'You have no sessions. Start one with hadron_start_session(description: "<task>", workerRef: "<name>") to work as a teammate.'
            : 'You have no open sessions. Start one with hadron_start_session(description: "<task>", workerRef: "<name>"); pass includeEnded to see recent ended ones.'),
        );
      }

      // Resolve each distinct worker and App ONCE — a caller with several open
      // sessions on one App would otherwise repeat identical lookups.
      const workerRows = new Map(
        (
          await db.worker.findMany({
            where: { id: { in: [...new Set(sessions.map((s) => s.workerId).filter((w): w is string => !!w))] } },
            select: { id: true, name: true, slug: true, role: true, appId: true },
          })
        ).map((w) => [w.id, w]),
      );
      const appRows = new Map(
        (
          await db.app.findMany({
            where: { id: { in: [...new Set(sessions.map((s) => s.appId).filter((a): a is string => !!a))] } },
            select: { id: true, name: true, urn: true },
          })
        ).map((a) => [a.id, a]),
      );

      // Spec 049 Phase 6: the register per BOUND row, rendered through the one
      // composition point and evaluated for this caller — what each worker
      // session may read and post, and where the Channels stand.
      const registerBlocks = new Map<string, string>();
      for (const workerId of new Set(sessions.map((s) => s.workerId).filter((w): w is string => !!w))) {
        try {
          const block = renderDerivedBlocks(await resolveRegister(db, { attendee: { workerId }, actor: scopeCtx() }));
          if (block) registerBlocks.set(workerId, block);
        } catch {
          // A register that cannot be rendered never fails the identity read.
        }
      }

      // #1617 — liveness was invisible until a post was refused. Same
      // derivation as the post and bind gates (`sessionLapsesAt`, which
      // `isSessionLive` is defined by), so what this shows is what they enforce.
      const nowForLiveness = new Date();
      const lastEventForLiveness = await loadLastEventBySession(
        db as never,
        sessions.filter((s) => !s.endedAt).map((s) => s.id),
      );

      const lines = sessions.map((s) => {
        const worker = s.workerId ? workerRows.get(s.workerId) : null;
        const app = s.appId ? appRows.get(s.appId) : null;
        let urn: string | null = null;
        if (worker && app) {
          try {
            urn = composeWorkerUrn(normalizeUrnForLookup(app.urn), worker.slug);
          } catch {
            // An App URN the fixed arity can't take degrades to no URN rather
            // than failing the whole read (the Worker.urn field resolver's rule).
            urn = null;
          }
        }
        // #1026 — from the URN just composed, so this row's link and its
        // identifier cannot disagree.
        const url = workerPortalUrl(urn);
        return (
          `- session ${s.id}${s.endedAt ? ' [ENDED]' : ''}${s.workerId ? ' (worker session id; pass as `session` to team tools)' : ' (session id)'}\n` +
          (s.endedAt ? `    ended: ${s.endedAt.toISOString()} · end reason: ${sessionEndReason(s)}\n` : '') +
          // The un-bound case is the one worth calling out: it is the shape in
          // which a team-chat post silently lands under the human's name.
          (worker
            ? `    working as: ${worker.name}${worker.role ? ` (${worker.role})` : ''} (worker id: ${worker.id})${urn ? `\n    ${urn}` : ''}${url ? `\n    URL: ${url}` : ''}\n`
            : '    working as: nobody — this session is NOT bound to a worker, so anything it posts is attributed to you, not a teammate.\n') +
          (app ? `    app: ${app.name}\n` : '') +
          `    started: ${s.startedAt.toISOString()}${s.type ? ` · ${s.type}` : ''}` +
          (s.endedAt ? '' : `\n    ${renderSessionLiveness(sessionLapsesAt(s, lastEventForLiveness.get(s.id)), nowForLiveness, s.expiresAt)}`) +
          (s.plan ? `\n    plan: ${s.plan}` : '') +
          (s.workerId && registerBlocks.has(s.workerId)
            ? `\n${registerBlocks.get(s.workerId)!.split('\n').map((l) => `    ${l}`).join('\n')}`
            : '')
        );
      });

      // #1133 — absence from this list must never be readable as "the session
      // is gone" (tasks:end-worker-session reads it as "reaped", and a reaped
      // session writes no handoff). When the list truncated, say so, and give
      // recovery guidance that is TRUE: `limit` retrieves everything only
      // while the total fits under its 50 cap — beyond that, say older rows
      // exist instead of promising a call that cannot return them.
      const truncated = total > sessions.length;
      const header = truncated
        ? total <= 50
          ? `${sessions.length} session(s) — TRUNCATED, showing the newest ${sessions.length} of ${total}; pass limit: ${total} to see them all:\n`
          : `${sessions.length} session(s) — TRUNCATED, showing the newest ${sessions.length} of ${total}; limit caps at 50, so ${total - 50} older session(s) lie beyond any single call:\n`
        : `${sessions.length} session(s):\n`;

      return textResult(
        `${activeMemoryLine}${header}${lines.join('\n')}\n\n` +
          // #1034: "session id" stays GENERAL here, because this list includes
          // unbound sessions whose own row says "working as: nobody" — calling
          // every id a worker session id would contradict the line above it and
          // invite a reader to infer a binding that does not exist. The
          // worker-session fact below is scoped to the rows it is true of.
          // #1034: every clause here is scoped to the rows it is TRUE of. This
          // list deliberately includes unbound sessions, and team chat REFUSES
          // one (SESSION_NOT_WORKER_BOUND) — so unconditional "post as the
          // worker" advice contradicts the "working as: nobody" row directly
          // above it, and promises a call that cannot succeed.
          'Pass a row that is BOUND and still OPEN to hadron_team_chat_post to post AS that worker — an ' +
          'unbound row is refused SESSION_NOT_WORKER_BOUND and an [ENDED] one SESSION_ENDED, neither ' +
          'silently posted as you. Any session id works for ' +
          'hadron_record_work and hadron_end_session. Re-fetch a worker\'s boot briefing with hadron_get_worker. ' +
          'A bound row is a worker session. One created by hadron_start_session has no hard expiry and ' +
          'stays open until hadron_end_session, no matter what happened to the chat session that started ' +
          'it. A session created elsewhere with a non-null hard expiry can also be ended by the reaper ' +
          'when that deadline passes. While open and recently active ' +
          'inside its idle window, it reads LIVE and adds the WORKER_TAKEN bind block. After the idle ' +
          'window, that session block falls away; any human HOLD remains independent until explicit release.',
      );
    },
  );

  // ── hadron_cast_worker ────────────────────────────────────────────────────────

  server.tool(
    'hadron_cast_worker',
    'Cast a Worker (#974, spec cor:agt:020 / cor:dmo:050:11): create a named AI team member — the casting of an agent already installed in the team App under a name ("Iris"). The agent carries the persona dressing (personaRole, and the compiled boot prompt every casting of it is served); the Worker is the local named identity that does attributable work. Pass agent to cast a specific installed agent, or role to pick the single installed agent with that personaRole. The name is REQUIRED (#1050): a worker\'s name is permanent within the App, so it is chosen, never derived — a nameless cast refuses WORKER_NAME_REQUIRED rather than inventing a permanent identifier nobody picked. Names are unique per App, case-insensitively, FOREVER (two Apps may each have an Iris; a name already taken here — including a retired worker\'s — refuses with WORKER_NAME_TAKEN). NFKC-normalized Unicode 16 UTS #39 skeletons (original-case and caseless) must also be distinct here, retired workers included: WORKER_NAME_CONFUSABLE names the colliding worker; display spelling is preserved. Returns the worker\'s id, name, URN (hrn:worker:<root>:<app-slug>:<slug>, #991) and resolved prompt — print the prompt as the worker\'s boot briefing, and pass the URN (or the id) as workerRef when starting sessions. Casting is a one-time mint, so record the URN: it is the ref that gets you back to this worker later.',
    SHAPE_HADRON_CAST_WORKER,
    async ({ role, name, agent, app, reportsTo, noTeam, session }) => {
      // #1081 — the caller just drove this session, so it is alive. The
      // touch is explicit here rather than a side effect of whichever tool
      // happens to write the Session row (see heartbeatSession).
      await heartbeatSession(session);
      // Delegate to the GraphQL resolver (findings:node-write-surface-
      // invariants — MCP tools delegate, never re-implement). Auth semantics
      // live in the resolver's gate: a hybrid user+selection principal is
      // judged on the user's own rights, a pure App-key principal is denied.
      //
      // App default (Codex review): requireAppScope() must run BEFORE reading
      // auth.appId — for OAuth callers it is what copies the session's
      // hadron_set_active_app selection into auth.appId.
      let appRef = app;
      if (!appRef) {
        // #1009: same session-as-App-hint recovery as the team tools.
        await adoptAppFromSession(session);
        const appScopeError = requireAppScope();
        if (appScopeError) return appScopeError;
        appRef = auth.appId;
        if (!appRef) {
          return textResult('No App context — pass the app parameter or select one with hadron_set_active_app.');
        }
      }
      try {
        const ctx = {
          db,
          clientId: auth.clientId ?? undefined,
          userId: auth.userId ?? undefined,
          apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId, // #1868: the shared authorized tx re-checks the presented key
          appId: auth.appId ?? undefined,
          sessionId: auth.sessionId ?? undefined,
          roles: auth.roles as Context['roles'],
          organizationId: auth.organizationId ?? undefined,
        };
        const worker = await resolvers.Mutation.castWorker(
          {},
          { appRef, role: role ?? null, agentRef: agent ?? null, name: name ?? null,
            ...(reportsTo !== undefined ? { reportsTo } : {}), ...(noTeam !== undefined ? { noTeam } : {}),
          },
          ctx,
        );
        const prompt = await resolvers.Worker.prompt(worker, {}, ctx);
        // #991: emit the URN alongside the id. It is the ref a human can read
        // back later — the cast is a one-time mint, and before the URN existed
        // an MCP-only client that did not record the cuid had no way back to
        // the worker (hadron-cli#443).
        const workerUrn = (await resolvers.Worker.urn(worker, {}, ctx)) as string | null;
        // #1026: the cast is a one-time mint whose receipt is the record a
        // human keeps, so the link ships with the URN it is built from.
        const workerUrl = workerPortalUrl(workerUrn);
        const placement = await resolvers.Worker.teamPlacement(worker, {}, ctx);
        const reportingHeadId = await resolvers.Worker.reportsToWorkerId(worker, {}, ctx);
        return textResult(
          `Worker cast: **${worker.name}**${worker.role ? ` (${worker.role})` : ''}\n` +
            `Worker id: ${worker.id}\n` +
            (placement !== null ? `Team placement: ${placement}\n` : '') +
            (reportingHeadId ? `Reports to worker: ${reportingHeadId}\n` : '') +
            (workerUrn ? `Worker URN: ${workerUrn}\n` : '') +
            (workerUrl ? `URL: ${workerUrl}\n` : '') +
            `\nBoot briefing:\n\n${prompt ?? ''}`,
        );
      } catch (e) {
        if (e instanceof ScopeGraphQLError) return refusalResult(`Error: [${String(e.extensions?.code ?? 'ERROR')}] ${e.message}`);
        return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : 'worker casting failed'}`, 'hadron_cast_worker');
      }
    },
  );

  // ── Channel-addressed chat (spec 049 Phase 8) ─────────────────────────────────

  const chatCtx = (): Context => ({
    db,
    clientId: auth.clientId ?? undefined,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId, // #1868: the shared authorized tx re-checks the presented key
    appId: auth.appId ?? undefined,
    sessionId: auth.sessionId ?? undefined,
    roles: auth.roles as Context['roles'],
    organizationId: auth.organizationId ?? undefined,
  });

  /** Post into a Channel by id or address — the team-chat post's Channel-addressed twin. */
  const postToChannel = async (channelRef: string, body: string, replyToSeq: number | null, session: string | null) => {
    try {
      const msg = await resolvers.Mutation.createChannelMessage({}, { channelRef, body, replyToSeq, sessionRef: session }, chatCtx());
      const extras: string[] = [];
      if (msg.mentions.length > 0) extras.push(`mentions: ${msg.mentions.map((m: string) => `@${m}`).join(', ')}`);
      if (msg.replyToSeq != null) extras.push(`in reply to #${msg.replyToSeq}`);
      if (msg.authorAppId) extras.push('cross-App post');
      // Display-only, best-effort: the message is already appended, so a
      // failed lookup must not turn a successful post into an error the
      // caller retries (Copilot on PR #1169). Routed through the ref resolver
      // (#1171) so a post addressed by the chat root's node URN names the
      // Channel in its receipt instead of echoing the ref back.
      const ch = await resolveChannelRefId(db, channelRef)
        .then((id) => (id ? db.channel.findUnique({ where: { id }, select: { name: true, loc: true } }) : null))
        .catch(() => null);
      return textResult(
        `Posted message #${msg.seq} in Channel ${ch ? `${ch.name} (${ch.loc})` : channelRef} as ${msg.authorName ?? 'unknown'}${extras.length ? ` (${extras.join('; ')})` : ''}.`,
      );
    } catch (e) {
      if (e instanceof ScopeGraphQLError) return refusalResult(`[${String(e.extensions?.code ?? 'ERROR').toLowerCase()}] ${e.message}`);
      return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : 'channel post failed'}`, 'hadron_channel_post');
    }
  };

  /** Read a Channel by id or address — the team-chat read's Channel-addressed twin. */
  const readChannel = async (
    channelRef: string,
    args: { replyToSeq?: number; sinceSeq?: number; beforeSeq?: number; mentions?: string; teamHeadRef?: string; untagged?: boolean; limit?: number; offset?: number; session?: string; expectedIncarnation?: number },
  ) => {
    try {
      // #1353: capture applies to any user-principal session read — the pilot
      // operator allowlist that used to bound it is gone. App-key callers
      // (no userId) keep their resolver isolation and never capture.
      const pilotRead = !!args.session && !!auth.userId;
      const channelId = pilotRead ? await resolveChannelRefId(db, channelRef) : null;
      const captured = channelId
        ? await db.channel.findFirst({
            where: { id: channelId, deletedAt: null },
            select: { id: true, lastSeq: true },
          })
        : null;
      // An explicit Worker session owns cursor attribution for user callers.
      // Keep a pure App key's header-bound session: the delegated resolver
      // uses it to isolate reads to that session's memory.
      const resolverCtx = args.session && auth.userId
        ? { ...chatCtx(), sessionId: undefined }
        : chatCtx();
      const page = await resolvers.Query.channelMessages(
        {},
        { channelRef, replyToSeq: args.replyToSeq ?? null, sinceSeq: args.sinceSeq ?? null, beforeSeq: args.beforeSeq ?? null, mentionsRef: args.mentions ?? null, teamHeadRef: args.teamHeadRef ?? null, untagged: args.untagged ?? null, limit: args.limit ?? null, offset: args.offset ?? null, expectedIncarnation: args.expectedIncarnation ?? null },
        resolverCtx,
      );
      if (captured && args.session) {
        try {
          await maybeAdvanceOwnChannelRead(chatCtx(), {
            channelId: captured.id,
            capturedHead: captured.lastSeq,
            sessionRef: args.session,
            replyToSeq: args.replyToSeq,
            sinceSeq: args.sinceSeq,
            beforeSeq: args.beforeSeq,
            mentionsRef: args.mentions,
            teamHeadRef: args.teamHeadRef,
            untagged: args.untagged,
            limit: args.limit,
            offset: args.offset,
            expectedIncarnation: args.expectedIncarnation,
            page,
          });
        } catch (error) {
          // #2181: a pinned read whose final fence refused returns the typed error, never the page.
          if (args.expectedIncarnation != null && error instanceof ScopeGraphQLError && ['CHANNEL_INCARNATION_CHANGED', 'CHANNEL_NOT_FOUND'].includes(String(error.extensions?.code))) throw error;
          // The transcript is already authorized and loaded. Cursor ownership
          // is best-effort bookkeeping: never discard a successful read and
          // invite the caller to retry it because the follow-up write failed.
          console.warn('[hadron_channel_read] pilot read-state advance failed:', error);
        }
      }
      // #2181: the envelope line a caller pins its next read or mark to (additive final line).
      const envelope = page.channelId != null && page.channelIncarnation != null ? `\n\nchannel ${page.channelId} incarnation ${page.channelIncarnation}` : '';
      if (page.total === 0) return textResult(`The Channel has no matching messages.${envelope}`);
      const lines = page.items.map((m) => {
        const reply = m.replyToSeq != null ? ` (reply to #${m.replyToSeq})` : '';
        const cross = m.authorAppId ? ' [cross-App]' : '';
        const tags = m.teamTags?.length ? ` [${m.teamTags.map(t => `${t.label} (headId: ${t.headId})`).join(', ')}]` : '';
        return `#${m.seq} ${chatByline(m)}${cross}${tags} ${m.at.toISOString()}${reply}:\n${m.body}`;
      });
      return textResult(`${page.total} message(s) total, showing ${page.items.length}:\n\n${lines.join('\n\n')}${envelope}`);
    } catch (e) {
      if (e instanceof ScopeGraphQLError) return refusalResult(`[${String(e.extensions?.code ?? 'ERROR').toLowerCase()}] ${e.message}`);
      return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : 'channel read failed'}`, 'hadron_channel_read');
    }
  };

  /**
   * #1265 — unattended team-chat polling for the Workers THIS user is
   * currently driving. Register says who attends; ChannelReadState says where
   * each attendee is up to. Reading never advances either record: the host
   * acknowledges a returned checkpoint only after it has routed/acted on the
   * window, so a crash can duplicate attention but cannot skip it.
   */
  const monitorTeamChat = async (args: {
    appRef: string;
    channel?: string;
    monitorFor?: string;
    acknowledge?: Array<{ worker: string; channel: string; seq: number; proof: string }>;
    limit?: number;
  }) => {
    if (!auth.userId || auth.impersonation) {
      return refusalResult('[forbidden] Team-chat monitoring is available only to an ordinary user driving their own live Worker sessions.');
    }

    try {
      const { id: appId } = await resolveAppRef(db, args.appRef);
      const app = await db.app.findFirst({
        where: { id: appId, deletedAt: null, uninstalledAt: null },
        select: { id: true, organizationId: true, ownerUserId: true, defaultChannelId: true },
      });
      if (!app) return refusalResult('[app_not_found] App not found.');

      const ctx: Context = {
        ...chatCtx(),
        appId: app.id,
        organizationId: app.organizationId ?? undefined,
        // A monitor observes liveness; its transcript read must not itself
        // create a UsageEvent that makes the transport-bound session live.
        sessionId: undefined,
      };
      if (!(await isAppParticipant(ctx, app))) return refusalResult('[forbidden] You do not participate in that App.');

      const resolveWorkerInApp = async (ref: string) => {
        try {
          const worker = await resolvers.Query.worker({}, { ref, appRef: app.id }, ctx);
          return worker.appId === app.id ? worker : null;
        } catch (e) {
          if (
            e instanceof ScopeGraphQLError && ['WORKER_NOT_FOUND', 'FORBIDDEN'].includes(String(e.extensions?.code))
          ) return null;
          throw e;
        }
      };
      const requestedWorker = args.monitorFor !== undefined
        ? await resolveWorkerInApp(args.monitorFor)
        : null;
      if (args.monitorFor !== undefined && !requestedWorker) {
        return refusalResult('[monitor_target_not_live] That Worker is not in one of your live sessions in this App.');
      }

      // A monitor is an operator-owned relay, not a presence board. Enumerate
      // only this user's live, Worker-bound sessions in this App. The +1 makes
      // the resource cap fail closed instead of silently omitting a Worker.
      const now = new Date();
      const open = await db.session.findMany({
        where: {
          userId: auth.userId,
          workerId: requestedWorker ? requestedWorker.id : { not: null },
          endedAt: null,
          deletedAt: null,
          worker: { appId: app.id, retiredAt: null },
          ...recentlyTouchedFilter(now),
        },
        orderBy: [{ updatedAt: { sort: 'desc', nulls: 'last' } }, { startedAt: 'desc' }],
        select: { id: true, workerId: true, type: true, startedAt: true, updatedAt: true, autoExpiredAt: true, endedAt: true, expiresAt: true },
        take: requestedWorker ? OPEN_SESSION_SCAN_CAP : OPEN_SESSION_SCAN_CAP + 1,
      });
      if (!requestedWorker && open.length > OPEN_SESSION_SCAN_CAP) {
        return refusalResult(`[monitor_scope_too_large] More than ${OPEN_SESSION_SCAN_CAP} recent Worker sessions match. Pass monitorFor to narrow the monitor.`);
      }
      const lastEvents = await loadLastEventBySession(db as never, open.map((s) => s.id));
      const liveWorkerIds = [...new Set(
        open
          .filter((s) => s.workerId && isSessionLive(s, lastEvents.get(s.id), now))
          .map((s) => s.workerId as string),
      )];
      // #1617 B: a worker whose own session merely LAPSED is still monitored —
      // its next read or post resumes it (`reviveOwnLapsedSession`) — so a
      // quiet stretch past the idle window does not make it unwakeable.
      // Observing resumes nothing; the worker's own act does.
      for (const id of await resumableOwnWorkerIds(ctx, {
        userId: auth.userId!,
        appId: app.id,
        workerId: requestedWorker?.id,
        now,
      })) {
        if (!liveWorkerIds.includes(id)) liveWorkerIds.push(id);
      }
      const liveWorkerSet = new Set(liveWorkerIds);
      if (!requestedWorker && liveWorkerIds.length > TEAM_CHAT_MONITOR_MAX_TARGETS) {
        return textResult(
          `[monitor_scope_too_large] More than ${TEAM_CHAT_MONITOR_MAX_TARGETS} live Workers match. Pass monitorFor to narrow the monitor.`,
        );
      }

      let targetWorkerIds = liveWorkerIds;
      if (requestedWorker) {
        if (!liveWorkerSet.has(requestedWorker.id)) {
          return refusalResult('[monitor_target_not_live] That Worker is not in one of your live sessions in this App.');
        }
        targetWorkerIds = [requestedWorker.id];
      }
      if (targetWorkerIds.length === 0) {
        return textResult('No live Worker sessions of yours need team-chat monitoring in this App.');
      }

      const channelId = args.channel !== undefined
        ? await resolveChannelRefId(db, args.channel)
        : app.defaultChannelId;
      if (!channelId) return refusalResult('[channel_not_found] No matching Channel.');
      const selectedChannel = await db.channel.findFirst({
        where: { id: channelId, deletedAt: null },
        select: { id: true, name: true, loc: true, lastSeq: true },
      });
      if (!selectedChannel) return refusalResult('[channel_not_found] No matching Channel.');

      if ((args.acknowledge?.length ?? 0) > TEAM_CHAT_MONITOR_MAX_TARGETS) {
        return refusalResult(`[bad_user_input] acknowledge accepts at most ${TEAM_CHAT_MONITOR_MAX_TARGETS} checkpoints.`);
      }
      const ackByWorker = new Map<string, { workerId: string; seq: number }>();
      const targetWorkerSet = new Set(targetWorkerIds);
      for (const ack of args.acknowledge ?? []) {
        const checkpoint = verifyTeamChatMonitorCheckpoint(ack.proof);
        if (
          !checkpoint ||
          checkpoint.appId !== app.id ||
          checkpoint.channelId !== selectedChannel.id ||
          checkpoint.workerId !== ack.worker ||
          checkpoint.channelId !== ack.channel ||
          checkpoint.seq !== ack.seq
        ) {
          return refusalResult('[invalid_checkpoint] The acknowledgement was not issued for this Worker, Channel and sequence. Poll again.');
        }
        if (!liveWorkerSet.has(checkpoint.workerId) || !targetWorkerSet.has(checkpoint.workerId)) {
          return refusalResult('[monitor_target_not_live] An acknowledgement named a Worker outside this monitor\'s live targets.');
        }
        const held = ackByWorker.get(checkpoint.workerId);
        if (!held || checkpoint.seq > held.seq) {
          ackByWorker.set(checkpoint.workerId, { workerId: checkpoint.workerId, seq: checkpoint.seq });
        }
      }
      const resolvedAcks = [...ackByWorker.values()];
      for (const ack of resolvedAcks) {
        const ackView = await resolveRegister(db, { attendee: { workerId: ack.workerId }, actor: ctx });
        const ackRow = ackView?.rows.find((candidate) => candidate.channel.id === selectedChannel.id);
        if (!ackRow) return refusalResult('[channel_not_found] No matching Channel.');
        if (!ackRow.canRead || ackRow.entry.role === 'POST') {
          return refusalResult('[forbidden] An acknowledgement named a Channel this Worker cannot watch.');
        }
      }
      // One checkpoint is one act. If any entry is invalid or a write fails,
      // roll all of them back rather than partially silencing the monitor.
      const acknowledged = resolvedAcks.length
        ? await db.$transaction(async (tx) => {
            const receipts: string[] = [];
            const txCtx = { ...ctx, db: tx as unknown as PrismaClient };
            for (const ack of resolvedAcks) {
              const state = await resolvers.Mutation.advanceChannelReadState(
                {},
                { attendeeRef: ack.workerId, appRef: app.id, channelRef: selectedChannel.id, seq: ack.seq },
                txCtx,
              );
              receipts.push(`${state.attendeeUrn ?? ack.workerId} through #${state.lastSeenSeq}`);
            }
            return receipts;
          })
        : [];

      const views = await Promise.all(targetWorkerIds.map(async (workerId) => ({
        workerId,
        view: await resolveRegister(db, { attendee: { workerId }, actor: ctx }),
      })));
      const statuses: string[] = [];
      const watchers: Array<{
        workerId: string;
        urn: string;
        seen: number;
        mentionOnly: boolean;
        disclosure: string | null;
        mentionTokens: Set<string>;
      }> = [];
      let registeredTargets = 0;

      for (const { workerId, view } of views) {
        const urn = view?.attendeeUrn ?? workerId;
        const row = view?.rows.find((candidate) => candidate.channel.id === selectedChannel.id);
        if (!row) {
          statuses.push(`- ${urn}: not registered for this Channel`);
          continue;
        }
        registeredTargets += 1;
        if (row.entry.role === 'POST') {
          statuses.push(`- ${urn}: role POST does not watch${row.disclosure ? ` (${row.disclosure})` : ''}`);
          continue;
        }
        if (!row.canRead) {
          statuses.push(`- ${urn}: ${row.disclosure ?? 'HOST_MEMORY_NOT_READABLE'}`);
          continue;
        }
        const tokens = row.entry.mentionOnly
          ? await attendeeMentionTokens(db, { workerId })
          : [];
        watchers.push({
          workerId,
          urn,
          seen: row.readState?.lastSeenSeq ?? 0,
          mentionOnly: row.entry.mentionOnly,
          disclosure: row.disclosure,
          mentionTokens: new Set(tokens),
        });
        if (row.disclosure) statuses.push(`- ${urn}: watching with ${row.disclosure}`);
      }

      // No applicable register row means the monitor has no legitimate route
      // to this Channel. Collapse that with absence, matching every other
      // Channel read surface instead of becoming an id-existence oracle.
      if (registeredTargets === 0) return refusalResult('[channel_not_found] No matching Channel.');

      const ackLine = acknowledged.length ? `Acknowledged ${acknowledged.join('; ')}.\n` : '';
      const pollStateLine = acknowledged.length
        ? 'Acknowledgements were applied; polling made no further read-state changes.'
        : 'Stored read state was not changed.';
      if (watchers.length === 0) {
        return textResult(`${ackLine}No readable WATCH/BOTH register entry applies to your live Worker sessions.${statuses.length ? `\n\nStatus:\n${statuses.join('\n')}` : ''}`);
      }

      if (watchers.every((watcher) => watcher.seen >= selectedChannel.lastSeq)) {
        return textResult(
          `${ackLine}No new registered team-chat attention. Channel is at #${selectedChannel.lastSeq}; ${watchers.length} live Worker${watchers.length === 1 ? '' : 's'} monitored. ${pollStateLine}` +
          (statuses.length ? `\n\nStatus:\n${statuses.join('\n')}` : ''),
        );
      }

      const sinceSeq = Math.min(...watchers.map((watcher) => watcher.seen));
      const page = await resolvers.Query.channelMessages(
        {},
        { channelRef: selectedChannel.id, sinceSeq, beforeSeq: null, mentionsRef: null, limit: args.limit ?? null, offset: null },
        ctx,
      );
      // lastSeq includes tombstones while channelMessages deliberately omits
      // them. Once the visible page is exhausted, the captured watermark is
      // nevertheless fully scanned and safe to acknowledge.
      const pageExhausted = page.total <= page.items.length;
      const scannedThrough = pageExhausted
        ? selectedChannel.lastSeq
        : page.items.reduce((max, message) => Math.max(max, message.seq), sinceSeq);
      const routed: string[] = [];
      for (const message of page.items) {
        const routes = watchers.filter((watcher) => {
          if (message.seq <= watcher.seen) return false;
          // A Worker never receives its own post, including a broadcast.
          if (message.authorWorkerId === watcher.workerId) return false;
          if (!watcher.mentionOnly) return true;
          // #2020: its names, or a broadcast stamped at post time.
          return mentionReach(message, [...watcher.mentionTokens], [watcher.workerId]) !== null;
        });
        if (routes.length === 0) continue;
        const reply = message.replyToSeq != null ? ` (reply to #${message.replyToSeq})` : '';
        const cross = message.authorAppId ? ' [cross-App]' : '';
        const mentionLine = message.mentions.length ? `\nmentions: ${message.mentions.map((mention) => `@${mention}`).join(', ')}` : '';
        routed.push(
          `#${message.seq} ${chatByline(message)}${cross} ${message.at.toISOString()}${reply}:\n${message.body}` +
          `${mentionLine}\nroute to: ${routes.map((route) => route.urn).join(', ')}`,
        );
      }

      const checkpoints = watchers
        .map((watcher) => ({ worker: watcher, seq: Math.min(scannedThrough, selectedChannel.lastSeq) }))
        .filter(({ worker, seq }) => seq > worker.seen)
        .map(({ worker, seq }) => ({
          worker: worker.workerId,
          channel: selectedChannel.id,
          seq,
          proof: signTeamChatMonitorCheckpoint({ v: 1, appId: app.id, channelId: selectedChannel.id, workerId: worker.workerId, seq }),
        }));
      const more = page.total > page.items.length
        ? `\nMore messages remain after this page (${page.items.length} of ${page.total} scanned from the oldest stored cursor).`
        : '';
      const routing = routed.length
        ? `${routed.length} message${routed.length === 1 ? '' : 's'} need${routed.length === 1 ? 's' : ''} routing:\n\n${routed.join('\n\n')}`
        : 'No messages in the scanned window need routing to these attendees.';
      const checkpoint = checkpoints.length
        ? `\n\nAfter routing/action succeeds, deliberately acknowledge this checkpoint:\n${JSON.stringify(checkpoints)}`
        : '';
      const status = statuses.length ? `\n\nStatus:\n${statuses.join('\n')}` : '';
      return textResult(
        `${ackLine}Team-chat monitor: ${selectedChannel.name} (${selectedChannel.loc}), Channel at #${selectedChannel.lastSeq}. ${pollStateLine}\n\n${routing}${more}${checkpoint}${status}`,
      );
    } catch (e) {
      return scopeErrorText(e);
    }
  };

  /**
   * #1697 — the worker session this request already speaks for, if any: the
   * validated X-Hadron-Session header, else the connection's one live binding
   * (DAC, #1610). Null when neither names a Worker. An ambiguous connection
   * never reaches here unnamed: the #1701 gate refuses it first.
   */
  const boundWorkerSession = async (): Promise<string | null> => {
    if (auth.sessionId) {
      const valid = await validateSessionBinding(db, auth, auth.sessionId);
      return valid?.actor.workerId ? valid.sessionId : null;
    }
    const mcpSessionId = getSessionId();
    if (!mcpSessionId) return null;
    const live = await liveConnectionBindings(mcpSessionId, auth);
    if (!live.length || connectionIsAmbiguous(mcpSessionId, live)) return null;
    const bound = live[live.length - 1];
    return bound.actor.workerId ? bound.sessionId : null;
  };

  server.tool(
    'hadron_channel_post',
    'Post a message into a Channel by id or ADDRESS — the chat-root URN hadron_list_channels prints (spec 049 — Channels are the durable, server-ordered streams hadron_list_channels shows; every App\'s default `team` Channel is what hadron_team_chat_post writes). Same contract as hadron_team_chat_post: mentions extracted server-side, replyToSeq wires a reply, session posts AS that session\'s Worker. AUTHORSHIP IS EXPLICIT (#1697, parity with the CLI\'s `channel post --session | --as-me`): with no session, a connection bound to one worker session (hadron_start_session) posts as that Worker; otherwise pass asMe: true to post as yourself, or the post is refused [authorship_required] — never silently recorded under your name. Item J: a Worker of ANOTHER App authors here only when you (its driver) may write the Channel\'s host memory — the post is then marked cross-App. A Channel you may not read is [channel_not_found].',
    SHAPE_HADRON_CHANNEL_POST,
    async ({ channel, body, replyToSeq, session, asMe }) => {
      await heartbeatSession(session);
      // #1697 — never default to the human. The server treats sessionRef as
      // optional, so an omitted one used to record the caller as the author
      // with no error: wrong provenance that reads as success (cor:agt:020:03).
      if (session && asMe) {
        return {
          isError: true as const,
          content: [{ type: 'text' as const, text: '[bad_user_input] hadron_channel_post: pass session OR asMe, not both — one says a Worker authors, the other that you do. Nothing was posted.' }],
        };
      }
      let author = session ?? null;
      if (!author && !asMe) {
        author = await boundWorkerSession();
        if (!author) {
          return {
            isError: true as const,
            content: [{
              type: 'text' as const,
              text:
                '[authorship_required] hadron_channel_post: no worker session is named or bound on this connection, ' +
                'so this post would be recorded under YOUR name. Nothing was posted. Pass session: "<your worker ' +
                'session id>" (hadron_whoami lists yours) to post as that Worker, or asMe: true to post as yourself (#1697).',
            }],
          };
        }
      }
      return postToChannel(channel, body, replyToSeq ?? null, author);
    },
  );

  server.tool(
    'hadron_channel_read',
    'Read a Channel by id or ADDRESS (the chat-root URN hadron_list_channels prints; spec 049). With no cursor or offset, returns the newest page, ascending by seq; sinceSeq reads forward and beforeSeq pages backward. A Channel you may not read is [channel_not_found].',
    SHAPE_HADRON_CHANNEL_READ,
    async ({ channel, replyToSeq, sinceSeq, beforeSeq, mentions, teamHeadRef, untagged, limit, offset, session: rawSession, expectedIncarnation }) => {
      // A blank session is no session, for every consumer below (#1362 review).
      const session = typeof rawSession === 'string' ? rawSession.trim() || undefined : rawSession;
      await heartbeatSession(session);
      return readChannel(channel, { replyToSeq, sinceSeq, beforeSeq, mentions, teamHeadRef, untagged, limit, offset, session, expectedIncarnation });
    },
  );

  // ── hadron_team_chat_post / hadron_team_chat_read ─────────────────────────────

  server.tool(
    'hadron_team_chat_post',
    'Post a message into the team App\'s chat (#939). The team chat is one well-known chat per team App (loc chats:team in the Team Agent\'s shared app memory), bootstrapped on first post. Mention teammates as @worker-name or @handle — mentions are extracted server-side into the message envelope. Pass session to post AS the Worker bound to that session (the driving session is recorded; the worker must not be retired). AUTHORSHIP IS EXPLICIT (#1967, the same contract as hadron_channel_post and the CLI\'s `team chat post --session | --as-me`): with no session, a connection bound to one worker session (hadron_start_session) posts as that Worker; otherwise pass asMe: true to post as yourself, or the post is refused [authorship_required] — never silently recorded under your name. A Worker of ANOTHER App authors here only when you (its driver) may write the chat\'s host memory — the post is then marked cross-App (spec 049 item J). Pass replyToSeq to reply to an earlier message. Returns the posted message\'s seq.',
    SHAPE_HADRON_TEAM_CHAT_POST,
    async ({ body, replyToSeq, session, asMe, app, channel }) => {
      // #1967 (cor:agt:020:03 rev 55; Holger #12681): never default to the human, on either path. The contract and
      // the refusal text are hadron_channel_post's (#1697), so the two tools teach one rule.
      if (session && asMe) {
        return {
          isError: true as const,
          content: [{ type: 'text' as const, text: '[bad_user_input] hadron_team_chat_post: pass session OR asMe, not both — one says a Worker authors, the other that you do. Nothing was posted.' }],
        };
      }
      let author = session ?? null;
      if (!author && !asMe) {
        author = await boundWorkerSession();
        if (!author) {
          return {
            isError: true as const,
            content: [{
              type: 'text' as const,
              text:
                '[authorship_required] hadron_team_chat_post: no worker session is named or bound on this connection, ' +
                'so this post would be recorded under YOUR name. Nothing was posted. Pass session: "<your worker ' +
                'session id>" (hadron_whoami lists yours) to post as that Worker, or asMe: true to post as yourself (#1967).',
            }],
          };
        }
      }
      // Presence, not truthiness (Copilot on PR #1169): a supplied '' is a
      // malformed Channel selector and resolves as CHANNEL_NOT_FOUND, never
      // a silent fall-through to the default team chat.
      if (channel !== undefined) {
        await heartbeatSession(author ?? undefined);
        return postToChannel(channel, body, replyToSeq ?? null, author);
      }
      // #1081 — the caller just drove this session, so it is alive. The
      // touch is explicit here rather than a side effect of whichever tool
      // happens to write the Session row (see heartbeatSession).
      await heartbeatSession(author ?? undefined);
      // Delegate to the GraphQL resolver (findings:node-write-surface-
      // invariants — MCP tools delegate, never re-implement). App default
      // mirrors hadron_cast_worker: requireAppScope() runs BEFORE reading
      // auth.appId so the omit-app flow honors hadron_set_active_app.
      let appRef = app;
      if (!appRef) {
        // #1005: the session names its App — recover scope from it before
        // declaring the caller's App set ambiguous.
        await adoptAppFromSession(author ?? undefined);
        const appScopeError = requireAppScope();
        if (appScopeError) return appScopeError;
        appRef = auth.appId;
        if (!appRef) {
          return textResult('No App context — pass the app parameter or select one with hadron_set_active_app.');
        }
      }
      try {
        const msg = await resolvers.Mutation.createTeamChatMessage(
          {},
          { appRef, body, replyToSeq: replyToSeq ?? null, sessionRef: author },
          {
            db,
            clientId: auth.clientId ?? undefined,
            userId: auth.userId ?? undefined,
            apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId, // #1868: the shared authorized tx re-checks the presented key
            appId: auth.appId ?? undefined,
            sessionId: auth.sessionId ?? undefined,
            roles: auth.roles as Context['roles'],
            organizationId: auth.organizationId ?? undefined,
          },
        );
        const extras: string[] = [];
        if (msg.mentions.length > 0) extras.push(`mentions: ${msg.mentions.map((m: string) => `@${m}`).join(', ')}`);
        if (msg.replyToSeq != null) extras.push(`in reply to #${msg.replyToSeq}`);
        // Item J: a cross-App post is visible as one.
        if (msg.authorAppId) extras.push('cross-App post');
        // #1037: the receipt NAMES the team it posted into. With a session
        // passed, the App is unambiguous and a mismatch refuses — but posting
        // as yourself names no App at all, so the ambient selection decides and
        // nothing tells you which team heard you. The old receipt printed the
        // author and the seq, the two things never in doubt, and read as
        // confirmation whichever team it reached. This is hadron-cli#470's
        // answer on the surface that has no worktree to warn from: put the
        // resolved scope in the reader's path rather than add a check.
        // Resolved through the SHARED ref helper, not a hand-rolled column
        // match (PR #1049 review, Copilot): `app` accepts every ref form, and
        // `App.urn` stores the BARE `<root>:<slug>` — so an explicit
        // `hrn:app:…` matched neither column and the receipt silently dropped
        // the team name in exactly the case where the caller named an App by
        // hand. Best-effort: a receipt decorating a post that already succeeded
        // must never turn it into an error.
        const postedTo = await resolveAppRef(db, appRef)
          .then(({ id }: { id: string }) => db.app.findUnique({ where: { id }, select: { urn: true, name: true } }))
          .catch(() => null);
        const where = postedTo ? ` in ${postedTo.urn}${postedTo.name ? ` — ${postedTo.name}` : ''}` : '';
        return textResult(
          `Posted team-chat message #${msg.seq}${where} as ${msg.authorName ?? 'unknown'}${extras.length ? ` (${extras.join('; ')})` : ''}.`,
        );
      } catch (e) {
        return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : 'team-chat post failed'}`, 'hadron_team_chat_post');
      }
    },
  );

  server.tool(
    'hadron_team_chat_read',
    'Read the team App\'s chat (#939), newest page by default, ascending within the page. sinceSeq (including 0) reads forward; beforeSeq pages backward; explicit offset retains oldest-first paging. For unattended routing (#1265), pass monitor:true: the tool derives each of your LIVE Worker sessions\' cursor from ChannelReadState and its WATCH/BOTH + mentionOnly policy from the register, returns each message once with the Workers it concerns, and never routes a message back to its Worker author. It NEVER advances state merely by reading. After routing/action succeeds, call again with monitor:true and the returned acknowledge checkpoint. This makes a restart duplicate work rather than skip it. monitorFor narrows to one of your live Workers; monitoring never wakes sessions or observes another operator\'s sessions.',
    SHAPE_HADRON_TEAM_CHAT_READ,
    async ({ replyToSeq, sinceSeq, beforeSeq, mentions, teamHeadRef, untagged, limit, offset, session: rawSession, app, channel, expectedIncarnation, monitor, monitorFor, acknowledge }) => {
      // A blank session is no session, for every consumer below (#1362 review):
      // otherwise the MCP layer drops the bound session as "explicit" while
      // maybeAdvanceOwnChannelRead's trim falls back to it.
      const session = typeof rawSession === 'string' ? rawSession.trim() || undefined : rawSession;
      if (!monitor && (monitorFor !== undefined || acknowledge !== undefined)) {
        return refusalResult('[bad_user_input] monitorFor and acknowledge require monitor:true.');
      }
      if (monitor && (replyToSeq !== undefined || teamHeadRef !== undefined || untagged !== undefined || sinceSeq !== undefined || beforeSeq !== undefined || mentions !== undefined || offset !== undefined)) {
        return refusalResult('[bad_user_input] monitor:true owns the cursor and mention routing; do not pass replyToSeq, sinceSeq, beforeSeq, mentions or offset.');
      }
      if (monitor && limit !== undefined && limit < 1) {
        return refusalResult('[bad_user_input] monitor:true requires a positive limit.');
      }
      // Monitoring observes liveness; it never creates it. Ordinary reads keep
      // the long-standing #1081 heartbeat contract when a session is passed.
      if (!monitor) await heartbeatSession(session);
      // A normal Channel-addressed read is self-scoping and keeps its existing
      // contract: it needs no active App. Monitor mode still needs an App to
      // decide which of this operator's live Worker sessions participate.
      if (!monitor && channel !== undefined) {
        return readChannel(channel, { replyToSeq, sinceSeq, beforeSeq, mentions, teamHeadRef, untagged, limit, offset, session, expectedIncarnation });
      }

      let appRef = app;
      if (!appRef) {
        const scopedBySession = await adoptAppFromSession(session);
        if (!scopedBySession && monitorFor !== undefined) await adoptAppFromWorker(monitorFor);
        const appScopeError = requireAppScope();
        if (appScopeError) return appScopeError;
        appRef = auth.appId;
        if (!appRef) {
          return textResult('No App context — pass the app parameter or select one with hadron_set_active_app.');
        }
      }
      if (monitor) {
        return monitorTeamChat({ appRef, channel, monitorFor, acknowledge, limit });
      }

      try {
        // Suppress the header-bound session only for user principals whose
        // explicit Worker session owns cursor attribution. A pure App key
        // needs its binding for the resolver's session-memory isolation.
        const resolverCtx = session && auth.userId
          ? { ...chatCtx(), sessionId: undefined }
          : chatCtx();
        // Capture the Channel the resolver will actually read (its oldest
        // team-space root, not necessarily App.defaultChannel), BEFORE the
        // read, with the context the resolver gets (#1362 review, Codex P2).
        const pilotAppId = session && auth.userId
          ? (await resolveAppRef(db, appRef)).id
          : null;
        const captured = pilotAppId ? await locateTeamChatChannel(resolverCtx, pilotAppId) : null;
        const page = await resolvers.Query.teamChatMessages(
          {},
          {
            appRef,
            replyToSeq: replyToSeq ?? null,
            sinceSeq: sinceSeq ?? null,
            beforeSeq: beforeSeq ?? null,
            mentionsRef: mentions ?? null,
            teamHeadRef: teamHeadRef ?? null,
            untagged: untagged ?? null,
            limit: limit ?? null,
            offset: offset ?? null,
          },
          resolverCtx,
        );
        // Advance only if the resolver still serves the root captured above;
        // a root that changed mid-read is skipped (a duplicate nudge, never a
        // cursor moved on a Channel whose messages were not read).
        const stillServed = captured && pilotAppId
          ? (await locateTeamChatChannel(resolverCtx, pilotAppId))?.rootId === captured.rootId
          : false;
        if (captured && session && stillServed) {
          try {
            await maybeAdvanceOwnChannelRead(chatCtx(), {
              channelId: captured.channelId,
              capturedHead: captured.lastSeq,
              sessionRef: session,
              replyToSeq,
              sinceSeq,
              beforeSeq,
              mentionsRef: mentions,
              teamHeadRef,
              untagged,
              limit,
              offset,
              page,
            });
          } catch (error) {
            console.warn('[hadron_team_chat_read] pilot read-state advance failed:', error);
          }
        }
        const envelope = page.channelId != null && page.channelIncarnation != null ? `\n\nchannel ${page.channelId} incarnation ${page.channelIncarnation}` : '';
        if (page.total === 0) return textResult(`The team chat has no matching messages.${envelope}`);
        const lines = page.items.map((m) => {
          const reply = m.replyToSeq != null ? ` (reply to #${m.replyToSeq})` : '';
          const tags = m.teamTags?.length ? ` [${m.teamTags.map(t => `${t.label} (headId: ${t.headId})`).join(', ')}]` : '';
          return `#${m.seq} ${chatByline(m)}${tags} ${m.at.toISOString()}${reply}:\n${m.body}`;
        });
        return textResult(
          `${page.total} message(s) total, showing ${page.items.length}:\n\n${lines.join('\n\n')}${envelope}`,
        );
      } catch (e) {
        return toolErrorResult(
          e,
          () => e instanceof ScopeGraphQLError
            ? `[${String(e.extensions?.code ?? 'ERROR').toLowerCase()}] ${e.message}`
            : `Error: ${e instanceof Error ? e.message : 'team-chat read failed'}`,
          'hadron_team_chat_read',
        );
      }
    },
  );

  // ── #2299 hadron_team_chat_search ────────────────────────────────────────────

  server.tool(
    'hadron_team_chat_search',
    'Search ONE chat\'s history (#2299, cor:agt:020:04): the team App\'s chat, or the Channel named by channel. A literal, case-insensitive substring of the message text (% _ and the backslash are ordinary characters); query is 2 to 200 characters, counted as typed. Newest first; limit defaults to 20 and is clamped to 50. Each call scans at most 1,000 messages: the result says whether the search reached the start of the history (complete) or stopped, and gives the cursor to continue with. An empty page that is not complete may continue; "no matches" is only ever a complete search. Returns message references only (seq and URN, no text): read the message with hadron_team_chat_read / hadron_channel_read to see it. It matches what a read shows, goes through the same access as a read, and NEVER moves your read position or counts as attention. A chat in an encrypted memory is refused [team_chat_search_encrypted].',
    SHAPE_HADRON_TEAM_CHAT_SEARCH,
    async ({ query, limit, cursor, app, channel }) => {
      try {
        let page;
        if (channel !== undefined) {
          page = await resolvers.Query.channelMessageSearch({}, { channelRef: channel, query, limit: limit ?? null, cursor: cursor ?? null }, chatCtx());
        } else {
          let appRef = app;
          if (!appRef) {
            const appScopeError = requireAppScope();
            if (appScopeError) return appScopeError;
            appRef = auth.appId ?? undefined;
            if (!appRef) return textResult('No App context — pass the app parameter or select one with hadron_set_active_app.');
          }
          page = await resolvers.Query.teamChatSearch({}, { appRef, query, limit: limit ?? null, cursor: cursor ?? null }, chatCtx());
        }
        const envelope = page.channelId != null && page.channelIncarnation != null ? `\nchannel ${page.channelId} incarnation ${page.channelIncarnation}` : '';
        const state = page.complete
          ? (page.items.length === 0 ? 'No matches (the search reached the start of the history).' : 'The search reached the start of the history.')
          : `The search stopped before the start of the history${page.items.length === 0 ? ' with no match yet' : ''}; continue with cursor: ${page.cursor}`;
        const lines = page.items.map((m: { seq: number; urn: string | null; nodeId: string }) => `#${m.seq} ${m.urn ?? `node ${m.nodeId}`}`);
        return textResult(`${page.items.length} match(es):\n${lines.join('\n')}${lines.length ? '\n' : ''}\n${state}${envelope}`);
      } catch (e) {
        if (e instanceof ScopeGraphQLError) return refusalResult(`[${String(e.extensions?.code ?? 'ERROR').toLowerCase()}] ${e.message}`);
        return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : 'team-chat search failed'}`, 'hadron_team_chat_search');
      }
    },
  );

  // ── #1353 internal-pilot compact attention ───────────────────────────────────

  // #1353: discovery follows the user principal — the pilot operator
  // allowlist that hid these tools from non-allowlisted connections is
  // removed. What still bounds them is per-call: resolvePilotApp's live-App
  // + participation checks (APP_NOT_FOUND parity) and each tool's own
  // session/consent guards; the capability probe in server_info reports
  // team-attention only for a caller who could actually use it.
  if (auth.userId && !auth.impersonation) {
    server.tool(
      'hadron_team_attention',
      'RETIRED (#1384): the v1 one-shot poll scanned an encrypted Channel\'s whole unread backlog inside one request and now answers UPGRADE_REQUIRED. Use hadron_team_attention_page — the bounded paged successor; your existing since token is accepted there and carries your watermark forward.',
      SHAPE_HADRON_TEAM_ATTENTION,
      async ({ app, since }) => {
        let appRef = app;
        if (!appRef) {
          const scopeError = requireAppScope();
          if (scopeError) return scopeError;
          appRef = auth.appId;
        }
        if (!appRef) return textResult('No App context — pass app or select one with hadron_set_active_app.');
        try {
          const result = await resolvers.Query.teamAttention({}, { appRef, since: since ?? null }, chatCtx());
          return textResult(JSON.stringify(result, null, 2));
        } catch (error) {
          return scopeErrorText(error);
        }
      },
    );

    server.tool(
      'hadron_team_attention_page',
      'PAGED ATTENTION (#1384 v2): one bounded slice of the compact unread scan for this operator\'s LIVE Workers — at most scanLimit decrypted rows and limit emitted Worker/Channel pairs per call. Continue with the returned nextPage while scanComplete is false. Items carry no message bodies; counts are exact for the captured range of the issuing scan. The FINAL page alone returns adoptableSince — adopt it only after every listed nudge was accepted; on any partial failure retain your prior watermark and restart the scan (duplicates, never loss). An existing v1 since token starts a scan and carries the watermark forward. Never changes ChannelReadState.',
      SHAPE_HADRON_TEAM_ATTENTION_PAGE,
      async ({ app, since, page, limit, scanLimit }) => {
        let appRef = app;
        if (!appRef) {
          const scopeError = requireAppScope();
          if (scopeError) return scopeError;
          appRef = auth.appId;
        }
        if (!appRef) return textResult('No App context — pass app or select one with hadron_set_active_app.');
        try {
          const result = await resolvers.Query.teamAttentionPage(
            {},
            { appRef, since: since ?? null, page: page ?? null, limit: limit ?? null, scanLimit: scanLimit ?? null },
            chatCtx(),
          );
          return textResult(JSON.stringify(result, null, 2));
        } catch (error) {
          return scopeErrorText(error);
        }
      },
    );

    server.tool(
      'hadron_team_attention_switchover',
      'PAGED (#1384 v2): explicitly baseline every current live Worker through captured Channel heads. preview is read-only, pages like the poll tool (continue with its returned nextPage), and yields the short-lived proof ONLY on its final completed page. apply requires that proof and atomically refuses if the operator, App, live-Worker scope, effective register or cursor changed. Messages arriving after the preview freeze remain unread. This is the only supported way to discard the pre-router backlog.',
      SHAPE_HADRON_TEAM_ATTENTION_SWITCHOVER,
      async ({ app, action, page, limit, proof }) => {
        let appRef = app;
        if (!appRef) {
          const scopeError = requireAppScope();
          if (scopeError) return scopeError;
          appRef = auth.appId;
        }
        if (!appRef) return textResult('No App context — pass app or select one with hadron_set_active_app.');
        if (action === 'apply' && !proof) return refusalResult('[bad_user_input] action:"apply" requires the proof returned by the final preview page.');
        if (action === 'preview' && proof !== undefined) return refusalResult('[bad_user_input] preview does not accept a proof.');
        if (action === 'apply' && page !== undefined) return refusalResult('[bad_user_input] apply does not accept a page continuation.');
        try {
          const result = action === 'preview'
            ? await resolvers.Query.teamAttentionPreviewPage({}, { appRef, page: page ?? null, limit: limit ?? null, scanLimit: null }, chatCtx())
            : await resolvers.Mutation.confirmTeamAttentionSwitchover({}, { appRef, proof: proof! }, chatCtx());
          return textResult(JSON.stringify(result, null, 2));
        } catch (error) {
          return scopeErrorText(error);
        }
      },
    );

    server.tool(
      'hadron_team_chat_mark_read',
      'Explicitly advance the Worker bound to your live session on one registered Channel. Use after filtered reads, which intentionally never auto-advance. Monotonic; a lower seq is a no-op and a seq beyond the Channel head is refused.',
      SHAPE_HADRON_TEAM_CHAT_MARK_READ,
      async ({ session, app, channel, seq, expectedIncarnation }) => {
        await heartbeatSession(session);
        let appRef = app;
        if (!appRef) {
          await adoptAppFromSession(session);
          const scopeError = requireAppScope();
          if (scopeError) return scopeError;
          appRef = auth.appId;
        }
        if (!appRef) return textResult('No App context — pass app or select one with hadron_set_active_app.');
        try {
          // An omitted channel means the one hadron_team_chat_read SERVES —
          // its oldest team-space root, which need not be App.defaultChannel
          // (#1362 review, Copilot). Resolved here, with the read's own
          // locator, so the mark lands on the Channel that was read.
          let channelRef: string | null | undefined = channel;
          if (channelRef === undefined) {
            channelRef = (await locateTeamChatChannel(chatCtx(), (await resolveAppRef(db, appRef)).id))?.channelId ?? '';
          }
          const result = await markOwnTeamChatRead(chatCtx(), { appRef, channelRef, sessionRef: session, seq, expectedIncarnation });
          return textResult(JSON.stringify(result, null, 2));
        } catch (error) {
          return scopeErrorText(error);
        }
      },
    );
  }

  // ── hadron_list_workers ───────────────────────────────────────────────────────

/**
 * Compact relative age for the roster — "3d ago" (hadron-cli#487).
 *
 * Coarse on purpose: a coordinator is asking "has anyone touched this in a
 * while?", and minute-precision on a two-week-old session invites a reader to
 * treat it as presence. Rounds DOWN, so it never overstates recency.
 */
function ageOf(at: Date, now: Date = new Date()): string {
  const mins = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

  server.tool(
    'hadron_list_workers',
    'List the team App\'s workers — its named staff (#997). THE roster read: use it when you need to work as a teammate but do not know the names, since hadron_start_session\'s workerRef takes a name. Returns each worker\'s name, URN, role, WHO HOLDS IT, whether a session is live, and whether it is retired. #1050: a name is HELD by a person until released — a held name is not yours to take however idle it looks, and the remedy is to cast your own worker, never to end someone\'s session. An UNHELD worker is held by whoever binds it next. "session live" is a separate fact and only ever a question about your own worker. Retired workers are excluded unless includeRetired — their names stay reserved forever, so they explain a WORKER_NAME_TAKEN refusal.',
    SHAPE_HADRON_LIST_WORKERS,
    async ({ includeRetired, limit, offset, session, app }) => {
      // #1081 — the caller just drove this session, so it is alive. The
      // touch is explicit here rather than a side effect of whichever tool
      // happens to write the Session row (see heartbeatSession).
      await heartbeatSession(session);
      // App default mirrors hadron_cast_worker / hadron_record_work:
      // requireAppScope() runs BEFORE reading auth.appId so the omit-app flow
      // honors hadron_set_active_app.
      let appRef = app;
      if (!appRef) {
        // #1009: the roster read is what an agent reaches for FIRST after
        // losing its bearings, so it must be recoverable from a session too.
        await adoptAppFromSession(session);
        const appScopeError = requireAppScope();
        if (appScopeError) return appScopeError;
        appRef = auth.appId;
        if (!appRef) {
          return textResult('No App context — pass the app parameter or select one with hadron_set_active_app.');
        }
      }
      const ctx: Context = {
        db,
        clientId: auth.clientId ?? undefined,
        userId: auth.userId ?? undefined,
        apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId, // #1868: the shared authorized tx re-checks the presented key
        appId: auth.appId ?? undefined,
        sessionId: auth.sessionId ?? undefined,
        roles: auth.roles as Context['roles'],
        organizationId: auth.organizationId ?? undefined,
      };
      try {
        // Delegate to the GraphQL resolver (findings:node-write-surface-
        // invariants — MCP tools delegate, never re-implement), so the staff
        // read gate is literally the same code path GraphQL runs and cannot
        // drift. No authorization logic lives here.
        const page = await resolvers.Query.workers(
          {},
          { appRef, includeRetired: includeRetired ?? null, limit: limit ?? null, offset: offset ?? null },
          ctx,
        );
        // An empty PAGE is not an empty ROSTER (PR #1000 review, Codex P2):
        // `limit: 0` is the resolver's count-only mode, and an offset past the
        // end also yields no items while `total` stays positive. Telling either
        // caller to go cast a worker would be plainly wrong.
        if (page.total === 0) {
          return textResult(
            includeRetired
              ? 'This App has no workers. Cast one with hadron_cast_worker.'
              : 'This App has no active workers. Cast one with hadron_cast_worker, or pass includeRetired to see retired castings.',
          );
        }
        if (page.items.length === 0) {
          return textResult(
            `${page.total} worker(s) in this App, none on this page — offset ${offset ?? 0}` +
              `${limit === 0 ? ' with limit 0 (count only)' : ''}.`,
          );
        }
        // "Taken right now" + "last driven", in ONE load for the whole page
        // rather than per worker: cor:agt:020:03 derives liveness from active
        // sessions, and this is the same signal hadron_start_session refuses
        // WORKER_TAKEN on. It names only THAT a worker is taken, never who is
        // driving it — the driver's identity stays behind the takeover refusal,
        // which is a deliberate act rather than a listing.
        //
        // Shared with `Worker.hasLiveSession` / `Worker.lastActiveAt` since
        // hadron-cli#487 (`loadAppWorkerActivity`), rather than the copy of the
        // predicate that used to live here. Two roster surfaces reading the
        // same fact must not be able to disagree about it, and the MCP roster
        // and the GraphQL one are read by the same coordinator minutes apart.
        const activity = await loadAppWorkerActivity(ctx, page.items[0].appId);
        // #2138 §3.4 — the same per-App derivation as Worker.checkStatus and the roster.
        const checks = await loadAppWorkerCheckStatuses(ctx, page.items[0].appId);
        // The App's URN once for the PAGE, not once per worker (PR #1000
        // review, Copilot): every worker here belongs to the SAME App, so
        // calling the `Worker.urn` field resolver per item repeated one
        // identical App lookup up to the 200-item page cap — concurrently,
        // which is how you saturate a pool. Composed from the shared value with
        // the same helper the field resolver uses, so the spelling cannot
        // drift; an App URN the fixed arity can't take degrades to no URN
        // rather than throwing, exactly as the field resolver does.
        const rosterApp = await db.app.findUnique({
          where: { id: page.items[0].appId },
          select: { urn: true },
        });
        const workerUrn = (slug: string): string | null => {
          if (!rosterApp) return null;
          try {
            return composeWorkerUrn(normalizeUrnForLookup(rosterApp.urn), slug);
          } catch {
            return null;
          }
        };

        // The role AGENT's name, resolved ONCE PER DISTINCT AGENT rather than
        // per worker (a team commonly casts several workers onto one role
        // agent). Goes through the `Worker.agent` field resolver, which applies
        // the Agent's OWN read gate and masks to null on deny — the Worker read
        // gate is wider than the Agent's, and #552 is precisely about not
        // letting the wider gate hand out the narrower entity. Only the NAME is
        // projected; the Agent object never reaches the caller.
        // Holder display names for the whole PAGE in one query, same reasoning
        // as the App URN above. Only a NAME is projected — the roster shows
        // whose a name is, never anything else about them.
        const holderIds = [
          ...new Set(
            page.items
              .map((w: { heldByUserId: string | null }) => w.heldByUserId)
              .filter((id: string | null): id is string => !!id),
          ),
        ];
        const holders = new Map<string, string>();
        if (holderIds.length > 0) {
          for (const u of await db.user.findMany({
            where: { id: { in: holderIds } },
            select: { id: true, handle: true, githubUsername: true },
          })) {
            holders.set(u.id, u.handle ?? u.githubUsername ?? u.id);
          }
        }
        const holderName = (id: string): string => holders.get(id) ?? id;

        const agentNames = new Map<string, Promise<string | null>>();
        const agentNameFor = (agentId: string): Promise<string | null> => {
          let pending = agentNames.get(agentId);
          if (!pending) {
            pending = (async () => {
              const agent = await resolvers.Worker.agent({ agentId } as never, {}, ctx);
              return (agent as { name?: string } | null)?.name ?? null;
            })();
            agentNames.set(agentId, pending);
          }
          return pending;
        };

        const lines = await Promise.all(
          page.items.map(async (w: {
            id: string; name: string; slug: string; role: string | null;
            agentId: string; retiredAt: Date | null;
            heldByUserId: string | null; appId: string; reportsToWorkerId: string | null; explicitNoTeam: boolean;
          }) => {
            const urn = workerUrn(w.slug);
            const agentName = await agentNameFor(w.agentId);
            // Retirement and liveness are INDEPENDENT (PR #1000 review,
            // Copilot): `retireWorker` only stamps `retiredAt`, so a retired
            // worker can still hold an unended session, and collapsing the two
            // into one ternary dropped the taken/free state that
            // `includeRetired` promises.
            // #1050 — HELD and TAKEN are different facts and the roster must
            // not blur them, which is the whole of hadron-cli#487. HELD says
            // whose name it is and is what decides whether you may bind;
            // taken/free says whether a session is live right now, which is
            // only ever a question about your OWN worker. Held-by-someone-else
            // reads as unavailable regardless of liveness — that is the point:
            // an idle held worker is not up for adjudication.
            const flags: string[] = [];
            const placement = await resolvers.Worker.teamPlacement(w, {}, ctx);
            if (placement !== null) flags.push(`team placement ${placement}`);
            if (w.retiredAt) flags.push('RETIRED');
            if (w.heldByUserId && w.heldByUserId !== auth.userId) {
              flags.push(`held by ${holderName(w.heldByUserId)}`);
            } else if (w.heldByUserId) {
              flags.push('held by YOU');
            } else {
              flags.push('unheld — binding it holds it');
            }
            const act = activity.get(w.id);
            flags.push(act?.hasLiveSession ? 'session live' : 'no live session');
            // hadron-cli#487: "cast but never driven" is the state a
            // coordinator most needs and no surface showed — ten issues went to
            // a worker whose whole history was two sessions under three
            // minutes, rendered exactly like one worked yesterday.
            //
            // The AGE matters as much as the never-case, and omitting it was
            // the same defect one step in (PR #1086 review, Codex P2): a worker
            // last driven in March and one driven an hour ago both read "no
            // live session", while the timestamp sat computed and unrendered.
            // Rendered only when there is no live session — during one, "live"
            // is the answer and an age beside it invites reading the age as
            // presence, which is #1034's confusion in a new place.
            if (!act?.lastActiveAt) flags.push('never driven');
            else if (!act.hasLiveSession) flags.push(`last recorded activity ${ageOf(act.lastActiveAt)}`);
            // #2138 §3.4 — after the activity facts, which it is read beside.
            const check = checks.get(w.id);
            if (check) flags.push(renderCheckStatusShort(check));
            // #1026 — built from the SAME page-shared URN above, so the roster
            // costs no extra lookup per worker (the PR #1000 rule that pulled
            // the App URN out of the per-item path in the first place).
            const url = workerPortalUrl(urn);
            return (
              `- ${w.name}${w.role ? ` (${w.role})` : ''} — ${flags.join(', ')}` +
              (agentName ? `\n    agent: ${agentName}` : '') +
              (urn ? `\n    ${urn}` : '') +
              (url ? `\n    URL: ${url}` : '')
            );
          }),
        );
        return textResult(
          `${page.items.length} of ${page.total} worker(s):\n${lines.join('\n')}\n\n` +
            'Work as one with hadron_start_session(description: "<task>", workerRef: "<name>") — it returns that worker\'s boot briefing.',
        );
      } catch (e) {
        return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : 'listing workers failed'}`, 'hadron_list_workers');
      }
    },
  );

  // ── hadron_get_worker ─────────────────────────────────────────────────────────

  server.tool(
    'hadron_get_worker',
    'Read ONE worker, including its resolved BOOT BRIEFING (#1015). THE recovery read: hadron_start_session returns the briefing once, at bind time, and the briefing must never be cached — so an agent whose context was compacted has no copy and no legitimate way back to it. This is that way. It reserves nothing and mints nothing, so recovering costs neither a second session nor a force-takeover of yourself (both of which corrupt the provenance record the Worker model exists to produce). workerRef takes the same three forms as hadron_start_session — the worker\'s NAME ("Iris"), its URN (hrn:worker:<root>:<app-slug>:<slug>), or its id; an id or URN names its own App, a bare NAME needs one selected (or passed as app/session). Re-read this whenever you are unsure you are still working as the worker you bound.',
    SHAPE_HADRON_GET_WORKER,
    async ({ workerRef, app, session }) => {
      // #1081 — the caller just drove this session, so it is alive. The
      // touch is explicit here rather than a side effect of whichever tool
      // happens to write the Session row (see heartbeatSession).
      await heartbeatSession(session);
      // createTestableMcpServer bypasses zod — normalize defensively so the
      // test surface and production agree on malformed input.
      const trimmed = typeof workerRef === 'string' ? workerRef.trim() : '';
      if (trimmed === '') return textResult('Pass workerRef — a worker name, URN, or id.');

      // The NAME form is the only one that needs App context — a name is unique
      // only WITHIN an App (#990), while an id or URN names exactly one worker
      // and therefore exactly one App. Same shape test, and the same reasoning,
      // as hadron_start_session's #1005 branch: demanding a prior
      // hadron_set_active_app for a self-describing ref asks the caller to
      // state what the argument already settles.
      const refNamesItsApp = isId(trimmed) || hasSchemePrefix(trimmed);

      let appRef = app;
      if (!refNamesItsApp && !appRef) {
        // #1016's other half: the session is the durable anchor that survives a
        // transparent MCP reconnect, so try it before declaring the caller's
        // App set ambiguous.
        await adoptAppFromSession(session);
        const appScopeError = requireAppScope();
        if (appScopeError) return appScopeError;
        appRef = auth.appId;
        if (!appRef) {
          return textResult(
            `"${trimmed}" is a worker name, which is only unique within an App — pass app, pass your session, or select one with hadron_set_active_app. A worker id or URN needs none of that.`,
          );
        }
      }

      const ctx: Context = {
        db,
        clientId: auth.clientId ?? undefined,
        userId: auth.userId ?? undefined,
        apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId, // #1868: the shared authorized tx re-checks the presented key
        appId: auth.appId ?? undefined,
        sessionId: auth.sessionId ?? (await explicitActingSessionId(session)),
        roles: auth.roles as Context['roles'],
        organizationId: auth.organizationId ?? undefined,
      };
      try {
        // Delegate to the GraphQL resolver (findings:node-write-surface-
        // invariants — MCP tools delegate, never re-implement): the staff read
        // gate, the name-form gate ordering, and the WORKER_NOT_FOUND collapse
        // are all literally the code GraphQL runs. No authorization here.
        const worker = await resolvers.Query.worker(
          {},
          { ref: trimmed, appRef: refNamesItsApp ? null : appRef },
          ctx,
        );
        if (!worker) return refusalResult(`Worker not found: ${workerRef}`);

        // Resolved through the SAME field resolvers GraphQL serves, so this
        // surface and the briefing hadron_start_session prints cannot drift —
        // and `prompt` self-guards behind the worker read gate, so routing
        // through it cannot widen access. Rendering live is the whole point:
        // a copied briefing goes stale silently the moment a role agent's
        // template changes, which is why the contract forbids caching it.
        // #1090: one composition supplies the text AND its freshness facts —
        // the stamps below describe exactly this rendering.
        const [briefing, workerUrn, agent, continuity, signature, trailer, checkStatus] = await Promise.all([
          composeWorkerPrompt(ctx, worker),
          resolvers.Worker.urn(worker, {}, ctx),
          resolvers.Worker.agent(worker, {}, ctx),
          // #1029: this tool IS the post-compaction recovery read, so it must
          // carry the handoff for the same reason the bind does — an agent that
          // lost its context lost the handoff with it, and is the least likely
          // reader to know one exists.
          resolvers.Worker.continuity(worker, {}, ctx),
          resolvers.Worker.signature(worker, {}, ctx),
          resolvers.Worker.trailer(worker, {}, ctx),
          // #2138 §3.4 — gated like hasLiveSession; null on deny.
          resolvers.Worker.checkStatus(worker, {}, ctx) as Promise<WorkerCheckStatus | null>,
        ]);
        // #2045: the boot-prompt pointer, through the SAME gated field resolvers
        // GraphQL serves (null on deny, and null when unset). A read only: R24
        // keeps every pointer WRITE off MCP.
        const [bootPromptRef, bootPromptTargetDeleted] = await Promise.all([
          resolvers.Worker.bootPromptRef(worker, {}, ctx),
          resolvers.Worker.bootPromptTargetDeleted(worker, {}, ctx),
        ]);
        const prompt = briefing.text;
        const agentName = (agent as { name?: string } | null)?.name ?? null;
        const readUrl = workerPortalUrl(workerUrn as string | null);
        const placement = await resolvers.Worker.teamPlacement(worker, {}, ctx);
        const reportingHeadId = await resolvers.Worker.reportsToWorkerId(worker, {}, ctx);

        // Liveness is derived from real rows, never a lease (cor:agt:020:03) —
        // the same predicate hadron_start_session refuses WORKER_TAKEN on, and
        // hadron_list_workers reports. It answers "is someone driving this?",
        // which is what an agent unsure of its own state needs to see.
        //
        // #1114/#1120 review (Codex P2): that parity claim was TRUE of the
        // comment and FALSE of the code the moment liveness stopped being
        // `endedAt IS NULL`. An open-but-stale session would have read as
        // "driving" here while the roster said idle and a bind succeeded —
        // three surfaces, two answers, which is precisely what cor:agt:020:11
        // exists to forbid. The predicate is the shared one now.
        //
        // #1149: whether someone is driving the worker is WORKING STATE
        // (`hasLiveSession`, cor:dmo:050:11). `Query.worker` now admits a
        // signed-in caller who may see only the profile, so the taken/free flag
        // is computed for a participant alone; everyone else gets no flag.
        const nowHere0 = new Date();
        const seesWorkingState = await maySeeWorkerInternals(ctx, worker.appId);
        const openHere = !seesWorkingState ? [] : await db.session.findMany({
          // The SAME bound as the bind path, filter AND cap (#1120 review,
          // Codex P2 — second round). The first fix here took the cap without
          // the filter, which is the mistake the filter exists to prevent:
          // `startedAt: desc` is not liveness, so past the cap an OLDER
          // session with a recent heartbeat is dropped before isSessionLive
          // is asked — and this read then says `free` while the roster and
          // the binder both say taken. The cap orders a set the filter has
          // already made small; alone it silently decides the answer.
          where: {
            workerId: worker.id, endedAt: null, deletedAt: null,
            ...recentlyTouchedFilter(nowHere0),
          },
          // Heartbeat order, matching the bind path — the cap keeps a prefix,
          // so what it is ordered by decides what survives it (#1120 review).
          orderBy: [
            { updatedAt: { sort: 'desc' as const, nulls: 'last' as const } },
            { startedAt: 'desc' as const },
          ],
          select: {
            id: true, userId: true, startedAt: true,
            type: true, updatedAt: true, autoExpiredAt: true, endedAt: true, expiresAt: true,
          },
          take: OPEN_SESSION_SCAN_CAP,
        });
        const eventsHere = await loadLastEventBySession(db as never, openHere.map((r) => r.id));
        const nowHere = nowHere0;
        const liveHere = openHere.filter((r) => isSessionLive(r, eventsHere.get(r.id), nowHere));
        // TWO QUESTIONS, TWO QUERIES (#1120 review, Codex P2, twice).
        //
        // "Is anyone driving this" is about ANY live row and tolerates a cap:
        // one live session is as good as another for a taken flag. "What is MY
        // session id" tolerates neither a cap nor an ordering, because there is
        // exactly one right answer and losing it defeats the whole read — this
        // is the post-compaction recovery path.
        //
        // Selecting `mine` out of the capped set was two fixes deep and still
        // wrong: first it depended on the first row, then on surviving the
        // shared cap. Scoping the query to the caller's own sessions is what
        // actually makes the guarantee independent — and it is naturally
        // bounded, since it is one person's sessions on one worker.
        const driving = liveHere[0] ?? null;
        // #1149: the caller's own session is working state too. A departed
        // participant keeps an open row until it ends, and must not be handed
        // its id through the profile read.
        const myRows = auth.userId && seesWorkingState
          ? await db.session.findMany({
              where: {
                workerId: worker.id, endedAt: null, deletedAt: null,
                userId: auth.userId,
                ...recentlyTouchedFilter(nowHere0),
              },
              orderBy: [
                { updatedAt: { sort: 'desc' as const, nulls: 'last' as const } },
                { startedAt: 'desc' as const },
              ],
              take: OPEN_SESSION_SCAN_CAP,
              select: {
                id: true, userId: true, startedAt: true,
                type: true, updatedAt: true, autoExpiredAt: true, endedAt: true, expiresAt: true,
              },
            })
          : [];
        const myEvents = await loadLastEventBySession(db as never, myRows.map((r) => r.id));
        const mine = myRows.find((r) => isSessionLive(r, myEvents.get(r.id), nowHere)) ?? null;

        const flags: string[] = [];
        if (worker.retiredAt) flags.push('RETIRED');
        if (seesWorkingState) flags.push(driving ? 'taken' : 'free');

        return textResult(
          `**${worker.name}**${worker.role ? ` (${worker.role})` : ''}${flags.length ? ` — ${flags.join(', ')}` : ''}\n` +
            `Worker id: ${worker.id}\n` +
            (workerUrn ? `Worker URN: ${workerUrn}\n` : '') +
            // #1026: THE recovery read is also the read a worker comes to for
            // its own identity line, so the link ships beside the URN rather
            // than being assembled from it.
            (readUrl ? `URL: ${readUrl}\n` : '') +
            (placement !== null ? `Team placement: ${placement}\n` : '') +
            (reportingHeadId ? `Reports to worker: ${reportingHeadId}\n` : '') +
            (agentName ? `Role agent: ${agentName}\n` : '') +
            (checkStatus ? `${renderCheckStatusLong(checkStatus)}\n` : '') +
            // Only the caller's OWN driving session is named. Whose session it
            // is otherwise stays behind the takeover refusal, which is a
            // deliberate act rather than a listing (hadron_list_workers' rule).
            (bootPromptRef
              ? `Boot prompt pointer: ${bootPromptRef}${bootPromptTargetDeleted ? ' (TARGET DELETED: nothing can be served from it; clear or repoint it)' : ''}\n`
              : '') +
            (mine
              ? `Your active session: ${mine.id} (worker session id; pass as \`session\` to team tools; since ${mine.startedAt.toISOString()})\n`
              : '') +
            // Shown separately from the briefing, and labelled as the editable
            // part, so hadron_update_worker's replace semantics have something
            // correct to be given back.
            (signature != null ? `\nSignature template:\n${signature}\n` : '') +
            (trailer != null ? `\nTrailer template:\n${trailer}\n` : '') +
            (prompt
              ? `\nBoot briefing — adopt this for the rest of the session:` +
                `\nrendered at: ${briefing.renderedAt.toISOString()}` +
                `\nrole Agent updated at: ${briefing.roleAgentUpdatedAt ? briefing.roleAgentUpdatedAt.toISOString() : 'not recorded'} (generic Agent row update)` +
                `\n\n${prompt}`
              : briefing.refusal
                ? `\n(No boot briefing: the boot prompt cannot be served — ${briefing.refusal}.)`
                : seesWorkingState
                  ? '\n(No boot briefing: no boot prompt is served to this worker.)'
                  : '') +
            (await describeServedWorker(ctx, worker)) +
            renderWorkerContinuity(continuity as RenderableContinuity | null),
        );
      } catch (e) {
        return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : 'reading the worker failed'}`, 'hadron_get_worker');
      }
    },
  );

  // #1162: one eligibility implementation across transports.
  server.tool(
    'hadron_delete_worker',
    'Remove a never-used miscast only. Empty ended and released stints alone do not count as work. Any persisted reference blocks deletion; retire workers with history. You must first verify no signed commit, trailer, PR, comment, review or published artifact attributes work to this identity and explicitly confirm. Database checks cannot establish external absence; known or uncertain history means retire. This does not scan external hosts.',
    SHAPE_HADRON_DELETE_WORKER,
    async ({ workerRef, confirmNoExternalAttribution }) => {
      const ctx: Context = {
        db, userId: auth.userId ?? undefined, appId: auth.appId ?? undefined,
        clientId: auth.clientId ?? undefined, apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId,
        sessionId: auth.sessionId ?? undefined, organizationId: auth.organizationId ?? undefined,
        roles: auth.roles as Context['roles'],
      };
      try {
        await resolvers.Mutation.deleteWorker({}, { workerRef, confirmNoExternalAttribution }, ctx);
        return textResult('Deleted the verified unused miscast and its empty working memory.');
      } catch (error) {
        if (!(error instanceof GraphQLError)) throw error;
        return { ...textResult(`${error.extensions.code ?? 'ERROR'}: ${error.message}`), isError: true };
      }
    },
  );

  // ── hadron_update_worker ──────────────────────────────────────────────────────

  server.tool(
    'hadron_update_worker',
    "Amend a worker's signature and trailer templates (#1010). A worker's boot prompt is not edited here: it is the worker's own compiled boot source, changed by compile and approve (#2712). signature and trailer edit the per-worker signing templates (App managers only; worker-session edits provisionally refused under H26). Omit to preserve; null is refused; blank stores empty text. The name is permanent; to change the worker's agent (and with it its role) use hadron_change_worker_agent. Refuses for a retired worker.",
    SHAPE_HADRON_UPDATE_WORKER,
    async ({ workerRef, signature, trailer, app, session }) => {
      // This tool owns `session`, so the common actor gate leaves invalid names to us.
      // Refuse before heartbeat or edits instead of falling back to the human principal.
      if (session !== undefined && !(await validateSessionBinding(db, auth, session))) {
        return { ...textResult('[session_not_bound] The named session cannot bind. Nothing was written.'), isError: true };
      }
      // #1081 — the caller just drove this session, so it is alive. The
      // touch is explicit here rather than a side effect of whichever tool
      // happens to write the Session row (see heartbeatSession).
      await heartbeatSession(session);
      // Name-vs-self-describing ref handling, identical to hadron_get_worker.
      // The MUTATION takes a worker id, so a name is resolved to one FIRST
      // through the read surface — which applies the staff READ gate; the
      // staffing gate that authorizes the edit itself then runs in the
      // resolver, on the resolved row. Neither stands in for the other.
      const trimmed = typeof workerRef === 'string' ? workerRef.trim() : '';
      if (trimmed === '') return textResult('Pass workerRef — a worker name, URN, or id.');
      const refNamesItsApp = isId(trimmed) || hasSchemePrefix(trimmed);

      let appRef = app;
      if (!refNamesItsApp && !appRef) {
        await adoptAppFromSession(session);
        const appScopeError = requireAppScope();
        if (appScopeError) return appScopeError;
        appRef = auth.appId;
        if (!appRef) {
          return textResult(
            `"${trimmed}" is a worker name, which is only unique within an App — pass app, pass your session, or select one with hadron_set_active_app.`,
          );
        }
      }

      const ctx: Context = {
        db,
        clientId: auth.clientId ?? undefined,
        userId: auth.userId ?? undefined,
        apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId, // #1868: the shared authorized tx re-checks the presented key
        appId: auth.appId ?? undefined,
        ...mcpRequestSessionContext(auth),
        roles: auth.roles as Context['roles'],
        organizationId: auth.organizationId ?? undefined,
      };
      try {
        const target = await resolvers.Query.worker(
          {},
          { ref: trimmed, appRef: refNamesItsApp ? null : appRef },
          ctx,
        );
        if (!target) return refusalResult(`Worker not found: ${workerRef}`);

        // Forward a key ONLY when the caller supplied it (PR #1019 review,
        // Copilot): the resolver distinguishes omitted-preserves by PRESENCE.
        const mutationArgs: { workerRef: string; signature?: string | null; trailer?: string | null } = {
          workerRef: target.id,
        };
        const changing = signature !== undefined || trailer !== undefined;
        if (signature !== undefined) mutationArgs.signature = signature;
        if (trailer !== undefined) mutationArgs.trailer = trailer;

        const worker = await resolvers.Mutation.updateWorker({}, mutationArgs, ctx);
        // Echo the RESOLVED prompt: what the worker will be told at its next bind.
        const prompt = await resolvers.Worker.prompt(worker, {}, ctx);
        return textResult(
          (changing ? `Updated **${worker.name}**.\n` : `**${worker.name}** — no change requested (editable fields omitted).\n`) +
            (signature !== undefined ? `\nSignature template now:\n\n${worker.signature}\n` : '') +
            (trailer !== undefined ? `\nTrailer template now:\n\n${worker.trailer}\n` : '') +
            (prompt
              ? `\nResolved boot briefing (what ${worker.name} receives at its next bind):\n\n${prompt}`
              : ''),
        );
      } catch (e) {
        return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : 'updating the worker failed'}`, 'hadron_update_worker');
      }
    },
  );


  // ── hadron_change_worker_agent ────────────────────────────────────────────────

  server.tool(
    'hadron_change_worker_agent',
    "Change the agent a worker casts (#2458, cor:dmo:050:11). The worker's role follows the new agent; it is never typed in. Name, slug, URN, signature, trailer, reporting line and all past records stay, and past sessions keep the agent and role they ran under. App managers only, acting as themselves: a worker session is refused, even one its manager holds. The new agent must be installed in the App, and the App must hold the grants for it and for every Agent its boot prompt includes from. A complete change: the worker's own boot-prompt pointer is cleared, the old agent's generated tickers end and the new agent's are made, and one worker.casting event is written. It takes effect at the worker's next bind: an open session finishes under the agent and role it was bound with. A refused change changes nothing.",
    SHAPE_HADRON_CHANGE_WORKER_AGENT,
    async ({ workerRef, agent, app, session }) => {
      if (session !== undefined && !(await validateSessionBinding(db, auth, session))) {
        return { ...textResult('[session_not_bound] The named session cannot bind. Nothing was written.'), isError: true };
      }
      await heartbeatSession(session);
      // Name-vs-self-describing ref handling, identical to hadron_update_worker: a NAME resolves through the read
      // surface first; the resolver then decides the manager gate on the resolved row.
      const trimmed = typeof workerRef === 'string' ? workerRef.trim() : '';
      if (trimmed === '') return textResult('Pass workerRef — a worker name, URN, or id.');
      const refNamesItsApp = isId(trimmed) || hasSchemePrefix(trimmed);
      let appRef = app;
      if (!refNamesItsApp && !appRef) {
        await adoptAppFromSession(session);
        const appScopeError = requireAppScope();
        if (appScopeError) return appScopeError;
        appRef = auth.appId;
        if (!appRef) {
          return textResult(
            `"${trimmed}" is a worker name, which is only unique within an App — pass app, pass your session, or select one with hadron_set_active_app.`,
          );
        }
      }
      const ctx: Context = {
        db,
        clientId: auth.clientId ?? undefined,
        userId: auth.userId ?? undefined,
        apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId,
        appId: auth.appId ?? undefined,
        ...mcpRequestSessionContext(auth),
        roles: auth.roles as Context['roles'],
        organizationId: auth.organizationId ?? undefined,
      };
      try {
        const target = await resolvers.Query.worker({}, { ref: trimmed, appRef: refNamesItsApp ? null : appRef }, ctx);
        if (!target) return textResult(`Worker not found: ${workerRef}`);
        const worker = await resolvers.Mutation.changeWorkerAgent({}, { workerRef: target.id, agentRef: agent }, ctx);
        return textResult(
          `**${worker.name}** now casts agent ${worker.agentId}${worker.role ? ` (role ${worker.role})` : ''}. ` +
            'It takes effect at the next bind.',
        );
      } catch (e) {
        // #1789: a typed refusal keeps its [code] text; anything else is a fault and gets the generic envelope.
        return toolErrorResult(e, () => `[${String((e as GraphQLError).extensions?.code ?? 'ERROR')}] ${(e as Error).message}`, 'hadron_change_worker_agent');
      }
    },
  );


  // ── hadron_set_worker_reports_to ───────────────────────────────────────────

  server.tool(
    'hadron_set_worker_reports_to',
    "#1726 — set, hand over or clear who a worker reports to: one other, non-retired worker of the same App (never itself, never a cycle). It belongs to the casting, not to a session, so it outlasts session rotation and a dormant team; every change is a `worker.reports-to` team event. Who may change it: whoever manages the App; the worker it reports to now (handing it over or clearing it is its agreement); for a worker that reports to nobody, also a worker claiming it for itself when one person holds both, or its own holder (interim rule, pending a ruling). A worker acts through its bound session, so pass `session`. Informational: nothing is refused on the strength of it except the task authority cor:agt:050:09 gives a worker over the tasks of workers that report to it.",
    SHAPE_HADRON_SET_WORKER_REPORTS_TO,
    async ({ workerRef, reportsTo, app }) => {
      const trimmed = workerRef.trim();
      if (trimmed === '') return textResult('Pass workerRef — a worker name, URN, or id.');
      const target = typeof reportsTo === 'string' ? reportsTo.trim() : null;
      const needsApp = [trimmed, target].some((r) => r && !(isId(r) || hasSchemePrefix(r)));
      let appRef = app;
      if (needsApp && !appRef) {
        const appScopeError = requireAppScope();
        if (appScopeError) return appScopeError;
        appRef = auth.appId ?? undefined;
      }
      const ctx: Context = {
        db,
        clientId: auth.clientId ?? undefined,
        userId: auth.userId ?? undefined,
        apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId, // #1868: the shared authorized tx re-checks the presented key
        appId: auth.appId ?? undefined,
        sessionId: auth.sessionId ?? undefined,
        roles: auth.roles as Context['roles'],
        organizationId: auth.organizationId ?? undefined,
      };
      try {
        const resolveRef = async (ref: string) => {
          const w = await resolvers.Query.worker({}, { ref, appRef: isId(ref) || hasSchemePrefix(ref) ? null : appRef }, ctx);
          if (!w) throw new Error(`Worker not found: ${ref}`);
          return w.id as string;
        };
        const workerId = await resolveRef(trimmed);
        const toId = target ? await resolveRef(target) : null;
        const worker = await resolvers.Mutation.setWorkerReportsTo({}, { workerRef: workerId, reportsTo: toId }, ctx);
        const to = worker.reportsToWorkerId ? await db.worker.findUnique({ where: { id: worker.reportsToWorkerId }, select: { name: true } }) : null;
        return textResult(to ? `**${worker.name}** now reports to **${to.name}**.` : `**${worker.name}** now has explicit no team.`);
      } catch (e) {
        return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : 'changing who the worker reports to failed'}`, 'hadron_set_worker_reports_to');
      }
    },
  );
  // ── hadron_record_work / hadron_team_work_items ───────────────────────────────

  server.tool(
    'hadron_record_work',
    'Record an externally visible work milestone (a PR opened, a branch pushed, an issue closed) into the team App\'s worklog (#947) — the append-only, authoritative PR-session join. Pass the session doing the work; ref accepts a github URL or short form (owner/repo#N, owner/repo@sha, owner/repo:branch, owner/repo) and is stored in ONE canonical spelling. A bare number is refused — include the repo. kind: pr also updates the session\'s displayed PR number. Correct a wrong record by recording a newer one (records are never edited). Capability note (#1398): the optional `model` argument is honored when hadron_server_info advertises the `worklog-model` capability — an older build silently DROPS the argument and records the session\'s model instead, so test for the token before relying on an explicit model report.',
    SHAPE_HADRON_RECORD_WORK,
    async ({ session, tool, kind, ref, action, detail, model, app }) => {
      // #1081 — the caller just drove this session, so it is alive. The
      // touch is explicit here rather than a side effect of whichever tool
      // happens to write the Session row (see heartbeatSession).
      await heartbeatSession(session);
      // Delegate to the GraphQL resolver (findings:node-write-surface-
      // invariants — MCP tools delegate, never re-implement). App default
      // mirrors hadron_cast_worker: requireAppScope() runs BEFORE reading
      // auth.appId so the omit-app flow honors hadron_set_active_app.
      let appRef = app;
      if (!appRef) {
        // #1005: the session names its App (here it is REQUIRED), so scope is
        // recoverable without a prior hadron_set_active_app.
        await adoptAppFromSession(session);
        const appScopeError = requireAppScope();
        if (appScopeError) return appScopeError;
        appRef = auth.appId;
        if (!appRef) {
          return textResult('No App context — pass the app parameter or select one with hadron_set_active_app.');
        }
      }
      try {
        const item = await resolvers.Mutation.recordTeamWork(
          {},
          { appRef, sessionRef: session, tool, kind, ref, action, detail: detail ?? null, model: model ?? null },
          {
            db,
            clientId: auth.clientId ?? undefined,
            userId: auth.userId ?? undefined,
            apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId, // #1868: the shared authorized tx re-checks the presented key
            appId: auth.appId ?? undefined,
            sessionId: auth.sessionId ?? undefined,
            roles: auth.roles as Context['roles'],
            organizationId: auth.organizationId ?? undefined,
          },
        );
        // #1053 — SAY when the session has already ended.
        //
        // Recording against an ended session is deliberate and durable law
        // (cor:agt:020:05: "an ended session may be recorded against — late
        // attribution is the worklog's point: a merge lands after the session
        // ends"). The chat refuses the same session because speech needs a live
        // speaker; the worklog is record-keeping. Both are right.
        //
        // What was wrong is that this tool said NOTHING. A worker whose binding
        // had been reaped recorded two milestones, got two clean receipts, and
        // would have finished the stint believing it was still bound — the only
        // thing that revealed the loss was a chat post it happened to make
        // afterwards. Worse, the guidance in every briefing named THIS tool as
        // one that "at least fails loudly", so a successful receipt read as
        // positive evidence the binding was alive.
        //
        // So the fix is the signal, not a refusal: keep the record, and put the
        // state in the reader's path at the one moment they would otherwise be
        // misled. Best-effort — a receipt must never turn a committed record
        // into an error.
        let endedNote = '';
        try {
          const s = await db.session.findUnique({
            where: { id: item.sessionId },
            select: { endedAt: true, autoExpiredAt: true, endReason: true },
          });
          if (s?.endedAt) {
            endedNote =
              `\n\n⚠ This session ALREADY ENDED at ${s.endedAt.toISOString()}` +
              ` — end reason: ${sessionEndReason(s)}.` +
              ' The record is kept, and further records against it will be too:' +
              ' late attribution is what the worklog is for.' +
              ' What you no longer have is a LIVE binding: the team chat will refuse to author' +
              ' as this worker through it. Start a new session before doing more work as this' +
              ' worker.' +
              ' hadron_whoami lists what you are actually driving.';
          }
        } catch {
          // Swallowed: the record is committed and the receipt is decoration.
        }
        return textResult(
          `Recorded: ${item.kind} ${item.action} ${item.ref} — session ${item.sessionId} (${item.workerName}) at ${item.at.toISOString()}.` +
            (item.model ? ` Model: ${item.model}.` : '') +
            endedNote,
        );
      } catch (e) {
        return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : 'work record failed'}`, 'hadron_record_work');
      }
    },
  );

  server.tool(
    'hadron_team_work_items',
    'Read the team App\'s worklog (#947) — the provenance query. Two directions: which sessions produced this PR/artifact (pass ref as a github URL or owner/repo#N, owner/repo@sha, owner/repo:branch, owner/repo; an ownerless cli#793 matches every readable repo whose name ends in cli, never guesses an owner), and what has one WORKER done (pass worker, by name, id or URN — #1035; a retired worker still resolves, because retirement ends the casting, not the history). Newest first. Filter further by session, tool, or kind, and combine filters freely. Each item carries the sessionId; read the session for its transcript path.',
    SHAPE_HADRON_TEAM_WORK_ITEMS,
    async ({ ref, session, worker, tool, kind, limit, offset, app }) => {
      // #1081 — the caller just drove this session, so it is alive. The
      // touch is explicit here rather than a side effect of whichever tool
      // happens to write the Session row (see heartbeatSession).
      await heartbeatSession(session);
      let appRef = app;
      if (!appRef) {
        // #1005: the optional session filter doubles as an App-resolution hint.
        const scopedBySession = await adoptAppFromSession(session);
        // #1037/PR #1051 review: a SELF-DESCRIBING worker ref names its own App
        // too. Gated on whether the session ACTUALLY established scope, not on
        // whether a session string was supplied (Codex P2): `adoptAppFromSession`
        // deliberately does nothing for a stale session, or one belonging to a
        // teammate, and the mere presence of the argument then suppressed the
        // worker fallback — leaving a caller who may read this worklog with "no
        // active App" while holding a ref that identifies the App unambiguously.
        // A session that DID establish scope still wins: it is the caller's own
        // binding and the more specific statement.
        if (!scopedBySession) await adoptAppFromWorker(worker);
        const appScopeError = requireAppScope();
        if (appScopeError) return appScopeError;
        appRef = auth.appId;
        if (!appRef) {
          return textResult('No App context — pass the app parameter or select one with hadron_set_active_app.');
        }
      }
      try {
        const page = await resolvers.Query.teamWorkItems(
          {},
          {
            appRef,
            ref: ref ?? null,
            sessionRef: session ?? null,
            workerRef: worker ?? null,
            tool: tool ?? null,
            kind: kind ?? null,
            limit: limit ?? null,
            offset: offset ?? null,
          },
          {
            db,
            clientId: auth.clientId ?? undefined,
            userId: auth.userId ?? undefined,
            apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId, // #1868: the shared authorized tx re-checks the presented key
            appId: auth.appId ?? undefined,
            sessionId: auth.sessionId ?? undefined,
            roles: auth.roles as Context['roles'],
            organizationId: auth.organizationId ?? undefined,
          },
        );
        if (page.total === 0) return textResult('No matching worklog records.');
        const lines = page.items.map(
          (i) =>
            `${i.at.toISOString()} [${i.workerName}] ${i.kind} ${i.action} ${i.ref} (session ${i.sessionId})${i.model ? ` [model: ${i.model}]` : ''}`,
        );
        return textResult(
          `${page.total} record(s) total, showing ${page.items.length}:\n\n${lines.join('\n')}`,
        );
      } catch (e) {
        return toolErrorResult(e, () => `Error: ${e instanceof Error ? e.message : 'worklog read failed'}`, 'hadron_team_work_items');
      }
    },
  );

  // ── hadron_validate ───────────────────────────────────────────────────────────

  server.tool(
    'hadron_validate',
    'Check a memory for broken edge references, sparse nodes (non-object nodes with no description, content or abstract; object nodes are exempt, #2516), stale-abstract warnings (spec 032 FR-011 — abstract no longer reflects current content), embedding-failure flags (spec 033 — nodes with `embedding_failed_at` set; covers BOTH in-flight transient failures awaiting retry AND terminal failures, including the #206 encrypted-no-plaintext perma-fail class), and property-schema conformance (#725 — a node whose objectType/properties violate the memory\'s declared schema; catches records written before the schema was defined/tightened, a non-destructive audit). The memory URN MUST be fully qualified. On encrypted memories the stale-abstract check is skipped in v1 (hadron_validate does not decrypt; tracked by #206).',
    SHAPE_HADRON_VALIDATE,
    async ({ memoryUrn }) => {
      // Spec 022: qualification at the API boundary.
      try {
        assertFullyQualifiedUrn(memoryUrn, 'memory');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return refusalResult(e.message);
        throw e;
      }

      // #1316: an unreadable memory takes the missing branch.
      const memory = await resolveVisibleMemoryByUrn(auth, memoryUrn, 'read');
      if (!memory) {
        return refusalResult(`Memory not found: "${memoryUrn}".`);
      }

      // #819 — the checks themselves now live in src/lib/memoryValidation.ts,
      // shared with the GraphQL `validateMemory` query so the two surfaces
      // cannot drift on what "healthy" means. This handler keeps the prose
      // rendering (and its historical wording); the query returns the same
      // findings typed.
      const report = await validateMemoryNodes(db, memory.id);
      const issues: string[] = [];
      const memoryUrnOf = memoizedMemoryUrnLookup();
      for (const f of report.findings) {
        issues.push(formatFindingLine(f, await nodeUrn(f.nodeLoc, memory.id, memoryUrnOf)));
      }
      // A skipped check is stated rather than silently omitted — a clean bill
      // of health that quietly skipped a check is worse than no report.
      const skippedNote = report.skippedChecks.length
        ? `\n\nSkipped checks:\n${report.skippedChecks.map((c) => `- ${c.check}: ${c.reason}`).join('\n')}`
        : '';

      if (issues.length === 0) {
        return textResult(`Validated ${report.nodesChecked} nodes. No issues found.${skippedNote}`);
      }
      return textResult(
        `Found ${issues.length} issue(s) in ${report.nodesChecked} nodes:\n\n${issues.join('\n')}${skippedNote}`,
      );
    },
  );

  // ── hadron_sync_graph ─────────────────────────────────────────────────────────

  server.tool(
    'hadron_sync_graph',
    'Trigger an on-demand sync for a memory from its GitHub source. The memory URN MUST be fully qualified.',
    SHAPE_HADRON_SYNC_GRAPH,
    async ({ memoryUrn }) => {
      // Spec 022: qualification at the API boundary.
      try {
        assertFullyQualifiedUrn(memoryUrn, 'memory');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return refusalResult(e.message);
        throw e;
      }

      // #1316: hidden from this caller ⇒ the missing branch; a reader keeps the denial.
      const memoryRef = await resolveVisibleMemoryByUrn(auth, memoryUrn, 'write');
      if (!memoryRef) return refusalResult(`Memory not found: "${memoryUrn}".`);
      if (!(await canWriteToMemory(db, auth, memoryRef.id, EXPLICIT_REF))) {
        return refusalResult('Access denied.');
      }

      const memory = await db.memory.findUnique({
        where: { id: memoryRef.id },
        include: { organization: true },
      });
      if (!memory) return refusalResult('Memory not found.');
      // R206 / cor:sec:040:05: an encrypted memory gets the typed refusal from the sync itself
      // even with no source, so the no-source reply never reads as a healthy sync.
      if (!memory.source && !memory.isEncrypted) return textResult('Memory has no source repository configured.');

      // Import and call syncGraphFromGithub
      const { syncGraphFromGithub, describeSyncOutcome } = await import('../integrations/github/syncGraphFromGithub.js');
      const result = await syncGraphFromGithub(memory as Parameters<typeof syncGraphFromGithub>[0]);

      if (result.fault) throw new Error(result.error ?? 'sync fault');
      if (result.error) return refusalResult(`Sync failed${result.errorCode ? ` [${result.errorCode}]` : ''}: ${result.error}`);
      // #1061 — one write per node the sync actually wrote. This tool is the
      // ONE entry point to a git sync that has a principal to attribute to; the
      // webhook and startup batch-loop callers deliberately drop `writtenNodes`
      // on the floor, because an unattended sync is nobody's usage.
      recordNodeUsage(db, 'write', result.writtenNodes ?? [], auth);
      // #1330 / #1411 review — refused, deferred and held files are skipped,
      // not failed; say so, or the caller reads a clean sync.
      return textResult(describeSyncOutcome(result));
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Transport management — one transport per MCP session
// ---------------------------------------------------------------------------

type ActiveMcpTransport = {
  transport: StreamableHTTPServerTransport;
  /** Mutated only while holding this transport's request lock. */
  auth: AuthContext;
  /**
   * Settled by the previous POST after BOTH role refresh and dispatch.
   * Auth is captured by every tool closure, so those two steps are one
   * authorization critical section rather than independent operations.
   */
  requestTail: Promise<void>;
  /** #2261: tagged key of the credential that opened this transport (`mcpPrincipalKey`). */
  principalKey: string;
  /**
   * #2261: requests holding this transport right now, counted off the Node response (arrival to `close`/`finish`),
   * so a GET/SSE stream, a POST queued behind `requestTail` and a still-open response all pin it.
   */
  inFlight: number;
  /** #2261: arrival or completion time of the latest request (epoch ms). */
  lastActivityAt: number;
};

const transports = new Map<string, ActiveMcpTransport>();

/**
 * #2261: new-session capacity reserved by initializes that have authenticated but not yet registered, per
 * principal key. A reservation is taken synchronously (no await between the cap check and the increment),
 * so concurrent initializes cannot jointly exceed the cap, and is released exactly once: on conversion to a
 * registered entry, on any exit of the handler, or when the response ends, whichever comes first.
 */
const mcpSessionReservations = new Map<string, number>();

/** Marks one more request in flight on `active`; the returned function releases it (idempotent). */
function holdMcpTransport(active: ActiveMcpTransport, res: Response): () => void {
  active.inFlight += 1;
  active.lastActivityAt = Date.now();
  return releaseOnceOnResponseEnd(res, () => {
    active.inFlight -= 1;
    active.lastActivityAt = Date.now();
  });
}

/**
 * Drops a transport from the registry synchronously (so its capacity frees at once), then closes it.
 * Same cleanup as `onclose`/DELETE via `unregisterMcpTransport`; connection-local state only, never the durable
 * worker Session or its hold.
 */
function evictMcpTransport(sessionId: string, active: ActiveMcpTransport, reason: 'idle' | 'cap'): void {
  if (transports.get(sessionId) !== active) return;
  unregisterMcpTransport(sessionId, active.transport);
  mcpLog('info', 'mcp_transport_evicted', { mcpSessionId: sessionId, reason, principalKey: active.principalKey });
  void active.transport.close().catch(() => undefined);
}

/**
 * Idle rule (distinct from the cap rule): a transport is evicted when it has NO request in flight AND has been
 * quiet longer than the TTL. Re-checked per entry immediately before eviction, synchronously, so a request that
 * arrives between the scan and the close wins.
 */
export function sweepIdleMcpTransports(now: number = Date.now()): number {
  const ttl = idleTtlMs();
  let evicted = 0;
  for (const [sid, active] of [...transports]) {
    if (active.inFlight === 0 && now - active.lastActivityAt > ttl) {
      evictMcpTransport(sid, active, 'idle');
      evicted += 1;
    }
  }
  return evicted;
}

/**
 * #2261 cap rule (distinct from the idle rule): reserve one new-session slot for `principalKey`, evicting that
 * principal's least-recently-active transport WITH NOTHING IN FLIGHT to make room, without waiting for the TTL.
 * Nothing awaits between the count and the reservation, so concurrent initializes cannot jointly exceed the cap.
 * When every live transport of the principal is in flight (or reserved), answers 429 and returns null: no live
 * request is ever evicted. Release the returned function on conversion; it also fires when the response ends.
 */
/** Whether the response ended or died BEFORE this handler started to answer it (nothing legitimate ends first). */
function isResponseTerminal(res: Response): boolean {
  return res.destroyed || res.writableEnded;
}

/** Whether the client went away: the socket is gone and the response never finished normally. */
function isResponseAborted(res: Response): boolean {
  return res.destroyed && !res.writableFinished;
}

/** A held new-session slot; see `reserveMcpSession`. */
export type McpSessionReservation = {
  /** Registers the slot: true once, false if it was cancelled or the response is already terminal. */
  convert(): boolean;
  /** Gives the slot back on a failure path; idempotent, and a later convert() is refused. */
  cancel(): void;
};

export function reserveMcpSession(principalKey: string, res: Response): McpSessionReservation | null {
  // `close`/`finish` events do not replay: a response that ended while authentication was awaited has already
  // fired them, so listeners attached below would never run. Check the terminal state directly (review, Andi P2).
  if (isResponseTerminal(res)) return null;
  const cap = maxSessionsPerPrincipal();
  const live = (): number => {
    let n = mcpSessionReservations.get(principalKey) ?? 0;
    for (const a of transports.values()) if (a.principalKey === principalKey) n += 1;
    return n;
  };
  while (live() >= cap) {
    let oldest: [string, ActiveMcpTransport] | null = null;
    for (const entry of transports) {
      const [, a] = entry;
      if (a.principalKey !== principalKey || a.inFlight > 0) continue;
      if (!oldest || a.lastActivityAt < oldest[1].lastActivityAt) oldest = entry;
    }
    if (!oldest) {
      res.setHeader('Retry-After', String(CAP_RETRY_AFTER_SECONDS));
      res.status(429).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: `Too many open MCP sessions for this credential (limit ${cap}). Close one and retry.` },
        id: null,
      });
      return null;
    }
    evictMcpTransport(oldest[0], oldest[1], 'cap');
  }
  mcpSessionReservations.set(principalKey, (mcpSessionReservations.get(principalKey) ?? 0) + 1);
  // Terminal state: `held` ends exactly once, as `converted` (registered) or `cancelled` (the response ended first).
  // A suspended initialize whose response already ended must NOT register afterwards: its slot was freed.
  let state: 'held' | 'converted' | 'cancelled' = 'held';
  const free = (): void => {
    const left = (mcpSessionReservations.get(principalKey) ?? 1) - 1;
    if (left <= 0) mcpSessionReservations.delete(principalKey);
    else mcpSessionReservations.set(principalKey, left);
  };
  const cancel = (): void => {
    if (state !== 'held') return;
    state = 'cancelled';
    free();
  };
  // A normal `finish` is NOT a cancellation: the initialize response is written before the handler converts.
  res.once('close', () => {
    if (isResponseAborted(res)) cancel();
  });
  return {
    convert(): boolean {
      // A terminal response whose event was missed must not convert either (belt and braces with the listeners).
      if (state === 'held' && isResponseAborted(res)) cancel();
      if (state !== 'held') return false;
      state = 'converted';
      free();
      return true;
    },
    cancel,
  };
}

let mcpTransportSweepTimer: NodeJS.Timeout | null = null;

/** Starts the idle-transport sweep on its OWN timer (not the session reaper's, so one flag cannot disable both). */
export function startMcpTransportSweepLoop(): void {
  if (mcpTransportSweepTimer) return;
  mcpTransportSweepTimer = setInterval(() => {
    try {
      sweepIdleMcpTransports();
    } catch (err) {
      mcpLog('error', 'mcp_transport_sweep_failed', { message: err instanceof Error ? err.message : String(err) });
    }
  }, SWEEP_INTERVAL_MS);
  mcpTransportSweepTimer.unref?.();
}

/** Stops the sweep (server shutdown). */
export function stopMcpTransportSweepLoop(): void {
  if (mcpTransportSweepTimer) clearInterval(mcpTransportSweepTimer);
  mcpTransportSweepTimer = null;
}

/** Test seam: sweep as of `now`. */
export async function sweepIdleMcpTransportsForTests(now: number): Promise<number> {
  const n = sweepIdleMcpTransports(now);
  await new Promise((r) => setTimeout(r, 25)); // let the closes settle
  return n;
}

/** Test seam: a snapshot of the registry and the per-session side maps. */
export function mcpTransportStateForTests(): {
  sessionIds: string[];
  entries: Record<string, { inFlight: number; lastActivityAt: number; principalKey: string }>;
  reservations: number;
  sweepTimerRunning: boolean;
  sideMapKeys: { activeApp: string[]; workerSessions: string[]; sharedConnections: string[]; actorsSeen: string[] };
} {
  const entries: Record<string, { inFlight: number; lastActivityAt: number; principalKey: string }> = {};
  for (const [sid, a] of transports) entries[sid] = { inFlight: a.inFlight, lastActivityAt: a.lastActivityAt, principalKey: a.principalKey };
  let reservations = 0;
  for (const n of mcpSessionReservations.values()) reservations += n;
  return {
    sessionIds: [...transports.keys()],
    entries,
    reservations,
    sweepTimerRunning: mcpTransportSweepTimer !== null,
    sideMapKeys: {
      activeApp: [...activeAppByMcpSession.keys()],
      workerSessions: [...workerSessionsByMcpSession.keys()],
      sharedConnections: [...sharedMcpConnections.keys()],
      actorsSeen: [...actorsSeenByMcpSession.keys()],
    },
  };
}

/**
 * Spec 026 — per-MCP-session active App, used by both regime (b)
 * (directory-aware, seeded from `initialize` capability parameter) and
 * regime (c) (session-scoped, set by the `hadron_set_active_app` tool).
 * Keyed by transport `sessionId`. Cleaned up in `transport.onclose`
 * alongside `transports.delete(sid)`. Single-replica only per spec 026
 * §Clarifications Q3; horizontal scale-out requires either sticky
 * sessions or persistent `McpSessionState` first.
 */
/**
 * #1009 — when this process last answered a stale `Mcp-Session-Id` with the
 * recovery 404, or `null` if it never has.
 *
 * The reconnect that matters is a two-request exchange with nothing linking its
 * halves: the stale call carries a session id we reject, and the client's
 * re-`initialize` deliberately carries NO session header. The 404 is answered
 * before auth is resolved (by design — learning "session not found" needs no
 * credential), so there is no principal to correlate on either.
 *
 * So the correlation is at PROCESS level: if this server has recently had to
 * tell someone their session is gone, it is serving clients that had sessions
 * before — the post-restart state — and a session opened inside that window is
 * very likely a revival.
 *
 * A HEURISTIC, and deliberately biased toward false POSITIVES: the cost of
 * wrongly mentioning a reconnect is one extra sentence to a caller who had no
 * selection to lose, while the cost of missing one is the original bug, where
 * the agent concludes its client is broken. The reconnect note is worded to
 * stay true under a false positive ("if you had selected…"), which is what
 * makes that trade safe.
 */
let lastStaleSessionAt: number | null = null;

/** How long after a stale-session 404 a new session still reads as a revival. */
const RECONNECT_CORRELATION_WINDOW_MS = 5 * 60 * 1000;

/** Whether a session opening right now plausibly replaces one this process lost. */
function isLikelyReconnect(presentedStaleSessionId: string | undefined): boolean {
  // A client that re-initialized while still sending its old session id is
  // certain, not heuristic — a known session returned long before this point.
  if (presentedStaleSessionId) return true;
  if (lastStaleSessionAt === null) return false;
  return Date.now() - lastStaleSessionAt <= RECONNECT_CORRELATION_WINDOW_MS;
}

/** Test seam: forget any observed stale-session 404 (see the heuristic above). */
export function __resetReconnectCorrelationForTests(): void {
  lastStaleSessionAt = null;
}

const activeAppByMcpSession = new Map<
  string,
  { appId: string; organizationId: string | null }
>();

/**
 * DAC (Holger, 2026-10-05; #1610 follow-on): the Hadron sessions
 * `hadron_start_session` bound on this MCP connection, oldest first. Later
 * requests on the connection write as the bound Worker / Agent, re-validated
 * every time through the same ownership check as the X-Hadron-Session header,
 * so a session that has since ended or changed hands stops attributing at
 * once. An explicit header, or a tool call's own `session` argument, wins. Per
 * transport, like the active App: a reconnect starts unbound until the client
 * starts or names a session again.
 *
 * A LIST, not one id (#1701): a desktop host can carry several chat sessions
 * over ONE MCP connection, each binding its own worker. Keeping only the last
 * bind credited every chat session's writes to whoever bound last (Gil's node
 * read "Created by: worker Cody"). With every binding kept, a connection whose
 * live bindings name more than one actor is AMBIGUOUS, and a write that does
 * not say which caller it is gets refused rather than guessed at.
 */
const workerSessionsByMcpSession = new Map<string, string[]>();

/**
 * Connections that may be shared: ones on which two different actors have
 * EVER been bound, overlapping or not (PR #1702 reviews, Codex P1 twice).
 * Sticky until the transport goes away.
 *
 * Ending a Hadron session does not end the chat session that drove it, so
 * the live-binding list proves nothing about who is still calling. Chat A
 * binds Iris and ends it, chat B binds Dara, and A's next unnamed write looks
 * EXACTLY like one chat session that switched from Iris to Dara: the server
 * cannot tell the two apart, so it must not pick one. On a connection in this
 * set, a caller whose session has ended is one more possible caller, its
 * actor nobody, so an unnamed write is refused while any worker or agent
 * binding is live, and the caller must name its session. The price is that a
 * single chat session that switches workers names its session too. Re-binding
 * the SAME worker (a rotation) never marks a connection.
 */
const sharedMcpConnections = new Set<string>();

/** Every actor ever bound on a connection, keyed by {@link actorKey}. */
const actorsSeenByMcpSession = new Map<string, Set<string>>();

/**
 * Record a session bound on this connection (#1701: appended, never
 * replacing). A plain session is recorded too: its actor is nobody, and it
 * counts as one more candidate when the connection's bindings are compared.
 *
 * UNCAPPED on purpose (PR #1702 review, Codex P2): a cap that dropped the
 * oldest entry could drop a LIVE binding — bind A, then supersede B's session
 * 32 times — and hand A's chat session's writes to B, the very failure this
 * list exists to prevent. The list stays short without one: each bind runs
 * liveConnectionBindings for its receipt, and every header-less request runs
 * it before dispatch, and both prune the entries that no longer validate. So
 * the list holds the connection's live bindings plus at most the one being
 * added. A superseded session is ended, so it validates no longer.
 */
function rememberConnectionBinding(
  mcpSessionId: string,
  hadronSessionId: string,
  actor: { workerId: string | null; agentId: string | null },
): void {
  const list = (workerSessionsByMcpSession.get(mcpSessionId) ?? []).filter((id) => id !== hadronSessionId);
  list.push(hadronSessionId);
  workerSessionsByMcpSession.set(mcpSessionId, list);
  const seen = actorsSeenByMcpSession.get(mcpSessionId) ?? new Set<string>();
  seen.add(actorKey(actor));
  actorsSeenByMcpSession.set(mcpSessionId, seen);
  if (seen.size > 1) sharedMcpConnections.add(mcpSessionId);
}

/**
 * The connection's bindings that still validate, oldest first, pruning the
 * rest from the map. One validation per remembered session, each through the
 * shared {@link validateSessionBinding} gate.
 */
async function liveConnectionBindings(
  mcpSessionId: string,
  principal: AuthContext,
): Promise<Array<{ sessionId: string; actor: { workerId: string | null; agentId: string | null } }>> {
  const remembered = workerSessionsByMcpSession.get(mcpSessionId);
  if (!remembered?.length) return [];
  const live = [];
  for (const id of remembered) {
    const valid = await validateSessionBinding(db, principal, id);
    if (valid) live.push(valid);
  }
  if (live.length) workerSessionsByMcpSession.set(mcpSessionId, live.map((b) => b.sessionId));
  else workerSessionsByMcpSession.delete(mcpSessionId);
  return live;
}

/**
 * Is the next unnamed write on this connection ambiguous? It is when its live
 * bindings name more than one actor, or when the connection is known shared
 * and any live binding names a worker or agent, since "a caller whose session
 * ended" (nobody) is then a candidate too. Never ambiguous with no live
 * binding: every candidate is nobody.
 */
function connectionIsAmbiguous(
  mcpSessionId: string,
  live: Array<{ actor: { workerId: string | null; agentId: string | null } }>,
): boolean {
  if (!live.length) return false;
  if (distinctActorCount(live) > 1) return true;
  return sharedMcpConnections.has(mcpSessionId) && live.some((b) => b.actor.workerId || b.actor.agentId);
}

/** One actor's identity for comparison: its Worker and Agent ids ("/" for nobody). */
function actorKey(actor: { workerId: string | null; agentId: string | null }): string {
  return `${actor.workerId ?? ''}/${actor.agentId ?? ''}`;
}

/** The distinct Worker / Agent identities among a set of bindings. */
function distinctActorCount(bindings: Array<{ actor: { workerId: string | null; agentId: string | null } }>): number {
  return new Set(bindings.map((b) => actorKey(b.actor))).size;
}

/**
 * Publish the connection's bound actor for this request (DAC). A request that
 * NAMES a session in X-Hadron-Session has spoken for itself even when that
 * header failed validation: it then writes as nobody, never as the
 * connection's worker (#1665 review).
 *
 * #1701: when the live bindings name more than one actor, nothing here can
 * tell which chat session sent the request, so it publishes an AMBIGUOUS
 * actor (nobody, with the candidates) and the per-tool gate in
 * createMcpServerInstance decides: a call naming its `session` proceeds as
 * that session, a writing call without one is refused SESSION_AMBIGUOUS.
 */
async function publishConnectionActor(mcpSessionId: string, presented: AuthContext, headerPresented: boolean): Promise<void> {
  if (headerPresented || presented.sessionId) return;
  const live = await liveConnectionBindings(mcpSessionId, presented);
  if (!live.length) return;
  if (connectionIsAmbiguous(mcpSessionId, live)) {
    publishAmbiguousActor(live.map((b) => b.sessionId));
    return;
  }
  publishActor(live[live.length - 1].actor);
}

function respondMcpSessionNotFound(res: Response): void {
  res.status(404).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Session not found' },
    id: null,
  });
}

/** A transport session belongs to the principal that authenticated its initialize request. */
function sameMcpPrincipal(bound: AuthContext, presented: AuthContext): boolean {
  if (bound.userId) return presented.userId === bound.userId && !presented.impersonation;
  // An App key's scopes distinguish keys of one App (#1749): a transport belongs to the EXACT key that opened it, so a
  // returning request signed with another key of the same App can borrow neither its scope, its proof identity nor its audit.
  if (bound.appKeyId) return presented.appKeyId === bound.appKeyId && !presented.userId;
  if (bound.appId) return presented.appId === bound.appId && !presented.userId;
  return !!bound.clientId && presented.clientId === bound.clientId;
}

/** Reuse the initialization 401 challenge for every known-session request. */
function respondMcpAuthenticationRequired(req: Request, res: Response): void {
  const origin = getServerOrigin(req);
  if (!origin) {
    res.status(400).json({ error: 'Missing Host header' });
    return;
  }
  const prmUrl = `${origin}/.well-known/oauth-protected-resource`;
  res.setHeader(
    'WWW-Authenticate',
    `Bearer realm="hadron", error="invalid_token", resource_metadata="${prmUrl}"`,
  );
  res.status(401).json({ error: 'Authentication required' });
}

/**
 * A session ID routes to a transport; it never authenticates its bearer. The
 * bearer must still be live, MCP-scoped, and bound to this transport's principal.
 * Recheck the exact transport after credential resolution, which may await DB.
 */
async function authenticateBoundMcpSession(
  req: Request,
  res: Response,
  sessionId: string,
  active: ActiveMcpTransport,
): Promise<AuthContext | null> {
  let presented: AuthContext;
  try {
    presented = await resolveAuthContext(req, db);
  } catch {
    res.status(503).json({ error: 'Authentication temporarily unavailable' });
    return null;
  }
  if (transports.get(sessionId) !== active) {
    respondMcpSessionNotFound(res);
    return null;
  }
  if (presented.impersonation || (!presented.userId && !presented.appId && !presented.clientId)) {
    respondMcpAuthenticationRequired(req, res);
    return null;
  }
  const surfaceRefusal = oauthSurfaceRefusal(presented, 'mcp');
  if (surfaceRefusal) {
    res.setHeader('WWW-Authenticate', 'Bearer error="insufficient_scope", scope="mcp"');
    res.status(403).json({
      error: oauthSurfaceRefusalMessage(surfaceRefusal, 'This OAuth credential does not grant MCP access'),
      code: 'FORBIDDEN',
      ...surfaceRefusal,
    });
    return null;
  }
  if (!sameMcpPrincipal(active.auth, presented)) {
    // A foreign principal's session ID is indistinguishable from a missing one.
    respondMcpSessionNotFound(res);
    return null;
  }
  return presented;
}

/**
 * Remove state owned by one concrete transport. Session IDs can be reused by
 * a reconnecting initialize request while an older transport is still closing;
 * cleanup from the old instance must never erase that replacement's state.
 */
function unregisterMcpTransport(
  sessionId: string,
  transport: StreamableHTTPServerTransport,
): boolean {
  const registered = transports.get(sessionId);
  if (registered && registered.transport !== transport) return false;
  transports.delete(sessionId);
  activeAppByMcpSession.delete(sessionId);
  workerSessionsByMcpSession.delete(sessionId);
  sharedMcpConnections.delete(sessionId);
  actorsSeenByMcpSession.delete(sessionId);
  sessionKeyCache.evict(`mcp:${sessionId}`);
  return true;
}

/**
 * Handle MCP requests on the Express /mcp endpoint.
 * Authenticates via Bearer token, creates or reuses transport sessions.
 */
export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  // Recheck the presented credential for each request on an existing transport.
  // Its principal was captured at initialization, while platform roles must
  // still be refreshed before every tool-dispatch POST (#1251).
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    const active = transports.get(sessionId)!;
    // #2261: from ARRIVAL (before any queueing) until the response ends. A handler returning is not the release
    // signal: an SSE stream outlives it. Only a throw needs the explicit release (no response may ever end then).
    const releaseHold = holdMcpTransport(active, res);
    try {
      await handleKnownMcpSession(req, res, sessionId, active);
    } catch (err) {
      releaseHold();
      throw err;
    }
    return;
  }
  return handleUnknownOrNewMcpSession(req, res, sessionId);
}

async function handleKnownMcpSession(
  req: Request,
  res: Response,
  sessionId: string,
  active: ActiveMcpTransport,
): Promise<void> {
  // Streamable HTTP GET opens the transport's long-lived SSE channel. Its
  // handleRequest promise lasts for the stream lifetime, so putting it in
  // the POST queue would prevent every later tool call from ever reaching
  // role refresh or dispatch. GET does not dispatch role-gated tools and
  // therefore does not mutate the shared authorization snapshot.
  if (req.method === 'GET') {
    if (!(await authenticateBoundMcpSession(req, res, sessionId, active))) return;
    await active.transport.handleRequest(req, res, req.body);
    return;
  }

  const previousRequest = active.requestTail;
  let releaseRequest!: () => void;
  active.requestTail = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  await previousRequest;
  try {
    // A request may have queued before another request invalidated and
    // closed this transport. It must not dispatch through the stale object.
    if (transports.get(sessionId) !== active) {
      respondMcpSessionNotFound(res);
      return;
    }
    let roles: Awaited<ReturnType<typeof getCurrentUserRoles>>;
    try {
      roles = await getCurrentUserRoles(db, active.auth);
    } catch {
      // Express 4 does not forward a rejected async handler. Fail this request
      // closed and explicitly rather than either dispatching with cached roles
      // or leaving the client hanging on a database failure.
      mcpLog('error', 'mcp_role_refresh_failed', {
        mcpSessionId: sessionId,
        userId: active.auth.userId,
      });
      res.status(503).json({ error: 'Authentication temporarily unavailable' });
      return;
    }

    // DELETE and transport.onclose do not enter this POST queue. Either can
    // unregister the session while the database lookup above is in flight,
    // so revalidate the exact transport after that await and immediately
    // before mutating its captured auth or dispatching through it.
    if (transports.get(sessionId) !== active) {
      respondMcpSessionNotFound(res);
      return;
    }

    if (roles === null) {
      // Account deletion revokes self-contained JWTs per request. Apply the
      // same liveness contract to an already-open MCP transport: zero roles
      // is a valid ordinary user, while a missing live user is no principal.
      unregisterMcpTransport(sessionId, active.transport);
      await active.transport.close();
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Credential validation shares this lock with role refresh and dispatch:
    // a queued request may never borrow the prior request's bearer.
    const presented = await authenticateBoundMcpSession(req, res, sessionId, active);
    if (!presented) return;
    // Credential resolution re-reads the live user after the liveness check
    // above. A demotion between those reads must win before tool dispatch.
    active.auth.roles = presented.roles ?? [];
    // #2123: every principal's session-sensitive consumers receive THIS
    // request's binding result, under the same credential/request lock through
    // dispatch. Keep initialization refusal and retained actor state intact.
    active.auth.requestSession = { sessionId: presented.sessionId, refused: presented.sessionBindingRefused === true };
    await publishConnectionActor(sessionId, presented, req.headers['x-hadron-session'] !== undefined);
    await active.transport.handleRequest(req, res, req.body);
  } finally {
    releaseRequest();
  }
}

/** An unknown or absent session id: answer the stale-id 404, or authenticate and open a new session. */
async function handleUnknownOrNewMcpSession(req: Request, res: Response, sessionId: string | undefined): Promise<void> {
  const held: { reservation?: McpSessionReservation } = {};
  try {
    await openOrRejectMcpSession(req, res, sessionId, held);
  } finally {
    // Every exit gives an unconverted slot back: a throw (Express 4 never answers a rejected async handler, so the
    // response may stay open long after) or any early return. A converted reservation ignores this.
    held.reservation?.cancel();
  }
}

async function openOrRejectMcpSession(
  req: Request,
  res: Response,
  sessionId: string | undefined,
  held: { reservation?: McpSessionReservation },
): Promise<void> {
  // Stale session — the client presented a session ID we don't know
  // (typically: the server restarted and the in-memory registry was wiped).
  // Per the MCP streamable-HTTP spec the recoverable signal is HTTP 404
  // ("Session not found"): on a 404 the client MUST transparently start a
  // new session with a fresh InitializeRequest, and work resumes. Anything
  // else — in particular the 400 "Server not initialized" the SDK emits if
  // we feed a non-initialize request to a brand-new transport — is a
  // generic protocol error the client gives up on, permanently severing
  // the connection until the client itself restarts.
  //
  // Initialize requests fall through: the block below builds a fresh
  // transport for them (reusing the presented session ID, so a client that
  // re-inits with a stale ID keeps working). No auth is required to learn
  // "session not found" — session IDs are server-generated UUIDs and the
  // DELETE handler already answers 404 pre-auth for unknown sessions.
  if (sessionId) {
    const body: unknown = req.body;
    const hasInitialize = Array.isArray(body)
      ? body.some((m) => isInitializeRequest(m))
      : isInitializeRequest(body);
    if (!hasInitialize) {
      // #1009 (PR #1011 review, Codex P1 + Copilot): remember that THIS PROCESS
      // has just told a client its session is gone. A spec-compliant client
      // reacts to this 404 by re-initializing WITHOUT a session header
      // (server.session-revival.test.ts), so the next request carries nothing
      // to correlate on — `Boolean(sessionId)` alone catches only the minority
      // of clients that re-init while still sending the stale id, which would
      // have left the primary post-restart path reporting a fresh connection.
      // This timestamp is the only signal that survives the gap.
      lastStaleSessionAt = Date.now();
      mcpLog('info', 'stale_mcp_session_404', { mcpSessionId: sessionId, method: req.method });
      respondMcpSessionNotFound(res);
      return;
    }
  }

  // New session — authenticate. Accept JWT users (userId/clientId set by
  // resolveAuthContext) OR App Keys (appId set) OR User API Keys (userId
  // set without appId, per spec 025-oauth-for-mcp). App Keys are the
  // canonical way for hadron-client / Claude Code MCP / Cursor / etc. to
  // authenticate; user-credential MCP arrives via OAuth or portal-minted
  // hdr_user_<…> bearer tokens.
  const auth = await resolveAuthContext(req, db);
  // Admin impersonation: impersonation tokens are not accepted on /mcp (v1).
  // MCP binds credential identity at session init. Ordinary-user roles are
  // refreshed per request below, but the impersonation SESSION row's full
  // stop/expiry/membership contract is not, so the revalidation that makes
  // impersonation safe on /graphql cannot hold here. Rejecting at init is
  // sufficient — an established session was never minted from one.
  if (auth.impersonation) {
    res.status(401).json({ error: 'Impersonation tokens are not accepted on /mcp' });
    return;
  }
  const surfaceRefusal = oauthSurfaceRefusal(auth, 'mcp');
  if (surfaceRefusal) {
    res.setHeader('WWW-Authenticate', 'Bearer error="insufficient_scope", scope="mcp"');
    // #1303: the same matchable fields as the account surfaces (@copilot, PR
    // #1306); prose and status unchanged.
    res.status(403).json({ error: oauthSurfaceRefusalMessage(surfaceRefusal, 'This OAuth credential does not grant MCP access'), code: 'FORBIDDEN', ...surfaceRefusal });
    return;
  }
  if (!auth.appId && !auth.userId && !auth.clientId) {
    // Advertise the protected-resource metadata URL per RFC 9728 §5.1 so
    // MCP-spec-compliant clients (Claude Desktop, MCP Inspector) can
    // discover the OAuth authorization server and walk the OAuth dance.
    //
    // Origin resolution is delegated to `getServerOrigin` so this path
    // shares the same precedence as the discovery endpoints (the
    // `BASE_URL` env var when set, else
    // `req.protocol + req.get('host')`). Without that consolidation,
    // a misconfigured deployment could emit an `https://` issuer in
    // the AS metadata but an `http://` URL in this WWW-Authenticate
    // header (or vice versa) — same root cause as the original
    // catch-all "everything is http://" production bug.
    respondMcpAuthenticationRequired(req, res);
    return;
  }

  // #2261: reserve capacity NOW, before the first await below, so concurrent initializes cannot jointly exceed
  // the per-principal cap. The key is read before `auth.appId` is filled in from a default or a restored selection.
  const principalKey = mcpPrincipalKey(auth);
  const reservation = reserveMcpSession(principalKey, res);
  if (!reservation) {
    // Either refused with a 429, or the response had already ended and there is nothing to answer.
    return;
  }
  held.reservation = reservation;

  // Spec 025 / 026 — App-identification resolution at the MCP boundary for
  // user-credential callers (userId set, appId not set; JWT or
  // hdr_user_<…> Bearer). App-key callers already have appId populated by
  // the middleware and skip this block.
  //
  // **Spec-026 change** (relative to spec-025):
  // - The legacy `multiple_apps_resolved` HTTP 409 NO LONGER fires here at
  //   session-init time. Spec 026 requires multi-App sessions to OPEN so
  //   the user can call `hadron_list_apps` + `hadron_set_active_app` to pick an App.
  // - For multi-App users, `auth.appId` is left unset at session-init and
  //   the resolution is cached for per-tool-call dispatch.
  // - Single-App users continue to get `auth.appId` populated here (regime
  //   `a` unchanged from spec 025).
  // - The legacy 409 text survives as the FR-016 fall-through tool-error
  //   envelope: an App-scoped tool call from a multi-App user who has NOT
  //   touched the new selection surface gets that text in a tool error
  //   instead of an HTTP 409.
  //
  // **`auth` is mutated in place** on the resolved path. Today this is
  // safe — `auth` is local to handleMcpRequest and the closure inside
  // `createMcpServerInstance` reads the post-mutation state.
  let cachedAppResolution: AppResolution | null = null;
  /** #1012 — did `auth.appId` come from the single-App default rather than a credential? */
  let appIdFromSingleAppDefault = false;
  if (auth.userId && !auth.appId) {
    cachedAppResolution = await resolveAppForRequest(auth.userId, db);
    if (cachedAppResolution.kind === 'resolved') {
      auth.appId = cachedAppResolution.appId;
      auth.organizationId = cachedAppResolution.organizationId ?? undefined;
      // #1012 (PR #1013 review, Codex P1): remember that this came from the
      // regime-a DEFAULT, not from a credential — a stored explicit selection
      // is allowed to override it below, but must never re-point an App key.
      appIdFromSingleAppDefault = true;
    }
    if (cachedAppResolution.kind === 'multi-app') {
      mcpLog('warn', 'multi_app_session_opened_without_selection', {
        userId: auth.userId,
      });
    }
    // 'no-app': continue without setting appId; downstream tool calls
    // fail with their existing errors (zero-App fall-through unchanged
    // from spec 025).
  }

  // Session not found or no session — create a new one.
  // This handles both first-time connections and reconnections after server restart.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: sessionId
      ? () => sessionId  // Reuse the client's session ID so it doesn't need to re-init
      : () => randomUUID(),
  });

  // #1009: is this session replacing one the client had already been using?
  // Two shapes — a re-initialize still carrying the stale id (certain), or a
  // headerless re-initialize shortly after this process 404'd someone's session
  // (the spec-compliant path, correlated at process level). See
  // `isLikelyReconnect`. Everything per-session was just reset underneath a
  // client that will not mention it, so the tools need to be able to say so.
  const isReconnect = isLikelyReconnect(sessionId);

  // #1012: the client's stable instance id, if it opted in. Read here — at
  // session construction — because that is the one moment a restore is useful:
  // the selections must be in place before the first tool call, not after one
  // has already been refused.
  const clientKey = normalizeClientKey(req.headers[CLIENT_KEY_HEADER]);

  // Restore this client's durable selections, re-authorized (see
  // loadMcpSessionState — a stored selection is a cache of a choice, never a
  // grant). Applied to `auth` before the server instance closes over it, so
  // every downstream `if (!auth.appId)` sees the restored value with no
  // per-tool plumbing — the same shape requireAppScope already relies on.
  const restored = await loadMcpSessionState(db, auth, clientKey);
  // Precedence, strongest first (PR #1013 review, Codex P1):
  //
  //   1. an App-KEY credential — App identity IS the credential and a stored
  //      selection must never re-point it (`appIdFromSingleAppDefault` is false
  //      there, and `loadMcpSessionState` returns nothing for a userId-less
  //      principal anyway);
  //   2. this client's EXPLICIT stored selection, re-authorized above;
  //   3. the regime-a single-App default.
  //
  // 2 outranking 3 is the fix: a user who explicitly chose App A can later drop
  // to exactly one AppMember row (say App B) while remaining a valid
  // participant in A by org CONTRIBUTOR or ownership. `resolveAppForRequest`
  // then resolves B as "their only App", and taking that over the choice they
  // actually made would silently retarget the next App-scoped write. A stated
  // preference outranks an inferred default whenever it still authorizes.
  if (restored.appId && (!auth.appId || appIdFromSingleAppDefault)) {
    const overrodeDefault = auth.appId !== undefined && auth.appId !== restored.appId;
    auth.appId = restored.appId;
    auth.organizationId = restored.organizationId ?? undefined;
    mcpLog('info', 'mcp_session_state_restored', {
      userId: auth.userId,
      appId: restored.appId,
      restoredMemory: Boolean(restored.memoryUrn),
      overrodeSingleAppDefault: overrodeDefault,
      reconnect: isReconnect,
    });
  }

  const mcpServer = createMcpServerInstance(
    auth,
    () => transport.sessionId,
    cachedAppResolution,
    {
      isReconnect,
      clientKey,
      restoredMemoryUrn: restored.memoryUrn,
      restoredOrgId: restored.activeOrgId,
      restoredScopeId: restored.activeScopeId,
    },
  );

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) unregisterMcpTransport(sid, transport);
  };

  await mcpServer.connect(transport);

  // Handle the request with the new transport
  await transport.handleRequest(req, res, req.body);

  const sid = transport.sessionId;
  if (sid) {
    // Convert the reservation into the registered entry with nothing awaited between the two. If the response
    // ended while this handler was suspended, the reservation is already cancelled and its slot freed: do not
    // register, or a burst of aborted initializes would exceed the cap (#2261 review, Dara/Colin P2).
    if (reservation.convert()) {
      transports.set(sid, { transport, auth, requestTail: Promise.resolve(), principalKey, inFlight: 0, lastActivityAt: Date.now() });
    } else {
      unregisterMcpTransport(sid, transport);
      await transport.close().catch(() => undefined);
    }
  } else {
    reservation.convert();
  }
}

/**
 * Handle DELETE requests to close an MCP session.
 */
export async function handleMcpDelete(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const active = transports.get(sessionId)!;
  if (!(await authenticateBoundMcpSession(req, res, sessionId, active))) return;
  const { transport } = active;
  // Another close/reconnect may have replaced the transport during auth.
  if (transports.get(sessionId) !== active) {
    respondMcpSessionNotFound(res);
    return;
  }
  await transport.close();
  // close() normally triggers onclose first. Keep this fallback for SDK paths
  // that do not, but make it identity-aware in case a same-ID replacement was
  // registered between onclose and close() settling.
  unregisterMcpTransport(sessionId, transport);
  res.status(200).json({ ok: true });
}

// ── #2260: the caller-session gate's `session` field, also built once ─────────
// The #1701 gate adds an optional `session` field to every writing tool's shape. Rebuilding that spread per
// instance would allocate a fresh object and a fresh field schema for every tool in every session and defeat the
// sharing below, so the widened shape is memoised on the (shared) source shape's identity. A shape that is not
// shared (one that captures per-session state and stays inline) gets its own entry that dies with it.
const SESSION_PARAM_DESCRIPTION =
  'Your worker session id (from hadron_start_session or hadron_whoami). Attributes this write to that ' +
  'session\'s worker. Optional on a connection bound to one worker; REQUIRED when the connection carries ' +
  'more than one worker\'s session (several chat sessions on one host), where a write without it is ' +
  'refused SESSION_AMBIGUOUS (#1701).';
const SESSION_FIELD_SCHEMA = z.string().optional().describe(SESSION_PARAM_DESCRIPTION);
const shapeWithSession = new WeakMap<object, Record<string, unknown>>();
function withSessionField(shape: Record<string, unknown>): Record<string, unknown> {
  let widened = shapeWithSession.get(shape);
  if (!widened) {
    widened = { ...shape, session: SESSION_FIELD_SCHEMA };
    shapeWithSession.set(shape, widened);
  }
  return widened;
}

// ── #2260: parameter shapes, built ONCE per process ──────────────────────────
// A shape is pure data (no session state: moved here only because nothing in it resolves to a
// function- or block-scoped binding, so `tsc` rejects one that captures `auth` or any other
// per-session value). Every MCP session registers these same objects instead of rebuilding ~15 MB.

const recoveryPageArgs = {
  memoryRef: z.string().describe('One live memory ID or qualified URN.'),
  limit: z.number().int().nullable().optional().describe('Default 20 (also null), maximum 200; use total to fetch remaining pages.'),
  offset: z.number().int().nullable().optional().describe('Page offset, default 0.'),
};

const recoveryEdgesArgs = {
  ...recoveryPageArgs,
  edgeIds: z.array(z.string()).nullable().optional().describe('Restrict the result, total included, to these edge ids (1 to 200). An id that is not a visible edge of this memory is absent.'),
};

const governedDoorArgs = {
  urn: z.string().describe('Fully-qualified node URN (hrn:node:<root>:<memory>:<loc>).'),
  name: z.string().optional().describe('Node name. Required when creating.'),
  description: z.string().optional().describe('Short description'),
  abstract: z.string().optional().describe('Paragraph-length summary (max 2000 chars).'),
  content: z.string().optional().describe('Markdown content'),
  // The same lenient schema as the generic node tools ("a,b" or an array),
  // so a call the generic tool accepted replays through the door
  // unchanged (@codex, PR #1305).
  tags: tagsInputSchema.optional().describe('Tags'),
  nodeType: z.string().optional().describe('Node classification. Distinct from the governed kind — see Node.role.'),
  seq: z.number().optional().describe('Sort order among siblings (lower values first)'),
  properties: z.record(z.string(), z.unknown()).optional().describe('Structured key-value properties'),
  data: z.record(z.string(), z.unknown()).optional().describe('Runtime data bag'),
};

/**
 * The UPDATE doors additionally accept their own governed signal, so a
 * governed node can be RETIRED through the door that owns it. Absent from the
 * create args on purpose — there the tool is the statement of intent.
 */
//
// PER KIND, not shared (@copilot, PR #1203). A single arg set carrying both
// signals reads as if both are actionable on both tools, and they are not:
// `isRunnable` through the review door is refused by the gate every time,
// because the review door owns the review kind and not the task kind. A
// description that promises an argument the gate always refuses is worse than
// no argument.
const taskUpdateArgs = {
  ...governedDoorArgs,
  expectedRevision: z.number().int().positive().max(2_147_483_647).optional().describe('Optional positive Revision value from hadron_get_node. A mismatch refuses atomically with [node_write_conflict].'),
  isRunnable: z
    .boolean()
    .optional()
    .describe('Set false to RETIRE this task — it stops being runnable. Omit to preserve. This door is the only way to change it: the generic surface is refused, because clearing the signal is how a governed node is un-governed.'),
};

const reviewUpdateArgs = {
  ...governedDoorArgs,
  expectedRevision: z.number().int().positive().max(2_147_483_647).optional().describe('Optional positive Revision value from hadron_get_node. A mismatch refuses atomically with [node_write_conflict].'),
  role: z
    .string()
    .nullable()
    .optional()
    .describe('Set null to RETIRE this node from the review kind. Omit to preserve. This door is the only way to change it, including moving it between "review" and a dotted "review.<sub-role>" (#1322). Setting it to another GOVERNED family ("spec" / "spec.*") is refused — that kind has its own door.'),
};

// #1345 review (@codex): the review family is authored here, sub-roles included.
const reviewCreateArgs = {
  ...governedDoorArgs,
  role: z
    .string()
    .optional()
    .describe('Which member of the review family to create: "review" (the default) or a dotted sub-role such as "review.security" (#1322). Anything outside the review family is refused.'),
};

const SHAPE_HADRON_SEARCH = {
  query: z
    .string()
    .describe('Search text: a PK/id, a URN (hrn:/urn: or bare root:slug), or free-text name.'),
  entityTypes: z
    .array(
      z.enum(['organization', 'memory', 'node', 'agent', 'app', 'aiServiceConfig', 'user']),
    )
    .optional()
    .describe('Restrict to these entity types. Omit to search all.'),
  fields: z
    .array(z.enum(['urn', 'name', 'description', 'pk', 'content']))
    .optional()
    .describe('Force these fields (overrides the smart-sniff). Omit to auto-detect.'),
  limit: z.number().optional().describe('Max results (default 20, max 200).'),
  scope: z.string().optional().describe('Spec 049: run the memory + node slices under a named scope (a scope id / name, "app", or "global"). Omitted: the ladder applies (active scope › active App › active organization) and the result says which.'),
};

const SHAPE_HADRON_SET_ACTIVE_MEMORY = {
  memoryUrn: z.string().describe('Memory URN, e.g. hrn:mem:hadronmemory.com:dev (bare hadronmemory.com:dev also accepted). Legacy hrn:memory: and :: forms still resolve.'),
};

// #2661 / #2260: immutable, principal-independent parameter schemas are shared.
const SHAPE_HADRON_CREATE_APP_MEMORY = {
  app: z.string().describe('App ID or URN.'),
  name: z.string().min(1).describe('Memory name; determines its slug.'),
  shortDescription: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
};

const SHAPE_HADRON_CREATE_MEMORY = {
  name: z.string().min(1).describe('Memory name; its slug becomes the URN tail (e.g. "My Notes" -> my-notes).'),
  memoryClass: z
    .enum(['knowledge', 'group', 'personal', 'private'])
    .optional()
    .describe("Memory class (default 'knowledge'). personal/private are owner-only; knowledge/group are organization-shared and need `org`."),
  org: z
    .string()
    .optional()
    .describe('Organization URN or id to create it in. Omit for a user-owned personal/private memory in your own namespace.'),
  shortDescription: z.string().optional().describe('One-line description.'),
  description: z.string().optional().describe('Longer description.'),
  tags: z.array(z.string()).optional().describe('Tags.'),
  visibility: z
    .enum(['PUBLIC', 'ORGANIZATION', 'GROUP'])
    .optional()
    .describe("Knowledge memories: PUBLIC or ORGANIZATION (default). A group memory is always GROUP. personal/private take none."),
};

const SHAPE_HADRON_SET_ACTIVE_APP = {
  app: z
    .string()
    .describe(
      "App URN or unambiguous App name. Pass the URN form for guaranteed match; pass the display name when it is unique across your Apps.",
    ),
};

const SHAPE_HADRON_SET_ACTIVE_ORG = {
  org: z
    .string()
    .optional()
    .describe('Organization URN (hrn:org:<root>) or id. Must be one you are a member of; a foreign or nonexistent org reads the same (org_not_found), with your memberships listed.'),
  clear: z
    .boolean()
    .optional()
    .describe('true = drop the explicit selection (the ladder then falls through to your active App / single membership). Ignored when org is passed.'),
};

const SHAPE_HADRON_GET_RECOVERY_NODE = { nodeRef: z.string().describe('Stable node ID or qualified node URN.') };

const SHAPE_HADRON_RESTORE_NODE = { nodeRef: z.string().describe('Stable node ID or qualified node URN.') };

const SHAPE_HADRON_LIST_SCOPES = {
  app: z.string().optional().describe('App URN or id whose context to list. Defaults to the active App.'),
  ownerType: z.enum(['ORGANIZATION', 'AGENT', 'APP']).optional().describe('With ownerRef: list one owner\'s scopes instead of an App context.'),
  ownerRef: z.string().optional().describe('URN or id of the owner (with ownerType).'),
  name: z.string().optional().describe('Only scopes with exactly this name.'),
  limit: z.number().int().optional().describe('Page size (default 20, cap 200).'),
  offset: z.number().int().optional().describe('Page offset.'),
};

const SHAPE_HADRON_CREATE_SCOPE = {
  name: z.string().describe('The scope name.'),
  memoryUrns: z.array(z.string()).min(1).describe('The ORDERED memory list — fully-qualified memory URNs (hrn:mem:<root>:<slug>) or ids.'),
  description: z.string().optional().describe('What this lens is for — shown wherever the scope is shown.'),
  organizationRef: z.string().optional().describe('Own it by this organization (URN or id).'),
  agentRef: z.string().optional().describe('Own it by this Agent (URN or id) — travels with the Agent\'s installs.'),
  appRef: z.string().optional().describe('Own it by this App (URN or id). Default when no owner is passed: the active App.'),
};

const SHAPE_HADRON_UPDATE_SCOPE = {
  scope: z.string().describe('The scope id (from hadron_list_scopes).'),
  name: z.string().optional(),
  description: z.string().optional(),
  memoryUrns: z.array(z.string()).min(1).optional().describe('The NEW ordered list — replaces, never merges.'),
};

const SHAPE_HADRON_DELETE_SCOPE = { scope: z.string().describe('The scope id.') };

const SHAPE_HADRON_SCOPE_EXPLAIN = {
  scope: z.string().optional().describe('The scope id. Or pass name.'),
  name: z.string().optional().describe('A scope NAME, resolved in the App\'s context.'),
  app: z.string().optional().describe('The App context for a name (URN or id). Defaults to the active App.'),
  loc: z.string().optional().describe('An address: report which memory in the scope would win for it.'),
};

const SHAPE_HADRON_LIST_CHANNELS = {
  app: z.string().optional().describe('App URN or id. Defaults to the active App.'),
  memory: z.string().optional().describe('Or: one host memory (URN or id).'),
  limit: z.number().int().optional().describe('Page size (default 20, cap 200).'),
  offset: z.number().int().optional().describe('Page offset.'),
};

const SHAPE_HADRON_CREATE_CHANNEL = {
  memory: z.string().describe('Host memory (URN or id) — any class you may write.'),
  loc: z.string().describe('The reserved address, e.g. chats:release.'),
  name: z.string().describe('The Channel name.'),
  description: z.string().optional().describe('What the Channel is for.'),
};

const SHAPE_HADRON_REGISTER_LIST = {
  owner: z.string().optional().describe('An App or organization (URN or id). Defaults to the active App.'),
  channel: z.string().optional().describe('Only rows for this Channel (its id or address).'),
  attendee: z.string().optional().describe('Only rows naming this Worker or Agent (URN or id).'),
  limit: z.number().int().optional().describe('Page size (default 20, cap 200).'),
  offset: z.number().int().optional().describe('Page offset.'),
};

const SHAPE_HADRON_REGISTER_ADD = {
  channel: z.string().describe('The Channel — its id, or its address (the chat root node URN hadron_list_channels prints). Copy one of those; a ref naming nothing reads as a Channel you may not see.'),
  attendee: z.string().optional().describe('A Worker or Agent (URN or id). Omit = every attendee in the owner\'s context.'),
  owner: z.string().optional().describe('An App or organization (URN or id). Defaults to the active App.'),
  role: z.enum(['WATCH', 'POST', 'BOTH']).optional().describe('Default BOTH.'),
  mentionOnly: z.boolean().optional().describe('Only messages mentioning the attendee count as new for it.'),
  description: z.string().optional().describe('Why — the human\'s intent.'),
};

const SHAPE_HADRON_REGISTER_REMOVE = { entry: z.string().describe('The register entry id (from hadron_register_list).') };

const SHAPE_HADRON_SET_ACTIVE_SCOPE = {
  scope: z.string().optional().describe('A scope id, or a scope NAME resolved in the active App\'s context (App › Agent › organization). See hadron_list_scopes.'),
  clear: z.boolean().optional().describe('true = drop the selection; the ladder falls through to the active App / organization.'),
};

const SHAPE_HADRON_CREATE_PARENT_NODE = {
  urn: z.string().describe('Fully-qualified node URN for the new section, e.g. "hrn:node:acme.com:mmdata:services" or "hrn:node:acme.com:mmdata:services:db-helpers"'),
  name: z.string().optional().describe('Display name (defaults to the last loc atom)'),
  description: z.string().optional().describe('What this section contains'),
  tags: tagsInputSchema.optional(),
};

const SHAPE_HADRON_FIND_NODES = {
  query: z.string().describe('For mode:keyword (default) / mode:hybrid — a full-text query: stemmed terms ranked by relevance, with boolean operators `(a OR b) AND c`, quoted phrases, and `-term` / `NOT`. For mode:vector / mode:hybrid — also embedded and matched semantically against the memory\'s vector index. For mode:regex — a POSIX regular expression. Use "*" or "" to list all nodes (survey mode; rejected for mode:vector / mode:hybrid).'),
  mode: z.enum(['keyword', 'vector', 'hybrid', 'regex']).optional().describe('keyword (default): full-text search — stemmed, relevance-ranked, boolean operators, body + abstract indexed. vector: semantic search over the memory\'s vector index (requires vectorIndexEnabled). hybrid: keyword + vector fused by reciprocal-rank fusion (RRF, k=60). regex: POSIX regular-expression match over node text. On a non-indexed memory, mode:hybrid degrades to keyword-only and emits a [degraded:no_vector_index] note. Spec 033 + cor:api:090.'),
  parentRel: z.string().optional().describe('Scope search to this subtree'),
  memoryUrn: z.string().optional().describe('Scope search to a single memory (fully-qualified URN). Omit to search all memories you can read — see allMemories.'),
  memoryUrns: z.array(z.string()).min(1).optional().describe('Scope search to this SET of memories (each a fully-qualified memory URN, hrn:mem:<root>:<slug>) — a targeted multi-memory search. Must be non-empty (for "everything", use allMemories). Mutually exclusive with memoryUrn and allMemories.'),
  allMemories: z.boolean().optional().describe('Search across ALL memories you can read — the org-wide "does anyone know about X?" probe (stemmed + relevance-ranked in keyword mode). The explicit, self-documenting form of omitting a memory scope. Mutually exclusive with memoryUrn / memoryUrns.'),
  isRunnable: z.boolean().optional().describe('Filter by runnable status (applies in every mode). true = only task nodes (Node.isRunnable=true) — the canonical "tasks I can run" predicate hadron_run_task gates on. false = only nodes explicitly marked non-runnable (most nodes leave it NULL, so false does NOT include them). Omit to ignore runnable status. Spec cor:api:060.'),
  role: z.string().optional().describe('Filter by Node.role family in every mode. Segment-boundary prefix semantics: "spec" matches "spec" and dotted descendants such as "spec.rule", but never "special" or "specification" (#1322). Node.role remains an open string; this is a query filter, not role validation.'),
  nodeType: z.string().optional().describe('#331 — exact-match node-type facet (free-form, e.g. "task" / "parent" / "info"): only nodes whose nodeType equals this. Applies in every mode; with query "*" it lists all nodes of one type. Orthogonal to objectType. Without it, system nodes stay excluded; "comment" searches comments as the engine documents. Negation and multi-value are not supported.'),
  objectType: z.string().optional().describe('#725 — collection facet: only nodes whose objectType equals this (the domain-object discriminator, e.g. "competitor" / "insight"). Orthogonal to nodeType. Composes with query/mode + where.'),
  nodeKind: z.enum(['CONTENT', 'COMMENTS', 'ALL']).optional().describe('#1608/#1678 — which KIND of node to search (GraphQL: NodeFilter.contentScope). CONTENT (default): content nodes only. COMMENTS: comment nodes only (feedback about other nodes), found exhaustively in every mode before ranking and limits. ALL: both. A comment hit is labelled COMMENT and is never content of, or verified fact about, its target. Not hadron_get_node\'s contentScope, which picks the parts of one node to return.'),
  scope: z.string().optional().describe('Spec 049: search under a named scope — a scope id, a scope NAME (resolved in the active App\'s context), "app" (the active App\'s attached memories), or "global" (your active organization\'s view). Omitted with no memory selector: the ladder applies (active scope › active App › active organization), and the result says which. An explicit memoryUrn / memoryUrns / allMemories outranks the ambient scope but still intersects with one named here.'),
  brief: z.boolean().optional().describe('Return index info only: name, description, edges'),
  limit: z.number().int().optional().describe('Max primary results: integer clamped to 1–200 (default 10 for a query; 20 for survey mode "*"/""). Expansion neighbors are additional.'),
  minScore: z.number().optional().describe('Absolute relevance floor: drop hits scoring below this. Scores are NOT comparable across modes — keyword ranks run roughly 0..a-few, vector cosine similarity is 0..1, hybrid is a small RRF fraction — so read the (score …) values in a first unfiltered call, then set a floor for the mode in use. Prefer this (or a narrower query) over reading a long tail of weak hits. Returns fewer hits, never weaker ones; does not apply to survey mode.'),
  expand: z.number().int().min(0).max(3).optional().describe('Append undirected graph neighbors (all edge types) within depth N AFTER the ranked hits, unscored. Default 0 (no expansion). Max 3. Useful for context-stuffing — the ranked nodes plus their immediate graph context in one tool call. Spec 033 FR-020.'),
  granularity: z.enum(['node', 'chunk']).optional().describe('node (default): one entry per matching node, ranked by best-chunk similarity for content-chunk indexes. chunk: return matching passages (span text + character offsets + chunk index + parent node URN), useful for RAG context-stuffing. **chunk requires mode:vector** — hybrid + chunk is out of v1 (the design call for how RRF fuses with passage-level results was deferred). Spec 033 US2 FR-022.'),
  where: z.record(z.string(), z.unknown()).optional().describe('Structured predicate over a node\'s `properties`/`data` JSONB (#719) — filters, then the chosen mode ranks the survivors (composes with keyword/vector/hybrid/regex and survey/browse). A node is EITHER a branch (exactly one of `and`/`or`/`not`) OR a leaf: a `path` (array of JSON keys, e.g. ["sourceKind"]) plus exactly ONE operator — eq | ne | in | lt | lte | gt | gte | between | exists | contains. `field`: "properties" (default) | "data". `as`: "text" (default) | "number" | "datetime" | "boolean" — number/datetime route through DB guards so unparseable values drop the row (never an error); `contains` is jsonb @> containment. Bounded: depth ≤ 4, ≤ 32 leaves, path ≤ 8. Example: {"and":[{"path":["sourceKind"],"eq":"substack"},{"path":["extractedAt"],"as":"datetime","gte":"2026-07-04T00:00:00Z"}]}'),
};

const SHAPE_HADRON_GET_NODE = {
  urn: z.string().describe('Fully-qualified node URN, e.g. "hrn:node:acme.com:mmdata:architecture" (legacy :: forms still accepted), or an action URN "hrn:action:<root>:<agent-slug>:<code>" — the register entry\'s second address'),
  contentScope: z
    .enum(['content', 'abstract', 'all'])
    .optional()
    .describe("Selects what the response includes. 'content' (default): meta block + body, with abstract substituted into the body slot when content is null/empty (Source: abstract-fallback line appears). 'abstract': meta block + abstract, no body. 'all': meta block + abstract + body."),
  raw: z
    .boolean()
    .optional()
    .describe('Return the stored text with include tags ({{> loc}}) as written instead of resolving them (cor:dmo:150:03). Default false: includes resolve with your own read access.'),
};

const SHAPE_HADRON_GET_NODES = {
  refs: z
    .array(z.string())
    .optional()
    .describe('Explicit-set form: node references, each a primary key OR a fully-qualified node URN (hrn:node:<root>:<memory>:<loc>). Returned in input order. Mutually exclusive with memoryUrn/locPrefix.'),
  memoryUrn: z
    .string()
    .optional()
    .describe('Prefix form: fully-qualified memory URN to read from. Use together with locPrefix.'),
  locPrefix: z
    .string()
    .optional()
    .describe('Prefix form: return every readable node whose loc starts with this prefix (loc order). Use together with memoryUrn.'),
  contentScope: z
    .enum(['content', 'abstract', 'all'])
    .optional()
    .describe("Per-node projection scope, as on hadron_get_node. Default 'content'."),
  raw: z
    .boolean()
    .optional()
    .describe('Return the stored text with include tags ({{> loc}}) as written instead of resolving them (cor:dmo:150:03). Default false: includes resolve with your own read access.'),
};

const SHAPE_HADRON_GET_NEXT_NODE = {
  parent: z.string().describe('Fully-qualified parent node URN, e.g. "hrn:node:acme.com:mmdata:sections"'),
  current: z.string().optional().describe('Fully-qualified current child node URN (must be in the same memory as `parent`)'),
  raw: z
    .boolean()
    .optional()
    .describe('Return the stored text with include tags ({{> loc}}) as written instead of resolving them (cor:dmo:150:03). Default false: includes resolve with your own read access.'),
};

const SHAPE_HADRON_LIST_NODES = {
  parentRel: z.string().optional().describe('Parent loc (for example notes:ideas) with memoryUrn, or a fully qualified hrn:node: parent URN. If both references are provided, they must name the same memory. A bare loc without memoryUrn searches discovery scope only; use an explicit reference for your personal/private memories. Omit to list from memory root.'),
  memoryUrn: z.string().optional().describe('Fully qualified Memory URN. Scopes a bare parentRel; required when parentRel is omitted. No active-memory fallback.'),
  depth: z.number().optional().describe('Max depth to traverse (default: 1)'),
  isRunnable: z.boolean().optional().describe('Filter the tree to runnable status. true = only task nodes (Node.isRunnable=true) — the canonical "tasks I can run" predicate hadron_run_task gates on. false = only nodes explicitly marked non-runnable (most nodes leave it NULL, so false does NOT include them). Omit to list every node. Spec cor:api:060.'),
};

const SHAPE_HADRON_UNLOCK_MEMORY = {
  memoryUrn: z.string().describe('Memory URN or id'),
  passphrase: z.string().optional().describe('The passphrase the memory was encrypted with'),
  dataKey: z.string().optional().describe('Raw base64 32-byte data key (alternative to passphrase)'),
};

const SHAPE_HADRON_LOCK_MEMORY = { memoryUrn: z.string().describe('Memory URN or id') };

const SHAPE_HADRON_CREATE_NODE = {
  urn: z.string().describe('Fully-qualified node URN, e.g. "hrn:node:acme.com:mmdata:review:sort-imports". Both bare and prefixed forms accepted, in either URN grammar. Relative-form URNs (no memory) are rejected.'),
  name: z.string().describe('Node name'),
  nodeType: z.string().optional().describe('Node classification (free-form; canonical values: abstract, chat, data, info (default), prompt, record, reference, system). Running is gated by isRunnable, independent of nodeType.'),
  objectType: z.string().optional().describe('#725 — collection this node belongs to (the domain-object discriminator, e.g. "competitor" / "insight"), orthogonal to nodeType. On a memory with a property schema, it MUST name a declared collection and the node\'s properties are validated against it; free-form on an unschema\'d memory. Omit for an ordinary node.'),
  isRunnable: z.boolean().optional().describe('#1201 — REFUSED on this tool if true: a write producing a runnable node must go through hadron_create_task, because authoring something the platform will EXECUTE is not the same act as writing prose. Accepted only as false/omitted (the default). Independent of nodeType — a runnable node may carry any nodeType.'),
  role: z.string().optional().describe('#1201/#1322 — what this node is FOR (open string). NOT nodeType (the platform-kind axis) and NOT objectType (the collection discriminator); role does not affect default ranking, though hadron_find_nodes can filter by its dotted family. Most values are inert, but the GOVERNED families — "review" / "review.*", "spec" / "spec.*" and "decision" / "decision.*" — are refused on this tool. Use hadron_create_review for a review; a spec is authored with the `hadron spec` CLI, its only authoring surface; a decision is asked with the GraphQL askDecision operation (#1641). The same applies to isRunnable — this tool cannot create a runnable node; use hadron_create_task.'),
  description: z.string().optional().describe('Short description'),
  abstract: z.string().optional().describe('Paragraph-length summary (max 2000 chars). Opt-in on hadron_get_node via the contentScope parameter. (hadron_find_nodes preview surfacing of abstract ships in spec 031 US2 — not yet live.) Empty + whitespace-only values normalize to null. Spec 031.'),
  content: z.string().optional().describe('Markdown content'),
  seq: z.number().optional().describe('Sort order among siblings (lower values first)'),
  tags: tagsInputSchema.optional().describe('Tags'),
  properties: z.record(z.string(), z.unknown()).optional().describe('Structured key-value properties'),
  data: z.record(z.string(), z.unknown()).optional().describe('Runtime data (e.g. stageOrder, promptRef, extractionSpec for chat config)'),
  llmModel: z.string().optional().describe('LLM model used (e.g. claude-opus-4-6)'),
  aiAgent: z.string().optional().describe('AI agent tool used (e.g. claude-code, cursor)'),
  edges: z.array(z.object({
    targetUrn: z.string().describe('Target node fully-qualified URN'),
    name: z.string().optional().describe('Relationship name (was "label"), e.g. depends-on, documents'),
    loc: z.string().optional().describe('Explicit edge loc. Omit to derive <sourceLoc>:<name>:<targetLoc>.'),
    description: z.string().optional().describe(EDGE_DESCRIPTION_DOC),
    isRunnable: z.boolean().optional().describe('Whether this edge can be run/executed (task/conversation flows)'),
  })).optional().describe('Outgoing edges (replaces the full set on the source node)'),
  install: z.object({
    app: z.string().describe('The App: its ID or fully-qualified URN.'),
    agent: z.string().describe('The Agent the App customises: its ID or fully-qualified URN.'),
  }).optional().describe('#2044 — write into an App\'s INSTALL MEMORY (where it keeps its customisation of an installed Agent, cor:agt:040:06) instead of a memory named by `urn`. When set, `urn` is just the node\'s LOC (e.g. "prompts:lane"), not a URN. The first create finds-or-creates the install memory in the same step as the write; later calls reuse it. Only whoever manages the App may write, while the App is live and the Agent installed. Not supported with `edges`, `isRunnable` or `abstractStillAccurate`.'),
};

const SHAPE_HADRON_UPDATE_NODE = {
  urn: z.string().describe('Fully-qualified node URN, e.g. "hrn:node:acme.com:mmdata:review:sort-imports"'),
  expectedRevision: z.number().int().positive().max(2_147_483_647).optional().describe('Optional positive Revision value from hadron_get_node. A mismatch refuses with [node_write_conflict]; omit for backward-compatible last-write-wins behavior.'),
  name: z.string().optional().describe('New node name'),
  nodeType: z.string().optional().describe('Node classification (free-form; canonical values: abstract, chat, data, info (default), prompt, record, reference, system). Changing nodeType does NOT change isRunnable or properties (e.g. claudeSkill) — a retyped runnable node stays runnable until you clear isRunnable yourself. Running is gated by isRunnable, not nodeType.'),
  objectType: z.string().optional().describe('#725 — collection this node belongs to (e.g. "competitor" / "insight"), orthogonal to nodeType. On a schema-governed memory it must name a declared collection and the resulting properties are validated against it. Omit to preserve.'),
  isRunnable: z.boolean().optional().describe('#1201 — REFUSED on this tool: making a node runnable, and RETIRING a runnable one, both go through hadron_update_task. Editing a node that is already runnable is refused here too, whatever this field says, because the result is still a runnable node. Omit to preserve. Independent of nodeType — retyping the node never changes this flag.'),
  role: z.string().nullable().optional().describe('#1201/#1322 — what this node is FOR (open string). NOT nodeType and NOT objectType. Omit to preserve; null to clear. GOVERNED families ("review" / "review.*", "spec" / "spec.*", "decision" / "decision.*") are refused here — use hadron_update_review, the `hadron spec` CLI for a spec, or the decision operations (amendDecision, …) for a decision — and so is EDITING a node that already carries one — the gate reads the resulting state, not the change — because a governed node must not be rewritable through the generic surface.'),
  description: z.string().optional().describe('New short description'),
  abstract: z.string().nullable().optional().describe('New paragraph-length summary (max 2000 chars). Pass `null` to clear; omit to preserve. Empty + whitespace-only normalize to null. Surfaced on hadron_get_node via contentScope; hadron_find_nodes preview surfacing ships in spec 031 US2. STALENESS: the abstract is fingerprinted against the content AS OF THIS CALL, so passing `abstract` and `content` TOGETHER keeps them in sync and needs no ordering. If you instead change `content` in a LATER call, this abstract is marked `abstract-stale` on read until you re-save it (re-sending the identical text is enough) or assert `abstractStillAccurate`. It also arms for an abstract that was NEVER fingerprinted — one saved against an empty node, where a body arrived later (#1128). Read the ABSENCE of the marker narrowly: it means "checked against this exact content" ONLY on a read that could have shown it — `contentScope` of `abstract` or `all`, on a memory that is unencrypted or unlocked. Under the default `content` scope, or on a locked memory, no marker is emitted either way and its absence says nothing at all. Spec 031/032.'),
  content: z.string().nullable().optional().describe('New markdown content. Pass `null` to clear; omit to preserve. Spec 032 widened the schema from string-only to allow null per the consistent partial-update convention; clearing content interacts with abstractOriginHash maintenance (FR-006/FR-007). Changing content WITHOUT also passing `abstract` arms the `abstract-stale` marker on this node — that is intended (the abstract was written against the old content and may no longer describe it). Pass both together, or assert `abstractStillAccurate` if you have re-read the abstract and it survives the edit.'),
  abstractStillAccurate: z.boolean().optional().describe('ASSERTION, NOT A SETTING — and it SUPPRESSES A CORRECTNESS CHECK. Setting this true tells the server you have RE-READ the existing abstract against the content this call is writing and it still describes it, so the `abstract-stale` marker is cleared instead of armed. It changes no text: it only re-fingerprints the abstract you already have. Do NOT set it to make a marker go away, to save a call, or by default — the marker exists to catch an abstract that quietly stopped matching its node, and this is the one flag that can hide exactly that. If you have not actually compared the two, OMIT IT: a stale marker on an accurate abstract is cheap and self-correcting, a suppressed marker on an inaccurate one is neither, and it misleads every later reader and every RAG hit. Ignored when `abstract` is also supplied (that path already re-fingerprints) or when the node has no abstract. CONCURRENCY — it binds to NEITHER half: it re-fingerprints whatever abstract is STORED when this write lands, against the `content` you pass here — or, if you omit it, the body as this call read it before the write. The two halves fail in OPPOSITE directions: a concurrent ABSTRACT swap is certified unseen and the marker is suppressed on text you never read, whereas a concurrent CONTENT change leaves the stored hash disagreeing with the row, so the marker stays armed: the hash IS written, it just lands on the wrong body, and the one thing you wanted — clearing the marker — does not happen. Neither side is checked against what you read. The fully-bound form needs no flag at all — pass `abstract` AND `content` together and you are writing exactly the two things you compared. Prefer that whenever the node might have another writer; use this flag when re-sending the abstract is not worth it and you accept that trade.'),
  seq: z.number().optional().describe('New sort order among siblings'),
  tags: tagsInputSchema.optional().describe('Replace tags'),
  properties: z.record(z.string(), z.unknown()).optional().describe('Structured key-value properties'),
  data: z.record(z.string(), z.unknown()).optional().describe('Runtime data (e.g. stageOrder, promptRef, extractionSpec for chat config). REPLACES the whole data bag — to merge in a few keys while preserving the rest, use hadron_update_node_data instead.'),
  llmModel: z.string().optional().describe('LLM model used'),
  aiAgent: z.string().optional().describe('AI agent tool used'),
  edges: z.array(z.object({
    targetUrn: z.string().describe('Target node fully-qualified URN'),
    name: z.string().optional().describe('Relationship name (was "label"), e.g. depends-on, documents'),
    loc: z.string().optional().describe('Explicit edge loc. Omit to derive <sourceLoc>:<name>:<targetLoc>.'),
    description: z.string().optional().describe(EDGE_DESCRIPTION_DOC),
    isRunnable: z.boolean().optional().describe('Whether this edge can be run/executed (task/conversation flows)'),
  })).optional().describe('REPLACES the node\'s ENTIRE outgoing edge set — it does NOT merge. Any existing edge you do not re-supply here is DELETED, silently and without a diff. Unlike every other argument on this tool (omit `content` and content is preserved, omit `tags` and tags are preserved), omitting an edge does not preserve it. To change ONE edge, use hadron_update_edge instead; to add one without touching the others, use hadron_create_edge. If you must use this argument, read the node first and re-supply every edge you want to keep.'),
  reason: z.string().optional().describe('Why this change was made (stored in revision history)'),
  install: z.object({
    app: z.string().describe('The App: its ID or fully-qualified URN.'),
    agent: z.string().describe('The Agent the App customises: its ID or fully-qualified URN.'),
  }).optional().describe('#2044 — write into an App\'s INSTALL MEMORY (where it keeps its customisation of an installed Agent, cor:agt:040:06) instead of a memory named by `urn`. When set, `urn` is just the node\'s LOC (e.g. "prompts:lane"), not a URN. The first create finds-or-creates the install memory in the same step as the write; later calls reuse it. Only whoever manages the App may write, while the App is live and the Agent installed. Creates nothing: the memory exists once the first hadron_create_node with `install` has run. Not supported with `edges`, `isRunnable` or `abstractStillAccurate`.'),
};

const SHAPE_HADRON_UPDATE_NODE_DATA = {
  nodeUrn: z.string().describe('Node to update — a fully-qualified node URN (hrn:node:<root>:<memory>:<loc>) or an ID-shape PK.'),
  data: z.record(z.string(), z.unknown()).describe('JSON object to merge into the node\'s `data`. Must be an object (not an array or scalar). Its top-level keys overwrite existing ones; unmentioned keys are preserved.'),
};

const SHAPE_HADRON_CREATE_OBJECT = {
  memoryUrn: z.string().describe('Memory to create the object in — a fully-qualified URN (hrn:mem:<root>:<slug>) or an ID.'),
  type: z.string().describe('The collection this object belongs to (e.g. "competitor"). A single segment (no ":").'),
  fields: z.record(z.string(), z.unknown()).describe('The object\'s flat fields (typed properties). "id"/"type" are reserved.'),
  key: z.string().optional().describe('Optional natural id → a human-meaningful loc (<type>:<key>); a single segment (no ":"). Omit for an auto-generated id.'),
  name: z.string().optional().describe('Optional display name for the underlying node (defaults to a name/title field, else the type).'),
};

const SHAPE_HADRON_GET_OBJECT = {
  ref: z.string().describe('Object id (or a fully-qualified node URN).'),
};

const SHAPE_HADRON_UPDATE_OBJECT = {
  ref: z.string().describe('Object id (or a fully-qualified node URN).'),
  fields: z.record(z.string(), z.unknown()).describe('Fields to merge in. "id"/"type" are reserved.'),
  reason: z.string().optional().describe('Optional rationale, recorded in revision history.'),
};

const SHAPE_HADRON_DELETE_OBJECT = {
  ref: z.string().describe('Object id (or a fully-qualified node URN).'),
  hard: z.boolean().optional().describe('Permanently remove the row (default false = soft delete).'),
};

const SHAPE_HADRON_FIND_OBJECTS = {
  memoryUrn: z.string().describe('Memory to query — a fully-qualified URN (hrn:mem:<root>:<slug>) or an ID.'),
  type: z.string().describe('The collection to query (e.g. "competitor").'),
  match: z.record(z.string(), z.unknown()).optional().describe('Equality shorthand: { field: value, ... } → an AND of eq predicates (cast inferred from the schema).'),
  where: z.record(z.string(), z.unknown()).optional().describe('Full #719 structured predicate over the object\'s fields (ANDed with match).'),
  sort: z.record(z.string(), z.unknown()).optional().describe('Single-field sort: { field: "asc" | "desc" }, e.g. { "fundingUsd": "desc" }.'),
  limit: z.number().optional(),
  offset: z.number().optional(),
};

const SHAPE_HADRON_REPLACE_TEXT = {
  oldText: z.string().describe('Text to find (literal substring), or a regular-expression source when regex:true. Must be non-empty.'),
  newText: z.string().describe('Replacement text. May be empty to delete the matched text. In regex mode, $1/$<name>/$& are honored.'),
  nodeUrns: z.array(z.string()).optional().describe('Explicit nodes to edit — fully-qualified node URNs (hrn:node:<root>:<memory>:<loc>) or ID-shape values.'),
  memoryUrns: z.array(z.string()).optional().describe('Edit every live node in these memories — fully-qualified memory URNs (hrn:mem:<root>:<slug>) or ID-shape values. At least one of nodeUrns / memoryUrns is required.'),
  prefix: z.string().optional().describe("Restrict the memoryUrns selection to a subtree: the node at this loc plus its descendants. Requires memoryUrns (loc is only unique within a memory)."),
  fields: z.array(z.enum(['content', 'name', 'alias', 'description', 'abstract', 'tags']))
    .describe('Which text fields to search. At least one required.'),
  caseInsensitive: z.boolean().optional().describe('Match case-insensitively (default false).'),
  regex: z.boolean().optional().describe('Treat oldText as a regular-expression source and newText as a replacement pattern (default false).'),
  dryRun: z.boolean().optional().describe('Preview only: report per-node match counts WITHOUT writing anything. Strongly recommended before a real run.'),
};

const SHAPE_HADRON_CREATE_EDGE = {
  sourceUrn: z.string().describe('Source node, as an ID-shape PK (preferred — immutable across move/rename) OR a fully-qualified URN, e.g. "hrn:node:acme.com:mmdata:services:db-helper". The source node must already exist; this tool will not create it.'),
  targetUrn: z.string().describe('Target node, as an ID-shape PK (preferred) OR a fully-qualified URN. The target must already exist; use hadron_create_node first if it does not.'),
  name: z.string().optional().describe('Relationship name (was "label"), e.g. "depends-on", "documents", "supersedes". Optional — loc is the identity.'),
  loc: z.string().optional().describe('Explicit edge loc (its identity + URN suffix hrn:edge:<root>:<memory>:<loc>). Omit to derive <sourceLoc>:<name>:<targetLoc>.'),
  description: z.string().optional().describe(EDGE_DESCRIPTION_DOC),
  isRunnable: z.boolean().optional().describe('Whether this edge can be run/executed (task automation, conversation transitions).'),
};

const SHAPE_HADRON_UPDATE_EDGE = {
  edgeRef: z.string().describe('Edge to update, as an ID-shape PK (preferred — immutable) OR a fully-qualified edge URN.'),
  name: z.string().nullable().optional().describe('New relationship name, e.g. "depends-on". Pass null to clear it.'),
  loc: z.string().optional().describe('New edge loc (its identity + URN suffix). Changing this changes the edge URN.'),
  description: z.string().nullable().optional().describe(`${EDGE_DESCRIPTION_DOC} Pass null to clear it.`),
  isRunnable: z.boolean().optional().describe('Whether this edge can be run/executed.'),
  priority: z.number().int().optional().describe('Routing priority among sibling edges. Must be an integer.'),
  condition: z.record(z.string(), z.unknown()).nullable().optional().describe('JSONLogic routing condition evaluated when the walker picks an outgoing edge. Pass null to clear it (an unconditional edge).'),
  data: z.record(z.string(), z.unknown()).nullable().optional().describe('Structured data carried on the edge. REPLACES the stored object; pass null to clear it.'),
};

const SHAPE_HADRON_DELETE_EDGE = {
  edgeRef: z.string().describe('Edge to delete, as an ID-shape PK OR a fully-qualified edge URN.'),
};

const SHAPE_HADRON_DELETE_NODE = {
  urn: z.string().describe('Fully-qualified node URN, e.g. "hrn:node:acme.com:mmdata:review:sort-imports".'),
  hard: z.boolean().optional().describe('Default false (soft-delete). Pass true to delete the row entirely; cascades to Edge and NodeRevision via FK and explicitly cleans up PendingEdge target-side rows. Irreversible.'),
  recursive: z.boolean().optional().describe('Default false (refuses with descendants). Pass true to apply the same soft/hard mode to every descendant under the node\'s URN prefix.'),
  cascadeCrossMemoryEdges: z.boolean().optional().describe('Hard-delete only; default false. Pass true to acknowledge that hard-deleting will remove edges whose other endpoint lives in a different memory (the other memory\'s view loses them silently).'),
};

const SHAPE_HADRON_MOVE_NODE = {
  urn: z.string().describe('Current node fully-qualified URN, e.g. "hrn:node:acme.com:mmdata:services:db-helper"'),
  targetUrn: z.string().describe('Destination node fully-qualified URN. Different memory in the target URN performs a cross-memory move.'),
  overwrite: z.boolean().optional().describe('Default false (refuses on collision). Pass true to soft-delete an existing live target node before moving; the move then proceeds into the freed URN slot.'),
  renameToLeaf: z.boolean().optional().describe("Default false — the node keeps its name. Pass true to also overwrite the moved node's name with the target loc's terminal atom (\"services:db-helper\" → \"db-helper\"). Destroys the existing display title, so only pass it when the name is meant to track the loc."),
};

const SHAPE_HADRON_RUN_ACTION = {
  urn: z.string().describe('Fully-qualified node URN, e.g. "hrn:node:acme.com:mmdata:actions:review"'),
  args: z.record(z.string(), z.string()).optional().describe('Action arguments as key-value pairs'),
};

const SHAPE_HADRON_GET_RUN = {
  ref: z.string().describe('The run: its id, or its hrn:apprun:<root>:<app>:<run-id> URN (hadron_run_task prints the id).'),
};

const SHAPE_HADRON_RUN_TASK = {
  task: z
    .string()
    .optional()
    .describe(
      'Loose name of the task to run (matched against runnable nodes by name/alias/loc/description).',
    ),
  memory: z
    .string()
    .optional()
    .describe('Loose memory name or URN to scope the search. Omit to use the active memory.'),
  urn: z
    .string()
    .optional()
    .describe('Fully-qualified node URN to run directly, skipping name resolution.'),
  args: z
    .record(z.string(), z.string())
    .optional()
    .describe('Task arguments as key-value pairs ({{key}} substitution).'),
  appRef: z
    .string()
    .optional()
    .describe(
      'App (PK or URN) to EXECUTE the task under (#529). When set, the server mints a MANUAL app run for the resolved task and returns the run id (poll the app-run status surface) instead of the rendered prompt. Omit to get the rendered instructions for you to run yourself.',
    ),
  runAsSelf: z
    .boolean()
    .optional()
    .describe('Attribute the executed run to the calling user (only with appRef).'),
  agentRef: z
    .string()
    .optional()
    .describe(
      "Agent (PK or URN) the executed run is served as (#2735). Only with appRef. Omit to use the App's single installed Agent; an App with several installed Agents refuses with RUN_AGENT_REQUIRED.",
    ),
};

const SHAPE_HADRON_START_SESSION = {
  description: z.string().describe("What this session is about"),
  type: z.string().optional().describe('Session type: DEVELOPER, CHATBOT, AUTOMATION, EDGE'),
  repo: z.string().optional().describe('Repository being worked on (e.g. org/repo)'),
  branch: z.string().optional().describe('Git branch'),
  prNumber: z.number().optional().describe('Pull request number'),
  customerId: z.string().optional().describe('Customer ID for chatbot sessions'),
  language: z.string().optional().describe('Programming language'),
  llmModel: z.string().optional().describe('LLM model being used'),
  family: z.string().optional().describe('The model family this session runs as (cor:agt:060:04), e.g. claude, codex or glm. Omit to derive it from llmModel; a session nothing classifies gets no family, and its worker is not matched to queued tasks until one is given. A matching input only, never authorization.'),
  parentSessionId: z.string().optional().describe('Parent session ID'),
  prevSessionId: z.string().optional().describe('Previous session ID'),
  workerRef: z.string().optional().describe('The Worker (named casting) this session works as. Three forms resolve: the worker\'s NAME ("Iris" — unique within the App, case-insensitive, and what a human will say), its URN (hrn:worker:<root>:<app-slug>:<slug>), or its bare id. Prefer the name for a human-driven pickup; the URN when addressing a worker across App context. Must belong to this App; stamps the session\'s agentId from the casting and returns the worker\'s boot briefing.'),
  reportsTo: z.string().optional().describe('#1726 — the worker this worker reports to (its name in this App, URN or id), set in the same step as the bind, as a spawn brief would. Sets it only when the worker reports to nobody, or already to that worker; naming a different one refuses the bind (WORKER_REPORTS_TO_HELD) unless you manage the App. Omit to leave it unchanged.'),
  force: z.boolean().optional().describe('Take over a WORKER_TAKEN worker — one someone drove RECENTLY (#1114: a merely-open session no longer refuses, so if you are seeing this refusal the session is live rather than just unclosed). That open session may be someone else\'s live work, or your own left behind by a chat session that ended without ending it (ending a chat session never ends a worker session); the server cannot tell which, so neither should you assume. Use only on the user\'s explicit override, after showing who last drove it.'),
  launchGrant: z.string().optional().describe('#1709: the single-use launch grant your host gave you when it started you (cor:agt:070:08). Pass it with your holder\'s own credential; it binds the worker it names, so workerRef may be omitted. It cannot be combined with force.'),
};

const SHAPE_HADRON_CREATE_RESUME_CLAIM = {
  session: z.string().describe('Your open worker session id (hadron_whoami lists it).'),
};

const SHAPE_HADRON_RESUME_SESSION = {
  session: z.string().optional().describe('Pick one of a listed answer\'s sessions by its id. Omit on the first call.'),
  description: z.string().optional().describe('What the next session is about, used only when the redemption starts a new one (after a rotation).'),
  llmModel: z.string().optional().describe('LLM model: recorded on a session the redemption starts, and refreshed on an open session it resumes (never cleared when omitted).'),
  family: z.string().optional().describe('Model family (claude, codex, glm…): recorded on a session the redemption starts, and refreshed on an open session it resumes. Wins over the family the model implies; an invalid token is refused before a claim is spent.'),
};

const SHAPE_HADRON_END_SESSION = {
  id: z.string().describe('Id of the session to end — a Hadron session id (the worker session id, when one is bound), never anything about your chat session'),
  summary: z
    .string()
    .optional()
    .describe(
      'A label on the session ROW, readable via the `session` / `sessions` GraphQL queries. It is NOT the continuity record: no worker-handoff path reads it, so the next driver of this worker never sees it (#1100). ' +
        'If you are writing something for whoever comes next, that is `handoff`. ' +
        'This used to be described as "Summary of what was accomplished", which is exactly what a departing worker thinks it is writing: choosing it succeeds, returns a normal receipt, and delivers nothing to anyone. ' +
        'The two mistakes are not symmetric. Putting continuity prose here produces NO handoff, and cannot be corrected afterwards — the sequence is append-only and the stint has ended, so the remedy is to bind again and end that session with the prose. Putting a label in `handoff` is merely untidy: the label is missing from the row and the prose reaches the next driver anyway.',
    ),
  handoff: z
    .string()
    .optional()
    .describe(
      'The closing handoff for this worker: prose the NEXT worker session bound to this worker receives at bind. Worker-bound sessions only.',
    ),
  resumeClaim: z
    .boolean()
    .optional()
    .describe(
      '#1956: also write a RESUME CLAIM, with the handoff and before the end, so the fresh context after this rotation recovers the worker with hadron_resume_session and no arguments. Single use, 60 seconds, redeemable only by you. Your own worker session only.',
    ),
  inputTokens: z.number().optional().describe('Total input tokens used'),
  outputTokens: z.number().optional().describe('Total output tokens used'),
  turnCount: z.number().optional().describe('Number of conversation turns'),
  errorCount: z.number().optional().describe('Number of errors encountered'),
};

const SHAPE_HADRON_WHOAMI = {
  app: z.string().optional().describe('Narrow your sessions to this App ID or qualified App URN. Missing and unavailable references return no matching session.'),
  workerRef: z.string().optional().describe('Narrow your sessions to this Worker ID, qualified Worker URN, name or slug. Ambiguous names/slugs require app or an exact ID/URN.'),
  limit: z.number().int().optional().describe('Max sessions to return (default 10, cap 50). Newest first.'),
  includeEnded: z.boolean().optional().describe('Also list recently ENDED sessions — useful to confirm you did end one, or to find the session a work record should have been attributed to.'),
};

const SHAPE_HADRON_CAST_WORKER = {
  reportsTo: z.string().nullable().optional().describe('Same-App reporting head reference; supply this or noTeam:true, never both. Only omission is compatible while choice enforcement is OFF.'),
  noTeam: z.boolean().nullable().optional().describe('true explicitly records No team; false and null are invalid. Omit reportsTo entirely when choosing this arm.'),
  role: z.string().optional().describe('The role ("backend-engineer") — picks the installed agent by its personaRole when agent is omitted, and becomes the casting\'s role label. Not validated against defined roles: cast lists are ergonomics, never a gate (cor:agt:020:00).'),
  name: z.string().optional().describe('The worker\'s name — REQUIRED in effect (#1050): omitting it refuses WORKER_NAME_REQUIRED rather than deriving one, because a name is permanent within the App. Optional in the schema only so that refusal carries its reason instead of arriving as a bare validation error.'),
  agent: z.string().optional().describe('The agent to cast (Agent URN or ID) — must be installed in the App. Omit to resolve it from role.'),
  app: z.string().optional().describe('The team App — an App URN or ID. Omit to use the session\'s active App.'),
  session: z.string().optional().describe('Your session id — used to resolve which App to cast in when app is omitted. Passing it also keeps that session alive — driving a session through any team tool counts as activity (#1081).'),
};

const SHAPE_HADRON_CHANNEL_POST = {
  channel: z.string().describe('The Channel — its id, or its address (the chat root node URN hadron_list_channels prints). Copy one of those; a ref naming nothing reads as a Channel you may not see.'),
  body: z.string().describe('The message text (max 65536 characters). Mention teammates as @worker-name or @handle.'),
  replyToSeq: z.number().int().optional().describe('seq of the message this replies to.'),
  session: z.string().optional().describe('A session id — the message is authored by that session\'s bound Worker. Omit it on a connection bound to ONE worker session to post as that Worker; on a SHARED connection (several of your sessions bound on it, e.g. several chat sessions on one host) an omitted session is refused SESSION_AMBIGUOUS (#1701). Not combinable with asMe.'),
  asMe: z.boolean().optional().describe('true posts as YOU, the human, even on a connection bound to a worker (#1697). Required to post as yourself when no worker session is bound or named; without it such a post is refused [authorship_required]. Not combinable with session.'),
};

const SHAPE_HADRON_CHANNEL_READ = {
  replyToSeq: z.number().int().optional().describe('Only direct replies to this seq, excluding the target. Missing or deleted target refuses TEAM_CHAT_REPLY_NOT_FOUND. AND-composes with other filters; not combinable with monitor:true.'),
  channel: z.string().describe('The Channel — its id, or its address (the chat root node URN hadron_list_channels prints). Copy one of those; a ref naming nothing reads as a Channel you may not see.'),
  sinceSeq: z.number().int().optional().describe('Only messages with seq strictly greater than this watermark.'),
  beforeSeq: z.number().int().optional().describe('Page BACKWARD: only messages with seq strictly less than this, newest page of those. Ignores offset.'),
  teamHeadRef: z.string().optional().describe('Filter by an authorized stable team-head ID; mutually exclusive with untagged.'),
  untagged: z.boolean().optional().describe('Filter for no stored head identity, including historical absent snapshots. Requires team metadata access.'),
  mentions: z.string().optional().describe('Filter to messages mentioning this worker (name or id) or user (handle/id) of the host App. For a worker this includes its stored team-broadcast recipients and qualifying global broadcasts (including legacy @team), decided at post time; never its own posts.'),
  limit: z.number().int().optional().describe('Page size (default 20, cap 200).'),
  offset: z.number().int().optional().describe('Legacy oldest-first page offset. Prefer sinceSeq or beforeSeq for stable paging.'),
  session: z.string().optional().describe('Your session id — passing it keeps that session alive (#1081).'),
  expectedIncarnation: z.number().int().optional().describe('#2181: pin the read to the Channel incarnation you read (the "incarnation" on the final line of a read). A different one is [channel_incarnation_changed] with no page and no cursor, check or resume applied; omitted, the read is unfenced.'),
};

const SHAPE_HADRON_TEAM_CHAT_POST = {
  body: z.string().describe('The message text (max 65536 characters). Mention teammates as @worker-name or @handle.'),
  replyToSeq: z.number().int().optional().describe('seq of the message this replies to (a replies-to edge is wired).'),
  session: z.string().optional().describe('A session id — the message is authored by that session\'s bound Worker. Omit it on a connection bound to ONE worker session to post as that Worker; on a SHARED connection (several of your sessions bound on it, e.g. several chat sessions on one host) an omitted session is refused SESSION_AMBIGUOUS (#1701). Not combinable with asMe.'),
  asMe: z.boolean().optional().describe('true posts as YOU, the human, even on a connection bound to a worker (#1967, as hadron_channel_post). Required to post as yourself when no worker session is bound or named; without it such a post is refused [authorship_required]. Not combinable with session.'),
  app: z.string().optional().describe('The team App — an App URN or ID. Omit to use the session\'s active App.'),
  channel: z.string().optional().describe('Spec 049: post into THIS Channel (its id or address, from hadron_list_channels) instead of the App\'s default team chat. Item J: your worker authors there when its App is the Channel\'s, or when you may write the Channel\'s host memory.'),
};

const SHAPE_HADRON_TEAM_CHAT_READ = {
  replyToSeq: z.number().int().optional().describe('Only direct replies to this seq, excluding the target. Missing or deleted target refuses TEAM_CHAT_REPLY_NOT_FOUND. AND-composes with other filters; not combinable with monitor:true.'),
  sinceSeq: z.number().int().optional().describe('Only messages with seq strictly greater than this watermark.'),
  beforeSeq: z.number().int().optional().describe('Page BACKWARD (#1116): only messages with seq strictly LESS than this, returning the NEWEST such page — pass the oldest seq you have seen. Stable under concurrent posting where offset is not. Ignores offset.'),
  teamHeadRef: z.string().optional().describe('Filter by an authorized stable team-head ID; mutually exclusive with untagged.'),
  untagged: z.boolean().optional().describe('Filter for no stored head identity, including historical absent snapshots. Requires team metadata access.'),
  mentions: z.string().optional().describe('Filter to messages mentioning this worker (name or id) or user (handle/id). For a worker this includes its stored team-broadcast recipients and qualifying global broadcasts (including legacy @team), decided at post time; never its own posts.'),
  limit: z.number().int().optional().describe('Page size (default 20, cap 200).'),
  offset: z.number().int().optional().describe('Legacy oldest-first page offset. Prefer sinceSeq or beforeSeq for stable paging.'),
  session: z.string().optional().describe('Your session id — used to resolve which team App to read when app is omitted. On an ordinary read, passing it keeps that session alive (#1081). Monitor mode uses it only as an App hint and does not heartbeat or wake the session.'),
  app: z.string().optional().describe('The team App — an App URN or ID. Omit to use the session\'s active App.'),
  channel: z.string().optional().describe('Spec 049: read THIS Channel (its id or address, from hadron_list_channels) instead of the App\'s default team chat.'),
  expectedIncarnation: z.number().int().optional().describe('#2181: with channel, pin the read to the Channel incarnation you read; see hadron_channel_read.'),
  monitor: z.boolean().optional().describe('Use the register + stored ChannelReadState for your live Worker sessions. Incompatible with sinceSeq, beforeSeq, mentions and offset.'),
  monitorFor: z.string().optional().describe('With monitor:true, narrow to one Worker by name, id or URN. It must be bound to one of your live sessions in this App.'),
  acknowledge: z.array(z.object({
    worker: z.string().describe('Exact Worker id from the returned checkpoint.'),
    channel: z.string().describe('Exact Channel id from the returned checkpoint.'),
    seq: z.number().int().min(0).describe('Exact sequence from the returned checkpoint.'),
    proof: z.string().describe('Opaque server proof from the returned checkpoint; binds Worker + Channel + sequence.'),
  })).max(TEAM_CHAT_MONITOR_MAX_TARGETS).optional().describe('With monitor:true, deliberately advance these server-issued checkpoints after routing/action succeeded.'),
};

const SHAPE_HADRON_TEAM_CHAT_SEARCH = {
  query: z.string().describe('The text to find: a literal, case-insensitive substring, 2 to 200 characters counted as typed (no trimming). % _ and the backslash have no special meaning.'),
  limit: z.number().int().optional().describe('Matches per page (default 20; a larger value is clamped to 50; below 1 is refused).'),
  cursor: z.string().optional().describe('The continuation from the previous page of THIS search (same query, chat and caller); any other use is [team_chat_search_cursor_invalid].'),
  app: z.string().optional().describe('The team App — an App URN or ID. Omit to use the active App. Ignored when channel is given.'),
  channel: z.string().optional().describe('Search THIS Channel (its id or address, from hadron_list_channels) instead of the App\'s default team chat.'),
};

const SHAPE_HADRON_TEAM_ATTENTION = {
  app: z.string().optional().describe('The App — an App URN or ID. Omit to use the selected App.'),
  since: z.string().optional().describe('Opaque token returned by the preceding successful poll. Do not pass "now".'),
};

const SHAPE_HADRON_TEAM_ATTENTION_PAGE = {
  app: z.string().optional().describe('The App — an App URN or ID. Omit to use the selected App.'),
  since: z.string().optional().describe('v1-shaped watermark token to start a scan from. Do not pass with page. Do not pass "now".'),
  page: z.string().optional().describe('Opaque continuation returned by the preceding page. Do not pass with since.'),
  limit: z.number().int().optional().describe('Max Worker/Channel pairs to emit this call (default 20, cap 100).'),
  scanLimit: z.number().int().optional().describe('Max encrypted rows to decrypt or aggregate this call (default 50, cap 100).'),
};

const SHAPE_HADRON_TEAM_ATTENTION_SWITCHOVER = {
  app: z.string().optional().describe('The App — an App URN or ID. Omit to use the selected App.'),
  action: z.enum(['preview', 'apply']).describe('preview makes no writes and pages; apply requires the exact final-page proof.'),
  page: z.string().optional().describe('preview continuation from the preceding preview page.'),
  limit: z.number().int().optional().describe('Max Worker/Channel pairs to emit per preview call (default 20, cap 100).'),
  proof: z.string().optional().describe('Required for action:"apply"; returned by the final preview page.'),
};

const SHAPE_HADRON_TEAM_CHAT_MARK_READ = {
  session: z.string().describe('Your live Worker session; selects the Worker whose own cursor advances.'),
  app: z.string().optional().describe('The App. Omit to recover it from session or the active selection.'),
  channel: z.string().optional().describe('Channel id or address. Omit for the team Channel hadron_team_chat_read serves for the App.'),
  seq: z.number().int().min(0).describe('Read through this exact sequence.'),
  expectedIncarnation: z.number().int().optional().describe('#2181: fence the mark to the Channel incarnation you read (the "incarnation" on the final line of a read). A different one is [channel_incarnation_changed] — never repeat it; read again and pin the new incarnation. The result names channelIncarnation and cursorIncarnation (null = legacy cursor, never relabelled). Omitted, the mark is unfenced.'),
};

const SHAPE_HADRON_LIST_WORKERS = {
  includeRetired: z.boolean().optional().describe('Include retired castings — historical staff whose names stay reserved.'),
  limit: z.number().int().optional().describe('Page size (default 20, cap 200).'),
  offset: z.number().int().optional().describe('Page offset.'),
  session: z.string().optional().describe('Your session id — used to resolve which team App to list when app is omitted. Passing it also keeps that session alive — driving a session through any team tool counts as activity (#1081).'),
  app: z.string().optional().describe('The team App — an App URN or ID. Omit to use the session\'s active App.'),
};

const SHAPE_HADRON_GET_WORKER = {
  workerRef: z.string().describe('The worker: its NAME ("Iris", within the App), its URN (hrn:worker:<root>:<app-slug>:<slug>), or its id.'),
  app: z.string().optional().describe('The team App — an App URN or ID. Only needed for the NAME form; omit to use the session\'s active App.'),
  session: z.string().optional().describe('Your session id. Used to resolve which App a bare NAME belongs to when app is omitted, and — whenever you pass it — to keep that session alive: driving a session through any team tool counts as activity, so its DERIVED liveness stays current while you are working (#1081; #1114 — inactivity no longer reaps anything, it only decides whether a session reads as live).'),
};

const SHAPE_HADRON_DELETE_WORKER = {
  workerRef: z.string().describe('The worker id or URN.'),
  confirmNoExternalAttribution: z.boolean().optional().describe('Explicit requester verification of no external attribution. Omitted or false refuses; ordinary yes/confirmation is insufficient.'),
};

const SHAPE_HADRON_UPDATE_WORKER = {
  workerRef: z.string().describe('The worker: its NAME ("Iris", within the App), its URN, or its id.'),
  signature: z.string().nullable().optional().describe('Per-worker signature template. Omit preserves; null refuses; blank delivers nothing. App managers only.'),
  trailer: z.string().nullable().optional().describe('Per-worker trailer template, same manager and omission rules as signature.'),
  app: z.string().optional().describe('The team App — an App URN or ID. Only needed for the NAME form; omit to use the session\'s active App.'),
  session: z.string().optional().describe('Your session id. Used to resolve which App a bare NAME belongs to when app is omitted, and — whenever you pass it — to keep that session alive: driving a session through any team tool counts as activity, so its DERIVED liveness stays current while you are working (#1081; #1114 — inactivity no longer reaps anything, it only decides whether a session reads as live).'),
};

const SHAPE_HADRON_CHANGE_WORKER_AGENT = {
  workerRef: z.string().describe('The worker: its NAME ("Iris", within the App), its URN, or its id.'),
  agent: z.string().describe('The agent the worker will cast: an Agent URN or id, installed in the App. The role is that agent\'s own.'),
  app: z.string().optional().describe('The team App — an App URN or ID. Only needed for the NAME form; omit to use the session\'s active App.'),
  session: z.string().optional().describe('Your session id: resolves which App a bare NAME belongs to, and keeps that session alive (#1081). Passing a WORKER session does not authorize the change: a worker session is refused.'),
};

const SHAPE_HADRON_SET_WORKER_REPORTS_TO = {
  workerRef: z.string().describe('The worker whose value changes: its NAME (within the App), URN or id.'),
  reportsTo: z.string().nullable().describe('The worker it reports to (name, URN or id), or null to clear.'),
  app: z.string().optional().describe('The team App (URN or id). Only needed for the NAME forms; omit to use the session\'s App.'),
};

const SHAPE_HADRON_RECORD_WORK = {
  session: z.string().describe('The session id the work is attributed to (must be a session of the team App).'),
  tool: z.string().describe('The external tool the artifact lives in, e.g. "github".'),
  kind: z.string().describe('Artifact kind: pr | issue | commit | branch | repo.'),
  ref: z.string().describe('The artifact ref — a github URL or short form; stored canonically (e.g. owner/repo#371).'),
  action: z.string().describe('What happened: opened | merged | claimed | reviewed | closed | pushed | ... (free verb).'),
  detail: z.record(z.string(), z.unknown()).optional().describe('Optional display extras (title, URL) — stored, never filtered on.'),
  model: z.string().optional().describe('Optional explicit report of the LLM model that produced the work (#1398) — use it for a model switch or a late record. Takes precedence over the session\'s model; omit to use the session\'s model. Not verified telemetry.'),
  app: z.string().optional().describe('The team App — an App URN or ID. Omit to use the session\'s active App.'),
};

const SHAPE_HADRON_TEAM_WORK_ITEMS = {
  ref: z.string().optional().describe('Artifact filter: a PR URL or owner/repo#371 matches canonically; an ownerless repo suffix such as cli#793 finds all matching GitHub repositories in this App.'),
  session: z.string().optional().describe('Filter to records of this session id.'),
  worker: z.string().optional().describe('Filter to ONE worker\'s records — its name ("Iris"), id, or URN. Everything that worker has done, across all of their sessions. A retired worker still resolves.'),
  tool: z.string().optional().describe('Filter by tool (e.g. "github").'),
  kind: z.string().optional().describe('Filter by kind: pr | issue | commit | branch | repo.'),
  limit: z.number().int().optional().describe('Page size (default 20, cap 200).'),
  offset: z.number().int().optional().describe('Page offset.'),
  app: z.string().optional().describe('The team App — an App URN or ID. Omit to use the session\'s active App.'),
};

const SHAPE_HADRON_VALIDATE = {
  memoryUrn: z.string().describe('Fully-qualified memory URN, e.g. "acme.com:mmdata"'),
};

const SHAPE_HADRON_SYNC_GRAPH = {
  memoryUrn: z.string().describe('Fully-qualified memory URN, e.g. "acme.com:mmdata"'),
};
