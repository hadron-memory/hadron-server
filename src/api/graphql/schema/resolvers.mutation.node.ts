// nodeMutations — extracted from resolvers.ts Mutation (split step 2). No behavior change.
import { currentActor } from '../../../lib/requestActor.js';
import { foreignEdgeMemoryIds } from '../../../lib/foreignEdgeMemories.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, assertBootPromptWriteAllowed, assertNoBootPromptRows, inCompileScope, isBootPromptRole } from '../../../lib/bootPrompt.js';
import { COMMENT_NODE_TYPE, assertNotCommentWrite, commentError, commentGovernedError } from '../../../lib/comments/index.js';
import { commentIdsAmong, hardDeleteThreadsOfTargets, restoreThreadsOfTargets, softDeleteThreadsOfTargets } from '../../../lib/comments/lifecycle.js';
import { decisionContainedError, isDecisionFamilyRole, refuseDecisionFamily, refuseUnderDecisionLog } from '../../../lib/decisions/index.js';
import { refuseLiveThreadsOnFold } from '../../../lib/comments/merge.js';
import { generateId } from '../../../lib/id.js';
// Spec 049 S4 — the protected-loc gate on the in-place update paths and the bulk skip.
import {
  assertLocWritable,
  protectedLocsIn,
  protectedLocCovers,
  type ProtectedLoc,
  type ProtectedSource,
} from '../../../lib/protectedLoc.js';
import { lockMemoryForChannelChange } from '../../../lib/channels.js';
import { assertNoMintedSpecRemoval, assertNoMintedSpecUnmark } from '../../../lib/mintedSpecPermanence.js';
import { assertNoGovernedRemoval, governedRemovalError } from '../../../lib/governedRemoval.js';
import {
  assertGovernedWrite,
  assertRoleDeclaredForWrite,
  lockMemoryConfigShared,
  mergedGovernedState,
  governedKindsOf,
  GOVERNED_KINDS,
  type GovernedKind,
  type GovernedContext,
  type GovernedMerge,
} from '../../../lib/governedRole.js';
import { assertEdgeSourceWritersById, assertRoleWritersForNodes, assertRoleWritersForWrite, lockEdgeUnderSourceWriters, roleWritersRefusal } from '../../../lib/nodeRoleWriters.js';
import { assertPlaceholderKeepsSpecRole, placeholderFillPatch } from '../../../lib/specCorpus.js';
import { carryGovernedSignals } from '../../../lib/governedSignals.js';
import { computeContentHash } from '../../../lib/contentHash.js';
import { decryptReadableRevisions } from '../../../lib/nodeRevisionRead.js';
import {
  buildNodeRevisionSnapshot,
  createNodeRevision,
  computeRevisionStateHash,
  ensureCurrentNodeRevisionInTransaction,
  editorFromAuth,
  diffNodeChanges,
  restorableNodeFields,
  revisionStateHashRefreshMarker,
  revisionStateMatches,
  jsonOrDbNull,
  REV_LABEL_MAX_LEN,
} from '../../../lib/nodeRevisionSnapshot.js';
import {
  buildReplacer,
  replaceInTags,
  SearchReplaceInvalidPatternError,
  type Replacer,
} from '../../../lib/searchReplace.js';
import { enqueueNodeEmbedding, pendingAtForRevival } from '../../../services/embedding/enqueue.js';
import { canReadMemory, isWriteBeyondRead } from '../../../mcp/access-control.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { enforceNodeSchemaOnWrite, normalizeObjectType, normalizeRole } from '../../../lib/enforceNodeSchema.js';
import {
  encryptNodeFieldsWithKey,
  decryptNodeFields,
  decryptNodeFieldsWithKey,
  getMemoryEncryptionInfo,
} from '../../../lib/nodeCrypto.js';
import { parseUrnInput, splitNodeUrn } from '../../../lib/urn.js';
import { splitWholeNodeUrn } from '../../../lib/splitNodeUrnTolerant.js';
import {
  validateLoc,
  InvalidLocError,
} from '../../../lib/validateLoc.js';
import { escapePrismaLikePattern } from '../../../lib/literalLocPrefix.js';
import { deriveEdgeLoc } from '../../../lib/edgeLoc.js';
import {
  liveEdgeEndpointSet,
  lockEdgeEndpointMemories,
  lockLiveEdgeEndpoints,
} from '../../../lib/edgeEndpointLock.js';
import {
  moveNodeSubtree,
  SubtreeMoveCollisionError,
  SubtreeMoveMintedError,
  SubtreeMoveIntoSelfError,
  SubtreeMoveSourceChangedError,
  CrossMemoryMoveUnsupportedError,
  SubtreeMoveSchemaViolationError,
  type MoveNodeSubtreeResult,
} from '../../../lib/nodeSubtreeMove.js';
import { mirrorNodeMoveToGit } from '../../../integrations/github/mirrorNodeMove.js';
import {
  NodeLocConflictError,
  NodeNotFoundError,
  NodeAbstractTooLongError,
  EdgeNotFoundError,
} from '../../../lib/entityRef/errors.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { MemoryNotFoundError } from '../../../lib/asset/gate.js';
import { lockAgentDefinitionAuthority } from '../../../lib/auth/managedSystemMemory.js';
import { resolveNodeRefForCaller } from './resolvers.nodeRefAccess.js';
import { resolveEdgeRef } from '../../../lib/entityRef/edgeRef.js';
import { GraphQLError } from 'graphql';
import { mapDeadlockToWriteConflict } from '../../../lib/memoryLockConflict.js';
import { convertHtmlToMarkdown, convertPdfToMarkdown } from '../../../lib/pdfClient.js';
import { type InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import { Prisma } from '../../../generated/prisma/index.js';
import {
  deserializeTags,
  serializeTags,
} from '../../../integrations/db/provider.js';
import { writeNodeToGit } from '../../../integrations/github/writeNodeToGit.js';
import { mirrorEdgeSourceAfterCommit } from '../../../integrations/github/mirrorEdgeSource.js';
import { publishNodeWritten } from '../../../lib/events/nodeWritten.js';
import {
  recordNodeRead,
  recordNodeUsage,
  recordNodeWrite,
  toUsageNodeRef,
  toUsageNodeRefs,
} from '../../../lib/usageRecorder.js';
import { nextSiblingSeq } from '../../../lib/nodeSeq.js';
import { authoredContentChanged, carryNodeAuthorship, clearNodeAuthorship, type NodeAuthorshipStamp } from '../../../lib/nodeAuthorship.js';
import { mergePropertiesPatch } from '../../../lib/skilldoc/exportsMerge.js';
import {
  ancestorLocs,
  lockAncestorsForCreate,
  acquireLockSet,
  lockLocForWrite,
  lockNodeForDelete,
} from '../../../lib/nodeSubtreeLock.js';
import {
  mergeNodeFields,
  ALL_NODE_MERGE_FIELDS,
  type NodeMergeField,
} from '../../../lib/nodeMerge.js';
import {
  type Context,
  getAccessibleMemoryIds,
  mapToolDriveFile,
  runOwnedEmailOperation,
  throwOnInvalidCondition,
  throwOnReservedExtractionSpec,
  requireMemoryWriteAccess,
  memoryWriteForbidden,
  isMemoryReadableCached,
  concealUnreadableDenial,
  concealUnreadableNodeDenial,
  nodeNotFoundError,
  resolveMemoryRefForWrite,
  isMemoryHiddenForWrite,
  withoutRequestCaches,
  canReadMemoryRecord,
  type NodeInput,
  type NodeEdgeInput,
  type CreateNodeInput,
  type UpdateNodeInput,
  type SearchReplaceInNodesInput,
  type MergeNodesInput,
} from './resolvers.helpers.js';
import { type ToolDriveFile } from '../../../lib/emailClient.js';
import { concealWriteBeyondRead, findInstallMemory, lockInstallAuthorityFirst, resolveInstallTarget, withInstallMemory, type InstallTarget } from './installMemory.js';
import { searchReplaceInSpecNodes } from './resolvers.searchReplaceSpec.js';
import { resolveNodeContent } from '../../../lib/includes/resolveNodeContent.js';
import { assertIncludesWritable, includeRefusal, syncDerivedIncludesEdges } from '../../../lib/includes/writeIncludes.js';
import { deletePendingEdgesTargetingNodes, reconcilePendingEdgeCounts } from '../../../lib/pendingEdgePromotion.js';
import { memoryIsVectorIndexed } from '../../../lib/embedding/indexing.js';

/**
 * #1606 (cor:dmo:110:01/04) — no generic edge write alters or removes a
 * comment's anchor or reply edge. Read on the transaction, after the gate.
 */
async function refuseGovernedEdge(tx: Pick<Prisma.TransactionClient, 'edge'>, edgeId: string): Promise<void> {
  const edge = await tx.edge.findUnique({ where: { id: edgeId }, select: { governedKind: true } });
  if (edge?.governedKind === 'INCLUDE') {
    throw includeRefusal('INCLUDE_EDGE_DERIVED', 'This edge is derived from an include tag in the source node\'s content; edit that content instead.');
  }
  if (edge?.governedKind) throw commentGovernedError('edge', 'edits');
}

// ── Shared node-write core (spec 039 Phase 0 D1) ────────────────────────────
//
// The single canonical single-node write path — formerly the upsertNode
// resolver. Public callers reach it through createNode / updateNode below;
// server-internal callers (updateNodeData, and the spec-039 import worker)
// call it directly and may use mode 'upsert', which is no longer exposed on
// the GraphQL surface. Every single-write invariant lives here once:
// per-memory write auth, encryption (decrypt→mutate→re-encrypt), NodeRevision
// snapshot, abstractOriginHash recompute, re-embed enqueue, git mirror.
type NodeWriteMode = 'create' | 'update' | 'upsert';
/** NodeInput with `name` optional — update mode preserves it on omit (D4). */
type NodeWriteInput = Omit<NodeInput, 'name'> & { name?: string };

/**
 * Why did an update-by-PK match no row? Extracted so the decision is testable
 * even though the race that reaches it is not (@copilot, PR #1198).
 *
 * With the address and liveness carried in the write's own predicate, a
 * zero-row update has three causes and they are not interchangeable:
 *
 *   - `moved`   — the row is alive at a DIFFERENT address, so reporting "not
 *                 found" would contradict the NODE_WRITE_CONFLICT contract for
 *                 a node that plainly still exists;
 *   - `deleted` — soft-deleted; NODE_NOT_FOUND is correct and matches the
 *                 unlocked mode gate's own refusal;
 *   - `gone`    — no row at all (hard delete), likewise NODE_NOT_FOUND.
 *
 * A soft-deleted row that ALSO moved reports `deleted`: the caller cannot act
 * on a tombstone's new address, and "it was deleted" is the outcome they need.
 */
export async function classifyFailedUpdate(
  db: Pick<Prisma.TransactionClient, 'node'>,
  targetNodeId: string,
): Promise<
  { kind: 'moved'; memoryId: string; loc: string } | { kind: 'deleted' } | { kind: 'gone' }
> {
  const row = await db.node.findUnique({
    where: { id: targetNodeId },
    select: { loc: true, memoryId: true, deletedAt: true },
  });
  if (!row) return { kind: 'gone' };
  if (row.deletedAt) return { kind: 'deleted' };
  return { kind: 'moved', memoryId: row.memoryId, loc: row.loc };
}

async function writeNodeCoreRaw(
  rawInput: NodeWriteInput,
  ctx: Context,
  mode: NodeWriteMode,
  // Update-by-PK anchor (updateNode's `id` selector path). When set, the
  // existence check and the UPDATE's `where` key on this immutable PK
  // instead of (loc, memoryId) — a concurrent move that frees the old loc
  // for another node can otherwise make the loc-keyed write hit the wrong
  // row (PR-460 review).
  //
  // guardRevSeq (#989): update-mode compare-and-swap on Node.revSeq — the
  // per-node monotonic revision counter every revisioned write bumps
  // (#696), which makes it THE optimistic-concurrency token (updatedAt is
  // unusable: createNodeRevision's own revSeq increment fires @updatedAt
  // before the main write, invalidating any timestamp anchor). The claim
  // of the next revision number IS the compare-and-swap: it lands only
  // while revSeq still equals this value, else the typed
  // NODE_WRITE_CONFLICT refuses — BEFORE the revision snapshot, so a
  // refused write leaves no artifact. For callers whose precondition must
  // hold against writers outside their own locking discipline. (#1050 removed
  // this option's original caller — updateTeamRole's expectedNames — but the
  // mechanism stays: it is the generic guarded-write primitive, and the next
  // caller-level precondition will need exactly it.)
  opts?: {
    /** Reuse a caller's lock transaction; effects wait for its commit. */
    transaction?: {
      tx: Prisma.TransactionClient;
      pooledDb: Context['db'];
      afterCommit: (effect: () => void) => void;
    };
    targetNodeId?: string;
    guardRevSeq?: number;
    /**
     * #2046 (S9-4): write a revision even when no field changed. The compile
     * must leave one revision per compile, and the generic writer skips an
     * identical-content save. Honoured ONLY inside `withCompileWrite`; outside
     * it the option is ignored, so no request path can mint empty revisions.
     */
    forceRevision?: boolean;
    /**
     * The ADDRESS-protection source this caller owns — `'channel'`, passed by a
     * Channel's own operations. Since #1201 the Channel table is the only
     * source of address protection again (`Memory.protectedLocs` is gone), so
     * every node-authoring caller omits this and is refused at a Channel
     * address — the safe default `a-gate-a-caller-can-omit` asks for.
     *
     * DISTINCT FROM `ownsKind` below, and the two must not be merged: this one
     * is about WHERE a write lands, that one about WHAT it produces. A spec
     * door is exempt from the spec ROLE gate and still fully subject to Channel
     * protection, which is what stops it forging chat authorship (#1190 shipped
     * a single boolean covering both and @codex + @copilot flagged it P1).
     */
    owns?: ProtectedSource;
    /**
     * #1201 — the GOVERNED KIND this caller is the door for. Passed only by a
     * kind's own doors (`createSpecNode` → `'spec'`, and so on); every generic
     * writer omits it and is refused when its write would PRODUCE that kind.
     *
     * Never a boolean, and never universal: a door exempts itself from its own
     * kind and stays subject to every other, so the task door cannot mint a
     * review and neither can reach a Channel address.
     */
    ownsKind?: GovernedKind;
    /**
     * #1301 — set by the generic MERGE mutations (`updateNodeData`,
     * `updateNodeProperties`) so a governed refusal can say that no door
     * merges and name the REPLACE route, instead of pointing at a door that
     * would drop every key the caller did not resend. Wording only: the gate
     * decides exactly as it would without it.
     */
    governedMerge?: GovernedMerge;
    /**
     * #1301 — set ONLY by the direct node mutations (createNode, updateNode,
     * the kind doors, the two merges), whose refusal can honestly name a
     * node-write route. Every other caller (clone, import, run tools, session
     * handoffs, asset references…) leaves it unset and its refusal offers no
     * route: "use hadron node create" does not perform a clone or a run step
     * (@codex, PR #1305).
     */
    governedContext?: GovernedContext;
    /**
     * #1316 — direct node doors conceal an unreadable target exactly like a
     * missing one. Internal callers omit this so the security fix does not
     * redesign unrelated write surfaces while #1220 remains separately scoped.
     */
    concealUnreadable?: { entity: 'memory' | 'node'; ref: string };
    /** #1326 — an internal clone carries the source's already-stored stamp. */
    copiedAuthorship?: NodeAuthorshipStamp;
    /**
     * #1330 — a node the SERVER writes on its own account, exempt from the
     * strict-sub-role refusal (`assertRoleDeclaredForWrite`). Only server code
     * can pass it, never a client, which is what makes the exemption
     * trustworthy. No caller needs it yet: no platform writer sets a role.
     */
    platformWrite?: boolean;
  },
) {
      // Keep the historical `input` name so the body below stays a
      // minimal-diff move from the upsertNode resolver it used to be.
      let input = rawInput;
      // Spec 022: `memoryId` MUST be supplied (typeDefs marks it `String!`).
      // Route through `resolveMemoryRef` so:
      //   - ID-shape inputs (CUID / 32-char hex) dispatch via spec 007
      //   - URN-shape inputs trigger `assertFullyQualifiedUrn(_, 'memory')`
      //     and reject relative-form inputs with UrnNotQualifiedError
      //     (mapped to `URN_NOT_QUALIFIED` by Apollo's formatError)
      //
      // The pre-022 fallback that walked all accessible memories looking
      // for a URN prefix of `input.loc` was the API-boundary loose-lookup
      // path the spec exists to close — removed.
      // #2044: CreateNodeInput.memoryId is nullable on the wire (the other target is an App's
      // install memory, handled by createNode before it gets here), so every other door refuses a miss.
      if (!input.memoryId) {
        throw new GraphQLError('A node write needs `memoryId`.', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      const rawMemoryRef = input.memoryId;
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, rawMemoryRef);
      input.memoryId = resolvedMemoryId;
      // #1316: the direct node doors conceal an unreadable target exactly like
      // a missing one, through the SHARED classifiers — a memory-addressed door
      // against the record gate, a node-addressed one against the node-content
      // gate (the line Query.node draws). Successful writers are never
      // narrowed: some App-session principals legitimately write a private
      // memory without record-read access. Internal callers pass no
      // concealUnreadable and keep the bare denial.
      const conceal = opts?.concealUnreadable;
      const authorizeWrite = async (authCtx: Context) => {
        const gate = () => requireMemoryWriteAccess(authCtx, resolvedMemoryId);
        if (!conceal) {
          await gate();
        } else if (conceal.entity === 'node') {
          await concealUnreadableNodeDenial(authCtx, resolvedMemoryId, () => nodeNotFoundError(conceal.ref), gate);
        } else {
          await concealUnreadableDenial(authCtx, resolvedMemoryId, conceal.ref, gate);
        }
      };
      await authorizeWrite({ ...ctx, installWritePreflight: true });
      // Spec 049 S4 / #1180: a protected address is written by its owning
      // operation only. Since #1201 the ONLY source is the Channel table, and
      // only a Channel's own operations pass the bypass; every node-authoring
      // caller — the kind doors included — omits it and is refused there.
      // The verb is MODE-DERIVED, not the blanket 'write' (@copilot, PR #1198,
      // round 4). `write` is ambiguous — it covers create and update at once —
      // and the remedy has to name a door that can do what the caller asked, so
      // an ambiguous verb forces the message to guess. It guessed wrong in both
      // directions: an EDIT at a Channel-overlapping address was told to "post
      // with createTeamChatMessage" (a post cannot edit), and an edit at a
      // declared address was offered the create door alongside the edit one.
      // The core knows its mode; passing it removes the ambiguity at the source
      // rather than papering over it in the message.
      await assertLocWritable(
        ctx.db,
        input.memoryId,
        input.loc,
        mode === 'update' ? 'update' : 'create',
        opts?.owns,
      );

      // Validate loc shape at the GraphQL boundary so any caller — portal,
      // MCP, tests, future — gets the same typed InvalidLocError instead
      // of a downstream Prisma constraint failure leaking as INTERNAL_SERVER_ERROR.
      // The typed-error class is the source of truth for both the code
      // string (extensions.code = e.name) and the user-facing message,
      // matching the pattern at line ~5010.
      try {
        validateLoc(input.loc);
      } catch (e) {
        if (e instanceof InvalidLocError) {
          throw new GraphQLError(e.message, {
            extensions: { code: e.name, loc: e.loc, segment: e.segment },
          });
        }
        throw e;
      }

      // #476 / #488 — contentType conversion at the single write seam, so the
      // converted Markdown (not the source HTML/PDF) is what every downstream
      // invariant sees: encryption, NodeRevision snapshot, abstractOriginHash,
      // re-embed, git mirror. 'text/markdown' (default) is a no-op; 'text/html'
      // converts captured DOM via hadrontool-pdf (which sanitizes — no second
      // pass here); 'application/pdf' takes raw base64 (a PDF is binary, so the
      // inline `content` String carries it base64-encoded) and extracts the
      // text layer. Both non-markdown types fill properties.title from the
      // converter's extraction. The field is consumed here, never stored.
      if (input.contentType !== undefined) {
        // Consume the field FIRST — for explicit null as well as strings
        // (PR-486 review, Codex P2): contentType is not a Node column, and
        // a `contentType: null` that skipped consumption would leak into
        // the Prisma payload and turn a plain store-as-Markdown request
        // into a validation error.
        const rawContentType = input.contentType;
        {
          const { contentType: _consumed, ...rest } = input;
          input = rest;
        }
        const ct = rawContentType == null ? 'text/markdown' : rawContentType.trim().toLowerCase();
        if (ct !== 'text/html' && ct !== 'text/markdown' && ct !== 'application/pdf') {
          throw new GraphQLError(
            `Unsupported contentType "${rawContentType}" — use text/markdown (default), text/html, or application/pdf.`,
            { extensions: { code: 'BAD_USER_INPUT' } },
          );
        }
        if (ct !== 'text/markdown' && typeof input.content === 'string' && input.content.trim() !== '') {
          const { markdown, title } =
            ct === 'text/html'
              ? await convertHtmlToMarkdown(input.content)
              : await convertPdfToMarkdown(input.content);
          input = { ...input, content: markdown };
          // Fill title only when properties is absent or a plain object — a
          // caller-supplied scalar/array JSON value passes through untouched
          // (PR-485 review: spreading a string would corrupt it into
          // {0:'…'}). And never mutate in place: args may be frozen.
          const props = input.properties as unknown;
          const propsIsPlain =
            props == null || (typeof props === 'object' && !Array.isArray(props));
          if (
            title &&
            propsIsPlain &&
            (props as Record<string, unknown> | null | undefined)?.title == null
          ) {
            input = {
              ...input,
              properties: { ...((props as Record<string, unknown>) ?? {}), title },
            };
          }
        }
      }

      // Spec 031 — abstract validation + normalization. Length-cap check
      // on the raw input first; then trim-then-check normalization (empty
      // + whitespace-only collapse to null; non-empty trimmed values
      // persist untrimmed so intentional surrounding whitespace on real
      // paragraphs is lossless). Applied at the resolver layer so this
      // surface matches the MCP hadron_create_node / hadron_update_node semantics.
      // `undefined` (key absent) means "preserve existing" and bypasses
      // both checks.
      //
      // The normalized value is reassigned back onto `input.abstract`
      // BELOW (after validation), but we compute it in a local first so
      // the resolver doesn't observe a mutated args object before its
      // validation has settled (defense against future GraphQL runners
      // that freeze args).
      if (input.abstract !== undefined && input.abstract !== null) {
        if (input.abstract.length > 2000) {
          const err = new NodeAbstractTooLongError(input.abstract.length);
          // Same shared envelope as the edit-aware sites — for a create or
          // full replacement it carries no currentLength (none exists), so
          // the wire shape is identical to the previous literal.
          throw new GraphQLError(err.message, {
            extensions: err.extensionFields(),
          });
        }
        const normalized: string | null =
          input.abstract.trim() === '' ? null : input.abstract;
        input = { ...input, abstract: normalized };
      }

      // #1219 (cor:dmo:060:02, ruling "A" via Vera) — an empty/whitespace role
      // is the same as no role → null, beside objectType's #725 normalization.
      // Applied HERE, before the first consumer (mergedGovernedState's
      // before/after judgment below, the locked-row re-checks and the
      // resurrection path all read input.role), so every write path and every
      // governance judgment sees ONE spelling of "ungoverned". `undefined`
      // stays undefined — omit-on-update preserves the existing role.
      if (input.role !== undefined && input.role !== null) {
        input = { ...input, role: normalizeRole(input.role) };
      }

      // Reject saves whose extraction-spec arrays would write into the
      // reserved exception namespace (spec 001-edge-condition-spec FR-013).
      throwOnReservedExtractionSpec(input.data);

      // Snapshot current state before update (for revision history). The
      // update-by-PK path anchors on the immutable id; everything else keys
      // on (loc, memoryId).
      const existing = await ctx.db.node.findUnique({
        where: opts?.targetNodeId
          ? { id: opts.targetNodeId }
          : { loc_memoryId: { loc: input.loc, memoryId: input.memoryId } },
      });

      // #1201 — the GOVERNED-KIND gate, on the RESULTING STATE.
      //
      // Deliberately reads the merged post-write state rather than the input.
      // A gate reading only what a write DECLARES is evaded in two legal steps:
      // create a node carrying no `isRunnable`, then set `isRunnable: true` in a
      // second generic update against a node that was not governed when it was
      // written. Neither step declares a governed node; the pair produces one.
      //
      // It also means an UPDATE to an existing governed node is gated even when
      // it touches neither signal — editing a review node's body still produces
      // a review node, so it still needs the review door. That is the point: a
      // safety check must not be rewritable through the generic surface.
      //
      // ORDER: before the mode gate for an UPDATE, after its live-collision
      // refusal for a CREATE (@copilot, PR #1203).
      //
      // For an update, "you need the review door" is more useful than "that
      // node does not exist", so the governed gate goes first. For a create at
      // a loc that already holds a LIVE node, the opposite: the collision is
      // the real answer and a ROLE_GOVERNED refusal naming a create door is
      // actively misleading, because the create door cannot create over a live
      // node either. Same refusal either way — only the remedy differs, and a
      // remedy that cannot be followed is worse than a blunt one.
      //
      // Both are unlocked fast checks, so which fires first is a message
      // decision and not a safety one; the authoritative refusals are unchanged.
      //
      // MERGED ON EVERY MODE, create included (@codex P1, PR #1203). A create
      // is not always a create: `createNode` RESURRECTS a soft-deleted row at
      // the target loc and PRESERVES the fields the caller omits. So
      // soft-deleting a review and then creating at the same loc, naming
      // neither signal, passed an input-only check and resurrected a
      // still-governed node with fresh content — the resulting-state rule
      // defeated by the one path where a create carries prior state.
      //
      // Merging unconditionally is also simpler than special-casing the
      // tombstone: with no existing row the merge IS the input, and a LIVE row
      // in create mode is refused by the mode gate below regardless.
      if (mode === 'create' && existing && !existing.deletedAt) {
        const collision = new NodeLocConflictError(input.loc, input.memoryId);
        throw new GraphQLError(collision.message, {
          extensions: { code: collision.name, loc: collision.loc, memoryId: collision.memoryId },
        });
      }
      // #1606 (cor:dmo:110:04) — no generic write creates, converts or edits a
      // comment, a tombstoned one included (a create at its loc would resurrect
      // it). Every caller of the core — createNode/updateNode, the kind doors,
      // updateNodeData/Properties, importNode, cloneNode — passes through here.
      assertNotCommentWrite(existing?.nodeType, input.nodeType, mode === 'update' ? 'update' : 'create');
      // #2043 — the compiled-node and worker-session boot-prompt guards (cor:agt:040:11).
      assertBootPromptWriteAllowed(existing, { nodeType: input.nodeType, role: normalizeRole(input.role) }, mode === 'update' ? 'update' : 'create');
      // #1641 — a log's child locs are its decision codes: only the decision
      // doors write there, so a squatter can never block a code.
      if (!existing && opts?.ownsKind !== 'decision') {
        await refuseUnderDecisionLog(ctx.db, input.memoryId, input.loc, 'Creating this node');
      }
      assertGovernedWrite(
        existing,
        mergedGovernedState(existing, { role: input.role, isRunnable: input.isRunnable }),
        mode === 'update' ? 'update' : 'create',
        opts?.ownsKind,
        {
          // No route for an UPDATE of a tombstone or of a missing row: every door answers it
          // NODE_NOT_FOUND too, and this gate runs before that check (@copilot,
          // PR #1305). A create over a LIVE row never gets here — the
          // collision check above refuses it first.
          // …nor for an UPDATE of a loc with no row at all (@copilot, #1305),
          // nor for a CREATE onto any existing row: a resurrection's routes
          // depend on which fields it names (the CLI routes by input), so, as
          // on MCP, a create is routable only onto a free loc (@codex, #1305).
          context:
            (mode === 'update' && (!existing || existing.deletedAt)) || (mode === 'create' && existing)
              ? undefined
              : opts?.governedContext,
          merge: opts?.governedMerge,
          surface: ctx.transport === 'mcp' ? 'mcp' : 'graphql',
          canReplay: ctx.governedCanReplay,
        },
      );

      // Mode gate (spec 039 Phase 0 D1). Create: reject if a **live** node
      // already lives at (loc, memoryId) — the portal's create form (and any
      // other creating caller) surfaces a NodeLocConflictError instead of
      // silently overwriting. Soft-deleted nodes at the target loc are
      // treated as not-existing for collision purposes — the create
      // resurrects them (the UPDATE branch below clears `deletedAt`/
      // `deletedBy` when this resurrection path runs). Update: the target
      // must exist — updateNode never creates.
      //
      // This gate runs UNLOCKED, so it settles the common case and not the
      // race. It used to claim otherwise — "a concurrent delete between this
      // gate and the write surfaces as Prisma P2025, mapped to NODE_NOT_FOUND
      // at the write below" — which holds only for a HARD delete. This repo
      // SOFT-deletes: the row is still there, the write's `where` carries no
      // `deletedAt` clause, and the edit lands on the tombstone. Measured on
      // both selector paths (@copilot, PR #1198). `assertTargetStillWritable`
      // re-checks under the address lock and is what makes this paragraph true.
      //
      // Upsert (internal callers only): legacy either-way behavior.
      const isResurrect = mode === 'create' && !!existing?.deletedAt;
      if (mode === 'create' && existing && !existing.deletedAt) {
        const err = new NodeLocConflictError(input.loc, input.memoryId);
        throw new GraphQLError(err.message, {
          extensions: { code: err.name, loc: err.loc, memoryId: err.memoryId },
        });
      }
      if (mode === 'update' && (!existing || existing.deletedAt)) {
        throw new GraphQLError(
          `Node not found at loc "${input.loc}" in memory "${input.memoryId}".`,
          { extensions: { code: 'NODE_NOT_FOUND', loc: input.loc, memoryId: input.memoryId } },
        );
      }

      // Resolve edge targets BEFORE any write so an unresolvable
      // target aborts the mutation without committing the source
      // node, the revision snapshot, or any edge changes. Per spec 007
      // (issue #105), `targetId` accepts ID, full URN, memory-prefixed
      // loc, or short loc — `resolveNodeRef` is the single resolver
      // and throws `NodeNotFoundError` on miss.
      // Spec 037: edges are first-class. Carry the target's loc so the
      // edge loc can be derived (<sourceLoc>:<name>:<targetLoc>) when the
      // caller doesn't author one; validate any author-supplied loc here.
      let resolvedEdges: Array<{
        targetNodeId: string;
        targetLoc: string;
        targetMemoryId: string;
        name: string | null;
        loc: string | null;
        description: string | null;
        isRunnable: boolean | null;
      }> | null = null;
      if (input.edges !== undefined) {
        resolvedEdges = [];
        for (const e of input.edges) {
          if (e.loc != null && e.loc !== '') {
            try {
              validateLoc(e.loc);
            } catch (err) {
              if (err instanceof InvalidLocError) {
                throw new GraphQLError(err.message, {
                  extensions: { code: err.name, loc: err.loc, segment: err.segment },
                });
              }
              throw err;
            }
          }
          try {
            const { id: targetNodeId } = await resolveNodeRefForCaller(ctx, e.targetId, input.memoryId);
            const tgt = await ctx.db.node.findUnique({
              where: { id: targetNodeId },
              select: { loc: true, memoryId: true },
            });
            // #755: the source memory was gated by requireMemoryWriteAccess
            // above, but the TARGET was not — so this inline path could point
            // an edge at a node in a memory the caller cannot read, the exact
            // gap the standalone createEdge closes. Combined with edge
            // endpoint hydration that made it a cross-tenant read primitive:
            // create a personal memory, add an edge to a victim node, then
            // read it back through Edge.target.
            //
            // Gate on the NODE-CONTENT read set (`isMemoryReadableCached` ->
            // getAccessibleMemoryIds) — the SAME predicate #781's
            // Edge.source/Edge.target hydration uses. That makes write and read
            // exactly symmetric: you may link precisely what you could read
            // back, no more and no less.
            //
            // Deliberately NOT the MCP `canReadMemory`: its personal-memory
            // branch tests `memory.userId` only and never consults MemoryShare,
            // so a `writer` share-grantee adding an inline edge into that same
            // shared memory would be refused NODE_NOT_FOUND (PR #844 review,
            // Codex P2). createEdge uses this same gate since #849.
            //
            // The denial reuses the not-found wording so it can't be used as a
            // cross-memory existence oracle.
            if (!tgt || !(await isMemoryReadableCached(ctx, tgt.memoryId))) {
              throw new GraphQLError(`Edge target not found: "${e.targetId}"`, {
                extensions: { code: 'NODE_NOT_FOUND', ref: e.targetId },
              });
            }
            resolvedEdges.push({
              targetNodeId,
              targetLoc: tgt.loc,
              targetMemoryId: tgt.memoryId,
              name: e.name ?? null,
              loc: e.loc ?? null,
              description: e.description ?? null,
              isRunnable: e.isRunnable ?? null,
            });
          } catch (err) {
            if (err instanceof NodeNotFoundError) {
              throw new GraphQLError(`Edge target not found: "${err.ref}"`, {
                extensions: { code: err.name, ref: err.ref },
              });
            }
            throw err;
          }
        }
      }

      // #725 — an empty/whitespace objectType means "no collection" → normalize
      // to null so it is stored as an ordinary node and can't bypass the
      // declared-collection check as a non-null discriminator.
      input.objectType = normalizeObjectType(input.objectType);
      // #1186: schema validation belongs to each locked write arm below;
      // the preliminary probe cannot supply preserve-on-omit values.

      // The fields this write will change, in the shape diffNodeChanges wants.
      // Hoisted out of the snapshot block below because the create/upsert path
      // now snapshots inside its own transaction and needs the same value.
      // Tags need the serialized form for a faithful compare; other input
      // fields map 1:1 onto node columns.
      const suppliedForDiff: Record<string, unknown> = { ...input };
      if (input.tags !== undefined) {
        suppliedForDiff.tags = serializeTags(input.tags ?? []);
      }

      // Tags partial-update semantics (hadron-cli#37). A create always
      // sets the column; an update only writes it when the caller actually
      // sent `tags`. `input.tags === undefined` (key omitted) means
      // "preserve existing" — the same omit→leave-untouched contract the
      // scalar fields and abstractOriginHash follow — so a partial update
      // (e.g. content-only) no longer silently clears tags. An explicit
      // array (including [], and a runtime `null` coerced via `?? []`)
      // replaces.
      const tags = serializeTags(input.tags ?? []) as string[];
      const updateTagsPayload = input.tags === undefined ? {} : { tags };
      // #1468 — what this write does to an existing row's spec marker, for
      // the guard that keeps a minted spec a spec (omitted = unchanged).
      const markerChange = (nodeId: string) => ({
        id: nodeId,
        tags: input.tags === undefined ? undefined : tags,
        role: input.role,
      });
      const id = input.id ?? generateId();
      // Strip GraphQL-only fields + `tags` from the Prisma payload.
      // `edges` is consumed above (resolved into `resolvedEdges`) and applied
      // below. `tags` is re-applied per-branch below (serialized, and
      // update-gated) — leaving the raw array in `nodeFields` would write the
      // wrong shape on SQLite and clobber the preserve-on-omit gating above.
      // `reason` is revision-history metadata (consumed into editedBy above), not
      // a Node column — strip it so it never reaches the node upsert payload.
      const {
        edges: _edges,
        tags: _tags,
        reason: _reason,
        ...nodeFields
      } = input;
      const createdBy = ctx.userId ?? ctx.clientId ?? null;

      // If the target memory is encrypted, encrypt content and data before
      // writing. Throws SESSION_EXPIRED if no session key is cached.
      const memEncInfo = await getMemoryEncryptionInfo(ctx.db, input.memoryId);

      // Spec 032 — compute abstractOriginHash. MUST happen on PLAINTEXT
      // content (FR-009), so this runs BEFORE the encryption block below
      // that mutates nodeFields.content to ciphertext.
      //
      // Matrix per contracts/hadron_update_node.md:
      //   - input.abstract === undefined  → preserve hash (omit from payload)
      //   - input.abstract === null       → clear hash
      //   - input.abstract is string      → hash from current content
      //     (current = input.content if supplied else existing.content
      //     decrypted to plaintext — FR-003 reset case)
      //
      // Gating the decrypt on `input.abstract is string` (Gemini review,
      // PR-209): avoids a per-upsert decryptString call on encrypted
      // memories when the caller didn't touch `abstract`, which is the
      // common case for unrelated field updates.
      let nextAbstractOriginHash: string | null | undefined;
      if (input.abstract === undefined) {
        nextAbstractOriginHash = undefined; // preserve
      } else if (input.abstract === null) {
        nextAbstractOriginHash = null;
      } else {
        let postUpdatePlaintextContent: string | null;
        if (input.content !== undefined) {
          postUpdatePlaintextContent = input.content;
        } else if (existing) {
          // Decrypt existing.content for hash computation on encrypted
          // memories. decryptNodeFields mutates `existing` in place;
          // existing.content is PLAINTEXT after this line — do NOT use
          // it as DB ground truth past this point. Safe today because
          // the upsert writes from `nodeFields` (caller input), not
          // from `existing`.
          if (memEncInfo.isEncrypted) {
            decryptNodeFields(existing, memEncInfo);
          }
          postUpdatePlaintextContent = existing.content;
        } else {
          postUpdatePlaintextContent = null;
        }
        nextAbstractOriginHash = computeContentHash(postUpdatePlaintextContent);
      }
      // The hash is DERIVED above and never caller-supplied, so the raw input
      // the diff reads cannot carry it. Without this, re-saving the same
      // abstract to mark it accurate against the current content (spec 032's
      // reset) diffs as a no-op and the refreshed hash is never written — on
      // plaintext memories always, and on encrypted ones since the diff began
      // comparing decrypted plaintext (Codex on #1397 `dbf7cdce`). The change
      // is revisioned like MCP's; `authoredContentChanged` ignores this derived
      // field, so a verified authorship stamp survives the reset.
      if (nextAbstractOriginHash !== undefined) {
        suppliedForDiff.abstractOriginHash = nextAbstractOriginHash;
      }

      /** Recompute against the locked row when an abstract-only write follows a concurrent body edit. */
      const hashAgainstLockedContent = (lockedContent: string | null): string | null | undefined => {
        if (input.abstract === undefined) return undefined;
        if (input.abstract === null) return null;
        if (input.content !== undefined) return computeContentHash(input.content);
        const plaintext = memEncInfo.isEncrypted
          ? decryptNodeFields({ content: lockedContent }, memEncInfo).content ?? null
          : lockedContent;
        return computeContentHash(plaintext);
      };

      if (memEncInfo.isEncrypted) {
        const key = sessionKeyCache.getByMemoryId(memEncInfo.id);
        if (!key) {
          throw new Error('SESSION_EXPIRED: memory is encrypted but no active session key is available');
        }
        // Spec 031 — `abstract` joins the encrypted-fields set; rationale
        // in nodeCrypto.ts EncryptedNodeFields doc-comment.
        const enc = encryptNodeFieldsWithKey(
          {
            abstract: (nodeFields as { abstract?: string | null }).abstract ?? null,
            content: nodeFields.content ?? null,
            data: nodeFields.data ?? null,
          },
          key,
        );
        (nodeFields as Record<string, unknown>).abstract = enc.abstract ?? undefined;
        (nodeFields as Record<string, unknown>).content = enc.content ?? undefined;
        (nodeFields as Record<string, unknown>).data = enc.data ?? undefined;
      }

      // When createOnly resurrects a soft-deleted node, the UPDATE branch
      // must clear `deletedAt`/`deletedBy` — otherwise the resurrected
      // node ends up with the new content but still flagged as deleted,
      // which is the worst of both worlds.
      const updateExtras: Record<string, unknown> = isResurrect
        ? { deletedAt: null, deletedBy: null }
        : {};
      // Spec 032 — inject abstractOriginHash into the payload. For
      // partial updates we use Prisma's "omit undefined → leave column
      // untouched" semantic for the preserve case. Stripping any
      // caller-supplied abstractOriginHash from nodeFields is
      // belt-and-suspenders (NodeInput doesn't expose the field, so
      // this is defense-in-depth for any future code path).
      const hashPayload =
        nextAbstractOriginHash === undefined
          ? {}
          : { abstractOriginHash: nextAbstractOriginHash };
      // #1450 — `isPlaceholder` is SERVER-set (reserveSpecCitation marks it,
      // a real content write clears it). No node input type carries it, but a
      // caller passing a parsed object through (an importer, an internal
      // helper) must not be able to set or clear it, so it is stripped here
      // with the same defence as the hash.
      const {
        abstractOriginHash: _stripCallerSupplied,
        isPlaceholder: _stripCallerPlaceholder,
        ...nodeFieldsClean
      } = nodeFields as Record<string, unknown>;

      // Spec: cor:dmo:020:01 (Node ordering).
      // Auto-assign `seq` for a NEW node joining an already-ordered sibling
      // list: with no explicit seq it inherits max(sibling seq)+1 and lands at
      // the end. Create-only; an explicit input.seq always wins; an unordered /
      // empty sibling list leaves seq null (nextSiblingSeq returns null).
      const seqForCreate =
        existing == null && input.seq == null
          ? await nextSiblingSeq(ctx.db, input.memoryId, input.loc)
          : undefined;

      // Update mode writes via `update`, not `upsert`: existence was verified
      // by the mode gate above, and with `name` now optional-on-update (D4)
      // the upsert's create payload could lack the required `name` column —
      // Prisma validates that payload eagerly even when the update branch
      // would run. A concurrent delete between the gate and this write
      // surfaces as Prisma P2025, mapped to the typed NODE_NOT_FOUND below
      // (issue #100: no raw ORM errors past the resolver boundary) rather
      // than a silent create. Create/upsert modes keep the historical upsert
      // call; their callers always supply `name`.
      //
      // The update payload never carries `loc`/`memoryId` — updateNode never
      // moves (D3), and on the update-by-PK path writing the caller-supplied
      // loc back could undo a concurrent move.
      const include = {
        outgoingEdges: { include: { target: true } },
        incomingEdges: { include: { source: true } },
      };
      const inWriteTransaction = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
        opts?.transaction
          ? work(opts.transaction.tx)
          : mapDeadlockToWriteConflict(input.memoryId, () => ctx.db.$transaction(async (tx) => {
            // #2044: an install memory's authority comes before ANY memory/node/loc lock.
            await lockInstallAuthorityFirst(tx, ctx, input.memoryId);
            return work(tx);
          }));

      // encryptMemory and ownership transfer both change what this writer may
      // commit. Hold a shared memory-row lock through the write, then recheck
      // encryption and authorization on the transaction's fresh view. The
      // preflight gate above can precede a transfer while the transaction
      // below follows it; request caches must not replay that old decision.
      const assertMemoryWriteStateStable = async (tx: Prisma.TransactionClient) => {
        await tx.$queryRaw`SELECT id FROM memories WHERE id = ${input.memoryId} FOR SHARE`;
        const latest = await tx.memory.findUniqueOrThrow({
          where: { id: input.memoryId }, select: { isEncrypted: true },
        });
        if (latest.isEncrypted !== memEncInfo.isEncrypted) {
          throw new GraphQLError('Memory encryption changed while this node write waited; retry.', {
            extensions: { code: 'NODE_WRITE_CONFLICT', memoryId: input.memoryId },
          });
        }
        await authorizeWrite(withoutRequestCaches(ctx, tx));
      };

      // Inline edge replacement is part of the node mutation, not a follow-up
      // write. Acquire the complete endpoint-memory set BEFORE any loc lock or
      // source mutation, then revalidate and replace inside that same
      // transaction. If Channel reuse wins first, the endpoint refusal rolls
      // back the node write too; if this write wins, reuse waits until both the
      // source and its outgoing edge set commit together.
      const inlineEdgeTargets = resolvedEdges?.map((edge) => ({
        id: edge.targetNodeId,
        loc: edge.targetLoc,
        memoryId: edge.targetMemoryId,
      })) ?? [];
      async function lockInlineEdgeMemories(tx: Prisma.TransactionClient): Promise<void> {
        if (resolvedEdges === null) return;
        await lockEdgeEndpointMemories(tx, [
          input.memoryId,
          ...inlineEdgeTargets.map((target) => target.memoryId),
        ]);
      }
      // #2040 — include tags are checked and their derived edges synced in the
      // writer's own transaction, on the plaintext the caller supplied. A
      // refusal throws, so the content, revision and edges roll back together.
      const readableForIncludes = typeof input.content === 'string' && input.content.includes('{{>')
        ? await getAccessibleMemoryIds(ctx)
        : null;
      // #2041 S2b — `storedPlaintext` is the includer's plaintext from the row
      // this write locked and revalidated, before its update; null for a create
      // or a resurrected tombstone, whose old text is not the includer's.
      async function finalizeNodeWrite<T extends { id: string; loc: string; memoryId: string }>(
        tx: Prisma.TransactionClient,
        writtenNode: T,
        storedPlaintext: string | null,
      ): Promise<T> {
        if (input.content !== undefined) {
          const stored = { storedPlaintext };
          const tags = await assertIncludesWritable(tx, writtenNode, input.content, readableForIncludes, undefined, stored);
          const result = await replaceInlineEdges(tx, writtenNode);
          await syncDerivedIncludesEdges(tx, writtenNode, tags, readableForIncludes, stored);
          return result;
        }
        return replaceInlineEdges(tx, writtenNode);
      }
      async function replaceInlineEdges<T extends { id: string; loc: string; memoryId: string }>(
        tx: Prisma.TransactionClient,
        writtenNode: T,
      ): Promise<T> {
        if (resolvedEdges === null) return writtenNode;
        const sourceSnapshot = {
          id: writtenNode.id,
          loc: writtenNode.loc,
          memoryId: writtenNode.memoryId,
        };
        const live = await liveEdgeEndpointSet(tx, [sourceSnapshot, ...inlineEdgeTargets]);
        if (!live.has(sourceSnapshot.id)) {
          throw new GraphQLError(`Source node not found: "${writtenNode.id}"`, {
            extensions: { code: 'NODE_NOT_FOUND' },
          });
        }
        const missing = resolvedEdges.find((edge) => !live.has(edge.targetNodeId));
        if (missing) {
          throw new GraphQLError(`Edge target not found: "${missing.targetNodeId}"`, {
            extensions: { code: 'NODE_NOT_FOUND', ref: missing.targetNodeId },
          });
        }

        // Derived INCLUDE edges (#2040) belong to the content writer, not the
        // client's edge list: they survive an inline-edge replacement.
        await tx.edge.deleteMany({ where: { sourceId: writtenNode.id, governedKind: null } });
        await tx.pendingEdge.deleteMany({ where: { sourceId: writtenNode.id } });
        if (resolvedEdges.length > 0) {
          const { count } = await tx.edge.createMany({
            data: resolvedEdges.map((edge) => ({
              memoryId: writtenNode.memoryId,
              sourceId: writtenNode.id,
              targetId: edge.targetNodeId,
              loc: edge.loc ?? deriveEdgeLoc(writtenNode.loc, edge.name, edge.targetLoc),
              name: edge.name,
              description: edge.description,
              isRunnable: edge.isRunnable,
              createdBy,
            })),
            skipDuplicates: true,
          });
          // MCP's replaceOutgoingEdgesInTransaction checks the same count.
          // Both inline writers must refuse a skipped edge and roll back the
          // enclosing node mutation instead of reporting a partial save.
          if (count !== resolvedEdges.length) {
            throw new GraphQLError('An edge loc is already occupied; choose unique edge locs.', {
              extensions: { code: 'EDGE_LOC_CONFLICT' },
            });
          }
        }
        const refreshed = await tx.node.findUniqueOrThrow({ where: { id: writtenNode.id }, include });
        return refreshed as unknown as T;
      }

      /**
       * Re-read the update target UNDER THE ADDRESS LOCK and refuse if the world
       * moved after the unlocked mode-gate probe. Two TOCTOUs, both found by
       * review on PR #1198 and both PRE-EXISTING (since PR-460), both reproduced
       * before they were fixed, and both fixed here because this is the one
       * point that already holds the lock and already reads the row.
       *
       * 1. THE TARGET MOVED (@codex, P1) — id-selector path only. `updateNode`
       *    resolves `id` → (memoryId, loc) OUTSIDE any transaction, and
       *    everything protecting the write is checked against THAT address:
       *    `requireMemoryWriteAccess`, the protected-loc gate, the memory's
       *    property schema. The UPDATE itself keys on the immutable PK, so a
       *    `moveNode` committing in between leaves the two pointing at
       *    different memories and the write lands on the row at its NEW
       *    address — authorized against the memory the caller could write,
       *    applied in one that was never consulted. Refused as
       *    NODE_WRITE_CONFLICT rather than re-authorized at the new address:
       *    the caller asked to edit the node at the address they named.
       *
       * 2. THE TARGET WAS SOFT-DELETED (@copilot) — BOTH selector paths, which
       *    is wider than the finding framed it. The mode gate already refuses a
       *    tombstone (`mode === 'update' && existing.deletedAt` ⇒
       *    NODE_NOT_FOUND), but it runs unlocked, and `tx.node.update` filters
       *    on the PK or (loc, memoryId) with NO `deletedAt` clause — so a
       *    delete landing in between is written straight through, leaving a
       *    tombstone carrying an edit that was accepted after it died.
       *
       *    The comment on that mode gate asserted this was already covered: "a
       *    concurrent delete between this gate and the write surfaces as Prisma
       *    P2025, mapped to NODE_NOT_FOUND at the write below." That is true of
       *    a HARD delete, and this repo soft-deletes — the row is still there,
       *    so P2025 never fires. Prose describing a protection that does not
       *    exist; the claim is now corrected at that gate, and this is what
       *    makes it true. Measured on both paths: the write SUCCEEDED and the
       *    tombstone's content was rewritten.
       *
       * Ordering note (#1187): this adds a READ, never a lock, so it introduces
       * no new edge into the advisory-lock key space the four helpers share and
       * cannot be half of a cycle. READ COMMITTED is what makes it
       * authoritative — each statement sees the latest commit, so anything that
       * landed before it is visible.
       */
      /**
       * The moved-target refusal, built ONCE so the re-check and the P2025
       * fallback cannot disagree — and REDACTED across a memory boundary
       * (@copilot, PR #1198, round 4).
       *
       * Naming where a node went is helpful inside the memory the caller was
       * already authorized against. Across memories it is a disclosure: the
       * caller is told a loc in a memory they may not read, learned through a
       * write they were refused. That is the repo's cross-tenant criterion, not
       * a cosmetic one, so the address is withheld and only the fact of the move
       * is reported. `currentLoc` is omitted from extensions for the same
       * reason rather than merely left out of the sentence.
       */
      function movedConflict(currentMemoryId: string, currentLoc: string): GraphQLError {
        const movedMemory = currentMemoryId !== input.memoryId;
        return new GraphQLError(
          movedMemory
            ? `Node "${opts?.targetNodeId ?? input.loc}" moved since it was read — it is no ` +
              `longer in memory "${input.memoryId}", and this write was authorized against ` +
              `"${input.loc}". Re-read and retry.`
            : `Node "${opts?.targetNodeId ?? input.loc}" moved since it was read — it is now ` +
              `at "${currentLoc}", and this write was authorized against "${input.loc}". ` +
              `Re-read and retry.`,
          {
            extensions: {
              code: 'NODE_WRITE_CONFLICT',
              loc: input.loc,
              memoryId: input.memoryId,
              movedMemory,
              ...(movedMemory ? {} : { currentLoc }),
            },
          },
        );
      }

      async function assertTargetStillWritable(
        tx: Pick<Prisma.TransactionClient, 'node'>,
      ) {
        const current = await tx.node.findUnique({
          where: opts?.targetNodeId
            ? { id: opts.targetNodeId }
            : { loc_memoryId: { loc: input.loc, memoryId: input.memoryId } },
        });
        // A row that vanished entirely is left to the write below, which maps
        // Prisma's P2025 to the typed NODE_NOT_FOUND. Refusing here would swap
        // one typed error for an identical one.
        if (!current) return null;

        // #1201 governed state, RE-CHECKED under the lock (@codex P2, PR #1203).
        // The gate far above decides from an UNLOCKED read, so a kind door
        // setting `role: 'review'` or `isRunnable: true` between that read and
        // this transaction would leave a generic update rewriting a node that
        // has since become governed. Address and liveness were already
        // re-checked here; governance is the third thing that can change under
        // the same window, and it is the one with teeth.
        // #1606 — the comment gate, re-checked under the lock with the row it guards.
        assertNotCommentWrite(current.nodeType, input.nodeType, 'update');
        assertBootPromptWriteAllowed(current, { nodeType: input.nodeType, role: normalizeRole(input.role) }, 'update');
        assertGovernedWrite(
          current,
          mergedGovernedState(current, { role: input.role, isRunnable: input.isRunnable }),
          'update',
          opts?.ownsKind,
          // The AUTHORITATIVE check, under the lock: a merge that loses the
          // promotion race must still get the merge wording, or the refusal
          // sends it to a replacing door without saying so (@codex P1, #1305).
          // And a row tombstoned in that window gets no route: every door
          // answers it NODE_NOT_FOUND (@codex, #1305).
          {
            context: current.deletedAt ? undefined : opts?.governedContext,
            merge: opts?.governedMerge,
            surface: ctx.transport === 'mcp' ? 'mcp' : 'graphql',
          canReplay: ctx.governedCanReplay,
          },
        );

        if (current.deletedAt) {
          // Deliberately the SAME shape the unlocked mode gate throws, because
          // this is the same refusal arriving a few milliseconds later: from
          // the caller's side "it was deleted" is one outcome, not two.
          throw new GraphQLError(
            `Node not found at loc "${input.loc}" in memory "${input.memoryId}".`,
            {
              extensions: { code: 'NODE_NOT_FOUND', loc: input.loc, memoryId: input.memoryId },
            },
          );
        }

        if (current.memoryId === input.memoryId && current.loc === input.loc) return current;
        // NODE_WRITE_CONFLICT rather than a new code: "the target changed since
        // it was read, re-read and retry" is exactly what that code already
        // says on the revSeq compare-and-swap next door.
        throw movedConflict(current.memoryId, current.loc);
      }
      const {
        loc: _updLoc,
        memoryId: _updMemoryId,
        ...updateFields
      } = nodeFieldsClean as { loc?: string; memoryId?: string } & Record<string, unknown>;
      const updatePayload = {
        ...updateFields,
        ...updateTagsPayload,
        ...updateExtras,
        ...hashPayload,
      } as Prisma.NodeUncheckedUpdateInput;
      let node;
      try {
        if (mode === 'update') {
          // #1072/#1185/#1323 — ONE transaction owns the authoritative
          // pre-state, optional OCC claim, snapshot, visible update and inline
          // edges. Concurrent supported writers serialize before their snapshot
          // is built. Ordinary refusals throw inside the transaction and leave
          // no artifact. The exception is an already-authorized row's raw drift:
          // commit its reconciliation before reporting a stale guard, so a
          // fresh read and guarded retry can use the new revision (#1454).
          const writeConflict = () =>
            new GraphQLError(`Node at loc "${input.loc}" changed since it was read — re-read and retry.`, {
              extensions: { code: 'NODE_WRITE_CONFLICT', loc: input.loc, memoryId: input.memoryId },
            });
          const result = await inWriteTransaction(async (tx) => {
            await lockInlineEdgeMemories(tx);
            await lockLocForWrite(tx, input.memoryId, input.loc, {
              owns: opts?.owns,
              op: 'update',
            });
            const candidate = await assertTargetStillWritable(tx);
            if (!candidate) return { conflict: false, node: null };
            // #1753 — memory row BEFORE the node row, the order promotion's
            // memory FOR UPDATE already uses, so the two cannot cycle.
            await tx.$queryRaw`SELECT id FROM memories WHERE id = ${input.memoryId} FOR SHARE`;
            await tx.$queryRaw`SELECT "id" FROM "nodes" WHERE "id" = ${candidate.id} FOR UPDATE`;
            await assertMemoryWriteStateStable(tx);
            let current = await assertTargetStillWritable(tx);
            if (!current) return { conflict: false, node: null };

            // #1186 / cor:dmo:020:05 — reject invalid RESULTING state before
            // drift reconciliation can commit history for a refused write.
            await enforceNodeSchemaOnWrite(
              tx, input.memoryId,
              input.objectType !== undefined ? input.objectType : current.objectType,
              input.properties !== undefined ? input.properties : current.properties,
            );

            // Unreconciled drift (a raw writer changed tracked state without
            // advancing revSeq) is reconciled as its OWN revision BEFORE the
            // guard and the edit, exactly as an exposed read would have done.
            // Folding it into this edit's revision let a caller guarding on
            // the pre-drift number succeed over a change it never saw, and
            // hid the drift transition once the fingerprint was refreshed
            // (@codex P1, PR #1339). The row lock is already held.
            if (current.revisionContentHash !== await computeRevisionStateHash(tx, current.id)) {
              const preReconcileRevSeq = current.revSeq;
              await ensureCurrentNodeRevisionInTransaction(tx, current.id, { expectedMemoryId: input.memoryId });
              current = await assertTargetStillWritable(tx);
              if (!current) return { conflict: false, node: null };
              // A guarded write that itself reconciled drift is refused even when
              // its token equals the NEW revision: every exposed read reconciles,
              // so no token can name drift first seen here, and a token matching
              // the freshly minted number is a guess or a stale ABA collision
              // (@codex P2, PR #1458). A legacy null-fingerprint backfill mints no
              // revision and falls through to the ordinary guard below.
              // Return rather than throw: the transaction commits only the
              // reconciled drift. The caller's edit and inline edges have not
              // run, and the conflict is surfaced after commit below.
              if (opts?.guardRevSeq !== undefined && current.revSeq !== preReconcileRevSeq) {
                return { conflict: true, node: null };
              }
            }

            // #1330 — H1 strict sub-roles, judged on the locked row: a role the
            // write assigns must be declared under a strict parent.
            await assertRoleDeclaredForWrite(
              tx,
              input.memoryId,
              {
                role: input.role === undefined ? current.role : input.role,
                priorRole: current.role,
                runnableAfter: mergedGovernedState(current, { role: input.role, isRunnable: input.isRunnable }).isRunnable,
              },
              { platformWrite: opts?.platformWrite },
            );
            // #1331 — the writer level of the role before AND after, on the locked row.
            await assertRoleWritersForWrite(
              tx, ctx, input.memoryId,
              {
                priorRole: current.role, nextRole: input.role === undefined ? current.role : input.role,
                priorRunnable: current.isRunnable,
                nextRunnable: mergedGovernedState(current, { role: input.role, isRunnable: input.isRunnable }).isRunnable,
              },
              { platformWrite: opts?.platformWrite },
            );

            // The snapshot uses the at-rest row, but the caller supplied
            // plaintext. Diff a decrypted COPY so an identical encrypted save
            // neither manufactures a revision nor clears valid attribution.
            const currentForDiff = memEncInfo.isEncrypted
              ? decryptNodeFields({ ...current }, memEncInfo)
              : current;
            const lockedAbstractHash = hashAgainstLockedContent(current.content);
            const changes = diffNodeChanges(currentForDiff, {
              ...suppliedForDiff, abstractOriginHash: lockedAbstractHash,
            });
            const changesUnversionedField =
              input.ownerRepo !== undefined && input.ownerRepo !== current.ownerRepo;
            // ownerRepo deliberately remains outside restorable node history,
            // so an unguarded ownerRepo-only update keeps its legacy
            // revision-free behaviour. A guarded update is different: every
            // successful state change must consume the claimed token or the
            // same expectedRevision could be reused to overwrite it (#937).
            const needsRevision =
              resolvedEdges !== null ||
              changes.length > 0 ||
              (opts?.forceRevision === true && inCompileScope()) ||
              (opts?.guardRevSeq !== undefined && changesUnversionedField);
            if (!needsRevision && !changesUnversionedField) {
              // A stale guard is refused even when the write is a no-op: the
              // compare-and-swap protects the caller's merge base, and an
              // idempotent write must not report success against a revision
              // the caller never saw (@copilot, PR #1339). Consumes nothing.
              if (opts?.guardRevSeq !== undefined && current.revSeq !== opts.guardRevSeq) {
                throw writeConflict();
              }
              // #1450 (@codex P2, PR #1452): a placeholder that already holds
              // real content (a merge or raw write put it there) is cleared by
              // re-saving that content, even though nothing else changes. Not
              // a revisioned field, so no revision.
              const fill = placeholderFillPatch(current, input.content);
              if (Object.keys(fill).length > 0) {
                await tx.node.update({ where: { id: current.id }, data: fill });
              }
              const unchanged = await tx.node.findUniqueOrThrow({
                where: { id: current.id },
                include,
              });
              return { conflict: false, node: unchanged };
            }

            // A guarded claim happens only after the no-op decision and inside
            // this transaction. Since revSeq names the CURRENT state, the
            // snapshot uses the anchor and the live row advances to anchor+1.
            if (opts?.guardRevSeq !== undefined) {
              if (!needsRevision) {
                if (current.revSeq !== opts.guardRevSeq) throw writeConflict();
              } else {
                const claimed = await tx.node.updateMany({
                  where: { id: current.id, revSeq: opts.guardRevSeq },
                  data: { revSeq: { increment: 1 } },
                });
                if (claimed.count === 0) throw writeConflict();
              }
            }

            if (needsRevision) {
              await createNodeRevision(tx, {
                ...buildNodeRevisionSnapshot(current, editorFromAuth(ctx), {
                  revLabel: input.reason,
                  changes,
                }),
                ...(opts?.guardRevSeq !== undefined ? { revNo: opts.guardRevSeq } : {}),
              });
            }

            // #1450 — a placeholder keeps its spec role until it is written.
            assertPlaceholderKeepsSpecRole(current, { role: input.role, content: input.content });
            await assertNoMintedSpecUnmark(tx, input.memoryId, [markerChange(current.id)], 'update');
            const data = {
              ...updatePayload,
              // The snapshot above keeps the old author. The new live content
              // has no verified author until the attestation/human gates land.
              ...(authoredContentChanged(changes) ? clearNodeAuthorship() : {}),
              ...(lockedAbstractHash !== undefined ? { abstractOriginHash: lockedAbstractHash } : {}),
              // #1450 — writing real content to a reserved citation makes it a spec.
              ...placeholderFillPatch(current, input.content),
              revisionContentHash: revisionStateHashRefreshMarker(),
            } as Prisma.NodeUncheckedUpdateInput;

            const where = opts?.targetNodeId
              ? {
                  id: opts.targetNodeId,
                  memoryId: input.memoryId,
                  loc: input.loc,
                  deletedAt: null,
                }
              : {
                  loc_memoryId: { loc: input.loc, memoryId: input.memoryId },
                  deletedAt: null,
                };
            const updated = await tx.node.update({ where, data, include });
            return { conflict: false, node: await finalizeNodeWrite(tx, updated, currentForDiff.content ?? null) };
          });
          if (result.conflict) {
            throw new GraphQLError(
              `Node at loc "${input.loc}" changed since it was read — re-read and retry.`,
              {
                extensions: {
                  code: 'NODE_WRITE_CONFLICT',
                  loc: input.loc,
                  memoryId: input.memoryId,
                },
              },
            );
          }
          if (!result.node) {
            throw new GraphQLError(
              `Node not found at loc "${input.loc}" in memory "${input.memoryId}".`,
              { extensions: { code: 'NODE_NOT_FOUND', loc: input.loc, memoryId: input.memoryId } },
            );
          }
          node = result.node;
        } else {
          // Create/upsert. A new node placed into a subtree must be serialized
          // against a concurrent ancestor-delete's descendant count, or the
          // delete can miss it and orphan it under a now-missing prefix (#664,
          // Model A — see nodeSubtreeLock.ts). Hold advisory locks on the node's
          // ancestor path across the write; the delete side locks its own loc.
          // READ COMMITTED (the default) is REQUIRED: the count on the delete
          // side must see this row once our commit releases the lock, which a
          // frozen SERIALIZABLE snapshot would not guarantee.
          //
          // EVERY write takes the transaction, root-level locs included — since
          // #976 for the snapshot's sake, and since #1183 because a root-level
          // loc takes its own write lock in there. (This paragraph used to say a
          // root-level loc "skips the transaction"; that stopped being true at
          // #976 and is doubly untrue now. @copilot, PR #1184 round 5.)
          //
          // `satisfies` (not a `: NodeUpsertArgs` annotation) so the literal
          // `include` type is preserved and the upsert below still infers the
          // edge relations onto the result (`node.outgoingEdges`).
          const upsertArgs = {
            where: { loc_memoryId: { loc: input.loc, memoryId: input.memoryId } },
            create: {
              ...nodeFieldsClean,
              ...(opts?.copiedAuthorship ? carryNodeAuthorship(opts.copiedAuthorship) : {}),
              id,
              tags,
              createdBy,
              ...hashPayload,
              revisionContentHash: revisionStateHashRefreshMarker(),
              ...(seqForCreate != null ? { seq: seqForCreate } : {}),
            } as Prisma.NodeUncheckedCreateInput,
            update: updatePayload,
            include,
          } satisfies Prisma.NodeUpsertArgs;
          // A root-level loc takes no ancestor lock, but still goes through
          // the helper: it is also the spec 049 S4 protected-loc gate, run
          // under the transaction — a root-level Channel address was
          // otherwise overwritable here (Copilot on PR #1165, round 2).
          node = await inWriteTransaction(async (tx) => {
            await lockInlineEdgeMemories(tx);
            await lockAncestorsForCreate(tx, input.memoryId, input.loc, {
              owns: opts?.owns,
            });
            // #1183 — serialize two creates at the SAME loc.
            //
            // A NESTED loc needs nothing extra: lockAncestorsForCreate above
            // takes the ancestor path, and two creates at one loc share every
            // ancestor, so they already serialize. (Measured, not assumed —
            // removing the lock below left every nested-loc race test green.)
            //
            // A ROOT-LEVEL loc has no ancestors, so that helper takes NOTHING
            // and the two creates are unserialized. Hence this, exactly there.
            //
            // Taking it ONLY at root level is still deliberate, but #1187
            // changed WHY — and the old reason is worth keeping visible,
            // because it is the one that will tempt the next reader.
            //
            // It USED to be deadlock. The four helpers share one key space and
            // this repo had no global acquisition order, so an earlier revision
            // that took this lock unconditionally made a create hold `a` and
            // wait for `a:b`, which @copilot found deadlocking against merge —
            // and the obvious repair (sorting merge's endpoints) promptly
            // inverted merge against MOVE. Restricting the lock to root level
            // meant create never held two keys at all: no new edge, nothing to
            // order against.
            //
            // #1187 established the order (`acquireLockSet` / `compareLockKeys`)
            // and merge and move now declare their full sets through it, so
            // that constraint is GONE: ancestors-then-own-loc is already the
            // global order (length-ascending), and taking this lock
            // unconditionally would be safe today.
            //
            // It stays root-level-only for the ORIGINAL, narrower reason —
            // redundancy. Two creates at one NESTED loc already serialize on
            // their shared ancestors; measured, not assumed, when #1183 removed
            // this lock and every nested-loc race test stayed green. Only a
            // root-level loc has no ancestors and therefore nothing to
            // serialize on. An unconditional lock would buy nothing and cost a
            // round trip per create.
            if (ancestorLocs(input.loc).length === 0) {
              // This branch is create/upsert only — the mode union excludes
              // 'update' here, so the verb is unconditional.
              await lockLocForWrite(tx, input.memoryId, input.loc, {
                owns: opts?.owns,
                op: 'create',
              });
            }
            await assertMemoryWriteStateStable(tx);

            // #1183 — THE AUTHORITATIVE read. The `existing` probe far above is
            // taken before this lock, so under concurrency both callers see no
            // row: the mode gate passes twice, and because the write below is
            // an UPSERT the loser does not collide on (loc, memory_id) — it
            // takes the update branch and overwrites the winner. Measured
            // before this fix: 40 concurrent pairs, 40 double-successes, zero
            // refusals. Spec 039 Phase 0 D1's create-only guarantee held only
            // sequentially, which is why a sequential test pinned it happily.
            let authoritative = await tx.node.findUnique({
              where: { loc_memoryId: { loc: input.loc, memoryId: input.memoryId } },
            });

            if (mode === 'create' && authoritative && !authoritative.deletedAt) {
              const err = new NodeLocConflictError(input.loc, input.memoryId);
              throw new GraphQLError(err.message, {
                extensions: { code: err.name, loc: err.loc, memoryId: err.memoryId },
              });
            }

            // #1186: a tombstone may have appeared or changed since the probe.
            // Lock/re-read it before deriving omitted collection fields, and
            // validate before reconciliation/snapshot/revival side effects.
            if (authoritative) {
              await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${authoritative.id} FOR UPDATE`;
              authoritative = await tx.node.findUniqueOrThrow({ where: { id: authoritative.id } });
              if (authoritative.loc !== input.loc || authoritative.memoryId !== input.memoryId) {
                throw movedConflict(authoritative.memoryId, authoritative.loc);
              }
              if (mode === 'create' && !authoritative.deletedAt) {
                const err = new NodeLocConflictError(input.loc, input.memoryId);
                throw new GraphQLError(err.message, {
                  extensions: { code: err.name, loc: err.loc, memoryId: err.memoryId },
                });
              }
            }
            await enforceNodeSchemaOnWrite(
              tx, input.memoryId,
              input.objectType !== undefined ? input.objectType : authoritative?.objectType,
              input.properties !== undefined ? input.properties : authoritative?.properties,
            );

            // #1183 — snapshot the row this write will actually overwrite, from
            // the authoritative read and inside this transaction, so it commits
            // with the write (a failed write cannot leave an orphan revision)
            // and so a row that appeared after the stale probe is still
            // recorded. After the gate above, the only row a `create` can still
            // overwrite is a SOFT-DELETED one being resurrected — and a
            // tombstone's content is real content, which losing silently was
            // the #976 defect. `upsert` mode reaches here for a live row too,
            // deliberately: that mode is either-way by contract.
            let authoritativeChanges: string[] = [];
            let storedForIncludes: string | null = null;
            let authoritativeAbstractHash = nextAbstractOriginHash;
            if (authoritative) {
              // Row lock + drift reconciled as its own revision BEFORE this
              // snapshot (@copilot, PR #1339): the address lock binds only
              // writers that take it, so a raw write landing after the read
              // above would otherwise be snapshotted stale, overwritten, and
              // hidden by the refreshed fingerprint. Same order as the update
              // path.
              await ensureCurrentNodeRevisionInTransaction(tx, authoritative.id, { expectedMemoryId: input.memoryId });
              authoritative = await tx.node.findUniqueOrThrow({ where: { id: authoritative.id } });
              // Found by (loc, memory), locked by id: a row that moved in
              // between must refuse, not be snapshotted while the upsert
              // writes the old address (@copilot, PR #1339).
              if (authoritative.loc !== input.loc || authoritative.memoryId !== input.memoryId) {
                throw new GraphQLError(
                  `Node at loc "${input.loc}" moved while this write waited — re-read and retry.`,
                  { extensions: { code: 'NODE_WRITE_CONFLICT', loc: input.loc, memoryId: input.memoryId } },
                );
              }
              const authoritativeForDiff = memEncInfo.isEncrypted
                ? decryptNodeFields({ ...authoritative }, memEncInfo)
                : authoritative;
              // A tombstone's text is not the includer's stored text (#2041 S2b).
              if (!authoritative.deletedAt) storedForIncludes = authoritativeForDiff.content ?? null;
              authoritativeAbstractHash = hashAgainstLockedContent(authoritative.content);
              authoritativeChanges = diffNodeChanges(authoritativeForDiff, {
                ...suppliedForDiff, abstractOriginHash: authoritativeAbstractHash,
              });
              await createNodeRevision(tx, {
                ...buildNodeRevisionSnapshot(authoritative, editorFromAuth(ctx), {
                  revLabel: input.reason,
                  changes: authoritativeChanges,
                }),
              });
            }

            // #1330 — H1 strict sub-roles, against the AUTHORITATIVE row: a
            // resurrection keeps the tombstone's role unless the write names one.
            await assertRoleDeclaredForWrite(
              tx,
              input.memoryId,
              {
                role: input.role === undefined ? (authoritative?.role ?? null) : input.role,
                priorRole: authoritative?.role ?? null,
                runnableAfter: mergedGovernedState(authoritative, { role: input.role, isRunnable: input.isRunnable }).isRunnable,
              },
              { platformWrite: opts?.platformWrite },
            );
            // #1331 — the writer level of the role before AND after, on the locked row.
            await assertRoleWritersForWrite(
              tx, ctx, input.memoryId,
              {
                priorRole: authoritative?.role ?? null, nextRole: input.role === undefined ? (authoritative?.role ?? null) : input.role,
                priorRunnable: authoritative?.isRunnable ?? null,
                nextRunnable: mergedGovernedState(authoritative, { role: input.role, isRunnable: input.isRunnable }).isRunnable,
              },
              { platformWrite: opts?.platformWrite },
            );

            // #1460 — a tombstone still owns its old abstract and chunk
            // vectors. Remove them in this transaction before making the row
            // live, so a revive cannot publish its previous incarnation's
            // plaintext while the new embed is pending or unavailable.
            const reviving = mode === 'create' && !!authoritative?.deletedAt;
            let revivedPendingAt: Date | null | undefined;
            if (reviving && authoritative) {
              await tx.nodeEmbedding.deleteMany({ where: { nodeId: authoritative.id } });
              const indexed = await tx.memory.findUniqueOrThrow({
                where: { id: input.memoryId }, select: { vectorIndexEnabled: true, class: true },
              });
              // Invalidate an old embed before post-commit enqueue runs.
              // Unindexed memories keep the normal null pending marker.
              revivedPendingAt = pendingAtForRevival(authoritative.embeddingPendingAt, memoryIsVectorIndexed(indexed));
            }

            // #1183 — resurrect from the AUTHORITATIVE row, not the stale
            // probe. `updateExtras` above was built from `existing`, which may
            // have seen nothing while another caller created AND soft-deleted
            // this loc before we took the lock. The gate lets a tombstone
            // through by design, so without this override the upsert would
            // write the new fields and leave `deletedAt` set — the "worst of
            // both worlds" #543 exists to prevent, reachable again through the
            // window this transaction was added to close. The MCP path already
            // overrides the same way (src/mcp/server.ts).
            if (authoritative && mode !== 'create') {
              assertPlaceholderKeepsSpecRole(authoritative, { role: input.role, content: input.content });
            }
            if (authoritative) {
              await assertNoMintedSpecUnmark(tx, input.memoryId, [markerChange(authoritative.id)], 'overwrite');
            }
            const upserted = await tx.node.upsert({
              ...upsertArgs,
              update: {
                ...upsertArgs.update,
                // #1326 — this arm OVERWRITES an existing row. For a copy
                // (`create` mode, which refuses a live occupant above) that row
                // is a resurrected tombstone whose fields the copy omitted
                // survive, so the copied claim describes the source, not the
                // mixture. A copied stamp is carried only on the fresh insert
                // (the create arm); here it clears (Codex on #1397 f650be49).
                ...(opts?.copiedAuthorship
                  ? clearNodeAuthorship()
                  : authoritative && (mode === 'create' || authoredContentChanged(authoritativeChanges))
                    ? clearNodeAuthorship() : {}),
                ...(authoritativeAbstractHash !== undefined
                  ? { abstractOriginHash: authoritativeAbstractHash } : {}),
                // #1450 — a create that revives a tombstone is a NEW node, so it
                // must not inherit a dead placeholder's flag (reserve re-marks
                // its own row afterwards). An upsert onto a live placeholder
                // clears it only when it writes real content.
                ...(mode === 'create'
                  ? { isPlaceholder: false }
                  : placeholderFillPatch(authoritative, input.content)),
                revisionContentHash: revisionStateHashRefreshMarker(),
                // create-ONLY, matching the `isResurrect` it corrects. Widening
                // it to `upsert` would let an importer revive a soft-deleted
                // node merely by writing to its loc — a behaviour change this
                // fix has no business making (@copilot, PR #1184 round 4).
                ...(reviving
                  ? { deletedAt: null, deletedBy: null, embeddingPendingAt: revivedPendingAt }
                  : {}),
              } as Prisma.NodeUncheckedUpdateInput,
            });
            // #1606 — restoring a target restores the threads its soft delete
            // took (cause TARGET), never ones an admin deleted.
            if (reviving) await restoreThreadsOfTargets(tx, [upserted.id]);
            return finalizeNodeWrite(tx, upserted, storedForIncludes);
          });
        }
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2025'
        ) {
          // Lost the race between the mode gate (or `assertTargetStillWritable`)
          // and the write. Since the address and liveness now ride in the
          // write's own predicate, a no-match here has TWO causes and they
          // deserve different codes (@copilot, PR #1198): the row was deleted,
          // or it MOVED — and a move that slips past the re-check would
          // otherwise report NODE_NOT_FOUND for a node that plainly still
          // exists, contradicting the NODE_WRITE_CONFLICT contract this PR
          // introduced two statements earlier. `mergeMemoryGraph` relocates
          // with an unlocked bulk updateMany, so that ordering is reachable.
          //
          // One extra read, only on the already-failed path.
          //
          // The DECISION is extracted to `classifyFailedUpdate` and unit-tested
          // against all three end states (@copilot, PR #1198, round 5). The
          // WIRING — that a P2025 here reaches it — stays uncovered, because
          // reaching it needs a relocation committing between
          // `assertTargetStillWritable` and the statement immediately after it,
          // inside one transaction, with no seam between them to hook. Adding a
          // test-only injection point to the canonical write path is a worse
          // trade. What was untestable was never the branching; it was the
          // race, and the branching is what could be silently wrong.
          if (mode === 'update' && opts?.targetNodeId) {
            const outcome = await classifyFailedUpdate(ctx.db, opts.targetNodeId);
            if (outcome.kind === 'moved') {
              throw movedConflict(outcome.memoryId, outcome.loc);
            }
          }
          throw new GraphQLError(
            `Node not found at loc "${input.loc}" in memory "${input.memoryId}".`,
            { extensions: { code: 'NODE_NOT_FOUND', loc: input.loc, memoryId: input.memoryId } },
          );
        }
        throw e;
      }

      // For the return value, decrypt the result back so callers see plaintext.
      if (memEncInfo.isEncrypted) {
        decryptNodeFields(node, memEncInfo);
      }

      const finalNode = node;

      // Event pivot: the write core announces the fact; subscribers (git
      // mirror, embedding wake, whatever comes next) act on it. Encrypted
      // memories keep the direct git write below — the subscriber can't
      // decrypt without this request's session key, and finalNode is plaintext.
      // When the caller owns the transaction, delay every effect until its
      // commit succeeds. The callback uses the pooled client, never the tx.
      const afterCommit = () => {
        const pooledDb = opts?.transaction?.pooledDb ?? ctx.db;
        void publishNodeWritten({
          nodeId: finalNode.id,
          memoryId: input.memoryId,
          ownerRepo: input.ownerRepo ?? '',
          clientId: ctx.clientId,
        });
        if (memEncInfo.isEncrypted) {
          // reserveSpecCitation marks the new row AFTER writeNodeCore returns,
          // in its enclosing transaction. The direct encrypted mirror path is
          // the only exporter for that memory, so read the committed marker
          // rather than serializing finalNode's pre-reservation false value.
          void (async () => {
            const committed = await pooledDb.node.findUnique({
              where: { id: finalNode.id }, select: { isPlaceholder: true },
            });
            if (!committed) return;
            await writeNodeToGit({
              id: finalNode.id,
              loc: finalNode.loc,
              name: finalNode.name,
              nodeType: finalNode.nodeType,
              alias: finalNode.alias,
              description: finalNode.description,
              abstract: finalNode.abstract,
              abstractOriginHash: finalNode.abstractOriginHash,
              contentHash: finalNode.contentHash,
              content: finalNode.content,
              tags: deserializeTags(finalNode.tags) as string[],
              seq: finalNode.seq,
              data: finalNode.data,
              properties: finalNode.properties,
              // #1218 — the mirror carries the governed signals.
              role: finalNode.role ?? null,
              isRunnable: finalNode.isRunnable ?? null,
              isPlaceholder: committed.isPlaceholder,
              outgoingEdges: finalNode.outgoingEdges ?? [],
              mirrorRevSeq: finalNode.revSeq,
            }, input.ownerRepo ?? '', ctx.clientId, input.memoryId);
          })().catch((err) => {
            console.error('[writeNodeCore] git write error:', err);
          });
        }

        // 033 — (re-)embed on write. finalNode is decrypted (plaintext) here,
        // so the prompt-drain embeds correctly on encrypted memories (FR-027).
        void enqueueNodeEmbedding(pooledDb, {
          nodeId: finalNode.id,
          memoryId: input.memoryId,
          plaintext: { content: finalNode.content, abstract: finalNode.abstract },
        });

        // #1061 — the one place a `write` event is recorded for every caller
        // that reaches the shared write core. A refused write records nothing.
        recordNodeWrite(
          pooledDb,
          { id: finalNode.id, loc: finalNode.loc, memoryId: input.memoryId },
          ctx,
        );
      };
      if (opts?.transaction) opts.transaction.afterCommit(afterCommit);
      else afterCommit();

      return finalNode;
}

/**
 * #564 — resolve a node by ref (PK or fully-qualified URN) to its full live
 * row, or throw a typed NODE_NOT_FOUND. Shared by moveNode / cloneNode; a
 * genuine miss and a soft-deleted row map to the same not-found (no existence
 * oracle), while a malformed URN propagates as UrnNotQualifiedError (spec 022).
 */
async function resolveExistingNode(ctx: Context, ref: string, opts?: { forWrite?: boolean; movesContent?: boolean }) {
  let id: string;
  try {
    ({ id } = await resolveNodeRefForCaller(ctx, ref));
  } catch (e) {
    if (e instanceof NodeNotFoundError)
      throw new GraphQLError(`Node not found: "${ref}"`, {
        extensions: { code: 'NODE_NOT_FOUND', ref },
      });
    throw e;
  }
  const node = await ctx.db.node.findUnique({ where: { id } });
  if (!node || node.deletedAt)
    throw new GraphQLError(`Node not found: "${ref}"`, {
      extensions: { code: 'NODE_NOT_FOUND', ref },
    });
  // #1381: a node the caller will WRITE, in a memory it can neither write nor
  // read, answers here — at resolution — exactly as a missing one. Refusing at
  // the later write gate leaks through ORDER (see resolveMemoryRefForWrite).
  if (opts?.forWrite && (await isMemoryHiddenForWrite(ctx, node.memoryId, 'node'))) {
    throw nodeNotFoundError(ref);
  }
  // #2206 (B): an operation that carries the node's existing content somewhere the caller sees it (a move) answers a
  // caller who may write but not read this memory as a missing node, at resolution, before any later gate.
  if (opts?.movesContent && (await isWriteBeyondRead(ctx.db, ctx, node.memoryId))) {
    throw nodeNotFoundError(ref);
  }
  return node;
}

/**
 * #564 — resolve the destination (memory + loc) for moveNode / cloneNode from
 * the mutually-exclusive `targetUrn` / `targetMemoryRef` args. Exactly one must
 * be supplied — both OR neither fails loudly (BAD_USER_INPUT):
 *   - `targetUrn`: the full destination node URN → dest memory + dest loc. It
 *     may name a not-yet-existing node, so it's split (not resolveNodeRef'd);
 *     splitNodeUrn self-validates the fully-qualified shape.
 *   - `targetMemoryRef`: a destination memory (ID or URN) → the node keeps its
 *     current loc; only its memory changes.
 * Validates the destination loc shape. Occupancy (the fail-loud conflict) is
 * the caller's concern.
 */
async function resolveRelocationTarget(
  ctx: Context,
  source: { loc: string },
  targetUrn?: string | null,
  targetMemoryRef?: string | null,
): Promise<{ destMemoryId: string; destLoc: string }> {
  const hasUrn = targetUrn != null && targetUrn !== '';
  const hasMemory = targetMemoryRef != null && targetMemoryRef !== '';
  if (hasUrn === hasMemory) {
    throw new GraphQLError(
      'Specify exactly one of `targetUrn` (full destination node URN) or `targetMemoryRef` (destination memory).',
      { extensions: { code: 'BAD_USER_INPUT' } },
    );
  }
  let destMemoryId: string;
  let destLoc: string;
  if (hasUrn) {
    const { memoryUrn, loc } = splitWholeNodeUrn(targetUrn as string);
    destLoc = loc;
    // #1381: the destination is written, so it conceals as it resolves.
    ({ id: destMemoryId } = await resolveMemoryRefForWrite(ctx, memoryUrn));
  } else {
    ({ id: destMemoryId } = await resolveMemoryRefForWrite(ctx, targetMemoryRef as string));
    destLoc = source.loc;
  }
  try {
    validateLoc(destLoc);
  } catch (e) {
    if (e instanceof InvalidLocError) {
      throw new GraphQLError(e.message, {
        extensions: { code: e.name, loc: e.loc, segment: e.segment },
      });
    }
    throw e;
  }
  return { destMemoryId, destLoc };
}

/**
 * The update half of the single-node write path: selector resolution (spec 039
 * D2 — `id` XOR `memoryId` + `loc`) followed by `writeNodeCore` in update mode.
 *
 * SHARED, not copied (#1192, extended by #1201). `updateNode` and every
 * kind-specific update door differ in exactly one argument — `ownsKind` — and
 * everything else about an
 * update is identical: the same selectors, the same NODE_NOT_FOUND shape, the
 * same PK anchoring against a concurrent move. A second copy of this would be
 * a predicate with two homes, and the one that is edited next is whichever the
 * next author happens to open (PR #1190 shipped exactly that mistake with
 * `locsOverlap`, twice).
 *
 * @param input  the caller's UpdateNodeInput, selectors included.
 * @param ctx    request context.
 * @param op     the mutation name, used in the two selector refusals so each
 *               door names itself rather than the one it was extracted from.
 * @param opts.ownsKind  the GOVERNED KIND this caller is the door for. Passed
 *               only by that kind's own update door; omitted by the generic
 *               surface, which is then refused when its write would produce a
 *               governed node. NOT a universal bypass — every other kind, and
 *               Channel address protection, stay in force.
 */
async function updateNodeCore(
  input: UpdateNodeInput,
  ctx: Context,
  op: string,
  opts?: { ownsKind?: GovernedKind; governedContext?: GovernedContext },
) {
  const { id, memoryId, loc, expectedRevision, ...fields } = input;
  // GraphQL guarantees a signed 32-bit integer on the wire, but resolver tests
  // and internal delegates call this function directly. Keep the public
  // contract true at the shared seam rather than relying on one transport.
  if (
    expectedRevision != null &&
    (!Number.isInteger(expectedRevision) || expectedRevision <= 0 || expectedRevision > 2_147_483_647)
  ) {
    throw new GraphQLError('expectedRevision must be a positive 32-bit integer.', {
      extensions: { code: 'BAD_USER_INPUT', field: 'expectedRevision' },
    });
  }
  const hasId = id != null && id !== '';
  if (hasId && (memoryId != null || loc != null)) {
    throw new GraphQLError(
      `${op}: identify the node by \`id\` OR by \`memoryId\` + \`loc\`, not both. ` +
        '(`loc`/`memoryId` are selectors, not writable fields — moveNode relocates.)',
      { extensions: { code: 'BAD_USER_INPUT' } },
    );
  }
  if (!hasId && (memoryId == null || loc == null)) {
    throw new GraphQLError(
      `${op}: supply \`id\` (PK or fully-qualified node URN) or both \`memoryId\` and \`loc\`.`,
      { extensions: { code: 'BAD_USER_INPUT' } },
    );
  }

  let targetMemoryId: string;
  let targetLoc: string;
  let targetNodeId: string | undefined;
  if (hasId) {
    // ID-or-URN dispatch (spec 007/022). A genuine miss → NODE_NOT_FOUND;
    // a relative-form URN propagates as UrnNotQualifiedError.
    try {
      ({ id: targetNodeId } = await resolveNodeRefForCaller(ctx, id));
    } catch (e) {
      if (e instanceof NodeNotFoundError) {
        throw new GraphQLError(`Node not found: "${id}"`, {
          extensions: { code: 'NODE_NOT_FOUND', ref: id },
        });
      }
      throw e;
    }
    const row = await ctx.db.node.findUnique({
      where: { id: targetNodeId },
      select: { memoryId: true, loc: true, memory: { select: { deletedAt: true } } },
    });
    // Soft-deleting a memory leaves its node rows, so an id can still resolve
    // a node whose memory is gone. That node is missing, as the URN form
    // already says (it requires a live memory); falling through would answer
    // MEMORY_NOT_FOUND with the memory's own id (#1316, @copilot PR #1319).
    if (!row || row.memory.deletedAt) {
      throw new GraphQLError(`Node not found: "${id}"`, {
        extensions: { code: 'NODE_NOT_FOUND', ref: id },
      });
    }
    targetMemoryId = row.memoryId;
    targetLoc = row.loc;
  } else {
    // Pass the raw ref through — writeNodeCore's own resolveMemoryRef
    // handles ID-or-URN dispatch (no need to resolve twice).
    targetMemoryId = memoryId as string;
    targetLoc = loc as string;
  }

  // The PK anchors the write on the id-selector path so a concurrent
  // move (which frees the loc for reuse) can't make the loc-keyed
  // write hit a different node.
  return writeNodeCore({ ...fields, memoryId: targetMemoryId, loc: targetLoc }, ctx, 'update', {
    targetNodeId,
    guardRevSeq: expectedRevision ?? undefined,
    ownsKind: opts?.ownsKind,
    governedContext: opts?.governedContext,
    concealUnreadable: {
      entity: hasId ? 'node' : 'memory',
      ref: hasId ? (id as string) : (memoryId as string),
    },
  });
}

/**
 * The body of `updateNodeProperties`, shared with the object store's
 * `updateObject` (#745). One option differs between the two surfaces:
 *
 * - `mergeExports: true` — `updateNodeProperties`. `properties.exports` is the
 *   D12 per-host skill declaration map on a node, so an object patch under it
 *   is merge-patched (#1227; the SDL states it).
 * - `mergeExports: false` — `updateObject`. An object's fields are arbitrary
 *   and its SDL promises a shallow, patch-wins merge for every field, so an
 *   object field that happens to be called `exports` stays shallow (#1278
 *   review, Codex). Each surface keeps the promise its own SDL makes, rather
 *   than guessing from the data whether an `exports` value is a declaration.
 */
export async function updateNodePropertiesWith(
  { nodeRef, properties, reason }: { nodeRef: string; properties: unknown; reason?: string | null },
  ctx: Context,
  // `governedContext`: set by `updateNodeProperties` only. `updateObject`
  // shares this body but its refusal must not send a reader to the NODE
  // surface, which skips the object contract's reserved-key checks (@copilot,
  // PR #1305).
  opts: { mergeExports: boolean; governedContext?: GovernedContext },
) {
  // The patch must be a JSON object — the operation merges keys, so an
  // array / scalar / null has no sensible "apply onto existing properties"
  // meaning (mirrors updateNodeData's `data` contract).
  if (properties == null || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new GraphQLError('updateNodeProperties: `properties` must be a JSON object.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }

  // Resolve the node (ID or fully-qualified URN — same dispatch as
  // updateNodeData / mergeNodes). A genuine miss → NODE_NOT_FOUND.
  let resolvedId: string;
  try {
    ({ id: resolvedId } = await resolveNodeRefForCaller(ctx, nodeRef));
  } catch (e) {
    if (e instanceof NodeNotFoundError) {
      throw new GraphQLError(`Node not found: "${nodeRef}"`, {
        extensions: { code: 'NODE_NOT_FOUND', ref: nodeRef },
      });
    }
    throw e;
  }
  // Pre-auth: read only what authorization needs; the properties payload is
  // read only AFTER write access is confirmed (mirrors updateNodeData).
  const meta = await ctx.db.node.findUnique({
    where: { id: resolvedId },
    select: { id: true, memoryId: true, deletedAt: true },
  });
  if (!meta || meta.deletedAt) {
    throw new GraphQLError(`Node not found: "${nodeRef}"`, {
      extensions: { code: 'NODE_NOT_FOUND', ref: nodeRef },
    });
  }
  // #1316: a node in a memory the caller cannot read answers as a missing one.
  await concealUnreadableNodeDenial(ctx, meta.memoryId, () => nodeNotFoundError(nodeRef), () =>
    requireMemoryWriteAccess(ctx, meta.memoryId),
  );
  // Spec 049 S4: an in-place update takes no lock, so the gate is explicit here.
  await assertLocWritable(
    ctx.db,
    meta.memoryId,
    (await ctx.db.node.findUniqueOrThrow({ where: { id: meta.id }, select: { loc: true } })).loc,
    'update',
  );

  // Encrypted memory: require an active session up front (mirrors
  // updateNodeData / writeNodeCore) so a missing key fails with a typed
  // SESSION_EXPIRED rather than writeNodeCore's bare throw. `properties`
  // itself is plaintext, but the write round-trips the node's encrypted
  // fields, so the key is still required to persist.
  const memEnc = await getMemoryEncryptionInfo(ctx.db, meta.memoryId);
  if (memEnc.isEncrypted && !sessionKeyCache.getByMemoryId(memEnc.id)) {
    throw new GraphQLError(
      `SESSION_EXPIRED: memory ${memEnc.id} is encrypted but no active session key is available.`,
      { extensions: { code: 'SESSION_EXPIRED', memoryId: memEnc.id } },
    );
  }

  // The READ→merge→WRITE must be atomic, or two concurrent merges patching
  // distinct keys lose each other (both read the same base, last write wins —
  // #746 review, Codex P1). Serialize per-node with a transaction-scoped
  // advisory lock: any other updateNodeProperties on this node blocks until
  // this one's write commits, then reads the fresh base.
  //
  // The merge and core write use the SAME transaction connection. Otherwise
  // each concurrent merge holds one connection for its lock while waiting for
  // a second connection to write, exhausting a small pool (#1279). The core's
  // event, embedding, git and usage effects run only after this commit, on the
  // pooled client rather than a closed transaction client.
  const effects: Array<() => void> = [];
  const written = await ctx.db.$transaction(async (lockTx) => {
    await lockTx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${meta.id}))`;

    // Fresh read UNDER the lock — the merge base can't be stale. `properties`
    // is plaintext at rest, so no decrypt.
    const fresh = await lockTx.node.findUnique({
      where: { id: meta.id },
      select: { loc: true, ownerRepo: true, properties: true },
    });
    if (!fresh) {
      // Lost a race with a concurrent delete.
      throw new GraphQLError(`Node not found: "${nodeRef}"`, {
        extensions: { code: 'NODE_NOT_FOUND', ref: nodeRef },
      });
    }

    // Shallow merge (the patch wins on key collision; absent keys
    // preserved), EXCEPT `exports`, which is merge-patched one host at a
    // time (#1227): D12 made it an object keyed by host, and a shallow
    // merge of one host's declaration deleted every sibling host. Done
    // HERE, under the lock, so two clients toggling different hosts both
    // land. A node with no properties yet takes the patch as-is.
    const merged = opts.mergeExports
      ? mergePropertiesPatch(fresh.properties, properties as Record<string, unknown>)
      : shallowMergeProperties(fresh.properties, properties as Record<string, unknown>);

    // Delegate the write to the core in update mode. Anchor on the immutable
    // PK (targetNodeId), not (memoryId, loc): a concurrent move that frees this
    // loc could otherwise make the loc-keyed write hit the wrong row (PR-460).
    // writeNodeCore runs enforceNodeSchemaOnWrite on the merged `properties`,
    // so a merge that breaks the memory's schema surfaces as BAD_USER_INPUT.
    return writeNodeCore(
      {
        memoryId: meta.memoryId,
        loc: fresh.loc,
        properties: merged,
        ...(fresh.ownerRepo != null ? { ownerRepo: fresh.ownerRepo } : {}),
        ...(reason != null ? { reason } : {}),
      },
      withoutRequestCaches(ctx, lockTx),
      'update',
      {
        targetNodeId: meta.id,
        governedMerge: 'properties',
        governedContext: opts.governedContext,
        transaction: { tx: lockTx, pooledDb: ctx.db, afterCommit: (effect) => effects.push(effect) },
      },
    );
  });
  for (const effect of effects) effect();
  return written;
}

/** Shallow, patch-wins merge; a node with no object properties takes the patch as-is. */
function shallowMergeProperties(existing: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  return existing != null && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>), ...patch }
    : patch;
}

/**
 * moveNode's implementation, which also reports EXACTLY which rows the atomic
 * subtree mover relocated, with the loc each one left (#1449, @codex P2 on
 * #1453). renumberSpec needs that list; rebuilding it from a later snapshot
 * would include nodes created under the target afterwards, or miss one moved
 * away again. Held in an object so tests can intercept it.
 */
export const nodeMoveOps = {
  async moveWithResult(
    ctx: Context,
    { sourceRef, targetUrn, targetMemoryRef, requireUnminted, expectedSource, mirrorAfterMove = true }: {
      sourceRef: string; targetUrn?: string | null; targetMemoryRef?: string | null;
      /** A compound operation may mirror once after its follow-on edits. */
      mirrorAfterMove?: boolean;
      /** #1449/#1591: refuse (NODE_MINTED) when any moved node is minted, under the move's locks (renumber). */
      requireUnminted?: boolean;
      /**
       * #1449 (@codex P2, PR #1453): refuse (CONFLICT) unless the resolved
       * source still sits at this memory + loc. With `sourceRef` an id, the
       * move is pinned to one node: an address can fall through to another
       * memory's historical holder, and an id cannot; the mover then
       * re-validates this same memory + loc under its row lock.
       */
      expectedSource?: { memoryId: string; loc: string };
    },
  ) {
      const source = await resolveExistingNode(ctx, sourceRef, { forWrite: true, movesContent: true });
      if (expectedSource && (source.memoryId !== expectedSource.memoryId || source.loc !== expectedSource.loc)) {
        throw new GraphQLError('The node moved since it was read, so nothing was moved. Re-read and retry.', {
          extensions: { code: 'CONFLICT', nodeId: source.id },
        });
      }
      const { destMemoryId, destLoc } = await resolveRelocationTarget(
        ctx, source, targetUrn, targetMemoryRef,
      );

      // The subtree leaves the source memory and lands in the destination — write
      // access to both (a same-memory move checks once).
      await requireMemoryWriteAccess(ctx, source.memoryId);
      // Spec 049 S4: a move whose SOURCE subtree contains a Channel is refused
      // here; a destination entering one is refused by the create lock.
      await assertLocWritable(ctx.db, source.memoryId, source.loc, 'move');
      const crossMemory = destMemoryId !== source.memoryId;
      if (crossMemory) {
        await requireMemoryWriteAccess(ctx, destMemoryId);
      }

      const isSameSlot = !crossMemory && destLoc === source.loc;

      const withEdges = {
        outgoingEdges: { include: { target: true } },
        incomingEdges: { include: { source: true } },
      } as const;

      try {
        let relocated: MoveNodeSubtreeResult['moved'] = [];
        let linkWarnings: MoveNodeSubtreeResult['linkWarnings'] = [];
        const moved = await ctx.db.$transaction(
          async (tx) => {
            // #2206 (#2233): an Agent definition's authority, at either end, before any loc or row lock.
            await lockAgentDefinitionAuthority(tx, ctx.userId ?? null, [source.memoryId, destMemoryId]);
            // #1187 — DECLARE the complete key set first, in the one global
            // order: the destination ancestor path AND the source path that
            // `lockSourceForMove` takes further down. Previously those were two
            // separate acquisitions in caller order (destination, then source),
            // which is one of the three pairwise inversions #1187 catalogues.
            // Both helpers below still run for their gates and the source
            // revalidation; their re-acquisitions are re-entrant no-ops.
            await acquireLockSet(tx, [
              ...ancestorLocs(destLoc).map((loc) => ({ memoryId: destMemoryId, loc })),
              ...ancestorLocs(source.loc).map((loc) => ({ memoryId: source.memoryId, loc })),
              { memoryId: source.memoryId, loc: source.loc },
            ]);
            // #664/#752: moving a node INTO a subtree is the same orphan vector as
            // a create there — a concurrent non-recursive delete of a destination
            // ancestor could count zero descendants, then this move lands the row
            // under it. Lock the destination ancestor path. Root-level → no-op.
            await lockAncestorsForCreate(tx, destMemoryId, destLoc);

            if (isSameSlot) {
              return tx.node.findUniqueOrThrow({ where: { id: source.id }, include: withEdges });
            }

            // Rebase the whole loc-subtree via the shared helper (it locks +
            // revalidates the source, carries embeddings/edges cross-memory, and
            // fails loud on a destination collision).
            const result = await moveNodeSubtree(tx, {
              source,
              destLoc,
              destMemoryId: crossMemory ? destMemoryId : undefined,
              editor: editorFromAuth(ctx),
              requireUnminted,
              authorizeLockedMemory: (memoryId) =>
                requireMemoryWriteAccess(withoutRequestCaches(ctx, tx), memoryId),
              principal: ctx,
            });
            relocated = result.moved;
            linkWarnings = result.linkWarnings;
            return tx.node.findUniqueOrThrow({ where: { id: source.id }, include: withEdges });
          },
          // A large subtree touches many rows; the default 5s interactive-txn
          // timeout is too tight (mirrors extractParentNodeGraph / cloneMemory).
          { timeout: 120_000 },
        );
        // #1061 — a move is a write, recorded against the node's POST-move
        // address (the loc and, on a cross-memory move, the memory it now
        // lives in): that is where a reader of the usage series will look for
        // it. As with a recursive delete, the rebased descendants are not
        // counted individually — one caller edit, one event.
        recordNodeWrite(ctx.db, toUsageNodeRef(moved), ctx);
        // #1095 — mirror the move into the affected repos: the destination gains
        // the files, the source loses them. Fired AFTER the commit (the mirror
        // re-reads the post-move rows) and NOT awaited — a mirror never fails a
        // write that already landed. This is what replaced the blanket refusal
        // of any cross-memory move touching a git-backed memory.
        if (mirrorAfterMove) {
          void mirrorNodeMoveToGit(ctx.db, {
            srcMemoryId: source.memoryId,
            destMemoryId,
            moved: relocated,
            clientId: ctx.clientId ?? null,
          });
        }
        return { node: { ...moved, moveLinkWarnings: linkWarnings }, relocated };
      } catch (e) {
        // Map the shared helper's typed errors (thrown from either branch) to the
        // GraphQL surface.
        if (e instanceof SubtreeMoveCollisionError) {
          throw new GraphQLError(
            `A node already occupies loc "${e.loc}" in the destination memory.`,
            { extensions: { code: 'NODE_ALREADY_EXISTS', loc: e.loc, memoryId: e.memoryId } },
          );
        }
        if (e instanceof SubtreeMoveIntoSelfError) {
          throw new GraphQLError(e.message, { extensions: { code: 'BAD_USER_INPUT', loc: e.loc } });
        }
        if (e instanceof SubtreeMoveMintedError) {
          throw new GraphQLError(e.message, {
            extensions: { code: 'NODE_MINTED', memoryId: e.memoryId, locs: e.locs.slice(0, 10), count: e.locs.length },
          });
        }
        if (e instanceof SubtreeMoveSourceChangedError) {
          throw new GraphQLError(e.message, { extensions: { code: 'CONFLICT', nodeId: e.nodeId } });
        }
        if (
          e instanceof CrossMemoryMoveUnsupportedError ||
          e instanceof SubtreeMoveSchemaViolationError
        ) {
          throw new GraphQLError(e.message, { extensions: { code: 'BAD_USER_INPUT' } });
        }
        throw e;
      }
  },
};

/** #2044: `createNode` / `updateNode` take an App's install memory as the target instead of `memoryId`. */
type CreateNodeArgs = Omit<CreateNodeInput, 'memoryId'> & { memoryId?: string | null; install?: InstallTarget | null };
type UpdateNodeArgs = Omit<UpdateNodeInput, 'memoryId'> & { memoryId?: string | null; install?: InstallTarget | null };

function assertMemoryTargeted(memoryId: string | null | undefined, op: string): void {
  if (!memoryId) {
    throw new GraphQLError(`${op}: supply \`memoryId\` or \`install\` (an App's install memory).`,
      { extensions: { code: 'BAD_USER_INPUT' } });
  }
}

/**
 * First customisation: finds or creates the App's install memory and writes the
 * node in the SAME transaction, so a refused write leaves no memory behind.
 */
async function createNodeInInstallMemory(input: CreateNodeArgs, ctx: Context) {
  const { install, memoryId, ...rest } = input;
  if (memoryId != null) {
    throw new GraphQLError('createNode: supply `memoryId` OR `install`, not both.', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  const effects: Array<() => void> = [];
  const written = await withInstallMemory(ctx, install!, (tx, txCtx, memory) =>
    writeNodeCore({ ...rest, memoryId: memory.id } as CreateNodeInput, txCtx, 'create', {
      governedContext: 'node-write',
      transaction: { tx, pooledDb: ctx.db, afterCommit: (effect) => effects.push(effect) },
    }));
  for (const effect of effects) effect();
  return written;
}

/** The caller's view of an App's install memory, creating nothing: a miss and a refusal read the same. */
export async function findCallerInstallMemory(ctx: Context, install: InstallTarget): Promise<{ id: string }> {
  const { appId, agentId } = await resolveInstallTarget(ctx.db, install);
  const row = await findInstallMemory(ctx.db, appId, agentId);
  if (!row || !(await canReadMemoryRecord(ctx, row))) {
    throw new GraphQLError('This App has not customised that Agent yet.', { extensions: { code: 'INSTALL_MEMORY_NOT_FOUND' } });
  }
  return row;
}

export const nodeMutations = {
    // Create a single node (spec 039 Phase 0 D1/D4). Create-only: a live
    // node at (memoryId, loc) rejects with NodeLocConflictError; a
    // soft-deleted one is resurrected. `input.id` is a forced create-PK
    // (importer/sync), never a selector.
    createNode: async (_: unknown, { input }: { input: CreateNodeArgs }, ctx: Context) => {
      // #2044: the target is a memory OR an App's install memory (cor:agt:040:06).
      if (input.install) return createNodeInInstallMemory(input, ctx);
      assertMemoryTargeted(input.memoryId, 'createNode');
      return writeNodeCore(input as CreateNodeInput, ctx, 'create', {
        governedContext: 'node-write',
        concealUnreadable: { entity: 'memory', ref: input.memoryId! },
      });
    },

    // #1201 — THE KIND-SPECIFIC AUTHORING DOORS. One create + one update per
    // governed kind, generated from the register so a kind cannot ship with a
    // door missing or with the wrong `ownsKind` wired in.
    //
    // PURE ROUTING, deliberately (@Holger): a door validates nothing and knows
    // nothing beyond which kind it is the door for. The authoring RULES stay in
    // the tool that owns them — `hadron spec` and `hadron coding` are
    // closed-list exceptions on the audience ground, so porting their logic
    // here is exactly what we are NOT doing.
    //
    // WHAT EACH DOOR BUYS IS NOT THE SAME, and the register records it rather
    // than leaving a reader to assume the strongest reading: `task` is a
    // CAPABILITY gate (evasion means the node does not run), `review` is a
    // SECURITY gate (a review may be a safety check, and removing one is the
    // attack), `spec` is DILIGENCE (it proves the spec tool authored the node,
    // not that nothing else could have).
    //
    // These replace the generic `authorProtectedNode` / `updateProtectedNode`,
    // which took the same inputs as createNode/updateNode and differed only by
    // name — one door exempt from EVERY declaration, which is the skeleton key
    // this split exists to remove. Each door here is exempt from its own kind
    // and subject to every other, Channel protection included.
    //
    // None of these MUTATIONS is itself an MCP tool: an agent's generic node
    // surface is hadron_create_node / hadron_update_node, which refuse. Tasks
    // and reviews have separate, deliberate MCP door tools (hadron_create_task,
    // hadron_update_review, …) that delegate here; specs have none, by design.
    // That no mutation is an MCP tool is pinned per door by a test that
    // iterates this same register.
    // #1641: an operations-only kind (decision) gets NO generic-shaped door
    // here; its own operations live in resolvers.decisions.ts.
    ...Object.fromEntries(
      GOVERNED_KINDS.filter((entry) => !entry.operationsOnly).flatMap((entry) => [
        [
          entry.doors.create,
          async (_: unknown, { input }: { input: CreateNodeInput }, ctx: Context) =>
            writeNodeCore(input, ctx, 'create', {
              ownsKind: entry.kind,
              governedContext: 'node-write',
              concealUnreadable: { entity: 'memory', ref: input.memoryId },
            }),
        ],
        [
          entry.doors.update,
          async (_: unknown, { input }: { input: UpdateNodeInput }, ctx: Context) =>
            updateNodeCore(input, ctx, entry.doors.update, { ownsKind: entry.kind, governedContext: 'node-write' }),
        ],
      ]),
    ),

    // Update an existing node (spec 039 Phase 0 D2–D4). Target = `id` (PK or
    // fully-qualified node URN) XOR (`memoryId` + `loc`); never creates,
    // never moves. All content fields preserve-on-omit.
    updateNode: async (_: unknown, { input }: { input: UpdateNodeArgs }, ctx: Context) => {
      if (input.install) {
        // #2044: select the node by the App's install memory + loc. Nothing is created
        // here; a caller who cannot even open the record gets the not-found a missing
        // customisation gives.
        const { install, memoryId, id, ...rest } = input;
        if (memoryId != null || id != null) {
          throw new GraphQLError('updateNode: identify the node by `install` + `loc`, not also by `id` or `memoryId`.',
            { extensions: { code: 'BAD_USER_INPUT' } });
        }
        const memory = await findCallerInstallMemory(ctx, install);
        return updateNodeCore({ ...rest, memoryId: memory.id } as UpdateNodeInput, ctx, 'updateNode', { governedContext: 'node-write' });
      }
      return updateNodeCore(input as UpdateNodeInput, ctx, 'updateNode', { governedContext: 'node-write' });
    },


    // Shallow-merge a JSON patch into a node's `data` bag (issue #366).
    // The supplied object's top-level keys overwrite the node's existing
    // `data` (the patch wins on collision); untouched keys are preserved; a
    // node with no prior data takes the patch verbatim. Delegates the write to
    // the shared write core so every single-write invariant (write auth,
    // re-encryption, NodeRevision snapshot, git mirror) is applied once and
    // stays in sync — this resolver only resolves the node and computes the
    // merged plaintext.
    updateNodeData: async (
      _: unknown,
      { nodeRef, data, reason }: { nodeRef: string; data: unknown; reason?: string | null },
      ctx: Context,
    ) => {
      // The patch must be a JSON object — the operation merges keys, so an
      // array / scalar / null has no sensible "apply onto existing data"
      // meaning (matches the mergeJson contract used by mergeNodes).
      if (data == null || typeof data !== 'object' || Array.isArray(data)) {
        throw new GraphQLError('updateNodeData: `data` must be a JSON object.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }

      // Resolve the node (ID or fully-qualified URN — same dispatch as
      // mergeNodes / createEdge). A genuine miss → NODE_NOT_FOUND; a malformed
      // relative URN propagates as UrnNotQualifiedError (spec 022).
      let resolvedId: string;
      try {
        ({ id: resolvedId } = await resolveNodeRefForCaller(ctx, nodeRef));
      } catch (e) {
        if (e instanceof NodeNotFoundError) {
          throw new GraphQLError(`Node not found: "${nodeRef}"`, {
            extensions: { code: 'NODE_NOT_FOUND', ref: nodeRef },
          });
        }
        throw e;
      }
      // Pre-auth, read ONLY the columns needed to authorize + the soft-delete
      // flag — NOT the (possibly sensitive / encrypted) `data` column. The
      // sensitive payload is read only AFTER write access is confirmed, so an
      // unauthorized caller can't force this surface to load a node's data.
      const meta = await ctx.db.node.findUnique({
        where: { id: resolvedId },
        select: { id: true, memoryId: true, deletedAt: true },
      });
      if (!meta || meta.deletedAt) {
        throw new GraphQLError(`Node not found: "${nodeRef}"`, {
          extensions: { code: 'NODE_NOT_FOUND', ref: nodeRef },
        });
      }
      // #1316: a node in a memory the caller cannot read answers as a missing one.
      await concealUnreadableNodeDenial(ctx, meta.memoryId, () => nodeNotFoundError(nodeRef), () =>
        requireMemoryWriteAccess(ctx, meta.memoryId),
      );
      // Spec 049 S4: an in-place update takes no lock, so the gate is explicit here.
      await assertLocWritable(
        ctx.db,
        meta.memoryId,
        (await ctx.db.node.findUniqueOrThrow({ where: { id: meta.id }, select: { loc: true } })).loc,
        'update',
      );

      // Encrypted memory: require an active session key up front (mirrors
      // mergeNodes / upsertNode) so a missing key fails with a typed
      // SESSION_EXPIRED rather than the bare throw from decryptNodeFields, and
      // the decrypt below is guarded.
      const memEnc = await getMemoryEncryptionInfo(ctx.db, meta.memoryId);
      if (memEnc.isEncrypted && !sessionKeyCache.getByMemoryId(memEnc.id)) {
        throw new GraphQLError(
          `SESSION_EXPIRED: memory ${memEnc.id} is encrypted but no active session key is available.`,
          { extensions: { code: 'SESSION_EXPIRED', memoryId: memEnc.id } },
        );
      }

      // Post-auth: read the addressing fields + the `data` payload, then
      // decrypt to plaintext so the merge folds the real object (upsertNode
      // re-encrypts on write).
      const row = await ctx.db.node.findUnique({
        where: { id: meta.id },
        select: { loc: true, name: true, ownerRepo: true, data: true },
      });
      if (!row) {
        // Lost a race with a concurrent delete between the two reads.
        throw new GraphQLError(`Node not found: "${nodeRef}"`, {
          extensions: { code: 'NODE_NOT_FOUND', ref: nodeRef },
        });
      }
      const fields: { abstract: null; content: null; data: unknown } = {
        abstract: null,
        content: null,
        data: row.data,
      };
      if (memEnc.isEncrypted) {
        decryptNodeFields(fields, memEnc);
      }

      // Shallow merge: the patch wins on key collision; absent keys preserved.
      // A node with no object data yet takes the patch as-is.
      const existing = fields.data;
      const merged =
        existing != null && typeof existing === 'object' && !Array.isArray(existing)
          ? { ...(existing as Record<string, unknown>), ...(data as Record<string, unknown>) }
          : (data as Record<string, unknown>);

      // Delegate the write to the core in update mode; omitted fields (name
      // included) preserve.
      //
      // ANCHORED ON THE PK, like updateNodeProperties next door and for its
      // reason (@copilot, PR #1198). This resolver resolves a node REF and then
      // addressed the write by the (memoryId, loc) it read — so if that node
      // moved and another live node took the old address, the write landed on
      // the REPLACEMENT: a caller's `data` patch applied to a different node
      // than the one they named. `updateNodeProperties` already threaded
      // `targetNodeId` and documented why; this path was simply never brought
      // into line.
      return writeNodeCore(
        {
          memoryId: meta.memoryId,
          loc: row.loc,
          data: merged,
          ...(row.ownerRepo != null ? { ownerRepo: row.ownerRepo } : {}),
          // #88: thread the edit rationale through to the revision snapshot.
          ...(reason != null ? { reason } : {}),
        },
        ctx,
        'update',
        { targetNodeId: meta.id, governedMerge: 'data', governedContext: 'node-write' },
      );
    },

    // #742 — server-side shallow-merge of a node's structured `properties`
    // (the schema-governed JSONB column), the `updateNodeProperties` analogue of
    // updateNodeData. It exists so a caller (CLI `--properties-merge`, the future
    // `updateObject`) can patch a few fields without a read-modify-write race.
    //
    // `properties` is ALWAYS plaintext — never encrypted at rest (only
    // abstract/content/data are; src/lib/nodeCrypto.ts) — so the MERGE reads the
    // real object with no decrypt, and the schema-conformance check needs no key.
    // But the WRITE still routes through the session-gated core (writeNodeCore
    // round-trips the node's encrypted fields), so — like updateNodeData and every
    // other write — an encrypted memory requires an active session. The one thing
    // it adds over updateNodeData: `properties` is schema-governed, so writeNodeCore
    // runs enforceNodeSchemaOnWrite on the MERGED result and rejects a violation.
    updateNodeProperties: (
      _: unknown,
      args: { nodeRef: string; properties: unknown; reason?: string | null },
      ctx: Context,
    ) => updateNodePropertiesWith(args, ctx, { mergeExports: true, governedContext: 'node-write' }),

    // Bulk literal/regex search-and-replace across selected nodes. Reuses the
    // single-write invariants from upsertNode (per-memory write auth,
    // decrypt→replace→re-encrypt, NodeRevision snapshot, abstractOriginHash
    // recompute, re-embed, git mirror) but keyed off existing node rows rather
    // than a full NodeInput. Selection is the union of nodeIds + (memoryIds,
    // optionally narrowed by a loc `prefix`). See SearchReplaceInNodesInput.
    searchReplaceInNodes: async (
      _: unknown,
      { input }: { input: SearchReplaceInNodesInput },
      ctx: Context,
    ) => {
      const {
        oldText,
        newText,
        nodeIds,
        memoryIds,
        prefix,
        fields,
        caseInsensitive = false,
        regex = false,
        dryRun = false,
      } = input;

      const hasNodeIds = Array.isArray(nodeIds) && nodeIds.length > 0;
      const hasMemoryIds = Array.isArray(memoryIds) && memoryIds.length > 0;
      const usePrefix = prefix != null && prefix !== '';

      if (!hasNodeIds && !hasMemoryIds) {
        throw new GraphQLError(
          'searchReplaceInNodes requires at least one of `nodeIds` or `memoryIds`.',
          { extensions: { code: 'SEARCH_REPLACE_NO_SELECTION' } },
        );
      }
      if (usePrefix && !hasMemoryIds) {
        throw new GraphQLError(
          'searchReplaceInNodes: `prefix` requires `memoryIds` (loc is only unique within a memory).',
          { extensions: { code: 'SEARCH_REPLACE_PREFIX_WITHOUT_MEMORY' } },
        );
      }
      if (!Array.isArray(fields) || fields.length === 0) {
        throw new GraphQLError(
          'searchReplaceInNodes requires at least one field in `fields`.',
          { extensions: { code: 'SEARCH_REPLACE_NO_FIELDS' } },
        );
      }
      const fieldSet = new Set<string>(fields);

      // Build (and validate) the replacer up front — a bad pattern fails the
      // whole request before any node is touched.
      let replacer: Replacer;
      try {
        replacer = buildReplacer(oldText, newText, { caseInsensitive, regex });
      } catch (e) {
        if (e instanceof SearchReplaceInvalidPatternError) {
          throw new GraphQLError(e.message, {
            extensions: { code: e.name, pattern: e.pattern, reason: e.reason },
          });
        }
        throw e;
      }

      // ── Resolve selection → deduped raw node rows (write-auth per memory) ──
      type NodeRow = NonNullable<Awaited<ReturnType<typeof ctx.db.node.findUnique>>>;
      const nodeById = new Map<string, NodeRow>();
      const authedMemories = new Set<string>();
      const ensureAuthed = async (memoryId: string) => {
        if (authedMemories.has(memoryId)) return;
        await requireMemoryWriteAccess(ctx, memoryId);
        // #2206 (B): matches and per-field counts (dry run too) disclose content, so a memory the caller may write but
        // not read is refused here; the conceal wrappers below then answer it as a memory the caller cannot see.
        if (await isWriteBeyondRead(ctx.db, ctx, memoryId)) throw memoryWriteForbidden();
        authedMemories.add(memoryId);
      };

      if (hasMemoryIds) {
        for (const ref of memoryIds!) {
          const { id: memId } = await resolveMemoryRef(ctx.db, ref);
          // #1316: an unreadable memory answers as resolveMemoryRef's miss. #2206 (B): so does one the caller may write
          // but not read (its record may be visible, so the wrapper below would answer FORBIDDEN instead).
          if (await isWriteBeyondRead(ctx.db, ctx, memId)) throw new MemoryNotFoundError(ref);
          await concealUnreadableDenial(ctx, memId, ref, () => ensureAuthed(memId));
          const where: Prisma.NodeWhereInput = { memoryId: memId, deletedAt: null };
          if (usePrefix) {
            // Match the node at `prefix` plus its descendants, on `:` path
            // boundaries (so 'auth' won't catch 'authoring').
            where.OR = [{ loc: prefix }, { loc: { startsWith: `${prefix}:` } }];
          }
          const rows = await ctx.db.node.findMany({ where });
          for (const r of rows) nodeById.set(r.id, r as NodeRow);
        }
      }

      if (hasNodeIds) {
        for (const ref of nodeIds!) {
          // Explicit refs must be IDs or fully-qualified URNs (no memory ctx).
          const { id } = await resolveNodeRefForCaller(ctx, ref);
          if (nodeById.has(id)) continue;
          const row = await ctx.db.node.findUnique({ where: { id } });
          if (!row || row.deletedAt) continue;
          // #1316: a node in an unreadable memory answers as resolveNodeRef's miss.
          await concealUnreadableNodeDenial(ctx, row.memoryId, () => new NodeNotFoundError(ref), () =>
            ensureAuthed(row.memoryId),
          );
          nodeById.set(id, row);
        }
      }

      // Spec 049 S4: a node under a Channel's address is SKIPPED, never
      // rewritten — the bulk surface reports rather than failing the batch.
      // One Channel-table read per memory, not per node (Copilot on PR #1165).
      const protectedByMemory = new Map<string, ProtectedLoc[]>();
      const isProtectedLoc = async (memoryId: string, loc: string) => {
        let locs = protectedByMemory.get(memoryId);
        if (!locs) {
          locs = await protectedLocsIn(ctx.db, memoryId);
          protectedByMemory.set(memoryId, locs);
        }
        return locs.some((p) => protectedLocCovers(p, loc));
      };

      // #1201 — GOVERNED nodes are excluded from a bulk search-replace
      // (@codex P1, PR #1203). This path writes with `tx.node.update` and never
      // reached the gate, so `hadron_replace_text` could rewrite a review node
      // or a runnable task through a generic tool — the exact bypass the gate
      // exists to close, arriving through a surface that does not create nodes
      // and so was not on the list of writers I checked.
      //
      // SKIPPED, not refused, matching how `partitionProtected` treats a
      // Channel address on the bulk paths: failing a whole batch on one
      // governed row makes the tool unusable on any memory that contains one,
      // and a skip writes nothing, which is the safe direction.
      //
      // #1294 reporting: classify every UNIQUE, AUTHORIZED selected row once,
      // before scanning text. Precedence is deterministic: governance first,
      // then Channel address protection. A node carrying multiple governed
      // signals still contributes one governed skip. Aggregate counts avoid
      // disclosing node metadata beyond what this mutation already returns.
      const skipCounts = { governed: 0, protectedAddress: 0 };
      const scannedNodes: NodeRow[] = [];
      for (const row of nodeById.values()) {
        // #1606 — a comment is governed too (cor:dmo:110:04): skipped, reported as governed.
        if (governedKindsOf({ role: row.role, isRunnable: row.isRunnable }).length > 0 || row.nodeType === COMMENT_NODE_TYPE
          // #2043 — compiled boot prompts are written only by a compile; a worker session also skips sources.
          || row.nodeType === COMPILED_BOOT_PROMPT_NODE_TYPE || (isBootPromptRole(row.role) && currentActor().workerId != null)) {
          skipCounts.governed += 1;
          continue;
        }
        if (await isProtectedLoc(row.memoryId, row.loc)) {
          skipCounts.protectedAddress += 1;
          continue;
        }
        scannedNodes.push(row);
      }

      // ── Compute pass: replace on PLAINTEXT, validate, plan writes ──
      // All validation (empty name, abstract cap, SESSION_EXPIRED) happens here
      // so the request fails before the write transaction opens.
      const memEncCache = new Map<string, { id: string; isEncrypted: boolean }>();
      const getMemEnc = async (memoryId: string) => {
        let info = memEncCache.get(memoryId);
        if (!info) {
          info = await getMemoryEncryptionInfo(ctx.db, memoryId);
          memEncCache.set(memoryId, info);
        }
        return info;
      };

      interface Plan {
        raw: NodeRow;
        isEncrypted: boolean;
        changed: Record<string, unknown>; // plaintext field → new value
        plaintext: { content: string | null; abstract: string | null };
        /** #2041 S2b — content before the replace; the row lock below revalidates it (revisionStateMatches). */
        storedContent: string | null;
        fieldResults: Array<{ field: string; matches: number }>;
        total: number;
        abstractChanged: boolean;
        contentChanged: boolean;
        ownerRepo: string;
      }
      const plans: Plan[] = [];

      // #1331 — a row whose role needs a writer level the caller lacks is SKIPPED
      // like any other governed row: a skip writes nothing, and failing a batch
      // on one such row would make the tool unusable on a memory that has one.
      // Judged again under the lock in the write pass.
      for (let i = scannedNodes.length - 1; i >= 0; i--) {
        const row = scannedNodes[i]!;
        if (!row.role && row.isRunnable !== true) continue;
        if (await roleWritersRefusal(ctx.db, ctx, row.memoryId, {
          priorRole: row.role, nextRole: row.role, priorRunnable: row.isRunnable, nextRunnable: row.isRunnable,
        })) {
          skipCounts.governed += 1;
          scannedNodes.splice(i, 1);
        }
      }

      for (const raw of scannedNodes) {
        const memEnc = await getMemEnc(raw.memoryId);
        if (memEnc.isEncrypted && !sessionKeyCache.getByMemoryId(memEnc.id)) {
          throw new GraphQLError(
            `SESSION_EXPIRED: memory ${memEnc.id} is encrypted but no active session key is available.`,
            { extensions: { code: 'SESSION_EXPIRED', memoryId: memEnc.id } },
          );
        }
        // Decrypt a working copy to plaintext; `raw` stays ciphertext so the
        // NodeRevision snapshot below matches upsertNode's snapshot shape.
        const pt = { ...raw } as NodeRow;
        if (memEnc.isEncrypted) decryptNodeFields(pt, memEnc);

        const changed: Record<string, unknown> = {};
        const fieldResults: Array<{ field: string; matches: number }> = [];
        let total = 0;
        let abstractChanged = false;
        let contentChanged = false;

        if (fieldSet.has('name')) {
          const r = replacer.apply(pt.name ?? '');
          if (r.count > 0) {
            if (r.value.trim() === '') {
              throw new GraphQLError(
                `searchReplaceInNodes: replacing in 'name' of node ${pt.loc} (${pt.id}) would leave it empty.`,
                { extensions: { code: 'SEARCH_REPLACE_EMPTY_NAME', nodeId: pt.id, loc: pt.loc } },
              );
            }
            changed.name = r.value;
            total += r.count;
            fieldResults.push({ field: 'name', matches: r.count });
          }
        }

        for (const f of ['alias', 'description'] as const) {
          if (!fieldSet.has(f)) continue;
          const cur = pt[f];
          if (cur == null) continue;
          const r = replacer.apply(cur);
          if (r.count > 0) {
            changed[f] = r.value;
            total += r.count;
            fieldResults.push({ field: f, matches: r.count });
          }
        }

        if (fieldSet.has('abstract') && pt.abstract != null) {
          const r = replacer.apply(pt.abstract);
          if (r.count > 0) {
            if (r.value.length > 2000) {
              // #1117: the edit context (current length) is in hand here, so
              // the refusal reports delta and headroom — the numbers a
              // surgical edit can act on without a second read.
              const err = new NodeAbstractTooLongError(r.value.length, {
                currentLength: pt.abstract.length,
              });
              throw new GraphQLError(`${err.message} (node ${pt.loc} / ${pt.id})`, {
                extensions: {
                  ...err.extensionFields(),
                  nodeId: pt.id,
                  loc: pt.loc,
                },
              });
            }
            // Whitespace-only result normalizes to null, matching upsertNode.
            changed.abstract = r.value.trim() === '' ? null : r.value;
            abstractChanged = true;
            total += r.count;
            fieldResults.push({ field: 'abstract', matches: r.count });
          }
        }

        if (fieldSet.has('content') && pt.content != null) {
          const r = replacer.apply(pt.content);
          if (r.count > 0) {
            changed.content = r.value;
            contentChanged = true;
            total += r.count;
            fieldResults.push({ field: 'content', matches: r.count });
          }
        }

        if (fieldSet.has('tags')) {
          const curTags = deserializeTags(pt.tags) as string[];
          const r = replaceInTags(curTags, replacer);
          if (r.count > 0) {
            changed.tags = r.value;
            total += r.count;
            fieldResults.push({ field: 'tags', matches: r.count });
          }
        }

        if (total > 0) {
          plans.push({
            raw,
            isEncrypted: memEnc.isEncrypted,
            changed,
            plaintext: {
              content: contentChanged ? (changed.content as string) : pt.content,
              abstract: abstractChanged ? (changed.abstract as string | null) : pt.abstract,
            },
            storedContent: pt.content ?? null,
            fieldResults,
            total,
            abstractChanged,
            contentChanged,
            ownerRepo: (raw as { ownerRepo?: string | null }).ownerRepo ?? '',
          });
        }
      }

      const buildResult = () => ({
        nodesSelected: nodeById.size,
        nodesScanned: scannedNodes.length,
        nodesSkipped: skipCounts.governed + skipCounts.protectedAddress,
        skipCounts,
        nodesChanged: plans.length,
        totalReplacements: plans.reduce((a, p) => a + p.total, 0),
        dryRun,
        results: plans.map((p) => ({
          nodeId: p.raw.id,
          loc: p.raw.loc,
          memoryId: p.raw.memoryId,
          replacements: p.total,
          fields: p.fieldResults,
        })),
      });

      if (dryRun) return buildResult();

      // ── Write pass: revision snapshot + node update, all-or-nothing ──
      await mapDeadlockToWriteConflict(plans[0]?.raw.memoryId ?? '', () => ctx.db.$transaction(async (tx) => {
        // A Channel can claim an ancestor after selection but before this
        // transaction. Take its per-memory key BEFORE any node row lock (the
        // Channel/create and delete paths use the same order), then classify
        // again under that key. Newly protected rows are SKIPPED, as if the
        // Channel had existed at selection time; no snapshot or update for
        // them may reach the Channel-owned address (#1298).
        const channelMemoryIds = [...new Set([...nodeById.values()].map((row) => row.memoryId))].sort();
        for (const memoryId of channelMemoryIds) {
          await lockMemoryForChannelChange(tx, memoryId);
        }
        const newlyProtected = new Set<string>();
        const currentProtected = new Map<string, ProtectedLoc[]>();
        for (const row of scannedNodes) {
          let locs = currentProtected.get(row.memoryId);
          if (!locs) {
            locs = await protectedLocsIn(tx, row.memoryId);
            currentProtected.set(row.memoryId, locs);
          }
          if (locs.some((entry) => protectedLocCovers(entry, row.loc))) {
            newlyProtected.add(row.id);
          }
        }
        if (newlyProtected.size > 0) {
          skipCounts.protectedAddress += newlyProtected.size;
          for (let i = scannedNodes.length - 1; i >= 0; i--) {
            if (newlyProtected.has(scannedNodes[i]!.id)) scannedNodes.splice(i, 1);
          }
          for (let i = plans.length - 1; i >= 0; i--) {
            if (newlyProtected.has(plans[i]!.raw.id)) plans.splice(i, 1);
          }
        }

        // #1323 (@codex/@copilot, PR #1339): each planned row is row-locked and
        // its unrevisioned drift reconciled as its OWN revision (id order, one
        // global order for multi-row writers) before its snapshot. The
        // replacement was computed from a read taken BEFORE this lock, so a row
        // whose tracked state changed since then refuses the whole batch
        // (all-or-nothing, as below) instead of overwriting the newer write.
        let readableForIncludes: string[] | null = null;
        const planMemory = new Map(plans.map((p) => [p.raw.id, p.raw.memoryId]));
        // #1753 — memory rows BEFORE node rows (promotion's order). Holding the
        // memory state through the batch still stops a pre-flip plan writing
        // plaintext after encryptMemory flips it: the flip needs the memory
        // UPDATE lock, which this SHARE excludes until commit.
        const plannedEncryption = new Map(plans.map((plan) => [plan.raw.memoryId, plan.isEncrypted]));
        for (const memoryId of [...plannedEncryption.keys()].sort()) {
          await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR SHARE`;
          const memory = await tx.memory.findUniqueOrThrow({
            where: { id: memoryId }, select: { isEncrypted: true },
          });
          if (memory.isEncrypted !== plannedEncryption.get(memoryId)) {
            throw new GraphQLError('Memory encryption changed while this replace was running; retry.', {
              extensions: { code: 'NODE_WRITE_CONFLICT', memoryId },
            });
          }
        }
        for (const id of [...planMemory.keys()].sort()) {
          await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${id} FOR UPDATE`;
        }
        // #1331 — the writer level of each planned row's role, on the LOCKED row
        // and the committed rulebook; a row the caller may no longer write (the
        // rule tightened, or its role changed, since selection) is dropped.
        for (const memoryId of [...plannedEncryption.keys()].sort()) await lockMemoryConfigShared(tx, memoryId);
        const lockedRoles = new Map((await tx.node.findMany({
          where: { id: { in: [...planMemory.keys()] } }, select: { id: true, role: true, isRunnable: true },
        })).map((r) => [r.id, r] as const));
        for (let i = plans.length - 1; i >= 0; i--) {
          const plan = plans[i]!;
          const locked = lockedRoles.get(plan.raw.id);
          const role = locked?.role ?? null;
          const runnable = locked?.isRunnable ?? null;
          if ((role || runnable === true) && await roleWritersRefusal(tx, ctx, plan.raw.memoryId, {
            priorRole: role, nextRole: role, priorRunnable: runnable, nextRunnable: runnable,
          })) {
            skipCounts.governed += 1;
            planMemory.delete(plan.raw.id);
            plans.splice(i, 1);
          }
        }
        // #1468 — a tag replace must not strip the spec marker off a minted
        // spec; one refusal refuses the whole batch, like every check here.
        for (const memoryId of [...plannedEncryption.keys()].sort()) {
          const changes = plans
            .filter((plan) => plan.raw.memoryId === memoryId && 'tags' in plan.changed)
            .map((plan) => ({ id: plan.raw.id, tags: serializeTags(plan.changed.tags as string[]) as string[] }));
          await assertNoMintedSpecUnmark(tx, memoryId, changes, 'replace text in');
        }
        for (const id of [...planMemory.keys()].sort()) {
          await ensureCurrentNodeRevisionInTransaction(tx, id, { expectedMemoryId: planMemory.get(id)! });
        }
        for (const p of plans) {
          const locked = await tx.node.findUnique({ where: { id: p.raw.id } });
          // deletedAt is not a revisioned field, so a delete that committed
          // before this lock must be refused explicitly (@copilot, PR #1339).
          if (!locked || locked.deletedAt || !revisionStateMatches(p.raw, locked)) {
            throw new GraphQLError(
              `Node at loc "${p.raw.loc}" changed while this replace was running — re-run it.`,
              { extensions: { code: 'NODE_WRITE_CONFLICT', loc: p.raw.loc, memoryId: p.raw.memoryId } },
            );
          }
        }
        for (const p of plans) {
          const raw = p.raw;
          // #88: the bulk-edit rationale rides in revLabel (#620); `changes`
          // is exactly the field set the replace pass rewrote on this node.
          await createNodeRevision(
            tx,
            buildNodeRevisionSnapshot(raw, editorFromAuth(ctx), {
              revLabel: input.reason,
              changes: Object.keys(p.changed),
            }),
          );

          const data: Record<string, unknown> = {};
          // Encrypt content/abstract for encrypted memories before persisting.
          if (p.isEncrypted && ('content' in p.changed || 'abstract' in p.changed)) {
            const key = sessionKeyCache.getByMemoryId(raw.memoryId)!; // validated above
            const enc = encryptNodeFieldsWithKey(
              {
                content: 'content' in p.changed ? (p.changed.content as string | null) : null,
                abstract: 'abstract' in p.changed ? (p.changed.abstract as string | null) : null,
              },
              key,
            );
            if ('content' in p.changed) data.content = enc.content;
            if ('abstract' in p.changed) data.abstract = enc.abstract;
          } else {
            if ('content' in p.changed) data.content = p.changed.content;
            if ('abstract' in p.changed) data.abstract = p.changed.abstract;
          }
          if ('name' in p.changed) data.name = p.changed.name;
          if ('alias' in p.changed) data.alias = p.changed.alias;
          if ('description' in p.changed) data.description = p.changed.description;
          if ('tags' in p.changed) data.tags = serializeTags(p.changed.tags as string[]);

          // abstractOriginHash tracks "content when the abstract was authored".
          // Recompute (against post-replace plaintext content) only when the
          // abstract itself changed — a content-only edit intentionally leaves
          // the hash so staleness detection fires (matches upsertNode).
          if (p.abstractChanged) {
            data.abstractOriginHash = computeContentHash(p.plaintext.content);
          }
          data.revisionContentHash = revisionStateHashRefreshMarker();

          Object.assign(data, clearNodeAuthorship());
          await tx.node.update({ where: { id: raw.id }, data });
          // #2040 — a replace that rewrites content re-checks its include tags; a
          // refusal throws and rolls the whole batch back with it.
          if (p.contentChanged) {
            const text = p.plaintext.content;
            readableForIncludes ??= text?.includes('{{>') ? await getAccessibleMemoryIds(ctx) : null;
            const stored = { storedPlaintext: p.storedContent };
            const tags = await assertIncludesWritable(tx, raw, text, readableForIncludes, undefined, stored);
            await syncDerivedIncludesEdges(tx, raw, tags, readableForIncludes, stored);
          }
        }
      }));

      // ── Post-commit side effects (best-effort, mirror upsertNode) ──
      // #1061 — one `write` event per node the bulk edit actually rewrote. The
      // dry run above returns before this point, so a preview records nothing.
      recordNodeUsage(
        ctx.db,
        'write',
        toUsageNodeRefs(plans.map((p) => p.raw)),
        ctx,
      );
      for (const p of plans) {
        // Re-embed when the embedded text (content/abstract) changed.
        if (p.contentChanged || p.abstractChanged) {
          void enqueueNodeEmbedding(ctx.db, {
            nodeId: p.raw.id,
            memoryId: p.raw.memoryId,
            plaintext: { content: p.plaintext.content, abstract: p.plaintext.abstract },
          });
        }
        // Announce the write (git mirror rides the event — so a later
        // repo-wins sync can't revert the edit). Encrypted memories keep the
        // direct decrypt-and-mirror below: the subscriber has no session key.
        void publishNodeWritten({
          nodeId: p.raw.id,
          memoryId: p.raw.memoryId,
          ownerRepo: p.ownerRepo,
          clientId: ctx.clientId,
        });
        if (p.isEncrypted) {
          void (async () => {
            const fresh = await ctx.db.node.findUnique({
              where: { id: p.raw.id },
              include: { outgoingEdges: { include: { target: true } } },
            });
            if (!fresh) return;
            const memEnc = await getMemEnc(fresh.memoryId);
            decryptNodeFields(fresh, memEnc);
            await writeNodeToGit(
              {
                id: fresh.id,
                loc: fresh.loc,
                name: fresh.name,
                nodeType: fresh.nodeType,
                alias: fresh.alias,
                description: fresh.description,
                abstract: fresh.abstract,
                abstractOriginHash: fresh.abstractOriginHash,
                contentHash: fresh.contentHash,
                content: fresh.content,
                tags: deserializeTags(fresh.tags) as string[],
                seq: fresh.seq,
                data: fresh.data,
                properties: fresh.properties,
                // #1218 — the mirror carries the governed signals.
                role: fresh.role ?? null,
                isRunnable: fresh.isRunnable ?? null,
                isPlaceholder: fresh.isPlaceholder,
                outgoingEdges: fresh.outgoingEdges ?? [],
                mirrorRevSeq: fresh.revSeq,
              },
              p.ownerRepo,
              ctx.clientId,
              fresh.memoryId,
            );
          })().catch((err) => {
            console.error('[searchReplaceInNodes] git write error:', err);
          });
        }
      }

      return buildResult();
    },

    searchReplaceInSpecNodes,

    deleteNode: async (
      _: unknown,
      { nodeRef, hard, recursive, cascadeCrossMemoryEdges }: {
        nodeRef: string;
        hard?: boolean | null;
        recursive?: boolean | null;
        cascadeCrossMemoryEdges?: boolean | null;
      },
      ctx: Context,
    ) => {
      // #542 — a single 'nodeRef' (ID or fully-qualified URN) identifies the
      // node, resolved by the shared resolveNodeRef. includeDeleted so a
      // re-delete of an already soft-deleted node stays idempotent (its ref
      // still resolves through the tombstone) — the old loc+memoryId path hit
      // the row directly regardless of deletedAt, so this preserves behavior.
      let resolvedId: string;
      try {
        ({ id: resolvedId } = await resolveNodeRefForCaller(ctx, nodeRef, undefined, {
          includeDeleted: true,
        }));
      } catch (e) {
        if (e instanceof NodeNotFoundError) {
          throw new GraphQLError(`Node not found: "${nodeRef}"`, {
            extensions: { code: 'NODE_NOT_FOUND', ref: nodeRef },
          });
        }
        throw e;
      }
      const node = await ctx.db.node.findUnique({
        where: { id: resolvedId },
        select: { memoryId: true, loc: true, deletedAt: true },
      });
      if (!node) {
        throw new GraphQLError(`Node not found: "${nodeRef}"`, {
          extensions: { code: 'NODE_NOT_FOUND', ref: nodeRef },
        });
      }
      // One check covers the subtree too: every descendant shares this memory.
      // #1316: a node in a memory the caller cannot read answers as a missing one.
      await concealUnreadableNodeDenial(ctx, node.memoryId, () => nodeNotFoundError(nodeRef), () =>
        requireMemoryWriteAccess(ctx, node.memoryId),
      );

      // Idempotent no-op: a non-recursive soft re-delete of an already-tombstoned
      // node preserves its original deletedAt/deletedBy (matches the
      // hadron_delete_node MCP tool) instead of re-stamping it. This must run
      // before Channel protection: clean Channel reuse tombstones the previous
      // transcript, then makes the Channel live again, and a retry by stable id
      // is still a no-op rather than a fresh attempt to mutate that live Channel.
      if (!recursive && !hard && node.deletedAt !== null) return true;

      // Spec 049 S4: a Channel's address (and any subtree overlapping it) is its own operation's.
      // 'delete', not 'write' (@copilot, PR #1198). The verb reaches the user twice —
      // "the only thing that may delete here", and the REMEDY, which must not offer
      // an authoring door for an operation neither door performs.
      await assertLocWritable(ctx.db, node.memoryId, node.loc, 'delete');

      const deletedBy = ctx.userId ?? ctx.appId ?? ctx.clientId ?? null;
      const now = new Date();
      const memoryId = node.memoryId;
      // The node at its loc PLUS every descendant, on ':' path boundaries (so
      // 'auth' won't catch 'authoring') — the same subtree shape as
      // extractParentNode / the bulk node ops.
      const subtree: Prisma.NodeWhereInput = {
        memoryId,
        OR: [{ loc: node.loc }, { loc: { startsWith: escapePrismaLikePattern(`${node.loc}:`) } }],
      };
      // #449 — source memories whose pending-edge count a hard delete changed.
      let pendingSourceMemories: string[] = [];
      try {
        // The count and the delete run in one transaction (parity with
        // hadron_delete_node). #664: an advisory lock on this node's loc — taken
        // first, as the matching key any descendant-create locks as an ancestor
        // (nodeSubtreeLock.ts) — closes the count-then-act race. A concurrent
        // create of a descendant either commits before this lock (so the count
        // below sees it and refuses) or blocks until this delete commits (so it
        // lands under an already-deleted prefix — the tolerated create-after-
        // delete case). READ COMMITTED (the default) is required so the count
        // runs on a fresh snapshot taken after the lock is granted.
        await ctx.db.$transaction(async (tx) => {
          // A dead Channel releases strict descendants for cleanup, so this
          // authoritative re-check must serialize with Channel resurrection.
          // Memory-before-loc matches ensureChannelWithRoot's global order.
          await lockMemoryForChannelChange(tx, memoryId);
          await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR SHARE`;
          const txCtx = withoutRequestCaches(ctx, tx);
          await concealUnreadableNodeDenial(
            txCtx, memoryId, () => nodeNotFoundError(nodeRef),
            () => requireMemoryWriteAccess(txCtx, memoryId),
          );
          // This helper acquires the loc lock AND runs assertLocWritable on a
          // fresh snapshot. Keep that re-check under the memory lock: if reuse
          // won while this request waited, the now-live Channel refuses the
          // stale cleanup before any descendant is touched.
          await lockNodeForDelete(tx, memoryId, node.loc);
          // The target may have moved while this delete waited. The loc lock
          // above protects the address we authorized, not the stable id; do
          // not let that id carry the delete into its new address or memory.
          const current = await tx.node.findUnique({
            where: { id: resolvedId },
            select: { memoryId: true, loc: true },
          });
          if (!current || current.memoryId !== memoryId || current.loc !== node.loc) {
            const movedMemory = !!current && current.memoryId !== memoryId;
            throw new GraphQLError(
              `Node "${nodeRef}" moved while this delete waited — re-read it and retry.`,
              {
                extensions: {
                  code: 'NODE_WRITE_CONFLICT',
                  ref: nodeRef,
                  memoryId,
                  movedMemory,
                  ...(!movedMemory && current ? { currentLoc: current.loc } : {}),
                },
              },
            );
          }
          const useSubtree = !!recursive;
          if (!useSubtree) {
            // Non-recursive: refuse rather than silently orphan a subtree under a
            // now-missing prefix. Hard counts the union (a tombstoned descendant
            // still cascades via FK); soft counts only live descendants.
            const descendantCount = await tx.node.count({
              where: {
                memoryId,
                loc: { startsWith: escapePrismaLikePattern(`${node.loc}:`) },
                ...(hard ? {} : { deletedAt: null }),
              },
            });
            if (descendantCount > 0) {
              throw new GraphQLError(
                `Node "${nodeRef}" has ${descendantCount} descendant(s). Pass recursive: true to delete the whole subtree.`,
                { extensions: { code: 'NODE_HAS_DESCENDANTS', count: descendantCount, ref: nodeRef } },
              );
            }
          }

          // #1468 — the complete removal scope, under the address lock taken
          // above (no row can join it now). A hard delete also removes
          // tombstones, so they count; a soft delete removes live rows only.
          // Hard deletes reuse these ids for the cross-memory edge gate +
          // PendingEdge cleanup — the safeguards hadron_delete_node applies.
          const affectedIds = useSubtree
            ? (await tx.node.findMany({
                where: hard ? subtree : { ...subtree, deletedAt: null },
                select: { id: true },
              })).map((n) => n.id)
            : [resolvedId];
          await assertNoMintedSpecRemoval(tx, memoryId, affectedIds, hard ? 'hard-delete' : 'delete');
          // #1606 (cor:dmo:110:04/05) — a comment is removed only by the comment
          // path's thread delete; a target takes its threads with it.
          if ((await commentIdsAmong(tx, affectedIds)).length > 0) throw commentGovernedError('delete', 'removes');
          await assertNoBootPromptRows(tx, affectedIds, 'delete');
          // #1641 §3.2 — a decision is withdrawn, never deleted, and deleting a
          // log or an ancestor of one would erase decision history.
          await refuseDecisionFamily(tx, affectedIds, 'Deleting this node');
          // A governed node is removed only after its marker is cleared through
          // the kind's door: the whole affected set is judged here, on locked
          // rows, before any write.
          const removed = await assertNoGovernedRemoval(tx, memoryId, affectedIds, 'graphql', { hard: !!hard });
          // cor:acl:130:07 — removing a node writes it: each removed row's role
          // and runnable state needs its writer level, judged on the rows locked
          // above, so one row of an ADMIN role refuses the whole removal.
          await assertRoleWritersForNodes(tx, ctx, removed, { from: memoryId });
          if (hard) await hardDeleteThreadsOfTargets(tx, affectedIds);
          else await softDeleteThreadsOfTargets(tx, affectedIds, { deletedBy, at: now });

          if (hard) {
            // A hard delete cascades Edge rows on BOTH endpoints via FK. If an
            // edge bridges this memory to another, cascading silently removes it
            // from a memory the caller may not own — refuse unless acknowledged.
            if (!cascadeCrossMemoryEdges) {
              const crossMemEdges = await tx.edge.count({
                where: {
                  OR: [
                    { targetId: { in: affectedIds }, source: { memoryId: { not: memoryId } } },
                    { sourceId: { in: affectedIds }, target: { memoryId: { not: memoryId } } },
                  ],
                },
              });
              if (crossMemEdges > 0) {
                throw new GraphQLError(
                  `Hard-delete refused: ${crossMemEdges} edge(s) bridge this memory to another. ` +
                    `Pass cascadeCrossMemoryEdges: true to remove them (the other memory's view loses them).`,
                  { extensions: { code: 'CROSS_MEMORY_EDGES', count: crossMemEdges } },
                );
              }
            }            // #1647: acknowledging the cascade is not write authority over the other holdings it edits. The whole
            // delete refuses (the transaction rolls back), with the generic write refusal.
            for (const other of await foreignEdgeMemoryIds(tx, affectedIds, memoryId)) {
              await requireMemoryWriteAccess(ctx, other);
            }
            // PendingEdge.targetId is intentionally NOT a foreign key, so the FK
            // cascade misses pending rows aimed at the deleted nodes — clean them
            // up explicitly (PR-189 pattern), in both node-keyed forms (#449).
            pendingSourceMemories = await deletePendingEdgesTargetingNodes(tx, affectedIds);

            if (useSubtree) {
              await tx.node.deleteMany({ where: subtree });
            } else {
              // Scope the write to the authorized memory: if the node was moved
              // to another memory between the access check and here, this yields
              // 0 rows → NODE_NOT_FOUND rather than a cross-memory write (TOCTOU).
              const res = await tx.node.deleteMany({ where: { id: resolvedId, memoryId } });
              if (res.count === 0) {
                throw new GraphQLError(`Node not found: "${nodeRef}"`, {
                  extensions: { code: 'NODE_NOT_FOUND', ref: nodeRef },
                });
              }
            }
          } else if (useSubtree) {
            // Soft-delete the whole subtree; only touch live rows so an
            // already-deleted node keeps its original audit stamp (idempotent).
            await tx.node.updateMany({
              where: { ...subtree, deletedAt: null },
              data: { deletedAt: now, deletedBy },
            });
          } else {
            // #391: soft-delete — set deletedAt/deletedBy so the node drops out of
            // every read (nodes/nodeById/node/resolveUrn) but stays recoverable.
            // Scoped to the authorized memory (TOCTOU, as above); the already-
            // deleted case was handled by the early no-op above, so 0 rows here
            // means the node moved → NODE_NOT_FOUND.
            const res = await tx.node.updateMany({
              where: { id: resolvedId, memoryId, deletedAt: null },
              data: { deletedAt: now, deletedBy },
            });
            if (res.count === 0) {
              throw new GraphQLError(`Node not found: "${nodeRef}"`, {
                extensions: { code: 'NODE_NOT_FOUND', ref: nodeRef },
              });
            }
          }
        // #1619 — a hard delete cascades every node's edges, revisions and
        // derived rows; a few dozen nodes outlast Prisma's 5 s default and
        // the transaction expired partway ("Transaction already closed").
        // Trade-off, accepted: the 5 s default also capped how long one slow
        // delete pins a pool connection and its row/advisory locks. At 120 s
        // a few concurrent huge deletes could starve the pool (others fail
        // fast at maxWait). Large recursive deletes are rare, operator-driven
        // calls, so we take that over failing every legitimate one; chunking
        // or a concurrency cap is the follow-up if it ever bites.
        }, { timeout: 120_000 });
      } catch (e) {
        if (e instanceof GraphQLError) throw e; // typed NODE_HAS_DESCENDANTS
        // Prisma P2025 = record not found — wrap so a missing node surfaces a
        // typed NODE_NOT_FOUND instead of leaking as INTERNAL_SERVER_ERROR
        // (mirrors moveNode; issue #100).
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
          throw new GraphQLError(`Node not found: "${nodeRef}"`, {
            extensions: { code: 'NODE_NOT_FOUND', ref: nodeRef },
          });
        }
        throw e;
      }
      await reconcilePendingEdgeCounts(ctx.db, pendingSourceMemories).catch((err) =>
        console.warn('[deleteNode] pending-edge count reconcile failed (the periodic repair will fix it):', err),
      );
      // #1061 — a delete is a write. Recorded for the addressed node only, not
      // per descendant of a recursive delete: the subtree is removed by one
      // `updateMany` whose row identities are never materialized, and counting
      // a tree's size as N separate writes would swamp the series for what the
      // caller experienced as a single edit.
      //
      // A HARD delete records nothing: the row is gone, so the event's `nodeId`
      // FK has nothing to point at (the insert would simply fail into the
      // recorder's swallowed catch) — and unlike the soft case there is no
      // surviving node whose usage series the event belongs to.
      if (!hard) {
        recordNodeWrite(
          ctx.db,
          { id: resolvedId, loc: node.loc, memoryId: node.memoryId },
          ctx,
        );
      }
      return true;
    },

    // ── Edge CRUD ──────────────────────────────────────────────────────

    createEdge: async (
      _: unknown,
      { sourceRef, targetRef, name, loc, description, isRunnable, condition, priority, data }: {
        sourceRef: string;
        targetRef: string;
        // GraphQL nullable args: non-JS clients send explicit nulls.
        name?: string | null;
        loc?: string | null;
        description?: string | null;
        isRunnable?: boolean | null;
        condition?: unknown;
        priority?: number | null;
        data?: Record<string, unknown> | null;
      },
      ctx: Context,
    ) => {
      // #1300 (Holger, 2026-09-24): NO platform-role gate here. The global
      // `requireRole(ctx, 'CONTRIBUTOR')` this opened with refused every
      // self-signed-up user (default roles [READER]) on ANY node, even as OWNER
      // of the memory, while inline `edges` and MCP hadron_create_edge gated on
      // memory access alone. Authorization is the memory gate below, before
      // any write.
      if (condition !== undefined && condition !== null) {
        throwOnInvalidCondition(condition);
      }
      // #322: each endpoint may be an ID-shape PK (preferred — immutable
      // across move/rename, so the edge survives a later URN change) OR a
      // fully-qualified node URN. resolveNodeRef dispatches on shape; a URN
      // must be fully qualified (spec 022 — no contextMemoryId at the API
      // boundary). Previously this path was PK-only (a bare findUnique by
      // id), so a URN caller got a spurious not-found.
      // Only map a genuine miss (NodeNotFoundError) to NODE_NOT_FOUND. Let
      // UrnNotQualifiedError propagate so server.ts formatError surfaces the
      // spec-022 URN_NOT_QUALIFIED code/message GraphQL callers rely on
      // (PR-348 review: previously both were collapsed into NODE_NOT_FOUND).
      // ORDER IS THE AUTHORIZATION (#1300; @codex + @copilot, PR #1307).
      // The SOURCE is resolved and fully authorized before the target is even
      // looked up: resolving both first let a caller who cannot see the
      // source's memory learn, pair by pair, whether either ref exists
      // ("Target node not found" vs "Source node not found"). Same shape as
      // cloneNode. A caller who cannot READ the source's memory gets exactly
      // what a missing source gets; only a reader who may not write is told
      // Forbidden (the source's existence is theirs to see already).
      let resolvedSourceId: string;
      let resolvedTargetId: string;
      try {
        ({ id: resolvedSourceId } = await resolveNodeRefForCaller(ctx, sourceRef));
      } catch (e) {
        if (e instanceof NodeNotFoundError)
          throw new GraphQLError(`Source node not found: "${sourceRef}"`, { extensions: { code: 'NODE_NOT_FOUND' } });
        throw e;
      }
      // Spec 037: an edge carries a memory-unique `loc` (its identity + URN
      // suffix), with `memoryId` denormalized from the source node.
      const src = await ctx.db.node.findUnique({ where: { id: resolvedSourceId }, select: { loc: true, memoryId: true } });
      if (!src || !(await isMemoryReadableCached(ctx, src.memoryId))) {
        throw new GraphQLError(`Source node not found: "${sourceRef}"`, { extensions: { code: 'NODE_NOT_FOUND' } });
      }
      // PR-348 (Gemini, critical): write access to the SOURCE memory is the
      // authorization — since #1300 there is no platform-role gate in front.
      await requireMemoryWriteAccess(ctx, src.memoryId);

      // Only now the target, and at least READ on it. Its denial is the same
      // NODE_NOT_FOUND as a genuine miss, so it is no cross-memory oracle.
      try {
        ({ id: resolvedTargetId } = await resolveNodeRefForCaller(ctx, targetRef));
      } catch (e) {
        if (e instanceof NodeNotFoundError)
          throw new GraphQLError(`Target node not found: "${targetRef}"`, { extensions: { code: 'NODE_NOT_FOUND' } });
        throw e;
      }
      const tgt = await ctx.db.node.findUnique({ where: { id: resolvedTargetId }, select: { loc: true, memoryId: true } });
      // #849: the shared node-content gate, as for the source above, the inline
      // edges in writeNodeCore (#844), Edge.source/target hydration (#781) and
      // this resolver's own in-transaction recheck below. The MCP
      // `canReadMemory` it used ignored MemoryShare, so a share grantee who
      // could read a node back through an edge could not create that edge.
      if (!tgt || !(await isMemoryReadableCached(ctx, tgt.memoryId))) {
        throw new GraphQLError(`Target node not found: "${targetRef}"`, { extensions: { code: 'NODE_NOT_FOUND' } });
      }
      const edgeLoc = loc != null && loc !== '' ? loc : deriveEdgeLoc(src.loc, name ?? null, tgt.loc);
      try {
        validateLoc(edgeLoc);
      } catch (e) {
        if (e instanceof InvalidLocError) {
          throw new GraphQLError(e.message, { extensions: { code: e.name, loc: e.loc, segment: e.segment } });
        }
        throw e;
      }
      const edge = await ctx.db.$transaction(async (tx) => {
        const locked = await lockLiveEdgeEndpoints(
          tx,
          { id: resolvedSourceId, ...src },
          { id: resolvedTargetId, ...tgt },
        );
        if (!locked.source) {
          throw new GraphQLError(`Source node not found: "${sourceRef}"`, {
            extensions: { code: 'NODE_NOT_FOUND' },
          });
        }
        if (!locked.target) {
          throw new GraphQLError(`Target node not found: "${targetRef}"`, {
            extensions: { code: 'NODE_NOT_FOUND' },
          });
        }
        // A transfer of either endpoint Memory may have committed after
        // preflight. Lock both in a stable order through the insert.
        for (const memoryId of [...new Set([src.memoryId, tgt.memoryId])].sort()) {
          await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR SHARE`;
        }
        const txCtx = withoutRequestCaches(ctx, tx);
        if (!(await isMemoryReadableCached(txCtx, src.memoryId))) {
          throw new GraphQLError(`Source node not found: "${sourceRef}"`, {
            extensions: { code: 'NODE_NOT_FOUND' },
          });
        }
        await requireMemoryWriteAccess(txCtx, src.memoryId);
        if (!(await isMemoryReadableCached(txCtx, tgt.memoryId))) {
          throw new GraphQLError(`Target node not found: "${targetRef}"`, {
            extensions: { code: 'NODE_NOT_FOUND' },
          });
        }
        // Writer level of the source node, on the locked source.
        await assertEdgeSourceWritersById(tx, ctx, locked.source.id);
        return tx.edge.create({
          data: {
            id: generateId(),
            memoryId: locked.source.memoryId,
            sourceId: locked.source.id,
            targetId: locked.target.id,
            loc: edgeLoc,
            name: name ?? null,
            description: description ?? null,
            isRunnable: isRunnable ?? null,
            condition: (condition ?? null) as InputJsonValue,
            // != null: the GraphQL arg is nullable, and non-JS clients (the
            // Go CLI) send explicit nulls for unset args. priority is a
            // non-nullable Int @default(0) — passing null to Prisma fails
            // validation with a misleading "Argument source is missing"
            // (the invalid field disqualifies the scalar-FK input variant).
            // Issue #263.
            ...(priority != null ? { priority } : {}),
            data: (data ?? null) as InputJsonValue,
            createdBy: ctx.userId ?? ctx.clientId ?? null,
          },
          include: { source: true, target: true },
        });
      });
      // #1061 — an edge write is a graph write, attributed to the SOURCE node:
      // the edge lives in the source's memory (spec 037) and `UsageEvent` has
      // no edge dimension. Attributing to the target instead would file the
      // event in another memory on a cross-memory edge. Recorded after the
      // create so a loc conflict records nothing.
      recordNodeWrite(
        ctx.db,
        { id: resolvedSourceId, loc: src.loc, memoryId: src.memoryId },
        ctx,
      );
      await mirrorEdgeSourceAfterCommit(ctx.db, edge.source, ctx.clientId);
      return edge;
    },

    updateEdge: async (
      _: unknown,
      { edgeRef, name, loc, description, isRunnable, condition, priority, data }: {
        edgeRef: string;
        name?: string | null;
        loc?: string | null;
        description?: string | null;
        isRunnable?: boolean | null;
        condition?: unknown;
        priority?: number | null;
        data?: Record<string, unknown> | null;
      },
      ctx: Context,
    ) => {
      // #1300 (Holger, 2026-09-24): NO platform-role gate here. The global
      // `requireRole(ctx, 'CONTRIBUTOR')` this opened with refused every
      // self-signed-up user (default roles [READER]) on ANY node, even as OWNER
      // of the memory, while inline `edges` and MCP hadron_create_edge gated on
      // memory access alone. Authorization is the memory gate below, before
      // any write.
      if (condition !== undefined && condition !== null) {
        throwOnInvalidCondition(condition);
      }
      if (loc != null && loc !== '') {
        try {
          validateLoc(loc);
        } catch (e) {
          if (e instanceof InvalidLocError) {
            throw new GraphQLError(e.message, { extensions: { code: e.name, loc: e.loc, segment: e.segment } });
          }
          throw e;
        }
      }
      // Null semantics differ per arg (#263):
      // - condition/data: null CLEARS the stored value — the spec'd
      //   edge-conditions contract ("null = always fires") that the portal
      //   condition editor relies on.
      // - name/description: null CLEARS (both nullable since spec 037).
      // - loc: null/empty = UNSET (keep stored); loc is the identity and
      //   can't be cleared. isRunnable: undefined preserves, else set.
      // - priority: null = UNSET (keep stored). The column is a
      //   non-nullable Int, so null is never meaningful — and forwarding
      //   it makes Prisma fail with a misleading "Argument source is
      //   missing".
      // Non-JS clients that serialize unset args as explicit nulls (the
      // Go CLI's genqlient layer) must omit unset variables instead —
      // tracked as a hadron-cli fix.
      //
      // #542: 'edgeRef' is an ID-shape PK OR a fully-qualified edge URN,
      // resolved by the shared resolveEdgeRef (Tier 2 — previously this path
      // was PK-only via a bare `where: { id }`). A genuine miss → EDGE_NOT_FOUND
      // (was an unwrapped Prisma P2025); a malformed relative URN propagates as
      // UrnNotQualifiedError (spec 022).
      let resolvedEdgeId: string;
      try {
        ({ id: resolvedEdgeId } = await resolveEdgeRef(ctx.db, edgeRef));
      } catch (e) {
        if (e instanceof EdgeNotFoundError) {
          throw new GraphQLError(`Edge not found: "${edgeRef}"`, {
            extensions: { code: 'EDGE_NOT_FOUND', ref: edgeRef },
          });
        }
        throw e;
      }
      // PR-348 parity (Codex #554): gate on write access to the edge's
      // (denormalized) memory, before the update — matching createEdge /
      // deleteNode / moveNode. Since #1300 this is the only gate, and with
      // edgeRef accepting a cross-memory URN it is what stops an update in a
      // memory the caller cannot write.
      const edgeMem = await ctx.db.edge.findUnique({
        where: { id: resolvedEdgeId },
        select: { memoryId: true },
      });
      if (!edgeMem) {
        throw new GraphQLError(`Edge not found: "${edgeRef}"`, {
          extensions: { code: 'EDGE_NOT_FOUND', ref: edgeRef },
        });
      }
      // #1300 / @codex P2 on PR #1307: a caller who cannot READ the edge's
      // memory gets the same EDGE_NOT_FOUND as a missing edge, so the refusal
      // is not an existence oracle; a reader who may not write gets Forbidden.
      if (!(await isMemoryReadableCached(ctx, edgeMem.memoryId))) {
        throw new GraphQLError(`Edge not found: "${edgeRef}"`, {
          extensions: { code: 'EDGE_NOT_FOUND', ref: edgeRef },
        });
      }
      await requireMemoryWriteAccess(ctx, edgeMem.memoryId);
      const updatedEdge = await ctx.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM memories WHERE id = ${edgeMem.memoryId} FOR SHARE`;
        const txCtx = withoutRequestCaches(ctx, tx);
        if (!(await isMemoryReadableCached(txCtx, edgeMem.memoryId))) {
          throw new GraphQLError(`Edge not found: "${edgeRef}"`, {
            extensions: { code: 'EDGE_NOT_FOUND', ref: edgeRef },
          });
        }
        await requireMemoryWriteAccess(txCtx, edgeMem.memoryId);
        // A Channel reuse may archive this edge after resolveEdgeRef's
        // preflight. Serialize with that archive's edge UPDATE and refuse a
        // tombstone instead of letting a stale update reoccupy its old loc.
        // Source node first, then the edge row (the order node writes take); the source is revalidated under the edge lock.
        const current = await lockEdgeUnderSourceWriters(tx, ctx, resolvedEdgeId);
        if (!current || current.deleted_at) {
          throw new GraphQLError(`Edge not found: "${edgeRef}"`, {
            extensions: { code: 'EDGE_NOT_FOUND', ref: edgeRef },
          });
        }
        await refuseGovernedEdge(tx, resolvedEdgeId);
        return tx.edge.update({
          where: { id: resolvedEdgeId },
          data: {
            ...(name !== undefined ? { name: name ?? null } : {}),
            ...(loc != null && loc !== '' ? { loc } : {}),
            ...(description !== undefined ? { description: description ?? null } : {}),
            ...(isRunnable !== undefined ? { isRunnable: isRunnable ?? null } : {}),
            ...(condition !== undefined ? { condition: (condition ?? null) as InputJsonValue } : {}),
            ...(priority != null ? { priority } : {}),
            ...(data !== undefined ? { data: data as InputJsonValue } : {}),
            updatedBy: ctx.userId ?? ctx.clientId ?? null,
          },
          include: { source: true, target: true },
        });
      });
      // #1061 — attributed to the source node, as createEdge is.
      recordNodeWrite(ctx.db, toUsageNodeRef(updatedEdge.source), ctx);
      await mirrorEdgeSourceAfterCommit(ctx.db, updatedEdge.source, ctx.clientId);
      return updatedEdge;
    },

    deleteEdge: async (
      _: unknown,
      { edgeRef }: { edgeRef: string },
      ctx: Context,
    ) => {
      // #1300 (Holger, 2026-09-24): NO platform-role gate here. The global
      // `requireRole(ctx, 'CONTRIBUTOR')` this opened with refused every
      // self-signed-up user (default roles [READER]) on ANY node, even as OWNER
      // of the memory, while inline `edges` and MCP hadron_create_edge gated on
      // memory access alone. Authorization is the memory gate below, before
      // any write.
      // #542: resolve edgeRef (ID or fully-qualified edge URN) via the shared
      // resolveEdgeRef (Tier 2 — was PK-only). A miss → EDGE_NOT_FOUND instead
      // of an unwrapped Prisma P2025.
      let resolvedEdgeId: string;
      try {
        ({ id: resolvedEdgeId } = await resolveEdgeRef(ctx.db, edgeRef));
      } catch (e) {
        if (e instanceof EdgeNotFoundError) {
          throw new GraphQLError(`Edge not found: "${edgeRef}"`, {
            extensions: { code: 'EDGE_NOT_FOUND', ref: edgeRef },
          });
        }
        throw e;
      }
      // PR-348 parity (Codex #554): gate on write access to the edge's memory
      // before deleting. Since #1300 this is the only gate, and it runs before
      // the delete.
      // `source` rides along for the #1061 usage attribution below; it is read
      // here rather than after the delete, when the row is gone.
      const edgeMem = await ctx.db.edge.findUnique({
        where: { id: resolvedEdgeId },
        select: {
          memoryId: true,
          source: { select: { id: true, loc: true, memoryId: true, ownerRepo: true } },
        },
      });
      if (!edgeMem) {
        throw new GraphQLError(`Edge not found: "${edgeRef}"`, {
          extensions: { code: 'EDGE_NOT_FOUND', ref: edgeRef },
        });
      }
      // #1300 / @codex P2 on PR #1307: a caller who cannot READ the edge's
      // memory gets the same EDGE_NOT_FOUND as a missing edge, so the refusal
      // is not an existence oracle; a reader who may not write gets Forbidden.
      if (!(await isMemoryReadableCached(ctx, edgeMem.memoryId))) {
        throw new GraphQLError(`Edge not found: "${edgeRef}"`, {
          extensions: { code: 'EDGE_NOT_FOUND', ref: edgeRef },
        });
      }
      await requireMemoryWriteAccess(ctx, edgeMem.memoryId);
      await ctx.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM memories WHERE id = ${edgeMem.memoryId} FOR SHARE`;
        const txCtx = withoutRequestCaches(ctx, tx);
        if (!(await isMemoryReadableCached(txCtx, edgeMem.memoryId))) {
          throw new GraphQLError(`Edge not found: "${edgeRef}"`, {
            extensions: { code: 'EDGE_NOT_FOUND', ref: edgeRef },
          });
        }
        await requireMemoryWriteAccess(txCtx, edgeMem.memoryId);
        // Writer level of the edge's current source, locked before the edge.
        const lockedEdge = await lockEdgeUnderSourceWriters(tx, ctx, resolvedEdgeId);
        if (!lockedEdge || lockedEdge.deleted_at) {
          throw new GraphQLError(`Edge not found: "${edgeRef}"`, { extensions: { code: 'EDGE_NOT_FOUND', ref: edgeRef } });
        }
        await refuseGovernedEdge(tx, resolvedEdgeId);
        await tx.edge.delete({ where: { id: resolvedEdgeId } });
      });
      // #1061 — attributed to the source node, as createEdge is.
      recordNodeWrite(ctx.db, toUsageNodeRef(edgeMem.source), ctx);
      await mirrorEdgeSourceAfterCommit(ctx.db, edgeMem.source, ctx.clientId);
      return true;
    },

    // ── Asset upload (spec 004-asset-upload) ───────────────────────────

    // #564 — relocate a node, identified by `sourceRef` (PK or fully-qualified
    // URN). The destination is either a full `targetUrn` (new memory + loc) or a
    // `targetMemoryRef` (same loc, new memory) — exactly one. Every node keeps
    // its stable id, so incoming/outgoing edge references stay valid. Fails
    // loudly (NODE_ALREADY_EXISTS) if any node already occupies a destination
    // slot. Requires write access to BOTH memories (review:entity-ref-args #3).
    //
    // A move rebases the node's whole loc-SUBTREE with it (#768). A node's
    // parent/child relation is its loc prefix (`a:b` parents `a:b:c`) and its URN
    // is `<memoryUrn>::<loc>` — so relocating only the named node stranded every
    // descendant. #781: a move may ALSO relocate the subtree ACROSS memories
    // (nodes + embeddings + outgoing edges follow; boundary edges become
    // cross-memory edges gated by #783) — moveNodeSubtree handles both.
    moveNode: async (
      _: unknown,
      args: { sourceRef: string; targetUrn?: string | null; targetMemoryRef?: string | null },
      ctx: Context,
    ) => (await nodeMoveOps.moveWithResult(ctx, args)).node,

    // #564 — clone a node to a new location, returning the NEW node (fresh id).
    // `sourceRef` + (`targetUrn` XOR `targetMemoryRef`) mirror moveNode. Copies
    // the source's own fields; OUTGOING edges are copied only where they
    // naturally resolve — a live node exists at the target's loc in the
    // destination memory (same-memory clones keep their sibling edges; a
    // cross-memory clone keeps only edges whose target also lives there).
    // Incoming edges are never copied (they reference the source's identity).
    // Delegates to writeNodeCore('create'), inheriting every single-write
    // invariant (dest write auth, encryption re-encrypt for the destination,
    // NodeRevision, abstractOriginHash, re-embed, git mirror) and its fail-loud
    // NodeLocConflictError when the destination loc is already occupied.
    cloneNode: async (
      _: unknown,
      { sourceRef, targetUrn, targetMemoryRef }: { sourceRef: string; targetUrn?: string | null; targetMemoryRef?: string | null },
      ctx: Context,
    ) => {
      const selectedSource = await resolveExistingNode(ctx, sourceRef);
      // Cloning READS the source's content — require read access to the source
      // memory, or the URN-widened input becomes a cross-tenant exfiltration
      // path (review:entity-ref-args #3). Denial reads as not-found (no oracle).
      if (!(await canReadMemory(ctx.db, ctx, selectedSource.memoryId))) {
        throw new GraphQLError(`Node not found: "${sourceRef}"`, {
          extensions: { code: 'NODE_NOT_FOUND', ref: sourceRef },
        });
      }
      // A raw writer may have changed the source's content while leaving its
      // old task/human stamp. Reconcile under the source row lock and copy the
      // resulting state; the clone's own fingerprint would otherwise certify
      // the stale stamp permanently. A concurrent move or delete is a miss in
      // the memory this caller was authorized to read.
      const source = await ctx.db.$transaction(async (tx) => {
        if ((await ensureCurrentNodeRevisionInTransaction(tx, selectedSource.id, {
          expectedMemoryId: selectedSource.memoryId,
        })) == null) return null;
        const current = await tx.node.findUnique({ where: { id: selectedSource.id } });
        return current && !current.deletedAt && current.loc === selectedSource.loc ? current : null;
      });
      if (!source) {
        throw new GraphQLError(`Node not found: "${sourceRef}"`, {
          extensions: { code: 'NODE_NOT_FOUND', ref: sourceRef },
        });
      }
      const { destMemoryId, destLoc } = await resolveRelocationTarget(
        ctx, source, targetUrn, targetMemoryRef,
      );
      // #1450 (@codex P1, PR #1452) — a placeholder has nothing to copy, and
      // writeNodeCore strips the flag, so a clone would be an ordinary blank
      // node claiming the citation. Reserve the citation at the destination.
      if (source.isPlaceholder) {
        throw new GraphQLError(
          `Cannot clone placeholder "${source.loc}": it has no spec to copy. Reserve the citation where you need it instead.`,
          { extensions: { code: 'SPEC_PLACEHOLDER_NOT_COPYABLE', loc: source.loc } },
        );
      }

      // Decrypt the source with the SOURCE memory key so writeNodeCore can
      // re-encrypt the plaintext for the DESTINATION memory. Only content/
      // abstract are encrypted at rest.
      const srcEnc = await getMemoryEncryptionInfo(ctx.db, source.memoryId);
      const srcPlain = { ...source };
      if (srcEnc.isEncrypted) {
        if (!sessionKeyCache.getByMemoryId(srcEnc.id)) {
          throw new GraphQLError(
            `SESSION_EXPIRED: memory ${srcEnc.id} is encrypted but no active session key is available.`,
            { extensions: { code: 'SESSION_EXPIRED', memoryId: srcEnc.id } },
          );
        }
        decryptNodeFields(srcPlain, srcEnc);
      }

      // Outgoing edges that naturally resolve in the destination memory.
      const outgoing = await ctx.db.edge.findMany({
        where: { sourceId: source.id, deletedAt: null, target: { deletedAt: null } },
        include: { target: { select: { loc: true } } },
      });
      const edges: NodeEdgeInput[] = [];
      for (const e of outgoing) {
        const destTarget = await ctx.db.node.findFirst({
          where: { loc: e.target.loc, memoryId: destMemoryId, deletedAt: null },
          select: { id: true },
        });
        if (!destTarget) continue; // target doesn't exist at the destination — skip
        edges.push({
          targetId: destTarget.id,
          name: e.name,
          description: e.description,
          isRunnable: e.isRunnable,
        });
      }

      const input: NodeInput = {
        memoryId: destMemoryId,
        loc: destLoc,
        name: srcPlain.name,
        nodeType: srcPlain.nodeType,
        isLink: srcPlain.isLink,
        objectType: srcPlain.objectType ?? undefined, // #725 — carry the collection through a clone
        // Keep the complete governed signal set together. The ordinary
        // writeNodeCore gate still refuses governed results from this generic
        // clone path; it must never succeed by silently dropping a signal.
        ...carryGovernedSignals(srcPlain),
        alias: srcPlain.alias ?? undefined,
        description: srcPlain.description ?? undefined,
        abstract: srcPlain.abstract ?? undefined,
        content: srcPlain.content ?? undefined,
        data: (srcPlain.data as Record<string, unknown> | null) ?? undefined,
        tags: deserializeTags(srcPlain.tags),
        properties: (srcPlain.properties as Record<string, unknown> | null) ?? undefined,
        llmModel: srcPlain.llmModel ?? undefined,
        aiAgent: srcPlain.aiAgent ?? undefined,
        seq: srcPlain.seq ?? undefined,
        edges,
      };
      // #1061 — a clone is both: the source's content was returned to this
      // caller (a read of the SOURCE memory, which may differ from the
      // destination's) and writeNodeCore records the write of the new node.
      recordNodeRead(ctx.db, toUsageNodeRef(source), ctx);
      // The generic write refuses governed signals, while open roles and all
      // other authored fields are copied. A stale abstract is re-fingerprinted
      // by writeNodeCore, so only that case changes the copied authored state.
      const copiedAuthorship = (
        srcPlain.abstract == null ||
        srcPlain.abstractOriginHash === computeContentHash(srcPlain.content)
      ) ? carryNodeAuthorship(source) : clearNodeAuthorship();
      return writeNodeCore(input, ctx, 'create', { copiedAuthorship });
    },

    // Fold a source node into a target node, returning the updated target.
    // Reuses upsertNode's single-write invariants (per-memory write auth,
    // decrypt→merge→re-encrypt, NodeRevision snapshot, abstractOriginHash
    // recompute, re-embed, git mirror) but combines two existing rows rather
    // than applying a NodeInput. See MergeNodesInput / NodeMergeField.
    mergeNodes: async (
      _: unknown,
      { input }: { input: MergeNodesInput },
      ctx: Context,
    ) => {
      const { source: rawSource, target: rawTarget } = input;
      const deleteSource = input.deleteSource ?? false;
      // Omitted/null `include` = merge every mergeable field.
      const fields = new Set<NodeMergeField>(input.include ?? ALL_NODE_MERGE_FIELDS);

      // Resolve both endpoints (ID or fully-qualified URN — same dispatch as
      // createEdge). A genuine miss maps to NODE_NOT_FOUND; a malformed
      // relative URN propagates as UrnNotQualifiedError (spec 022).
      let sourceId: string;
      let targetId: string;
      try {
        ({ id: sourceId } = await resolveNodeRefForCaller(ctx, rawSource));
      } catch (e) {
        if (e instanceof NodeNotFoundError)
          throw new GraphQLError(`Source node not found: "${rawSource}"`, {
            extensions: { code: 'NODE_NOT_FOUND', ref: rawSource },
          });
        throw e;
      }
      try {
        ({ id: targetId } = await resolveNodeRefForCaller(ctx, rawTarget));
      } catch (e) {
        if (e instanceof NodeNotFoundError)
          throw new GraphQLError(`Target node not found: "${rawTarget}"`, {
            extensions: { code: 'NODE_NOT_FOUND', ref: rawTarget },
          });
        throw e;
      }
      if (sourceId === targetId) {
        throw new GraphQLError('mergeNodes: source and target are the same node.', {
          extensions: { code: 'MERGE_SOURCE_EQUALS_TARGET', nodeId: sourceId },
        });
      }

      const [source, target] = await Promise.all([
        ctx.db.node.findUnique({ where: { id: sourceId } }),
        ctx.db.node.findUnique({ where: { id: targetId } }),
      ]);
      if (!source || source.deletedAt)
        throw new GraphQLError(`Source node not found: "${rawSource}"`, {
          extensions: { code: 'NODE_NOT_FOUND', ref: rawSource },
        });
      if (!target || target.deletedAt)
        throw new GraphQLError(`Target node not found: "${rawTarget}"`, {
          extensions: { code: 'NODE_NOT_FOUND', ref: rawTarget },
        });
      // #2206 (B): a merge folds one node's content into the other and returns the result, so a node in a memory the
      // caller may write but not read answers exactly as a missing one, on either end, before any gate.
      if (await isWriteBeyondRead(ctx.db, ctx, source.memoryId))
        throw new GraphQLError(`Source node not found: "${rawSource}"`, {
          extensions: { code: 'NODE_NOT_FOUND', ref: rawSource },
        });
      if (await isWriteBeyondRead(ctx.db, ctx, target.memoryId))
        throw new GraphQLError(`Target node not found: "${rawTarget}"`, {
          extensions: { code: 'NODE_NOT_FOUND', ref: rawTarget },
        });

      // Auth. The target is mutated → write access always. The source is
      // read to fold its fields; it's mutated only when we delete it or
      // re-point its edges (EDGES) → write access then, else read suffices.
      // A source read-denial returns the same NODE_NOT_FOUND wording as a
      // genuine miss so it can't be used as a cross-memory existence oracle
      // (mirrors createEdge's target-denial posture).
      await requireMemoryWriteAccess(ctx, target.memoryId);
      // #1606 (cor:dmo:110:01/04) — a comment never merges, and a merge that
      // moves the source's incoming edges or deletes it would retarget or
      // strand the threads anchored to the source's identity. The comment path
      // has no merge; an admin deletes the source's threads first.
      if (source.nodeType === COMMENT_NODE_TYPE || target.nodeType === COMMENT_NODE_TYPE) {
        throw commentGovernedError('merge', 'edits');
      }
      assertBootPromptWriteAllowed(source, { nodeType: undefined, role: undefined }, 'merge');
      assertBootPromptWriteAllowed(target, { nodeType: undefined, role: undefined }, 'merge');
      // #1664 — moving the source's edges is safe (governed edges never re-home);
      // DELETING a source with live threads refuses, but only under the source
      // lock, after every gate (#1682 review: a pre-lock check raced, and ran
      // before the source memory's authorization, disclosing its loc).
      // Same-memory merge (the common case): write access to the target's
      // memory already covers the source. Only run a separate source check
      // when the nodes live in different memories.
      const authedMemories = new Set<string>([target.memoryId]);
      if (source.memoryId !== target.memoryId) {
        const touchesSource = deleteSource || fields.has('EDGES');
        if (touchesSource) {
          await requireMemoryWriteAccess(ctx, source.memoryId);
        } else if (!(await canReadMemory(ctx.db, ctx, source.memoryId))) {
          throw new GraphQLError(`Source node not found: "${rawSource}"`, {
            extensions: { code: 'NODE_NOT_FOUND', ref: rawSource },
          });
        }
      }
      authedMemories.add(source.memoryId);
      // Spec 049 S4: neither endpoint may be a Channel's address — the target
      // is written, the source is deleted or re-pointed (Copilot on PR #1165,
      // round 2). Fast typed refusal here; the authoritative check runs under
      // the locks inside the transaction below.
      await assertLocWritable(ctx.db, target.memoryId, target.loc, 'merge');
      if (deleteSource || fields.has('EDGES')) {
        await assertLocWritable(ctx.db, source.memoryId, source.loc, 'merge');
      }

      // Edge transfer can mutate edges whose denormalized memory is NEITHER
      // the source's nor the target's: an INCOMING edge from a third memory
      // gets its endpoint re-pointed (or dropped) here. Require write access
      // to every such memory before touching it, so a merge can't re-point or
      // delete edges in a memory the caller can't write. Cheap pre-pass: pull
      // just the distinct memoryIds of edges touching the source.
      if (fields.has('EDGES')) {
        const edgeMems = await ctx.db.edge.findMany({
          where: { OR: [{ sourceId: source.id }, { targetId: source.id }] },
          select: { memoryId: true },
          distinct: ['memoryId'],
        });
        for (const { memoryId } of edgeMems) {
          if (authedMemories.has(memoryId)) continue;
          await requireMemoryWriteAccess(ctx, memoryId);
          authedMemories.add(memoryId);
        }
      }

      // Only content/abstract/data are encrypted at rest, so an edge-only or
      // tags/description/properties-only merge needs no session key. Gate the
      // key requirement + decrypt on whether an encrypted field actually
      // participates, so those merges work on an encrypted memory without a
      // live session (and don't fail with a spurious SESSION_EXPIRED).
      const touchesEncrypted =
        fields.has('CONTENT') || fields.has('ABSTRACT') || fields.has('DATA');
      const [srcEnc, tgtEnc] = await Promise.all([
        getMemoryEncryptionInfo(ctx.db, source.memoryId),
        getMemoryEncryptionInfo(ctx.db, target.memoryId),
      ]);
      if (touchesEncrypted && srcEnc.isEncrypted && !sessionKeyCache.getByMemoryId(srcEnc.id)) {
        throw new GraphQLError(
          `SESSION_EXPIRED: memory ${srcEnc.id} is encrypted but no active session key is available.`,
          { extensions: { code: 'SESSION_EXPIRED', memoryId: srcEnc.id } },
        );
      }
      if (touchesEncrypted && tgtEnc.isEncrypted && !sessionKeyCache.getByMemoryId(tgtEnc.id)) {
        throw new GraphQLError(
          `SESSION_EXPIRED: memory ${tgtEnc.id} is encrypted but no active session key is available.`,
          { extensions: { code: 'SESSION_EXPIRED', memoryId: tgtEnc.id } },
        );
      }
      const srcPt = { ...source };
      if (touchesEncrypted && srcEnc.isEncrypted) decryptNodeFields(srcPt, srcEnc);
      const tgtPt = { ...target };
      if (touchesEncrypted && tgtEnc.isEncrypted) decryptNodeFields(tgtPt, tgtEnc);

      // ── Field merge (on plaintext) ──────────────────────────────────────
      // Spec: cor:api:070:01 (field merge strategy). The per-field strategy is
      // shared with mergeMemories via src/lib/nodeMerge.ts. `properties` is
      // never encrypted, so it's read from the raw rows; data/content/abstract
      // come from the decrypted plaintext views above.
      let changed: Record<string, unknown>;
      let abstractChanged: boolean;
      let contentChanged: boolean;
      try {
        ({ changed, abstractChanged, contentChanged } = mergeNodeFields(
          {
            content: srcPt.content,
            abstract: srcPt.abstract,
            description: srcPt.description,
            tags: srcPt.tags,
            data: srcPt.data,
            properties: source.properties,
          },
          {
            content: tgtPt.content,
            abstract: tgtPt.abstract,
            description: tgtPt.description,
            tags: tgtPt.tags,
            data: tgtPt.data,
            properties: target.properties,
          },
          fields,
        ));
      } catch (e) {
        if (e instanceof NodeAbstractTooLongError) {
          throw new GraphQLError(e.message, {
            extensions: e.extensionFields(),
          });
        }
        throw e;
      }

      // Post-merge plaintext content drives the spec-032 abstract hash.
      const postMergeContent = contentChanged
        ? (changed.content as string | null)
        : tgtPt.content ?? null;

      // Encrypt the encrypted-field subset with the TARGET's key before write.
      const writeData: Record<string, unknown> = { ...changed };
      if (tgtEnc.isEncrypted && ('content' in changed || 'abstract' in changed || 'data' in changed)) {
        const key = sessionKeyCache.getByMemoryId(tgtEnc.id)!; // validated above
        const enc = encryptNodeFieldsWithKey(
          {
            content: 'content' in changed ? (changed.content as string | null) : null,
            abstract: 'abstract' in changed ? (changed.abstract as string | null) : null,
            data: 'data' in changed ? (changed.data ?? null) : null,
          },
          key,
        );
        if ('content' in changed) writeData.content = enc.content;
        if ('abstract' in changed) writeData.abstract = enc.abstract;
        if ('data' in changed) writeData.data = enc.data;
      }
      // abstractOriginHash tracks "content when the abstract was authored".
      // Recompute against post-merge plaintext content only when the abstract
      // itself changed (a content-only merge intentionally leaves the hash so
      // staleness detection fires — matches upsertNode / searchReplaceInNodes).
      if (abstractChanged) {
        writeData.abstractOriginHash = computeContentHash(postMergeContent);
      }
      writeData.revisionContentHash = revisionStateHashRefreshMarker();
      writeData.updatedBy = ctx.userId ?? ctx.clientId ?? null;

      // #725/#737 — the merged target must still satisfy its collection's schema.
      // objectType is untouched by a merge; `properties` is plaintext (never
      // encrypted), so `changed.properties` (else the target's) is safe here.
      await enforceNodeSchemaOnWrite(
        ctx.db,
        target.memoryId,
        target.objectType,
        'properties' in changed ? changed.properties : target.properties,
      );

      // ── Atomic write: revision snapshot → target update → edge re-point →
      //    source delete ──────────────────────────────────────────────────
      let pendingSourceMemories: string[] = []; // #449
      await mapDeadlockToWriteConflict(target.memoryId, () => ctx.db.$transaction(async (tx) => {
        // #1187 — DECLARE the complete key set first, in the one global order.
        // A merge takes two keys and used to take them target-then-source,
        // which inverted against move's destination-then-source; sorting only
        // merge's endpoints then inverted merge against move the other way.
        // Handing the whole set to `acquireLockSet` removes the choice: a call
        // site that cannot pick its own order cannot invert against another.
        //
        // The per-endpoint helpers below still run — they carry the spec-049 S4
        // gate and its per-verb refusal — and their re-acquisitions are free
        // (pg advisory locks are re-entrant within a transaction).
        const takesSource = deleteSource || fields.has('EDGES');
        await acquireLockSet(tx, [
          { memoryId: target.memoryId, loc: target.loc },
          ...(takesSource ? [{ memoryId: source.memoryId, loc: source.loc }] : []),
        ]);
        // Lock-then-gate on both endpoints (spec 049 S4).
        await lockLocForWrite(tx, target.memoryId, target.loc);
        if (takesSource) {
          await lockNodeForDelete(tx, source.memoryId, source.loc);
        }
        // A merge plans encrypted fields before this transaction. Keep both
        // memory flags stable through the write or refuse the stale plan.
        // #1753 — memory rows BEFORE node rows (promotion's order).
        for (const memoryId of [...new Set([source.memoryId, target.memoryId])].sort()) {
          await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR SHARE`;
          const memory = await tx.memory.findUniqueOrThrow({
            where: { id: memoryId }, select: { isEncrypted: true },
          });
          const expected = memoryId === source.memoryId ? srcEnc.isEncrypted : tgtEnc.isEncrypted;
          if (memory.isEncrypted !== expected) {
            throw new GraphQLError('Memory encryption changed while this merge was running; retry.', {
              extensions: { code: 'NODE_WRITE_CONFLICT', memoryId },
            });
          }
        }
        for (const id of [source.id, target.id].sort()) {
          await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${id} FOR UPDATE`;
        }
        // #1468 — `deleteSource` hard-deletes the source, so a minted spec
        // may not be the source (supersede it instead). Runs after the memory
        // locks and then the node locks just taken (memory, then node, #1753),
        // which the guard re-enters.
        if (deleteSource) {
          await assertNoMintedSpecRemoval(tx, source.memoryId, [source.id], 'merge-and-delete');
        }
        // #1323 (@codex/@copilot, PR #1339): both endpoints are row-locked and
        // their unrevisioned drift reconciled as their OWN revisions (id order)
        // before the snapshot. The merge was computed from reads taken BEFORE
        // these locks, so an endpoint whose tracked state changed since then
        // refuses instead of being overwritten with a stale fold.
        const endpointMemory = new Map([[source.id, source.memoryId], [target.id, target.memoryId]]);
        for (const id of [source.id, target.id].sort()) {
          await ensureCurrentNodeRevisionInTransaction(tx, id, { expectedMemoryId: endpointMemory.get(id)! });
        }
        const lockedSource = await tx.node.findUnique({ where: { id: source.id } });
        const lockedTarget = await tx.node.findUnique({ where: { id: target.id } });
        if (
          !lockedSource || !lockedTarget ||
          // deletedAt is not revisioned; a delete landing first must refuse.
          lockedSource.deletedAt || lockedTarget.deletedAt ||
          !revisionStateMatches(source, lockedSource) ||
          !revisionStateMatches(target, lockedTarget)
        ) {
          throw new GraphQLError('mergeNodes: the source or target changed while the merge was running — re-run it.', {
            extensions: { code: 'NODE_WRITE_CONFLICT' },
          });
        }
        // #1331 — the target is written, and a source that is deleted or whose edges
        // are re-pointed is written too: each role's writer level, on the locked rows.
        await assertRoleWritersForWrite(tx, ctx, target.memoryId, {
          priorRole: lockedTarget.role, nextRole: lockedTarget.role, priorRunnable: lockedTarget.isRunnable, nextRunnable: lockedTarget.isRunnable,
        });
        if (takesSource) {
          await assertRoleWritersForWrite(tx, ctx, source.memoryId, {
            priorRole: lockedSource.role, nextRole: lockedSource.role, priorRunnable: lockedSource.isRunnable, nextRunnable: lockedSource.isRunnable,
          });
        }
        // #1682 review (Baloo P2) — the AUTHORITATIVE live-thread refusal, under
        // the source lock and before any write. The pre-lock count above is only
        // a fast answer: posting a comment never changes its target's revision
        // (cor:dmo:110:06), so revisionStateMatches can't see one that landed in
        // between, and the delete below would destroy it.
        if (deleteSource) await refuseLiveThreadsOnFold(tx, [source.id]);
        // #1641 §3.2 — a decision is never merged, as source or target: its
        // content is rendered from its payload, and a fold would rewrite it.
        const mergedDecisions = [lockedSource, lockedTarget].filter((n) => isDecisionFamilyRole(n.role));
        if (mergedDecisions.length > 0) throw decisionContainedError('Merging these nodes', mergedDecisions.map((n) => n.loc));
        // A hard-deleted source is a removal. The source row was locked FOR
        // UPDATE and re-read above, so this judges its current state: a governed
        // node is removed only after its marker is cleared through the kind's door.
        if (deleteSource) {
          const kinds = governedKindsOf({ role: lockedSource.role, isRunnable: lockedSource.isRunnable });
          if (kinds.length > 0) throw governedRemovalError([{ id: lockedSource.id, loc: lockedSource.loc, kinds }]);
        }
        await createNodeRevision(
          tx,
          buildNodeRevisionSnapshot(target, editorFromAuth(ctx), {
            // Plaintext field names the merge folds into the target — the
            // node columns the update below writes.
            changes: Object.keys(changed),
          }),
        );

        if (Object.keys(changed).length > 0) {
          // #1468 — the tags union can mark the target's FIRST spec; the guard
          // takes the lock that serializes that with a whole-corpus delete.
          if ('tags' in changed) {
            await assertNoMintedSpecUnmark(tx, target.memoryId, [{ id: target.id, tags: changed.tags as string[] }], 'merge into');
          }
          await tx.node.update({
            where: { id: target.id },
            data: {
              ...writeData,
              ...clearNodeAuthorship(),
              // #1450 (@codex P2, PR #1452): merging real content into a
              // reserved citation writes the spec, same as updateSpecNode.
              ...placeholderFillPatch(lockedTarget, 'content' in changed ? changed.content : undefined),
            },
          });
          // #2040 — the folded plaintext is re-checked for include tags (a merge
          // can combine two nodes' tags into a cycle); a refusal rolls it back.
          if ('content' in changed) {
            const text = changed.content as string | null;
            const readable = text?.includes('{{>') ? await getAccessibleMemoryIds(ctx) : null;
            // The target's text before the fold: tgtPt, revalidated against the
            // locked row above (revisionStateMatches), so only the source's tags
            // and any the fold changes count as added (#2041 S2b).
            const stored = { storedPlaintext: tgtPt.content ?? null };
            const tags = await assertIncludesWritable(tx, target, text, readable, undefined, stored);
            await syncDerivedIncludesEdges(tx, target, tags, readable, stored);
          }
        }

        if (fields.has('EDGES')) {
          // Spec: cor:api:070:02 (edge transfer + source disposition).
          // Re-point A's edges onto B. Each re-homed edge's `loc` is RECOMPUTED
          // from its new endpoints (deriveEdgeLoc = <sourceLoc>:<name>:<targetLoc>)
          // so it (a) stays consistent with the endpoints rather than
          // referencing the merged-away source, and (b) collides — at the
          // recomputed (loc, memoryId) — with an equivalent edge B already
          // holds, which is then dropped rather than duplicated (#568 Q2).
          // Self-loops (source↔target collapsing onto B) are dropped too.
          const srcEdges = await tx.edge.findMany({
            // #1606 — a comment's governed edge never re-homes (deleted threads
            // only reach here; live ones refused above). It goes with its thread.
            where: { OR: [{ sourceId: source.id }, { targetId: source.id }], governedKind: null },
            include: { source: { select: { loc: true } }, target: { select: { loc: true } } },
          });
          const movingIds = new Set(srcEdges.map((e) => e.id));

          // Plan each re-home (dropping self-loops): compute the new endpoints,
          // the recomputed loc, and the landing memory. An OUTGOING edge follows
          // its source into the target's memory; an INCOMING edge keeps its own
          // (possibly foreign) memory, changing only its loc + targetId.
          const toDrop: string[] = [];
          const planned: Array<{
            id: string; sourceId: string; targetId: string; memoryId: string; loc: string;
          }> = [];
          const landingMemories = new Set<string>();
          for (const e of srcEdges) {
            const isOutgoing = e.sourceId === source.id;
            const newSourceId = isOutgoing ? target.id : e.sourceId;
            const newTargetId = e.targetId === source.id ? target.id : e.targetId;
            if (newSourceId === newTargetId) {
              toDrop.push(e.id); // self-loop
              continue;
            }
            const newSourceLoc = isOutgoing ? target.loc : e.source.loc;
            const newTargetLoc = e.targetId === source.id ? target.loc : e.target.loc;
            const newMemoryId = isOutgoing ? target.memoryId : e.memoryId;
            landingMemories.add(newMemoryId);
            planned.push({
              id: e.id,
              sourceId: newSourceId,
              targetId: newTargetId,
              memoryId: newMemoryId,
              loc: deriveEdgeLoc(newSourceLoc, e.name, newTargetLoc),
            });
          }

          // Existing locs a re-homed edge could collide with. Only the specific
          // RECOMPUTED locs can collide, so filter the lookup to those — O(re-
          // homed edges), not O(edges in the whole landing memory). A moving
          // edge can't collide with itself, so exclude the moving set.
          const candidateLocs = new Set(planned.map((p) => p.loc));
          const occupied = new Map<string, Set<string>>();
          for (const mid of landingMemories) occupied.set(mid, new Set());
          if (candidateLocs.size > 0) {
            for (const e of await tx.edge.findMany({
              where: { memoryId: { in: [...landingMemories] }, loc: { in: [...candidateLocs] } },
              select: { id: true, memoryId: true, loc: true },
            })) {
              if (!movingIds.has(e.id)) occupied.get(e.memoryId)!.add(e.loc);
            }
          }

          // Drop a planned edge whose recomputed (loc, memoryId) is already held
          // — by a non-moving edge, or by an earlier planned edge (dedup within
          // the moving set).
          const relocations: typeof planned = [];
          for (const p of planned) {
            const taken = occupied.get(p.memoryId)!;
            if (taken.has(p.loc)) {
              toDrop.push(p.id);
              continue;
            }
            taken.add(p.loc);
            relocations.push(p);
          }
          if (toDrop.length > 0) {
            await tx.edge.deleteMany({ where: { id: { in: toDrop } } });
          }

          // Two-phase write to avoid a transient (loc, memoryId) unique
          // violation: a relocating edge's FINAL loc can equal ANOTHER
          // relocating edge's CURRENT loc (possible with authored/stale locs),
          // so a single pass could hit a still-occupied slot mid-flight. Park
          // every relocating edge on a unique temporary loc first — its id,
          // which is globally unique (edge loc has no format CHECK, only the
          // (loc, memoryId) unique index) — freeing all the old locs, then
          // write the final endpoints + loc. The final set is mutually unique
          // and collision-free (deduped above), so the second pass can't
          // collide. Sequential, not Promise.all: ordered writes on one
          // transactional connection, and the two passes must not interleave.
          for (const r of relocations) {
            await tx.edge.update({ where: { id: r.id }, data: { loc: r.id }, select: { id: true } });
          }
          for (const r of relocations) {
            await tx.edge.update({
              where: { id: r.id },
              data: { sourceId: r.sourceId, targetId: r.targetId, memoryId: r.memoryId, loc: r.loc },
              select: { id: true },
            });
          }
        }

        if (deleteSource) {
          // Hard delete (matches deleteNode). Edges re-pointed above survive;
          // any the caller chose not to transfer cascade away with the row.
          // #449 — so do the PendingEdges aimed at the source: its id is gone.
          pendingSourceMemories = await deletePendingEdgesTargetingNodes(tx, [source.id]);
          await hardDeleteThreadsOfTargets(tx, [source.id]); // #1606 — deleted threads go with it
          await tx.node.delete({ where: { id: source.id } });
        }
      }));
      await reconcilePendingEdgeCounts(ctx.db, pendingSourceMemories).catch((err) =>
        console.warn('[mergeNodes] pending-edge count reconcile failed (the periodic repair will fix it):', err),
      );

      // Re-fetch the merged target with edges, decrypt for the response +
      // side effects. Only decrypt when a session key is actually available:
      // an edge-only/plaintext-field merge on an encrypted memory legitimately
      // runs without one, in which case the encrypted fields stay ciphertext
      // in the response (the same posture as any keyless read) rather than
      // throwing.
      const finalNode = (await ctx.db.node.findUnique({
        where: { id: target.id },
        include: {
          outgoingEdges: { include: { target: true } },
          incomingEdges: { include: { source: true } },
        },
      }))!;
      if (tgtEnc.isEncrypted && sessionKeyCache.getByMemoryId(tgtEnc.id)) {
        decryptNodeFields(finalNode, tgtEnc);
      }

      // Announce the write (git mirror rides the event — so a later
      // repo-wins sync can't revert the merge). Encrypted memories keep the
      // direct mirror below, using whatever plaintext this request could
      // decrypt. The shared checkout defers a keyless encrypted export
      // without touching the existing mirror (#1273).
      void publishNodeWritten({
        nodeId: finalNode.id,
        memoryId: target.memoryId,
        ownerRepo: (finalNode as { ownerRepo?: string | null }).ownerRepo ?? '',
        clientId: ctx.clientId,
      });
      if (tgtEnc.isEncrypted) {
        writeNodeToGit(
          {
            id: finalNode.id,
            loc: finalNode.loc,
            name: finalNode.name,
            nodeType: finalNode.nodeType,
            alias: finalNode.alias,
            description: finalNode.description,
            abstract: finalNode.abstract,
            abstractOriginHash: finalNode.abstractOriginHash,
            contentHash: finalNode.contentHash,
            content: finalNode.content,
            tags: deserializeTags(finalNode.tags) as string[],
            seq: finalNode.seq,
            data: finalNode.data,
            properties: finalNode.properties,
            // #1218 — the mirror carries the governed signals.
            role: finalNode.role ?? null,
            isRunnable: finalNode.isRunnable ?? null,
            isPlaceholder: finalNode.isPlaceholder,
            outgoingEdges: finalNode.outgoingEdges ?? [],
            mirrorRevSeq: finalNode.revSeq,
          },
          (finalNode as { ownerRepo?: string | null }).ownerRepo ?? '',
          ctx.clientId,
          target.memoryId,
        ).catch((err) => {
          console.error('[mergeNodes] git write error:', err);
        });
      }

      // Re-embed when the embedded text (content/abstract) changed.
      if (contentChanged || abstractChanged) {
        void enqueueNodeEmbedding(ctx.db, {
          nodeId: finalNode.id,
          memoryId: target.memoryId,
          plaintext: { content: finalNode.content, abstract: finalNode.abstract },
        });
      }

      // #1061 — one write, on the SURVIVING target. The source node may have
      // been HARD deleted above (`deleteSource`), so an event naming it would
      // fail the `nodeId` FK on insert; the merge is recorded where its result
      // lives.
      recordNodeWrite(
        ctx.db,
        { id: finalNode.id, loc: finalNode.loc, memoryId: target.memoryId },
        ctx,
      );
      // The merge also READ the source's content and folded it into the
      // returned target — the same read `cloneNode` records for its source, and
      // across memories when they differ (PR #1062 review — Copilot). Recorded
      // only when the source SURVIVES: on `deleteSource` the row is gone and
      // the FK has nothing to point at.
      if (!deleteSource) {
        recordNodeRead(
          ctx.db,
          { id: source.id, loc: source.loc, memoryId: source.memoryId },
          ctx,
        );
      }

      return finalNode;
    },

    // #454 — the old bulk path hard-deleted history and recreated rows outside
    // the canonical encryption, embedding, revision, and role gates. Keep the
    // public field for clients that still know it, but refuse every authorized
    // invocation before a transaction or other write side effect.
    replaceSubtree: async (
      _: unknown,
      { memoryId }: { memoryId: string },
      ctx: Context,
    ) => {
      // Preserve the ordinary write-access and concealed-memory boundary.
      const { id } = await resolveMemoryRefForWrite(ctx, memoryId);
      await requireMemoryWriteAccess(ctx, id);
      throw new GraphQLError(
        'replaceSubtree is unavailable because it cannot preserve node write invariants.',
        { extensions: { code: 'REPLACE_SUBTREE_RETIRED' } },
      );
    },

    restoreNodeRevision: async (
      _: unknown,
      { revisionId, truncate = false }: { revisionId: string; truncate?: boolean },
      ctx: Context,
    ) => {
      const notFound = () => new GraphQLError('Node revision not found', {
        extensions: { code: 'NOT_FOUND', revisionId },
      });
      // Resolve only provenance before the read gate: a moved node's snapshot
      // still belongs to its source memory, including when that memory is private.
      const revisionRef = await ctx.db.nodeRevision.findUnique({
        where: { id: revisionId }, select: { nodeId: true, memoryId: true },
      });
      if (!revisionRef) throw notFound();
      const node = await ctx.db.node.findUnique({ where: { id: revisionRef.nodeId } });
      if (!node || node.deletedAt) throw notFound();
      const accessible = await getAccessibleMemoryIds(ctx);
      const canRead = (memoryId: string) => accessible === null || accessible.includes(memoryId);
      if (!canRead(node.memoryId) || !canRead(revisionRef.memoryId ?? node.memoryId)) throw notFound();
      await requireMemoryWriteAccess(ctx, node.memoryId);
      const revision = await ctx.db.nodeRevision.findUnique({ where: { id: revisionId } });
      if (!revision) throw notFound();
      const sourceMemoryId = revision.memoryId ?? node.memoryId;
      if (!canRead(sourceMemoryId)) throw notFound();
      const [sourceEncryption, destinationEncryption] = await Promise.all([
        getMemoryEncryptionInfo(ctx.db, sourceMemoryId),
        getMemoryEncryptionInfo(ctx.db, node.memoryId),
      ]);
      const requireKey = (memoryId: string) => {
        const key = sessionKeyCache.getByMemoryId(memoryId);
        if (!key) throw new GraphQLError(
          `SESSION_EXPIRED: memory ${memoryId} is encrypted but no active session key is available.`,
          { extensions: { code: 'SESSION_EXPIRED', memoryId } },
        );
        return key;
      };
      if (sourceEncryption.isEncrypted) requireKey(sourceMemoryId);
      if (destinationEncryption.isEncrypted) requireKey(node.memoryId);
      const logicalFields = (snapshot: typeof revision, sourceId: string) => {
        const fields = restorableNodeFields(snapshot);
        const crypto = {
          content: fields.content as string | null,
          abstract: fields.abstract as string | null,
          ...('data' in fields ? { data: fields.data } : {}),
        };
        if (sourceEncryption.isEncrypted) {
          decryptNodeFieldsWithKey(crypto, requireKey(sourceId));
        }
        Object.assign(fields, crypto);
        return fields;
      };
      // Spec 049 S4: a Channel's address (and any subtree overlapping it) is its own operation's.
      // 'restore', not 'write' (@copilot, PR #1198). The verb reaches the user twice —
      // "the only thing that may restore here", and the REMEDY, which must not offer
      // an authoring door for an operation neither door performs.
      await assertLocWritable(ctx.db, node.memoryId, node.loc, 'restore');

      // #620 — the restored field set (legacy-sentinel-aware), shared by the
      // pre-restore snapshot's `changes` diff and the write-back.
      const restoreFields = logicalFields(revision, sourceMemoryId);

      // #1201 (@copilot, PR #1203 round 3) — a bypass my OWN fix created.
      // Making `role` restorable turned a restore into a way to write a
      // governed role with no door: restore a revision captured while the node
      // was a review, or one carrying `isRunnable: true`, and the node becomes
      // governed through a generic mutation.
      //
      // Gated on the RESULTING state like every other write, and it refuses in
      // both directions on purpose: a revision cannot make an ordinary node
      // governed, and a governed node's history cannot be restored through the
      // generic surface either. The kind doors have no restore variant, so a
      // governed node is currently not restorable at all — the same
      // no-door-for-this-operation shape as deletes, tracked with them in
      // #1204 rather than answered here.
      // #1606 — a comment's history is not restorable through the generic
      // surface, and no revision may turn a node into one (cor:dmo:110:04).
      assertNotCommentWrite(node.nodeType, (restoreFields as { nodeType?: string | null }).nodeType, 'restore');
      assertBootPromptWriteAllowed(node, restoreFields as { nodeType?: string | null; role?: string | null }, 'restore');
      assertGovernedWrite(
        node,
        mergedGovernedState(node, {
          role: (restoreFields as { role?: string | null }).role,
          isRunnable: (restoreFields as { isRunnable?: boolean | null }).isRunnable,
        }),
        'update',
        undefined,
        { context: 'restore' },
      );
      // #1331 — a restore replays history, role included: the writer level of the
      // role before AND after (fast refusal; the authoritative check is under the lock below).
      {
        const restoredRole = (restoreFields as { role?: string | null }).role;
        const restored = mergedGovernedState(node, {
          role: restoredRole, isRunnable: (restoreFields as { isRunnable?: boolean | null }).isRunnable,
        });
        const refusal = await roleWritersRefusal(ctx.db, ctx, node.memoryId, {
          priorRole: node.role, nextRole: restoredRole === undefined ? node.role : restoredRole,
          priorRunnable: node.isRunnable, nextRunnable: restored.isRunnable,
        });
        if (refusal) throw refusal;
      }

      // #725/#737 — a restored snapshot must satisfy the CURRENT schema. Validate
      // the resulting objectType/properties (restored value, else the node's
      // current). Blocks restoring to a now-invalid state after a schema change.
      await enforceNodeSchemaOnWrite(
        ctx.db,
        node.memoryId,
        'objectType' in restoreFields ? (restoreFields.objectType as string | null) : node.objectType,
        'properties' in restoreFields ? restoreFields.properties : node.properties,
      );

      // Restore (+ optional truncate) in one transaction (#617) so the portal
      // never sequences restore + N deletes and can't half-apply on a crash.
      const { restored, restoredPlaintext, destinationEncrypted } = await ctx.db.$transaction(async (tx) => {
        // Spec 049 S4: lock-then-gate — the check above is the fast refusal.
        await lockLocForWrite(tx, node.memoryId, node.loc);
        // Row lock + drift reconciled as its own revision before the restore's
        // snapshot, as on every other revisioned writer (@copilot, PR #1339).
        // A missing row returns null here and falls to the conflict below.
        await ensureCurrentNodeRevisionInTransaction(tx, node.id, { expectedMemoryId: node.memoryId });
        const current = await tx.node.findUnique({ where: { id: node.id } });
        if (
          !current ||
          current.deletedAt ||
          current.memoryId !== node.memoryId ||
          current.loc !== node.loc
        ) {
          const movedMemory = !!current && current.memoryId !== node.memoryId;
          throw new GraphQLError(
            `Node revision target moved or was deleted while this restore waited — re-read it and retry.`,
            {
              extensions: {
                code: 'NODE_WRITE_CONFLICT',
                revisionId,
                memoryId: node.memoryId,
                movedMemory,
                ...(!movedMemory && current ? { currentLoc: current.loc } : {}),
              },
            },
          );
        }

        // The converter takes the node lock before the revision lock as well.
        // Re-read after both locks so a concurrent conversion or prune cannot
        // leave us restoring an obsolete ciphertext/plaintext view.
        await tx.$queryRaw`SELECT id FROM node_revisions WHERE id = ${revisionId} FOR UPDATE`;
        const selected = await tx.nodeRevision.findUnique({ where: { id: revisionId } });
        if (!selected || !canRead(selected.memoryId ?? current.memoryId)) throw notFound();
        const selectedSourceId = selected.memoryId ?? current.memoryId;
        const selectedSource = await tx.memory.findUniqueOrThrow({
          where: { id: selectedSourceId }, select: { isEncrypted: true },
        });
        const selectedDestination = await tx.memory.findUniqueOrThrow({
          where: { id: current.memoryId }, select: { isEncrypted: true },
        });
        if (selectedSource.isEncrypted) requireKey(selectedSourceId);
        if (selectedDestination.isEncrypted) requireKey(current.memoryId);
        const logicalRestoreFields = restorableNodeFields(selected);
        const plaintextFields = {
          content: logicalRestoreFields.content as string | null,
          abstract: logicalRestoreFields.abstract as string | null,
          ...('data' in logicalRestoreFields ? { data: logicalRestoreFields.data } : {}),
        };
        if (selectedSource.isEncrypted) {
          decryptNodeFieldsWithKey(plaintextFields, requireKey(selectedSourceId));
        }
        Object.assign(logicalRestoreFields, plaintextFields);
        const logicalCurrent = { ...current };
        if (selectedDestination.isEncrypted) {
          decryptNodeFieldsWithKey(logicalCurrent, requireKey(current.memoryId));
        }
        const changes = diffNodeChanges(logicalCurrent, logicalRestoreFields);
        const restoreFields = { ...logicalRestoreFields };
        if (selectedDestination.isEncrypted) {
          Object.assign(restoreFields, encryptNodeFieldsWithKey(plaintextFields, requireKey(current.memoryId)));
        }

        // Repeat every state-dependent gate against the authoritative row.
        // The preflight checks above are useful fast refusals, but they cannot
        // protect a restore that waited behind a concurrent writer.
        assertNotCommentWrite(current.nodeType, (restoreFields as { nodeType?: string | null }).nodeType, 'restore');
        assertBootPromptWriteAllowed(current, restoreFields as { nodeType?: string | null; role?: string | null }, 'restore');
        assertGovernedWrite(
          current,
          mergedGovernedState(current, {
            role: (restoreFields as { role?: string | null }).role,
            isRunnable: (restoreFields as { isRunnable?: boolean | null }).isRunnable,
          }),
          'update',
          undefined,
          { context: 'restore' },
        );
        // #1331 — the writer level of the role before AND after, on the locked row.
        {
          const restoredRole = (restoreFields as { role?: string | null }).role;
          await assertRoleWritersForWrite(tx, ctx, current.memoryId, {
            priorRole: current.role, nextRole: restoredRole === undefined ? current.role : restoredRole,
            priorRunnable: current.isRunnable,
            nextRunnable: mergedGovernedState(current, {
              role: restoredRole, isRunnable: (restoreFields as { isRunnable?: boolean | null }).isRunnable,
            }).isRunnable,
          });
        }
        // #1330 — deliberately NO strict-sub-role check (`assertRoleDeclaredForWrite`):
        // a restore copies history, it does not author a role. A revision whose
        // role a since-tightened rulebook no longer declares still restores
        // (Holger, 2026-09-27). Exempt from that rule only: the governed and
        // schema gates around it still apply. Git sync, which IS authoring, is
        // checked.
        await enforceNodeSchemaOnWrite(
          tx,
          current.memoryId,
          'objectType' in restoreFields ? (restoreFields.objectType as string | null) : current.objectType,
          'properties' in restoreFields ? restoreFields.properties : current.properties,
        );
        if (truncate) {
          // #617 truncate: collapse the history so the selected revision becomes
          // the new baseline. Delete every snapshot NEWER than the selected one
          // (createdAt strictly greater — EXCLUSIVE of the selected row, which
          // is kept). #1323: the restore is still an authoring write, so advance
          // the live monotonic counter inside this transaction even though the
          // caller explicitly asked not to retain a pre-restore undo snapshot.
          // Missing NodeRevision rows are valid after pruning/truncation; the
          // live revision must never move backwards or stay unchanged.
          await tx.node.update({
            where: { id: current.id },
            data: { revSeq: { increment: 1 } },
          });
          await tx.nodeRevision.deleteMany({
            where: { nodeId: current.id, createdAt: { gt: selected.createdAt } },
          });
        } else {
          // Non-destructive default: snapshot current state before restoring so
          // the restore itself is undoable. Spec 031 — `abstract` must be
          // captured here too; without it, a round-trip restore (then restoring
          // this snapshot) silently drops abstract. Spec 032 — same for
          // `abstractOriginHash`. #620 — `changes` records which fields the
          // restore is about to rewrite; restorableNodeFields is the single
          // home for the restored field set + the legacy sentinel, shared
          // with the write-back below.
          await createNodeRevision(tx, {
            id: generateId(),
            ...buildNodeRevisionSnapshot(current, editorFromAuth(ctx), {
              changes,
            }),
          });
        }

        // Restore the node to the revision's state. Spec 031 — `abstract`
        // is part of the restored state; without it, restoring a revision
        // that had a non-null abstract leaves the node's current abstract
        // unchanged (and vice versa). Spec 032 — `abstractOriginHash`
        // applied verbatim per plan D4 (no recomputation on restore;
        // legacy null hashes short-circuit the staleness check via the
        // NOT NULL guard in hadron_get_node). #620 — the full curated
        // subset restores verbatim too, but ONLY for snapshots that
        // captured it: a NULL nodeType marks a legacy pre-#620 row, and
        // restoring its uncaptured fields would wipe the live values to
        // NULL rather than "restore" anything.
        const writeData: Record<string, unknown> = { ...restoreFields };
        // #1326 — a legacy pre-#620 snapshot captured no authorship, so it has
        // no stamp to restore. If the restore rewrites authored fields, keeping
        // the live stamp would attribute that older state to the current
        // author: clear it to unknown. An unchanged restore keeps its verified
        // stamp — the same rule as the agent-snapshot restore (#1397).
        if (!('authorshipKind' in restoreFields)
          && authoredContentChanged(changes)) {
          Object.assign(writeData, clearNodeAuthorship());
        }
        if ('properties' in writeData) {
          writeData.properties = jsonOrDbNull(writeData.properties as never);
        }
        if ('data' in writeData) {
          writeData.data = jsonOrDbNull(writeData.data as never);
        }
        writeData.revisionContentHash = revisionStateHashRefreshMarker();
        // #1468 — restoring a pre-mark revision must not unmark a minted spec.
        const restoredMarker = restoreFields as { tags?: string[]; role?: string | null };
        await assertNoMintedSpecUnmark(tx, current.memoryId, [{
          id: current.id,
          tags: 'tags' in restoredMarker ? restoredMarker.tags : undefined,
          role: 'role' in restoredMarker ? restoredMarker.role : undefined,
        }], 'restore a revision of');
        const restored = await tx.node.update({
          where: { id: current.id },
          data: writeData,
          include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
        });
        // #2040 — the restored text is re-checked: an old revision can hold a tag
        // that would now make a cycle. A refusal rolls the restore back.
        {
          const text = plaintextFields.content as string | null;
          const readable = text?.includes('{{>') ? await getAccessibleMemoryIds(ctx) : null;
          const stored = { storedPlaintext: (logicalCurrent.content as string | null) ?? null };
          const tags = await assertIncludesWritable(tx, current, text, readable, undefined, stored);
          await syncDerivedIncludesEdges(tx, current, tags, readable, stored);
        }
        return { restored, restoredPlaintext: plaintextFields, destinationEncrypted: selectedDestination.isEncrypted };
      });
      // 033 — re-embed the restored content (revision snapshots are plaintext on
      // non-encrypted memories; ciphertext snapshots are handled by embedNode's
      // #206 permanent-fail path).
      void enqueueNodeEmbedding(ctx.db, {
        nodeId: restored.id,
        memoryId: restored.memoryId,
        plaintext: { content: restoredPlaintext.content, abstract: restoredPlaintext.abstract },
      });
      // #1061 — a restore rewrites the live node, so it is a write like any
      // other. The revision-pruning mutations below (delete/label/clear
      // history) are NOT: they touch snapshot rows, never the node.
      recordNodeWrite(ctx.db, toUsageNodeRef(restored), ctx);
      return destinationEncrypted
        ? decryptNodeFieldsWithKey({ ...restored }, requireKey(restored.memoryId))
        : restored;
    },

    // #617 — delete a single snapshot. Write-gated on the node's CURRENT memory
    // (as restoreNodeRevision) — the memory you own the live node in, even if the
    // snapshot was captured in another memory before a move.
    deleteNodeRevision: async (_: unknown, { revisionId }: { revisionId: string }, ctx: Context) => {
      const revision = await ctx.db.nodeRevision.findUnique({ where: { id: revisionId } });
      if (!revision) {
        throw new GraphQLError('Node revision not found', {
          extensions: { code: 'NOT_FOUND', revisionId },
        });
      }
      const node = await ctx.db.node.findUniqueOrThrow({ where: { id: revision.nodeId } });
      await requireMemoryWriteAccess(ctx, node.memoryId);
      // #1641 §3.2 — a decision's history is its audit trail. Unlocked: no
      // write ever turns an existing node into a decision or back.
      if (isDecisionFamilyRole(node.role)) throw decisionContainedError("Deleting a decision's revision", [node.loc]);
      // No protected-loc gate: a revision row is history, not the address.
      await ctx.db.nodeRevision.delete({ where: { id: revisionId } });
      return true;
    },

    // #620 — set or clear the user-facing label on a revision snapshot
    // (NodeRevision.revLabel). Write-gated on the node's CURRENT memory (as
    // deleteNodeRevision) — but unlike the Boolean-returning prune mutations,
    // this one RETURNS the full snapshot, so it must also enforce the read
    // gates of the nodeRevision query: the per-snapshot memory gate (#602 —
    // a moved node's history can hold snapshots captured in a memory the
    // caller can't read) and the soft-deleted-node collapse (#618). Every
    // miss is the same NOT_FOUND (no existence disclosure).
    updateNodeRevision: async (
      _: unknown,
      { revisionId, revLabel }: { revisionId: string; revLabel?: string | null },
      ctx: Context,
    ) => {
      const notFound = () =>
        new GraphQLError('Node revision not found', {
          extensions: { code: 'NOT_FOUND', revisionId },
        });
      const revision = await ctx.db.nodeRevision.findUnique({ where: { id: revisionId } });
      if (!revision) throw notFound();
      const node = await ctx.db.node.findUnique({
        where: { id: revision.nodeId },
        select: { memoryId: true, deletedAt: true },
      });
      if (!node || node.deletedAt) throw notFound();
      const accessible = await getAccessibleMemoryIds(ctx);
      const canRead = (memId: string) => accessible === null || accessible.includes(memId);
      if (!canRead(node.memoryId) || !canRead(revision.memoryId ?? node.memoryId)) {
        throw notFound();
      }
      await requireMemoryWriteAccess(ctx, node.memoryId);
      // Omit = preserve (the repo-wide partial-update contract); null = clear.
      if (revLabel === undefined) {
        return (await decryptReadableRevisions(ctx.db, [revision], node.memoryId))[0]!;
      }
      if (revLabel != null && revLabel.length > REV_LABEL_MAX_LEN) {
        throw new GraphQLError(
          `revLabel exceeds the ${REV_LABEL_MAX_LEN}-character cap.`,
          { extensions: { code: 'BAD_USER_INPUT', max: REV_LABEL_MAX_LEN } },
        );
      }
      const updated = await ctx.db.nodeRevision.update({
        where: { id: revisionId },
        data: { revLabel },
      });
      return (await decryptReadableRevisions(ctx.db, [updated], node.memoryId))[0]!;
    },

    // #617 — delete ALL snapshots for a node, returning the count deleted. Write-
    // gated on the node's current memory. nodeRef is a PK or fully-qualified URN.
    clearNodeHistory: async (_: unknown, { nodeRef }: { nodeRef: string }, ctx: Context) => {
      let nodeId: string;
      try {
        // includeDeleted: a soft-deleted node still owns residual history an
        // owner may want to purge — clearing it is a cleanup op, so it stays
        // reachable on tombstones (parity with deleteNodeRevision's by-id path;
        // contrast the READ surfaces, which hide tombstoned history). PR #618.
        ({ id: nodeId } = await resolveNodeRefForCaller(ctx, nodeRef, undefined, { includeDeleted: true }));
      } catch (e) {
        if (e instanceof NodeNotFoundError) {
          throw new GraphQLError('Node not found', {
            extensions: { code: 'NODE_NOT_FOUND', nodeRef },
          });
        }
        throw e;
      }
      const node = await ctx.db.node.findUniqueOrThrow({
        where: { id: nodeId },
        select: { memoryId: true, role: true, loc: true },
      });
      await requireMemoryWriteAccess(ctx, node.memoryId);
      // #1641 §3.2 — a decision's history is its audit trail (as deleteNodeRevision).
      if (isDecisionFamilyRole(node.role)) throw decisionContainedError("Clearing a decision's history", [node.loc]);
      const { count } = await ctx.db.nodeRevision.deleteMany({ where: { nodeId } });
      return count;
    },

    // #749 — export a node's markdown as a NEW Google Doc via the drive
    // capability tool. Reads the node (same gate as nodeExport: accessible
    // memory, decrypted content, content falls back to `# name`), then runs
    // the owner-only `create-doc` operation on the caller's drive
    // connection (create-doc has no ConnectionGrant scope mapping, so App /
    // headless callers are denied fail-closed — decision 2, #749). The doc
    // is always NEW: the tool's drive.file scope cannot touch existing
    // files, and no update surface exists.
    exportNodeToGoogleDoc: async (
      _: unknown,
      {
        nodeRef,
        connectionRef,
        folderId,
        title,
      }: { nodeRef: string; connectionRef: string; folderId?: string | null; title?: string | null },
      ctx: Context,
    ) => {
      let nodeId: string;
      try {
        ({ id: nodeId } = await resolveNodeRefForCaller(ctx, nodeRef));
      } catch (e) {
        if (e instanceof NodeNotFoundError) {
          throw new GraphQLError('Node not found', { extensions: { code: 'NODE_NOT_FOUND', nodeRef } });
        }
        throw e;
      }
      const node = await ctx.db.node.findUnique({ where: { id: nodeId } });
      if (!node || node.deletedAt) {
        throw new GraphQLError('Node not found', { extensions: { code: 'NODE_NOT_FOUND', nodeRef } });
      }
      const accessibleIds = await getAccessibleMemoryIds(ctx);
      if (accessibleIds !== null && !accessibleIds.includes(node.memoryId)) {
        // Denied and not-found are indistinguishable on purpose (nodeById parity).
        throw new GraphQLError('Node not found', { extensions: { code: 'NODE_NOT_FOUND', nodeRef } });
      }
      // A locked encrypted node must be a typed refusal, never a silent
      // ciphertext export — decryptNodesBatch's leave-as-ciphertext posture
      // would ship the encrypted blob to Google as "markdown" (PR-751 Codex
      // review). Require the key, then decryptNodeFields does the work.
      const memEncInfo = await getMemoryEncryptionInfo(ctx.db, node.memoryId);
      if (memEncInfo.isEncrypted && !sessionKeyCache.getByMemoryId(node.memoryId)) {
        throw new GraphQLError(
          `SESSION_EXPIRED: memory ${node.memoryId} is encrypted but no active session key is available.`,
          { extensions: { code: 'SESSION_EXPIRED', memoryId: node.memoryId } },
        );
      }
      decryptNodeFields(node, memEncInfo);
      // A Google Doc is a read for a human: includes resolve with the exporter's
      // access (cor:dmo:150:03); variables stay as stored, as before.
      const exported = await resolveNodeContent(ctx, node, { mode: 'includes' });
      const markdown = exported && exported.trim().length > 0 ? exported : `# ${node.name}`;

      const { file } = await runOwnedEmailOperation<{ file: ToolDriveFile }>(ctx, connectionRef, 'create-doc', {
        title: title?.trim() || node.name,
        markdown,
        folderId: folderId ?? undefined,
      });
      return mapToolDriveFile(file);
    },

};

/**
 * THE node writer. The response of a write to a memory whose writer may not read it (an App's install memory;
 * a user-owned Agent's system memory written by a platform admin, #2206) is held to the memory's READ
 * audience here, at the one writer every door shares (createNode/updateNode by address or by
 * memoryId, the kind doors, merges, importers, MCP), not per door: a door-by-door wrap let an
 * alternate address return the content a write-only manager cannot read (Andi on #2064).
 * An ordinary memory costs one indexed select.
 */
export async function writeNodeCore(...args: Parameters<typeof writeNodeCoreRaw>): ReturnType<typeof writeNodeCoreRaw> {
  const written = await writeNodeCoreRaw(...args);
  const ctx = args[1];
  if (!written || typeof written !== 'object' || typeof (written as { memoryId?: unknown }).memoryId !== 'string') return written;
  return concealWriteBeyondRead(ctx, written as { memoryId: string }) as unknown as typeof written;
}
