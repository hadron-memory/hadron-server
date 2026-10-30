// memoryMutations — extracted from resolvers.ts Mutation (split step 2). No behavior change.
import { endApprovalsOnEncryptedEntry } from '../../../lib/nodeApproval.js';
import { Prisma } from '../../../generated/prisma/index.js';
import { generateId } from '../../../lib/id.js';
import { UrnNotQualifiedError } from '../../../lib/urn.js';
import { AmbiguousLegacyUrnError } from '../../../lib/entityRef/errors.js';
import { mintMemoryUrnV2 } from '../../../lib/mintMemoryUrnV2.js';
import { generateUniqueHandle, ensureUserHandle } from '../../../lib/userHandle.js';
import { ensureUserPrincipal } from '../../../lib/principal/mintPrincipal.js';
import {
  ensureCurrentNodeRevisionInTransaction,
  RECONCILE_EDITOR_INFO,
  revisionStateHashRefreshMarker,
  editorFromAuth,
} from '../../../lib/nodeRevisionSnapshot.js';
import { encryptToken } from '../../../lib/tokenCrypto.js';
import {
  assertMemoryVisibilityChangeAllowed,
  revokeLinksForeignToTenant,
} from '../../../lib/agentPublicCongruence.js';
import {
  backfillMemoryEmbeddings,
  publishEmbedWake,
  restampFailedEmbeddings,
} from '../../../services/embedding/enqueue.js';
import { deleteMemoryChunkVectors, deleteMemoryVectors } from '../../../services/embedding/vectors.js';
import { embeddingKindsWanted, memoryIsVectorIndexed } from '../../../lib/embedding/indexing.js';
import {
  createMemoryShare,
  InvalidMemoryClassForShareError,
  MemoryNotFoundForShareError,
  MemoryShareGranteeMissingError,
  CrossOrgShareNotAllowedError,
} from '../../../controller/operations/createMemoryShare.js';
import { cloneMemoryGraph } from '../../../controller/operations/cloneMemory.js';
import { extractParentNodeGraph } from '../../../controller/operations/extractParentNode.js';
import {
  MERGE_POST_COMMIT_REMEDY,
  mergeMemoryGraph,
  withPartialMerge,
  type MergeMemoryResult,
} from '../../../controller/operations/mergeMemories.js';
import {
  updateMemoryShareRole,
  MemoryShareNotFoundError,
} from '../../../controller/operations/updateMemoryShareRole.js';
import {
  addMemoryMemberInTx,
  InvalidMemoryClassForMemberError,
  MemoryNotFoundForMemberError,
  MemoryMemberUserMissingError,
} from '../../../controller/operations/addMemoryMember.js';
import {
  updateMemoryMemberRoleInTx,
  MemoryMemberNotFoundError,
  LastOwnerProtectedError,
} from '../../../controller/operations/updateMemoryMemberRole.js';
import { removeMemoryMemberInTx } from '../../../controller/operations/removeMemoryMember.js';
import { retryOnSerializationFailure } from '../../../lib/serializableRetry.js';
import { AuthoritySnapshotStale } from '../../../lib/auth/authorityAnchors.js';
import {
  type MemoryShareRole as MemoryShareRoleType,
  type MemoryMemberRole as MemoryMemberRoleType,
  type Role,
  type MemoryVisibility,
} from '../../../generated/prisma/index.js';
import { parseDataKey } from '../../../lib/crypto.js';
import { getRequestOperationKey } from '../../../lib/requestOperationKey.js';
import { isStrictOwner } from '../../../lib/auth/strictOwner.js';
import {
  generateKdfSalt,
  deriveDataKeyFromPassphrase,
  makeKeyVerifier,
  verifyDataKey,
  resolveSuppliedKey,
  MemoryUnlockError,
  DEFAULT_KDF_PARAMS,
} from '../../../lib/memoryUnlock.js';
import {
  encryptNodeFieldsWithKey,
  isAuthenticatedStringEnvelope,
  isAuthenticatedDataEnvelope,
} from '../../../lib/nodeCrypto.js';
import {
  NodeAbstractTooLongError,
  NodeNotFoundError,
  EncryptedVectorIndexNotAcknowledgedError,
  InvalidChunkConfigError,
  UserNotFoundError,
  AmbiguousUserRefError,
} from '../../../lib/entityRef/errors.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveNodeRefForCaller } from './resolvers.nodeRefAccess.js';
import { resolveUserRefOrEmail } from '../../../lib/entityRef/userRef.js';
import { canReadMemory } from '../../../mcp/access-control.js';
import { MemoryNotFoundError } from '../../../lib/asset/gate.js';
import { AgentNotFoundError } from '../../../lib/entityRef/errors.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import {
  agentSlugFromUrn,
  deriveSlugFromName,
  assertFullyQualifiedUrn,
  parseUrn,
  validateUserSlug,
  hasSchemePrefix,
} from '../../../lib/urn.js';
import { GraphQLError } from 'graphql';
import { withAuthorizedMemoryTx } from './authorizedTx.js';
// Spec 049 §8.5 — the memory-level lock Channel creation shares with deleteMemory.
import { lockMemoryForChannelChange } from '../../../lib/channels.js';
import { assertNoMintedCorpusRemoval, reclaimTombstonedMemory } from '../../../lib/mintedSpecPermanence.js';
import { decisionError, memoryHoldsDecisionLog } from '../../../lib/decisions/index.js';
import { type InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import { validateMemorySchema, MemorySchemaError } from '../../../lib/memorySchema.js';
import { validateMemorySource, GitSourceError } from '../../../lib/gitSource.js';
import { validateGitBranch, GitRefError } from '../../../lib/gitRef.js';
import { syncGraphFromGithub } from '../../../integrations/github/syncGraphFromGithub.js';
import { recordNodeUsage } from '../../../lib/usageRecorder.js';
import { createNode } from '../../../controller/operations/createNode.js';
import {
  ALL_NODE_MERGE_FIELDS,
  type NodeMergeField,
} from '../../../lib/nodeMerge.js';
import { recordUrnRename } from '../../../lib/urnAlias.js';
import {
  type Context,
  requireRole,
  requireOrgRole,
  requireAgentAccess,
  resolveReadableAgentRef,
  requireOwnerOrOrgRole,
  requireMemoryManageAccess,
  concealUnreadableDenial,
  requireAgentMemoryGrant,
  resolveMemoryRefForWrite,
  canOpenMemoryRecordById,
  refArgNotFoundError,
  chosenRefArg,
  requireMemoryWriteAccess,
  withoutRequestCaches,
  MEMORY_INCLUDE,
  AGENT_INCLUDE,
  ORG_INCLUDE,
  requireMemoryMemberOwner,
  requireMemoryMemberOwnerOrSelf,
  requireMemorySharePrincipal,
  isMemorySharePrincipal,
  memoryShareForbidden,
  isMemoryMemberOwner,
  memoryMemberForbidden,
  resolveMemoryRefForMemberGate,
  resolveSelfUserRefForMemberGate,
  resolveUserRefArg,
  resolveOrgRefArg,
  resolveMemoryRefArg,
  getAccessibleMemoryIds,
  type MergeMemoriesInput,
  assertMemoryRootLoc,
} from './resolvers.helpers.js';
import { requireOrgAction } from '../../../lib/auth/orgAction.js';
import { isInstallMemoryRow } from '../../../lib/auth/installMemory.js';
import { installDeleteAllowed, lockInstallAuthorityFirst } from './installMemory.js';
import { LIVE_ORG_MEMBERSHIP } from '../../../lib/auth/liveOrgMembership.js';
import { forbiddenError } from '../../../lib/refusals.js';
import { withFsProjectionRollback } from '../../../lib/fsProjectionRollback.js';

/**
 * #561 — refuse a `Memory.source` that is not a GitHub repository URL.
 *
 * The ONE gate both write paths call, rather than a check per mutation: the
 * column is a git remote URL, and git reads a remote URL as a transport
 * selector rather than an address — so it decides how git talks, not just
 * where. Every caller-reachable write to `source` must pass through here, so a
 * third write path added later is a missing call rather than a subtly
 * different regex. What was reachable before it, measured: see lib/gitSource.ts.
 *
 * Surfaces the refusal as `INVALID_MEMORY_SOURCE` so a client can branch on it
 * instead of matching prose.
 */
function assertValidMemorySource(source: string | null | undefined): void {
  try {
    validateMemorySource(source);
  } catch (e) {
    if (e instanceof GitSourceError) {
      throw new GraphQLError(e.message, { extensions: { code: 'INVALID_MEMORY_SOURCE' } });
    }
    throw e;
  }
}

/**
 * #1146 — `readBranch` / `writeBranch` reach `git` as POSITIONAL ARGUMENTS, so
 * a value beginning with `-` is read as an OPTION rather than as a ref. Not
 * shell injection (execGit uses no shell); argument injection, which is why it
 * survived #561's transport pass.
 *
 * Every caller-reachable write to either column passes through here, for the
 * same reason `assertValidMemorySource` exists: a third write path added later
 * should be a missing call rather than a subtly different regex. The columns
 * are ALSO validated at each point of use, because a row that arrived by
 * migration, restore or direct DB write never saw this.
 *
 * Surfaced as `INVALID_GIT_BRANCH` so a client can branch on it instead of
 * matching prose.
 */
function assertValidBranches(input: {
  readBranch?: string | null;
  writeBranch?: string | null;
}): void {
  try {
    validateGitBranch(input.readBranch, 'readBranch');
    validateGitBranch(input.writeBranch, 'writeBranch');
  } catch (e) {
    if (e instanceof GitRefError) {
      throw new GraphQLError(e.message, { extensions: { code: 'INVALID_GIT_BRANCH' } });
    }
    throw e;
  }
}

/**
 * #769 — resolve the grantee of a memory-share mutation to a definite user id.
 * Prefer the new `granteeRef` (id / email / handle / `hrn:user:` URN, resolved
 * server-side against the full user table so a cross-org personal share works),
 * falling back to the deprecated `granteeId` PK for existing callers. Exactly
 * one must be supplied. A ref that resolves to no user surfaces NOT_FOUND rather
 * than the caller-facing controller error.
 */
async function resolveGranteeId(
  ctx: Context,
  args: { granteeRef?: string | null; granteeId?: string | null },
): Promise<string> {
  const ref = args.granteeRef?.trim();
  // Mutually exclusive: passing both is a caller mistake, and silently
  // preferring one contradicts the schema (PR #774 review).
  if (ref && args.granteeId) {
    throw new GraphQLError('Pass either granteeRef or granteeId, not both.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  if (ref) {
    try {
      const { id } = await resolveUserRefOrEmail(ctx.db, ref);
      return id;
    } catch (e) {
      if (e instanceof UserNotFoundError) {
        throw new GraphQLError(`No user matches granteeRef "${ref}".`, {
          extensions: { code: 'NOT_FOUND' },
        });
      }
      if (e instanceof AmbiguousUserRefError) {
        throw new GraphQLError(
          `granteeRef "${ref}" matches more than one account (differing only by email case). Use the exact-case email, the handle, or the id.`,
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }
      throw e;
    }
  }
  if (args.granteeId) return args.granteeId;
  throw new GraphQLError('A grantee is required: pass granteeRef (or the deprecated granteeId).', {
    extensions: { code: 'BAD_USER_INPUT' },
  });
}

/**
 * Lock the (memory, agent) pair an attachment depends on, then re-read both
 * inside the transaction (#1349, @codex on PR #1357).
 *
 * `requireAgentMemoryGrant` decides from a memory's VISIBILITY and tenancy and
 * from the agent's VISIBILITY — three values another in-flight mutation may be
 * changing. Read outside the write's transaction, every one of those checks is
 * a check-then-act race:
 *
 *   - an attach reads the memory while it is PUBLIC, `updateMemory` narrows it
 *     and finds no link to revoke, then the attach writes its grant from the
 *     stale PUBLIC snapshot — a live foreign link to a now-private memory;
 *   - an attach reads the agent as non-PUBLIC while `updateAgent` publishes it
 *     and sees no read-write item — a PUBLIC agent holding write knowledge.
 *
 * Both writers already take `FOR UPDATE` on their own row (`updateMemory` on
 * the memory, `updateAgent` on the agent), so taking BOTH here serializes the
 * attach behind whichever is in flight and makes the re-read authoritative.
 *
 * LOCK ORDER IS MEMORY, THEN AGENT, and it matters: a pair of transactions
 * taking the same two rows in opposite orders deadlocks. No other path locks an
 * agent row and then a memory row (`updateAgent` syncs its system memory in a
 * SEPARATE transaction), so this order is consistent with what exists.
 */
async function lockAttachmentPair(
  tx: Prisma.TransactionClient,
  memoryId: string,
  agentId: string,
  // The caller's own refs, for the miss errors below.
  refs: { memoryRef: string; agentRef: string },
) {
  await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM agents WHERE id = ${agentId} FOR UPDATE`;
  const memory = await tx.memory.findUniqueOrThrow({
    where: { id: memoryId },
    select: {
      deletedAt: true,
      id: true,
      class: true,
      visibility: true,
      appId: true,
      userId: true,
      ownerUserId: true,
      organizationId: true,
      userMemoryOfAgentId: true,
    },
  });
  const agent = await tx.agent.findUniqueOrThrow({
    where: { id: agentId },
    select: { id: true, organizationId: true, ownerUserId: true, visibility: true, deletedAt: true },
  });
  // LIVENESS under the lock (@copilot, PR #1357). The resolvers refused a
  // deleted row only BEFORE the transaction, so a concurrent deleteAgent — or a
  // memory soft-delete — committing in between would otherwise get a grant
  // written onto a row that no longer exists. Answered exactly as the
  // resolvers answer a miss, agent first as they resolve.
  if (agent.deletedAt) throw new AgentNotFoundError(refs.agentRef);
  if (memory.deletedAt) throw new MemoryNotFoundError(refs.memoryRef);
  return { memory, agent };
}

/**
 * Refuse a subscription mutation on a memory this caller cannot open, with
 * resolveRefArg's own miss (#1381, `cor:api:140:03`) — for the mutations no
 * such caller can legitimately complete (create, update).
 *
 * This includes a PUBLIC memory the caller still cannot open: an App-scoped
 * one, which #653 keeps App-internal, so the shared read gate excludes it.
 * Subscribing to it used to succeed, and success versus "no match" was the
 * oracle. Refusing it is the narrowing `cor:api:140:03` requires, not a new
 * policy: a caller who could not otherwise know the memory exists gets the
 * missing answer.
 */
async function refuseHiddenSubscriptionMemory(
  ctx: Context,
  memoryId: string,
  refArg: { ref?: string | null; id?: string | null },
): Promise<void> {
  if (await canOpenMemoryRecordById(ctx, memoryId)) return;
  throw refArgNotFoundError('memory', chosenRefArg(refArg)!);
}

/**
 * Refuse, with a typed error, a subscription mutation whose (memory, org) row
 * does not exist (#1381). Before this it reached Prisma's `update` / `delete`
 * and surfaced P2025's own text, server paths included. A caller who cannot
 * open the memory gets resolveRefArg's memory miss, so the row's absence is
 * not an oracle for the memory's existence either.
 */
async function requireMemorySubscription(
  ctx: Context,
  memoryId: string,
  organizationId: string,
  memoryRef: string,
): Promise<void> {
  const row = await ctx.db.memorySubscription.findUnique({
    where: { memoryId_organizationId: { memoryId, organizationId } },
    select: { memoryId: true },
  });
  if (row) return;
  if (!(await canOpenMemoryRecordById(ctx, memoryId))) throw refArgNotFoundError('memory', memoryRef);
  throw new GraphQLError('No subscription from that organization to this memory.', {
    extensions: { code: 'NOT_FOUND' },
  });
}

export const memoryMutations = {
    mergeMemories: async (
      _: unknown,
      { input }: { input: MergeMemoriesInput },
      ctx: Context,
    ) => {
      const { source: rawSource, target: rawTarget } = input;
      const deleteSourceMem = input.deleteSourceMem ?? false;
      const fields = new Set<NodeMergeField>(input.include ?? ALL_NODE_MERGE_FIELDS);

      // #1381: both ends conceal AS THEY RESOLVE. The class and encryption
      // refusals below run before authorization, so an unreadable memory used
      // to answer with its class, its encryption state and its internal id.
      const { id: sourceId } = await resolveMemoryRefForWrite(ctx, rawSource);
      const { id: targetId } = await resolveMemoryRefForWrite(ctx, rawTarget);
      if (sourceId === targetId) {
        throw new GraphQLError('mergeMemories: source and target are the same memory.', {
          extensions: { code: 'MERGE_SOURCE_EQUALS_TARGET', memoryId: sourceId },
        });
      }
      const [sourceMem, targetMem] = await Promise.all([
        ctx.db.memory.findUniqueOrThrow({ where: { id: sourceId } }),
        ctx.db.memory.findUniqueOrThrow({ where: { id: targetId } }),
      ]);

      // v1 class guard: system/app memories auto-provision and carry pivot
      // invariants (chk_memory_class_app_id) a free-form merge would violate
      // (same rationale as cloneMemory rejecting these classes).
      for (const m of [sourceMem, targetMem]) {
        if (m.class === 'system' || m.class === 'app') {
          throw new GraphQLError(
            `mergeMemories does not accept a class='${m.class}' memory. ` +
              `Only 'knowledge', 'group', 'personal', and 'private' memories can be merged.`,
            { extensions: { code: 'UNSUPPORTED_MEMORY_CLASS', memoryId: m.id, memoryClass: m.class } },
          );
        }
      }
      // v1: encrypted memories rejected — a cross-key re-encrypt of the whole
      // graph (moved nodes included) is a separate follow-up (mirrors cloneMemory).
      for (const m of [sourceMem, targetMem]) {
        if (m.isEncrypted) {
          throw new GraphQLError(
            'mergeMemories does not support encrypted memories yet.',
            { extensions: { code: 'ENCRYPTED_MEMORY_MERGE_UNSUPPORTED', memoryId: m.id } },
          );
        }
      }

      // Auth (cross-org allowed → each memory authorized against its own org).
      // Spec: cor:api:080:02 (source disposition + constraints).
      // Target gains nodes → write access. Source is emptied → write access (a
      // writer could already delete its nodes one by one). Deleting the source
      // memory ROW is the stricter, delete-level action → owner for personal/
      // private, org ADMIN otherwise (mirrors deleteMemory).
      await requireMemoryWriteAccess(ctx, targetMem.id);
      await requireMemoryWriteAccess(ctx, sourceMem.id);
      if (deleteSourceMem) {
        if (sourceMem.class === 'personal' || sourceMem.class === 'private') {
          if (!ctx.userId || sourceMem.userId !== ctx.userId) {
            throw new GraphQLError(
              `Forbidden: only the owner can delete a ${sourceMem.class} memory`,
              { extensions: { code: 'FORBIDDEN' } },
            );
          }
        } else {
          await requireOwnerOrOrgRole(ctx, sourceMem, 'ADMIN');
        }
      }

      const editor = editorFromAuth(ctx);

      // EDGES transfer can mutate edges whose denormalized memory is neither
      // source nor target (incoming cross-memory edges). Require write access
      // to every such memory first — same posture as mergeNodes. Expressed via
      // a relation filter (edges sourced FROM the source memory, plus edges
      // whose TARGET node lives in it) so a large source memory never needs its
      // node ids materialized into a giant `IN (...)` list.
      if (fields.has('EDGES')) {
        const edgeMems = await ctx.db.edge.findMany({
          where: { OR: [{ memoryId: sourceMem.id }, { target: { memoryId: sourceMem.id } }] },
          select: { memoryId: true },
          distinct: ['memoryId'],
        });
        const authed = new Set<string>([sourceMem.id, targetMem.id]);
        for (const { memoryId } of edgeMems) {
          if (authed.has(memoryId)) continue;
          await requireMemoryWriteAccess(ctx, memoryId);
          authed.add(memoryId);
        }
      }

      // The merge runs as bounded, resumable batches rather than one
      // interactive transaction, so a very large source memory neither blows
      // past the ~5s tx timeout nor holds locks for the whole merge (#363).
      // Atomicity per-merge is traded for consistent partial progress: a
      // re-run completes an interrupted merge. The spec lists the batching +
      // ordering of these writes as tunable (cor:api:080).
      // Spec: cor:api:080:01 (collide vs relocate), cor:api:080:02 (source
      // disposition + constraints).
      let merged: MergeMemoryResult;
      try {
        merged = await mergeMemoryGraph(ctx.db, {
          sourceMemoryId: sourceMem.id,
          targetMemoryId: targetMem.id,
          fields,
          deleteSourceMem,
          editor,
          principal: ctx,
        });
      } catch (e) {
        // Surface the same typed error mergeNodes does, with the offending loc.
        if (e instanceof NodeAbstractTooLongError) {
          throw new GraphQLError(e.message, {
            extensions: {
              ...e.extensionFields(),
              loc: (e as NodeAbstractTooLongError & { loc?: string }).loc,
              // #1686 — present when earlier batches had already committed.
              ...((e as { partialMerge?: unknown }).partialMerge ? { partialMerge: (e as { partialMerge?: unknown }).partialMerge } : {}),
            },
          });
        }
        throw e;
      }

      // Re-embed: the target gained/changed nodes. If it indexes vectors,
      // re-stamp every node pending so the sweep embeds the relocated + merged
      // content (mirrors cloneMemory's backfill). No-op otherwise.
      //
      // #1691: the merge has fully committed by now, so a failure here must
      // not read as "applied nothing" (the SDL's promise for a refusal without
      // partialMerge). It reports the completed counts and the source's real
      // disposition, through the same redacting wrapper as a mid-merge failure.
      try {
        if (targetMem.vectorIndexEnabled) {
          await backfillMemoryEmbeddings(ctx.db, targetMem.id);
        }

        return await ctx.db.memory.findUniqueOrThrow({
          where: { id: targetMem.id },
          include: MEMORY_INCLUDE,
        });
      } catch (e) {
        throw withPartialMerge(e, {
          applied: true,
          relocated: merged.relocatedCount,
          folded: merged.foldedCount,
          edgesMoved: merged.edgesMovedCount,
          edgesDropped: merged.edgesDroppedCount,
          remainingSourceNodes: 0,
          sourceIntact: !deleteSourceMem,
          remedy: MERGE_POST_COMMIT_REMEDY,
        }, ` The merge itself completed (${merged.relocatedCount} relocated, ${merged.foldedCount} folded)${deleteSourceMem ? ' and the source memory was deleted' : ''}; a step after it failed. ${MERGE_POST_COMMIT_REMEDY}`);
      }
    },

    createMemory: async (
      _: unknown,
      {
        orgId,
        name,
        shortDescription,
        description,
        data,
        tags,
        license,
        category0,
        category1,
        category2,
        iconUrl,
        heroUrl,
        homeUrl,
        source,
        readBranch,
        writeBranch,
        visibility,
        memoryClass,
        vectorIndexEnabled,
        embeddingSource,
        maxRevCount,
        draftCorpus,
      }: {
        // spec 047: OPTIONAL — omitted ⇒ user-owned (caller's `@handle` namespace).
        orgId?: string | null; name: string;
        shortDescription?: string; description?: string; data?: Record<string, unknown> | null; tags?: string[];
        license?: string; category0?: string; category1?: string; category2?: string;
        iconUrl?: string; heroUrl?: string; homeUrl?: string;
        source?: string | null; readBranch?: string; writeBranch?: string; visibility?: string;
        // Both are nullable in the GraphQL schema — a client may pass an
        // explicit `null`, which we treat as "unspecified" (the `??` / `!= null`
        // guards below coalesce it to the class default).
        vectorIndexEnabled?: boolean | null;
        embeddingSource?: 'abstract' | 'contentChunks' | 'both' | null;
        // #621 — per-node revision cap; omitted ⇒ column default (10).
        maxRevCount?: number | null;
        // #1448 — the ONLY way a memory becomes a draft spec corpus.
        draftCorpus?: boolean | null;
        // GraphQL passes the full MemoryClass enum; the resolver
        // allowlists the user-creatable values below. Spec 034 added
        // `personal`/`private` as owner-only, user-creatable classes
        // (free-standing or app-scoped); `system`/`app` still
        // auto-provision via other paths and are rejected here.
        memoryClass?: 'knowledge' | 'group' | 'system' | 'app' | 'personal' | 'private';
      },
      ctx: Context,
    ) => {
      // spec 047 — user-owned tenancy: omitting `orgId` creates the memory in
      // the authenticated caller's own `@<handle>` namespace (organizationId
      // NULL, ownerUserId = caller) instead of under an org. The two paths
      // diverge on owner resolution, authorization, and URN root below.
      const userOwned = orgId == null;
      if (userOwned && !ctx.userId) {
        throw new GraphQLError(
          'Creating a user-owned memory (no orgId) requires an authenticated user (the creator is the owner).',
          { extensions: { code: 'UNAUTHENTICATED' } },
        );
      }
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const resolvedOrgId = userOwned ? null : (await resolveOrgRef(ctx.db, orgId!)).id;

      // #621 — friendly guard mirroring chk_memory_max_rev_count_positive.
      // Explicit `null` is rejected (there is no "null" cap — omit the arg to
      // get the default); only `undefined` (omitted) or a concrete >= 1 passes.
      if (maxRevCount === null || (maxRevCount !== undefined && maxRevCount < 1)) {
        throw new GraphQLError('maxRevCount must be at least 1.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }

      // #561 — `source` is a git remote URL, so it selects a transport. Refuse
      // anything that is not a GitHub repository before it is persisted.
      assertValidMemorySource(source);
      assertValidBranches({ readBranch, writeBranch });

      // 023-app-shape US4 + 034-memory-class-access: user-creatable classes are
      // `knowledge` (default), `group`, and the owner-owned `personal`/`private`
      // (free-standing — no app/agent). `system`/`app` still auto-provision via
      // other paths and are rejected here.
      const requestedClass = memoryClass ?? 'knowledge';
      const isUserOwned = requestedClass === 'personal' || requestedClass === 'private';
      if (requestedClass !== 'knowledge' && requestedClass !== 'group' && !isUserOwned) {
        throw new GraphQLError(
          `createMemory does not accept class='${requestedClass}'. Only ` +
            `'knowledge', 'group', 'personal', and 'private' are user-creatable; ` +
            `'${requestedClass}' auto-provisions via a different code path.`,
          { extensions: { code: 'UNSUPPORTED_MEMORY_CLASS' } },
        );
      }

      // spec 047 — the org-less (user-owned) path supports ONLY the owner-only
      // classes `personal`/`private`. `knowledge`/`group` are org-shared: their
      // read audience is visibility-scoped to org members, which is meaningless
      // without an org — so they still require `orgId`.
      if (userOwned && !isUserOwned) {
        throw new GraphQLError(
          `A user-owned memory (no orgId) must be class 'personal' or 'private'; ` +
            `'${requestedClass}' is org-shared — pass orgId to create it.`,
          { extensions: { code: 'UNSUPPORTED_MEMORY_CLASS' } },
        );
      }

      // Authorization (034-memory-class-access + 047-user-owned-tenancy):
      // - user-owned (no org): the caller IS the owner — nothing more to check.
      // - org-shared classes (knowledge/group): require the org.create grant.
      // - org-anchored personal/private: require ACTUAL membership of the org
      //   *container* — the memory is theirs, not the org's, but it lives in the
      //   org's namespace.
      if (userOwned) {
        // Owner is the authenticated caller (verified above); no org, no
        // membership to check. The memory is theirs outright.
      } else if (isUserOwned) {
        // #2511: a personal/private memory belongs to a USER. An App-key caller
        // has none, and `userId: undefined` below would drop the filter from the
        // membership lookup, admitting any member of the org to a gate meant
        // for the caller alone (the create then died on a CHECK constraint).
        if (!ctx.userId) {
          throw new GraphQLError(
            'Creating a personal/private memory requires an authenticated user (the creator is the owner).',
            { extensions: { code: 'UNAUTHENTICATED' } },
          );
        }
        // NOT requireOrgRole, whose global ADMIN/OWNER bypass would let a
        // platform admin create a personal/private memory in an org they don't
        // belong to.
        const orgMembership = await ctx.db.orgMember.findFirst({
          where: { organizationId: resolvedOrgId!, userId: ctx.userId!, ...LIVE_ORG_MEMBERSHIP },
        });
        if (!orgMembership) {
          throw new GraphQLError(
            'You must be a member of the organization to create a personal/private memory in it.',
            { extensions: { code: 'FORBIDDEN' } },
          );
        }
      } else {
        // Grant-model gate (design:grant-model P2a): role bundle union
        // individual grants. Behavior-equivalent to the former
        // requireOrgRole(ADMIN) until a memory.create grant row exists.
        await requireOrgAction(ctx, resolvedOrgId!, 'memory.create');
      }
      // 023-app-shape US4: group-class memories must carry GROUP
      // visibility (enforced by the chk_memory_group_visibility CHECK
      // constraint at the DB level; we surface a clearer error at the
      // API layer instead of letting the constraint fire). The
      // creator becomes the first owner via the bootstrap path below.
      if (requestedClass === 'group') {
        if (visibility !== undefined && visibility !== 'GROUP') {
          throw new GraphQLError(
            'Group-class memory must have visibility=GROUP (spec 023 FR-024).',
            { extensions: { code: 'INVALID_GROUP_MEMORY_VISIBILITY' } },
          );
        }
        if (!ctx.userId) {
          throw new GraphQLError(
            'Creating a group-class memory requires an authenticated user (the creator becomes the first owner).',
            { extensions: { code: 'UNAUTHENTICATED' } },
          );
        }
      } else if (visibility === 'GROUP') {
        // Symmetric guard: non-group class can't claim GROUP visibility.
        throw new GraphQLError(
          'visibility=GROUP requires class=group (spec 023 FR-024).',
          { extensions: { code: 'INVALID_GROUP_MEMORY_VISIBILITY' } },
        );
      }

      // #2730: the root node's loc is `name`; refuse an unprojectable one here,
      // after the gates and before ensureUserHandle, the tombstone reclaim or
      // any create.
      assertMemoryRootLoc(name);

      // The URN root is the owner principal's bare namespace atom — an org
      // domain (`baragaun.com`) or, for the user-owned path, the caller's
      // handle (`holger`). ensureUserHandle mints+persists a handle if the
      // owner has none, since the URN can't root on a missing handle. Both
      // yield the BARE stored form `<root>:<slug>` (single colon, no `hrn:mem:`
      // prefix — the display layer adds that); storing the rendered form is the
      // double-prefix footgun the chk_memory_urn_not_prefixed guardrail blocks.
      const memRoot = userOwned
        ? await ensureUserHandle(ctx.db, ctx.userId!)
        : (await ctx.db.organization.findUniqueOrThrow({ where: { id: resolvedOrgId! }, select: { urn: true } })).urn;
      // #574: slugify the display name — a raw name would persist a
      // case-sensitive / space-bearing URN that can't round-trip through parseUrn.
      const memoryUrn = `${memRoot}:${deriveSlugFromName(name)}`;
      // Check for existing memory with the same URN
      const existing = await ctx.db.memory.findUnique({ where: { urn: memoryUrn } });
      if (existing) {
        if (existing.deletedAt) {
          // #1468 — refused for a stamped corpus still holding a spec.
          await ctx.db.$transaction((tx) => reclaimTombstonedMemory(tx, existing.id));
        } else {
          throw new Error(`A memory with URN "${memoryUrn}" already exists`);
        }
      }

      // For group-class memory: bootstrap the creator as the first
      // owner in the same transaction as the Memory create, so the
      // Memory is never persisted in a zero-owner state (which would
      // be effectively unreachable to anyone, including the creator).
      const memory = await withFsProjectionRollback(() => ctx.db.$transaction(async (tx) => {
        const created = await tx.memory.create({
          data: {
            id: generateId(),
            // spec 047 owner XOR (chk_memory_owner_xor): exactly one of
            // organizationId / ownerUserId. Org path → org set, ownerUserId
            // NULL. User-owned path → org NULL, ownerUserId = caller (the tenant
            // owner, distinct from `userId` — the strict personal/private owner
            // set just below for those classes).
            organizationId: resolvedOrgId,
            ownerUserId: userOwned ? ctx.userId : null,
            urn: memoryUrn,
            name,
            // #1448 legacy flag. Since #1591 nothing reads it: corpus state
            // is derived from per-node minting, and every new node starts
            // unminted whether or not draft was asked for.
            corpusDraft: draftCorpus === true,
            shortDescription,
            description,
            // Free-form metadata bag (no server-side semantics). Mirrors the
            // Node.data / Edge.data null-handling: undefined omits the field
            // (column stays NULL on create), explicit null writes NULL.
            ...(data !== undefined ? { data: data as InputJsonValue } : {}),
            tags: tags ?? [],
            license,
            category0,
            category1,
            category2,
            iconUrl,
            heroUrl,
            homeUrl,
            source,
            readBranch,
            writeBranch,
            // 035-visibility-enum-cleanup: group → GROUP; personal/private →
            // NULL (privacy is class-driven, not visibility); knowledge default
            // → ORGANIZATION (was PRIVATE). chk_memory_visibility_class forbids
            // a non-null visibility on personal/private.
            visibility:
              requestedClass === 'group'
                ? 'GROUP'
                : requestedClass === 'personal' || requestedClass === 'private'
                  ? null
                  : ((visibility as MemoryVisibility) ?? 'ORGANIZATION'),
            // 005-agent-subscription: explicit user-driven createMemory
            // creates a knowledge-class memory by default. Personal-class
            // memories are auto-provisioned via the AgentSubscription
            // path; system-class via Agent.systemMemoryId.
            // 023-app-shape US4: a `memoryClass: 'group'` argument lets
            // callers create group-class memories explicitly.
            class: requestedClass,
            // 033 — class-derived defaults for the vector index (FR-001 + #281):
            // a `knowledge`-class memory (non-encrypted, as created here) is
            // searchable by default. The default source is `contentChunks` —
            // it embeds `Node.content` directly (no authored abstract / no LLM),
            // so any node with content is retrievable immediately (the `abstract`
            // column default would leave most knowledge nodes unindexed until
            // abstracts are written). `group` and others keep the column defaults
            // (off / `abstract`). Explicit caller values win for every class.
            // All flippable later via updateMemory.
            vectorIndexEnabled: vectorIndexEnabled ?? requestedClass === 'knowledge',
            ...(embeddingSource != null
              ? { embeddingSource }
              : requestedClass === 'knowledge'
                ? { embeddingSource: 'contentChunks' as const }
                : {}),
            // #621 — per-node revision cap; omitted/null ⇒ column default (10).
            ...(maxRevCount != null ? { maxRevCount } : {}),
            // Owner-owned personal/private set the creator as the owner
            // (free-standing: app_id / userMemoryOfAgentId stay NULL). All other
            // classes MUST have userId NULL (chk_personal_visibility_user /
            // chk_memory_group_no_owner) — set it explicitly rather than relying
            // on Prisma omitting the field.
            userId: isUserOwned ? ctx.userId : null,
            createdBy: ctx.userId ?? ctx.clientId ?? null,
          },
          include: MEMORY_INCLUDE,
        });
        if (requestedClass === 'group' && ctx.userId) {
          await tx.memoryMember.create({
            data: {
              memoryId: created.id,
              userId: ctx.userId,
              role: 'owner',
              createdBy: ctx.userId,
            },
          });
        }
        // #2728: the root node is created in the Memory's own transaction, so a root failure rolls the Memory
        // (and a group's owner row) back instead of leaving a rootless row a retry would duplicate.
        const rootName = name.split(':').pop() ?? name;
        await createNode({
          memoryId: created.id,
          loc: name,
          name: rootName,
          description: 'Root node for this memory.',
        }, tx);
        return created;
      }));

      return memory;
    },

    updateMemory: async (
      _: unknown,
      {
        id,
        name,
        urn,
        organizationId: newOrgId,
        shortDescription,
        description,
        data,
        tags,
        license,
        category0,
        category1,
        category2,
        iconUrl,
        heroUrl,
        homeUrl,
        source,
        readBranch,
        writeBranch,
        visibility,
        listedOnMarketplace,
        vectorIndexEnabled,
        embeddingSource,
        acknowledgeVectorInversionRisk,
        chunkTokens,
        chunkOverlap,
        forceFixedSize,
        maxRevCount,
        schema,
      }: {
        id: string; name?: string; urn?: string; organizationId?: string;
        shortDescription?: string; description?: string; data?: Record<string, unknown> | null; tags?: string[];
        license?: string; category0?: string; category1?: string; category2?: string;
        iconUrl?: string; heroUrl?: string; homeUrl?: string;
        source?: string; readBranch?: string; writeBranch?: string; visibility?: string;
        listedOnMarketplace?: boolean;
        vectorIndexEnabled?: boolean;
        embeddingSource?: 'abstract' | 'contentChunks' | 'both';
        acknowledgeVectorInversionRisk?: boolean;
        chunkTokens?: number | null;
        chunkOverlap?: number | null;
        forceFixedSize?: boolean;
        maxRevCount?: number | null;
        schema?: Record<string, unknown> | null;
      },
      ctx: Context,
    ) => {
      // #1381: resolve the ref (id OR URN, cor:api:140:01) so a miss is a typed
      // MEMORY_NOT_FOUND rather than Prisma's own error text, and conceal a
      // memory the caller cannot open exactly as that miss. `id` is the
      // resolved PK from here on.
      const ref = id;
      ({ id } = await resolveMemoryRef(ctx.db, ref));
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id } });
      await concealUnreadableDenial(ctx, id, ref, () => requireMemoryManageAccess(ctx, memory));
      if (newOrgId != null && newOrgId !== memory.organizationId) {
        throw new GraphQLError('Use transferMemoryOwnership to change a memory owner.', {
          extensions: { code: 'USE_TRANSFER_MEMORY_OWNERSHIP' },
        });
      }
      // #725 — validate the property schema for well-formedness BEFORE it is
      // stored: a malformed schema is BAD_USER_INPUT, never a persisted garbage
      // blob. `null` clears it; the stored value is the normalized schema (so
      // what's persisted is exactly the contract).
      let schemaValue: InputJsonValue | null | undefined = undefined;
      if (schema !== undefined) {
        if (schema === null) {
          schemaValue = null;
        } else {
          try {
            schemaValue = validateMemorySchema(schema) as unknown as InputJsonValue;
          } catch (e) {
            if (e instanceof MemorySchemaError) {
              throw new GraphQLError(`updateMemory.schema: ${e.message}`, { extensions: { code: 'BAD_USER_INPUT' } });
            }
            throw e;
          }
        }
      }
      // #561 — same gate as createMemory: a git remote URL selects a transport,
      // so refuse anything that is not a GitHub repository before it is stored.
      // An omitted `source` leaves the column untouched and is not re-validated;
      // an explicit null clears it (DB-only mode).
      assertValidMemorySource(source);
      assertValidBranches({ readBranch, writeBranch });
      // cor:acl:080:03 — un-PUBLIC-ing a COVERED memory that a PUBLIC agent
      // links would break the congruence invariant; reject before persisting.
      // The helper excludes per-user + app-scoped memories (never public).
      // #1349 (@codex, PR #1357): the authoritative check moved INSIDE the
      // transaction below, under the memory row lock, so a concurrent
      // `updateAgent(visibility: PUBLIC)` cannot observe this memory as still
      // PUBLIC while this call observes no PUBLIC agent. This early pass stays
      // as the fail-fast, ahead of the URN/alias writes.
      if (visibility !== undefined) {
        // #2573: the same two-direction class/visibility guard createMemory
        // applies (spec 023 FR-024), judged before anything is written. A
        // memory's class never changes here, so the stored class decides.
        // Without it the write reaches chk_memory_group_visibility and
        // surfaces as INTERNAL_SERVER_ERROR.
        if (memory.class === 'group' && visibility !== 'GROUP') {
          throw new GraphQLError(
            'Group-class memory must have visibility=GROUP (spec 023 FR-024).',
            { extensions: { code: 'INVALID_GROUP_MEMORY_VISIBILITY' } },
          );
        }
        if (memory.class !== 'group' && visibility === 'GROUP') {
          throw new GraphQLError(
            'visibility=GROUP requires class=group (spec 023 FR-024).',
            { extensions: { code: 'INVALID_GROUP_MEMORY_VISIBILITY' } },
          );
        }
        await assertMemoryVisibilityChangeAllowed(ctx.db, memory, visibility);
      }
      // #1349 (@codex, PR #1357): narrowing out of PUBLIC also REVOKES the
      // foreign-tenant agent links that only PUBLIC ever justified. Deferred
      // until after the update below, so a failed write leaves the grants as
      // they were.
      // #621 — friendly guard mirroring chk_memory_max_rev_count_positive.
      // The column is NOT NULL, so explicit `null` is rejected (omit the arg to
      // leave the cap unchanged); only `undefined` (omitted) or >= 1 passes.
      if (maxRevCount === null || (maxRevCount !== undefined && maxRevCount < 1)) {
        throw new GraphQLError('maxRevCount must be at least 1.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      // Owner changes use transferMemoryOwnership; only a slug change reaches
      // this path.
      let newUrn: string | undefined;
      if (urn !== undefined) {
        if (!memory.organizationId) {
          throw new GraphQLError('Renaming the URN is not supported for a user-owned memory yet.', {
            extensions: { code: 'BAD_USER_INPUT' },
          });
        }
        const org = await ctx.db.organization.findUniqueOrThrow({ where: { id: memory.organizationId }, select: { urn: true } });
        // Guard: a memory slug must be BARE — not a full or embedded URN. The
        // portal settings form once mis-derived the slug from a canonical
        // `hrn:memory:<org>::<slug>` and sent `memory:<org>::<slug>`, which
        // composed into `<org>:memory:<org>::<slug>` and corrupted the row
        // (the prod /app/orgs outage). Reject a client-supplied slug carrying a
        // scheme prefix, a URN type marker at the start, or a `::` hierarchy
        // separator BEFORE the write, so a bad value can never be persisted.
        if (/^(hrn|urn|memory|agent|app|node|org):|::/.test(urn)) {
          throw new GraphQLError(
            `Invalid memory slug "${urn}": expected a bare slug (e.g. "experiments"), not a full or prefixed URN.`,
            { extensions: { code: 'BAD_USER_INPUT' } },
          );
        }
        // #574: slugify an explicit client slug (lowercase, illegal chars → '-').
        const slug = deriveSlugFromName(urn);
        newUrn = `${org.urn}:${slug}`;
      }

      // 033 US5 FR-026 — enabling the vector index on an encrypted memory
      // requires explicit acknowledgment of the embedding-inversion
      // disclosure (stored vectors are plaintext + partially invertible —
      // see FR_026_DISCLOSURE in src/lib/entityRef/errors.ts for the full
      // four-point text). The friendly typed error fires at the API
      // boundary; the chk_memory_vector_encrypted_ack CHECK is the DB-level
      // backstop.
      //
      // Gate fires only when this call would enable the index AND the row
      // is encrypted AND no prior ack timestamp is recorded.
      //
      // ── First-ack-is-permanent (intentional; PR-222 review item 3) ──
      // `vectorIndexEncryptedAckAt` survives a revoke + re-enable cycle.
      // Once a user has acked, future toggles never re-prompt. The audit-
      // relevant moment is the FIRST opt-in. If the disclosure copy ever
      // changes materially, audit semantics would need an explicit
      // re-consent flow (e.g., bump a disclosure-version column and clear
      // ackAt when the version bumps) — but that's deliberately deferred
      // until/unless the copy actually changes. DO NOT "fix" this by
      // clearing ackAt on revoke without product sign-off; the current
      // semantic is the explicit choice.
      let nextAckAt: Date | undefined;
      const willBeEnabled = vectorIndexEnabled === true ||
        (vectorIndexEnabled === undefined && memory.vectorIndexEnabled);
      const enablingNow = willBeEnabled && !memory.vectorIndexEnabled;
      if (memory.isEncrypted && enablingNow && memory.vectorIndexEncryptedAckAt == null) {
        if (acknowledgeVectorInversionRisk !== true) {
          throw new EncryptedVectorIndexNotAcknowledgedError(memory.urn);
        }
        nextAckAt = new Date();
      }

      // 033 US2 T043 — chunk dial validation (FR-003). Same invariants
      // the chk_memory_chunk_tokens_positive / chk_memory_chunk_overlap_valid
      // CHECK constraints enforce at the DB level; this is the friendly
      // typed error at the API boundary. Compute effective post-update
      // values so partial updates (just chunkTokens, just chunkOverlap)
      // still validate against the row's settled state.
      //
      // PR-225 review (Gemini med + Copilot): when either dial is null in
      // the post-update state, the runtime treats null as "platform
      // default" (512 tokens / 64 overlap; see src/lib/chunking.ts).
      // Validation MUST resolve to those defaults too, otherwise an
      // input like `chunkOverlap: 600` with `chunkTokens: null` would
      // slip past the API and crash at the DB CHECK with a 500.
      const DEFAULT_TOKENS_FOR_VALIDATION = 512;
      const DEFAULT_OVERLAP_FOR_VALIDATION = 64;
      const effectiveTokens = chunkTokens !== undefined ? chunkTokens : memory.chunkTokens;
      const effectiveOverlap = chunkOverlap !== undefined ? chunkOverlap : memory.chunkOverlap;
      if (effectiveTokens !== null && effectiveTokens !== undefined && effectiveTokens <= 0) {
        throw new InvalidChunkConfigError(`chunkTokens must be > 0 (got ${effectiveTokens}).`);
      }
      const resolvedTokens = effectiveTokens ?? DEFAULT_TOKENS_FOR_VALIDATION;
      const resolvedOverlap = effectiveOverlap ?? DEFAULT_OVERLAP_FOR_VALIDATION;
      if (resolvedOverlap < 0 || resolvedOverlap >= resolvedTokens) {
        throw new InvalidChunkConfigError(
          `chunkOverlap must satisfy 0 <= chunkOverlap < chunkTokens (effective: overlap=${resolvedOverlap}, tokens=${resolvedTokens}).`,
        );
      }

      // #1079 — the rename and its alias record commit together. This is the
      // WIDEST arm of the fix: a node URN carries its memory's slug, so before
      // the alias map a single memory rename orphaned every published node URN
      // beneath it — the platform's most-cited identifier, and the one this
      // project's own docs, specs and chat archives are written in.
      const updated = await ctx.db.$transaction(async (tx) => {
        // Lock and RE-READ the urn inside the transaction (PR #1080 review,
        // Codex + Copilot P2). The row above was read before the transaction
        // opened, so two concurrent renames could both record the SAME old urn
        // and the intermediate identity — committed, and returned to whoever
        // made the first call — would never be aliased at all. Reading under
        // FOR UPDATE serializes the renames and makes each one record the urn it
        // actually superseded. `updateOrganization` already did this; the three
        // single-entity paths did not.
        const [lockedRow] = await tx.$queryRaw<{ urn: string; organizationId: string | null }[]>`
          SELECT urn, organization_id AS "organizationId" FROM memories WHERE id = ${id} FOR UPDATE
        `;
        const lockedMemory = await tx.memory.findUniqueOrThrow({ where: { id } });
        const txCtx = withoutRequestCaches(ctx, tx);
        await concealUnreadableDenial(txCtx, id, ref, () => requireMemoryManageAccess(txCtx, lockedMemory));
        // Calculations above used the pre-transaction owner and class. A
        // concurrent transfer can change both before this row lock is taken.
        // Refuse that stale computation even when the caller also manages the
        // new tenant; they can retry against the settled row.
        if (
          lockedMemory.organizationId !== memory.organizationId ||
          lockedMemory.ownerUserId !== memory.ownerUserId ||
          lockedMemory.userId !== memory.userId ||
          lockedMemory.class !== memory.class
        ) {
          throw new GraphQLError('Memory ownership changed during update; retry.', {
            extensions: { code: 'CONFLICT' },
          });
        }
        if (newOrgId != null && newOrgId !== lockedRow?.organizationId) {
          throw new GraphQLError('Use transferMemoryOwnership to change a memory owner.', {
            extensions: { code: 'USE_TRANSFER_MEMORY_OWNERSHIP' },
          });
        }
        // #1641 §3.2 — no git mirror on a memory holding a decision log: a
        // mirror could forge decisions. Under this row's FOR UPDATE, which
        // createDecisionLog's FOR SHARE anchor waits on (and vice versa), so a
        // concurrent attach and log creation cannot both succeed.
        if (source != null && (await memoryHoldsDecisionLog(tx, id))) {
          throw decisionError('DECISION_LOG_MIRRORED', 'This memory holds a decision log, so it cannot be git-mirrored.', { memoryId: id });
        }
        if (newUrn !== undefined) {
          await recordUrnRename(tx, {
            entityType: 'MEMORY',
            entityId: id,
            // Recorded verbatim: the `urn` column already holds the normalized
            // lookup form the resolvers query.
            oldUrn: lockedRow?.urn ?? memory.urn,
            newUrn,
            createdBy: ctx.userId ?? ctx.clientId ?? null,
          });
        }
        const row = await tx.memory.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(newUrn !== undefined ? { urn: newUrn } : {}),
          ...(shortDescription !== undefined ? { shortDescription } : {}),
          ...(description !== undefined ? { description } : {}),
          // Free-form metadata bag. undefined leaves the stored value
          // untouched; explicit null CLEARS it (same contract as Node.data /
          // Edge.data — #263).
          ...(data !== undefined ? { data: data as InputJsonValue } : {}),
          ...(schema !== undefined ? { schema: schemaValue as InputJsonValue } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(license !== undefined ? { license } : {}),
          ...(category0 !== undefined ? { category0 } : {}),
          ...(category1 !== undefined ? { category1 } : {}),
          ...(category2 !== undefined ? { category2 } : {}),
          ...(iconUrl !== undefined ? { iconUrl } : {}),
          ...(heroUrl !== undefined ? { heroUrl } : {}),
          ...(homeUrl !== undefined ? { homeUrl } : {}),
          ...(source !== undefined ? { source } : {}),
          ...(readBranch !== undefined ? { readBranch } : {}),
          ...(writeBranch !== undefined ? { writeBranch } : {}),
          ...(visibility !== undefined ? { visibility: visibility as MemoryVisibility } : {}),
          // cor:acl:080:04 — opt-in marketplace catalogue flag (advertisement,
          // not access; independent of visibility). NOT NULL column: an explicit
          // null is treated like an omitted arg (no change), not a NULL write.
          ...(listedOnMarketplace != null ? { listedOnMarketplace } : {}),
          // 033 — vector-index config. The chk_memory_vector_encrypted_ack CHECK
          // constraint blocks enabling on an encrypted memory without the
          // disclosure ack; the resolver-level gate above is the friendly
          // typed-error wrapper.
          ...(vectorIndexEnabled !== undefined ? { vectorIndexEnabled } : {}),
          ...(embeddingSource !== undefined ? { embeddingSource } : {}),
          ...(nextAckAt !== undefined ? { vectorIndexEncryptedAckAt: nextAckAt } : {}),
          // 033 US2 — chunk dials. Validated above against the effective
          // post-update state.
          ...(chunkTokens !== undefined ? { chunkTokens } : {}),
          ...(chunkOverlap !== undefined ? { chunkOverlap } : {}),
          ...(forceFixedSize !== undefined ? { forceFixedSize } : {}),
          // #621 — per-node revision cap. `null` is guarded out above (column
          // is NOT NULL); only a concrete >= 1 value is written.
          ...(maxRevCount != null ? { maxRevCount } : {}),
        },
        include: MEMORY_INCLUDE,
        });
        // #1349 (@codex, PR #1357) — inside the SAME transaction as the
        // visibility write, so a memory can never be non-PUBLIC while the
        // foreign links that only PUBLIC justified are still live.
        // Fires on a visibility change and classifies against `row` — the
        // post-update state (@codex, PR #1357). Owner transfers use the
        // dedicated mutation and cannot reach this path.
        // PINNED (harness #24): removing this re-check fails "a concurrent
        // narrowing and agent publication cannot both win". An earlier note here
        // called it unproven; later tests staged the interleaving — a
        // publication committing between the pre-transaction check above and
        // this row lock — which would otherwise leave a PUBLIC agent referencing
        // knowledge this call makes non-public (cor:acl:080:03).
        if (visibility !== undefined) {
          await assertMemoryVisibilityChangeAllowed(tx, row, visibility);
        }
        if (visibility !== undefined) {
          await revokeLinksForeignToTenant(tx, row, ctx.userId ?? ctx.clientId ?? null);
        }
        return row;
      });

      // 033 — react to vector-index config changes (FR-004/FR-008/FR-026):
      const nowEnabled = updated.vectorIndexEnabled;
      const wasEnabled = memory.vectorIndexEnabled;
      const sourceChanged =
        embeddingSource !== undefined && embeddingSource !== memory.embeddingSource;
      // 033 US2 FR-004 — chunk dial changes also count as a re-index trigger
      // (the existing chunks would otherwise drift from the new boundaries).
      // PR-225 review (Copilot): gate this trigger on the post-update
      // effective embeddingSource actually using chunks — tweaking chunk
      // dials on an abstract-only memory shouldn't force a full re-embed.
      const effectiveSource = updated.embeddingSource;
      const sourceUsesChunks =
        effectiveSource === 'contentChunks' || effectiveSource === 'both';
      const chunkDialsChanged =
        (chunkTokens !== undefined && chunkTokens !== memory.chunkTokens) ||
        (chunkOverlap !== undefined && chunkOverlap !== memory.chunkOverlap) ||
        (forceFixedSize !== undefined && forceFixedSize !== memory.forceFixedSize);
      const chunkConfigChanged = chunkDialsChanged && sourceUsesChunks;
      if (updated.class === 'system') {
        // #2199 (cor:rag:010:01 r17): a system memory's summary index cannot be switched off, so the setting and the
        // source only add or drop PASSAGES. Summary vectors survive every change; only chunk rows are managed.
        const wasChunks = embeddingKindsWanted(memory).chunks;
        const nowChunks = embeddingKindsWanted(updated).chunks;
        if (wasChunks && !nowChunks) {
          await deleteMemoryChunkVectors(ctx.db, id);
        } else if (nowChunks && (!wasChunks || sourceChanged || chunkConfigChanged)) {
          if (wasChunks) await deleteMemoryChunkVectors(ctx.db, id); // dials/source moved the boundaries
          await backfillMemoryEmbeddings(ctx.db, id);
        }
        return updated;
      }
      if (nowEnabled && (!wasEnabled || sourceChanged || chunkConfigChanged)) {
        // When the source itself changes (abstract ↔ contentChunks ↔ both),
        // the previously-stored vectors are now the wrong KIND. vectorSearch
        // doesn't filter by kind today, so leaving them would mix stale
        // vectors of the old kind with whatever the backfill produces.
        // Drop everything first; the backfill re-stamps every node and the
        // sweep re-embeds against the new source (PR-219 review).
        //
        // Chunk-config changes (033 US2 FR-004): the existing chunk vectors
        // were sliced under the OLD chunkTokens / chunkOverlap / forceFixedSize
        // values. New dials produce different boundaries — the sweep will
        // re-derive chunks per the new config, so we drop the old chunk
        // vectors before backfill (preserving abstract vectors when source
        // is `abstract` or `both` would be a bigger change; the simpler
        // shape is "any reconfig triggers a full re-index" matching the
        // sourceChanged path).
        if (sourceChanged || chunkConfigChanged) {
          await deleteMemoryVectors(ctx.db, id);
        }
        // Enabled or re-sourced → backfill: stamp every live node pending.
        await backfillMemoryEmbeddings(ctx.db, id);
      } else if (!nowEnabled && wasEnabled) {
        // Disabled → drop stored vectors and clear markers.
        await deleteMemoryVectors(ctx.db, id);
        await ctx.db.node.updateMany({
          where: { memoryId: id },
          data: {
            embeddingPendingAt: null,
            embeddingWorkToken: null,
            embeddingFailedAt: null,
            embeddingError: null,
            embeddingAttempts: 0,
          },
        });
      }
      return updated;
    },

    /**
     * #882 — re-drive every failed embed in a memory (the operator recovery
     * surface; previously a hand-written SQL re-stamp). Same gate as
     * updateMemory: strict owner for personal/private, otherwise tenant owner
     * or org-ADMIN. Returns the count re-stamped;
     * 0 (without stamping) when the memory isn't vector-indexed, so the
     * mutation can't queue work the worker would only discard.
     */
    retryFailedEmbeddings: async (
      _: unknown,
      { memoryRef }: { memoryRef: string },
      ctx: Context,
    ) => {
      const { id: memoryId } = await resolveMemoryRef(ctx.db, memoryRef);
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: memoryId } });
      // #1316: a caller who cannot open the memory's record is denied as if
      // it were missing (MEMORY_NOT_FOUND); one who can keeps the Forbidden.
      await concealUnreadableDenial(ctx, memory.id, memoryRef, () =>
        requireMemoryManageAccess(ctx, memory),
      );
      const count = await ctx.db.$transaction(async (tx) => {
        // Ownership transfer also locks this row. Recheck after any wait so a
        // former manager cannot restamp the receiving tenant's nodes.
        await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR UPDATE`;
        const current = await tx.memory.findUniqueOrThrow({ where: { id: memoryId } });
        if (current.deletedAt) throw new MemoryNotFoundError(memoryRef);
        const txCtx = withoutRequestCaches(ctx, tx);
        await concealUnreadableDenial(txCtx, memoryId, memoryRef, () =>
          requireMemoryManageAccess(txCtx, current),
        );
        if (!memoryIsVectorIndexed(current)) return 0;
        return restampFailedEmbeddings(tx, memoryId);
      });
      if (count > 0) void publishEmbedWake({});
      return count;
    },

    deleteMemory: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      // includeDeleted: a re-delete on an already-soft-deleted memory must
      // return true (FR-014 idempotency). The default resolveMemoryRef
      // would throw MemoryNotFoundError on the second call.
      const { id: resolvedId } = await resolveMemoryRef(ctx.db, id, { includeDeleted: true });
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedId } });
      // Spec 013: class-aware authz. Personal-class memories have a single
      // owner in Memory.userId. The chk_personal_visibility_user CHECK
      // constraint enforces class IN (personal,private) ⇔ userId IS NOT NULL
      // (re-keyed onto class by spec 034; visibility is NULL for these).
      // Only the owner deletes — matches parent constitution Invariant 13.
      // Private-class memories (added 2026-05-24) follow the same
      // single-owner delete rule. All other classes (system/app/knowledge/
      // group) gate on org-admin role on the parent org. Authz runs first
      // so unauthorized callers can't probe row state via the system-memory
      // guard or idempotency short-circuit.
      // #1381: a caller who cannot open this memory gets resolveMemoryRef's
      // miss — the owner-only refusals below also named the memory's class.
      const authorizeDelete = (authCtx: Context, current: typeof memory) =>
        concealUnreadableDenial(authCtx, resolvedId, id, async () => {
          if (isInstallMemoryRow(current)) {
            // #2044, R45: whoever manages the App (its owner, an OWNER-role member,
            // an org admin) deletes its install memory by hand, also after the App
            // was soft-deleted. Not content access: the record is all this opens.
            if (!(await installDeleteAllowed(authCtx, current))) {
              throw forbiddenError('Forbidden: only whoever manages the App can delete its install memory');
            }
            return;
          }
          if (current.class === 'personal' || current.class === 'private') {
            if (!authCtx.userId || current.userId !== authCtx.userId) {
              throw forbiddenError(`Forbidden: only the owner can delete a ${current.class} memory`);
            }
          } else if (current.ownerUserId !== null) {
            // spec 047: a user-owned memory is deletable only by its owner.
            if (authCtx.userId !== current.ownerUserId) {
              throw forbiddenError('Forbidden: only the owner can delete this memory');
            }
          } else {
            // Org-owned (the XOR CHECK guarantees ownerUserId is null here ⇒ org is
            // set); assert it explicitly rather than fall back to an empty org id.
            if (current.organizationId === null) {
              throw new Error('Invariant: org-owned memory has no organizationId');
            }
            // Grant-model gate (design:grant-model P2a) — was requireOrgRole(ADMIN).
            await requireOrgAction(authCtx, current.organizationId, 'memory.delete');
          }
        });
      await authorizeDelete(ctx, memory);
      // System-class memories are owned by their agent and can only be
      // removed by deleting the agent. This prevents the agent from ending
      // up with no brain via a stray deleteMemory call.
      if (memory.class === 'system' && !isInstallMemoryRow(memory)) {
        throw new Error('Cannot delete an agent system memory directly. Delete the owning agent instead.');
      }
      await ctx.db.$transaction(async (tx) => {
        // #2044: an install memory's authority before the memory row lock below.
        await lockInstallAuthorityFirst(tx, ctx, resolvedId);
        // Spec 049 §8.5: a memory hosting a live Channel is not deleted around
        // the Channel — delete the Channel through its own operation first.
        // Checked and tombstoned under the memory-level lock Channel creation
        // also takes (`lockMemoryForChannelChange`), so a Channel cannot land
        // between the check and the tombstone (Copilot on PR #1165, round 2).
        await lockMemoryForChannelChange(tx, resolvedId);
        // A transfer can commit after the first authorization and before this
        // transaction starts. Lock and recheck the current owner before the
        // tombstone write; the pre-transfer caller must not delete the new
        // tenant's memory after waiting on the row.
        await tx.$queryRaw`SELECT id FROM memories WHERE id = ${resolvedId} FOR UPDATE`;
        const current = await tx.memory.findUniqueOrThrow({ where: { id: resolvedId } });
        await authorizeDelete({ ...ctx, db: tx } as Context, current);
        if (current.class === 'system' && !isInstallMemoryRow(current)) {
          throw new Error('Cannot delete an agent system memory directly. Delete the owning agent instead.');
        }
        const hosted = await tx.channel.findFirst({
          where: { memoryId: resolvedId, deletedAt: null },
          select: { id: true, name: true, loc: true },
        });
        if (hosted) {
          throw new GraphQLError(
            `This memory hosts Channel "${hosted.name}" (${hosted.loc}); delete the Channel first (deleteChannel).`,
            { extensions: { code: 'MEMORY_HOSTS_CHANNEL', channelId: hosted.id } },
          );
        }
        // Spec 013 FR-014: idempotency. A re-delete on an already-soft-deleted
        // memory returns true without overwriting the original deletedAt. The
        // conditional updateMany closes the read-then-write race so deletedAt is
        // set once. Secrets are org/user-owned only (#696), so there are no
        // memory-scoped secrets to sweep here anymore.
        //
        // #1468 — deleting a mint-stamped corpus removes every spec in it.
        // FOR UPDATE, not the update's own NO KEY UPDATE (Codex on #1475):
        // it conflicts with the FK KEY SHARE every node insert or move-in
        // takes and with the FOR SHARE a write takes when it marks a spec
        // (lockMintedSpecUnmarks), so no spec can appear between the scan
        // below and the tombstone. The guard's FOR SHARE re-enters. A
        // re-delete removes nothing, so it stays idempotent and unguarded.
        const [row] = await tx.$queryRaw<Array<{ deleted_at: Date | null }>>`
          SELECT deleted_at FROM memories WHERE id = ${resolvedId} FOR UPDATE`;
        if (row && row.deleted_at === null) {
          await assertNoMintedCorpusRemoval(tx, resolvedId, 'delete the corpus', { includeTombstones: false });
        }
        await tx.memory.updateMany({
          where: { id: resolvedId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
      });
      return true;
    },

    cloneMemory: async (
      _: unknown,
      { ref, targetUrn }: { ref: string; targetUrn: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: ref may be ID, bare URN, or prefixed URN
      // (conventions:ref-param-naming — bare `ref` since the memory is the
      // obvious entity).
      const { id: sourceId } = await resolveMemoryRef(ctx.db, ref);
      const source = await ctx.db.memory.findUniqueOrThrow({ where: { id: sourceId } });

      // Source-side authz mirrors deleteMemory: personal/private are
      // owner-only; org-shared classes gate on the SOURCE org's ADMIN. Authz
      // runs first so unauthorized callers can't probe class/encryption state.
      // #1316: and a caller who cannot even open the source's record is denied
      // as if it were missing (MEMORY_NOT_FOUND), so the denial itself does not
      // disclose that the memory exists; one who can keeps the Forbidden.
      await concealUnreadableDenial(ctx, source.id, ref, async () => {
        if (source.class === 'personal' || source.class === 'private') {
          if (!ctx.userId || source.userId !== ctx.userId) {
            throw new GraphQLError(
              `Forbidden: only the owner can clone a ${source.class} memory`,
              { extensions: { code: 'FORBIDDEN' } },
            );
          }
        } else if (source.ownerUserId !== null) {
          // spec 047: a user-owned source memory is cloneable only by its owner.
          if (ctx.userId !== source.ownerUserId) {
            throw forbiddenError('Forbidden: only the owner can clone this memory');
          }
        } else {
          // Org-owned (XOR ⇒ org set here); assert rather than fall back to ''.
          if (source.organizationId === null) {
            throw new Error('Invariant: org-owned memory has no organizationId');
          }
          // Grant-model gate (design:grant-model P2a) — was requireOrgRole(ADMIN).
          // A memory.clone PrincipalGrant now lets a specific non-admin member
          // clone; the cross-org DESTINATION gate below is unchanged (#604).
          await requireOrgAction(ctx, source.organizationId, 'memory.clone');
        }
      });
      // system/app-class memories auto-provision via the agent/install
      // paths (same rationale as createMemory rejecting these classes) —
      // a free-standing clone would violate their pivot invariants
      // (chk_memory_class_app_id) or duplicate an agent's brain.
      if (source.class === 'system' || source.class === 'app') {
        throw new GraphQLError(
          `cloneMemory does not accept a class='${source.class}' source. ` +
            `Only 'knowledge', 'group', 'personal', and 'private' memories can be cloned.`,
          { extensions: { code: 'UNSUPPORTED_MEMORY_CLASS' } },
        );
      }
      // v1: encrypted sources are rejected — the URN rewrite needs
      // plaintext, and a clone would need its own encryption envelope +
      // session-key flow. Follow-up if/when needed.
      if (source.isEncrypted) {
        throw new GraphQLError(
          'cloneMemory does not support encrypted memories yet.',
          { extensions: { code: 'ENCRYPTED_MEMORY_CLONE_UNSUPPORTED' } },
        );
      }
      // Group-class clones bootstrap the caller as first owner, which
      // needs an authenticated user (matches createMemory).
      if (source.class === 'group' && !ctx.userId) {
        throw new GraphQLError(
          'Cloning a group-class memory requires an authenticated user (the caller becomes the first owner).',
          { extensions: { code: 'UNAUTHENTICATED' } },
        );
      }

      // #604: the destination is a fully-qualified target URN — it encodes the
      // clone's org AND slug, so a clone can land in a DIFFERENT org. Require a
      // `<org>::<slug>` shape (exactly two hierarchy segments); deeper per-user
      // shapes aren't valid clone destinations.
      assertFullyQualifiedUrn(targetUrn, 'memory');
      // parseUrn requires a scheme prefix; assertFullyQualifiedUrn accepts the
      // bare canonical form (`<org>::<slug>`), so prefix bare input before the
      // structured parse.
      const prefixedTarget = hasSchemePrefix(targetUrn) ? targetUrn : `hrn:memory:${targetUrn}`;
      const parsedTarget = parseUrn(prefixedTarget); // typed throw on bad grammar
      if (parsedTarget.pathSegments.length !== 2) {
        throw new GraphQLError(
          `cloneMemory targetUrn must be a fully-qualified "<org>::<slug>" memory URN (got "${targetUrn}").`,
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }
      const [targetOrgSlug, targetSlug] = parsedTarget.pathSegments;
      // Reject uppercase / reserved-word slugs at the CREATE boundary (the
      // parser is case-lenient on read; a new slug must be lowercase + legal).
      validateUserSlug(targetSlug);

      // Resolve + confirm the target org exists (throws OrganizationNotFound).
      const { id: targetOrgId } = await resolveOrgRef(ctx.db, `hrn:org:${targetOrgSlug}`);
      const targetOrg = await ctx.db.organization.findUniqueOrThrow({
        where: { id: targetOrgId },
        select: { urn: true },
      });

      // Cross-org gate (#604): dropping a memory into a DIFFERENT org requires
      // the caller to be an ACTUAL member of the target org whose role is not
      // READER. findFirst + deletedAt:null so a revoked membership can't
      // authorize (findings:revoked-membership-auth-gates); no global-role
      // bypass — "member and not read-only" means real membership.
      if (targetOrgId !== source.organizationId) {
        if (!ctx.userId) {
          throw new GraphQLError(
            'Cloning into another organization requires an authenticated user.',
            { extensions: { code: 'UNAUTHENTICATED' } },
          );
        }
        const membership = await ctx.db.orgMember.findFirst({
          where: { organizationId: targetOrgId, userId: ctx.userId, ...LIVE_ORG_MEMBERSHIP },
        });
        if (!membership || membership.role === 'READER') {
          throw new GraphQLError(
            'Forbidden: cloning into an organization requires a non-reader membership there.',
            { extensions: { code: 'FORBIDDEN' } },
          );
        }
      }

      const newUrn = `${targetOrg.urn}:${targetSlug}`;
      // The clone's display name is derived from the target slug (the arg that
      // named it), matching the URN the caller asked for.
      const name = targetSlug;
      // URN collision handling matches createMemory: a soft-deleted holder
      // is hard-deleted, a live one is an error.
      const existing = await ctx.db.memory.findUnique({ where: { urn: newUrn } });
      if (existing) {
        if (existing.deletedAt) {
          // #1468 — refused for a stamped corpus still holding a spec.
          await ctx.db.$transaction((tx) => reclaimTombstonedMemory(tx, existing.id));
        } else {
          throw new Error(`A memory with URN "${newUrn}" already exists`);
        }
      }

      const isUserOwned = source.class === 'personal' || source.class === 'private';
      const { memoryId } = await cloneMemoryGraph(ctx.db, {
        sourceMemoryId: source.id,
        name,
        newUrn,
        targetOrganizationId: targetOrgId,
        // chk_personal_visibility_user: owner set iff personal/private.
        ownerUserId: isUserOwned ? ctx.userId! : null,
        groupOwnerUserId: source.class === 'group' ? (ctx.userId ?? null) : null,
        actorId: ctx.userId ?? ctx.clientId ?? null,
        // #2167 — every copied include tag is checked against the copier's reads.
        copierReadableMemoryIds: await getAccessibleMemoryIds(ctx),
      });

      // 033 — the clone carries the source's vector-index config but no
      // vectors; stamp every node pending so the sweep (or prompt-drain on
      // future writes) re-embeds the rewritten content.
      if (source.vectorIndexEnabled) {
        await backfillMemoryEmbeddings(ctx.db, memoryId);
      }

      return ctx.db.memory.findUniqueOrThrow({
        where: { id: memoryId },
        include: MEMORY_INCLUDE,
      });
    },

    extractParentNodeToMemory: async (
      _: unknown,
      { parentRef, targetUrn, move: rawMove }: { parentRef: string; targetUrn: string; move?: boolean | null },
      ctx: Context,
    ) => {
      const move = rawMove ?? false;

      // Resolve the parent node (PK or fully-qualified URN). A miss surfaces as
      // NODE_NOT_FOUND rather than a raw resolver throw.
      let parentId: string;
      try {
        ({ id: parentId } = await resolveNodeRefForCaller(ctx, parentRef));
      } catch (e) {
        if (e instanceof NodeNotFoundError) {
          throw new GraphQLError(`Node not found: "${parentRef}"`, {
            extensions: { code: 'NODE_NOT_FOUND', ref: parentRef },
          });
        }
        throw e;
      }
      const parent = await ctx.db.node.findUniqueOrThrow({ where: { id: parentId } });
      const source = await ctx.db.memory.findUniqueOrThrow({ where: { id: parent.memoryId } });

      // A node can outlive its memory's soft-delete — deleteMemory only
      // tombstones the Memory row, and resolveNodeRef filters the node row, not
      // its memory. Treat an extract from a tombstoned source as not-found so a
      // stale node id can't resurrect deleted content into a new live memory.
      if (source.deletedAt) {
        throw new GraphQLError(`Node not found: "${parentRef}"`, {
          extensions: { code: 'NODE_NOT_FOUND', ref: parentRef },
        });
      }

      // Reading the subtree's content requires read access to the source — a
      // URN-widened parentRef must not become a cross-tenant exfiltration path
      // (review:entity-ref-args #3). Denial reads as not-found (no oracle).
      if (!(await canReadMemory(ctx.db, ctx, source.id))) {
        throw new GraphQLError(`Node not found: "${parentRef}"`, {
          extensions: { code: 'NODE_NOT_FOUND', ref: parentRef },
        });
      }

      // v1 gating mirrors cloneMemory: encrypted sources need a cross-key
      // re-encrypt of the moved content (a separate follow-up); system/app
      // sources auto-provision and carry pivot invariants a free-form extract
      // would violate.
      if (source.isEncrypted) {
        throw new GraphQLError(
          'extractParentNodeToMemory does not support encrypted memories yet.',
          { extensions: { code: 'ENCRYPTED_MEMORY_EXTRACT_UNSUPPORTED', memoryId: source.id } },
        );
      }
      if (source.class === 'system' || source.class === 'app') {
        throw new GraphQLError(
          `extractParentNodeToMemory does not accept a class='${source.class}' source. ` +
            `Only 'knowledge', 'group', 'personal', and 'private' memories can be extracted from.`,
          { extensions: { code: 'UNSUPPORTED_MEMORY_CLASS', memoryId: source.id, memoryClass: source.class } },
        );
      }

      // A move must leave at least one live node OUTSIDE the subtree, else it
      // empties the source (and orphans its root). Checked by node set, NOT by
      // `parent.loc === source.name`: Memory.name is mutable (updateMemory) and
      // a rename does not rename the root node loc, so a name-based guard is
      // wrong both ways (misses a renamed root, false-flags a node at the new
      // name). Rename-proof — the survivor query doesn't reference the name.
      if (move) {
        const survivor = await ctx.db.node.findFirst({
          where: {
            memoryId: source.id,
            deletedAt: null,
            NOT: { OR: [{ loc: parent.loc }, { loc: { startsWith: `${parent.loc}:` } }] },
          },
          select: { id: true },
        });
        if (!survivor) {
          throw new GraphQLError(
            'extractParentNodeToMemory: this move would empty the source memory (no live node remains ' +
              'outside the subtree). Use cloneMemory + deleteMemory, or extract a child subtree.',
            { extensions: { code: 'BAD_USER_INPUT', memoryId: source.id, parentLoc: parent.loc } },
          );
        }
      }

      // ── Destination URN → org + slug (mirrors cloneMemory) ───────────────
      assertFullyQualifiedUrn(targetUrn, 'memory');
      const prefixedTarget = hasSchemePrefix(targetUrn) ? targetUrn : `hrn:memory:${targetUrn}`;
      const parsedTarget = parseUrn(prefixedTarget);
      if (parsedTarget.pathSegments.length !== 2) {
        throw new GraphQLError(
          `extractParentNodeToMemory targetUrn must be a fully-qualified "<org>::<slug>" memory URN (got "${targetUrn}").`,
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }
      const [targetOrgSlug, targetSlug] = parsedTarget.pathSegments;
      validateUserSlug(targetSlug);
      const { id: targetOrgId } = await resolveOrgRef(ctx.db, `hrn:org:${targetOrgSlug}`);
      const targetOrg = await ctx.db.organization.findUniqueOrThrow({
        where: { id: targetOrgId },
        select: { urn: true },
      });

      // ── Class of the NEW memory + authorization ──────────────────────────
      // The new memory PRESERVES the source's class so an extract never widens
      // who can read the content: a member-restricted `group` stays group,
      // personal/private stay owner-owned, knowledge stays knowledge.
      const isUserOwned = source.class === 'personal' || source.class === 'private';
      const isGroup = source.class === 'group';
      const newClass = source.class; // system/app already rejected above

      if (isUserOwned) {
        // canReadMemory already proved ctx.userId is the owner. The new memory
        // must land in an org the owner actually belongs to (NOT requireOrgAction,
        // whose global-admin bypass would let a platform admin drop it into an
        // org they don't belong to — matches createMemory's personal path).
        if (!ctx.userId) {
          throw new GraphQLError(
            'Extracting a personal/private subtree requires an authenticated user (the owner).',
            { extensions: { code: 'UNAUTHENTICATED' } },
          );
        }
        const membership = await ctx.db.orgMember.findFirst({
          where: { organizationId: targetOrgId, userId: ctx.userId, ...LIVE_ORG_MEMBERSHIP },
        });
        if (!membership) {
          throw new GraphQLError(
            'You must be a member of the organization to extract a personal/private subtree into it.',
            { extensions: { code: 'FORBIDDEN' } },
          );
        }
      } else {
        // A group extract bootstraps the caller as first owner → needs a user.
        if (isGroup && !ctx.userId) {
          throw new GraphQLError(
            'Extracting a group-class subtree requires an authenticated user (the caller becomes the first owner).',
            { extensions: { code: 'UNAUTHENTICATED' } },
          );
        }
        // Source-side gate at clone parity (design:grant-model P2a): copying a
        // subtree out is an export, so hold the SOURCE org's memory.clone grant
        // — canReadMemory alone would let a bare reader exfiltrate. cloneMemory
        // gates the same way. spec 047: a user-owned source is gated by its owner.
        if (source.ownerUserId !== null) {
          if (ctx.userId !== source.ownerUserId) {
            throw forbiddenError('Forbidden: only the owner can copy from this memory');
          }
        } else {
          // Org-owned (XOR ⇒ org set here); assert rather than fall back to ''.
          if (source.organizationId === null) {
            throw new Error('Invariant: org-owned memory has no organizationId');
          }
          await requireOrgAction(ctx, source.organizationId, 'memory.clone');
        }
        // Target-side create grant (same as createMemory).
        await requireOrgAction(ctx, targetOrgId, 'memory.create');
        // Cross-org drop requires an ACTUAL non-reader membership of the target
        // org (mirrors cloneMemory #604; findFirst + deletedAt:null so a revoked
        // membership can't authorize).
        if (targetOrgId !== source.organizationId) {
          if (!ctx.userId) {
            throw new GraphQLError(
              'Extracting into another organization requires an authenticated user.',
              { extensions: { code: 'UNAUTHENTICATED' } },
            );
          }
          const membership = await ctx.db.orgMember.findFirst({
            where: { organizationId: targetOrgId, userId: ctx.userId, ...LIVE_ORG_MEMBERSHIP },
          });
          if (!membership || membership.role === 'READER') {
            throw new GraphQLError(
              'Forbidden: extracting into an organization requires a non-reader membership there.',
              { extensions: { code: 'FORBIDDEN' } },
            );
          }
        }
      }

      // move soft-deletes the source subtree → write access to the source.
      if (move) {
        await requireMemoryWriteAccess(ctx, source.id);
      }

      // URN collision handling matches createMemory / cloneMemory.
      const newUrn = `${targetOrg.urn}:${targetSlug}`;
      const existing = await ctx.db.memory.findUnique({ where: { urn: newUrn } });
      if (existing) {
        if (existing.deletedAt) {
          // #1468 — refused for a stamped corpus still holding a spec.
          await ctx.db.$transaction((tx) => reclaimTombstonedMemory(tx, existing.id));
        } else {
          throw new Error(`A memory with URN "${newUrn}" already exists`);
        }
      }

      // The parent becomes the new memory's root — its rebased loc is the
      // slug (a valid loc), and the display name is the slug the caller chose.
      const vectorIndexEnabled = newClass === 'knowledge';
      const { memoryId } = await extractParentNodeGraph(ctx.db, {
        sourceMemoryId: source.id,
        parentLoc: parent.loc,
        newUrn,
        name: targetSlug,
        rootLoc: targetSlug,
        targetOrganizationId: targetOrgId,
        newClass,
        // 035: group carries GROUP visibility (chk_memory_group_visibility);
        // personal/private carry NULL; knowledge defaults ORGANIZATION.
        visibility: isGroup ? 'GROUP' : isUserOwned ? null : 'ORGANIZATION',
        ownerUserId: isUserOwned ? ctx.userId! : null,
        groupOwnerUserId: isGroup ? ctx.userId! : null,
        vectorIndexEnabled,
        move,
        actorId: ctx.userId ?? ctx.clientId ?? null,
        principal: ctx,
        // #2167 — every copied include tag is checked against the copier's reads.
        copierReadableMemoryIds: await getAccessibleMemoryIds(ctx),
      });

      // The extract carries the subtree's content but no vectors; stamp every
      // node pending so the sweep embeds it (no-op when not indexed).
      if (vectorIndexEnabled) {
        await backfillMemoryEmbeddings(ctx.db, memoryId);
      }

      return ctx.db.memory.findUniqueOrThrow({
        where: { id: memoryId },
        include: MEMORY_INCLUDE,
      });
    },

    setMemorySourceToken: async (
      _: unknown,
      { id, token, expiresAt }: { id: string; token: string; expiresAt?: string },
      ctx: Context,
    ) => {
      // #1381: resolve (typed miss, URN accepted) and conceal as updateMemory does.
      const ref = id;
      ({ id } = await resolveMemoryRef(ctx.db, ref));
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id } });
      await concealUnreadableDenial(ctx, id, ref, () => requireMemoryManageAccess(ctx, memory));
      const encrypted = encryptToken(token);
      return ctx.db.$transaction(async (tx) => {
        // A transfer must not land between the manage gate and the token write.
        await tx.$queryRaw`SELECT id FROM memories WHERE id = ${id} FOR UPDATE`;
        const current = await tx.memory.findUniqueOrThrow({ where: { id } });
        if (current.deletedAt) throw new MemoryNotFoundError(ref);
        const txCtx = withoutRequestCaches(ctx, tx);
        await concealUnreadableDenial(txCtx, id, ref, () => requireMemoryManageAccess(txCtx, current));
        return tx.memory.update({
          where: { id },
          data: {
            sourceTokenEncrypted: encrypted,
            sourceTokenExpiresAt: expiresAt ? new Date(expiresAt) : null,
          },
          include: MEMORY_INCLUDE,
        });
      });
    },

    // ── Agent management ──────────────────────────────────────────────────

    addMemoryToAgent: async (
      _: unknown,
      { agentRef, memoryRef, role }: { agentRef: string; memoryRef: string; role?: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentId and memoryId may be IDs, bare URNs,
      // or prefixed URNs. Resolve both to definite IDs before any
      // subsequent checks. #1944: the Agent through the read gate, so one
      // the caller can't read answers as absent.
      const agent = await resolveReadableAgentRef(ctx, agentRef);
      const resolvedAgentId = agent.id;
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryRef);
      await requireAgentAccess(ctx, agent, 'ADMIN');
      // #1349: the role is validated before anything is stored (the column is
      // a free String, so an unknown value used to persist as an inert grant)
      // — by the gate below, AFTER its concealment decision (@copilot, PR #1357).
      // #1349 — the gate and the write are ONE transaction, over locked rows
      // (see lockAttachmentPair). Everything the gate decides from — the
      // memory's visibility and tenancy, the agent's visibility — is re-read
      // under those locks, so no concurrent narrowing or publication can be
      // stale by the time the grant is persisted.
      let lockedPair: Awaited<ReturnType<typeof lockAttachmentPair>>;
      let grantedRole: Awaited<ReturnType<typeof requireAgentMemoryGrant>>;
      await withAuthorizedMemoryTx(
        ctx, resolvedMemoryId,
        [
          { kind: 'agent', id: resolvedAgentId },
          ...(agent.organizationId ? [{ kind: 'org' as const, id: agent.organizationId }] : []),
          ...(agent.ownerUserId ? [{ kind: 'user' as const, id: agent.ownerUserId }] : []),
        ],
        async (txCtx) => {
          if (lockedPair.agent.organizationId !== agent.organizationId ||
              lockedPair.agent.ownerUserId !== agent.ownerUserId) {
            throw new Error('Agent ownership changed; retry the operation');
          }
          await requireAgentAccess(txCtx, lockedPair.agent, 'ADMIN');
          grantedRole = await requireAgentMemoryGrant(txCtx, lockedPair.agent, lockedPair.memory, role, memoryRef);
        },
        async (tx) => {
          await tx.agentMemoryItem.upsert({
        where: { agentId_memoryId: { agentId: resolvedAgentId, memoryId: resolvedMemoryId } },
        create: {
          agentId: resolvedAgentId,
          memoryId: resolvedMemoryId,
          role: grantedRole,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
        update: {
          role: grantedRole,
          deletedAt: null,
          deletedBy: null,
          updatedAt: new Date(),
          updatedBy: ctx.userId ?? ctx.clientId ?? null,
        },
          });
        },
        { lockMode: 'exclusive', afterLock: async (tx) => {
          lockedPair = await lockAttachmentPair(tx, resolvedMemoryId, resolvedAgentId, { memoryRef, agentRef });
        } },
      );
      return ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId }, include: AGENT_INCLUDE });
    },

    updateAgentMemoryRole: async (
      _: unknown,
      { agentRef, memoryRef, role }: { agentRef: string; memoryRef: string; role: string },
      ctx: Context,
    ) => {
      // #1944: an Agent the caller can't read answers as absent.
      const agent = await resolveReadableAgentRef(ctx, agentRef);
      const resolvedAgentId = agent.id;
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryRef);
      await requireAgentAccess(ctx, agent, 'ADMIN');
      // #1349: re-role is its own escalation path — an existing `read` row
      // becomes the write cap here — so the NEW role gets the same memory-side
      // gate as a fresh attach, not merely the agent gate. The new role is
      // parsed by that gate, after its concealment decision (@copilot, PR #1357).
      // #1349 — gate and write in ONE transaction over locked rows, for the
      // same reason as addMemoryToAgent: a re-role to `read-write` racing an
      // `updateAgent(visibility: PUBLIC)` could otherwise leave a PUBLIC agent
      // holding write knowledge, with both guards having passed.
      let lockedPair: Awaited<ReturnType<typeof lockAttachmentPair>>;
      let grantedRole: Awaited<ReturnType<typeof requireAgentMemoryGrant>>;
      const updated = await withAuthorizedMemoryTx(
        ctx, resolvedMemoryId,
        [
          { kind: 'agent', id: resolvedAgentId },
          ...(agent.organizationId ? [{ kind: 'org' as const, id: agent.organizationId }] : []),
          ...(agent.ownerUserId ? [{ kind: 'user' as const, id: agent.ownerUserId }] : []),
        ],
        async (txCtx) => {
          if (lockedPair.agent.organizationId !== agent.organizationId ||
              lockedPair.agent.ownerUserId !== agent.ownerUserId) {
            throw new Error('Agent ownership changed; retry the operation');
          }
          await requireAgentAccess(txCtx, lockedPair.agent, 'ADMIN');
          grantedRole = await requireAgentMemoryGrant(txCtx, lockedPair.agent, lockedPair.memory, role, memoryRef);
        },
        async (tx) => {
      // #501: only a LIVE grant is updatable — updateMany + deletedAt:null
      // (findUnique on the composite PK can't filter soft-deletes; the
      // requireOrgRole-pattern rule from findings:revoked-membership-auth-
      // gates, PR-512 review). Zero rows = typed NOT_FOUND, never a raw
      // P2025 → 500; a soft-deleted grant stays inactive until
      // addMemoryToAgent resurrects it.
          return tx.agentMemoryItem.updateMany({
        where: { agentId: resolvedAgentId, memoryId: resolvedMemoryId, deletedAt: null },
        // #1349: stamp the actor. Before this the row recorded WHO escalated it
        // nowhere, so a later audit could not tell an original grant from a
        // re-role — which is what made a delegator-attribution containment
        // strategy unworkable.
        data: { role: grantedRole, updatedBy: ctx.userId ?? ctx.clientId ?? null },
          });
        },
        { lockMode: 'exclusive', afterLock: async (tx) => {
          lockedPair = await lockAttachmentPair(tx, resolvedMemoryId, resolvedAgentId, { memoryRef, agentRef });
        } },
      );
      if (updated.count === 0) {
        throw new GraphQLError(
          'No active grant exists for this agent+memory pair — use addMemoryToAgent to create one.',
          { extensions: { code: 'NOT_FOUND' } },
        );
      }
      return ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId }, include: AGENT_INCLUDE });
    },

    removeMemoryFromAgent: async (
      _: unknown,
      { agentRef, memoryRef }: { agentRef: string; memoryRef: string },
      ctx: Context,
    ) => {
      // #1944: an Agent the caller can't read answers as absent.
      const agent = await resolveReadableAgentRef(ctx, agentRef);
      const resolvedAgentId = agent.id;
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryRef);
      await requireAgentAccess(ctx, agent, 'ADMIN');
      let lockedPair: Awaited<ReturnType<typeof lockAttachmentPair>>;
      await withAuthorizedMemoryTx(
        ctx, resolvedMemoryId,
        [
          { kind: 'agent', id: resolvedAgentId },
          ...(agent.organizationId ? [{ kind: 'org' as const, id: agent.organizationId }] : []),
          ...(agent.ownerUserId ? [{ kind: 'user' as const, id: agent.ownerUserId }] : []),
        ],
        async (txCtx) => {
          if (lockedPair.agent.organizationId !== agent.organizationId ||
              lockedPair.agent.ownerUserId !== agent.ownerUserId) {
            throw new Error('Agent ownership changed; retry the operation');
          }
          await requireAgentAccess(txCtx, lockedPair.agent, 'ADMIN');
        },
        (tx) => tx.agentMemoryItem.delete({
          where: { agentId_memoryId: { agentId: resolvedAgentId, memoryId: resolvedMemoryId } },
        }).then(() => undefined),
        { lockMode: 'exclusive', afterLock: async (tx) => {
          lockedPair = await lockAttachmentPair(tx, resolvedMemoryId, resolvedAgentId, { memoryRef, agentRef });
        } },
      );
      return ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId }, include: AGENT_INCLUDE });
    },

    // ── Memory subscriptions ─────────────────────────────────────────────

    createMemorySubscription: async (
      _: unknown,
      {
        memoryRef,
        memoryId,
        orgRef,
        orgId,
        role,
      }: {
        memoryRef?: string | null;
        memoryId?: string | null;
        orgRef?: string | null;
        orgId?: string | null;
        role: string;
      },
      ctx: Context,
    ) => {
      // #764 (was 007-entity-id-or-urn): memoryRef/orgRef accept id / URN /
      // (org) handle. memoryId/orgId are the deprecated aliases.
      const resolvedMemoryId = await resolveMemoryRefArg(ctx.db, { ref: memoryRef, id: memoryId });
      // #1381: hidden from this caller ⇒ resolveRefArg's own miss, decided HERE,
      // before the org resolves — an org error arriving first would tell an
      // existing memory from a missing one. No caller who cannot open the
      // memory can succeed here, so this narrows nobody legitimate.
      await refuseHiddenSubscriptionMemory(ctx, resolvedMemoryId, { ref: memoryRef, id: memoryId });
      const resolvedOrgId = await resolveOrgRefArg(ctx.db, { ref: orgRef, id: orgId });
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });

      // 035-visibility-enum-cleanup: only PUBLIC memories are cross-org
      // subscribable. ORGANIZATION/GROUP/NULL (personal/private/app/system)
      // are all rejected (PRIVATE is gone from the enum).
      if (memory.visibility !== 'PUBLIC') {
        // Reached only by a caller who can open the memory (#1381 refused the
        // rest above), so this refusal discloses nothing they did not know.
        throw new GraphQLError(
          'Only public memories can be subscribed to by other organizations',
          { extensions: { code: 'SUBSCRIPTION_REQUIRES_PUBLIC_MEMORY' } },
        );
      }

      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');

      if (memory.organizationId === resolvedOrgId) {
        throw new GraphQLError(
          'Owner organization has implicit access and cannot subscribe',
          { extensions: { code: 'OWNER_ORG_CANNOT_SUBSCRIBE' } },
        );
      }

      return withAuthorizedMemoryTx(
        ctx, resolvedMemoryId, [{ kind: 'org', id: resolvedOrgId }],
        async (txCtx) => {
          await refuseHiddenSubscriptionMemory(txCtx, resolvedMemoryId, { ref: memoryRef, id: memoryId });
          await requireOrgRole(txCtx, resolvedOrgId, 'ADMIN');
          const current = await txCtx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
          if (current.visibility !== 'PUBLIC') {
            throw new GraphQLError(
          'Only public memories can be subscribed to by other organizations',
          { extensions: { code: 'SUBSCRIPTION_REQUIRES_PUBLIC_MEMORY' } },
        );
          }
          if (current.organizationId === resolvedOrgId) {
            throw new GraphQLError(
          'Owner organization has implicit access and cannot subscribe',
          { extensions: { code: 'OWNER_ORG_CANNOT_SUBSCRIBE' } },
        );
          }
        },
        (tx) => tx.memorySubscription.create({
          data: { id: generateId(), memoryId: resolvedMemoryId, organizationId: resolvedOrgId, role: role as Role, createdBy: ctx.userId ?? ctx.clientId ?? null },
          include: { memory: { include: MEMORY_INCLUDE }, organization: { include: ORG_INCLUDE } },
        }),
      );
    },

    updateMemorySubscription: async (
      _: unknown,
      {
        memoryRef,
        memoryId,
        orgRef,
        orgId,
        role,
      }: {
        memoryRef?: string | null;
        memoryId?: string | null;
        orgRef?: string | null;
        orgId?: string | null;
        role: string;
      },
      ctx: Context,
    ) => {
      const resolvedMemoryId = await resolveMemoryRefArg(ctx.db, { ref: memoryRef, id: memoryId });
      // #1381: hidden from this caller ⇒ resolveRefArg's own miss, decided HERE,
      // before the org resolves — an org error arriving first would tell an
      // existing memory from a missing one. No caller who cannot open the
      // memory can succeed here, so this narrows nobody legitimate.
      await refuseHiddenSubscriptionMemory(ctx, resolvedMemoryId, { ref: memoryRef, id: memoryId });
      const resolvedOrgId = await resolveOrgRefArg(ctx.db, { ref: orgRef, id: orgId });
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
      // Only callers who can open the memory reach here (#1381), so this
      // denial discloses nothing they did not already know.
      await requireMemoryManageAccess(ctx, memory);
      // A missing subscription is a typed NOT_FOUND, not Prisma's P2025 text.
      await requireMemorySubscription(ctx, resolvedMemoryId, resolvedOrgId, chosenRefArg({ ref: memoryRef, id: memoryId })!);
      return withAuthorizedMemoryTx(
        ctx, resolvedMemoryId, [{ kind: 'org', id: resolvedOrgId }],
        async (txCtx) => {
          await refuseHiddenSubscriptionMemory(txCtx, resolvedMemoryId, { ref: memoryRef, id: memoryId });
          const current = await txCtx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
          await requireMemoryManageAccess(txCtx, current);
          await requireMemorySubscription(txCtx, resolvedMemoryId, resolvedOrgId, chosenRefArg({ ref: memoryRef, id: memoryId })!);
        },
        (tx) => tx.memorySubscription.update({
          where: { memoryId_organizationId: { memoryId: resolvedMemoryId, organizationId: resolvedOrgId } },
          data: { role: role as Role },
          include: { memory: { include: MEMORY_INCLUDE }, organization: { include: ORG_INCLUDE } },
        }),
        { lockMode: 'exclusive' },
      );
    },

    deleteMemorySubscription: async (
      _: unknown,
      {
        memoryRef,
        memoryId,
        orgRef,
        orgId,
      }: {
        memoryRef?: string | null;
        memoryId?: string | null;
        orgRef?: string | null;
        orgId?: string | null;
      },
      ctx: Context,
    ) => {
      const resolvedMemoryId = await resolveMemoryRefArg(ctx.db, { ref: memoryRef, id: memoryId });
      // #1381: unlike create/update, a caller who cannot open the memory CAN
      // succeed here — an admin of the subscribing org removing its own
      // subscription — so it is not refused up front. Instead any org error
      // becomes the memory's miss when the memory is hidden, so an org error
      // arriving first cannot tell an existing memory from a missing one.
      const memoryHidden = !(await canOpenMemoryRecordById(ctx, resolvedMemoryId));
      const resolvedOrgId = await resolveOrgRefArg(ctx.db, { ref: orgRef, id: orgId }).catch((e: unknown) => {
        // Only CALLER-INPUT errors are converted — a missing org, both-or-neither,
        // a malformed URN — since a missing memory refuses before the org is ever
        // parsed. A DB fault is not input: it propagates as itself, never as
        // "no such memory" (@copilot, PR #1383).
        const callerInput =
          e instanceof UrnNotQualifiedError ||
          // An org ref whose legacy alias names two orgs is caller input too
          // (@codex, PR #1383): a missing memory refuses before it is resolved.
          e instanceof AmbiguousLegacyUrnError ||
          (e instanceof GraphQLError && (e.extensions.code === 'NOT_FOUND' || e.extensions.code === 'BAD_USER_INPUT'));
        if (memoryHidden && callerInput) {
          throw refArgNotFoundError('memory', chosenRefArg({ ref: memoryRef, id: memoryId })!);
        }
        throw e;
      });
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
      // findFirst + deletedAt in both checks so a REVOKED membership no
      // longer authorizes subscription management (same rule as requireOrgRole).
      const isOwnerAdmin = async () => {
        if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return true;
        if (!ctx.userId) return false;
        // spec 047: a user-owned memory has no org — no org-admin via this path.
        if (memory.organizationId === null) return false;
        const m = await ctx.db.orgMember.findFirst({
          where: { organizationId: memory.organizationId, userId: ctx.userId, ...LIVE_ORG_MEMBERSHIP },
        });
        return m?.role === 'ADMIN' || m?.role === 'OWNER';
      };
      const isSubscriberAdmin = async () => {
        if (!ctx.userId) return false;
        const m = await ctx.db.orgMember.findFirst({
          where: { organizationId: resolvedOrgId, userId: ctx.userId, ...LIVE_ORG_MEMBERSHIP },
        });
        return m?.role === 'ADMIN' || m?.role === 'OWNER';
      };
      // #1381: a caller who cannot open the memory gets resolveRefArg's own miss.
      const chosen = chosenRefArg({ ref: memoryRef, id: memoryId })!;
      await concealUnreadableDenial(
        ctx,
        resolvedMemoryId,
        chosen,
        async () => {
          if (!(await isOwnerAdmin()) && !(await isSubscriberAdmin())) {
            throw forbiddenError();
          }
        },
        () => refArgNotFoundError('memory', chosen),
      );
      // Being an admin of the SUBSCRIBING org passes the gate above for any
      // memory at all, so the missing-row case must conceal too — it used to
      // surface Prisma's own error text, server paths included.
      await requireMemorySubscription(ctx, resolvedMemoryId, resolvedOrgId, chosen);
      await withAuthorizedMemoryTx(
        ctx, resolvedMemoryId, [{ kind: 'org', id: resolvedOrgId }],
        async (txCtx) => {
          const current = await txCtx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
          const platformAdmin = txCtx.roles?.includes('ADMIN') || txCtx.roles?.includes('OWNER');
          const ownerAdmin = current.organizationId && txCtx.userId
            ? await txCtx.db.orgMember.findFirst({
                where: { organizationId: current.organizationId, userId: txCtx.userId, ...LIVE_ORG_MEMBERSHIP,
                  role: { in: ['ADMIN', 'OWNER'] } }, select: { id: true },
              })
            : null;
          const subscriberAdmin = txCtx.userId
            ? await txCtx.db.orgMember.findFirst({
                where: { organizationId: resolvedOrgId, userId: txCtx.userId, ...LIVE_ORG_MEMBERSHIP,
                  role: { in: ['ADMIN', 'OWNER'] } }, select: { id: true },
              })
            : null;
          if (!platformAdmin && !ownerAdmin && !subscriberAdmin) throw forbiddenError();
          await requireMemorySubscription(txCtx, resolvedMemoryId, resolvedOrgId, chosen);
        },
        (tx) => tx.memorySubscription.delete({
          where: { memoryId_organizationId: { memoryId: resolvedMemoryId, organizationId: resolvedOrgId } },
        }).then(() => undefined),
        { lockMode: 'exclusive' },
      );
      return true;
    },

    syncMemory: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      // #1381: resolve (typed miss, URN accepted) and conceal as updateMemory does.
      const ref = id;
      ({ id } = await resolveMemoryRef(ctx.db, ref));
      const memory = await ctx.db.memory.findUniqueOrThrow({
        where: { id },
        include: { organization: true },
      });
      await concealUnreadableDenial(ctx, id, ref, () => requireMemoryManageAccess(ctx, memory, 'CONTRIBUTOR'));

      const result = await syncGraphFromGithub(memory);
      // `fault` is judged on its own: an exception with an empty message must not read as success.
      if (result.fault) throw new Error(result.error ?? 'sync fault');
      if (result.error) {
        if (result.errorCode) throw new GraphQLError(result.error, { extensions: { code: result.errorCode } });
        // #1789: the text is the stored `Memory.syncError` the caller can already read, so it keeps its text; it needs a code
        // of its own to be a typed refusal rather than a fault.
        throw new GraphQLError(result.error, { extensions: { code: 'SYNC_FAILED' } });
      }

      // #1061 — one write per node the sync actually wrote. This mutation and
      // the `hadron_sync_graph` MCP tool are the two sync entry points with a
      // principal to attribute to; the webhook and the startup batch loop
      // deliberately drop `writtenNodes`, because an unattended sync is nobody's
      // usage (PR #1062 review — Copilot).
      recordNodeUsage(ctx.db, 'write', result.writtenNodes ?? [], ctx);

      return ctx.db.memory.findUniqueOrThrow({ where: { id }, include: MEMORY_INCLUDE });
    },

    pushMemoryToGit: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      // #1381: resolve (typed miss, URN accepted) and conceal as updateMemory does.
      const ref = id;
      ({ id } = await resolveMemoryRef(ctx.db, ref));
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id } });
      await concealUnreadableDenial(ctx, id, ref, () => requireMemoryManageAccess(ctx, memory));

      const { pushMemoryToGit: push } = await import('../../../integrations/github/pushMemoryToGit.js');
      const result = await push(id);
      if (result.errorCode) throw new GraphQLError(result.error ?? result.errorCode, { extensions: { code: result.errorCode } });
      if (result.error) throw new Error(result.error);
      return true;
    },

    // ── Exchange integration mutations ──────────────────────────────────
    // Connection is created via OAuth at /auth/microsoft (no GraphQL mutation needed)

    linkMemoryToUser: async (
      _: unknown,
      { memoryId, externalUserId }: { memoryId: string; externalUserId: string },
      ctx: Context,
    ) => {
      if (!ctx.appId) throw forbiddenError('Forbidden: App Key required');
      // 007-entity-id-or-urn: memoryId may be ID, bare URN, or prefixed URN.
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: ctx.appId } });
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
      const [{ now: promotionNow }] = await ctx.db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      // #1644: both promotion paths belong to this App's live anonymous
      // provisioning scope. Registered holdings require their owner's authority.
      await concealUnreadableDenial(ctx, resolvedMemoryId, memoryId, async () => {
        if (memory.organizationId !== app.organizationId || !memory.userMemoryOfAgentId ||
            memory.deletedAt || memory.anonymousExpiresAt === null || memory.anonymousExpiresAt <= promotionNow || memory.userId !== null || memory.class !== 'app' ||
            memory.appId !== ctx.appId || memory.isEncrypted || ctx.impersonation) {
          throw new GraphQLError("Only this App's plaintext anonymous memory may be linked.", {
            extensions: { code: 'FORBIDDEN' },
          });
        }
      });

      // #1796: consume request-only supply before any provisioning writes.
      const suppliedKey = getRequestOperationKey();

      // Resolve or create user
      let user = await ctx.db.user.findFirst({
        where: { externalAppId: ctx.appId, externalId: externalUserId, deletedAt: null },
      });
      if (!user) {
        if (app.createUserPermission === 'DENY') {
          throw new Error('User not found and createUserPermission=DENY');
        }
        // Handle is NOT NULL (spec 047). This magic-link-provisioned app
        // end-user gets a RANDOM handle — addressed by (externalAppId,
        // externalId), not by handle.
        const appUserHandle = await generateUniqueHandle(ctx.db);
        user = await ctx.db.$transaction(async (tx) => {
          const u = await tx.user.create({
            data: {
              externalAppId: ctx.appId,
              externalId: externalUserId,
              identityProvider: 'APP',
              handle: appUserHandle,
              createdBy: ctx.appId,
            },
          });
          await ensureUserPrincipal(tx, u); // #692: pool principal
          return u;
        });
      }

      // Rewrite the URN from anon → user
      const agent = await ctx.db.agent.findUniqueOrThrow({
        where: { id: memory.userMemoryOfAgentId! },
      });
      if (!agent.organizationId) {
        throw new Error('linkMemoryToUser is not supported for a user-owned Agent yet');
      }
      const org = await ctx.db.organization.findUniqueOrThrow({
        where: { id: agent.organizationId }, select: { urn: true },
      });
      const opaqueId = generateId();
      const agentSlug = agentSlugFromUrn(agent.urn);
      // #697 Stage 3: the anon→registered promotion re-mints a FLAT single-atom
      // v2 urn (`<org>:<opaqueId>`); the per-user `app-user` scope lives in the
      // row columns, not the URN path. Fresh opaque id ⇒ no collision.
      const newUrn = await mintMemoryUrnV2(ctx.db, {
        root: org.urn,
        desiredSlug: opaqueId,
        authorRoot: agentSlug,
      });

      // If a request key is provided and the memory isn't already encrypted,
      // encrypt every node in a single transaction, then flip isEncrypted.
      // This is the anonymous → registered promotion path.
      // 041 (#516): 'private' is the only encryptable class, so an encrypted
      // promotion lands the memory as class='private' owned by the registered
      // user (the anon scratch memory was class='app', userId NULL). The
      // plaintext branch below leaves the App-scoped class untouched.
      if (suppliedKey && !memory.isEncrypted) {
        const key = suppliedKey;
        // #1346: reconciliation adds per-row work to this atomic conversion.
        // Match the bulk node writers' explicit processing budget instead of
        // inheriting Prisma's five-second default. This is not a node limit
        // or an end-to-end latency guarantee (completion runs after commit).
        await ctx.db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM memories WHERE id = ${resolvedMemoryId} FOR UPDATE`;
          const current = await tx.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
          const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
          if (current.deletedAt || current.anonymousExpiresAt === null || current.anonymousExpiresAt <= now || !current.userMemoryOfAgentId || current.userId !== null || current.class !== 'app' ||
              current.appId !== ctx.appId || current.organizationId !== app.organizationId ||
              current.isEncrypted || current.keyVerifier !== null || current.urn !== memory.urn) {
            throw new GraphQLError('Anonymous memory changed during promotion; retry.', {
              extensions: { code: 'MEMORY_WRITE_CONFLICT', memoryId: resolvedMemoryId },
            });
          }
          // #1346: Memory precedes Node locks (#1776). Read the deciding
          // live set only after that fence, then lock every row in id order.
          // Values read before the fence can overwrite a committed late edit.
          const nodes = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM nodes
            WHERE memory_id = ${resolvedMemoryId} AND deleted_at IS NULL
            ORDER BY id FOR UPDATE
          `;
          for (const candidate of nodes) {
            const before = await tx.node.findUniqueOrThrow({ where: { id: candidate.id } });
            const revision = await ensureCurrentNodeRevisionInTransaction(tx, candidate.id, {
              expectedMemoryId: resolvedMemoryId,
            });
            const node = await tx.node.findUniqueOrThrow({ where: { id: candidate.id } });
            // As in encryptMemory (#1435), reconciliation creates a snapshot
            // of raw plaintext drift. Encrypt it before the flag flips in this
            // transaction, even if the later history completion is interrupted.
            if (revision != null && revision > before.revSeq) {
              const reconciled = await tx.nodeRevision.findFirst({
                where: { nodeId: node.id, memoryId: resolvedMemoryId,
                  revNo: revision - 1, editedByInfo: RECONCILE_EDITOR_INFO },
              });
              if (reconciled) {
                const encryptedRevision = encryptNodeFieldsWithKey(
                  { content: reconciled.content, abstract: reconciled.abstract, data: reconciled.data }, key,
                );
                await tx.nodeRevision.update({
                  where: { id: reconciled.id },
                  data: { content: encryptedRevision.content ?? null,
                    abstract: encryptedRevision.abstract ?? null,
                    data: (encryptedRevision.data ?? null) as InputJsonValue },
                });
              }
            }
            const encrypted = encryptNodeFieldsWithKey(
              { content: node.content, abstract: node.abstract, data: node.data },
              key,
            );
            await tx.node.update({
              where: { id: node.id },
              data: {
                content: encrypted.content ?? null,
                revisionContentHash: revisionStateHashRefreshMarker(),
                abstract: encrypted.abstract ?? null,
                data: (encrypted.data ?? null) as InputJsonValue,
              },
            });
          }
          // #1079 (PR #1080 third review, Codex P2) — linking an anonymous
          // memory to a user REPLACES its urn, which is a rename by any other
          // name and owes an alias. Already inside this transaction, so the
          // alias and the rewrite commit together.
          await recordUrnRename(tx, {
            entityType: 'MEMORY',
            entityId: resolvedMemoryId,
            oldUrn: memory.urn,
            newUrn,
            createdBy: user.id,
          });
          // A second promotion may have read the same anonymous row and
          // supplied a different key. Claim the flag and verifier together;
          // if another writer won, roll back every Node rewrite, reconcile,
          // and alias in this transaction.
          // Evaluate expiry in the claim statement, not against an application
          // clock or the transaction's start time (a lock wait can outlive it).
          // R206: this flip is serialized against an in-flight Git mirror's KEY SHARE
          // fence by the memory row FOR UPDATE this transaction took on entry.
          const claimed = await tx.$executeRaw`
            UPDATE memories SET urn = ${newUrn}, created_by = ${user.id},
              anonymous_expires_at = NULL, is_encrypted = true,
              key_verifier = ${makeKeyVerifier(key)}, class = 'private', user_id = ${user.id},
              updated_by = ${ctx.appId}, updated_at = clock_timestamp()
            WHERE id = ${resolvedMemoryId} AND is_encrypted = false AND key_verifier IS NULL
              AND urn = ${memory.urn} AND user_id IS NULL
              AND anonymous_expires_at > clock_timestamp()
              AND user_memory_of_agent_id IS NOT NULL
              AND app_id = ${ctx.appId} AND organization_id = ${app.organizationId}
              AND class = 'app' AND deleted_at IS NULL
          `;
          if (claimed !== 1) {
            throw new GraphQLError('Anonymous memory changed during promotion; retry.', {
              extensions: { code: 'MEMORY_WRITE_CONFLICT', memoryId: resolvedMemoryId },
            });
          }
          // #1838 (cor:dmo:120:04): the flip ENDS the approvals in this same
          // transaction, so an interrupted completion pass below cannot leave
          // a live or copied hash behind. Who/when/revision stay.
          await endApprovalsOnEncryptedEntry(tx, { memoryId: resolvedMemoryId });
        }, { timeout: 120_000 });
        // Promotion's live-node rewrite does not cover tombstones or prior
        // snapshots. Reuse the bounded completion pass under the verifier we
        // just installed. The owning App can recover an interrupted pass by
        // proving possession of this existing key; it cannot repeat promotion
        // or choose a replacement verifier (Holger's #1644 completion ruling).
        await memoryMutations.encryptMemory(
          {}, { memoryId: resolvedMemoryId, dataKey: key.raw.toString('base64') }, ctx,
        );
        return ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
      }

      // Claim the plaintext rename under the same scope and lock as encrypted
      // promotion. A competing rename/registration must roll the alias back.
      return ctx.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM memories WHERE id = ${resolvedMemoryId} FOR UPDATE`;
        const current = await tx.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
        const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
        if (current.deletedAt || current.anonymousExpiresAt === null || current.anonymousExpiresAt <= now || !current.userMemoryOfAgentId || current.userId !== null || current.class !== 'app' ||
            current.appId !== ctx.appId || current.organizationId !== app.organizationId ||
            current.isEncrypted || current.keyVerifier !== null || current.urn !== memory.urn) {
          throw new GraphQLError('Anonymous memory changed during promotion; retry.', {
            extensions: { code: 'MEMORY_WRITE_CONFLICT', memoryId: resolvedMemoryId },
          });
        }
        await recordUrnRename(tx, {
          entityType: 'MEMORY', entityId: resolvedMemoryId,
          oldUrn: memory.urn, newUrn, createdBy: user.id,
        });
        const claimed = await tx.$executeRaw`
          UPDATE memories SET urn = ${newUrn}, created_by = ${user.id},
            anonymous_expires_at = NULL, updated_by = ${ctx.appId}, updated_at = clock_timestamp()
          WHERE id = ${resolvedMemoryId} AND urn = ${memory.urn} AND user_id IS NULL
            AND class = 'app' AND app_id = ${ctx.appId} AND organization_id = ${app.organizationId}
            AND deleted_at IS NULL AND anonymous_expires_at > clock_timestamp()
            AND user_memory_of_agent_id IS NOT NULL AND is_encrypted = false AND key_verifier IS NULL
        `;
        if (claimed !== 1) {
          throw new GraphQLError('Anonymous memory changed during promotion; retry.', {
            extensions: { code: 'MEMORY_WRITE_CONFLICT', memoryId: resolvedMemoryId },
          });
        }
        return tx.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
      });
    },

    // Spec 041 (D-2026-07-06-B): convert a plaintext PRIVATE memory to
    // encrypted. Caller supplies exactly one of dataKey / passphrase; the
    // passphrase path stores KDF salt+params, and BOTH paths store a
    // keyVerifier so later unlocks detect a wrong key without touching
    // node rows. The server never persists the key itself.
    encryptMemory: async (
      _: unknown,
      {
        memoryId,
        dataKey,
        passphrase,
      }: { memoryId: string; dataKey?: string | null; passphrase?: string | null },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: memoryId may be ID, bare URN, or prefixed URN.
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
      // #1644: first encryption requires the strict owner. Holger's ruling
      // also permits completion by the owning App's actual key principal,
      // under the existing verifier, without fabricating an owner identity.
      const appCompletionOnly = ctx.userId == null && !ctx.impersonation && !!ctx.appId &&
        memory.appId === ctx.appId && memory.class === 'private' &&
        memory.userId !== null && memory.isEncrypted && !!dataKey && !passphrase;
      await concealUnreadableDenial(ctx, resolvedMemoryId, memoryId, async () => {
        if (!isStrictOwner(ctx, memory.userId) && !appCompletionOnly) {
          throw new GraphQLError('Only the memory owner may encrypt it.', {
            extensions: { code: 'FORBIDDEN' },
          });
        }
      });
      // Class gate (D-2026-07-06-B, #516 resolved): 'private' is the ONLY
      // encryptable class — no exceptions. Tier 2.5's SECRET-mode memories are
      // now born class='private' (resolvers.mutation.session.ts) and the anon→
      // registered encrypted promotion lands 'private' (linkMemoryToUser), so
      // the pre-041 'personal' grandfather is retired and the platform has ONE
      // answer to "which classes encrypt?".
      const classAllowed = memory.class === 'private';
      if (!classAllowed) {
        throw new GraphQLError(
          "Only class='private' memories support encryption (D-2026-07-06-B).",
          { extensions: { code: 'BAD_USER_INPUT', memoryClass: memory.class } },
        );
      }
      // #1434: an encryption interrupted after the flip, or completed before
      // historical revisions were included, may leave plaintext rows behind.
      // A rerun is a completion under the EXISTING key, never a key rotation.
      // Verifier-less legacy rows cannot safely complete: a later wrong-key
      // session can create an authenticating envelope under that key (#1441).
      // A matching envelope therefore does not prove the original memory key.
      // Vector indexing on an encrypted memory requires the FR-026 ack;
      // converting an INDEXED memory would violate chk_memory_vector_
      // encrypted_ack — surface it as a typed error, not a DB error.
      if (!memory.isEncrypted && memory.vectorIndexEnabled && !memory.vectorIndexEncryptedAckAt) {
        throw new GraphQLError(
          'Disable the vector index (or acknowledge the inversion disclosure) before encrypting.',
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }
      if (memory.isEncrypted && !memory.keyVerifier) {
        throw new GraphQLError('Encrypted memory has no stored key verifier for safe completion.', {
          extensions: { code: 'BAD_UNLOCK_INPUT', memoryId: resolvedMemoryId },
        });
      }
      let key;
      let kdfFields: { kdfSalt?: string; kdfParams?: InputJsonValue } = {};
      if (memory.isEncrypted) {
        try {
          key = await resolveSuppliedKey(memory, { dataKey, passphrase });
        } catch (e) {
          if (e instanceof MemoryUnlockError) {
            throw new GraphQLError(e.message, { extensions: { code: e.code, memoryId: resolvedMemoryId } });
          }
          throw e;
        }
      } else if (passphrase) {
        if (dataKey) {
          throw new GraphQLError('Provide exactly one of dataKey or passphrase.', {
            extensions: { code: 'BAD_USER_INPUT' },
          });
        }
        const kdfSalt = generateKdfSalt();
        key = await deriveDataKeyFromPassphrase(passphrase, kdfSalt, DEFAULT_KDF_PARAMS);
        kdfFields = { kdfSalt, kdfParams: DEFAULT_KDF_PARAMS as unknown as InputJsonValue };
      } else if (dataKey) {
        try {
          key = parseDataKey(dataKey);
        } catch (e) {
          // A malformed key is caller input, not a server fault (PR-514
          // review, Copilot) — surface as typed BAD_USER_INPUT.
          throw new GraphQLError(String((e as Error).message), {
            extensions: { code: 'BAD_USER_INPUT' },
          });
        }
      } else {
        throw new GraphQLError('Provide exactly one of dataKey or passphrase.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      // FLIP FIRST, then converge (PR-514 review, Copilot — conversion
      // race): once isEncrypted commits, every concurrent write path either
      // encrypts (key present) or fails closed (SESSION_EXPIRED) — so
      // plaintext can no longer be ADDED. The encryption passes below then
      // converge on zero plaintext rows: a row written plaintext between
      // our scan and the flip is caught by the next pass. Idempotent by the
      // Authenticated envelopes stay unchanged, so re-running a pass is safe.
      // Two callers may both have read the plaintext flag above. Claim the
      // flip atomically so only one key can become the verifier/conversion key;
      // otherwise a losing caller could replace the verifier while the winner
      // encrypts rows under its own key (#1346).
      if (!memory.isEncrypted) {
        await ctx.db.$transaction(async (tx) => {
          // A transfer may win after the preflight above. Hold the same row
          // lock as transfer while checking the current owner and class, so
          // the former owner's key cannot encrypt the receiver's nodes.
          await tx.$queryRaw`SELECT id FROM memories WHERE id = ${resolvedMemoryId} FOR UPDATE`;
          const current = await tx.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
          const txCtx = { ...ctx, db: tx } as Context;
          await concealUnreadableDenial(txCtx, resolvedMemoryId, memoryId, async () => {
            if (current.deletedAt) throw new GraphQLError('Memory not found.', { extensions: { code: 'FORBIDDEN' } });
            if (!isStrictOwner(ctx, current.userId)) {
              throw new GraphQLError('Only the memory owner may encrypt it.', {
                extensions: { code: 'FORBIDDEN' },
              });
            }
          });
          if (current.class !== 'private') {
            throw new GraphQLError("Only class='private' memories support encryption (D-2026-07-06-B).", {
              extensions: { code: 'BAD_USER_INPUT', memoryClass: current.class },
            });
          }
          // #1641 §5.4 (Q5) — reciprocal to createDecisionLog's refusal: a
          // decision is verified by re-rendering its plaintext, so a memory
          // holding a log is never encrypted. Under this row's FOR UPDATE.
          if (await memoryHoldsDecisionLog(tx, resolvedMemoryId)) {
            throw decisionError('DECISION_LOG_ENCRYPTED', 'This memory holds a decision log, so it cannot be encrypted.', { memoryId: resolvedMemoryId });
          }
          if (current.vectorIndexEnabled && !current.vectorIndexEncryptedAckAt) {
            throw new GraphQLError(
              'Disable the vector index (or acknowledge the inversion disclosure) before encrypting.',
              { extensions: { code: 'BAD_USER_INPUT' } },
            );
          }
          const flip = await tx.memory.updateMany({
            where: { id: resolvedMemoryId, isEncrypted: false },
            data: {
              isEncrypted: true,
              keyVerifier: makeKeyVerifier(key),
              ...kdfFields,
              updatedBy: ctx.appId ?? ctx.userId ?? null,
            },
          });
          if (flip.count !== 1) throw new Error('Memory is already encrypted');
          // #1838 (cor:dmo:120:04): entering ENDS the approvals, in this same
          // transaction, so no copied hash can revive after any later move out.
          await endApprovalsOnEncryptedEntry(tx, { memoryId: resolvedMemoryId });
        });
      }
      /** Keep conversion authority current while holding memory before node locks. */
      const lockConversionMemory = async (tx: Prisma.TransactionClient) => {
        await tx.$queryRaw`SELECT id FROM memories WHERE id = ${resolvedMemoryId} FOR SHARE`;
        const current = await tx.memory.findUnique({ where: { id: resolvedMemoryId } });
        await concealUnreadableDenial({ ...ctx, db: tx } as Context, resolvedMemoryId, memoryId, async () => {
          if (!current || current.deletedAt || (!isStrictOwner(ctx, current.userId) &&
              !(appCompletionOnly && current.appId === ctx.appId && current.userId === memory.userId &&
                current.class === 'private' && current.isEncrypted))) {
            throw new GraphQLError('Only the memory owner may encrypt it.', { extensions: { code: 'FORBIDDEN' } });
          }
        });
        if (!current || current.class !== 'private' || !current.isEncrypted || !current.keyVerifier ||
            !verifyDataKey(current.keyVerifier, key)) {
          throw new GraphQLError('Memory encryption state changed; retry with its current key.', {
            extensions: { code: 'BAD_UNLOCK_INPUT', memoryId: resolvedMemoryId },
          });
        }
        return current;
      };
      const BATCH = 200; // bound memory per pass (PR-514 review, Gemini)
      for (let pass = 0; pass < 5; pass++) {
        let converted = 0;
        // Paginate by id to keep memory bounded for large graphs.
        let cursor: string | undefined;
        for (;;) {
          const nodes = await ctx.db.node.findMany({
            // Tombstones retain content and may later be restored. They are
            // part of the at-rest conversion too (#1435 review P2).
            where: { memoryId: resolvedMemoryId },
            // This is only an id page. Fields must be read AFTER the row lock:
            // a concurrent edit between enumeration and conversion otherwise
            // gets overwritten with ciphertext of the older value (#1346).
            select: { id: true },
            orderBy: { id: 'asc' },
            take: BATCH,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          });
          if (nodes.length === 0) break;
          cursor = nodes[nodes.length - 1].id;
          for (const node of nodes) {
            const didConvert = await ctx.db.$transaction(async (tx) => {
              await lockConversionMemory(tx);
              // Lock first, then re-read. A moved row is outside this memory;
              // a deleted row still belongs here and retains restorable
              // content, so it must be reconciled and encrypted too. The
              // reconciliation snapshot is encrypted below before commit.
              // Each transaction holds only one node lock; id paging orders
              // the conversions deterministically.
              const locked = await tx.$queryRaw<Array<{ id: string }>>`
                SELECT id FROM nodes WHERE id = ${node.id} FOR UPDATE
              `;
              if (locked.length === 0) return false;
              const lockedNode = await tx.node.findUnique({
                where: { id: node.id },
              });
              if (!lockedNode || lockedNode.memoryId !== resolvedMemoryId) return false;
              // The helper reuses our row lock, scopes the reconcile to the
              // authorized memory, and snapshots raw drift before conversion.
              const revision = await ensureCurrentNodeRevisionInTransaction(tx, node.id, {
                expectedMemoryId: resolvedMemoryId,
              });
              if (revision == null) return false;
              const current = await tx.node.findUnique({ where: { id: node.id } });
              if (!current || current.memoryId !== resolvedMemoryId) return false;

              // Reconciliation can snapshot the raw plaintext change. Encrypt
              // that newly minted snapshot before this transaction commits:
              // once the memory flag is set, no new plaintext history may
              // become visible at rest. Ordinary pre-existing revisions are
              // outside this conversion's revision semantics.
              if (revision > lockedNode.revSeq) {
                const reconciled = await tx.nodeRevision.findFirst({
                  where: {
                    nodeId: node.id,
                    revNo: revision - 1,
                    editedByInfo: RECONCILE_EDITOR_INFO,
                    memoryId: resolvedMemoryId,
                  },
                });
                if (reconciled) {
                  const encryptedRevision = encryptNodeFieldsWithKey(
                    { content: reconciled.content, abstract: reconciled.abstract, data: reconciled.data }, key,
                  );
                  await tx.nodeRevision.update({
                    where: { id: reconciled.id },
                    data: {
                      content: encryptedRevision.content ?? null,
                      abstract: encryptedRevision.abstract ?? null,
                      data: (encryptedRevision.data ?? null) as InputJsonValue,
                    },
                  });
                }
              }

              const plaintextContent = current.content != null && !isAuthenticatedStringEnvelope(current.content, key);
              const plaintextAbstract = current.abstract != null && !isAuthenticatedStringEnvelope(current.abstract, key);
              const plaintextData = current.data != null && !isAuthenticatedDataEnvelope(current.data, key);
              if (!plaintextContent && !plaintextAbstract && !plaintextData) return false;
              const encrypted = encryptNodeFieldsWithKey(
                { content: current.content, abstract: current.abstract, data: current.data }, key,
              );
              await tx.node.update({
                where: { id: current.id },
                data: {
                  content: encrypted.content ?? null,
                  revisionContentHash: revisionStateHashRefreshMarker(),
                  abstract: encrypted.abstract ?? null,
                  data: (encrypted.data ?? null) as InputJsonValue,
                },
              });
              return true;
            });
            if (didConvert) converted += 1;
          }
          if (nodes.length < BATCH) break;
        }
        if (converted === 0) break; // clean pass — converged
        if (pass === 4) {
          console.error(
            `[encryptMemory] memory ${resolvedMemoryId} did not converge after 5 passes — investigate`,
          );
        }
      }

      // Historical snapshots belong to the memory where they were captured,
      // even when their Node has since moved. Legacy NULL-memory snapshots
      // follow the read gate's current-Node-memory fallback (#602). Page IDs
      // only, then lock the parent and re-check that fallback before writing:
      // a move between the page read and conversion must not encrypt history
      // under the wrong memory key. Sanctioned writes after the flip create
      // ciphertext snapshots; this pass converts the pre-flip history (#1434).
      // Encryption stays in the application because the caller's key must
      // never be passed to PostgreSQL for a bulk UPDATE. Use an id comparison
      // for paging: a history prune can delete the last row of a page, so a
      // Prisma cursor on that row would lose the remaining pages.
      let revisionConverged = false;
      for (let revisionPass = 0; revisionPass < 5; revisionPass++) {
        let convertedRevisions = 0;
        let revisionCursor: string | undefined;
        for (;;) {
          const revisions = await ctx.db.nodeRevision.findMany({
            where: {
              ...(revisionCursor ? { id: { gt: revisionCursor } } : {}),
              OR: [
                { memoryId: resolvedMemoryId },
                { memoryId: null, node: { memoryId: resolvedMemoryId } },
              ],
            },
            select: { id: true, nodeId: true },
            orderBy: { id: 'asc' },
            take: BATCH,
          });
          if (revisions.length === 0) break;
          revisionCursor = revisions[revisions.length - 1].id;
          for (const candidate of revisions) {
            const didConvert = await ctx.db.$transaction(async (tx) => {
              await lockConversionMemory(tx);
              await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${candidate.nodeId} FOR UPDATE`;
              // A concurrent history prune may delete a page candidate. Lock
              // the snapshot before reading it so a later delete cannot turn
              // the selective update into a failed, half-finished conversion.
              const lockedRevision = await tx.$queryRaw<Array<{ id: string }>>`
                SELECT id FROM node_revisions WHERE id = ${candidate.id} FOR UPDATE
              `;
              if (lockedRevision.length === 0) return false;
              const revision = await tx.nodeRevision.findUnique({ where: { id: candidate.id } });
              if (!revision) return false;
              if (revision.memoryId !== resolvedMemoryId) {
                if (revision.memoryId !== null) return false;
                const node = await tx.node.findUnique({
                  where: { id: candidate.nodeId }, select: { memoryId: true },
                });
                if (node?.memoryId !== resolvedMemoryId) return false;
              }
              const plaintextContent = revision.content != null && !isAuthenticatedStringEnvelope(revision.content, key);
              const plaintextAbstract = revision.abstract != null && !isAuthenticatedStringEnvelope(revision.abstract, key);
              const plaintextData = revision.data != null && !isAuthenticatedDataEnvelope(revision.data, key);
              if (!plaintextContent && !plaintextAbstract && !plaintextData) return false;
              const encrypted = encryptNodeFieldsWithKey(
                { content: revision.content, abstract: revision.abstract, data: revision.data }, key,
              );
              await tx.nodeRevision.update({
                where: { id: revision.id },
                data: {
                  content: encrypted.content ?? null,
                  abstract: encrypted.abstract ?? null,
                  data: (encrypted.data ?? null) as InputJsonValue,
                },
              });
              return true;
            });
            if (didConvert) convertedRevisions += 1;
          }
          if (revisions.length < BATCH) break;
        }
        // Always make a second pass: an old pre-flip writer can commit after
        // the first scan reached its last page. Later passes stop only after
        // observing no plaintext conversion across a complete traversal.
        if (convertedRevisions === 0 && revisionPass > 0) {
          revisionConverged = true;
          break;
        }
      }
      if (!revisionConverged) {
        throw new GraphQLError('Encrypted revision history did not converge; retry completion.', {
          extensions: { code: 'ENCRYPTION_INCOMPLETE', memoryId: resolvedMemoryId },
        });
      }
      return ctx.db.$transaction(async (tx) => {
        const current = await lockConversionMemory(tx);
        // A completion of an earlier encryption ends approvals it predates.
        await endApprovalsOnEncryptedEntry(tx, { memoryId: resolvedMemoryId });
        return current;
      });
    },

    // Spec cor:api:060 — run a task by loose name (mirrors hadron_run_task MCP tool).
    // Accepts task/memory hints (case-insensitive substring match) or a fully-qualified
    // URN. Reuses the action runner: {{arg}} substitution, inlined dependencies, usage event.
    createMemoryShare: async (
      _: unknown,
      {
        memoryId,
        granteeRef,
        granteeId,
        role,
      }: { memoryId: string; granteeRef?: string | null; granteeId?: string | null; role: MemoryShareRoleType },
      ctx: Context,
    ) => {
      if (!ctx.userId) {
        throw new GraphQLError('createMemoryShare requires an authenticated user', {
          extensions: { code: 'UNAUTHENTICATED' },
        });
      }
      // Caller-authority gate FIRST, then grantee resolution — so an unauthorized
      // caller always gets FORBIDDEN and can't use the NOT_FOUND-vs-FORBIDDEN
      // difference as a user-enumeration oracle (mirrors createPrincipalGrant).
      await requireMemorySharePrincipal(ctx, memoryId);
      const resolvedGranteeId = await resolveGranteeId(ctx, { granteeRef, granteeId });
      try {
        const memoryShare = await withAuthorizedMemoryTx(
          ctx,
          memoryId,
          [{ kind: 'user', id: resolvedGranteeId }],
          (txCtx) => requireMemorySharePrincipal(txCtx, memoryId),
          (_tx, txCtx) => createMemoryShare(txCtx.db, {
            memoryId,
            granteeId: resolvedGranteeId,
            role,
            actorId: ctx.userId!,
          }),
          {
            afterLock: async (tx) => {
              await tx.$queryRaw`
                SELECT memory_id FROM memory_shares
                WHERE memory_id = ${memoryId} AND grantee_id = ${resolvedGranteeId} FOR UPDATE`;
            },
            // The upsert may lower an existing writer to reader.
            lockMode: 'exclusive',
          },
        );
        return { memoryShare };
      } catch (e: unknown) {
        if (
          e instanceof InvalidMemoryClassForShareError ||
          e instanceof MemoryNotFoundForShareError ||
          e instanceof MemoryShareGranteeMissingError ||
          e instanceof CrossOrgShareNotAllowedError
        ) {
          throw new GraphQLError((e as Error).message, {
            extensions: { code: (e as Error).name },
          });
        }
        throw e;
      }
    },

    // 023-app-shape US3 — delete an existing MemoryShare. Idempotent.
    // #785: principal-OR-self. The memory's principal may delete any
    // grantee's row; a grantee may delete THEIR OWN row (the
    // stop-sharing-with-me path the portal needs), and omitting the
    // grantee entirely means "mine".
    deleteMemoryShare: async (
      _: unknown,
      {
        memoryRef,
        granteeRef,
        granteeId,
      }: { memoryRef: string; granteeRef?: string | null; granteeId?: string | null },
      ctx: Context,
    ) => {
      if (!ctx.userId) {
        throw new GraphQLError('deleteMemoryShare requires an authenticated user', {
          extensions: { code: 'UNAUTHENTICATED' },
        });
      }
      // Resolve LENIENTLY: an unknown memoryRef must not answer differently
      // from an unauthorized one, or any logged-in user could probe which
      // memory ids / URNs exist (PR-786 review, Codex P2 + Copilot). Only a
      // missing row is swallowed — a malformed URN is a caller-shape error and
      // still throws, since it reveals nothing about what exists.
      //
      // includeDeleted: a grantee must be able to detach from a memory whose
      // owner soft-deleted it — otherwise the row is stranded (the same
      // reasoning leaveApp applies to a dead App). It does NOT widen the
      // principal path: isMemorySharePrincipal still reports false for a
      // soft-deleted memory, so the owner-side FORBIDDEN is unchanged.
      let resolvedMemoryId: string | null = null;
      try {
        resolvedMemoryId = (
          await resolveMemoryRef(ctx.db, memoryRef, { includeDeleted: true })
        ).id;
      } catch (e) {
        if (!(e instanceof MemoryNotFoundError)) throw e;
      }
      if (resolvedMemoryId === null) throw memoryShareForbidden();
      // The authority answer is needed BEFORE the grantee is resolved, because
      // a non-principal must fail identically whether or not the named grantee
      // exists — otherwise the NOT_FOUND-vs-FORBIDDEN difference becomes a
      // user-enumeration oracle (the ordering rule createMemoryShare states).
      const isPrincipal = await isMemorySharePrincipal(ctx, resolvedMemoryId);
      // No grantee named ⇒ the caller means their own share ("leave").
      const wantsSelf = !granteeRef?.trim() && !granteeId;
      let resolvedGranteeId: string;
      if (wantsSelf) {
        resolvedGranteeId = ctx.userId;
      } else {
        try {
          resolvedGranteeId = await resolveGranteeId(ctx, { granteeRef, granteeId });
        } catch (e) {
          if (!isPrincipal) throw memoryShareForbidden();
          throw e;
        }
      }
      if (!isPrincipal) {
        if (resolvedGranteeId !== ctx.userId) throw memoryShareForbidden();
        // On the self path the SHARE ROW is the authorization — the caller has
        // no other claim on this memory. Requiring it is what keeps the
        // outcome uniform: non-participant and nonexistent-memory both answer
        // FORBIDDEN, so success never doubles as an existence probe. The cost
        // is that self-removal is idempotent only up to the row's lifetime —
        // repeating a successful leave answers FORBIDDEN (already left), while
        // the PRINCIPAL's delete stays idempotent exactly as it was pre-785.
        const ownShare = await ctx.db.memoryShare.findUnique({
          where: {
            memoryId_granteeId: { memoryId: resolvedMemoryId, granteeId: ctx.userId },
          },
          select: { memoryId: true },
        });
        if (!ownShare) throw memoryShareForbidden();
      }
      await withAuthorizedMemoryTx(
        ctx, resolvedMemoryId, [{ kind: 'user', id: resolvedGranteeId }],
        async (txCtx) => {
          const principal = await isMemorySharePrincipal(txCtx, resolvedMemoryId!);
          if (!principal) {
            if (resolvedGranteeId !== txCtx.userId) throw memoryShareForbidden();
            const ownShare = await txCtx.db.memoryShare.findUnique({
              where: { memoryId_granteeId: { memoryId: resolvedMemoryId!, granteeId: resolvedGranteeId } },
              select: { memoryId: true },
            });
            if (!ownShare) throw memoryShareForbidden();
          }
        },
        (tx) => tx.memoryShare.deleteMany({
          where: { memoryId: resolvedMemoryId!, granteeId: resolvedGranteeId },
        }).then(() => undefined),
        {
          lockMode: 'exclusive', allowDeletedMemory: true, allowDeletedOrg: true,
          afterLock: async (tx) => {
            await tx.$queryRaw`
              SELECT memory_id FROM memory_shares
              WHERE memory_id = ${resolvedMemoryId} AND grantee_id = ${resolvedGranteeId} FOR UPDATE`;
          },
        },
      );
      // Return the RESOLVED PKs so the client can correlate the deletion.
      return { memoryId: resolvedMemoryId, granteeId: resolvedGranteeId };
    },

    // 023-app-shape US3 — change the role on an existing MemoryShare.
    // Throws MemoryShareNotFoundError when the row doesn't exist
    // (use createMemoryShare to upsert).
    updateMemoryShareRole: async (
      _: unknown,
      {
        memoryId,
        granteeRef,
        granteeId,
        role,
      }: { memoryId: string; granteeRef?: string | null; granteeId?: string | null; role: MemoryShareRoleType },
      ctx: Context,
    ) => {
      if (!ctx.userId) {
        throw new GraphQLError('updateMemoryShareRole requires an authenticated user', {
          extensions: { code: 'UNAUTHENTICATED' },
        });
      }
      await requireMemorySharePrincipal(ctx, memoryId);
      const resolvedGranteeId = await resolveGranteeId(ctx, { granteeRef, granteeId });
      try {
        const memoryShare = await withAuthorizedMemoryTx(
          ctx,
          memoryId,
          [{ kind: 'user', id: resolvedGranteeId }],
          (txCtx) => requireMemorySharePrincipal(txCtx, memoryId),
          (_tx, txCtx) => updateMemoryShareRole(txCtx.db, {
            memoryId,
            granteeId: resolvedGranteeId,
            role,
            actorId: ctx.userId!,
          }),
          {
            afterLock: async (tx) => {
              await tx.$queryRaw`
                SELECT memory_id FROM memory_shares
                WHERE memory_id = ${memoryId} AND grantee_id = ${resolvedGranteeId} FOR UPDATE`;
            },
            lockMode: 'exclusive',
          },
        );
        return { memoryShare };
      } catch (e: unknown) {
        if (e instanceof MemoryShareNotFoundError) {
          throw new GraphQLError(e.message, {
            extensions: { code: e.name },
          });
        }
        throw e;
      }
    },

    // 023-app-shape US4 — add a team member to a group-class memory.
    // Caller MUST be an existing owner of the memory.
    addMemoryMember: async (
      _: unknown,
      {
        memoryRef,
        memoryId,
        userRef,
        userId,
        role,
      }: {
        memoryRef?: string | null;
        memoryId?: string | null;
        userRef?: string | null;
        userId?: string | null;
        role: MemoryMemberRoleType;
      },
      ctx: Context,
    ) => {
      // #764: memoryRef/userRef accept id/URN/handle/email. Resolve the memory
      // (a miss maps to the uniform member FORBIDDEN — no existence oracle) +
      // run the owner gate FIRST, then resolve the user — so an unauthorized
      // caller gets FORBIDDEN and can't use NOT_FOUND to enumerate memories or
      // users (mirrors createMemoryShare; #816 review).
      const resolvedMemoryId = await resolveMemoryRefForMemberGate(ctx, { ref: memoryRef, id: memoryId });
      await requireMemoryMemberOwner(ctx, resolvedMemoryId);
      const resolvedUserId = await resolveUserRefArg(ctx.db, { ref: userRef, id: userId });
      try {
        const memoryMember = await retryOnSerializationFailure(() => withAuthorizedMemoryTx(
          ctx, resolvedMemoryId, [{ kind: 'user', id: resolvedUserId }],
          (txCtx) => requireMemoryMemberOwner(txCtx, resolvedMemoryId),
          (tx) => addMemoryMemberInTx(tx, {
            memoryId: resolvedMemoryId, userId: resolvedUserId, role, actorId: ctx.userId!,
          }),
          {
            lockMode: 'exclusive',
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            afterLock: async (tx) => {
              if (ctx.userId) await tx.$queryRaw`
                SELECT user_id FROM memory_members
                WHERE memory_id = ${resolvedMemoryId} AND user_id = ${ctx.userId} FOR SHARE`;
              const rows = await tx.$queryRaw<Array<{ user_id: string }>>`
                SELECT user_id FROM memory_members
                WHERE memory_id = ${resolvedMemoryId} AND user_id = ${resolvedUserId} FOR UPDATE`;
              const fresh = await ctx.db.$queryRaw<Array<{ user_id: string }>>`
                SELECT user_id FROM memory_members
                WHERE memory_id = ${resolvedMemoryId} AND user_id = ${resolvedUserId}`;
              if (Boolean(rows[0]) !== Boolean(fresh[0])) throw new AuthoritySnapshotStale();
            },
          },
        ));
        return { memoryMember };
      } catch (e: unknown) {
        if (
          e instanceof InvalidMemoryClassForMemberError ||
          e instanceof MemoryNotFoundForMemberError ||
          e instanceof MemoryMemberUserMissingError ||
          e instanceof LastOwnerProtectedError
        ) {
          throw new GraphQLError((e as Error).message, {
            extensions: { code: (e as Error).name },
          });
        }
        throw e;
      }
    },

    // 023-app-shape US4 — change the role on a team member. Enforces
    // FR-038 last-owner protection.
    updateMemoryMemberRole: async (
      _: unknown,
      {
        memoryRef,
        memoryId,
        userRef,
        userId,
        role,
      }: {
        memoryRef?: string | null;
        memoryId?: string | null;
        userRef?: string | null;
        userId?: string | null;
        role: MemoryMemberRoleType;
      },
      ctx: Context,
    ) => {
      // #764: resolve memory (miss → uniform member FORBIDDEN, no existence
      // oracle) + owner-gate FIRST, then resolve the user (auth before
      // revealing user existence — #816 review).
      const resolvedMemoryId = await resolveMemoryRefForMemberGate(ctx, { ref: memoryRef, id: memoryId });
      await requireMemoryMemberOwner(ctx, resolvedMemoryId);
      const resolvedUserId = await resolveUserRefArg(ctx.db, { ref: userRef, id: userId });
      try {
        const memoryMember = await retryOnSerializationFailure(() => withAuthorizedMemoryTx(
          ctx, resolvedMemoryId, [{ kind: 'user', id: resolvedUserId }],
          (txCtx) => requireMemoryMemberOwner(txCtx, resolvedMemoryId),
          (tx) => updateMemoryMemberRoleInTx(tx, {
            memoryId: resolvedMemoryId, userId: resolvedUserId, role, actorId: ctx.userId!,
          }),
          {
            lockMode: 'exclusive',
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            afterLock: async (tx) => {
              if (ctx.userId) await tx.$queryRaw`
                SELECT user_id FROM memory_members
                WHERE memory_id = ${resolvedMemoryId} AND user_id = ${ctx.userId} FOR SHARE`;
              const rows = await tx.$queryRaw<Array<{ user_id: string }>>`
                SELECT user_id FROM memory_members
                WHERE memory_id = ${resolvedMemoryId} AND user_id = ${resolvedUserId} FOR UPDATE`;
              const fresh = await ctx.db.$queryRaw<Array<{ user_id: string }>>`
                SELECT user_id FROM memory_members
                WHERE memory_id = ${resolvedMemoryId} AND user_id = ${resolvedUserId}`;
              if (Boolean(rows[0]) !== Boolean(fresh[0])) throw new AuthoritySnapshotStale();
            },
          },
        ));
        return { memoryMember };
      } catch (e: unknown) {
        if (
          e instanceof MemoryMemberNotFoundError ||
          e instanceof InvalidMemoryClassForMemberError ||
          e instanceof MemoryNotFoundForMemberError ||
          e instanceof LastOwnerProtectedError
        ) {
          throw new GraphQLError((e as Error).message, {
            extensions: { code: (e as Error).name },
          });
        }
        throw e;
      }
    },

    // 023-app-shape US4 — remove a team member. Owner OR self-removal.
    // Enforces FR-038 last-owner protection.
    removeMemoryMember: async (
      _: unknown,
      {
        memoryRef,
        memoryId,
        userRef,
        userId,
      }: {
        memoryRef?: string | null;
        memoryId?: string | null;
        userRef?: string | null;
        userId?: string | null;
      },
      ctx: Context,
    ) => {
      // #764 + #816 review: owner-OR-self, with no existence oracle. Resolve
      // the memory (miss → uniform member FORBIDDEN). An OWNER may target any
      // user (resolve normally). A NON-owner may only remove THEMSELVES, so
      // their target resolution maps any miss to the same FORBIDDEN and the
      // resolved id must equal the caller — an unknown handle/email is then
      // indistinguishable from a real user they can't act on.
      const resolvedMemoryId = await resolveMemoryRefForMemberGate(ctx, { ref: memoryRef, id: memoryId });
      let resolvedUserId: string;
      if (await isMemoryMemberOwner(ctx, resolvedMemoryId)) {
        resolvedUserId = await resolveUserRefArg(ctx.db, { ref: userRef, id: userId });
      } else {
        resolvedUserId = await resolveSelfUserRefForMemberGate(ctx, { ref: userRef, id: userId });
        if (resolvedUserId !== ctx.userId) throw memoryMemberForbidden();
      }
      await requireMemoryMemberOwnerOrSelf(ctx, resolvedMemoryId, resolvedUserId);
      try {
        return await retryOnSerializationFailure(() => withAuthorizedMemoryTx(
          ctx, resolvedMemoryId, [{ kind: 'user', id: resolvedUserId }],
          (txCtx) => requireMemoryMemberOwnerOrSelf(txCtx, resolvedMemoryId, resolvedUserId),
          (tx) => removeMemoryMemberInTx(tx, { memoryId: resolvedMemoryId, userId: resolvedUserId }),
          {
            lockMode: 'exclusive',
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            afterLock: async (tx) => {
              if (ctx.userId) await tx.$queryRaw`
                SELECT user_id FROM memory_members
                WHERE memory_id = ${resolvedMemoryId} AND user_id = ${ctx.userId} FOR SHARE`;
              const rows = await tx.$queryRaw<Array<{ user_id: string }>>`
                SELECT user_id FROM memory_members
                WHERE memory_id = ${resolvedMemoryId} AND user_id = ${resolvedUserId} FOR UPDATE`;
              const fresh = await ctx.db.$queryRaw<Array<{ user_id: string }>>`
                SELECT user_id FROM memory_members
                WHERE memory_id = ${resolvedMemoryId} AND user_id = ${resolvedUserId}`;
              if (Boolean(rows[0]) !== Boolean(fresh[0])) throw new AuthoritySnapshotStale();
            },
          },
        ));
      } catch (e: unknown) {
        if (e instanceof LastOwnerProtectedError) {
          throw new GraphQLError(e.message, {
            extensions: { code: e.name },
          });
        }
        throw e;
      }
    },

    // 008-agent-installation: AgentImport bundling. Per spec FR-005 +
    // contracts/agent-app-graphql.md "publishAgentImport".
};
