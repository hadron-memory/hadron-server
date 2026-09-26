// memoryMutations — extracted from resolvers.ts Mutation (split step 2). No behavior change.
import { generateId } from '../../../lib/id.js';
import { mintMemoryUrnV2 } from '../../../lib/mintMemoryUrnV2.js';
import { generateUniqueHandle, ensureUserHandle } from '../../../lib/userHandle.js';
import { ensureUserPrincipal } from '../../../lib/principal/mintPrincipal.js';
import {
  revisionStateHashRefreshMarker,
  editorFromAuth,
} from '../../../lib/nodeRevisionSnapshot.js';
import { encryptToken } from '../../../lib/tokenCrypto.js';
import {
  assertMemoryVisibilityChangeAllowed,
  assertLinkAllowedForPublicAgent,
} from '../../../lib/agentPublicCongruence.js';
import {
  backfillMemoryEmbeddings,
  restampFailedEmbeddings,
} from '../../../services/embedding/enqueue.js';
import { deleteMemoryVectors } from '../../../services/embedding/vectors.js';
import {
  createMemoryShare,
  InvalidMemoryClassForShareError,
  MemoryNotFoundForShareError,
  MemoryShareGranteeMissingError,
  CrossOrgShareNotAllowedError,
} from '../../../controller/operations/createMemoryShare.js';
import { cloneMemoryGraph } from '../../../controller/operations/cloneMemory.js';
import { extractParentNodeGraph } from '../../../controller/operations/extractParentNode.js';
import { mergeMemoryGraph } from '../../../controller/operations/mergeMemories.js';
import { deleteMemoryShare } from '../../../controller/operations/deleteMemoryShare.js';
import {
  updateMemoryShareRole,
  MemoryShareNotFoundError,
} from '../../../controller/operations/updateMemoryShareRole.js';
import {
  addMemoryMember,
  InvalidMemoryClassForMemberError,
  MemoryNotFoundForMemberError,
  MemoryMemberUserMissingError,
} from '../../../controller/operations/addMemoryMember.js';
import {
  updateMemoryMemberRole,
  MemoryMemberNotFoundError,
  LastOwnerProtectedError,
} from '../../../controller/operations/updateMemoryMemberRole.js';
import { removeMemoryMember } from '../../../controller/operations/removeMemoryMember.js';
import {
  type MemoryShareRole as MemoryShareRoleType,
  type MemoryMemberRole as MemoryMemberRoleType,
  type Role,
  type MemoryVisibility,
} from '../../../generated/prisma/index.js';
import { parseDataKey, isCiphertext } from '../../../lib/crypto.js';
import {
  generateKdfSalt,
  deriveDataKeyFromPassphrase,
  makeKeyVerifier,
  DEFAULT_KDF_PARAMS,
} from '../../../lib/memoryUnlock.js';
import { encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import {
  NodeAbstractTooLongError,
  NodeNotFoundError,
  EncryptedVectorIndexNotAcknowledgedError,
  InvalidChunkConfigError,
  UserNotFoundError,
  AmbiguousUserRefError,
} from '../../../lib/entityRef/errors.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveNodeRef } from '../../../lib/entityRef/nodeRef.js';
import { resolveUserRefOrEmail } from '../../../lib/entityRef/userRef.js';
import { canReadMemory } from '../../../mcp/access-control.js';
import { MemoryNotFoundError } from '../../../lib/asset/gate.js';
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
// Spec 049 §8.5 — the memory-level lock Channel creation shares with deleteMemory.
import { lockMemoryForChannelChange } from '../../../lib/channels.js';
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
  requireOwnerOrOrgRole,
  concealUnreadableDenial,
  requireMemoryWriteAccess,
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
  type MergeMemoriesInput,
} from './resolvers.helpers.js';
import { requireOrgAction } from '../../../lib/auth/orgAction.js';

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

export const memoryMutations = {
    mergeMemories: async (
      _: unknown,
      { input }: { input: MergeMemoriesInput },
      ctx: Context,
    ) => {
      const { source: rawSource, target: rawTarget } = input;
      const deleteSourceMem = input.deleteSourceMem ?? false;
      const fields = new Set<NodeMergeField>(input.include ?? ALL_NODE_MERGE_FIELDS);

      const { id: sourceId } = await resolveMemoryRef(ctx.db, rawSource);
      const { id: targetId } = await resolveMemoryRef(ctx.db, rawTarget);
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
      try {
        await mergeMemoryGraph(ctx.db, {
          sourceMemoryId: sourceMem.id,
          targetMemoryId: targetMem.id,
          fields,
          deleteSourceMem,
          editor,
        });
      } catch (e) {
        // Surface the same typed error mergeNodes does, with the offending loc.
        if (e instanceof NodeAbstractTooLongError) {
          throw new GraphQLError(e.message, {
            extensions: {
              code: e.name,
              length: e.length,
              max: e.max,
              loc: (e as NodeAbstractTooLongError & { loc?: string }).loc,
            },
          });
        }
        throw e;
      }

      // Re-embed: the target gained/changed nodes. If it indexes vectors,
      // re-stamp every node pending so the sweep embeds the relocated + merged
      // content (mirrors cloneMemory's backfill). No-op otherwise.
      if (targetMem.vectorIndexEnabled) {
        await backfillMemoryEmbeddings(ctx.db, targetMem.id);
      }

      return ctx.db.memory.findUniqueOrThrow({
        where: { id: targetMem.id },
        include: MEMORY_INCLUDE,
      });
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
        // NOT requireOrgRole, whose global ADMIN/OWNER bypass would let a
        // platform admin create a personal/private memory in an org they don't
        // belong to.
        const orgMembership = await ctx.db.orgMember.findUnique({
          where: { organizationId_userId: { organizationId: resolvedOrgId!, userId: ctx.userId! } },
        });
        if (!orgMembership || orgMembership.deletedAt) {
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
          await ctx.db.memory.delete({ where: { id: existing.id } });
        } else {
          throw new Error(`A memory with URN "${memoryUrn}" already exists`);
        }
      }

      // For group-class memory: bootstrap the creator as the first
      // owner in the same transaction as the Memory create, so the
      // Memory is never persisted in a zero-owner state (which would
      // be effectively unreachable to anyone, including the creator).
      const memory = await ctx.db.$transaction(async (tx) => {
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
        return created;
      });

      // Create the root node for this memory
      const rootName = name.split(':').pop() ?? name;
      await createNode({
        memoryId: memory.id,
        loc: name,
        name: rootName,
      });

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
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id } });
      await requireOwnerOrOrgRole(ctx, memory, 'ADMIN');
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
      // If transferring to a new org, require ADMIN on the target org too
      if (newOrgId && newOrgId !== memory.organizationId) {
        await requireOrgRole(ctx, newOrgId, 'ADMIN');
      }
      // cor:acl:080:03 — un-PUBLIC-ing a COVERED memory that a PUBLIC agent
      // links would break the congruence invariant; reject before persisting.
      // The helper excludes per-user + app-scoped memories (never public).
      if (visibility !== undefined) {
        await assertMemoryVisibilityChangeAllowed(ctx.db, memory, visibility);
      }
      // #621 — friendly guard mirroring chk_memory_max_rev_count_positive.
      // The column is NOT NULL, so explicit `null` is rejected (omit the arg to
      // leave the cap unchanged); only `undefined` (omitted) or >= 1 passes.
      if (maxRevCount === null || (maxRevCount !== undefined && maxRevCount < 1)) {
        throw new GraphQLError('maxRevCount must be at least 1.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      // Rebuild URN if slug or org changed
      const effectiveOrgId = newOrgId ?? memory.organizationId;
      let newUrn: string | undefined;
      if (urn !== undefined || (newOrgId && newOrgId !== memory.organizationId)) {
        if (!effectiveOrgId) {
          throw new GraphQLError('Renaming or transferring the URN is not supported for a user-owned memory yet.', {
            extensions: { code: 'BAD_USER_INPUT' },
          });
        }
        const org = await ctx.db.organization.findUniqueOrThrow({ where: { id: effectiveOrgId }, select: { urn: true } });
        // Guard: a memory slug must be BARE — not a full or embedded URN. The
        // portal settings form once mis-derived the slug from a canonical
        // `hrn:memory:<org>::<slug>` and sent `memory:<org>::<slug>`, which
        // composed into `<org>:memory:<org>::<slug>` and corrupted the row
        // (the prod /app/orgs outage). Reject a client-supplied slug carrying a
        // scheme prefix, a URN type marker at the start, or a `::` hierarchy
        // separator BEFORE the write, so a bad value can never be persisted.
        // (The org-transfer fallback below derives the slug from the stored,
        // already-valid URN, so it's only the client `urn` arg we validate.)
        if (urn !== undefined && /^(hrn|urn|memory|agent|app|node|org):|::/.test(urn)) {
          throw new GraphQLError(
            `Invalid memory slug "${urn}": expected a bare slug (e.g. "experiments"), not a full or prefixed URN.`,
            { extensions: { code: 'BAD_USER_INPUT' } },
          );
        }
        // #574: slugify an explicit client slug (lowercase, illegal chars → '-');
        // the org-transfer fallback reuses the stored URN's already-valid slug.
        const slug = urn !== undefined ? deriveSlugFromName(urn) : memory.urn.split(':').slice(1).join(':');
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
        const [lockedRow] = await tx.$queryRaw<{ urn: string }[]>`
          SELECT urn FROM memories WHERE id = ${id} FOR UPDATE
        `;
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
        return tx.memory.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(newOrgId ? { organizationId: newOrgId } : {}),
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
     * updateMemory: memory owner or org-ADMIN. Returns the count re-stamped;
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
        requireOwnerOrOrgRole(ctx, memory, 'ADMIN'),
      );
      if (!memory.vectorIndexEnabled) return 0;
      return restampFailedEmbeddings(ctx.db, memory.id);
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
      if (memory.class === 'personal' || memory.class === 'private') {
        if (!ctx.userId || memory.userId !== ctx.userId) {
          throw new Error(`Forbidden: only the owner can delete a ${memory.class} memory`);
        }
      } else if (memory.ownerUserId !== null) {
        // spec 047: a user-owned memory is deletable only by its owner.
        if (ctx.userId !== memory.ownerUserId) {
          throw new Error('Forbidden: only the owner can delete this memory');
        }
      } else {
        // Org-owned (the XOR CHECK guarantees ownerUserId is null here ⇒ org is
        // set); assert it explicitly rather than fall back to an empty org id.
        if (memory.organizationId === null) {
          throw new Error('Invariant: org-owned memory has no organizationId');
        }
        // Grant-model gate (design:grant-model P2a) — was requireOrgRole(ADMIN).
        await requireOrgAction(ctx, memory.organizationId, 'memory.delete');
      }
      // System-class memories are owned by their agent and can only be
      // removed by deleting the agent. This prevents the agent from ending
      // up with no brain via a stray deleteMemory call.
      if (memory.class === 'system') {
        throw new Error('Cannot delete an agent system memory directly. Delete the owning agent instead.');
      }
      await ctx.db.$transaction(async (tx) => {
        // Spec 049 §8.5: a memory hosting a live Channel is not deleted around
        // the Channel — delete the Channel through its own operation first.
        // Checked and tombstoned under the memory-level lock Channel creation
        // also takes (`lockMemoryForChannelChange`), so a Channel cannot land
        // between the check and the tombstone (Copilot on PR #1165, round 2).
        await lockMemoryForChannelChange(tx, resolvedId);
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
            throw new Error('Forbidden: only the owner can clone this memory');
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
          where: { organizationId: targetOrgId, userId: ctx.userId, deletedAt: null },
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
          await ctx.db.memory.delete({ where: { id: existing.id } });
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
        ({ id: parentId } = await resolveNodeRef(ctx.db, parentRef));
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
          where: { organizationId: targetOrgId, userId: ctx.userId, deletedAt: null },
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
            throw new Error('Forbidden: only the owner can copy from this memory');
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
            where: { organizationId: targetOrgId, userId: ctx.userId, deletedAt: null },
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
          await ctx.db.memory.delete({ where: { id: existing.id } });
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
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id } });
      await requireOwnerOrOrgRole(ctx, memory, 'ADMIN');
      const encrypted = encryptToken(token);
      return ctx.db.memory.update({
        where: { id },
        data: {
          sourceTokenEncrypted: encrypted,
          sourceTokenExpiresAt: expiresAt ? new Date(expiresAt) : null,
        },
        include: MEMORY_INCLUDE,
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
      // subsequent checks.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentRef);
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryRef);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOwnerOrOrgRole(ctx, agent, 'ADMIN');
      // System-class memories can only be linked via Agent.systemMemoryId.
      // Attaching them as regular memory items would allow access patterns
      // we don't want (e.g. another agent reading the linked agent's prompts).
      const memory = await ctx.db.memory.findUniqueOrThrow({
        where: { id: resolvedMemoryId },
        select: { class: true, visibility: true, appId: true },
      });
      if (memory.class === 'system') {
        throw new Error('Agent system memories can only be attached via systemMemoryId, not as a memory item');
      }
      // #1101 — strict-owner classes are not attachable, for a different reason
      // than `system` above. `AgentMemoryItem` is a fold INPUT: an attached
      // memory lands in `getAppMemoryAccess`, which the MCP access map and the
      // GraphQL enumeration gate (#1092) both build on, and which is DOCUMENTED
      // personal-free with `getAccessibleMemoryIds` consumers told to rely on
      // it. Nothing enforced that. Measured before this gate existed: a pure
      // App key's accessible set returned another user's personal memory, while
      // MCP's `canReadMemory` refused the same principal the same row.
      //
      // The deeper reason it cannot be right is that an attach is a GRANT to an
      // audience, and these two classes HAVE no audience beyond their owner
      // (`cor:acl:010:01`/`:02` — not even a platform ADMIN). So the org ADMIN
      // authorized to run this mutation is, by construction, granting reach over
      // a memory they may not themselves read. There is no correct role for it,
      // which is why this is a refusal rather than a stricter permission.
      //
      // MemoryShare is the supported way to give someone else a personal
      // memory, and it is per-user rather than per-audience.
      if (memory.class === 'personal' || memory.class === 'private') {
        // Two messages, not one parameterized one (PR #1106 review, @copilot).
        // The classes differ in the only respect the message is FOR — what the
        // caller should do instead — so a shared sentence with a conditional
        // tail told `private` to use a share that class cannot have.
        //
        // And `personal` is NOT "readable only by its owner": a MemoryShare
        // grantee reads it, which is the whole subject of #1104/#1105, merged a
        // day before this line was written. `cor:acl:010:01`'s shorthand is
        // "owner-only" because it is contrasting with org-wide audiences; in an
        // error message aimed at someone choosing their next action, that
        // shorthand is simply wrong.
        // The remedy is addressed to the OWNER, not to the caller (PR #1106
        // review, @codex P2). The principal who reaches this refusal is an org
        // ADMIN — and `createMemoryShare` gates on `isMemorySharePrincipal`,
        // which is a bare `memory.userId === ctx.userId` with no admin path. So
        // "use createMemoryShare" sent an authorized agent administrator into a
        // guaranteed FORBIDDEN: two correct gates composing into a dead end,
        // which is only visible if you check that the ACTOR the message speaks
        // to can perform the act it names.
        // THIS MESSAGE DELIBERATELY DOES NOT DESCRIBE WHO CAN READ THE MEMORY,
        // and that is the third round of review talking (PR #1106: @copilot,
        // then @codex ×2). Every attempt to state the read audience was wrong
        // in a new way — "owner only" ignores share grantees (#1104); "owner
        // and anyone they shared with" is false for an AGENT-SCOPED personal
        // row, where `granteeShareAccess` excludes the share outright and
        // `resolveMemoryAuthorization` additionally demands an active
        // AgentSubscription. Three wordings, three wrong claims.
        //
        // The refusal never needed any of them. It rests on one property —
        // this class has no AUDIENCE to grant to — which is true of every row
        // in both classes and cannot rot. Stating the read set was a second
        // claim the rule does not need, from a surface the rule does not
        // govern; the same discipline `cor:urn:010:04` records for specs.
        //
        // What the message DOES owe the caller is the actor: access is the
        // owner's to give and not an administrator's, so a non-owner is told to
        // ask rather than sent to a mutation that will refuse them (@codex P2 —
        // `isMemorySharePrincipal` is a bare owner check). Note it names
        // createMemoryShare as the MECHANISM and the owner as the only caller,
        // without claiming a share is by itself SUFFICIENT — for an
        // agent-scoped row it is not.
        throw new GraphQLError(
          memory.class === 'private'
            ? 'A private-class memory cannot be attached to an agent — an attach grants the agent’s whole audience, and this class has no audience to grant. Private memories are never shareable either, not even by their owner. If this content needs to reach an agent, it has to live in a memory whose class has readers.'
            : 'A personal-class memory cannot be attached to an agent — an attach grants the agent’s whole audience, and this class has no audience to grant. Giving another person access is the owner’s to do, not an administrator’s: createMemoryShare is the mechanism and only the owner may call it, so if you are not the owner, ask them.',
          {
            extensions: {
              code: 'UNSUPPORTED_MEMORY_CLASS',
              memoryId: resolvedMemoryId,
              memoryClass: memory.class,
            },
          },
        );
      }
      // cor:acl:080:03 — a PUBLIC agent may reference only PUBLIC knowledge:
      // reject linking a covered (non-per-user, non-app-scoped), non-PUBLIC
      // memory to a PUBLIC agent.
      await assertLinkAllowedForPublicAgent(agent.visibility, memory);
      // Upsert semantics (#501): granting is idempotent — re-attaching an
      // already-attached memory updates the role, and a soft-deleted grant
      // row (which still occupies the @@unique(agentId, memoryId) slot) is
      // resurrected instead of surfacing a raw P2002.
      await ctx.db.agentMemoryItem.upsert({
        where: { agentId_memoryId: { agentId: resolvedAgentId, memoryId: resolvedMemoryId } },
        create: {
          agentId: resolvedAgentId,
          memoryId: resolvedMemoryId,
          role: role ?? 'read',
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
        update: {
          role: role ?? 'read',
          deletedAt: null,
          deletedBy: null,
          updatedAt: new Date(),
          updatedBy: ctx.userId ?? ctx.clientId ?? null,
        },
      });
      return ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId }, include: AGENT_INCLUDE });
    },

    updateAgentMemoryRole: async (
      _: unknown,
      { agentRef, memoryRef, role }: { agentRef: string; memoryRef: string; role: string },
      ctx: Context,
    ) => {
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentRef);
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryRef);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOwnerOrOrgRole(ctx, agent, 'ADMIN');
      // #501: only a LIVE grant is updatable — updateMany + deletedAt:null
      // (findUnique on the composite PK can't filter soft-deletes; the
      // requireOrgRole-pattern rule from findings:revoked-membership-auth-
      // gates, PR-512 review). Zero rows = typed NOT_FOUND, never a raw
      // P2025 → 500; a soft-deleted grant stays inactive until
      // addMemoryToAgent resurrects it.
      const updated = await ctx.db.agentMemoryItem.updateMany({
        where: { agentId: resolvedAgentId, memoryId: resolvedMemoryId, deletedAt: null },
        data: { role },
      });
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
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentRef);
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryRef);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOwnerOrOrgRole(ctx, agent, 'ADMIN');
      await ctx.db.agentMemoryItem.delete({
        where: { agentId_memoryId: { agentId: resolvedAgentId, memoryId: resolvedMemoryId } },
      });
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
      const resolvedOrgId = await resolveOrgRefArg(ctx.db, { ref: orgRef, id: orgId });
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });

      // 035-visibility-enum-cleanup: only PUBLIC memories are cross-org
      // subscribable. ORGANIZATION/GROUP/NULL (personal/private/app/system)
      // are all rejected (PRIVATE is gone from the enum).
      if (memory.visibility !== 'PUBLIC') {
        throw new Error('Only public memories can be subscribed to by other organizations');
      }

      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');

      if (memory.organizationId === resolvedOrgId) {
        throw new Error('Owner organization has implicit access and cannot subscribe');
      }

      return ctx.db.memorySubscription.create({
        data: { id: generateId(), memoryId: resolvedMemoryId, organizationId: resolvedOrgId, role: role as Role, createdBy: ctx.userId ?? ctx.clientId ?? null },
        include: { memory: { include: MEMORY_INCLUDE }, organization: { include: ORG_INCLUDE } },
      });
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
      const resolvedOrgId = await resolveOrgRefArg(ctx.db, { ref: orgRef, id: orgId });
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
      await requireOwnerOrOrgRole(ctx, memory, 'ADMIN');
      return ctx.db.memorySubscription.update({
        where: { memoryId_organizationId: { memoryId: resolvedMemoryId, organizationId: resolvedOrgId } },
        data: { role: role as Role },
        include: { memory: { include: MEMORY_INCLUDE }, organization: { include: ORG_INCLUDE } },
      });
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
      const resolvedOrgId = await resolveOrgRefArg(ctx.db, { ref: orgRef, id: orgId });
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
      // findFirst + deletedAt in both checks so a REVOKED membership no
      // longer authorizes subscription management (same rule as requireOrgRole).
      const isOwnerAdmin = async () => {
        if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return true;
        if (!ctx.userId) return false;
        // spec 047: a user-owned memory has no org — no org-admin via this path.
        if (memory.organizationId === null) return false;
        const m = await ctx.db.orgMember.findFirst({
          where: { organizationId: memory.organizationId, userId: ctx.userId, deletedAt: null },
        });
        return m?.role === 'ADMIN' || m?.role === 'OWNER';
      };
      const isSubscriberAdmin = async () => {
        if (!ctx.userId) return false;
        const m = await ctx.db.orgMember.findFirst({
          where: { organizationId: resolvedOrgId, userId: ctx.userId, deletedAt: null },
        });
        return m?.role === 'ADMIN' || m?.role === 'OWNER';
      };
      if (!(await isOwnerAdmin()) && !(await isSubscriberAdmin())) {
        throw new Error('Forbidden');
      }
      await ctx.db.memorySubscription.delete({
        where: { memoryId_organizationId: { memoryId: resolvedMemoryId, organizationId: resolvedOrgId } },
      });
      return true;
    },

    syncMemory: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const memory = await ctx.db.memory.findUniqueOrThrow({
        where: { id },
        include: { organization: true },
      });
      await requireOwnerOrOrgRole(ctx, memory, 'CONTRIBUTOR');

      const result = await syncGraphFromGithub(memory);
      if (result.error) throw new Error(result.error);

      // #1061 — one write per node the sync actually wrote. This mutation and
      // the `hadron_sync_graph` MCP tool are the two sync entry points with a
      // principal to attribute to; the webhook and the startup batch loop
      // deliberately drop `writtenNodes`, because an unattended sync is nobody's
      // usage (PR #1062 review — Copilot).
      recordNodeUsage(ctx.db, 'write', result.writtenNodes ?? [], ctx);

      return ctx.db.memory.findUniqueOrThrow({ where: { id }, include: MEMORY_INCLUDE });
    },

    pushMemoryToGit: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id } });
      await requireOwnerOrOrgRole(ctx, memory, 'ADMIN');

      const { pushMemoryToGit: push } = await import('../../../integrations/github/pushMemoryToGit.js');
      const result = await push(id);
      if (result.error) throw new Error(result.error);
      return true;
    },

    // ── Exchange integration mutations ──────────────────────────────────
    // Connection is created via OAuth at /auth/microsoft (no GraphQL mutation needed)

    linkMemoryToUser: async (
      _: unknown,
      { memoryId, externalUserId, dataKey }: { memoryId: string; externalUserId: string; dataKey?: string },
      ctx: Context,
    ) => {
      if (!ctx.appId) throw new Error('Forbidden: App Key required');
      // 007-entity-id-or-urn: memoryId may be ID, bare URN, or prefixed URN.
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: ctx.appId } });
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
      if (memory.organizationId !== app.organizationId) {
        throw new Error('Forbidden: memory does not belong to this app\'s organization');
      }
      if (!memory.userMemoryOfAgentId) {
        throw new Error('Only user/anonymous memories can be linked');
      }

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
        where: { id: memory.userMemoryOfAgentId },
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

      // If a dataKey is provided and the memory isn't already encrypted,
      // encrypt every node in a single transaction, then flip isEncrypted.
      // This is the anonymous → registered promotion path.
      // 041 (#516): 'private' is the only encryptable class, so an encrypted
      // promotion lands the memory as class='private' owned by the registered
      // user (the anon scratch memory was class='app', userId NULL). The
      // plaintext branch below leaves the App-scoped class untouched.
      if (dataKey && !memory.isEncrypted) {
        const key = parseDataKey(dataKey);
        const nodes = await ctx.db.node.findMany({
          where: { memoryId: resolvedMemoryId, deletedAt: null },
          // abstract encrypts alongside content since spec 031 — selecting only
          // content+data here would leave abstracts plaintext on a memory marked
          // encrypted (matches the encryptMemory fix below).
          select: { id: true, content: true, abstract: true, data: true },
        });
        await ctx.db.$transaction(async (tx) => {
          for (const node of nodes) {
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
          await tx.memory.update({
            where: { id: resolvedMemoryId },
            data: {
              urn: newUrn,
              createdBy: user.id,
              anonymousExpiresAt: null,
              isEncrypted: true,
              // 041 (#516): encrypted ⇒ class='private'; set the owner so the
              // bidirectional chk_personal_visibility_user (private ⇔ userId)
              // holds. userMemoryOfAgentId + appId are already set on the anon
              // row, satisfying chk_memory_personal_agent_id / _class_app_id.
              class: 'private',
              userId: user.id,
              updatedBy: ctx.appId,
            },
          });
        });
        return ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
      }

      // #1079 — same rename, unencrypted branch. Wrapped so the alias and the
      // rewrite commit together rather than as two independent writes.
      return ctx.db.$transaction(async (tx) => {
        await recordUrnRename(tx, {
          entityType: 'MEMORY',
          entityId: resolvedMemoryId,
          oldUrn: memory.urn,
          newUrn,
          createdBy: user.id,
        });
        return tx.memory.update({
        where: { id: resolvedMemoryId },
        data: {
          urn: newUrn,
          createdBy: user.id,
          anonymousExpiresAt: null,
          updatedBy: ctx.appId,
        },
        });
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
      // Auth: the App-key path (same org — the SECRET-mode flow) OR the
      // memory's OWNER (private memories are owner-only; spec 041 makes
      // self-encryption a first-class user action).
      if (ctx.appId) {
        const app = await ctx.db.app.findUniqueOrThrow({ where: { id: ctx.appId } });
        if (memory.organizationId !== app.organizationId) {
          throw new Error('Forbidden: memory does not belong to this app\'s organization');
        }
      } else if (!ctx.userId || memory.userId !== ctx.userId) {
        throw new GraphQLError('Only the memory owner (or an org App) may encrypt it.', {
          extensions: { code: 'FORBIDDEN' },
        });
      }
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
      if (memory.isEncrypted) {
        throw new Error('Memory is already encrypted');
      }
      // Vector indexing on an encrypted memory requires the FR-026 ack;
      // converting an INDEXED memory would violate chk_memory_vector_
      // encrypted_ack — surface it as a typed error, not a DB error.
      if (memory.vectorIndexEnabled && !memory.vectorIndexEncryptedAckAt) {
        throw new GraphQLError(
          'Disable the vector index (or acknowledge the inversion disclosure) before encrypting.',
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }
      let key;
      let kdfFields: { kdfSalt?: string; kdfParams?: InputJsonValue } = {};
      if (passphrase) {
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
      // enc:v1 prefix (isCiphertext), so re-running a pass is safe.
      await ctx.db.memory.update({
        where: { id: resolvedMemoryId },
        data: {
          isEncrypted: true,
          keyVerifier: makeKeyVerifier(key),
          ...kdfFields,
          updatedBy: ctx.appId ?? ctx.userId ?? null,
        },
      });
      const BATCH = 200; // bound memory per pass (PR-514 review, Gemini)
      for (let pass = 0; pass < 5; pass++) {
        let converted = 0;
        // Paginate by id to keep memory bounded for large graphs.
        let cursor: string | undefined;
        for (;;) {
          const nodes = await ctx.db.node.findMany({
            where: { memoryId: resolvedMemoryId, deletedAt: null },
            // abstract encrypts alongside content since spec 031 — the old
            // select missed it, leaving abstracts plaintext (spec-041 fix).
            select: { id: true, content: true, abstract: true, data: true },
            orderBy: { id: 'asc' },
            take: BATCH,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          });
          if (nodes.length === 0) break;
          cursor = nodes[nodes.length - 1].id;
          for (const node of nodes) {
            const plaintextContent = node.content != null && !isCiphertext(node.content);
            const plaintextAbstract = node.abstract != null && !isCiphertext(node.abstract);
            const plaintextData =
              node.data != null &&
              !(typeof node.data === 'object' && (node.data as { __enc?: string }).__enc);
            if (!plaintextContent && !plaintextAbstract && !plaintextData) continue;
            const encrypted = encryptNodeFieldsWithKey(
              { content: node.content, abstract: node.abstract, data: node.data },
              key,
            );
            await ctx.db.node.update({
              where: { id: node.id },
              data: {
                content: encrypted.content ?? null,
                revisionContentHash: revisionStateHashRefreshMarker(),
                abstract: encrypted.abstract ?? null,
                data: (encrypted.data ?? null) as InputJsonValue,
              },
            });
            converted += 1;
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
      return ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
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
        const memoryShare = await createMemoryShare(ctx.db, {
          memoryId,
          granteeId: resolvedGranteeId,
          role,
          actorId: ctx.userId,
        });
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
      await deleteMemoryShare(ctx.db, {
        memoryId: resolvedMemoryId,
        granteeId: resolvedGranteeId,
      });
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
        const memoryShare = await updateMemoryShareRole(ctx.db, {
          memoryId,
          granteeId: resolvedGranteeId,
          role,
          actorId: ctx.userId,
        });
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
        const memoryMember = await addMemoryMember(ctx.db, {
          memoryId: resolvedMemoryId,
          userId: resolvedUserId,
          role,
          actorId: ctx.userId!,
        });
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
        const memoryMember = await updateMemoryMemberRole(ctx.db, {
          memoryId: resolvedMemoryId,
          userId: resolvedUserId,
          role,
          actorId: ctx.userId!,
        });
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
        return await removeMemoryMember(ctx.db, { memoryId: resolvedMemoryId, userId: resolvedUserId });
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
