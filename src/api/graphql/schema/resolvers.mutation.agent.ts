// agentMutations — extracted from resolvers.ts Mutation (split step 2). No behavior change.
import { encryptToken } from '../../../lib/tokenCrypto.js';
import { assertAgentPublicAllowed } from '../../../lib/agentPublicCongruence.js';
import {
  assertSystemMemoryOwner,
  repairAgentSystemMemoryOwner,
} from '../../../lib/agentSystemMemory.js';
import {
  AiServiceConfigNotFoundError,
  AiConfigValidationError,
  DuplicateAiServiceConfigNameError,
  DEFAULT_AI_CONFIG_NAME,
  apiKeyWriteFields,
  apiKeyPreviewOf,
  validateAiConfigName,
  validateProviderAndParams,
  type AiConfigOwnerType,
} from '../../../lib/aiConfig.js';
import {
  publishAgentImport,
  SelfImportError,
  MultiLevelImportError,
  MissingGrantError,
  PositionConflictError,
} from '../../../controller/operations/publishAgentImport.js';
import { ensureAgentOrgGrant } from '../../../controller/operations/ensureAgentOrgGrant.js';
import { removeAgentImport } from '../../../controller/operations/removeAgentImport.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { deriveSlugFromName } from '../../../lib/urn.js';
import { normalizeHandleOrNull } from '../../../lib/userHandle.js';
import { generateId } from '../../../lib/id.js';
import { isLifecycleActive } from '@hadron-memory/access-control';
import { GraphQLError } from 'graphql';
import { type InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import {
  Prisma,
  type AgentVisibility,
} from '../../../generated/prisma/index.js';
import {
  type Context,
  requireOrgRole,
  requireOwnerOrOrgRole,
  aiConfigOwnerOf,
  toGqlAiServiceConfig,
  requireAiConfigOwnerAdmin,
  rethrowAiConfigTyped,
  resolveUserRefArg,
  resolveAgentRefArg,
  AGENT_INCLUDE,
} from './resolvers.helpers.js';
import { recordUrnRename } from '../../../lib/urnAlias.js';

/**
 * #928/#929 review: persona dressing fields are trimmed, and a blank-after-trim
 * value is NULL (absent on create, clear on update). undefined passes through
 * (omitted arg = no change on update).
 */
const normalizePersonaField = (v: string | null | undefined): string | null | undefined => {
  if (v === undefined || v === null) return v;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * #935: a live Agent already holds the derived URN. Typed (rather than the
 * former bare `Error`) so API callers get a stable code instead of
 * INTERNAL_SERVER_ERROR.
 */
export class AgentUrnTakenError extends GraphQLError {
  constructor(urn: string, message?: string) {
    super(message ?? `An agent with URN "${urn}" already exists`, {
      extensions: { code: 'AGENT_URN_TAKEN', urn },
    });
  }
}

/**
 * Owner-resolved inputs for {@link createAgentCore}: exactly one of
 * `organizationId` / `ownerUserId` is set (spec 047 XOR), and `namespace` is
 * the matching URN owner atom (org URN or the user's bare handle). The caller
 * is responsible for AUTHORIZATION — the core only creates.
 */
export interface CreateAgentCoreInput {
  organizationId: string | null;
  ownerUserId: string | null;
  namespace: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  systemMemoryId?: string;
  visibility?: string;
  type?: 'ASSISTANT' | 'CHATBOT';
  surfaces?: string[];
  personaRole?: string | null;
  personaPrompt?: string | null;
}

/**
 * The authorization-free core of createAgent: URN compose + reclaim, type/
 * visibility defaults, and the one transaction that provisions the system
 * memory alongside the Agent row. (Extracted for #935; the Worker re-cut of
 * #974 removed its persona-minting caller, so createAgent is its one caller
 * again.) Persona dressing fields (`personaRole`/`personaPrompt` —
 * cor:agt:020:01) are normalized here (blank-after-trim ⇒ NULL); the named
 * identity lives on the Worker entity, never here.
 */
export async function createAgentCore(ctx: Context, input: CreateAgentCoreInput) {
  const {
    organizationId: resolvedOrgId,
    ownerUserId,
    namespace,
    name,
    description,
    systemPrompt,
    systemMemoryId,
    visibility,
    type,
    surfaces,
  } = input;
  // #929 review: normalize persona dressing inputs before anything touches
  // them.
  const personaRoleNorm = normalizePersonaField(input.personaRole);
  const personaPromptNorm = normalizePersonaField(input.personaPrompt);
  // #574: slugify the display name — a raw name would persist a
  // case-sensitive / space-bearing URN (and the system memory URN derives
  // from this one, so it inherits the clean slug).
  const agentSlug = deriveSlugFromName(name);
  const agentUrn = `${namespace}:${agentSlug}`;
  // Check for existing agent with the same URN. A tombstone is reclaimed —
  // worker-name permanence lives on Worker rows (cor:agt:020:02), never on
  // agent tombstones (the #974 re-cut removed the persona-reservation branch
  // here; a Worker's agent FK is Restrict, so a casting's agent can't be a
  // hard-deletable tombstone anyway).
  const existing = await ctx.db.agent.findUnique({ where: { urn: agentUrn } });
  if (existing) {
    if (existing.deletedAt) {
      await ctx.db.agent.delete({ where: { id: existing.id } }).catch((e: unknown) => {
        // P2003 = a Worker casting still references the tombstone (Restrict):
        // the URN slot is genuinely occupied — refuse typed, don't 500.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
          throw new AgentUrnTakenError(
            agentUrn,
            `URN "${agentUrn}" belongs to a deleted agent that still has Worker castings — their history keeps it reserved.`,
          );
        }
        throw e;
      });
    } else {
      throw new AgentUrnTakenError(agentUrn);
    }
  }
  // Defaults: CHATBOT when systemMemoryId is set (wizard flow), otherwise ASSISTANT.
  const inferredType = type ?? (systemMemoryId ? 'CHATBOT' : 'ASSISTANT');
  const defaultSurfaces = inferredType === 'CHATBOT' ? ['api'] : ['mcp'];
  const agentVisibility = (visibility as AgentVisibility) ?? 'PERSONAL';
  // spec 047: a user-owned agent is owner-only in v1 (no sharing / no
  // cross-install). Forbid a non-PERSONAL visibility so it can never become
  // PUBLIC (which the install gate would let a foreign org install, exposing
  // the agent's user-owned memories to that App's members).
  if (ownerUserId !== null && agentVisibility !== 'PERSONAL') {
    throw new GraphQLError('A personal (user-owned) agent must be PERSONAL — sharing a user-owned agent is not supported yet.', { extensions: { code: 'BAD_USER_INPUT' } });
  }

  // Every agent owns a system memory (cor:dmo:050:01 — the Agent carries a
  // pointer to its own class='system' memory). Two entry points:
  //   1. systemMemoryId supplied (wizard flow) → promote that existing
  //      memory to class='system'.
  //   2. no systemMemoryId → auto-provision a fresh class='system' memory.
  // This applies regardless of the legacy ASSISTANT/CHATBOT type, which is
  // not load-bearing (cor:dmo:050:01 "what invalidates this spec").
  // The memory-provision + agent-create run in one transaction so a
  // failure never leaves a dangling system memory or an ownerless agent.
  //
  // 035-visibility-enum-cleanup: a system memory is marked by `class` (not
  // the dropped `type` column) and its `visibility` is always NULL
  // (chk_memory_visibility_class forbids a non-null visibility on
  // class='system'); agent visibility does not sync onto it.
  const createdAgent = await ctx.db.$transaction(async (tx) => {
    let resolvedSystemMemoryId: string;
    if (systemMemoryId) {
      const target = await tx.memory.findUniqueOrThrow({ where: { id: systemMemoryId } });
      // spec 047 / #949: the promoted memory must share the agent's owner —
      // same org (org-owned) OR same user (user-owned). One shared assertion
      // so this path and updateAgent's first-attach can't drift.
      assertSystemMemoryOwner(
        { organizationId: resolvedOrgId, ownerUserId },
        { organizationId: target.organizationId, ownerUserId: target.ownerUserId, id: target.id },
      );
      const otherAgent = await tx.agent.findFirst({
        where: { systemMemoryId, deletedAt: null },
        select: { id: true },
      });
      if (otherAgent) {
        throw new Error('This memory is already the system memory of another agent');
      }
      await tx.memory.update({
        where: { id: systemMemoryId },
        data: {
          class: 'system',
          name: `${name} System`,
          visibility: null,
          // system-class memories must opt out of uploads (schema.prisma,
          // 006-asset-upload-redesign). Applies when promoting too, not
          // just on auto-provision. #519 review.
          acceptsUploads: false,
        },
      });
      resolvedSystemMemoryId = systemMemoryId;
    } else {
      // Auto-provision. The memory URN derives from the (unique) agent URN
      // so it's collision-free and stable. If a soft-deleted memory still
      // holds that URN (e.g. an earlier agent at this URN was deleted),
      // hard-delete it first — mirrors createMemory's URN-reclaim path.
      const systemMemoryUrn = `${agentUrn}-system`;
      const staleHolder = await tx.memory.findUnique({ where: { urn: systemMemoryUrn } });
      if (staleHolder) {
        if (staleHolder.deletedAt) {
          await tx.memory.delete({ where: { id: staleHolder.id } });
        } else {
          // #935: typed — under racing creates of the same name, the loser
          // can land HERE (the winner's system memory committed between the
          // agent-urn pre-check and this one), and allocation loops must see
          // the same slot-occupied refusal as every other urn collision.
          throw new AgentUrnTakenError(
            agentUrn,
            `A memory with URN "${systemMemoryUrn}" already exists`,
          );
        }
      }
      const systemMemory = await tx.memory.create({
        data: {
          id: generateId(),
          organizationId: resolvedOrgId,
          ownerUserId,
          urn: systemMemoryUrn,
          name: `${name} System`,
          class: 'system',
          // system-class memories must opt out of uploads (schema.prisma,
          // 006-asset-upload-redesign — DB default is true; the asset gate
          // only checks Memory.acceptsUploads after write auth). #519 review.
          acceptsUploads: false,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
      });
      resolvedSystemMemoryId = systemMemory.id;
    }

    return tx.agent.create({
      data: {
        organizationId: resolvedOrgId, ownerUserId, urn: agentUrn, name, description, systemPrompt, systemMemoryId: resolvedSystemMemoryId,
        visibility: agentVisibility,
        type: inferredType,
        surfaces: surfaces ?? defaultSurfaces,
        // #928 persona dressing — pure metadata (see schema.prisma).
        personaRole: personaRoleNorm, personaPrompt: personaPromptNorm,
        createdBy: ctx.userId ?? ctx.clientId ?? null,
      },
      include: AGENT_INCLUDE,
    });
  }).catch((e: unknown) => {
    // #935: under CONCURRENT creates the pre-check above races — the loser
    // surfaces as P2002 on the agent (or derived system-memory) urn unique
    // instead. Map it to the same typed refusal the pre-check throws, so
    // callers see a stable code instead of a raw P2002.
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002' &&
      String((e.meta as { target?: unknown } | undefined)?.target ?? '').includes('urn')
    ) {
      throw new AgentUrnTakenError(agentUrn);
    }
    throw e;
  });
  return createdAgent;
}

export const agentMutations = {
    createAgent: async (
      _: unknown,
      { orgId, name, description, systemPrompt, systemMemoryId, visibility, type, surfaces, personaRole, personaPrompt }: { orgId?: string | null; name: string; description?: string; systemPrompt?: string; systemMemoryId?: string; visibility?: string; type?: 'ASSISTANT' | 'CHATBOT'; surfaces?: string[]; personaRole?: string; personaPrompt?: string },
      ctx: Context,
    ) => {
      // spec 047: an agent is owned by EXACTLY ONE of an org or a user. `orgId`
      // present ⇒ org-owned (org ADMIN); `orgId` omitted ⇒ user-owned by the
      // caller, namespaced under their `@<handle>`. The chosen `namespace` is
      // the URN owner-atom (org domain OR `@<handle>`) — the rest of the compose
      // path is identical, and the system memory inherits the same owner.
      let resolvedOrgId: string | null = null;
      let ownerUserId: string | null = null;
      let namespace: string;
      // An EMPTY-STRING orgId is a malformed request, not a personal-create
      // signal — reject it explicitly so a client bug can't silently bypass the
      // org resolution + ADMIN gate and create a personal agent instead (empty
      // string is a common "unset" sentinel elsewhere in this file). Omit orgId
      // entirely to create a personal agent. (Copilot review, #682.)
      if (orgId !== undefined && orgId !== null && orgId.trim() === '') {
        throw new GraphQLError('orgId must be a non-empty organization ID or URN — omit it entirely to create a personal agent.', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      if (orgId) {
        // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
        const { id } = await resolveOrgRef(ctx.db, orgId);
        await requireOrgRole(ctx, id, 'ADMIN');
        const org = await ctx.db.organization.findUniqueOrThrow({ where: { id }, select: { urn: true } });
        resolvedOrgId = id;
        namespace = org.urn;
      } else {
        if (!ctx.userId) {
          throw new GraphQLError('Creating a personal agent requires an authenticated user.', { extensions: { code: 'UNAUTHENTICATED' } });
        }
        const user = await ctx.db.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { handle: true } });
        const handle = normalizeHandleOrNull(user.handle);
        if (!handle) {
          throw new GraphQLError('Your account needs a valid handle before you can create a personal agent. Set one in your profile.', { extensions: { code: 'BAD_USER_INPUT' } });
        }
        ownerUserId = ctx.userId;
        // #697 v2: a user-owned root is the BARE handle — no `@` sigil (the
        // per-server principal pool makes handle/org names disjoint, so the
        // sigil is unnecessary and would break round-trip: emission strips it,
        // so a stored `@handle:slug` can't be found from the emitted
        // `hrn:agent:handle:slug`). The legacy `@handle:...` INPUT form still
        // resolves migrated rows via the stored alias map (#697 Task A).
        namespace = handle;
      }
      // #935: authorization + owner resolution above, provisioning in the
      // shared core.
      return createAgentCore(ctx, {
        organizationId: resolvedOrgId,
        ownerUserId,
        namespace,
        name,
        description,
        systemPrompt,
        systemMemoryId,
        visibility,
        type,
        surfaces,
        personaRole,
        personaPrompt,
      });
    },

    updateAgent: async (
      _: unknown,
      { ref, name, urn, description, systemPrompt, systemMemoryId, visibility, listedOnMarketplace, type, surfaces, personaRole, personaPrompt, registerDefaults }: { ref: string; name?: string; urn?: string; description?: string; systemPrompt?: string; systemMemoryId?: string; visibility?: string; listedOnMarketplace?: boolean; type?: 'ASSISTANT' | 'CHATBOT'; surfaces?: string[]; personaRole?: string | null; personaPrompt?: string | null; registerDefaults?: { mentionOnly?: boolean | null } | null },
      ctx: Context,
    ) => {
      // #929 review: normalize persona dressing (blank-after-trim clears).
      const personaRoleNorm = normalizePersonaField(personaRole);
      const personaPromptNorm = normalizePersonaField(personaPrompt);
      // #789 / cor:api:140 — was a PK-only findUniqueOrThrow, so a caller
      // holding a URN or handle had to pre-resolve it. resolveAgentRef is a
      // pure lookup and does NOT authorize (#554): the resource-scoped
      // requireOwnerOrOrgRole below still runs on the RESOLVED agent.
      const { id } = await resolveAgentRef(ctx.db, ref);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id } });
      await requireOwnerOrOrgRole(ctx, agent, 'ADMIN');
      // spec 047 (codex review, #682): a user-owned agent is owner-only in v1 —
      // it must NEVER become non-PERSONAL. The create-time guard alone is
      // insufficient: without this, an owner could create a PERSONAL agent and
      // then update it to PUBLIC, which would expose its definition AND let a
      // foreign org install it (folding the user-owned system memory into that
      // App's readable set). Applies to a user-owned agent (ownerUserId set).
      if (agent.ownerUserId !== null && visibility !== undefined && visibility !== 'PERSONAL') {
        throw new GraphQLError('A personal (user-owned) agent must stay PERSONAL — sharing a user-owned agent is not supported yet.', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      // cor:acl:080:03 — congruence invariant: an agent may become PUBLIC only
      // if every knowledge memory it links (excluding per-user personal/private)
      // is itself PUBLIC. Checked against the CURRENT links before persisting.
      // cor:acl:080:03 — congruence: an agent may become PUBLIC only if every
      // knowledge memory it links is itself PUBLIC, and (#1349) only if it
      // holds no read-write knowledge.
      //
      // Checked TWICE, deliberately (@codex P2, PR #1357). The authoritative
      // check is under the agent row lock in the transaction below, because
      // checking here and writing there let an `updateAgentMemoryRole(
      // read-write)` interleave. But the locked check alone is too LATE for a
      // call that also supplies a first `systemMemoryId`: the promotion below
      // converts the target memory to class='system', clears its visibility and
      // disables uploads in its OWN transaction, so a later rejection rolled
      // that back nowhere and left a mutated orphan the agent never attached.
      // This early pass is the fail-fast that keeps the refusal ahead of any
      // externally visible mutation; the locked one still decides.
      if (visibility === 'PUBLIC') {
        await assertAgentPublicAllowed(ctx.db, id);
      }
      let newUrn: string | undefined;
      if (urn !== undefined) {
        if (!agent.organizationId) {
          throw new GraphQLError('Renaming via urn is not supported for user-owned agents.', { extensions: { code: 'BAD_USER_INPUT' } });
        }
        const org = await ctx.db.organization.findUniqueOrThrow({ where: { id: agent.organizationId }, select: { urn: true } });
        const renamedSlug = deriveSlugFromName(urn); // #574: slugify the explicit rename slug
        newUrn = `${org.urn}:${renamedSlug}`;
      }

      // ── systemMemoryId: first-attach is allowed, but unset/change are not.
      // Rationale: once an agent has a brain, swapping it destroys the
      // scaffold and confuses the UX. Users who want a different brain
      // should delete the agent and create a new one.
      if (systemMemoryId !== undefined) {
        const incoming = systemMemoryId === '' ? null : systemMemoryId;
        if (agent.systemMemoryId && incoming !== agent.systemMemoryId) {
          throw new Error('Cannot unset or change an agent\'s system memory. Delete the agent to replace it.');
        }
        if (!agent.systemMemoryId && incoming) {
          // First-attach: verify the target memory exists, belongs to this
          // org, isn't already another agent's system memory, and promote it
          // to class='system'.
          const target = await ctx.db.memory.findUniqueOrThrow({ where: { id: incoming } });
          // #949: was a bare `target.organizationId !== agent.organizationId`,
          // which for a USER-owned agent compares `null !== null` ⇒ false and
          // waves through ANOTHER user's memory
          // (findings:org-xor-owner-null-comparison-bypass). The shared
          // assertion branches on the ownership class first.
          assertSystemMemoryOwner(agent, {
            organizationId: target.organizationId,
            ownerUserId: target.ownerUserId,
            id: target.id,
          });
          const otherAgent = await ctx.db.agent.findFirst({
            where: { systemMemoryId: incoming, deletedAt: null, id: { not: id } },
            select: { id: true },
          });
          if (otherAgent) {
            throw new Error('This memory is already the system memory of another agent');
          }
          await ctx.db.memory.update({
            where: { id: incoming },
            data: {
              // 035-visibility-enum-cleanup: mark via class; clear visibility
              // (forbidden non-null on class='system'). Agent visibility no
              // longer propagates onto the system memory.
              class: 'system',
              name: `${name ?? agent.name} System`,
              visibility: null,
              // system-class memories must opt out of uploads (schema.prisma,
              // 006-asset-upload-redesign). #519 review.
              acceptsUploads: false,
            },
          });
        }
      }

      // ── URN sync for an auto-derived system memory.
      // An auto-provisioned system memory's URN is `${agentUrn}-system` (see
      // createAgent). If the agent's URN changes we must move the memory's URN
      // in lockstep — otherwise the stale `${oldUrn}-system` memory keeps the
      // old slug reserved, and re-creating an agent at that slug fails the
      // system-memory URN-reclaim check (#519 review). Only touch a memory whose
      // URN still matches the derived pattern: a wizard-supplied system memory
      // carries its own author-chosen URN we must not rewrite.
      if (agent.systemMemoryId && newUrn !== undefined && newUrn !== agent.urn) {
        const derivedOldUrn = `${agent.urn}-system`;
        const sys = await ctx.db.memory.findUnique({
          where: { id: agent.systemMemoryId },
          select: { urn: true },
        });
        if (sys?.urn === derivedOldUrn) {
          // #1079 (PR #1080 review, Codex + Copilot P2) — this renames a
          // MEMORY, so it owes a MEMORY alias. Without one an agent rename
          // silently 404'd every published node and edge URN under that
          // agent's system memory — which for a Team Agent is its whole
          // `roles:` branch, and for any agent is where its definition lives.
          // I aliased the Agent and missed the memory it drags along.
          //
          // Wrapped in its OWN transaction rather than folded into the agent
          // rename below, which preserves the best-effort contract this block
          // already had: a URN collision here must not fail the agent rename.
          // Folding it in would also break on the first caught error, because a
          // failed statement poisons the enclosing Postgres transaction — the
          // catch would swallow the error and every later write in that
          // transaction would fail with "current transaction is aborted".
          await ctx.db
            .$transaction(async (tx) => {
              const memId = agent.systemMemoryId as string;
              // Lock and RE-READ inside the transaction (PR #1080 re-review,
              // Codex P2). `sys.urn` was read before this transaction opened, so
              // two concurrent agent renames could both see `A-system`; the
              // first commits `B-system`, the second overwrites with `C-system`
              // while still recording `A-system` as the predecessor — leaving
              // the committed, possibly published `B-system` with no alias.
              // Aliasing the urn actually superseded is the whole point.
              const [lockedSys] = await tx.$queryRaw<{ urn: string }[]>`
                SELECT urn FROM memories WHERE id = ${memId} FOR UPDATE
              `;
              const currentSysUrn = lockedSys?.urn;
              // Re-check the derived-pattern guard against the LOCKED value: a
              // concurrent rename may already have moved it off the pattern, and
              // a wizard-supplied system memory carries an author-chosen URN we
              // must never rewrite.
              //
              // UNPROVEN BY TEST, and kept anyway. Mutating this line away leaves
              // the suite green, because the pre-transaction check above already
              // excludes every input the suite can construct. Reaching it needs
              // the pattern to match at that outer read and to have CHANGED by
              // the time this lock is acquired — a genuine interleaving no test
              // here can stage. Per `review:a-green-mutation-indicts-the-test`
              // that green indicts the test, not the guard: it does not mean the
              // check is redundant, only that nothing exercises it. It is the
              // sole thing standing between a concurrent rename and this code
              // rewriting an author-chosen system-memory URN from stale data.
              if (!currentSysUrn || currentSysUrn !== derivedOldUrn) return;
              await tx.memory.update({
                where: { id: memId },
                data: {
                  urn: `${newUrn}-system`,
                  updatedBy: ctx.userId ?? ctx.clientId ?? null,
                },
              });
              await recordUrnRename(tx, {
                entityType: 'MEMORY',
                entityId: memId,
                oldUrn: currentSysUrn,
                newUrn: `${newUrn}-system`,
                createdBy: ctx.userId ?? ctx.clientId ?? null,
              });
            })
            .catch((err) => {
              // Best-effort, like the name sync below: a rare collision on the
              // new URN shouldn't fail the whole agent rename. The alias and the
              // rename succeed or fail together, so a failure here leaves the
              // memory at its old URN — still resolvable, which is the safe
              // direction.
              console.warn('[updateAgent] system memory URN sync failed:', err);
            });
        }
      }

      // ── Name sync for existing system memory.
      // If the agent already has a system memory and the caller is updating
      // the agent's name, propagate so they stay in lockstep.
      // 035-visibility-enum-cleanup: visibility no longer propagates — a
      // system memory's visibility is always NULL.
      if (agent.systemMemoryId && name !== undefined) {
        await ctx.db.memory.update({
          where: { id: agent.systemMemoryId },
          data: {
            name: `${name} System`,
            updatedBy: ctx.userId ?? ctx.clientId ?? null,
          },
        }).catch((err) => {
          // Log but don't block the agent update — if the system memory
          // has been manually renamed or deleted, we don't want to fail
          // the whole operation.
          console.warn('[updateAgent] system memory sync failed:', err);
        });
      }

      // #1079 — the rename and its alias record commit together (see the App arm
      // in resolvers.mutation.app.ts for why they cannot be separate).
      return ctx.db.$transaction(async (tx) => {
        // Lock and RE-READ the urn inside the transaction (PR #1080 review,
        // Codex + Copilot P2). The row above was read before the transaction
        // opened, so two concurrent renames could both record the SAME old urn
        // and the intermediate identity — committed, and returned to whoever
        // made the first call — would never be aliased at all. Reading under
        // FOR UPDATE serializes the renames and makes each one record the urn it
        // actually superseded. `updateOrganization` already did this; the three
        // single-entity paths did not.
        const [lockedRow] = await tx.$queryRaw<{ urn: string }[]>`
          SELECT urn FROM agents WHERE id = ${id} FOR UPDATE
        `;
        // cor:acl:080:03 — congruence invariant: an agent may become PUBLIC
        // only if every knowledge memory it links (excluding per-user
        // personal/private) is itself PUBLIC, and (#1349) only if it holds no
        // read-write knowledge. Run under the row lock taken just above, so an
        // attach or re-role racing this publication serializes behind it
        // instead of both observing a state the other is about to change.
        if (visibility === 'PUBLIC') {
          await assertAgentPublicAllowed(tx, id);
        }
        if (newUrn !== undefined) {
          await recordUrnRename(tx, {
            entityType: 'AGENT',
            entityId: id,
            // Recorded verbatim: the `urn` column already holds the normalized
            // lookup form the resolvers query.
            oldUrn: lockedRow?.urn ?? agent.urn,
            newUrn,
            createdBy: ctx.userId ?? ctx.clientId ?? null,
          });
        }
        return tx.agent.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(newUrn !== undefined ? { urn: newUrn } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
          ...(systemMemoryId !== undefined ? { systemMemoryId } : {}),
          ...(visibility !== undefined ? { visibility: visibility as AgentVisibility } : {}),
          // cor:acl:080:04 — opt-in marketplace catalogue flag (advertisement,
          // not access; independent of visibility). NOT NULL column: an explicit
          // null is treated like an omitted arg (no change), not a NULL write.
          ...(listedOnMarketplace != null ? { listedOnMarketplace } : {}),
          ...(type !== undefined ? { type } : {}),
          ...(surfaces !== undefined ? { surfaces } : {}),
          // #928 persona dressing — pure metadata. An explicit null (or a
          // blank-after-trim string) clears the field; omitted preserves.
          ...(personaRoleNorm !== undefined ? { personaRole: personaRoleNorm } : {}),
          ...(personaPromptNorm !== undefined ? { personaPrompt: personaPromptNorm } : {}),
          // Spec 049 Phase 5: the install-row defaults — a scalar declaration,
          // stored as given; null clears to the platform defaults.
          ...(registerDefaults !== undefined
            ? { registerDefaults: registerDefaults === null ? Prisma.JsonNull : { mentionOnly: registerDefaults.mentionOnly === true } }
            : {}),
        },
        include: AGENT_INCLUDE,
        });
      });
    },

    deleteAgent: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
      // #789 / cor:api:140 — see updateAgent: resolution is not authorization.
      const { id } = await resolveAgentRef(ctx.db, ref);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id } });
      await requireOwnerOrOrgRole(ctx, agent, 'ADMIN');
      // Soft-delete the agent and its owned system memory (if any) in the
      // same pass. System memories are owned by the agent and cannot be
      // detached, so deleting the agent is the only way they get cleaned up.
      await ctx.db.agent.update({ where: { id }, data: { deletedAt: new Date() } });
      if (agent.systemMemoryId) {
        await ctx.db.memory
          .update({ where: { id: agent.systemMemoryId }, data: { deletedAt: new Date() } })
          .catch((err) => console.warn('[deleteAgent] system memory cleanup failed:', err));
      }
      return true;
    },

    /**
     * #949 — re-own an Agent's system memory to the Agent's OWN owner.
     *
     * The recovery path for rows that predate the shared owner assertion: a
     * system memory can only ever be created by Agent provisioning, so before
     * this there was nothing to hand `updateAgent(systemMemoryId:)` and the
     * only fix was to recreate the Agent, move its role nodes, reinstall the
     * App, and retire the old one.
     *
     * PLATFORM ADMIN ONLY, deliberately: the memory to be moved is owned by a
     * DIFFERENT tenant, so neither side's org admin is the right authority —
     * the agent's org admin would be pulling a row out of an org they have no
     * standing in, and the holding org's admin would be handing away a row
     * their own members can currently read. Idempotent: an already-consistent
     * pair is a no-op.
     */
    repairAgentSystemMemory: async (
      _: unknown,
      { agentRef }: { agentRef: string },
      ctx: Context,
    ) => {
      const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
      // Impersonation sessions are read-only support views (#875) — never a
      // cross-tenant write, whatever the impersonator's own roles say.
      if (!isPlatformAdmin || ctx.impersonation) {
        throw new GraphQLError('Repairing an agent system memory requires a platform administrator.', {
          extensions: { code: 'FORBIDDEN' },
        });
      }
      const { id } = await resolveAgentRef(ctx.db, agentRef);
      const result = await repairAgentSystemMemoryOwner(ctx.db, id, {
        actorId: ctx.userId ?? ctx.clientId ?? null,
      });
      if (result.urnNote) console.warn('[repairAgentSystemMemory]', result.urnNote);
      return ctx.db.agent.findUniqueOrThrow({ where: { id }, include: AGENT_INCLUDE });
    },

    createAgentOrgGrant: async (
      _: unknown,
      { agentRef, orgRef }: { agentRef: string; orgRef: string },
      ctx: Context,
    ) => {
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentRef);
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgRef);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');

      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      if (agent.organizationId === resolvedOrgId) {
        throw new GraphQLError(
          'Owner organization has implicit authority for its own Agent and cannot subscribe.',
          { extensions: { code: 'SELF_AGENT_ORG_GRANT' } },
        );
      }
      if (agent.visibility !== 'PUBLIC') {
        throw new GraphQLError('Only PUBLIC agents can be subscribed to by other organizations.', {
          extensions: { code: 'AGENT_NOT_PUBLIC', agentId: resolvedAgentId },
        });
      }

      await ensureAgentOrgGrant(ctx.db, resolvedOrgId, resolvedAgentId, {
        createdBy: ctx.userId ?? ctx.clientId ?? null,
      });

      const grant = await ctx.db.agentOrgGrant.findUniqueOrThrow({
        where: { orgId_agentId: { orgId: resolvedOrgId, agentId: resolvedAgentId } },
      });
      if (!isLifecycleActive(grant)) {
        throw new GraphQLError(
          'An AgentOrgGrant already exists for this organization and Agent, but it is not active. Ask the Agent owner to issue a new grant or clear the revocation.',
          {
            extensions: {
              code: 'AGENT_ORG_GRANT_INACTIVE',
              orgId: resolvedOrgId,
              agentId: resolvedAgentId,
              revokedAt: grant.revokedAt?.toISOString() ?? null,
              expiresAt: grant.expiresAt?.toISOString() ?? null,
              activatedAt: grant.activatedAt?.toISOString() ?? null,
            },
          },
        );
      }
      return grant;
    },

    revokeAgentOrgGrant: async (
      _: unknown,
      { agentRef, orgRef }: { agentRef: string; orgRef: string },
      ctx: Context,
    ) => {
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentRef);
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgRef);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });

      await requireAgentOrgGrantRevokeRole(ctx, resolvedOrgId, agent);

      await ctx.db.agentOrgGrant.updateMany({
        where: {
          orgId: resolvedOrgId,
          agentId: resolvedAgentId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
          revokedBy: ctx.userId ?? null,
          updatedBy: ctx.userId ?? ctx.clientId ?? null,
        },
      });

      const grant = await ctx.db.agentOrgGrant.findUnique({
        where: { orgId_agentId: { orgId: resolvedOrgId, agentId: resolvedAgentId } },
      });
      if (!grant) {
        throw new GraphQLError('AgentOrgGrant not found for this organization and Agent.', {
          extensions: {
            code: 'AGENT_ORG_GRANT_NOT_FOUND',
            orgId: resolvedOrgId,
            agentId: resolvedAgentId,
          },
        });
      }
      return grant;
    },

    publishAgentImport: async (
      _: unknown,
      {
        parentAgentRef,
        importedAgentRef,
        position,
        required,
      }: {
        parentAgentRef: string;
        importedAgentRef: string;
        position: number;
        required?: boolean;
      },
      ctx: Context,
    ) => {
      const { id: resolvedParentId } = await resolveAgentRef(ctx.db, parentAgentRef);
      const { id: resolvedImportedId } = await resolveAgentRef(ctx.db, importedAgentRef);
      const parent = await ctx.db.agent.findUniqueOrThrow({
        where: { id: resolvedParentId },
      });
      // Authorization: ADMIN/OWNER of the parent Agent's owning org.
      await requireOwnerOrOrgRole(ctx, parent, 'ADMIN');

      try {
        return await publishAgentImport(ctx.db, {
          parentAgentId: resolvedParentId,
          importedAgentId: resolvedImportedId,
          position,
          required: required ?? true,
          actorId: ctx.userId ?? null,
        });
      } catch (e: unknown) {
        if (
          e instanceof SelfImportError ||
          e instanceof MultiLevelImportError ||
          e instanceof MissingGrantError ||
          e instanceof PositionConflictError
        ) {
          throw new GraphQLError((e as Error).message, {
            extensions: { code: (e as Error).name },
          });
        }
        throw e;
      }
    },

    removeAgentImport: async (
      _: unknown,
      { parentAgentRef, importedAgentRef }: { parentAgentRef: string; importedAgentRef: string },
      ctx: Context,
    ) => {
      const { id: resolvedParentId } = await resolveAgentRef(ctx.db, parentAgentRef);
      const { id: resolvedImportedId } = await resolveAgentRef(ctx.db, importedAgentRef);
      const parent = await ctx.db.agent.findUniqueOrThrow({
        where: { id: resolvedParentId },
      });
      await requireOwnerOrOrgRole(ctx, parent, 'ADMIN');
      await removeAgentImport(ctx.db, resolvedParentId, resolvedImportedId);
      return true;
    },

    revokeAgentSubscription: async (
      _: unknown,
      {
        userRef,
        userId,
        agentRef,
        agentId,
      }: {
        userRef?: string | null;
        userId?: string | null;
        agentRef?: string | null;
        agentId?: string | null;
      },
      ctx: Context,
    ) => {
      // #764: agentRef/userRef accept id / URN / (user) handle / email. Resolve
      // the agent + owner-gate FIRST, then resolve the user.
      const resolvedAgentId = await resolveAgentRefArg(ctx.db, { ref: agentRef, id: agentId });
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOwnerOrOrgRole(ctx, agent, 'ADMIN');
      const resolvedUserId = await resolveUserRefArg(ctx.db, { ref: userRef, id: userId });

      const updated = await ctx.db.agentSubscription.update({
        where: { userId_agentId: { userId: resolvedUserId, agentId: resolvedAgentId } },
        data: {
          revokedAt: new Date(),
          revokedBy: ctx.userId ?? null,
        },
      });

      // FR-029: empty per-user Memory at revocation time → hard-delete. The
      // auto-provisioned memory is class='personal' (plaintext USER_ID mode) or
      // 'private' (encrypted SECRET mode, 041/#516); scope by userMemoryOfAgentId
      // so free-standing user memories (agent NULL) never match.
      const userMemory = await ctx.db.memory.findFirst({
        where: {
          userId: resolvedUserId,
          userMemoryOfAgentId: resolvedAgentId,
          class: { in: ['personal', 'private'] },
          deletedAt: null,
        },
        include: { _count: { select: { nodes: true } } },
      });
      if (userMemory && userMemory._count.nodes === 0) {
        await ctx.db.memory.delete({ where: { id: userMemory.id } });
      }

      return updated;
    },

    // ── Multi-user-agent: identity and sessions (App Key auth) ──────

    updateAgentAIConfig: async (
      _: unknown,
      { agentId, provider, apiKey, model }: { agentId: string; provider: string; apiKey?: string | null; model: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOwnerOrOrgRole(ctx, agent, 'ADMIN');
      // 036-ai-service-config: upsert the Agent's 'default' registry
      // config. Legacy key semantics preserved: a provided apiKey is
      // encrypted with a preview; omitted/blank keeps the stored key,
      // which must then already exist.
      try {
        validateProviderAndParams(provider, null);
      } catch (e) {
        rethrowAiConfigTyped(e);
      }
      const existing = await ctx.db.aiServiceConfig.findFirst({
        where: { agentId: resolvedAgentId, name: DEFAULT_AI_CONFIG_NAME },
      });
      const keyData: Record<string, string> = {};
      if (apiKey) {
        keyData.apiKeyEncrypted = encryptToken(apiKey);
        keyData.apiKeyPreview = apiKeyPreviewOf(apiKey);
      } else if (!existing?.apiKeyEncrypted) {
        rethrowAiConfigTyped(
          new AiConfigValidationError('API key is required when no key is saved yet'),
        );
      }
      if (existing) {
        await ctx.db.aiServiceConfig.update({
          where: { id: existing.id },
          data: { provider, model, ...keyData, updatedBy: ctx.userId ?? null },
        });
      } else {
        // apiKey is guaranteed non-blank here (guard above); P2002 from a
        // concurrent create surfaces as the duplicate-name typed error
        // rather than a retry (upsert is not race-safe on the cold path).
        try {
          await ctx.db.aiServiceConfig.create({
            data: {
              agentId: resolvedAgentId,
              name: DEFAULT_AI_CONFIG_NAME,
              provider,
              model,
              ...keyData,
              createdBy: ctx.userId ?? null,
            },
          });
        } catch (e: unknown) {
          if ((e as { code?: string }).code === 'P2002') {
            rethrowAiConfigTyped(new DuplicateAiServiceConfigNameError(DEFAULT_AI_CONFIG_NAME));
          }
          throw e;
        }
      }
      return ctx.db.agent.findUniqueOrThrow({
        where: { id: resolvedAgentId },
        include: AGENT_INCLUDE,
      });
    },

    clearAgentAIConfig: async (_: unknown, { agentId }: { agentId: string }, ctx: Context) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOwnerOrOrgRole(ctx, agent, 'ADMIN');
      // 036-ai-service-config: clearing deletes the 'default' registry
      // config (idempotent).
      await ctx.db.aiServiceConfig.deleteMany({
        where: { agentId: resolvedAgentId, name: DEFAULT_AI_CONFIG_NAME },
      });
      return ctx.db.agent.findUniqueOrThrow({
        where: { id: resolvedAgentId },
        include: AGENT_INCLUDE,
      });
    },

    // ── 036-ai-service-config CRUD ────────────────────────────────────

    createAiServiceConfig: async (
      _: unknown,
      args: {
        ownerType: AiConfigOwnerType;
        ownerId: string;
        name: string;
        provider: string;
        model: string;
        apiKey?: string | null;
        params?: unknown;
        enabled?: boolean | null;
      },
      ctx: Context,
    ) => {
      try {
        const { ownerWhere } = await requireAiConfigOwnerAdmin(ctx, args.ownerType, args.ownerId);
        const name = validateAiConfigName(args.name);
        validateProviderAndParams(args.provider, args.params ?? null);
        // No upsert: a P2002 from the partial unique (owner, name) index is
        // the duplicate-name typed error, not a retry (upsert is not
        // race-safe on the cold path).
        const config = await ctx.db.aiServiceConfig.create({
          data: {
            ...ownerWhere,
            name,
            provider: args.provider,
            model: args.model,
            ...(args.apiKey
              ? {
                  apiKeyEncrypted: encryptToken(args.apiKey),
                  apiKeyPreview: apiKeyPreviewOf(args.apiKey),
                }
              : {}),
            params:
              args.params === undefined || args.params === null
                ? undefined
                : (args.params as InputJsonValue),
            enabled: args.enabled ?? true,
            createdBy: ctx.userId ?? null,
          },
        });
        return toGqlAiServiceConfig(config);
      } catch (e: unknown) {
        if ((e as { code?: string }).code === 'P2002') {
          // Echo the canonical (trimmed) name the unique index actually saw.
          rethrowAiConfigTyped(new DuplicateAiServiceConfigNameError(args.name.trim()));
        }
        rethrowAiConfigTyped(e);
      }
    },

    updateAiServiceConfig: async (
      _: unknown,
      args: {
        id: string;
        name?: string | null;
        provider?: string | null;
        model?: string | null;
        apiKey?: string | null;
        params?: unknown;
        enabled?: boolean | null;
      },
      ctx: Context,
    ) => {
      try {
        const existing = await ctx.db.aiServiceConfig.findUnique({ where: { id: args.id } });
        if (!existing) throw new AiServiceConfigNotFoundError(args.id);
        const owner = aiConfigOwnerOf(existing);
        await requireAiConfigOwnerAdmin(ctx, owner.ownerType, owner.ownerId);
        const provider = args.provider ?? existing.provider;
        const params = args.params === undefined ? existing.params : args.params;
        validateProviderAndParams(provider, params ?? null);
        const config = await ctx.db.aiServiceConfig.update({
          where: { id: existing.id },
          data: {
            ...(args.name != null ? { name: validateAiConfigName(args.name) } : {}),
            provider,
            ...(args.model != null ? { model: args.model } : {}),
            ...apiKeyWriteFields(args.apiKey),
            ...(args.params === undefined
              ? {}
              : { params: args.params === null ? Prisma.DbNull : (args.params as InputJsonValue) }),
            ...(args.enabled == null ? {} : { enabled: args.enabled }),
            updatedBy: ctx.userId ?? null,
          },
        });
        return toGqlAiServiceConfig(config);
      } catch (e: unknown) {
        if ((e as { code?: string }).code === 'P2002') {
          // P2002 here can only come from renaming onto a conflict, so
          // args.name is set; trim to match the canonical stored form.
          rethrowAiConfigTyped(new DuplicateAiServiceConfigNameError((args.name ?? '').trim()));
        }
        rethrowAiConfigTyped(e);
      }
    },

    deleteAiServiceConfig: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      try {
        const existing = await ctx.db.aiServiceConfig.findUnique({ where: { id } });
        if (!existing) throw new AiServiceConfigNotFoundError(id);
        const owner = aiConfigOwnerOf(existing);
        await requireAiConfigOwnerAdmin(ctx, owner.ownerType, owner.ownerId);
        await ctx.db.aiServiceConfig.delete({ where: { id: existing.id } });
        return true;
      } catch (e) {
        rethrowAiConfigTyped(e);
      }
    },

    // ── Chatbot revisions ─────────────────────────────────────────────

};

async function requireAgentOrgGrantRevokeRole(
  ctx: Context,
  subscriberOrgId: string,
  agentOwner: { organizationId: string | null; ownerUserId: string | null },
): Promise<void> {
  try {
    await requireOrgRole(ctx, subscriberOrgId, 'ADMIN');
    return;
  } catch (subscriberErr) {
    try {
      await requireOwnerOrOrgRole(ctx, agentOwner, 'ADMIN');
      return;
    } catch {
      throw subscriberErr;
    }
  }
}
