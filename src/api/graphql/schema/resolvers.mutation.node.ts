// nodeMutations — extracted from resolvers.ts Mutation (split step 2). No behavior change.
import { generateId } from '../../../lib/id.js';
import { computeContentHash } from '../../../lib/contentHash.js';
import {
  buildReplacer,
  replaceInTags,
  SearchReplaceInvalidPatternError,
  type Replacer,
} from '../../../lib/searchReplace.js';
import { enqueueNodeEmbedding } from '../../../services/embedding/enqueue.js';
import { canReadMemory } from '../../../mcp/access-control.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import {
  encryptNodeFieldsWithKey,
  decryptNodeFields,
  getMemoryEncryptionInfo,
} from '../../../lib/nodeCrypto.js';
import { parseUrnInput } from '../../../lib/urn.js';
import {
  validateLoc,
  InvalidLocError,
} from '../../../lib/validateLoc.js';
import { deriveEdgeLoc } from '../../../lib/edgeLoc.js';
import {
  NodeLocConflictError,
  NodeNotFoundError,
  NodeAbstractTooLongError,
} from '../../../lib/entityRef/errors.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveNodeRef } from '../../../lib/entityRef/nodeRef.js';
import { GraphQLError } from 'graphql';
import { type InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import { Prisma } from '../../../generated/prisma/index.js';
import {
  deserializeTags,
  serializeTags,
} from '../../../integrations/db/provider.js';
import { writeNodeToGit } from '../../../integrations/github/writeNodeToGit.js';
import { nextSiblingSeq } from '../../../lib/nodeSeq.js';
import {
  mergeNodeFields,
  ALL_NODE_MERGE_FIELDS,
  type NodeMergeField,
} from '../../../lib/nodeMerge.js';
import {
  type Context,
  requireRole,
  throwOnInvalidCondition,
  throwOnReservedExtractionSpec,
  requireMemoryWriteAccess,
  type NodeInput,
  type CreateNodeInput,
  type UpdateNodeInput,
  type SearchReplaceInNodesInput,
  type EdgeInput,
  type MergeNodesInput,
} from './resolvers.helpers.js';

// ── Shared node-write core (spec 039 Phase 0 D1) ────────────────────────────
//
// The single canonical single-node write path — formerly the upsertNode
// resolver. Public callers reach it through createNode / updateNode below;
// server-internal callers (updateNodeData, and the spec-039 import worker)
// call it directly and may use mode 'upsert', which is no longer exposed on
// the GraphQL surface. Every single-write invariant lives here once:
// per-memory write auth, encryption (decrypt→mutate→re-encrypt), NodeVersion
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
  opts?: { targetNodeId?: string },
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

      // Snapshot current state before update (for version history). The
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
      // node, the version snapshot, or any edge changes. Per spec 007
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
              select: { loc: true },
            });
            resolvedEdges.push({
              targetNodeId,
              targetLoc: tgt?.loc ?? '',
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

      if (existing) {
        await ctx.db.nodeVersion.create({
          data: {
            nodeId: existing.id,
            loc: existing.loc,
            name: existing.name,
            alias: existing.alias,
            description: existing.description,
            abstract: existing.abstract,
            // Spec 032 — snapshot captures the hash so restoreNodeVersion
            // round-trips it.
            abstractOriginHash: existing.abstractOriginHash,
            content: existing.content,
            tags: existing.tags as string[],
            // #88: an explicit `reason` carries the edit rationale into history
            // (same column hadron_update_node's `reason` populates); fall back
            // to the caller identity when none is given.
            editedBy: input.reason ?? ctx.clientId ?? ctx.userId ?? null,
            createdBy: ctx.userId ?? ctx.clientId ?? null,
          },
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
      // `reason` is version-history metadata (consumed into editedBy above), not
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
        node =
          mode === 'update'
            ? await ctx.db.node.update({
                where: opts?.targetNodeId
                  ? { id: opts.targetNodeId }
                  : { loc_memoryId: { loc: input.loc, memoryId: input.memoryId } },
                data: updatePayload,
                include,
              })
            : await ctx.db.node.upsert({
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
              });
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

      // 033 — (re-)embed on write. finalNode is decrypted (plaintext) here, so
      // the prompt-drain embeds correctly even on encrypted memories (FR-027).
      void enqueueNodeEmbedding(ctx.db, {
        nodeId: finalNode.id,
        memoryId: input.memoryId,
        plaintext: { content: finalNode.content, abstract: finalNode.abstract },
      });

      return finalNode;
}

export const nodeMutations = {
    // Create a single node (spec 039 Phase 0 D1/D4). Create-only: a live
    // node at (memoryId, loc) rejects with NodeLocConflictError; a
    // soft-deleted one is resurrected. `input.id` is a forced create-PK
    // (importer/sync), never a selector.
    createNode: async (_: unknown, { input }: { input: CreateNodeInput }, ctx: Context) =>
      writeNodeCore(input, ctx, 'create'),

    // Update an existing node (spec 039 Phase 0 D2–D4). Target = `id` (PK or
    // fully-qualified node URN) XOR (`memoryId` + `loc`); never creates,
    // never moves. All content fields preserve-on-omit.
    updateNode: async (_: unknown, { input }: { input: UpdateNodeInput }, ctx: Context) => {
      const { id, memoryId, loc, ...fields } = input;
      const hasId = id != null && id !== '';
      if (hasId && (memoryId != null || loc != null)) {
        throw new GraphQLError(
          'updateNode: identify the node by `id` OR by `memoryId` + `loc`, not both. ' +
            '(`loc`/`memoryId` are selectors, not writable fields — moveNode relocates.)',
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }
      if (!hasId && (memoryId == null || loc == null)) {
        throw new GraphQLError(
          'updateNode: supply `id` (PK or fully-qualified node URN) or both `memoryId` and `loc`.',
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
      return writeNodeCore(
        { ...fields, memoryId: targetMemoryId, loc: targetLoc },
        ctx,
        'update',
        targetNodeId ? { targetNodeId } : undefined,
      );
    },

    // Shallow-merge a JSON patch into a node's `data` bag (issue #366).
    // The supplied object's top-level keys overwrite the node's existing
    // `data` (the patch wins on collision); untouched keys are preserved; a
    // node with no prior data takes the patch verbatim. Delegates the write to
    // the shared write core so every single-write invariant (write auth,
    // re-encryption, NodeVersion snapshot, git mirror) is applied once and
    // stays in sync — this resolver only resolves the node and computes the
    // merged plaintext.
    updateNodeData: async (
      _: unknown,
      { nodeId, data, reason }: { nodeId: string; data: unknown; reason?: string | null },
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
        ({ id: resolvedId } = await resolveNodeRef(ctx.db, nodeId));
      } catch (e) {
        if (e instanceof NodeNotFoundError) {
          throw new GraphQLError(`Node not found: "${nodeId}"`, {
            extensions: { code: 'NODE_NOT_FOUND', ref: nodeId },
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
        throw new GraphQLError(`Node not found: "${nodeId}"`, {
          extensions: { code: 'NODE_NOT_FOUND', ref: nodeId },
        });
      }
      await requireMemoryWriteAccess(ctx, meta.memoryId);

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
        throw new GraphQLError(`Node not found: "${nodeId}"`, {
          extensions: { code: 'NODE_NOT_FOUND', ref: nodeId },
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
          // #88: thread the edit rationale through to the version snapshot.
          ...(reason != null ? { reason } : {}),
        },
        ctx,
        'update',
      );
    },

    // Bulk literal/regex search-and-replace across selected nodes. Reuses the
    // single-write invariants from upsertNode (per-memory write auth,
    // decrypt→replace→re-encrypt, NodeVersion snapshot, abstractOriginHash
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

      for (const raw of rawNodes) {
        const memEnc = await getMemEnc(raw.memoryId);
        if (memEnc.isEncrypted && !sessionKeyCache.getByMemoryId(memEnc.id)) {
          throw new GraphQLError(
            `SESSION_EXPIRED: memory ${memEnc.id} is encrypted but no active session key is available.`,
            { extensions: { code: 'SESSION_EXPIRED', memoryId: memEnc.id } },
          );
        }
        // Decrypt a working copy to plaintext; `raw` stays ciphertext so the
        // NodeVersion snapshot below matches upsertNode's snapshot shape.
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

      // ── Write pass: version snapshot + node update, all-or-nothing ──
      await ctx.db.$transaction(async (tx) => {
        for (const p of plans) {
          const raw = p.raw;
          await tx.nodeVersion.create({
            data: {
              nodeId: raw.id,
              loc: raw.loc,
              name: raw.name,
              alias: raw.alias,
              description: raw.description,
              abstract: raw.abstract,
              abstractOriginHash: raw.abstractOriginHash,
              content: raw.content,
              tags: raw.tags as string[],
              // #88: carry the bulk-edit rationale into each node's history.
              editedBy: input.reason ?? ctx.clientId ?? ctx.userId ?? null,
              createdBy: ctx.userId ?? ctx.clientId ?? null,
            },
          });

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
      for (const p of plans) {
        // Re-embed when the embedded text (content/abstract) changed.
        if (p.contentChanged || p.abstractChanged) {
          void enqueueNodeEmbedding(ctx.db, {
            nodeId: p.raw.id,
            memoryId: p.raw.memoryId,
            plaintext: { content: p.plaintext.content, abstract: p.plaintext.abstract },
          });
        }
        // Mirror to git so a later (repo-wins) sync can't revert the edit.
        // Re-fetch with edges and decrypt to plaintext, as writeNodeToGit needs.
        void (async () => {
          const fresh = await ctx.db.node.findUnique({
            where: { id: p.raw.id },
            include: { outgoingEdges: { include: { target: true } } },
          });
          if (!fresh) return;
          if (p.isEncrypted) {
            const memEnc = await getMemEnc(fresh.memoryId);
            decryptNodeFields(fresh, memEnc);
          }
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

      return buildResult();
    },

    deleteNode: async (
      _: unknown,
      { loc: rawLoc, memoryId, hard }: { loc: string; memoryId: string; hard?: boolean | null },
      ctx: Context,
    ) => {
      const loc = parseUrnInput(rawLoc).value;
      // 007-entity-id-or-urn: memoryId may be ID, bare URN, or prefixed URN.
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);
      await requireMemoryWriteAccess(ctx, resolvedMemoryId);
      const where = { loc_memoryId: { loc, memoryId: resolvedMemoryId } };
      try {
        if (hard) {
          // Irreversible row delete; edges + NodeVersion cascade via FK.
          await ctx.db.node.delete({ where });
        } else {
          // #391: soft-delete by default, mirroring the hadron_delete_node MCP
          // tool — set deletedAt/deletedBy so the node drops out of every read
          // (nodes/nodeById/node/resolveUrn) but stays recoverable. Attribute to
          // the app for app-key callers (userId/clientId unset), then clientId.
          await ctx.db.node.update({
            where,
            data: { deletedAt: new Date(), deletedBy: ctx.userId ?? ctx.appId ?? ctx.clientId ?? null },
          });
        }
      } catch (e) {
        // Prisma P2025 = record not found — wrap so a missing node surfaces a
        // typed NODE_NOT_FOUND instead of leaking as INTERNAL_SERVER_ERROR
        // (mirrors moveNode; issue #100).
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
          throw new GraphQLError(`Node "${loc}" not found in this memory`, {
            extensions: { code: 'NODE_NOT_FOUND', loc, memoryId: resolvedMemoryId },
          });
        }
        throw e;
      }
      return true;
    },

    // ── Edge CRUD ──────────────────────────────────────────────────────

    createEdge: async (
      _: unknown,
      { sourceNodeId, targetNodeId, name, loc, description, isRunnable, condition, priority, data }: {
        sourceNodeId: string;
        targetNodeId: string;
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
        ({ id: resolvedSourceId } = await resolveNodeRef(ctx.db, sourceNodeId));
      } catch (e) {
        if (e instanceof NodeNotFoundError)
          throw new GraphQLError(`Source node not found: "${sourceNodeId}"`, { extensions: { code: 'NODE_NOT_FOUND' } });
        throw e;
      }
      try {
        ({ id: resolvedTargetId } = await resolveNodeRef(ctx.db, targetNodeId));
      } catch (e) {
        if (e instanceof NodeNotFoundError)
          throw new GraphQLError(`Target node not found: "${targetNodeId}"`, { extensions: { code: 'NODE_NOT_FOUND' } });
        throw e;
      }
      // Spec 037: an edge carries a memory-unique `loc` (its identity + URN
      // suffix), with `memoryId` denormalized from the source node. Fetch
      // both endpoints to compose/derive the loc + gate access.
      const [src, tgt] = await Promise.all([
        ctx.db.node.findUnique({ where: { id: resolvedSourceId }, select: { loc: true, memoryId: true } }),
        ctx.db.node.findUnique({ where: { id: resolvedTargetId }, select: { loc: true, memoryId: true } }),
      ]);
      if (!src) throw new GraphQLError(`Source node not found: "${sourceNodeId}"`, { extensions: { code: 'NODE_NOT_FOUND' } });
      if (!tgt) throw new GraphQLError(`Target node not found: "${targetNodeId}"`, { extensions: { code: 'NODE_NOT_FOUND' } });

      // PR-348 review (Gemini, critical): the global CONTRIBUTOR role gate
      // above is not memory-scoped. Mirror the MCP addEdge posture (and the
      // sibling upsertNode/moveNode mutations): require write access to the
      // SOURCE memory, and at least read on the TARGET. Without this any
      // CONTRIBUTOR could write an edge into a memory they can't touch. The
      // target denial returns the same NODE_NOT_FOUND wording as a genuine
      // miss so it can't be used as a cross-memory existence oracle.
      await requireMemoryWriteAccess(ctx, src.memoryId);
      if (!(await canReadMemory(ctx.db, ctx, tgt.memoryId))) {
        throw new GraphQLError(`Target node not found: "${targetNodeId}"`, { extensions: { code: 'NODE_NOT_FOUND' } });
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
      return ctx.db.edge.create({
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
    },

    updateEdge: async (
      _: unknown,
      { edgeId, name, loc, description, isRunnable, condition, priority, data }: {
        edgeId: string;
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
      return ctx.db.edge.update({
        where: { id: edgeId },
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
    },

    deleteEdge: async (
      _: unknown,
      { edgeId }: { edgeId: string },
      ctx: Context,
    ) => {
      requireRole(ctx, 'CONTRIBUTOR');
      await ctx.db.edge.delete({ where: { id: edgeId } });
      return true;
    },

    // ── Asset upload (spec 004-asset-upload) ───────────────────────────

    moveNode: async (_: unknown, { from: rawFrom, to: rawTo, memoryId, targetMemoryId }: { from: string; to: string; memoryId: string; targetMemoryId?: string }, ctx: Context) => {
      const from = parseUrnInput(rawFrom).value;
      const to = parseUrnInput(rawTo).value;
      // 007-entity-id-or-urn: memoryId and targetMemoryId may be IDs,
      // bare URNs, or prefixed URNs.
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);
      const resolvedTargetMemoryId = targetMemoryId
        ? (await resolveMemoryRef(ctx.db, targetMemoryId)).id
        : undefined;
      await requireMemoryWriteAccess(ctx, resolvedMemoryId);
      if (resolvedTargetMemoryId && resolvedTargetMemoryId !== resolvedMemoryId) {
        await requireMemoryWriteAccess(ctx, resolvedTargetMemoryId);
      }
      const destMemoryId = resolvedTargetMemoryId ?? resolvedMemoryId;
      try {
        return await ctx.db.node.update({
          where: { loc_memoryId: { loc: from, memoryId: resolvedMemoryId } },
          data: { loc: to, memoryId: destMemoryId },
          include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
        });
      } catch (e) {
        // Prisma P2025 = "Record to update not found." Wrap so the resolver
        // surfaces a typed NODE_NOT_FOUND error instead of leaking the raw
        // ORM message as INTERNAL_SERVER_ERROR (issue #100).
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
          throw new GraphQLError(`Node "${from}" not found in this memory`, {
            extensions: { code: 'NODE_NOT_FOUND', loc: from, memoryId: resolvedMemoryId },
          });
        }
        throw e;
      }
    },

    // Fold a source node into a target node, returning the updated target.
    // Reuses upsertNode's single-write invariants (per-memory write auth,
    // decrypt→merge→re-encrypt, NodeVersion snapshot, abstractOriginHash
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

      // ── Atomic write: version snapshot → target update → edge re-point →
      //    source delete ──────────────────────────────────────────────────
      await ctx.db.$transaction(async (tx) => {
        await tx.nodeVersion.create({
          data: {
            nodeId: target.id,
            loc: target.loc,
            name: target.name,
            alias: target.alias,
            description: target.description,
            abstract: target.abstract,
            abstractOriginHash: target.abstractOriginHash,
            content: target.content,
            tags: target.tags as string[],
            editedBy: ctx.clientId ?? ctx.userId ?? null,
            createdBy: ctx.userId ?? ctx.clientId ?? null,
          },
        });

        if (Object.keys(changed).length > 0) {
          await tx.node.update({ where: { id: target.id }, data: writeData });
        }

        if (fields.has('EDGES')) {
          // Spec: cor:api:070:02 (edge transfer + source disposition).
          // Edges reference nodes by id, so transferring the source's
          // relationships means re-pointing its edge endpoints onto the
          // target. Collisions on the (loc, memoryId) unique index — an edge
          // moving into the target's memory that lands on an already-occupied
          // loc — and self-loops (source↔target collapsing onto target) are
          // dropped rather than failing the merge. Pre-checked against a
          // claimed-loc set so we never poison the transaction with a P2002.
          const srcEdges = await tx.edge.findMany({
            where: { OR: [{ sourceId: source.id }, { targetId: source.id }] },
          });
          // Locs already occupied in the target's memory by edges NOT being
          // re-pointed here (incoming edges that stay in a foreign memory
          // can't newly collide — their loc+memoryId are unchanged).
          const movingIds = new Set(srcEdges.map((e) => e.id));
          const occupied = new Set<string>(
            (
              await tx.edge.findMany({
                where: { memoryId: target.memoryId },
                select: { id: true, loc: true },
              })
            )
              .filter((e) => !movingIds.has(e.id))
              .map((e) => e.loc),
          );
          // Partition in memory, then issue one deleteMany + up to two
          // updateMany — instead of an update/delete per edge — so a node with
          // many relationships doesn't N+1 the merge transaction. Outgoing
          // edges all become (sourceId=target, memoryId=target.memory);
          // incoming edges all become (targetId=target). A self-loop
          // (source↔target) or a loc already taken in the target's memory is
          // dropped rather than failing the merge.
          const toDrop: string[] = [];
          const outgoingIds: string[] = [];
          const incomingIds: string[] = [];
          for (const e of srcEdges) {
            const newSourceId = e.sourceId === source.id ? target.id : e.sourceId;
            const newTargetId = e.targetId === source.id ? target.id : e.targetId;
            if (newSourceId === newTargetId) {
              toDrop.push(e.id);
              continue;
            }
            const isOutgoing = e.sourceId === source.id;
            // An outgoing edge follows its source into the target's memory;
            // an incoming edge keeps its own (foreign) memory.
            const newMemoryId = isOutgoing ? target.memoryId : e.memoryId;
            if (newMemoryId === target.memoryId) {
              if (occupied.has(e.loc)) {
                toDrop.push(e.id);
                continue;
              }
              occupied.add(e.loc);
            }
            (isOutgoing ? outgoingIds : incomingIds).push(e.id);
          }
          if (toDrop.length > 0) {
            await tx.edge.deleteMany({ where: { id: { in: toDrop } } });
          }
          if (outgoingIds.length > 0) {
            await tx.edge.updateMany({
              where: { id: { in: outgoingIds } },
              data: { sourceId: target.id, memoryId: target.memoryId },
            });
          }
          if (incomingIds.length > 0) {
            await tx.edge.updateMany({
              where: { id: { in: incomingIds } },
              data: { targetId: target.id },
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

      // Mirror to git so a later (repo-wins) sync can't revert the merge.
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

      // Re-embed when the embedded text (content/abstract) changed.
      if (contentChanged || abstractChanged) {
        void enqueueNodeEmbedding(ctx.db, {
          nodeId: finalNode.id,
          memoryId: target.memoryId,
          plaintext: { content: finalNode.content, abstract: finalNode.abstract },
        });
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

      await ctx.db.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.node.deleteMany({ where: { ownerRepo, memoryId: resolvedMemoryId } });

        for (const input of nodes) {
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
          await tx.node.create({
            data: {
              id: input.id ?? generateId(),
              ...nodeFields,
              tags: serializeTags(input.tags ?? []) as string[],
            } as Prisma.NodeUncheckedCreateInput,
          });
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

      return nodes.length;
    },

    restoreNodeVersion: async (_: unknown, { versionId }: { versionId: string }, ctx: Context) => {
      const version = await ctx.db.nodeVersion.findUniqueOrThrow({ where: { id: versionId } });
      const node = await ctx.db.node.findUniqueOrThrow({ where: { id: version.nodeId } });
      await requireMemoryWriteAccess(ctx, node.memoryId);

      // Snapshot current state before restoring. Spec 031 — `abstract`
      // must be captured here too; without it, a round-trip restore (then
      // restoring this snapshot) silently drops abstract. Spec 032 — same
      // for `abstractOriginHash`.
      await ctx.db.nodeVersion.create({
        data: {
          id: generateId(),
          nodeId: node.id,
          loc: node.loc,
          name: node.name,
          alias: node.alias,
          description: node.description,
          abstract: node.abstract,
          abstractOriginHash: node.abstractOriginHash,
          content: node.content,
          tags: node.tags as string[],
          editedBy: ctx.clientId ?? ctx.userId ?? null,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
      });

      // Restore the node to the version's state. Spec 031 — `abstract`
      // is part of the restored state; without it, restoring a version
      // that had a non-null abstract leaves the node's current abstract
      // unchanged (and vice versa). Spec 032 — `abstractOriginHash`
      // applied verbatim per plan D4 (no recomputation on restore;
      // legacy null hashes short-circuit the staleness check via the
      // NOT NULL guard in hadron_get_node).
      const restored = await ctx.db.node.update({
        where: { id: node.id },
        data: {
          name: version.name,
          alias: version.alias,
          description: version.description,
          abstract: version.abstract,
          abstractOriginHash: version.abstractOriginHash,
          content: version.content,
          tags: version.tags as string[],
        },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
      // 033 — re-embed the restored content (version snapshots are plaintext on
      // non-encrypted memories; ciphertext snapshots are handled by embedNode's
      // #206 permanent-fail path).
      void enqueueNodeEmbedding(ctx.db, {
        nodeId: restored.id,
        memoryId: restored.memoryId,
        plaintext: { content: version.content, abstract: version.abstract },
      });
      return restored;
    },

};

