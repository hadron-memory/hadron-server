// nodeMutations — extracted from resolvers.ts Mutation (split step 2). No behavior change.
import { generateId } from '../../../lib/id.js';
// Spec 049 S4 — the protected-loc gate on the in-place update paths and the bulk skip.
import {
  assertLocWritable,
  protectedLocsIn,
  protectedLocCovers,
  protectedDeletionFilter,
  type ProtectedLoc,
  type ProtectedSource,
} from '../../../lib/protectedLoc.js';
import { computeContentHash } from '../../../lib/contentHash.js';
import {
  buildNodeRevisionSnapshot,
  createNodeRevision,
  editorFromAuth,
  diffNodeChanges,
  restorableNodeFields,
  jsonOrDbNull,
  REV_LABEL_MAX_LEN,
} from '../../../lib/nodeRevisionSnapshot.js';
import {
  buildReplacer,
  replaceInTags,
  SearchReplaceInvalidPatternError,
  type Replacer,
} from '../../../lib/searchReplace.js';
import { enqueueNodeEmbedding } from '../../../services/embedding/enqueue.js';
import { canReadMemory } from '../../../mcp/access-control.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { validateNodeAgainstSchema, NodeSchemaViolation } from '../../../lib/validateNodeAgainstSchema.js';
import { enforceNodeSchemaOnWrite, normalizeObjectType } from '../../../lib/enforceNodeSchema.js';
import type { MemorySchema } from '../../../lib/memorySchema.js';
import {
  encryptNodeFieldsWithKey,
  decryptNodeFields,
  getMemoryEncryptionInfo,
} from '../../../lib/nodeCrypto.js';
import { parseUrnInput, splitNodeUrn } from '../../../lib/urn.js';
import { splitWholeNodeUrn } from '../../../lib/splitNodeUrnTolerant.js';
import {
  validateLoc,
  InvalidLocError,
} from '../../../lib/validateLoc.js';
import { deriveEdgeLoc } from '../../../lib/edgeLoc.js';
import {
  moveNodeSubtree,
  SubtreeMoveCollisionError,
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
import { resolveNodeRef } from '../../../lib/entityRef/nodeRef.js';
import { resolveEdgeRef } from '../../../lib/entityRef/edgeRef.js';
import { GraphQLError } from 'graphql';
import { convertHtmlToMarkdown, convertPdfToMarkdown } from '../../../lib/pdfClient.js';
import { type InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import { Prisma } from '../../../generated/prisma/index.js';
import {
  deserializeTags,
  serializeTags,
} from '../../../integrations/db/provider.js';
import { writeNodeToGit } from '../../../integrations/github/writeNodeToGit.js';
import { publishNodeWritten } from '../../../lib/events/nodeWritten.js';
import {
  recordNodeRead,
  recordNodeUsage,
  recordNodeWrite,
  toUsageNodeRef,
  toUsageNodeRefs,
} from '../../../lib/usageRecorder.js';
import { nextSiblingSeq } from '../../../lib/nodeSeq.js';
import {
  ancestorLocs,
  lockAncestorsForCreate,
  lockLocForWrite,
  lockAncestorsForCreateMany,
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
  requireRole,
  runOwnedEmailOperation,
  throwOnInvalidCondition,
  throwOnReservedExtractionSpec,
  requireMemoryWriteAccess,
  isMemoryReadableCached,
  type NodeInput,
  type NodeEdgeInput,
  type CreateNodeInput,
  type UpdateNodeInput,
  type SearchReplaceInNodesInput,
  type EdgeInput,
  type MergeNodesInput,
} from './resolvers.helpers.js';
import { type ToolDriveFile } from '../../../lib/emailClient.js';

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

export async function writeNodeCore(
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
    targetNodeId?: string;
    guardRevSeq?: number;
    /**
     * #1180 — the predicate source this caller OWNS. Passed ONLY by
     * `authorProtectedNode` (`'declared'`), the door a memory-specific
     * authoring tool writes through. Every other caller omits it and is
     * refused at any protected address — the safe default
     * `a-gate-a-caller-can-omit` asks for.
     *
     * NOT a universal bypass: `'declared'` exempts a `Memory.protectedLocs`
     * entry and leaves CHANNEL protection fully in force, so this door cannot
     * write under `chats:team` and forge authorship.
     */
    owns?: ProtectedSource;
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
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, input.memoryId);
      input.memoryId = resolvedMemoryId;
      await requireMemoryWriteAccess(ctx, input.memoryId);
      // Spec 049 S4 / #1180: a protected address is written by its owning
      // operation only. `authorProtectedNode` is that operation for a
      // Memory.protectedLocs entry and passes the bypass; everyone else omits it.
      await assertLocWritable(ctx.db, input.memoryId, input.loc, 'write', opts?.owns);

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
          throw new GraphQLError(err.message, {
            extensions: { code: err.name, length: err.length, max: err.max },
          });
        }
        const normalized: string | null =
          input.abstract.trim() === '' ? null : input.abstract;
        input = { ...input, abstract: normalized };
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

      // Mode gate (spec 039 Phase 0 D1). Create: reject if a **live** node
      // already lives at (loc, memoryId) — the portal's create form (and any
      // other creating caller) surfaces a NodeLocConflictError instead of
      // silently overwriting. Soft-deleted nodes at the target loc are
      // treated as not-existing for collision purposes — the create
      // resurrects them (the UPDATE branch below clears `deletedAt`/
      // `deletedBy` when this resurrection path runs). Update: the target
      // must exist — updateNode never creates; a concurrent delete between
      // this gate and the write surfaces as Prisma P2025, mapped to
      // NODE_NOT_FOUND at the write below. Upsert (internal callers only):
      // legacy either-way behavior.
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
            const { id: targetNodeId } = await resolveNodeRef(ctx.db, e.targetId, input.memoryId);
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
            // Deliberately NOT the MCP `canReadMemory` that createEdge calls:
            // its personal-memory branch tests `memory.userId` only and never
            // consults MemoryShare, so a `writer` share-grantee adding an inline
            // edge into that same shared memory would be refused NODE_NOT_FOUND
            // (PR #844 review, Codex P2). createEdge has the same gap
            // pre-existing — tracked separately rather than widened here.
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
      // #725 — enforce the memory's property schema through the shared seam
      // BEFORE any write side effect (incl. the revision snapshot below), on the
      // RESULTING node state (input overrides, else the existing value).
      await enforceNodeSchemaOnWrite(
        ctx.db,
        input.memoryId,
        input.objectType !== undefined ? input.objectType : existing?.objectType,
        input.properties !== undefined ? input.properties : existing?.properties,
      );

      // #989 — the guarded revNo claim, the FIRST node write of a guarded
      // update: an atomic increment conditioned on revSeq still holding the
      // caller's anchor. Count 0 ⇒ a revisioned write (any surface) landed
      // since the caller read the node ⇒ typed refusal, before any
      // side effect. The claimed number is handed to createNodeRevision so
      // it skips its own (unconditional) bump, and the main update below is
      // then guarded on the claimed value — so an interleaver in the
      // claim-to-write window is caught there.
      let claimedRevNo: number | undefined;
      if (mode === 'update' && opts?.guardRevSeq !== undefined && existing) {
        const claimed = await ctx.db.node.updateMany({
          where: { id: existing.id, revSeq: opts.guardRevSeq },
          data: { revSeq: { increment: 1 } },
        });
        if (claimed.count === 0) {
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
        claimedRevNo = opts.guardRevSeq + 1;
      }

      // The fields this write will change, in the shape diffNodeChanges wants.
      // Hoisted out of the snapshot block below because the create/upsert path
      // now snapshots inside its own transaction and needs the same value.
      // Tags need the serialized form for a faithful compare; other input
      // fields map 1:1 onto node columns.
      const suppliedForDiff: Record<string, unknown> = { ...input };
      if (input.tags !== undefined) {
        suppliedForDiff.tags = serializeTags(input.tags ?? []);
      }

      // Snapshot the PRE-edit state (#620: shared builder — editedBy holds
      // the user PK, the #88 `reason` rationale lands in revLabel, and
      // `changes` records which fields this update is about to modify).
      //
      // #1183 — UPDATE MODES ONLY. This runs before the transaction and off the
      // stale `existing` probe, which is safe enough here because an update's
      // target is required to exist and its own gate already refused a missing
      // one. It is NOT safe for create/upsert, where `existing` may be null
      // while a row is committed moments later: the overwrite would then be
      // recorded nowhere. That path therefore takes its own snapshot inside its
      // transaction, from the row it actually observes under the loc lock —
      // the #977 pattern, which fixed this exact shape for the MCP surface and
      // was never applied here.
      //
      // The remaining pre-transaction snapshot on the update path has its own
      // smaller defect (a failed write can leave an orphan revision, since the
      // snapshot does not commit with it). Out of scope here and filed
      // separately rather than restructured inside a concurrency fix.
      if (existing && mode === 'update') {
        await createNodeRevision(ctx.db, {
          ...buildNodeRevisionSnapshot(existing, editorFromAuth(ctx), {
            revLabel: input.reason,
            changes: diffNodeChanges(existing, suppliedForDiff),
          }),
          // #989: a guarded update already claimed its number atomically.
          ...(claimedRevNo !== undefined ? { revNo: claimedRevNo } : {}),
        });
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
      const {
        abstractOriginHash: _stripCallerSupplied,
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

      /**
       * On the update-by-PK path, re-read the target UNDER THE ADDRESS LOCK and
       * refuse if it no longer lives where this write was authorized.
       *
       * The gap (@codex P1, PR #1198; pre-existing since PR-460 and reproduced
       * before it was fixed). `updateNode` resolves `id` → (memoryId, loc)
       * OUTSIDE any transaction, and everything protecting the write is checked
       * against THAT address — `requireMemoryWriteAccess`, the protected-loc
       * gate, the memory's property schema — while the UPDATE itself keys on
       * the immutable PK. A `moveNode` committing in between leaves the two
       * pointing at different memories, and the write lands on the row at its
       * NEW address: authorized against the memory the caller could write,
       * applied in one they may not, under a schema that was never consulted.
       * Measured, not argued — the write succeeded and the row was in the
       * destination memory.
       *
       * Ordering note (#1187): this adds a READ, never a lock, so it introduces
       * no new edge into the advisory-lock key space the four helpers share and
       * cannot be half of a cycle. READ COMMITTED is what makes it work — each
       * statement sees the latest commit, so a move that landed before this
       * statement is visible to it.
       *
       * NODE_WRITE_CONFLICT rather than a new code: the target moved since it
       * was read, which is exactly what that code already says, and re-reading
       * and retrying is exactly the remedy. The write is refused rather than
       * re-authorized at the new address — the caller asked to edit the node at
       * the address they named, and silently following it somewhere else is the
       * behaviour this refuses.
       */
      async function assertTargetStillAtAuthorizedAddress(
        tx: Pick<Prisma.TransactionClient, 'node'>,
      ): Promise<void> {
        if (!opts?.targetNodeId) return;
        const current = await tx.node.findUnique({
          where: { id: opts.targetNodeId },
          select: { memoryId: true, loc: true },
        });
        // A vanished row is left to the write below, which maps Prisma's P2025
        // to the typed NODE_NOT_FOUND — refusing here would swap one typed
        // error for another and change updateNode's contract for a deleted
        // target, which is not this fix's business.
        if (!current) return;
        if (current.memoryId === input.memoryId && current.loc === input.loc) return;
        throw new GraphQLError(
          `Node "${opts.targetNodeId}" moved since it was read — it is now at ` +
            `"${current.loc}" in another memory, and this write was authorized against ` +
            `"${input.loc}". Re-read and retry.`,
          {
            extensions: {
              code: 'NODE_WRITE_CONFLICT',
              loc: input.loc,
              memoryId: input.memoryId,
              currentLoc: current.loc,
            },
          },
        );
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
        if (mode === 'update' && claimedRevNo !== undefined) {
          // #989 — the write half of the compare-and-swap: guarded on the
          // revSeq value the claim above just installed, so a revisioned
          // write interleaving between claim and write is caught here
          // (its own claim bumps revSeq past ours). This is what makes a
          // caller-level precondition hold against writers that do NOT share
          // the caller's lock (#1050 retired the first such caller,
          // updateTeamRole's expectedNames; the primitive is unchanged) — the
          // generic node surfaces write this row unguarded, so an
          // application-level compare alone has a TOCTOU window between it
          // and this write. updateMany because a unique `where` can't carry
          // the extra predicate; the row is then re-read for the include
          // shape.
          const guardWhere: Prisma.NodeWhereInput = opts?.targetNodeId
            ? { id: opts.targetNodeId, revSeq: claimedRevNo }
            : { loc: input.loc, memoryId: input.memoryId, revSeq: claimedRevNo };
          // Spec 049 S4: the write holds the address lock, and the
          // protected-loc gate runs under it — the early check above is the
          // fast typed refusal, this is the authoritative one (a Channel can
          // be created, or the node moved under one, in between; Copilot on
          // PR #1165).
          const guarded = await ctx.db.$transaction(async (tx) => {
            await lockLocForWrite(tx, input.memoryId, input.loc, {
              owns: opts?.owns,
            });
            await assertTargetStillAtAuthorizedAddress(tx);
            return tx.node.updateMany({
              where: guardWhere,
              data: updatePayload as Prisma.NodeUncheckedUpdateManyInput,
            });
          });
          if (guarded.count === 0) {
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
          node = await ctx.db.node.findUniqueOrThrow({
            where: opts?.targetNodeId
              ? { id: opts.targetNodeId }
              : { loc_memoryId: { loc: input.loc, memoryId: input.memoryId } },
            include,
          });
        } else if (mode === 'update') {
          // Same lock-then-gate discipline as the guarded branch above.
          node = await ctx.db.$transaction(async (tx) => {
            await lockLocForWrite(tx, input.memoryId, input.loc, {
              owns: opts?.owns,
            });
            await assertTargetStillAtAuthorizedAddress(tx);
            return tx.node.update({
              where: opts?.targetNodeId
                ? { id: opts.targetNodeId }
                : { loc_memoryId: { loc: input.loc, memoryId: input.memoryId } },
              data: updatePayload,
              include,
            });
          });
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
              id,
              tags,
              createdBy,
              ...hashPayload,
              ...(seqForCreate != null ? { seq: seqForCreate } : {}),
            } as Prisma.NodeUncheckedCreateInput,
            update: updatePayload,
            include,
          } satisfies Prisma.NodeUpsertArgs;
          // A root-level loc takes no ancestor lock, but still goes through
          // the helper: it is also the spec 049 S4 protected-loc gate, run
          // under the transaction — a root-level Channel address was
          // otherwise overwritable here (Copilot on PR #1165, round 2).
          node = await ctx.db.$transaction(async (tx) => {
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
            // Taking it ONLY at root level is deliberate, and the reason is
            // deadlock rather than economy. Advisory keys are shared across
            // lockAncestorsForCreate / lockLocForWrite / lockNodeForDelete /
            // lockSourceForMove, and this repo has no single global acquisition
            // order — merge takes target-then-source, move takes
            // destination-ancestors-then-source, bulk sorts length-first. Any
            // NEW multi-lock edge added here has to be consistent with all of
            // them at once. An earlier revision of this fix took the loc lock
            // unconditionally, which made a create hold `a` and wait for `a:b`;
            // @copilot found it deadlocking against merge, and the obvious
            // repair (sorting merge's endpoints) promptly inverted merge
            // against MOVE. Restricting the lock to the root-level case means
            // create's lock SET is unchanged for every nested loc and is a
            // SINGLE lock at root level — and one lock cannot be half of a
            // cycle. No new edge, so nothing to order against.
            //
            // Establishing one global order across create/merge/move/bulk is
            // worth doing; it is not this PR, and it is filed.
            if (ancestorLocs(input.loc).length === 0) {
              await lockLocForWrite(tx, input.memoryId, input.loc, {
                owns: opts?.owns,
              });
            }

            // #1183 — THE AUTHORITATIVE read. The `existing` probe far above is
            // taken before this lock, so under concurrency both callers see no
            // row: the mode gate passes twice, and because the write below is
            // an UPSERT the loser does not collide on (loc, memory_id) — it
            // takes the update branch and overwrites the winner. Measured
            // before this fix: 40 concurrent pairs, 40 double-successes, zero
            // refusals. Spec 039 Phase 0 D1's create-only guarantee held only
            // sequentially, which is why a sequential test pinned it happily.
            const authoritative = await tx.node.findUnique({
              where: { loc_memoryId: { loc: input.loc, memoryId: input.memoryId } },
            });

            if (mode === 'create' && authoritative && !authoritative.deletedAt) {
              const err = new NodeLocConflictError(input.loc, input.memoryId);
              throw new GraphQLError(err.message, {
                extensions: { code: err.name, loc: err.loc, memoryId: err.memoryId },
              });
            }

            // #1183 — snapshot the row this write will actually overwrite, from
            // the authoritative read and inside this transaction, so it commits
            // with the write (a failed write cannot leave an orphan revision)
            // and so a row that appeared after the stale probe is still
            // recorded. After the gate above, the only row a `create` can still
            // overwrite is a SOFT-DELETED one being resurrected — and a
            // tombstone's content is real content, which losing silently was
            // the #976 defect. `upsert` mode reaches here for a live row too,
            // deliberately: that mode is either-way by contract.
            if (authoritative) {
              await createNodeRevision(tx, {
                ...buildNodeRevisionSnapshot(authoritative, editorFromAuth(ctx), {
                  revLabel: input.reason,
                  changes: diffNodeChanges(authoritative, suppliedForDiff),
                }),
              });
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
            return tx.node.upsert({
              ...upsertArgs,
              update: {
                ...upsertArgs.update,
                // create-ONLY, matching the `isResurrect` it corrects. Widening
                // it to `upsert` would let an importer revive a soft-deleted
                // node merely by writing to its loc — a behaviour change this
                // fix has no business making (@copilot, PR #1184 round 4).
                ...(mode === 'create' && authoritative?.deletedAt
                  ? { deletedAt: null, deletedBy: null }
                  : {}),
              } as Prisma.NodeUncheckedUpdateInput,
            });
          });
        }
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2025'
        ) {
          // Lost the race with a concurrent delete (or move, on the
          // loc-keyed path) between the mode gate and the write.
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

      let finalNode = node;
      if (resolvedEdges !== null) {
        // Replace the source's outgoing edges with the resolved set.
        // skipDuplicates: true defends against a duplicate (loc, memoryId)
        // inside the input array itself (e.g. two edges that derive the
        // same loc). Spec 037: each edge carries memoryId (= source's
        // memory) and a loc (author-supplied or derived).
        await ctx.db.edge.deleteMany({ where: { sourceId: node.id } });
        await ctx.db.pendingEdge.deleteMany({ where: { sourceId: node.id } });
        if (resolvedEdges.length > 0) {
          await ctx.db.edge.createMany({
            data: resolvedEdges.map((e) => ({
              memoryId: node.memoryId,
              sourceId: node.id,
              targetId: e.targetNodeId,
              loc: e.loc ?? deriveEdgeLoc(node.loc, e.name, e.targetLoc),
              name: e.name,
              description: e.description,
              isRunnable: e.isRunnable,
              createdBy,
            })),
            skipDuplicates: true,
          });
        }
        finalNode = (await ctx.db.node.findUnique({
          where: { id: node.id },
          include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
        }))!;
        if (memEncInfo.isEncrypted) {
          decryptNodeFields(finalNode, memEncInfo);
        }
      }

      // Event pivot: the write core announces the fact; subscribers (git
      // mirror, embedding wake, whatever comes next) act on it. Encrypted
      // memories keep the direct in-closure git write below — the subscriber
      // can't decrypt without this request's session key, and finalNode here
      // is already plaintext.
      void publishNodeWritten({
        nodeId: finalNode.id,
        memoryId: input.memoryId,
        ownerRepo: input.ownerRepo ?? '',
        clientId: ctx.clientId,
      });
      if (memEncInfo.isEncrypted) {
        writeNodeToGit({
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
          outgoingEdges: finalNode.outgoingEdges ?? [],
        }, input.ownerRepo ?? '', ctx.clientId, input.memoryId).catch((err) => {
          console.error('[writeNodeCore] git write error:', err);
        });
      }

      // 033 — (re-)embed on write. finalNode is decrypted (plaintext) here, so
      // the prompt-drain embeds correctly even on encrypted memories (FR-027).
      void enqueueNodeEmbedding(ctx.db, {
        nodeId: finalNode.id,
        memoryId: input.memoryId,
        plaintext: { content: finalNode.content, abstract: finalNode.abstract },
      });

      // #1061 — the one place a `write` event is recorded for every caller that
      // reaches the shared write core: GraphQL createNode/updateNode, the
      // portal and CLI behind them, importNode, the run-tools, asset reference
      // nodes and the session handoff. Placed after the write has landed, so a
      // refused or conflicted write records nothing.
      recordNodeWrite(
        ctx.db,
        { id: finalNode.id, loc: finalNode.loc, memoryId: input.memoryId },
        ctx,
      );

      return finalNode;
}

/**
 * #564 — resolve a node by ref (PK or fully-qualified URN) to its full live
 * row, or throw a typed NODE_NOT_FOUND. Shared by moveNode / cloneNode; a
 * genuine miss and a soft-deleted row map to the same not-found (no existence
 * oracle), while a malformed URN propagates as UrnNotQualifiedError (spec 022).
 */
async function resolveExistingNode(ctx: Context, ref: string) {
  let id: string;
  try {
    ({ id } = await resolveNodeRef(ctx.db, ref));
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
    ({ id: destMemoryId } = await resolveMemoryRef(ctx.db, memoryUrn));
  } else {
    ({ id: destMemoryId } = await resolveMemoryRef(ctx.db, targetMemoryRef as string));
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
 * SHARED, not copied (#1192). `updateNode` and `updateProtectedNode` differ in
 * exactly one argument — the `owns` bypass — and everything else about an
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
 * @param opts.owns  the protected-loc predicate source this caller OWNS.
 *               Passed ONLY by `updateProtectedNode` (`'declared'`); omitted by
 *               the generic surface, which is then refused at any protected
 *               address. NOT a universal bypass — Channel protection stays in
 *               force, so this cannot rewrite a chat message.
 */
async function updateNodeCore(
  input: UpdateNodeInput,
  ctx: Context,
  op: string,
  opts?: { owns?: ProtectedSource },
) {
  const { id, memoryId, loc, ...fields } = input;
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
      ({ id: targetNodeId } = await resolveNodeRef(ctx.db, id));
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
      select: { memoryId: true, loc: true },
    });
    if (!row) {
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
    owns: opts?.owns,
  });
}

export const nodeMutations = {
    // Create a single node (spec 039 Phase 0 D1/D4). Create-only: a live
    // node at (memoryId, loc) rejects with NodeLocConflictError; a
    // soft-deleted one is resurrected. `input.id` is a forced create-PK
    // (importer/sync), never a selector.
    createNode: async (_: unknown, { input }: { input: CreateNodeInput }, ctx: Context) =>
      writeNodeCore(input, ctx, 'create'),

    // #1180 — the authoring door for a PROTECTED loc. Identical in effect to
    // createNode (or an upsert when asked); the only difference is that it
    // carries `ownedByOperation`, so it writes where the generic surface is
    // refused.
    //
    // PURE ROUTING, deliberately (Holger, 2026-09-17): it validates nothing and
    // knows nothing about spec / review / task nodes. The authoring RULES stay
    // in the tool that owns them — `hadron spec` and `hadron coding` are closed-
    // list exceptions on the audience ground, so porting their logic here is
    // exactly what we are NOT doing. This resolver exists to be a different
    // door, nothing more.
    //
    // What that buys, precisely: the ACCIDENTAL generic write is refused and
    // told which tool to use. It is not a security boundary — a determined
    // caller can reach this mutation too. What keeps an AGENT away from it is
    // that it is not exposed as an MCP tool (the same reason
    // createTeamChatMessage is not), so `hadron_create_node` is the only node
    // door on that surface and it refuses.
    authorProtectedNode: async (
      _: unknown,
      { input, upsert }: { input: CreateNodeInput; upsert?: boolean | null },
      ctx: Context,
    ) => writeNodeCore(input, ctx, upsert ? 'upsert' : 'create', { owns: 'declared' }),

    // Update an existing node (spec 039 Phase 0 D2–D4). Target = `id` (PK or
    // fully-qualified node URN) XOR (`memoryId` + `loc`); never creates,
    // never moves. All content fields preserve-on-omit.
    updateNode: async (_: unknown, { input }: { input: UpdateNodeInput }, ctx: Context) =>
      updateNodeCore(input, ctx, 'updateNode'),

    // #1192 — the authoring door for EDITING a protected loc, and the
    // update-side counterpart of authorProtectedNode above. Same posture:
    // pure routing, validates nothing, deliberately not an MCP tool.
    //
    // It exists because the gate is not create-only. `writeNodeCore`'s update
    // branches pass `owns` into `lockLocForWrite` exactly as the create branch
    // does, so an ordinary updateNode at a declared loc is refused with
    // LOC_PROTECTED and — before this — had nowhere to route. A declared
    // corpus would have been append-only, and `hadron spec supersede` would
    // have been refused halfway through its own two-step.
    //
    // TWO doors rather than one, mirroring createNode/updateNode. The
    // alternative — `authorProtectedNode` taking an update input too — keeps
    // one mutation name but needs a runtime XOR between two nullable inputs
    // that the type system could have decided instead.
    //
    // And `upsert: true` is not a substitute, though NOT for the reason #1192
    // gives. The issue says an edit routed through the create door "blanks
    // every field the caller did not resend". MEASURED, it does not: Prisma
    // leaves an undefined column untouched on the upsert's update branch
    // exactly as it does on an update. What actually differs:
    //
    //   - an upsert CREATES at an empty loc (measured) where an update refuses
    //     NODE_NOT_FOUND — so a mistyped citation becomes a real node at a
    //     protected address instead of a refusal;
    //   - `id` is a forced create-PK on CreateNodeInput and THE SELECTOR (PK
    //     or node URN) on UpdateNodeInput, so edit-by-URN has no route at all;
    //   - `name` is required on create, omit-to-preserve on update.
    //
    // The conclusion survives the correction; the stated reason did not, and
    // it is restated here so the next reader inherits the measured version.
    updateProtectedNode: async (_: unknown, { input }: { input: UpdateNodeInput }, ctx: Context) =>
      updateNodeCore(input, ctx, 'updateProtectedNode', { owns: 'declared' }),

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
        ({ id: resolvedId } = await resolveNodeRef(ctx.db, nodeRef));
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
      await requireMemoryWriteAccess(ctx, meta.memoryId);
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

      // Delegate the write to the core in update mode. Addressing by the
      // existing (memoryId, loc); omitted fields (name included) preserve.
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
    updateNodeProperties: async (
      _: unknown,
      { nodeRef, properties, reason }: { nodeRef: string; properties: unknown; reason?: string | null },
      ctx: Context,
    ) => {
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
        ({ id: resolvedId } = await resolveNodeRef(ctx.db, nodeRef));
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
      await requireMemoryWriteAccess(ctx, meta.memoryId);
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
      // The lock is held by this short tx; writeNodeCore runs on the POOLED
      // connection (not this tx) on purpose — it fires a `void enqueueNodeEmbedding
      // (ctx.db)` that would break against a closing tx client — so the tx only
      // does the lock + the fresh read + delegate, and the lock releases when the
      // closure (incl. the awaited writeNodeCore) returns.
      return ctx.db.$transaction(async (lockTx) => {
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

        // Shallow merge: the patch wins on key collision; absent keys preserved.
        // A node with no properties yet takes the patch as-is.
        const existing = fresh.properties;
        const merged =
          existing != null && typeof existing === 'object' && !Array.isArray(existing)
            ? { ...(existing as Record<string, unknown>), ...(properties as Record<string, unknown>) }
            : (properties as Record<string, unknown>);

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
          ctx,
          'update',
          { targetNodeId: meta.id },
        );
      });
    },

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
        authedMemories.add(memoryId);
      };

      if (hasMemoryIds) {
        for (const ref of memoryIds!) {
          const { id: memId } = await resolveMemoryRef(ctx.db, ref);
          await ensureAuthed(memId);
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
          const { id } = await resolveNodeRef(ctx.db, ref);
          if (nodeById.has(id)) continue;
          const row = await ctx.db.node.findUnique({ where: { id } });
          if (!row || row.deletedAt) continue;
          await ensureAuthed(row.memoryId);
          nodeById.set(id, row);
        }
      }

      const rawNodes = [...nodeById.values()];

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
        fieldResults: Array<{ field: string; matches: number }>;
        total: number;
        abstractChanged: boolean;
        contentChanged: boolean;
        ownerRepo: string;
      }
      const plans: Plan[] = [];

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

      for (const raw of rawNodes) {
        if (await isProtectedLoc(raw.memoryId, raw.loc)) continue;
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
              const err = new NodeAbstractTooLongError(r.value.length);
              throw new GraphQLError(`${err.message} (node ${pt.loc} / ${pt.id})`, {
                extensions: {
                  code: err.name,
                  length: err.length,
                  max: err.max,
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
            fieldResults,
            total,
            abstractChanged,
            contentChanged,
            ownerRepo: (raw as { ownerRepo?: string | null }).ownerRepo ?? '',
          });
        }
      }

      const buildResult = () => ({
        nodesScanned: rawNodes.length,
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
      await ctx.db.$transaction(async (tx) => {
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

          await tx.node.update({ where: { id: raw.id }, data });
        }
      });

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
                outgoingEdges: fresh.outgoingEdges ?? [],
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
        ({ id: resolvedId } = await resolveNodeRef(ctx.db, nodeRef, undefined, {
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
      await requireMemoryWriteAccess(ctx, node.memoryId);
      // Spec 049 S4: a Channel's address (and any subtree overlapping it) is its own operation's.
      await assertLocWritable(ctx.db, node.memoryId, node.loc, 'write');

      // Idempotent no-op: a non-recursive soft re-delete of an already-tombstoned
      // node preserves its original deletedAt/deletedBy (matches the
      // hadron_delete_node MCP tool) instead of re-stamping it.
      if (!recursive && !hard && node.deletedAt !== null) return true;

      const deletedBy = ctx.userId ?? ctx.appId ?? ctx.clientId ?? null;
      const now = new Date();
      const memoryId = node.memoryId;
      // The node at its loc PLUS every descendant, on ':' path boundaries (so
      // 'auth' won't catch 'authoring') — the same subtree shape as
      // extractParentNode / the bulk node ops.
      const subtree: Prisma.NodeWhereInput = {
        memoryId,
        OR: [{ loc: node.loc }, { loc: { startsWith: `${node.loc}:` } }],
      };
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
          await lockNodeForDelete(tx, memoryId, node.loc);
          const useSubtree = !!recursive;
          if (!useSubtree) {
            // Non-recursive: refuse rather than silently orphan a subtree under a
            // now-missing prefix. Hard counts the union (a tombstoned descendant
            // still cascades via FK); soft counts only live descendants.
            const descendantCount = await tx.node.count({
              where: {
                memoryId,
                loc: { startsWith: `${node.loc}:` },
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

          if (hard) {
            // Resolve the affected ids for the cross-memory edge gate +
            // PendingEdge cleanup — the safeguards hadron_delete_node applies.
            const affectedIds = useSubtree
              ? (await tx.node.findMany({ where: subtree, select: { id: true } })).map((n) => n.id)
              : [resolvedId];

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
            }
            // PendingEdge.targetId is intentionally NOT a foreign key, so the FK
            // cascade misses pending rows aimed at the deleted nodes — clean them
            // up explicitly (PR-189 pattern).
            await tx.pendingEdge.deleteMany({ where: { targetId: { in: affectedIds } } });

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
        });
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
      requireRole(ctx, 'CONTRIBUTOR');
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
      let resolvedSourceId: string;
      let resolvedTargetId: string;
      try {
        ({ id: resolvedSourceId } = await resolveNodeRef(ctx.db, sourceRef));
      } catch (e) {
        if (e instanceof NodeNotFoundError)
          throw new GraphQLError(`Source node not found: "${sourceRef}"`, { extensions: { code: 'NODE_NOT_FOUND' } });
        throw e;
      }
      try {
        ({ id: resolvedTargetId } = await resolveNodeRef(ctx.db, targetRef));
      } catch (e) {
        if (e instanceof NodeNotFoundError)
          throw new GraphQLError(`Target node not found: "${targetRef}"`, { extensions: { code: 'NODE_NOT_FOUND' } });
        throw e;
      }
      // Spec 037: an edge carries a memory-unique `loc` (its identity + URN
      // suffix), with `memoryId` denormalized from the source node. Fetch
      // both endpoints to compose/derive the loc + gate access.
      const [src, tgt] = await Promise.all([
        ctx.db.node.findUnique({ where: { id: resolvedSourceId }, select: { loc: true, memoryId: true } }),
        ctx.db.node.findUnique({ where: { id: resolvedTargetId }, select: { loc: true, memoryId: true } }),
      ]);
      if (!src) throw new GraphQLError(`Source node not found: "${sourceRef}"`, { extensions: { code: 'NODE_NOT_FOUND' } });
      if (!tgt) throw new GraphQLError(`Target node not found: "${targetRef}"`, { extensions: { code: 'NODE_NOT_FOUND' } });

      // PR-348 review (Gemini, critical): the global CONTRIBUTOR role gate
      // above is not memory-scoped. Mirror the MCP addEdge posture (and the
      // sibling upsertNode/moveNode mutations): require write access to the
      // SOURCE memory, and at least read on the TARGET. Without this any
      // CONTRIBUTOR could write an edge into a memory they can't touch. The
      // target denial returns the same NODE_NOT_FOUND wording as a genuine
      // miss so it can't be used as a cross-memory existence oracle.
      await requireMemoryWriteAccess(ctx, src.memoryId);
      if (!(await canReadMemory(ctx.db, ctx, tgt.memoryId))) {
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
      const edge = await ctx.db.edge.create({
        data: {
          id: generateId(),
          memoryId: src.memoryId,
          sourceId: resolvedSourceId,
          targetId: resolvedTargetId,
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
      requireRole(ctx, 'CONTRIBUTOR');
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
      // PR-348 parity (Codex #554): the global CONTRIBUTOR gate above is not
      // memory-scoped. With edgeRef now accepting a cross-memory URN, a
      // contributor could otherwise update an edge in a memory they can't
      // write. Gate on write access to the edge's (denormalized) memory —
      // matching createEdge / deleteNode / moveNode.
      const edgeMem = await ctx.db.edge.findUnique({
        where: { id: resolvedEdgeId },
        select: { memoryId: true },
      });
      if (!edgeMem) {
        throw new GraphQLError(`Edge not found: "${edgeRef}"`, {
          extensions: { code: 'EDGE_NOT_FOUND', ref: edgeRef },
        });
      }
      await requireMemoryWriteAccess(ctx, edgeMem.memoryId);
      const updatedEdge = await ctx.db.edge.update({
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
      // #1061 — attributed to the source node, as createEdge is.
      recordNodeWrite(ctx.db, toUsageNodeRef(updatedEdge.source), ctx);
      return updatedEdge;
    },

    deleteEdge: async (
      _: unknown,
      { edgeRef }: { edgeRef: string },
      ctx: Context,
    ) => {
      requireRole(ctx, 'CONTRIBUTOR');
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
      // before deleting — the global CONTRIBUTOR role gate is not memory-scoped.
      // `source` rides along for the #1061 usage attribution below; it is read
      // here rather than after the delete, when the row is gone.
      const edgeMem = await ctx.db.edge.findUnique({
        where: { id: resolvedEdgeId },
        select: {
          memoryId: true,
          source: { select: { id: true, loc: true, memoryId: true } },
        },
      });
      if (!edgeMem) {
        throw new GraphQLError(`Edge not found: "${edgeRef}"`, {
          extensions: { code: 'EDGE_NOT_FOUND', ref: edgeRef },
        });
      }
      await requireMemoryWriteAccess(ctx, edgeMem.memoryId);
      await ctx.db.edge.delete({ where: { id: resolvedEdgeId } });
      // #1061 — attributed to the source node, as createEdge is.
      recordNodeWrite(ctx.db, toUsageNodeRef(edgeMem.source), ctx);
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
      { sourceRef, targetUrn, targetMemoryRef }: { sourceRef: string; targetUrn?: string | null; targetMemoryRef?: string | null },
      ctx: Context,
    ) => {
      const source = await resolveExistingNode(ctx, sourceRef);
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
        const moved = await ctx.db.$transaction(
          async (tx) => {
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
            });
            relocated = result.moved;
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
        void mirrorNodeMoveToGit(ctx.db, {
          srcMemoryId: source.memoryId,
          destMemoryId,
          moved: relocated,
          clientId: ctx.clientId ?? null,
        });
        return moved;
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
      const source = await resolveExistingNode(ctx, sourceRef);
      // Cloning READS the source's content — require read access to the source
      // memory, or the URN-widened input becomes a cross-tenant exfiltration
      // path (review:entity-ref-args #3). Denial reads as not-found (no oracle).
      if (!(await canReadMemory(ctx.db, ctx, source.memoryId))) {
        throw new GraphQLError(`Node not found: "${sourceRef}"`, {
          extensions: { code: 'NODE_NOT_FOUND', ref: sourceRef },
        });
      }
      const { destMemoryId, destLoc } = await resolveRelocationTarget(
        ctx, source, targetUrn, targetMemoryRef,
      );

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
        objectType: srcPlain.objectType ?? undefined, // #725 — carry the collection through a clone
        isRunnable: srcPlain.isRunnable,
        description: srcPlain.description ?? undefined,
        abstract: srcPlain.abstract ?? undefined,
        content: srcPlain.content ?? undefined,
        data: (srcPlain.data as Record<string, unknown> | null) ?? undefined,
        tags: deserializeTags(srcPlain.tags),
        properties: (srcPlain.properties as Record<string, unknown> | null) ?? undefined,
        seq: srcPlain.seq ?? undefined,
        edges,
      };
      // #1061 — a clone is both: the source's content was returned to this
      // caller (a read of the SOURCE memory, which may differ from the
      // destination's) and writeNodeCore records the write of the new node.
      recordNodeRead(ctx.db, toUsageNodeRef(source), ctx);
      return writeNodeCore(input, ctx, 'create');
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
        ({ id: sourceId } = await resolveNodeRef(ctx.db, rawSource));
      } catch (e) {
        if (e instanceof NodeNotFoundError)
          throw new GraphQLError(`Source node not found: "${rawSource}"`, {
            extensions: { code: 'NODE_NOT_FOUND', ref: rawSource },
          });
        throw e;
      }
      try {
        ({ id: targetId } = await resolveNodeRef(ctx.db, rawTarget));
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

      // Auth. The target is mutated → write access always. The source is
      // read to fold its fields; it's mutated only when we delete it or
      // re-point its edges (EDGES) → write access then, else read suffices.
      // A source read-denial returns the same NODE_NOT_FOUND wording as a
      // genuine miss so it can't be used as a cross-memory existence oracle
      // (mirrors createEdge's target-denial posture).
      await requireMemoryWriteAccess(ctx, target.memoryId);
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
            extensions: { code: e.name, length: e.length, max: e.max },
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
      await ctx.db.$transaction(async (tx) => {
        // Lock-then-gate on both endpoints (spec 049 S4).
        await lockLocForWrite(tx, target.memoryId, target.loc);
        if (deleteSource || fields.has('EDGES')) {
          await lockNodeForDelete(tx, source.memoryId, source.loc);
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
          await tx.node.update({ where: { id: target.id }, data: writeData });
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
            where: { OR: [{ sourceId: source.id }, { targetId: source.id }] },
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
          await tx.node.delete({ where: { id: source.id } });
        }
      });

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
      // decrypt (keyless merges mirrored ciphertext before the pivot too).
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
            outgoingEdges: finalNode.outgoingEdges ?? [],
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

    // Merge one memory (source) into another (target), returning the updated
    // target. Spec: cor:api:080. Source nodes whose loc collides with a target
    // node are folded into the counterpart via the shared mergeNodeFields
    // strategy (cor:api:070:01); the rest relocate with their loc unchanged.
    // Edges follow. v1 rejects encrypted memories and system/app classes
    // (mirrors cloneMemory's constraints).
    replaceSubtree: async (
      _: unknown,
      {
        ownerRepo,
        memoryId,
        nodes,
        edges,
      }: { ownerRepo: string; memoryId: string; nodes: NodeInput[]; edges: EdgeInput[] },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: memoryId may be ID, bare URN, or prefixed URN.
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);
      await requireMemoryWriteAccess(ctx, resolvedMemoryId);

      // #725 — this bulk path bypasses writeNodeCore, so enforce the memory's
      // property schema on each imported node here too (a git-synced typed node
      // must still satisfy its collection). Fetched once for the whole subtree.
      const replaceMemSchema = (
        await ctx.db.memory.findUnique({ where: { id: resolvedMemoryId }, select: { schema: true } })
      )?.schema as unknown as MemorySchema | null;

      // #1061 — collected inside the transaction because the PKs are minted
      // there (`input.id ?? generateId()`); recorded only after it commits, so
      // a rolled-back subtree records nothing.
      const written: { id: string; loc: string; memoryId: string }[] = [];

      await ctx.db.$transaction(async (tx: Prisma.TransactionClient) => {
        // #664/#752: this bulk create bypasses the locked writeNodeCore path, so
        // a concurrent non-recursive delete of an ancestor could miss the rows
        // inserted below. Lock the ancestor path of every incoming loc (deduped,
        // root→leaf) BEFORE the deleteMany's row locks — the delete path takes
        // its advisory lock before its row locks, so acquiring advisory-first
        // here too avoids a lock-order inversion (advisory→row vs row→advisory)
        // that could deadlock. READ COMMITTED (the tx default) is required so an
        // ancestor-delete's count sees these rows post-commit.
        await lockAncestorsForCreateMany(
          tx,
          resolvedMemoryId,
          nodes.map((n) => n.loc).filter((l): l is string => typeof l === 'string' && l !== ''),
        );

        // #1180 — this deletes by ownerRepo, NOT by the locs it was handed, so
        // the lock helper above (which only sees INCOMING locs) protects
        // nothing on the way out: a payload containing no protected loc would
        // still delete existing protected rows (@copilot, PR #1190). Route
        // through the shared filter rather than rebuilding the predicate.
        const replaceFilter = protectedDeletionFilter(
          await protectedLocsIn(tx, resolvedMemoryId),
        );
        if (!replaceFilter.wholeMemory) {
          await tx.node.deleteMany({
            where: {
              ownerRepo,
              memoryId: resolvedMemoryId,
              ...(replaceFilter.notClauses.length
                ? { NOT: { OR: replaceFilter.notClauses as Prisma.NodeWhereInput[] } }
                : {}),
            },
          });
        }

        for (const input of nodes) {
          // #725 — normalize an empty objectType to null, then enforce the schema.
          if (typeof input.objectType === 'string' && input.objectType.trim() === '') {
            input.objectType = null;
          }
          if (input.objectType != null) {
            try {
              validateNodeAgainstSchema(
                replaceMemSchema,
                input.objectType,
                (input.properties ?? null) as Record<string, unknown> | null,
              );
            } catch (e) {
              if (e instanceof NodeSchemaViolation) {
                throw new GraphQLError(e.message, { extensions: { code: 'BAD_USER_INPUT' } });
              }
              throw e;
            }
          }
          // Strip non-column NodeInput fields (edges/reason) that Prisma
          // would reject, and pull out id/tags so they're set explicitly
          // (spreading input.id would otherwise override the generated id).
          const {
            id: _id,
            edges: _edges,
            reason: _reason,
            tags: _tags,
            ...nodeFields
          } = input;
          const createdId = input.id ?? generateId();
          await tx.node.create({
            data: {
              id: createdId,
              ...nodeFields,
              tags: serializeTags(input.tags ?? []) as string[],
            } as Prisma.NodeUncheckedCreateInput,
          });
          if (typeof input.loc === 'string' && input.loc !== '') {
            written.push({ id: createdId, loc: input.loc, memoryId: resolvedMemoryId });
          }
        }

        for (const edge of edges) {
          const source = await tx.node.findUnique({ where: { loc_memoryId: { loc: edge.sourceLoc, memoryId: resolvedMemoryId } } });
          // loc is unique only within a memory — scope to resolvedMemoryId so a
          // loc collision in another memory can't be resolved as the target.
          const target = await tx.node.findUnique({ where: { loc_memoryId: { loc: edge.targetLoc, memoryId: resolvedMemoryId } } });
          if (source && target) {
            const edgeLoc = edge.loc ?? deriveEdgeLoc(source.loc, edge.name ?? null, target.loc);
            await tx.edge.upsert({
              where: { loc_memoryId: { loc: edgeLoc, memoryId: resolvedMemoryId } },
              create: {
                memoryId: resolvedMemoryId,
                sourceId: source.id,
                targetId: target.id,
                loc: edgeLoc,
                name: edge.name ?? null,
                description: edge.description ?? null,
                isRunnable: edge.isRunnable ?? null,
              },
              update: {},
            });
          }
        }
      });

      // #1061 — one write per node the subtree replace actually created. This
      // is the git-sync path, so a repo-backed memory's chart will be dominated
      // by sync writes rather than by hand edits. That is the honest reading:
      // the rows really were rewritten, and the alternative (silently exempting
      // the biggest writer on the platform) is what made the old series
      // untrustworthy in the first place.
      recordNodeUsage(ctx.db, 'write', written, ctx);

      return nodes.length;
    },

    restoreNodeRevision: async (
      _: unknown,
      { revisionId, truncate = false }: { revisionId: string; truncate?: boolean },
      ctx: Context,
    ) => {
      const revision = await ctx.db.nodeRevision.findUniqueOrThrow({ where: { id: revisionId } });
      const node = await ctx.db.node.findUniqueOrThrow({ where: { id: revision.nodeId } });
      await requireMemoryWriteAccess(ctx, node.memoryId);
      // Spec 049 S4: a Channel's address (and any subtree overlapping it) is its own operation's.
      await assertLocWritable(ctx.db, node.memoryId, node.loc, 'write');

      // #620 — the restored field set (legacy-sentinel-aware), shared by the
      // pre-restore snapshot's `changes` diff and the write-back.
      const restoreFields = restorableNodeFields(revision);

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
      const restored = await ctx.db.$transaction(async (tx) => {
        // Spec 049 S4: lock-then-gate — the check above is the fast refusal.
        await lockLocForWrite(tx, node.memoryId, node.loc);
        if (truncate) {
          // #617 truncate: collapse the history so the selected revision becomes
          // the new baseline. Delete every snapshot NEWER than the selected one
          // (createdAt strictly greater — EXCLUSIVE of the selected row, which
          // is kept), and skip the pre-restore snapshot. Ties on createdAt are
          // kept (never deletes the selected row); an over-keep is safe.
          await tx.nodeRevision.deleteMany({
            where: { nodeId: node.id, createdAt: { gt: revision.createdAt } },
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
            ...buildNodeRevisionSnapshot(node, editorFromAuth(ctx), {
              changes: diffNodeChanges(node, restoreFields),
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
        if ('properties' in writeData) {
          writeData.properties = jsonOrDbNull(writeData.properties as never);
        }
        if ('data' in writeData) {
          writeData.data = jsonOrDbNull(writeData.data as never);
        }
        return tx.node.update({
          where: { id: node.id },
          data: writeData,
          include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
        });
      });
      // 033 — re-embed the restored content (revision snapshots are plaintext on
      // non-encrypted memories; ciphertext snapshots are handled by embedNode's
      // #206 permanent-fail path).
      void enqueueNodeEmbedding(ctx.db, {
        nodeId: restored.id,
        memoryId: restored.memoryId,
        plaintext: { content: revision.content, abstract: revision.abstract },
      });
      // #1061 — a restore rewrites the live node, so it is a write like any
      // other. The revision-pruning mutations below (delete/label/clear
      // history) are NOT: they touch snapshot rows, never the node.
      recordNodeWrite(ctx.db, toUsageNodeRef(restored), ctx);
      return restored;
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
      if (revLabel === undefined) return revision;
      if (revLabel != null && revLabel.length > REV_LABEL_MAX_LEN) {
        throw new GraphQLError(
          `revLabel exceeds the ${REV_LABEL_MAX_LEN}-character cap.`,
          { extensions: { code: 'BAD_USER_INPUT', max: REV_LABEL_MAX_LEN } },
        );
      }
      return ctx.db.nodeRevision.update({
        where: { id: revisionId },
        data: { revLabel },
      });
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
        ({ id: nodeId } = await resolveNodeRef(ctx.db, nodeRef, undefined, { includeDeleted: true }));
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
        select: { memoryId: true },
      });
      await requireMemoryWriteAccess(ctx, node.memoryId);
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
        ({ id: nodeId } = await resolveNodeRef(ctx.db, nodeRef));
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
      const markdown = node.content && node.content.trim().length > 0 ? node.content : `# ${node.name}`;

      const { file } = await runOwnedEmailOperation<{ file: ToolDriveFile }>(ctx, connectionRef, 'create-doc', {
        title: title?.trim() || node.name,
        markdown,
        folderId: folderId ?? undefined,
      });
      return mapToolDriveFile(file);
    },

};

