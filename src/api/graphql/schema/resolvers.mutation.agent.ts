// agentMutations — extracted from resolvers.ts Mutation (split step 2). No behavior change.
import { encryptToken } from '../../../lib/tokenCrypto.js';
import { refuseLegacyBaseUrl, requireEndpointFor, requireKeyFor, validateApiStyle, validateEndpoint } from '../../../lib/aiEndpoint.js';
import { testAiServiceConfig, type AiConfigTestOverride } from '../../../controller/operations/testAiServiceConfig.js';
import { assertAgentPublicAllowed } from '../../../lib/agentPublicCongruence.js';

/**
 * Raised by the publication path when the agent's knowledge-link set changed
 * between the pre-lock snapshot and the post-lock re-scan (#1364). Internal to
 * this module: it never reaches a client, it only triggers the retry.
 */
class AgentLinkSetChangedError extends Error {
  constructor() {
    super('agent link set changed during publication');
    this.name = 'AgentLinkSetChangedError';
  }
}
import {
  assertSystemMemoryOwner,
  assertNotInstallMemory,
  repairAgentSystemMemoryOwner,
} from '../../../lib/agentSystemMemory.js';
import {
  AiServiceConfigNotFoundError,
  AiConfigValidationError,
  DuplicateAiServiceConfigNameError,
  DEFAULT_AI_CONFIG_NAME,
  apiKeyWriteFields,
  apiKeyPreviewOf,
  lockAiServiceConfig,
  validateAiConfigName,
  validateProviderAndParams,
  validateParamRanges,
  type AiConfigOwnerType,
} from '../../../lib/aiConfig.js';
import {
  publishAgentImport,
  SelfImportError,
  MultiLevelImportError,
  MissingGrantError,
  PositionConflictError,
} from '../../../controller/operations/publishAgentImport.js';
import { assertMaySubscribeOrgToPublicAgent } from '../../../controller/operations/subscribeOrgToPublicAgent.js';
import { ensureAgentOrgGrant } from '../../../controller/operations/ensureAgentOrgGrant.js';
import { removeAgentImport } from '../../../controller/operations/removeAgentImport.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { writeAgentBase } from '../../../lib/agentBase.js';
import { AgentNotFoundError, NodeNotFoundError } from '../../../lib/entityRef/errors.js';
import { canReadMemory } from '../../../mcp/access-control.js';
import { resolveNodeRefForCaller } from './resolvers.nodeRefAccess.js';
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
  requireAgentAccess,
  resolveReadableAgentRef,
  requireReadableAgent,
  requireOwnerOrOrgRole,
  aiConfigOwnerOf,
  toGqlAiServiceConfig,
  requireAiConfigOwnerAdmin,
  rethrowAiConfigTyped,
  resolveUserRefArg,
  resolveReadableAgentRefArg,
  AGENT_INCLUDE,
} from './resolvers.helpers.js';
import { recordUrnRename } from '../../../lib/urnAlias.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { liveTxContext, withAuthorizedTx } from './authorizedTx.js';
import { lockAuthorityAnchors, type AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';
import { backfillMemoryEmbeddings } from '../../../services/embedding/enqueue.js';
import { assertNoLiveAgentReferences } from '../../../lib/agentLiveReferences.js';
import { assertNoMintedCorpusRemoval, reclaimTombstonedMemory } from '../../../lib/mintedSpecPermanence.js';
import { DEFAULT_MEMBER_ROLES, normalizeMemberRoles } from '../../../lib/memberRoles.js';

/**
 * #928/#929 review: persona role is trimmed, and a blank-after-trim
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
  systemMemoryId?: string;
  visibility?: string;
  type?: 'ASSISTANT' | 'CHATBOT';
  surfaces?: string[];
  personaRole?: string | null;
  /** #2138 §3.5: false = every worker cast from this Agent counts as having a task. Default true. */
  usesTasks?: boolean | null;
  /** #2162 (cor:agt:050:27): reset a worker's context when its task ends. Default false; null means the default. */
  resetContextAfterTask?: boolean | null;
  /** #2171 (R211): omitted/null = the default, owner and member. */
  memberRoles?: string[] | null;
}

/**
 * The authorization-free core of createAgent: URN compose + reclaim, type/
 * visibility defaults, and the one transaction that provisions the system
 * memory alongside the Agent row. (Extracted for #935; the Worker re-cut of
 * #974 removed its persona-minting caller, so createAgent is its one caller
 * again.) The persona role (cor:agt:020:01) is normalized here
 * (blank-after-trim ⇒ NULL); the named
 * identity lives on the Worker entity, never here.
 */
export async function createAgentCore(ctx: Context, input: CreateAgentCoreInput) {
  const {
    organizationId: resolvedOrgId,
    ownerUserId,
    namespace,
    name,
    description,
    systemMemoryId,
    visibility,
    type,
    surfaces,
  } = input;
  // #929 review: normalize persona dressing inputs before anything touches
  // them.
  const personaRoleNorm = normalizePersonaField(input.personaRole);
  // #2171: validated before anything is written.
  const memberRolesNorm = input.memberRoles == null ? [...DEFAULT_MEMBER_ROLES] : normalizeMemberRoles(input.memberRoles);
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
      assertNotInstallMemory(target);
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
      // #1468 — reclaim through the shared guard: a deleted mint-stamped
      // corpus holding a protected spec refuses. A holder revived since the
      // read above is live, the same slot-occupied case as below.
      const reclaimed = !!staleHolder?.deletedAt && await reclaimTombstonedMemory(tx, staleHolder.id);
      if (staleHolder && !reclaimed) {
        // #935: typed — under racing creates of the same name, the loser
        // can land HERE (the winner's system memory committed between the
        // agent-urn pre-check and this one), and allocation loops must see
        // the same slot-occupied refusal as every other urn collision.
        throw new AgentUrnTakenError(
          agentUrn,
          `A memory with URN "${systemMemoryUrn}" already exists`,
        );
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
        // #2171 (R211): a NEW Agent offers owner and member unless told otherwise.
        // The column default stays owner-only so no existing row changes meaning.
        installationPolicy: { maxMembers: 'unlimited', memberRoles: memberRolesNorm } as Prisma.InputJsonValue,
        organizationId: resolvedOrgId, ownerUserId, urn: agentUrn, name, description, systemMemoryId: resolvedSystemMemoryId,
        visibility: agentVisibility,
        type: inferredType,
        surfaces: surfaces ?? defaultSurfaces,
        // #928 persona dressing — pure metadata (see schema.prisma).
        personaRole: personaRoleNorm,
        ...(input.usesTasks != null ? { usesTasks: input.usesTasks } : {}),
        ...(input.resetContextAfterTask != null ? { resetContextAfterTask: input.resetContextAfterTask } : {}),
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
  // #2199 (cor:rag:010:01 r17): a memory promoted to class='system' is always summary-indexed. Its existing nodes were
  // written while it was an ordinary memory, so stamp them for the drain (post-commit; a fresh auto-provisioned memory
  // is empty and every later write enqueues itself). Never fails the create.
  if (systemMemoryId && createdAgent.systemMemoryId) {
    await backfillMemoryEmbeddings(ctx.db, createdAgent.systemMemoryId).catch((err) => {
      console.warn('[createAgent] system memory embedding backfill failed:', err);
    });
  }
  return createdAgent;
}


/**
 * Bring an agent's system-memory URN in line with the agent's CURRENT URN,
 * after a rename (#1357, @codex).
 *
 * Runs after the rename commits, so two renames of one agent can race: the
 * second's sync can run first, find the memory still at the FIRST's old
 * derived URN and skip, and the first's sync then advance it only to the
 * intermediate URN — agent `C`, memory `B-system`. Writing the agent's URN as
 * read now, under the memory row lock, converges instead: every sync starts
 * after its own rename committed and syncs serialize on the memory lock, so
 * the last one to run sees the latest agent. Locks the MEMORY only (the agent
 * is read, not locked): locking the agent here would invert the attach path's
 * memory-then-agent order.
 *
 * Rewrites only a URN still on the DERIVED pattern of this request's old agent
 * URN — an author-chosen system-memory URN is never touched.
 */
export async function syncSystemMemoryUrn(
  db: Context['db'],
  args: { agentId: string; systemMemoryId: string; oldAgentUrn: string; actor: string | null },
): Promise<void> {
  const derivedOldUrn = `${args.oldAgentUrn}-system`;
  await db.$transaction(async (tx) => {
    const [lockedSys] = await tx.$queryRaw<{ urn: string }[]>`
      SELECT urn FROM memories WHERE id = ${args.systemMemoryId} FOR UPDATE
    `;
    const currentSysUrn = lockedSys?.urn;
    if (!currentSysUrn || currentSysUrn !== derivedOldUrn) return;
    const current = await tx.agent.findUnique({ where: { id: args.agentId }, select: { urn: true } });
    if (!current) return;
    const targetUrn = `${current.urn}-system`;
    if (targetUrn === currentSysUrn) return;
    await tx.memory.update({
      where: { id: args.systemMemoryId },
      data: { urn: targetUrn, updatedBy: args.actor },
    });
    await recordUrnRename(tx, {
      entityType: 'MEMORY',
      entityId: args.systemMemoryId,
      oldUrn: currentSysUrn,
      newUrn: targetUrn,
      createdBy: args.actor,
    });
  });
}

/**
 * Bring an agent's system-memory name in line with the agent's CURRENT name
 * (#1357, @codex): the same race as {@link syncSystemMemoryUrn} — two renames'
 * syncs landing in reverse order would leave the OLDER name — closed the same
 * way, by writing the agent's name as read under the memory row lock.
 */
export async function syncSystemMemoryName(
  db: Context['db'],
  args: { agentId: string; systemMemoryId: string; actor: string | null },
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM memories WHERE id = ${args.systemMemoryId} FOR UPDATE`;
    const current = await tx.agent.findUnique({ where: { id: args.agentId }, select: { name: true } });
    if (!current) return;
    await tx.memory.update({
      where: { id: args.systemMemoryId },
      data: { name: `${current.name} System`, updatedBy: args.actor },
    });
  });
}

/**
 * #1946 — an imported Agent the parent's manager may learn about: one they can
 * read, or one the parent's org holds any AgentOrgGrant row for (the licence
 * the import flow itself is built on, active or not). Anything else throws
 * `AgentNotFoundError(ref)`, exactly as an absent Agent, so the import's own
 * refusals (MultiLevelImportError, MissingGrantError) never reach a caller
 * who couldn't otherwise know the Agent exists.
 */
async function requireKnownImportedAgent(
  ctx: Context,
  parent: { organizationId: string | null },
  importedAgentId: string,
  ref: string,
): Promise<void> {
  const imported = await ctx.db.agent.findUnique({ where: { id: importedAgentId } });
  try {
    await requireReadableAgent(ctx, imported, ref);
  } catch (e) {
    if (!(e instanceof AgentNotFoundError) || !imported || imported.deletedAt || !parent.organizationId) throw e;
    const licensed = await ctx.db.agentOrgGrant.findUnique({
      where: { orgId_agentId: { orgId: parent.organizationId, agentId: importedAgentId } },
      select: { orgId: true },
    });
    if (!licensed) throw e;
  }
}

export const agentMutations = {
    createAgent: async (
      _: unknown,
      { orgId, name, description, systemMemoryId, visibility, type, surfaces, personaRole, usesTasks, resetContextAfterTask, memberRoles }: { orgId?: string | null; name: string; description?: string; systemMemoryId?: string; visibility?: string; type?: 'ASSISTANT' | 'CHATBOT'; surfaces?: string[]; personaRole?: string; usesTasks?: boolean | null; resetContextAfterTask?: boolean | null; memberRoles?: string[] | null },
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
        systemMemoryId,
        visibility,
        type,
        surfaces,
        personaRole,
        usesTasks,
        resetContextAfterTask,
        memberRoles,
      });
    },

    updateAgent: async (
      _: unknown,
      { ref, name, urn, description, systemMemoryId, visibility, listedOnMarketplace, type, surfaces, personaRole, usesTasks, resetContextAfterTask, registerDefaults, memberRoles }: { ref: string; name?: string; urn?: string; description?: string; systemMemoryId?: string; visibility?: string; listedOnMarketplace?: boolean; type?: 'ASSISTANT' | 'CHATBOT'; surfaces?: string[]; personaRole?: string | null; usesTasks?: boolean | null; resetContextAfterTask?: boolean | null; registerDefaults?: { mentionOnly?: boolean | null } | null; memberRoles?: string[] | null },
      ctx: Context,
    ) => {
      // #929 review: normalize persona dressing (blank-after-trim clears).
      const personaRoleNorm = normalizePersonaField(personaRole);
      // #789 / cor:api:140 — was a PK-only findUniqueOrThrow, so a caller
      // holding a URN or handle had to pre-resolve it. Resolution is not
      // authorization (#554): the resource-scoped gate below still runs on the
      // RESOLVED agent. #1944: resolved through the read gate, so a caller who
      // can't read the Agent is answered as if it were absent.
      const agent = await resolveReadableAgentRef(ctx, ref);
      const { id } = agent;
      await requireAgentAccess(ctx, agent, 'ADMIN');
      // #2171 (R211): validated after the gate, so a caller who may not edit sees the refusal, not a shape error.
      // Omitted and null both mean unchanged; an empty list is refused, not a reset.
      const memberRolesNorm = memberRoles == null ? undefined : normalizeMemberRoles(memberRoles);
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
      // holds no read-write knowledge. Checked ONCE, under the agent row lock
      // in the transaction below.
      //
      // There WAS an unlocked fail-fast here, added when the locked check was
      // the only one and the systemMemoryId promotion still committed ahead of
      // it: the fail-fast kept a refusal in front of that write. Deferring the
      // promotion into the deciding transaction and moving the URN/name syncs
      // after it removed every externally visible mutation that preceded the
      // decision, which removed the fail-fast's last correctness role. It is
      // deleted rather than kept as an optimisation: a duplicated
      // authorization check that no test can distinguish is the drift
      // `AGENTS.md` warns about, and its mutant went green the moment the last
      // write moved out from behind it (@codex, PR #1357).
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
      // Set when a first-attach promotion is due; performed inside the
      // deciding transaction so a refusal cannot leave it half-applied (#1364).
      let promoteSystemMemoryId: string | null = null;
      if (systemMemoryId !== undefined) {
        const incoming = systemMemoryId === '' ? null : systemMemoryId;
        if (agent.systemMemoryId && incoming !== agent.systemMemoryId) {
          // Typed, like the in-transaction twin below (#2856, cor:api:260:01): a plain
          // Error reads as a fault, but this is a refusal of the caller's own input.
          throw new GraphQLError(
            "Cannot unset or change an agent's system memory. Delete the agent to replace it.",
            { extensions: { code: 'BAD_USER_INPUT' } },
          );
        }
        if (!agent.systemMemoryId && incoming) {
          // #1818 review (Emerson P2-C): on a USER-owned agent, first-attach is
          // the OWNER's act. An admin managing the agent (#1787) must not
          // re-point its definition at one of the owner's other memories — the
          // promotion would manufacture a "definition" the admin's read arm
          // then reaches, and deleteAgent would destroy it.
          if (agent.ownerUserId !== null && ctx.userId !== agent.ownerUserId) {
            throw new GraphQLError("Attaching a system memory to a user-owned Agent is its owner's act.", {
              extensions: { code: 'FORBIDDEN' },
            });
          }
          // First-attach: verify the target memory exists, belongs to this
          // org, and isn't already another agent's system memory. These are
          // READS ONLY — the promotion WRITE now happens in the deciding
          // transaction below (#1364, @codex on PR #1357).
          //
          // It used to be a bare `ctx.db.memory.update` right here, outside any
          // transaction. That was safe only while the congruence check ran
          // earlier in the function; once that check moved under the agent lock
          // (to close a publication race), a refused publication could leave
          // this memory converted to class='system' with its visibility cleared
          // and uploads disabled, attached to nothing. Deferring the write is
          // what makes the refusal and the promotion succeed or fail together.
          const target = await ctx.db.memory.findUniqueOrThrow({ where: { id: incoming } });
          if (target.deletedAt) {
            throw new GraphQLError('Memory not found', { extensions: { code: 'MEMORY_NOT_FOUND' } });
          }
          // #949: was a bare `target.organizationId !== agent.organizationId`,
          // which for a USER-owned agent compares `null !== null` ⇒ false and
          // waves through ANOTHER user's memory
          // (findings:org-xor-owner-null-comparison-bypass). The shared
          // assertion branches on the ownership class first.
          assertNotInstallMemory(target);
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
          promoteSystemMemoryId = incoming;
          // These validations are re-run under the row locks in the deciding
          // transaction (@codex, PR #1357). Reading them here first keeps the
          // common refusal cheap and its message early; the authoritative pass
          // is the locked one, because two concurrent first-attaches could each
          // observe `systemMemoryId` as null — or each see no other claimant —
          // and both promote, leaving two promoted memories or one memory
          // claimed by two agents.
        }
      }

      // #1364 (@codex P2, PR #1357) — the system-memory URN and NAME syncs
      // used to run HERE, each committing its own transaction BEFORE the
      // deciding one below. A publication refused by the locked congruence
      // check (an attach landing after the fail-fast) therefore left the system
      // memory renamed or retitled under an agent that never changed. They are
      // best-effort by design — a failure must not fail the agent update — so
      // rather than fold them into the deciding transaction and change that,
      // they now run AFTER it, where a refusal can no longer reach them.
      // #1079 — the rename and its alias record commit together (see the App arm
      // in resolvers.mutation.app.ts for why they cannot be separate).
      // #1364 — bounded retry around the deciding transaction. The only thing
      // that raises AgentLinkSetChangedError is the post-lock re-scan below,
      // and once this transaction holds the agent lock no further link can be
      // added, so a single retry is normally enough; the cap is there so a
      // pathological loop fails loudly instead of spinning.
      const MAX_PUBLISH_ATTEMPTS = 3;
      let published: Awaited<ReturnType<typeof ctx.db.agent.update>> | undefined;
      // The agent URN this request actually overwrote, read under the agent
      // lock (@codex, PR #1357). The pre-transaction read can be stale: when a
      // concurrent rename commits first, the URN this request replaces is
      // THAT rename's, and a sync keyed on the stale read skips a memory the
      // other request already advanced.
      let predecessorUrn: string | undefined;
      for (let attempt = 1; ; attempt++) {
      try {
      published = await ctx.db.$transaction(async (tx) => {
        // #2171 (BLIND/LOCAL on PR #2465): a memberRoles edit decides what a
        // manager may later grant, so its authority is re-checked HERE, in the
        // deciding transaction, behind the same anchors a revoker takes
        // exclusively (the withAuthorizedTx protocol, whose order this keeps:
        // advisory anchors, then org/user rows, then the memory and agent rows
        // below). The pre-transaction gate alone left the authorize-then-write
        // window open: a manager demoted in between still landed the edit.
        if (memberRolesNorm !== undefined) {
          const anchors: AuthorityAnchor[] = [
            { kind: 'agent', id },
            ...(agent.organizationId ? [{ kind: 'org' as const, id: agent.organizationId }] : []),
            ...(agent.ownerUserId ? [{ kind: 'user' as const, id: agent.ownerUserId }] : []),
            ...(ctx.userId ? [{ kind: 'user' as const, id: ctx.userId }] : []),
          ];
          await lockAuthorityAnchors(tx, anchors, 'shared');
          if (agent.organizationId) await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${agent.organizationId} FOR SHARE`;
          for (const uid of new Set(anchors.filter((a) => a.kind === 'user').map((a) => a.id)).values()) {
            await tx.$queryRaw`SELECT id FROM users WHERE id = ${uid} FOR SHARE`;
          }
          const live = await liveTxContext(ctx, tx);
          const current = await tx.agent.findUnique({ where: { id } });
          if (!current || current.deletedAt) throw authorizationDenied();
          if (current.organizationId !== agent.organizationId || current.ownerUserId !== agent.ownerUserId) {
            throw new Error('Agent ownership changed; retry the update');
          }
          await requireAgentAccess(live, current, 'ADMIN');
        }
        // Lock and RE-READ the urn inside the transaction (PR #1080 review,
        // Codex + Copilot P2). The row above was read before the transaction
        // opened, so two concurrent renames could both record the SAME old urn
        // and the intermediate identity — committed, and returned to whoever
        // made the first call — would never be aliased at all. Reading under
        // FOR UPDATE serializes the renames and makes each one record the urn it
        // actually superseded. `updateOrganization` already did this; the three
        // single-entity paths did not.
        // #1349 (@codex, PR #1357) — publication must serialize with a
        // concurrent narrowing of the knowledge it links. `updateMemory` takes
        // `FOR UPDATE` on the memory row, so locking the linked memories here
        // makes the two contend: otherwise this check saw them still PUBLIC
        // while the narrowing's own check saw no PUBLIC agent yet, and both
        // committed — a PUBLIC agent referencing non-public knowledge.
        //
        // LOCKED BEFORE THE AGENT ROW, and ordered by id. The attach path locks
        // memory-then-agent (see lockAttachmentPair), so taking them in the
        // other order here would deadlock against it; ordering the memory set
        // by id keeps two concurrent publications consistent with each other.
        // An attach that adds a link to a memory outside this set still cannot
        // slip past: it must take the agent lock below, which this transaction
        // holds until it commits.
        let lockedMemoryIds: string[] = [];
        if (visibility === 'PUBLIC') {
          const linked = await tx.agentMemoryItem.findMany({
            where: { agentId: id, deletedAt: null },
            select: { memoryId: true },
            orderBy: { memoryId: 'asc' },
          });
          lockedMemoryIds = linked.map((l: { memoryId: string }) => l.memoryId);
        }
        // The promotion target belongs in the SAME ordered lock set (@codex P2,
        // PR #1357). Its `tx.memory.update` below would otherwise wait for that
        // row's lock AFTER this transaction has taken the agent lock — an
        // agent-then-memory acquisition, inverting `lockAttachmentPair`'s
        // memory-then-agent order and deadlocking against a concurrent attach
        // of the same pair. Exactly the hazard the lock-order note warns about;
        // taking it here, in id order, with the rest, is the fix.
        if (promoteSystemMemoryId && !lockedMemoryIds.includes(promoteSystemMemoryId)) {
          lockedMemoryIds = [...lockedMemoryIds, promoteSystemMemoryId].sort();
        }
        for (const memoryId of lockedMemoryIds) {
          await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR UPDATE`;
        }
        const [lockedRow] = await tx.$queryRaw<{ urn: string }[]>`
          SELECT urn FROM agents WHERE id = ${id} FOR UPDATE
        `;
        predecessorUrn = lockedRow?.urn;
        // #2171: the roles edit is a read-modify-write of the policy JSON, so it
        // reads the stored policy HERE, under the agent row lock, and merges
        // memberRoles only: maxMembers and selfJoinRole survive, and a concurrent
        // edit cannot be lost. The same row is what an admission holds FOR SHARE.
        let mergedPolicy: Prisma.InputJsonValue | undefined;
        if (memberRolesNorm !== undefined) {
          const stored = await tx.agent.findUniqueOrThrow({ where: { id }, select: { installationPolicy: true } });
          const current = (stored.installationPolicy ?? {}) as Record<string, unknown>;
          mergedPolicy = {
            ...current,
            maxMembers: current.maxMembers ?? 'unlimited',
            memberRoles: memberRolesNorm,
          } as Prisma.InputJsonValue;
        }
        if (visibility === 'PUBLIC') {
          // Re-scan the link set now that the agent row is LOCKED (#1364,
          // @codex on PR #1357). The scan above happened before this lock, so
          // an attach could commit in between and add a link whose memory is
          // therefore absent from `lockedMemoryIds` — and a concurrent
          // narrowing of that memory would then be serialized against nothing.
          //
          // The repair is a RETRY, not a second round of locking: taking a
          // memory lock while already holding the agent lock would be
          // agent-then-memory, inverting the attach path's memory-then-agent
          // order and deadlocking. Aborting releases both locks; the next
          // attempt sees the new link in its snapshot and locks it properly.
          // No attach can add a further link once this lock is held, so the
          // retry converges.
          // UNPROVEN BY TEST, and kept, for the same reason as the deferred
          // promotion above: staging it needs THREE transactions to interleave
          // (an attach committing between the snapshot and this lock, plus a
          // narrowing of that new memory). The suite stays green without it;
          // the hole it closes is a PUBLIC agent linked to non-public
          // knowledge.
          const afterLock = await tx.agentMemoryItem.findMany({
            where: { agentId: id, deletedAt: null },
            select: { memoryId: true },
            orderBy: { memoryId: 'asc' },
          });
          const now = afterLock.map((l: { memoryId: string }) => l.memoryId);
          // Compare against the LINK set, not the lock set: the lock set may
          // additionally carry the promotion target, which is not a link.
          if (now.some((m: string) => !lockedMemoryIds.includes(m))) {
            throw new AgentLinkSetChangedError();
          }
        }
        // cor:acl:080:03 — congruence invariant: an agent may become PUBLIC
        // only if every knowledge memory it links (excluding per-user
        // personal/private) is itself PUBLIC, and (#1349) only if it holds no
        // read-write knowledge. Run under the row lock taken just above, so an
        // attach or re-role racing this publication serializes behind it
        // instead of both observing a state the other is about to change.
        if (visibility === 'PUBLIC') {
          await assertAgentPublicAllowed(tx, id);
        }
        // The deferred first-attach promotion (#1364): inside THIS transaction,
        // after the congruence decision, so a refusal rolls it back with
        // everything else instead of leaving a mutated orphan.
        //
        // PINNED, though not by the case it exists for (harness #25): moving
        // this write back outside the transaction fails the two concurrent
        // system-memory claim tests (they time out on the lock). The #1364
        // orphan itself — a publication refused by a link committing between
        // the early fail-fast and this locked decision, yet still promoting the
        // memory — has never been staged (20 paired-race iterations), so that
        // specific interleaving remains argued, not measured.
        if (promoteSystemMemoryId) {
          // AUTHORITATIVE re-validation, under the locks taken above (@codex,
          // PR #1357). `lockedAgentRow` is this agent read inside the
          // transaction; the target row is locked in the ordered set.
          const lockedAgent = await tx.agent.findUniqueOrThrow({
            where: { id },
            select: { systemMemoryId: true, organizationId: true, ownerUserId: true, name: true },
          });
          if (lockedAgent.systemMemoryId && lockedAgent.systemMemoryId !== promoteSystemMemoryId) {
            throw new GraphQLError(
              "Cannot unset or change an agent's system memory. Delete the agent to replace it.",
              { extensions: { code: 'BAD_USER_INPUT' } },
            );
          }
          const lockedTarget = await tx.memory.findUniqueOrThrow({
            where: { id: promoteSystemMemoryId },
            select: { organizationId: true, ownerUserId: true, id: true, deletedAt: true, appId: true, installOfAgentId: true, isInstallMemory: true },
          });
          assertNotInstallMemory(lockedTarget);
          if (lockedTarget.deletedAt) {
            throw new GraphQLError('Memory not found', { extensions: { code: 'MEMORY_NOT_FOUND' } });
          }
          assertSystemMemoryOwner(lockedAgent, {
            organizationId: lockedTarget.organizationId,
            ownerUserId: lockedTarget.ownerUserId,
            id: lockedTarget.id,
          });
          const claimedElsewhere = await tx.agent.findFirst({
            where: { systemMemoryId: promoteSystemMemoryId, deletedAt: null, id: { not: id } },
            select: { id: true },
          });
          if (claimedElsewhere) {
            throw new GraphQLError('This memory is already the system memory of another agent', {
              extensions: { code: 'BAD_USER_INPUT' },
            });
          }
          await tx.memory.update({
            where: { id: promoteSystemMemoryId },
            data: {
              // 035-visibility-enum-cleanup: mark via class; clear visibility
              // (forbidden non-null on class='system'). Agent visibility no
              // longer propagates onto the system memory.
              class: 'system',
              // The LOCKED agent's name, not the pre-transaction snapshot
              // (@copilot, PR #1357): a rename committing in between would
              // otherwise leave the promoted memory named after the old one.
              name: `${name ?? lockedAgent.name} System`,
              visibility: null,
              // system-class memories must opt out of uploads (schema.prisma,
              // 006-asset-upload-redesign). #519 review.
              acceptsUploads: false,
            },
          });
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
          ...(usesTasks != null ? { usesTasks } : {}),
          // #2162 (cor:agt:050:27, R116): the same gate and lock as usesTasks; null and omitted change nothing. Turning
          // it off cancels nothing in flight: a reset's claim re-reads it (SETTING_OFF).
          ...(resetContextAfterTask != null ? { resetContextAfterTask } : {}),
          // Spec 049 Phase 5: the install-row defaults — a scalar declaration,
          // stored as given; null clears to the platform defaults.
          ...(mergedPolicy !== undefined ? { installationPolicy: mergedPolicy } : {}),
          ...(registerDefaults !== undefined
            ? { registerDefaults: registerDefaults === null ? Prisma.JsonNull : { mentionOnly: registerDefaults.mentionOnly === true } }
            : {}),
        },
        include: AGENT_INCLUDE,
        });
      });
      } catch (err) {
        if (err instanceof AgentLinkSetChangedError && attempt < MAX_PUBLISH_ATTEMPTS) continue;
        if (err instanceof AgentLinkSetChangedError) {
          throw new GraphQLError(
            'The agent\'s knowledge links kept changing while publishing it; retry the request.',
            { extensions: { code: 'CONFLICT', reason: 'AGENT_LINKS_CHANGED' } },
          );
        }
        throw err;
      }
      break;
      }

      // #2199: a memory promoted to class='system' by this update is now always summary-indexed — stamp its existing
      // nodes post-commit (the provisioning-seam half of the amendment; never fails the update).
      if (promoteSystemMemoryId && published?.systemMemoryId === promoteSystemMemoryId) {
        await backfillMemoryEmbeddings(ctx.db, promoteSystemMemoryId).catch((err) => {
          console.warn('[updateAgent] system memory embedding backfill failed:', err);
        });
      }

      // ── URN sync for an auto-derived system memory.
      // An auto-provisioned system memory's URN is `${agentUrn}-system` (see
      // createAgent). If the agent's URN changes we must move the memory's URN
      // in lockstep — otherwise the stale `${oldUrn}-system` memory keeps the
      // old slug reserved, and re-creating an agent at that slug fails the
      // system-memory URN-reclaim check (#519 review). Only touch a memory whose
      // URN still matches the derived pattern: a wizard-supplied system memory
      // carries its own author-chosen URN we must not rewrite.
      // Post-commit syncs of the agent's system memory (URN, then name). Both
      // write the agent's CURRENT state, read under the memory lock — not this
      // request's values — so two concurrent renames converge on the latest
      // (@codex, PR #1357). See syncSystemMemoryUrn / syncSystemMemoryName.
      const replacedUrn = predecessorUrn ?? agent.urn;
      // Gated on the COMMITTED row's system memory, not the pre-read (@copilot,
      // PR #1357): for a first attach, or a rename racing one, the snapshot has
      // no systemMemoryId and every sync was skipped.
      const committedSystemMemoryId = published?.systemMemoryId ?? agent.systemMemoryId;
      if (committedSystemMemoryId && newUrn !== undefined && newUrn !== replacedUrn) {
        await syncSystemMemoryUrn(ctx.db, {
          agentId: agent.id,
          systemMemoryId: committedSystemMemoryId,
          oldAgentUrn: replacedUrn,
          actor: ctx.userId ?? ctx.clientId ?? null,
        }).catch((err) => {
          console.warn('[updateAgent] system memory URN sync failed:', err);
        });
      }
      if (committedSystemMemoryId && name !== undefined) {
        await syncSystemMemoryName(ctx.db, {
          agentId: agent.id,
          systemMemoryId: committedSystemMemoryId,
          actor: ctx.userId ?? ctx.clientId ?? null,
        }).catch((err) => {
          console.warn('[updateAgent] system memory sync failed:', err);
        });
      }

      return published!;
    },

    deleteAgent: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
      // #789 / cor:api:140 — see updateAgent: resolution is not authorization.
      // #1944: an Agent the caller can't read answers as absent.
      const agent = await resolveReadableAgentRef(ctx, ref);
      const { id } = agent;
      await requireAgentAccess(ctx, agent, 'ADMIN');
      // Soft-delete the agent and its owned system memory (if any) in the
      // same pass. System memories are owned by the agent and cannot be
      // detached, so deleting the agent is the only way they get cleaned up.
      //
      // #1468 (Codex on #1475) — a system memory can hold a minted corpus
      // (createAgent may promote an existing memory into it), and deleting
      // the agent would take the corpus with it. Refused in the same
      // transaction as both soft-deletes, under the memory row lock.
      await withAuthorizedTx(ctx, [
        { kind: 'agent', id },
        ...(agent.organizationId ? [{ kind: 'org' as const, id: agent.organizationId }] : []),
        ...(agent.ownerUserId ? [{ kind: 'user' as const, id: agent.ownerUserId }] : []),
        ...(agent.systemMemoryId ? [{ kind: 'memory' as const, id: agent.systemMemoryId }] : []),
      ], async txCtx => {
        const current = await txCtx.db.agent.findUniqueOrThrow({ where: { id } });
        if (current.organizationId !== agent.organizationId || current.ownerUserId !== agent.ownerUserId ||
            current.systemMemoryId !== agent.systemMemoryId) {
          throw new Error('Agent ownership or system memory changed; retry the deletion');
        }
        await requireAgentAccess(txCtx, current, 'ADMIN');
      }, async tx => {
        await assertNoLiveAgentReferences(tx, id);
        if (agent.systemMemoryId) {
          await assertNoMintedCorpusRemoval(tx, agent.systemMemoryId, 'delete the agent whose system memory holds', {
            includeTombstones: false,
            remedy: 'Deleting the agent would delete its minted corpus; keep the agent.',
          });
        }
        const deletedAt = new Date();
        await tx.agent.update({ where: { id }, data: { deletedAt } });
        if (agent.systemMemoryId) {
          await tx.memory.updateMany({ where: { id: agent.systemMemoryId }, data: { deletedAt } });
        }
      }, {
        // An exclusive authority bracket prevents two deleters from upgrading
        // the same SHARE row locks concurrently. Memory precedes Agent, as in
        // publication/attachment; set-base and install/import writers share Agent.
        lockMode: 'exclusive', allowDeletedMemory: true,
        afterLock: async tx => {
          if (agent.systemMemoryId) {
            await tx.$queryRaw`SELECT id FROM memories WHERE id = ${agent.systemMemoryId} FOR UPDATE`;
          }
          await tx.$queryRaw`SELECT id FROM agents WHERE id = ${id} FOR UPDATE`;
        },
      });
      return true;
    },

    /**
     * #1885 (cor:dmo:050:14) — set, change or clear the one base Agent `ref`
     * extends. Whoever manages the child decides (cor:dmo:050:13, ruling 5);
     * `writeAgentBase` decides whether the change is well-formed: the grant,
     * no cycle, the chain cap for the child and every Agent extending it.
     * Managing the base isn't needed, and never conferred: the child's
     * managers change the child, never the base.
     */
    setAgentBase: async (_: unknown, { ref, baseRef }: { ref: string; baseRef?: string | null }, ctx: Context) => {
      // #789 / cor:api:140 — resolution is not authorization. #1944: an
      // Agent the caller can't read answers as absent (the base ref already
      // conceals, in writeAgentBase).
      const agent = await resolveReadableAgentRef(ctx, ref);
      const { id } = agent;
      await requireAgentAccess(ctx, agent, 'ADMIN');
      const baseId = baseRef ? (await resolveAgentRef(ctx.db, baseRef)).id : null;
      await ctx.db.$transaction((tx) =>
        writeAgentBase(tx, {
          childId: id,
          childRef: ref,
          baseId,
          baseRef: baseRef ?? null,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        }),
      );
      return ctx.db.agent.findUniqueOrThrow({ where: { id }, include: AGENT_INCLUDE });
    },

    /**
     * #1892 (cor:dmo:050:15, :16) — set or clear the Agent's tasks-index and
     * processes-index pointers. An omitted argument leaves its pointer as it
     * is; null clears it. Whoever manages the Agent decides, as for its base
     * (cor:dmo:050:13).
     *
     * PROPOSED (050:15's open "what the pointer may name"): the target must be
     * a live node the caller may read, and nothing more; a node the caller
     * can't read is refused as not found, so the write is no existence oracle.
     */
    setAgentIndexRefs: async (
      _: unknown,
      args: { ref: string; tasksIndexRef?: string | null; processesIndexRef?: string | null },
      ctx: Context,
    ) => {
      // #789 / cor:api:140 — resolution is not authorization. #1944: an
      // Agent the caller can't read answers as absent, as a retired one does.
      const agent = await resolveReadableAgentRef(ctx, args.ref);
      const { id } = agent;
      await requireAgentAccess(ctx, agent, 'ADMIN');
      // Resolve each target to its node and memory; the gates run again below,
      // inside the transaction, on what is current there.
      const resolve = async (ref: string | null | undefined) => {
        if (ref === undefined || ref === null) return ref;
        const { id: nodeId } = await resolveNodeRefForCaller(ctx, ref);
        const node = await ctx.db.node.findFirst({ where: { id: nodeId, deletedAt: null }, select: { memoryId: true } });
        if (!node) throw new NodeNotFoundError(ref);
        return { ref, nodeId, memoryId: node.memoryId };
      };
      const tasks = await resolve(args.tasksIndexRef);
      const processes = await resolve(args.processesIndexRef);
      const targets = [tasks, processes].filter((t): t is { ref: string; nodeId: string; memoryId: string } => !!t);

      // Anne's P2-2 on #1896: authorize and write in one transaction, behind
      // the authority anchors a revoker takes, re-reading the Agent, the
      // caller's roles and each target fresh, so a demotion, an Agent's
      // removal or a target becoming unreadable can't slip between the check
      // and the write.
      return withAuthorizedTx(
        ctx,
        [
          { kind: 'agent', id },
          ...(agent.organizationId ? [{ kind: 'org' as const, id: agent.organizationId }] : []),
          ...(agent.ownerUserId ? [{ kind: 'user' as const, id: agent.ownerUserId }] : []),
          ...targets.map((t) => ({ kind: 'memory' as const, id: t.memoryId })),
        ],
        async (txCtx) => {
          // The agent anchor has already refused a deleted Agent.
          const current = await txCtx.db.agent.findUniqueOrThrow({ where: { id } });
          if (current.organizationId !== agent.organizationId || current.ownerUserId !== agent.ownerUserId) {
            throw new Error('Agent ownership changed; retry the operation');
          }
          await requireAgentAccess(txCtx, current, 'ADMIN');
          for (const t of targets) {
            const [node] = await txCtx.db.$queryRaw<Array<{ memory_id: string }>>`
              SELECT memory_id FROM nodes WHERE id = ${t.nodeId} AND deleted_at IS NULL FOR SHARE`;
            if (!node || node.memory_id !== t.memoryId || !(await canReadMemory(txCtx.db, txCtx, t.memoryId))) {
              throw new NodeNotFoundError(t.ref);
            }
          }
        },
        (tx) => tx.agent.update({
          where: { id },
          data: {
            ...(tasks !== undefined ? { tasksIndexRef: tasks?.nodeId ?? null } : {}),
            ...(processes !== undefined ? { processesIndexRef: processes?.nodeId ?? null } : {}),
            updatedBy: ctx.userId ?? ctx.clientId ?? null,
          },
          include: AGENT_INCLUDE,
        }),
      );
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
      // #1946: the org gate runs BEFORE the Agent is resolved, so an outsider
      // is refused on the org whatever the ref names. An Agent the org's ADMIN
      // can't read answers exactly as an absent one (no AGENT_NOT_PUBLIC, no
      // agentId); AGENT_NOT_PUBLIC stays for one they can read.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgRef);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      const agent = await resolveReadableAgentRef(ctx, agentRef);
      const resolvedAgentId = agent.id;
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

      await withAuthorizedTx(
        ctx,
        [{ kind: 'org', id: resolvedOrgId }, { kind: 'agent', id: resolvedAgentId }],
        (txCtx) => assertMaySubscribeOrgToPublicAgent(txCtx, resolvedOrgId, resolvedAgentId),
        (tx) => ensureAgentOrgGrant(tx, resolvedOrgId, resolvedAgentId, {
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        }),
        { afterLock: async (tx) => {
          await tx.$queryRaw`SELECT id FROM agents WHERE id = ${resolvedAgentId} FOR SHARE`;
        } },
      );

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
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgRef);
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentRef);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      // #1946: an Agent the caller can't read is known to exactly one
      // legitimate revoker, the subscriber org's ADMIN holding a grant row for
      // it (which already names the Agent). Anyone else, or that ADMIN with no
      // grant row, gets the absent answer: no FORBIDDEN, no
      // AGENT_ORG_GRANT_NOT_FOUND, no agentId.
      try {
        await requireReadableAgent(ctx, agent, agentRef);
      } catch (e) {
        if (!(e instanceof AgentNotFoundError)) throw e;
        try {
          await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
        } catch (gate) {
          if (gate instanceof GraphQLError && gate.extensions?.code === 'FORBIDDEN') throw e;
          throw gate;
        }
        const held = await ctx.db.agentOrgGrant.findUnique({
          where: { orgId_agentId: { orgId: resolvedOrgId, agentId: resolvedAgentId } },
          select: { orgId: true },
        });
        if (!held) throw e;
      }

      await requireAgentOrgGrantRevokeRole(ctx, resolvedOrgId, agent);

      const grant = await withAuthorizedTx(
        ctx,
        [
          { kind: 'org', id: resolvedOrgId },
          { kind: 'agent', id: resolvedAgentId },
          ...(agent.organizationId ? [{ kind: 'org' as const, id: agent.organizationId }] : []),
          ...(agent.ownerUserId ? [{ kind: 'user' as const, id: agent.ownerUserId }] : []),
        ],
        async (txCtx) => {
          const current = await txCtx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
          if (current.organizationId !== agent.organizationId || current.ownerUserId !== agent.ownerUserId) {
            throw new Error('Agent ownership changed; retry the operation');
          }
          await requireAgentOrgGrantRevokeRole(txCtx, resolvedOrgId, current);
        },
        async (tx) => {
          await tx.agentOrgGrant.updateMany({
            where: { orgId: resolvedOrgId, agentId: resolvedAgentId, revokedAt: null },
            data: {
              revokedAt: new Date(), revokedBy: ctx.userId ?? null,
              updatedBy: ctx.userId ?? ctx.clientId ?? null,
            },
          });
          return tx.agentOrgGrant.findUnique({
            where: { orgId_agentId: { orgId: resolvedOrgId, agentId: resolvedAgentId } },
          });
        },
        { lockMode: 'exclusive', afterLock: async (tx) => {
          await tx.$queryRaw`SELECT id FROM agents WHERE id = ${resolvedAgentId} FOR SHARE`;
        } },
      );
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
      // #1944: the parent through the read gate FIRST, so an outsider learns
      // nothing about it (an unreadable parent answers as absent) and never
      // reaches the imported ref's lookup.
      const parent = await resolveReadableAgentRef(ctx, parentAgentRef);
      const resolvedParentId = parent.id;
      // Authorization: ADMIN/OWNER of the parent Agent's owning org.
      await requireAgentAccess(ctx, parent, 'ADMIN');
      // #1946: the imported ref only after the parent's gate, and bounded by
      // the import flow's own authority: an imported Agent the parent's manager
      // can neither read nor holds any grant row for (as the parent's org)
      // answers exactly as an absent one, before MultiLevelImportError or
      // MissingGrantError could tell them apart.
      const { id: resolvedImportedId } = await resolveAgentRef(ctx.db, importedAgentRef);
      await requireKnownImportedAgent(ctx, parent, resolvedImportedId, importedAgentRef);

      try {
        return await publishAgentImport(ctx.db, {
          parentAgentId: resolvedParentId,
          importedAgentId: resolvedImportedId,
          position,
          required: required ?? true,
          actorId: ctx.userId ?? null,
        }, ctx);
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
      // #1944: the parent through the read gate FIRST, as publishAgentImport.
      const parent = await resolveReadableAgentRef(ctx, parentAgentRef);
      const resolvedParentId = parent.id;
      await requireAgentAccess(ctx, parent, 'ADMIN');
      // #1946: idempotent for an imported Agent the manager knows (readable,
      // or already an import edge of this parent); any other answers exactly
      // as an absent one.
      const { id: resolvedImportedId } = await resolveAgentRef(ctx.db, importedAgentRef);
      const edge = await ctx.db.agentImport.findUnique({
        where: { parentAgentId_importedAgentId: { parentAgentId: resolvedParentId, importedAgentId: resolvedImportedId } },
        select: { parentAgentId: true },
      });
      if (!edge) {
        await requireReadableAgent(ctx, await ctx.db.agent.findUnique({ where: { id: resolvedImportedId } }), importedAgentRef);
      }
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
      // #1944: an Agent the caller can't read answers as absent.
      const agent = await resolveReadableAgentRefArg(ctx, { ref: agentRef, id: agentId });
      const resolvedAgentId = agent.id;
      await requireAgentAccess(ctx, agent, 'ADMIN');
      const resolvedUserId = await resolveUserRefArg(ctx.db, { ref: userRef, id: userId });

      // #1573: the revoker of the subscription writers (startChat, personal
      // createApp, install). It takes the same [agent, target user] anchors
      // they hold shared, EXCLUSIVE and through the revokedAt write, so a
      // revocation cannot return while a new subscription for this pair is
      // still about to commit. The Agent's owner anchor fences the ADMIN gate.
      const updated = await withAuthorizedTx(
        ctx,
        [
          { kind: 'agent', id: resolvedAgentId },
          { kind: 'user', id: resolvedUserId },
          ...(agent.organizationId ? [{ kind: 'org' as const, id: agent.organizationId }] : []),
          ...(agent.ownerUserId ? [{ kind: 'user' as const, id: agent.ownerUserId }] : []),
        ],
        async (txCtx) => {
          const current = await txCtx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
          if (current.organizationId !== agent.organizationId || current.ownerUserId !== agent.ownerUserId) {
            throw new Error('Agent ownership changed; retry the operation');
          }
          await requireAgentAccess(txCtx, current, 'ADMIN');
        },
        (tx) => tx.agentSubscription.update({
          where: { userId_agentId: { userId: resolvedUserId, agentId: resolvedAgentId } },
          data: {
            revokedAt: new Date(),
            revokedBy: ctx.userId ?? null,
          },
        }),
        { lockMode: 'exclusive' },
      );

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
      // #1944: through the read gate, so an unreadable Agent answers as absent.
      const agent = await resolveReadableAgentRef(ctx, agentId);
      const resolvedAgentId = agent.id;
      // #1787 review (Rook P2-1): updating config can keep the stored key under a
      // changed endpoint/provider — same exfil shape as the registry gate — so on a
      // user-owned Agent this stays owner-only (clearAgentAIConfig keeps the arm).
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
      // This legacy surface cannot set an endpoint, so an openai-compatible
      // config through it must keep the one it has (same provider) — a
      // provider change clears the endpoint below (#1373).
      try {
        requireEndpointFor(provider, existing && existing.provider === provider ? existing.endpoint : null);
      } catch (e) {
        rethrowAiConfigTyped(e);
      }
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
        // Re-judged on the LOCKED row (#1380 / #1389 review): a concurrent edit that
        // cleared the endpoint or key after the read above must not let this
        // write restore a provider that now lacks them.
        await ctx.db.$transaction(async (tx) => {
          const cur = await lockAiServiceConfig(tx, existing.id);
          if (!cur) throw new AiServiceConfigNotFoundError(existing.id);
          try {
            requireEndpointFor(provider, cur.provider === provider ? cur.endpoint : null);
          } catch (e) {
            rethrowAiConfigTyped(e);
          }
          if (!apiKey && !cur.apiKeyEncrypted) {
            rethrowAiConfigTyped(new AiConfigValidationError('API key is required when no key is saved yet'));
          }
          await tx.aiServiceConfig.update({
            where: { id: cur.id },
            data: {
              provider,
              model,
              ...keyData,
              // #1380 review: this legacy surface can express neither a style nor
              // an endpoint, and both were chosen for the OLD provider (its host,
              // its protocol). Any provider change clears both, so the new
              // provider starts from its own defaults and the new key never goes
              // to the old host.
              ...(provider !== cur.provider ? { endpoint: null, apiStyle: null } : {}),
              updatedBy: ctx.userId ?? null,
            },
          });
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
      // #1944: through the read gate, so an unreadable Agent answers as absent.
      const agent = await resolveReadableAgentRef(ctx, agentId);
      const resolvedAgentId = agent.id;
      await requireAgentAccess(ctx, agent, 'ADMIN');
      // #1882 / cor:dmo:050:13 (R12): a user-owned Agent clear removes every
      // named config, for its owner or a platform admin. Org-owned clears
      // retain the default shim.
      // Re-read roles and ownership under the same authority fences as Agent
      // management; a request-time ADMIN claim must not widen a later delete.
      await withAuthorizedTx(ctx, [
        { kind: 'agent', id: resolvedAgentId },
        ...(agent.organizationId ? [{ kind: 'org' as const, id: agent.organizationId }] : []),
        ...(agent.ownerUserId ? [{ kind: 'user' as const, id: agent.ownerUserId }] : []),
      ], async txCtx => {
        const current = await txCtx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
        if (current.organizationId !== agent.organizationId || current.ownerUserId !== agent.ownerUserId) {
          throw authorizationDenied();
        }
        await requireAgentAccess(txCtx, current, 'ADMIN');
      }, async (tx) => {
        await tx.aiServiceConfig.deleteMany({
          where: {
            agentId: resolvedAgentId,
            ...(agent.ownerUserId !== null ? {} : { name: DEFAULT_AI_CONFIG_NAME }),
          },
        });
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
        endpoint?: string | null;
        apiStyle?: string | null;
        enabled?: boolean | null;
      },
      ctx: Context,
    ) => {
      try {
        const { ownerWhere } = await requireAiConfigOwnerAdmin(ctx, args.ownerType, args.ownerId);
        const name = validateAiConfigName(args.name);
        validateProviderAndParams(args.provider, args.params ?? null);
        validateParamRanges(args.provider, args.params ?? null);
        refuseLegacyBaseUrl(args.params);
        const endpoint = args.endpoint ? validateEndpoint(args.endpoint) : null;
        requireEndpointFor(args.provider, endpoint);
        requireKeyFor({ provider: args.provider, endpoint }, !!args.apiKey, args.ownerType);
        validateApiStyle(args.provider, args.apiStyle);
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
            endpoint,
            apiStyle: args.apiStyle ?? null,
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
        endpoint?: string | null;
        apiStyle?: string | null;
        enabled?: boolean | null;
      },
      ctx: Context,
    ) => {
      try {
        const existing = await ctx.db.aiServiceConfig.findUnique({ where: { id: args.id } });
        if (!existing) throw new AiServiceConfigNotFoundError(args.id);
        const owner = aiConfigOwnerOf(existing);
        await requireAiConfigOwnerAdmin(ctx, owner.ownerType, owner.ownerId);
        if (args.params !== undefined) refuseLegacyBaseUrl(args.params);
        // Omitted = unchanged; null or '' = clear back to the provider default.
        const endpoint =
          args.endpoint === undefined ? undefined : args.endpoint ? validateEndpoint(args.endpoint) : null;
        // The RESULTING config, judged against a base row: a provider change
        // must not strand a style, and the endpoint and key the result needs
        // must be there.
        const judge = (base: typeof existing) => {
          const provider = args.provider ?? base.provider;
          const params = args.params === undefined ? base.params : args.params;
          validateProviderAndParams(provider, params ?? null);
          // #1417: known provider ranges bind what this write sets; a row it
          // leaves alone (no params, same provider) is not re-judged.
          if (args.params !== undefined || args.provider != null) validateParamRanges(provider, params ?? null);
          validateApiStyle(provider, args.apiStyle === undefined ? base.apiStyle : args.apiStyle);
          const resultingEndpoint = endpoint === undefined ? base.endpoint : endpoint;
          requireEndpointFor(provider, resultingEndpoint);
          requireKeyFor(
            { provider, endpoint: resultingEndpoint },
            args.apiKey === undefined ? !!base.apiKeyEncrypted : !!args.apiKey,
            owner.ownerType,
          );
          return provider;
        };
        judge(existing);
        // …and again on the LOCKED row, in the write's transaction (#1380 /
        // #1389 review): a concurrent edit between the read above and this
        // write can't leave a config the write-time rules refuse, including a
        // provider/style pair neither of two racing updates judged.
        const config = await ctx.db.$transaction(async (tx) => {
          const cur = await lockAiServiceConfig(tx, existing.id);
          if (!cur) throw new AiServiceConfigNotFoundError(args.id);
          const provider = judge(cur);
          return tx.aiServiceConfig.update({
          where: { id: existing.id },
          data: {
            ...(args.name != null ? { name: validateAiConfigName(args.name) } : {}),
            provider,
            ...(args.model != null ? { model: args.model } : {}),
            ...apiKeyWriteFields(args.apiKey),
            ...(args.params === undefined
              ? {}
              : { params: args.params === null ? Prisma.DbNull : (args.params as InputJsonValue) }),
            ...(endpoint === undefined ? {} : { endpoint }),
            ...(args.apiStyle === undefined ? {} : { apiStyle: args.apiStyle }),
            ...(args.enabled == null ? {} : { enabled: args.enabled }),
            updatedBy: ctx.userId ?? null,
          },
          });
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

    testAiServiceConfig: async (
      _: unknown,
      { id, override }: { id: string; override?: AiConfigTestOverride | null },
      ctx: Context,
    ) => {
      try {
        return await testAiServiceConfig(ctx, id, override ?? {});
      } catch (e) {
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
      await requireAgentAccess(ctx, agentOwner, 'ADMIN');
      return;
    } catch {
      throw subscriberErr;
    }
  }
}
