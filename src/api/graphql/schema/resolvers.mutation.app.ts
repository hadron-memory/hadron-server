import type { Prisma } from '../../../generated/prisma/index.js';
import { requireAppKeyManager, lockAppKeyManagerMemberships } from './appKeyManagement.js';
import { detachAppOwnerMemories } from '../../../controller/operations/detachAppOwnerMemories.js';
// appMutations — extracted from resolvers.ts Mutation (split step 2). No behavior change.
import {
  createHash,
  randomBytes,
} from 'crypto';
import { generateId } from '../../../lib/id.js';
import { encryptToken } from '../../../lib/tokenCrypto.js';
import {
  DEFAULT_AI_CONFIG_NAME,
  apiKeyWriteFields,
  apiKeyPreviewOf,
  AiServiceConfigNotFoundError,
  lockAiServiceConfig,
  validateProviderAndParams,
} from '../../../lib/aiConfig.js';
import {
  APP_KEY_PREFIX,
  USER_API_KEY_LABEL_MAX_LEN,
  oauthSurfaceRefusal,
  oauthSurfaceRefusalMessage,
  hashAppKey,
  mintUserApiKeyInTx,
} from '../../../middleware/auth.js';
import { ensureAgentOrgGrant } from '../../../controller/operations/ensureAgentOrgGrant.js';
import { planOrgAgentInstallGrant } from '../../../lib/auth/orgAgentInstallLicense.js';
import { ensureAgentSubscription } from '../../../controller/operations/ensureAgentSubscription.js';
import { normalizeHandleOrNull } from '../../../lib/userHandle.js';
import {
  ensureAppMember,
  InvalidRoleError,
  MaxMembersExceededError,
  OrphanAppError,
} from '../../../controller/operations/ensureAppMember.js';
import {
  joinApp,
  SelfJoinNotAllowedError,
  AppUninstalledError,
} from '../../../controller/operations/joinApp.js';
import { AgentNotFoundError, AppNotFoundError } from '../../../lib/entityRef/errors.js';
import { leaveApp } from '../../../controller/operations/leaveApp.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { deriveSlugFromName } from '../../../lib/urn.js';
import { parsePolicyLink } from '@hadron-memory/access-control';
import { GraphQLError } from 'graphql';
import {
  type AppType,
  type AppMembershipRole,
} from '../../../generated/prisma/index.js';
import {
  type Context,
  requireOrgRole,
  requireOwnerOrOrgRole,
  rethrowAiConfigTyped,
  resolveUserRefArg,
  resolveAppRefArg,
  APP_INCLUDE,
  installAgentIntoAppCore,
  uninstallAgentFromAppCore,
  requireReadableAgent,
} from './resolvers.helpers.js';
import { findOrCreateAppClassMemory } from './chat-scope.js';
// Spec 049 Phase 4 — the App's default Channel, created with the App.
import { ensureDefaultChannelForApp } from '../../../lib/channels.js';
import { recordUrnRename } from '../../../lib/urnAlias.js';
import { assertNoMintedCorpusCascade } from '../../../lib/mintedSpecPermanence.js';
import { requireEndpointFor, requireKeyFor } from '../../../lib/aiEndpoint.js';
import { LIVE_ORG_MEMBERSHIP } from '../../../lib/auth/liveOrgMembership.js';
import { withAuthorizedTx } from './authorizedTx.js';

/**
 * #974 / cor:agt:020:02: a soft-deleted App keeps reserving its workers'
 * names FOREVER — history (PR trailers, chat archives) references them, and
 * `Worker.appId` is onDelete: Cascade, so hard-deleting the tombstone would
 * silently take the castings with it and recycle their names. Every
 * tombstone-reclaim path must refuse instead when castings exist.
 */
async function assertNoWorkers(
  db: Context['db'],
  appId: string,
  appUrn: string,
  action: 'reclaim',
): Promise<void> {
  const workers = await db.worker.count({ where: { appId } });
  if (workers > 0) {
    throw new GraphQLError(
      `Cannot ${action} the URN "${appUrn}": the deleted App holding it still has ${workers} worker casting(s), whose names are permanently reserved (cor:agt:020:02).`,
      { extensions: { code: 'WORKER_NAMES_RESERVED', appId, workers } },
    );
  }
}

/**
 * #2044, R29 (Holger 2026-10-18): reclaiming an App's URN hard-deletes the soft-deleted App
 * holder, and `Memory.appId` cascades. Ruling A keeps an App's install memories when the App
 * is deleted ("org admins delete them by hand"), so the hard path is REFUSED while any
 * remain, never silently completed. The App row is locked first, in the transaction that
 * deletes it, so the count and the delete serialise against a creation (which holds the same
 * row shared and refuses a deleted App).
 */
async function assertNoInstallMemories(
  tx: Prisma.TransactionClient,
  appId: string,
  appUrn: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM apps WHERE id = ${appId} FOR UPDATE`;
  const remaining = await tx.memory.count({
    where: { appId, class: 'system', isInstallMemory: true, deletedAt: null },
  });
  if (remaining > 0) {
    throw new GraphQLError(
      `Cannot reclaim the URN "${appUrn}": the deleted App holding it still has ${remaining} install memor${remaining === 1 ? 'y' : 'ies'}, which are kept when an App is deleted. Whoever manages the App deletes them first (deleteMemory).`,
      { extensions: { code: 'INSTALL_MEMORIES_REMAIN', appId, installMemories: remaining } },
    );
  }
}

/**
 * Can the caller manage this App's members by ROLE alone — independent of any
 * target user? Platform ADMIN/OWNER for an ORG-owned App, the user-owner of a
 * user-owned App, an org ADMIN/OWNER of the App's org, or an owner-role
 * AppMember. spec 047 (blocker 3): the platform-admin bypass applies ONLY to an
 * org-owned App (a user-owned App is strictly owner-only). Shared by
 * ensureAppMember + removeAppMember so the role gate is evaluated BEFORE the
 * target user is resolved — a non-authorized caller can't turn user-ref
 * resolution into an existence oracle (#816 review).
 */
export async function callerManagesAppMembers(
  ctx: Context,
  app: { ownerUserId: string | null; organizationId: string | null },
  resolvedAppId: string,
): Promise<boolean> {
  const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
  if (isPlatformAdmin && app.ownerUserId === null) return true;
  const isAppOwnerUser = app.ownerUserId !== null && !!ctx.userId && ctx.userId === app.ownerUserId;
  if (isAppOwnerUser) return true;
  if (app.organizationId) {
    const orgMember = await ctx.db.orgMember.findFirst({
      where: {
        organizationId: app.organizationId,
        userId: ctx.userId ?? '',
        ...LIVE_ORG_MEMBERSHIP,
        role: { in: ['ADMIN', 'OWNER'] },
      },
    });
    if (orgMember) return true;
  }
  const ownerMember = ctx.userId
    ? await ctx.db.appMember.findUnique({
        where: { appId_userId: { appId: resolvedAppId, userId: ctx.userId } },
      })
    : null;
  return ownerMember?.role === 'owner';
}

/**
 * #951 — provision an App's `class='app'` shared memory for its founding
 * Agent, at App-create time. Idempotent (find-or-create on the derived URN),
 * and deliberately BEST-EFFORT: the App row is already committed by the time
 * we get here, the lazy provisioners on the chat paths remain, and an App
 * without its shared memory is exactly the pre-#951 state — so a failure is
 * logged, not raised.
 *
 * `actingUserId` may be absent for a platform-admin caller (createApp guards
 * its member grant the same way), in which case provisioning is skipped: the
 * memory's `createdBy` wants a real user, and the first post will provision it.
 *
 * Honors the Agent's own declaration (`memoryProvisioning.appMemory`, spec 008
 * FR-008 — 'shared' | 'user' | 'none', defaulting to 'shared'): eagerly
 * creating shared writable storage for an Agent that declares 'user' or 'none'
 * would contradict the contract it published. (Codex P1 on PR #953. The lazy
 * chat-time provisioners have never consulted this declaration either — that
 * pre-dates #951 and is left alone here rather than changed blind; a shared
 * chat needs its holding memory whatever the declaration says.)
 */
async function provisionAppSharedMemory(
  ctx: Context,
  app: { id: string; urn: string; name: string; organizationId: string | null; ownerUserId: string | null },
  agentId: string,
): Promise<void> {
  if (!ctx.userId) return;
  try {
    const agent = await ctx.db.agent.findUniqueOrThrow({
      where: { id: agentId },
      select: { urn: true, name: true, memoryProvisioning: true },
    });
    const appMemoryMode =
      (agent.memoryProvisioning as { appMemory?: unknown } | null)?.appMemory ?? 'shared';
    if (appMemoryMode !== 'shared') return;
    await findOrCreateAppClassMemory({
      appId: app.id,
      appUrn: app.urn,
      appName: app.name,
      agentId,
      agentUrn: agent.urn,
      agentName: agent.name,
      organizationId: app.organizationId,
      ownerUserId: app.ownerUserId,
      actingUserId: ctx.userId,
      db: ctx.db,
    });
  } catch (err) {
    console.warn('[createApp] app-class memory provisioning failed:', err);
  }
}

export const appMutations = {
    regenerateAppKey: async (_: unknown, { appRef }: { appRef: string }, ctx: Context) => {
      // 007-entity-id-or-urn: appRef may be ID, bare URN, or prefixed URN.
      const { id: resolvedId } = await resolveAppRef(ctx.db, appRef);
      const existing = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedId } });
      // #1744 / cor:dmo:050:05: rotation is one revoke plus mint, with the same audience.
      await requireAppKeyManager(ctx, existing);
      const rawKey = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
      const keyHash = createHash('sha256').update(rawKey).digest('hex');
      return withAuthorizedTx(
        ctx,
        [{ kind: 'app', id: resolvedId }, ...(existing.organizationId
          ? [{ kind: 'org' as const, id: existing.organizationId }]
          : [{ kind: 'user' as const, id: existing.ownerUserId! }])],
        async (txCtx) => {
          const current = await txCtx.db.app.findUniqueOrThrow({ where: { id: resolvedId } });
          if (current.organizationId !== existing.organizationId || current.ownerUserId !== existing.ownerUserId) {
            throw new Error('App ownership changed; retry key regeneration');
          }
          await requireAppKeyManager(txCtx, current);
        },
        async (tx) => {
          // Revocation and replacement are one atomic authority change.
          await tx.appKey.updateMany({
            where: { appId: resolvedId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          await tx.appKey.create({
            data: {
              id: generateId(),
              appId: resolvedId,
              keyHash,
              keyPreview: rawKey.slice(-4),
              label: 'Regenerated key',
              createdBy: ctx.userId ?? ctx.appId ?? ctx.clientId ?? null,
            },
          });
          const fresh = await tx.app.findUniqueOrThrow({
            where: { id: resolvedId }, include: APP_INCLUDE,
          });
          return { app: fresh, rawKey };
        },
        { lockMode: 'exclusive', afterLock: async (tx) => {
          await lockAppKeyManagerMemberships(tx, ctx, existing);
        } },
      );
    },

    createApp: async (
      _: unknown,
      {
        orgRef,
        agentRef,
        name,
        urn,
        appType,
        role,
        description,
        systemPrompt,
        agentTools,
        aiProvider,
        aiModel,
        aiApiKey,
        expiresAt,
        surfaces,
        trainingMode,
        installOptional,
        // App-original fields
        createUserPermission,
        identifyUserMethod,
        sessionTimeoutSeconds,
        anonymousTtlDays,
      }: {
        orgRef?: string | null;
        agentRef: string;
        name: string;
        urn?: string;
        appType?: AppType;
        role?: AppMembershipRole;
        description?: string;
        systemPrompt?: string;
        agentTools?: string[];
        aiProvider?: string;
        aiModel?: string;
        aiApiKey?: string;
        expiresAt?: string;
        surfaces?: string[];
        trainingMode?: boolean;
        installOptional?: string[];
        createUserPermission?: 'DENY' | 'EXPLICIT' | 'IMPLICIT';
        identifyUserMethod?: 'USER_ID' | 'SECRET';
        sessionTimeoutSeconds?: number;
        anonymousTtlDays?: number;
      },
      ctx: Context,
    ) => {
      // spec 047: an App is owned by EXACTLY ONE of an org or a user. `orgId`
      // present ⇒ org-owned (org ADMIN); `orgId` omitted ⇒ user-owned by the
      // caller, namespaced under their `@<handle>`. An EMPTY-STRING orgId is a
      // malformed request, not a personal-create signal — reject it so a client
      // bug can't silently bypass org resolution + the ADMIN gate.
      if (orgRef !== undefined && orgRef !== null && orgRef.trim() === '') {
        throw new GraphQLError('orgRef must be a non-empty organization ID or URN — omit it entirely to create a personal App.', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      // The legacy AI arguments are validated BEFORE any write (#1389 review):
      // refusing them after the App, its memory and its Channel exist would
      // leave a half-made App behind and a URN a retry collides with.
      if (aiProvider && aiModel) {
        try {
          validateProviderAndParams(aiProvider, null);
          // The legacy args carry no endpoint (#1373): openai-compatible needs one.
          requireEndpointFor(aiProvider, null);
          requireKeyFor({ provider: aiProvider, endpoint: null }, !!aiApiKey, 'APP');
        } catch (e) {
          rethrowAiConfigTyped(e);
        }
      }
      let resolvedOrgId: string | null = null;
      let ownerUserId: string | null = null;
      let namespace: string;
      if (orgRef) {
        // 007-entity-id-or-urn: orgRef may be ID, bare URN, or prefixed URN.
        const { id } = await resolveOrgRef(ctx.db, orgRef);
        await requireOrgRole(ctx, id, 'ADMIN');
        const org = await ctx.db.organization.findUniqueOrThrow({ where: { id }, select: { urn: true } });
        resolvedOrgId = id;
        namespace = org.urn;
      } else {
        if (!ctx.userId) {
          throw new GraphQLError('Creating a personal App requires an authenticated user.', { extensions: { code: 'UNAUTHENTICATED' } });
        }
        const user = await ctx.db.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { handle: true } });
        const handle = normalizeHandleOrNull(user.handle);
        if (!handle) {
          throw new GraphQLError('Your account needs a valid handle before you can create a personal App. Set one in your profile.', { extensions: { code: 'BAD_USER_INPUT' } });
        }
        ownerUserId = ctx.userId;
        // #697 v2: user-owned root is the BARE handle — no `@` sigil (see the
        // createAgent note). Emission strips the sigil, so a stored
        // `@handle:slug` couldn't be resolved from the emitted bare URN.
        namespace = handle;
      }
      // URN format matches memories and agents: "{namespace}:{slug}" — the
      // namespace is an org domain OR the bare user handle for a user-owned App.
      // #574: shared slugify.
      //
      const appSlug = deriveSlugFromName(urn ?? name);
      const appUrn = `${namespace}:${appSlug}`;

      // 009-install-agent-flow: agentRef is required (typeDef gate). Resolve the
      // Agent (resolveAgentRef rejects soft-deleted Agents).
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentRef);
      let selectedImports: Array<{ importedAgentId: string }> = [];
      // #1573: the personal path licenses the install with the owner's
      // subscription, written inside the anchored App-creation transaction.
      let personalSubscription = false;
      let txAutoGrantIds: string[] = [];
      if (resolvedOrgId) {
        // Conceal an unlicensed foreign parent before resolving caller-supplied
        // optional refs. Their lookup errors must not reveal that it exists.
        const autoGrantIds: string[] = [];
        if (await planOrgAgentInstallGrant(ctx.db, resolvedOrgId, resolvedAgentId, agentRef)) {
          autoGrantIds.push(resolvedAgentId);
        }
        // Resolve the full install set before any grant/App write. A required
        // or opted-in dependency may belong to another org even when the
        // parent Agent is ours; checking it after app.create left a partial
        // install when its license was missing.
        const imports = await ctx.db.agentImport.findMany({
          where: { parentAgentId: resolvedAgentId },
          orderBy: { position: 'asc' },
          select: { importedAgentId: true, required: true },
        });
        // #1946: an optional ref must name one of the parent's imports. One
        // that resolves to any other Agent used to be dropped silently, so the
        // App got created: a successful probe of the ref. It now refuses
        // exactly as an absent ref does, and nothing is created either way.
        const importIds = new Set(imports.map((imp) => imp.importedAgentId));
        const optionalIds = new Set<string>();
        for (const ref of installOptional ?? []) {
          const { id } = await resolveAgentRef(ctx.db, ref);
          if (!importIds.has(id)) throw new AgentNotFoundError(ref);
          optionalIds.add(id);
        }
        selectedImports = imports.filter((imp) => imp.required || optionalIds.has(imp.importedAgentId));

        for (const imp of selectedImports) {
          if (await planOrgAgentInstallGrant(ctx.db, resolvedOrgId, imp.importedAgentId, agentRef, true)) {
            autoGrantIds.push(imp.importedAgentId);
          }
        }
        // #1573: the grant WRITES happen inside the anchored transaction below,
        // which re-plans on txCtx. This pre-check only surfaces typed refusals
        // (and conceals an unlicensed foreign parent) before any write.
        void autoGrantIds;
      } else {
        // spec 047 personal path: no org ⇒ no AgentOrgGrant. The install is
        // licensed by the OWNER's AgentSubscription instead. A user may install
        // ONLY a PUBLIC (marketplace) agent or their OWN user-owned agent into a
        // personal App — never another tenant's private agent (which would fold
        // that tenant's memories into this App). Mirror installAgentIntoAppCore's
        // accessibility gate for the org-less case.
        const installAgent = await ctx.db.agent.findUniqueOrThrow({
          where: { id: resolvedAgentId },
          select: { visibility: true, ownerUserId: true, organizationId: true, deletedAt: true },
        });
        const isOwnAgent = installAgent.ownerUserId !== null && installAgent.ownerUserId === ctx.userId;
        if (installAgent.visibility !== 'PUBLIC' && !isOwnAgent) {
          // #1946: ORGANIZATION_MISMATCH (and its agentId) only for an Agent
          // the caller can read; one they can't answers as an absent one.
          await requireReadableAgent(ctx, installAgent, agentRef);
          throw new GraphQLError('A personal App may only install a PUBLIC agent or your own personal agent.', {
            extensions: { code: 'ORGANIZATION_MISMATCH', agentId: resolvedAgentId },
          });
        }
        // spec 047: cascade-install provisions each dependency as its own
        // ORG-scoped App — unsupported for a personal App in v1. Reject BEFORE
        // any write (subscription / App create) so a rejected call never leaves
        // an orphan App + AppAgent behind (codex review, #685). Required deps
        // always cascade; optional deps cascade when listed in installOptional —
        // either means "has deps to install", which a personal App can't do yet.
        const requiredDeps = await ctx.db.agentImport.count({
          where: { parentAgentId: resolvedAgentId, required: true },
        });
        if (requiredDeps > 0) {
          throw new GraphQLError('Installing an agent with required dependencies as a personal App is not supported yet.', {
            extensions: { code: 'BAD_USER_INPUT', agentId: resolvedAgentId },
          });
        }
        if (installOptional && installOptional.length > 0) {
          throw new GraphQLError('Installing optional dependencies as a personal App is not supported yet.', {
            extensions: { code: 'BAD_USER_INPUT', agentId: resolvedAgentId },
          });
        }
        // License the install with the owner's subscription (idempotent,
        // activates immediately in v1). Skipped for the owner's own agent —
        // ownership already licenses it.
        personalSubscription = !isOwnAgent;
      }

      // Hard-delete a soft-deleted collision so the URN can be reused
      // (same pattern as createAgent/createMemory).
      //
      // Spec 021 FR-027: App.urn is no longer globally unique — the
      // partial unique index `apps_urn_active_uniq` only enforces
      // uniqueness on rows where `uninstalled_at IS NULL`. Resolve the
      // active row via `findFirst` with the active-row filter so
      // uninstalled history rows sharing the same URN don't surface
      // here.
      const existing = await ctx.db.app.findFirst({
        where: { urn: appUrn, uninstalledAt: null },
      });
      if (existing) {
        if (existing.deletedAt) {
          // #974 / cor:agt:020:02: a soft-deleted App keeps reserving all of
          // its workers' names — history (PR trailers, chat archives)
          // references them, and `Worker.appId` is onDelete: Cascade, so
          // hard-deleting the tombstone here would silently take the castings
          // with it and recycle their permanently-reserved names. Refuse
          // instead.
          await assertNoWorkers(ctx.db, existing.id, appUrn, 'reclaim');
          // #1468 — the delete cascades the App's memories: refused while one
          // is a stamped corpus still holding a spec.
          await ctx.db.$transaction(async (tx) => {
            await assertNoInstallMemories(tx, existing.id, appUrn);
            await detachAppOwnerMemories(tx, [existing.id]);
            const doomed = await tx.memory.findMany({ where: { appId: existing.id }, select: { id: true } });
            await assertNoMintedCorpusCascade(tx, doomed.map((m) => m.id), 'reclaim the App URN over');
            await tx.app.delete({ where: { id: existing.id } });
          });
        } else {
          throw new Error(`An app with URN "${appUrn}" already exists`);
        }
      }
      // 023-app-shape Phase 2b: App↔Agent moved from `App.agentId` to the
      // N:M `AppAgent` join. Create the App, then immediately link the
      // requested Agent via an AppAgent row.
      // #1573: the license writes (org grants for the Agent and each selected
      // dependency, or the personal owner's subscription) and the App + its
      // AppAgent install commit TOGETHER under the anchors their revokers take
      // exclusively: the owning org (or the owning user, added by the helper as
      // the actor) and every Agent being licensed. After the anchor wait the
      // gate re-runs on txCtx: org ADMIN and the #1584 license plan, or the
      // personal PUBLIC-or-own rule.
      const licensedAgentIds = [resolvedAgentId, ...selectedImports.map((imp) => imp.importedAgentId)];
      const createdApp = await withAuthorizedTx(
        ctx,
        [
          ...(resolvedOrgId ? [{ kind: 'org' as const, id: resolvedOrgId }] : []),
          ...[...new Set(licensedAgentIds)].map((id) => ({ kind: 'agent' as const, id })),
        ],
        async (txCtx) => {
          if (resolvedOrgId) {
            await requireOrgRole(txCtx, resolvedOrgId, 'ADMIN');
            txAutoGrantIds = [];
            if (await planOrgAgentInstallGrant(txCtx.db, resolvedOrgId, resolvedAgentId, agentRef)) {
              txAutoGrantIds.push(resolvedAgentId);
            }
            for (const imp of selectedImports) {
              if (await planOrgAgentInstallGrant(txCtx.db, resolvedOrgId, imp.importedAgentId, agentRef, true)) {
                txAutoGrantIds.push(imp.importedAgentId);
              }
            }
          } else {
            const current = await txCtx.db.agent.findUnique({
              where: { id: resolvedAgentId },
              select: { visibility: true, ownerUserId: true, deletedAt: true },
            });
            const own = current?.ownerUserId != null && current.ownerUserId === ctx.userId;
            if (!current || current.deletedAt || (current.visibility !== 'PUBLIC' && !own)) {
              throw new GraphQLError('A personal App may only install a PUBLIC agent or your own personal agent.', {
                extensions: { code: 'ORGANIZATION_MISMATCH', agentId: resolvedAgentId },
              });
            }
          }
        },
        async (tx) => {
          for (const id of new Set(txAutoGrantIds)) {
            await ensureAgentOrgGrant(tx, resolvedOrgId!, id);
          }
          if (personalSubscription) await ensureAgentSubscription(tx, ctx.userId!, resolvedAgentId);
        const app = await tx.app.create({
          data: {
            organizationId: resolvedOrgId,
            ownerUserId,
            name,
            urn: appUrn,
            surfaces: surfaces ?? undefined, // undefined → use the schema default ['chat']
            trainingMode: trainingMode ?? false,
            appType: appType ?? 'WORKSTATION',
            role: role ?? 'READER',
            description: description ?? null,
            systemPrompt: systemPrompt ?? null,
            agentTools: agentTools ?? [],
            expiresAt: expiresAt ? new Date(expiresAt) : undefined,
            createUserPermission: createUserPermission ?? 'EXPLICIT',
            identifyUserMethod: identifyUserMethod ?? 'USER_ID',
            sessionTimeoutSeconds: sessionTimeoutSeconds ?? 900,
            anonymousTtlDays: anonymousTtlDays ?? 7,
            createdBy: ctx.userId ?? null,
            appAgents: { create: { agentId: resolvedAgentId, createdBy: ctx.userId ?? null } },
          },
          include: APP_INCLUDE,
        });
          // 009-install-agent-flow T015: the installer is auto-added as an
          // AppMember with role 'owner' when the Agent's installationPolicy
          // permits it, routed through ensureAppMember so the memberRoles +
          // maxMembers invariants from 008 R-7 hold. #1573 (Chip, Atilla):
          // granted INSIDE the transaction that creates the App, so no
          // deleteApp / removeAppMember can act on the App between its
          // creation and this membership grant. ctx.userId may be absent for a
          // platform-admin caller; there is then no user to grant it to.
          const installerAgent = await tx.agent.findUniqueOrThrow({
            where: { id: resolvedAgentId },
            select: { installationPolicy: true },
          });
          const allowedRoles = (installerAgent.installationPolicy as { memberRoles?: string[] })
            ?.memberRoles ?? ['owner'];
          if (allowedRoles.includes('owner') && ctx.userId) {
            await ensureAppMember(tx, app.id, ctx.userId, 'owner', { actorId: ctx.userId });
          }
          return app;
        },
        { fence: true },
      );

      // #951 — provision the App's own class='app' shared memory NOW, the way
      // an Agent's system memory is provisioned at Agent-create time. Until
      // this, the memory was created lazily on the first shared/team chat
      // post, so a freshly installed App's only memory was the Agent's
      // system memory — which is READ-ONLY from every App that runs it
      // (cor:dmo:050:03). That left a correctly-built App badged "read-only"
      // in the portal with no writable memory at all, and made `hadron team
      // init -m <memory>` unrunnable: the memory it needs did not exist until
      // somebody posted to the chat first.
      //
      // Best-effort: the App itself is already committed (createApp is not one
      // transaction), and the lazy provisioners are still in place, so a
      // failure here must not fail the install — it only defers provisioning
      // to first post, which is exactly the old behavior.
      await provisionAppSharedMemory(ctx, createdApp, resolvedAgentId);
      // Spec 049 Phase 4 (D-2026-09-13-006): the default Channel is created WITH
      // the App — nothing is unprotected before the first post. The core makes
      // root, row and default link in ONE transaction, so a failure here leaves
      // NO root behind (never a live `chats:team` without its Channel — Copilot
      // on PR #1165); the App row is committed, and the first post's bootstrap
      // provisions both. Logged at error level so the gap is visible.
      try {
        await ensureDefaultChannelForApp(ctx.db, createdApp, ctx.userId ?? null);
      } catch (err) {
        console.error(`[createApp] default Channel provisioning failed for App ${createdApp.id} — deferred to first post:`, err);
      }

      // 036-ai-service-config: the legacy aiProvider/aiModel/aiApiKey args
      // become the App's 'default' registry config (deploy-time override
      // that wins over the Agent's default in the resolution walk).
      if (aiProvider && aiModel) {
        // Validated before the App was created (top of this resolver).
        await ctx.db.aiServiceConfig.create({
          data: {
            appId: createdApp.id,
            name: DEFAULT_AI_CONFIG_NAME,
            provider: aiProvider,
            model: aiModel,
            ...(aiApiKey
              ? { apiKeyEncrypted: encryptToken(aiApiKey), apiKeyPreview: apiKeyPreviewOf(aiApiKey) }
              : {}),
            createdBy: ctx.userId ?? null,
          },
        });
      }

      // 008-agent-installation T059: cascade-install required deps.
      // Walk AgentImport rows for the parent and install each one as its own
      // App (or reuse an existing App in the same org for the same dep).
      // Required imports always cascade; optional imports cascade only when
      // their id appears in `installOptional`.
      // 009-install-agent-flow: the outer `if (resolvedAgentId)` guard is
      // dropped — agentId is always present post-009.
      // spec 047: cascade-install provisions each dependency as its own
      // ORG-scoped App (it threads resolvedOrgId + org.urn). A personal App has
      // no org, so cascade is unsupported there — the personal branch above
      // already rejected any agent-with-deps BEFORE writes, so here we simply
      // scope the cascade to org-owned Apps.
      if (resolvedOrgId) {
        const org = await ctx.db.organization.findUniqueOrThrow({ where: { id: resolvedOrgId }, select: { urn: true } });
        for (const imp of selectedImports) {

          // Reuse an existing App for the same (org, dep agent) — one App per
          // (org, Agent) pair (v1 doesn't support per-bundle namespacing of
          // dep installations, per spec User Story 3 acceptance scenario 4).
          const existingDepApp = await ctx.db.app.findFirst({
            where: {
              organizationId: resolvedOrgId,
              appAgents: { some: { agentId: imp.importedAgentId } },
              deletedAt: null,
            },
            select: { id: true },
          });
          if (existingDepApp) continue;

          // Derive a sensible URN for the dep's App. Use the imported
          // Agent's slug; fall back to `dep-${id}` if the URN doesn't have
          // a slug suffix (defensive — all 008-shape Agents have URNs).
          const depAgent = await ctx.db.agent.findUniqueOrThrow({
            where: { id: imp.importedAgentId },
            select: { name: true, urn: true },
          });
          const depSlug =
            depAgent.urn.split(':').slice(1).join(':') || `dep-${imp.importedAgentId}`;
          let depUrn = `${org.urn}:${depSlug}`;
          // If the URN happens to collide with a soft-deleted App, hard-delete
          // it (same pattern as the parent App branch above). For non-deleted
          // collisions, append the imported-agent id as a disambiguator.
          // Spec 021 FR-027: active-row resolution (uninstalled history rows
          // sharing this URN don't count as a collision).
          const depCollision = await ctx.db.app.findFirst({
            where: { urn: depUrn, uninstalledAt: null },
          });
          if (depCollision) {
            if (depCollision.deletedAt) {
              // Same reclaim rule as the parent App branch: `Worker.appId`
              // cascades, so hard-deleting a retired App here would delete its
              // castings and recycle their permanently-reserved names.
              await assertNoWorkers(ctx.db, depCollision.id, depUrn, 'reclaim');
              // #1468 — same cascade rule as the parent App branch.
              await ctx.db.$transaction(async (tx) => {
                await assertNoInstallMemories(tx, depCollision.id, depUrn);
                await detachAppOwnerMemories(tx, [depCollision.id]);
                const doomed = await tx.memory.findMany({ where: { appId: depCollision.id }, select: { id: true } });
                await assertNoMintedCorpusCascade(tx, doomed.map((m) => m.id), 'reclaim the App URN over');
                await tx.app.delete({ where: { id: depCollision.id } });
              });
            } else {
              depUrn = `${depUrn}:${imp.importedAgentId.slice(-8)}`;
            }
          }

          // #1573: each dependency App's install commits under the org and the
          // imported Agent's anchors (revokeAgentOrgGrant / org-role revokers
          // hold them exclusively), with org ADMIN and the dependency's license
          // re-checked on txCtx; a same-org grant that is missing is written in
          // the same transaction.
          let depAutoGrant = false;
          const depApp = await withAuthorizedTx(
            ctx,
            [{ kind: 'org', id: resolvedOrgId }, { kind: 'agent', id: imp.importedAgentId }],
            async (txCtx) => {
              await requireOrgRole(txCtx, resolvedOrgId, 'ADMIN');
              depAutoGrant = await planOrgAgentInstallGrant(txCtx.db, resolvedOrgId, imp.importedAgentId, agentRef, true);
            },
            async (tx) => {
              if (depAutoGrant) await ensureAgentOrgGrant(tx, resolvedOrgId, imp.importedAgentId);
              return tx.app.create({
                data: {
                  organizationId: resolvedOrgId,
                  name: `${depAgent.name} (cascaded from ${name})`,
                  urn: depUrn,
                  surfaces: ['chat'], // dep installs default to chat surface
                  trainingMode: false,
                  createdBy: ctx.userId ?? null,
                  appAgents: {
                    create: { agentId: imp.importedAgentId, createdBy: ctx.userId ?? null },
                  },
                },
              });
            },
            { fence: true },
          );
          // #951: a cascaded dependency App is an App like any other — it gets
          // its shared memory at install time too, not on first chat.
          await provisionAppSharedMemory(ctx, depApp, imp.importedAgentId);
        }
      }

      return createdApp;
    },

    updateApp: async (
      _: unknown,
      {
        ref,
        name,
        urn,
        appType,
        role,
        description,
        systemPrompt,
        agentTools,
        aiProvider,
        aiModel,
        aiApiKey,
        expiresAt,
        surfaces,
        trainingMode,
        // App-original fields
        createUserPermission,
        identifyUserMethod,
        sessionTimeoutSeconds,
        sessionDormancyDays,
        agentSessionsExpire,
        anonymousTtlDays,
        policy,
      }: {
        ref: string; name?: string; urn?: string;
        appType?: AppType;
        role?: AppMembershipRole;
        description?: string;
        systemPrompt?: string;
        agentTools?: string[];
        // GraphQL nullable args: explicit null is meaningful here
        // (aiProvider: null clears the App's 'default' AI config).
        aiProvider?: string | null;
        aiModel?: string | null;
        aiApiKey?: string | null;
        expiresAt?: string;
        surfaces?: string[];
        trainingMode?: boolean;
        createUserPermission?: 'DENY' | 'EXPLICIT' | 'IMPLICIT';
        identifyUserMethod?: 'USER_ID' | 'SECRET';
        sessionTimeoutSeconds?: number;
        sessionDormancyDays?: number | null;
        agentSessionsExpire?: boolean | null;
        anonymousTtlDays?: number;
        // #510: app-layer action-policy link (cor:acl:040:02).
        // Explicit null clears; omitted preserves.
        policy?: unknown;
      },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: ref may be ID, bare URN, or prefixed URN.
      const { id: resolvedId } = await resolveAppRef(ctx.db, ref);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedId } });
      await requireOwnerOrOrgRole(ctx, app, 'ADMIN');
      // #510: the app-layer action-policy link (cor:acl:040:02) — validate
      // shape before storing; explicit null clears (= no restriction).
      if (policy !== undefined && policy !== null && parsePolicyLink(policy) == null) {
        throw new GraphQLError('policy must be { allow: string[] } or null.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      // Ruling DY-5: a dormancy threshold is a positive whole number of days.
      // Loud rather than clamped: a 0 would make every lapsed session dormant.
      if (sessionDormancyDays != null && (!Number.isInteger(sessionDormancyDays) || sessionDormancyDays < 1)) {
        throw new GraphQLError('sessionDormancyDays must be a positive whole number of days.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      // URN updates: accept a new slug and rebuild the full URN against the
      // app's current org.
      let newUrn: string | undefined;
      if (urn !== undefined) {
        if (!app.organizationId) {
          throw new GraphQLError('Renaming via urn is not supported for user-owned Apps.', { extensions: { code: 'BAD_USER_INPUT' } });
        }
        const org = await ctx.db.organization.findUniqueOrThrow({
          where: { id: app.organizationId }, select: { urn: true },
        });
        const renamedSlug = deriveSlugFromName(urn); // #574: shared slugify
        newUrn = `${org.urn}:${renamedSlug}`;
      }
      // 036-ai-service-config: the legacy aiProvider/aiModel/aiApiKey args
      // maintain the App's 'default' registry config. Explicit null
      // aiProvider clears the whole config (legacy column-null semantics);
      // aiApiKey '' clears just the key.
      if (aiProvider !== undefined || aiModel !== undefined || aiApiKey !== undefined) {
        const existing = await ctx.db.aiServiceConfig.findFirst({
          where: { appId: resolvedId, name: DEFAULT_AI_CONFIG_NAME },
        });
        if (aiProvider === null) {
          if (existing) await ctx.db.aiServiceConfig.delete({ where: { id: existing.id } });
        } else {
          const provider = aiProvider ?? existing?.provider;
          const model = aiModel ?? existing?.model;
          if (!provider || !model) {
            // Clearing/keeping a key on an App with no saved config stays a
            // no-op (legacy column semantics tolerated key-only clears), but
            // any attempt to SET a partial config errors cleanly instead of
            // silently dropping the args (PR #262 review).
            if (aiProvider || aiModel || aiApiKey) {
              throw new GraphQLError(
                'aiProvider and aiModel are both required when configuring AI for an App that has no saved config',
                { extensions: { code: 'AiConfigValidationError' } },
              );
            }
          } else {
            try {
              validateProviderAndParams(provider, null);
            } catch (e) {
              rethrowAiConfigTyped(e);
            }
            // This legacy surface cannot set an endpoint, so an
            // openai-compatible config through it must keep the one it has
            // (same provider) — a provider change clears it below (#1373).
            try {
              const keptEndpoint = existing && existing.provider === provider ? existing.endpoint : null;
              requireEndpointFor(provider, keptEndpoint);
              requireKeyFor({ provider, endpoint: keptEndpoint }, aiApiKey === undefined ? !!existing?.apiKeyEncrypted : !!aiApiKey, 'APP');
            } catch (e) {
              rethrowAiConfigTyped(e);
            }
            const keyFields = apiKeyWriteFields(aiApiKey);
            if (existing) {
              // Re-judged on the LOCKED row (#1380 / #1389 review): a concurrent edit
              // after the read above must not let this write keep a provider
              // whose endpoint or key was cleared in between.
              await ctx.db.$transaction(async (tx) => {
                const cur = await lockAiServiceConfig(tx, existing.id);
                if (!cur) throw new AiServiceConfigNotFoundError(existing.id);
                // Omitted args keep what the row holds NOW, not what the read
                // above saw (#1380 review), and the resulting config is judged
                // again: provider, endpoint, key (#1389 review).
                const lockedProvider = aiProvider ?? cur.provider;
                const lockedModel = aiModel ?? cur.model;
                try {
                  validateProviderAndParams(lockedProvider, null);
                  const keptEndpoint = cur.provider === lockedProvider ? cur.endpoint : null;
                  requireEndpointFor(lockedProvider, keptEndpoint);
                  requireKeyFor({ provider: lockedProvider, endpoint: keptEndpoint }, aiApiKey === undefined ? !!cur.apiKeyEncrypted : !!aiApiKey, 'APP');
                } catch (e) {
                  rethrowAiConfigTyped(e);
                }
                await tx.aiServiceConfig.update({
                  where: { id: cur.id },
                  data: {
                    provider: lockedProvider,
                    model: lockedModel,
                    ...keyFields,
                    // #1380 review: a legacy surface can express neither a style nor
                    // an endpoint, and both were chosen for the OLD provider. Any
                    // provider change clears both, so the new provider starts
                    // from its own defaults and the new key never goes to the
                    // old host.
                    ...(lockedProvider !== cur.provider ? { endpoint: null, apiStyle: null } : {}),
                    updatedBy: ctx.userId ?? null,
                  },
                });
              });
            } else {
              await ctx.db.aiServiceConfig.create({
                data: {
                  appId: resolvedId,
                  name: DEFAULT_AI_CONFIG_NAME,
                  provider,
                  model,
                  ...keyFields,
                  createdBy: ctx.userId ?? null,
                },
              });
            }
          }
        }
      }
      // #1079 — a rename and its alias record commit TOGETHER. Separately, the
      // window between them is exactly the failure the alias map exists to
      // prevent: the old URN has stopped resolving and nothing remembers it.
      //
      // This is the App arm of that fix, and it is the one #1079 was filed for:
      // a worker URN embeds the App slug, so renaming an App silently 404'd
      // every worker URN published in a commit trailer or issue signature. The
      // alias heals them without workerRef changing, because a worker URN is
      // resolved by resolving its App URN first.
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
          SELECT urn FROM apps WHERE id = ${resolvedId} FOR UPDATE
        `;
        if (newUrn !== undefined) {
          await recordUrnRename(tx, {
            entityType: 'APP',
            entityId: resolvedId,
            // The `urn` column already holds the normalized lookup form the
            // resolvers query, so it is recorded verbatim — re-normalizing here
            // would introduce a second normalizer that can disagree with it.
            oldUrn: lockedRow?.urn ?? app.urn,
            newUrn,
            createdBy: ctx.userId ?? ctx.clientId ?? null,
          });
        }
        return tx.app.update({
        where: { id: resolvedId },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(newUrn !== undefined ? { urn: newUrn } : {}),
          ...(appType !== undefined ? { appType } : {}),
          ...(role !== undefined ? { role } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
          ...(agentTools !== undefined ? { agentTools } : {}),
          ...(expiresAt !== undefined ? { expiresAt: expiresAt ? new Date(expiresAt) : null } : {}),
          ...(surfaces !== undefined ? { surfaces } : {}),
          ...(trainingMode !== undefined ? { trainingMode } : {}),
          ...(createUserPermission !== undefined ? { createUserPermission } : {}),
          ...(identifyUserMethod !== undefined ? { identifyUserMethod } : {}),
          ...(sessionTimeoutSeconds !== undefined ? { sessionTimeoutSeconds } : {}),
          ...(sessionDormancyDays != null ? { sessionDormancyDays } : {}),
          ...(agentSessionsExpire != null ? { agentSessionsExpire } : {}),
          ...(anonymousTtlDays !== undefined ? { anonymousTtlDays } : {}),
          ...(policy !== undefined ? { policy: policy as never } : {}),
          updatedBy: ctx.userId ?? null,
        },
        include: APP_INCLUDE,
        });
      });
    },

    deleteApp: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
      // 007-entity-id-or-urn: ref may be ID, bare URN, or prefixed URN.
      const { id: resolvedId } = await resolveAppRef(ctx.db, ref);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedId } });
      await requireOwnerOrOrgRole(ctx, app, 'ADMIN');
      // Soft-delete the App. Secrets are org/user-owned only (#696), so there
      // are no app-owned secrets to sweep here anymore. The deletedAt-null guard
      // keeps the original deletedAt under a concurrent double-delete.
      await withAuthorizedTx(
        ctx,
        [
          { kind: 'app', id: resolvedId },
          ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
          ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
        ],
        async (txCtx) => {
          const current = await txCtx.db.app.findUniqueOrThrow({ where: { id: resolvedId } });
          if (current.organizationId !== app.organizationId || current.ownerUserId !== app.ownerUserId) {
            throw new Error('App ownership changed; retry deletion');
          }
          await requireOwnerOrOrgRole(txCtx, current, 'ADMIN');
        },
        (tx) => tx.app.updateMany({
          where: { id: resolvedId, deletedAt: null },
          data: { deletedAt: new Date() },
        }).then(() => undefined),
        { lockMode: 'exclusive', afterLock: async (tx) => {
          await tx.$queryRaw`SELECT id FROM apps WHERE id = ${resolvedId} FOR UPDATE`;
        } },
      );
      return true;
    },

    installAgentIntoApp: async (
      _: unknown,
      {
        appRef,
        agentRef,
        trainingMode,
      }: { appRef: string; agentRef: string; trainingMode?: boolean },
      ctx: Context,
    ) => {
      const { appAgent } = await installAgentIntoAppCore(ctx, {
        appRef,
        agentRef,
        trainingMode,
      });
      return { appAgent };
    },

    uninstallAgentFromApp: async (
      _: unknown,
      { appRef, agentRef }: { appRef: string; agentRef: string },
      ctx: Context,
    ) => {
      const result = await uninstallAgentFromAppCore(ctx, { appRef, agentRef });
      return { appId: result.appId, agentId: result.agentId };
    },

    // DEPRECATED — pre-023 callers. Delegates to installAgentIntoAppCore
    // and returns the App for source-compat.
    addAgentToApp: async (
      _: unknown,
      {
        appRef,
        agentRef,
        trainingMode,
      }: { appRef: string; agentRef: string; trainingMode?: boolean },
      ctx: Context,
    ) => {
      const { appId: resolvedAppId } = await installAgentIntoAppCore(ctx, {
        appRef,
        agentRef,
        trainingMode,
      });
      return ctx.db.app.findUniqueOrThrow({
        where: { id: resolvedAppId },
        include: APP_INCLUDE,
      });
    },

    // DEPRECATED — pre-023 callers. Delegates to uninstallAgentFromAppCore
    // and returns the App for source-compat.
    removeAgentFromApp: async (
      _: unknown,
      { appRef, agentRef }: { appRef: string; agentRef: string },
      ctx: Context,
    ) => {
      const { appId: resolvedAppId } = await uninstallAgentFromAppCore(ctx, { appRef, agentRef });
      return ctx.db.app.findUniqueOrThrow({
        where: { id: resolvedAppId },
        include: APP_INCLUDE,
      });
    },

    // 008-agent-installation: AppMember management. Per spec FR-004 / FR-016
    // and contracts/agent-app-graphql.md "ensureAppMember".
    ensureAppMember: async (
      _: unknown,
      {
        appRef,
        appId,
        userRef,
        userId,
        role,
      }: {
        appRef?: string | null;
        appId?: string | null;
        userRef?: string | null;
        userId?: string | null;
        role: string;
      },
      ctx: Context,
    ) => {
      // #764: appRef/userRef accept id / URN / (user) handle / email.
      const resolvedAppId = await resolveAppRefArg(ctx.db, { ref: appRef, id: appId });
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });

      // Authorization: ADMIN/OWNER of the App's owning org, the user-owner of a
      // user-owned App, or an existing owner-role AppMember (spec 047 — see
      // callerManagesAppMembers). Holger's ruling on #1718 (team chat #7790,
      // replacing the strict one): an owner-role AppMember has the user-owner's
      // rights, and platform admins manage org Apps. That is safe only because
      // joinApp never self-grants `owner` (#1714).
      if (!(await callerManagesAppMembers(ctx, app, resolvedAppId))) {
        throw new Error('Forbidden: only org admins or App owners can manage members');
      }

      // Target user resolved AFTER the authorization gate above (which keys off
      // ctx.userId), so an unauthorized caller can't use NOT_FOUND to enumerate
      // users.
      const resolvedUserId = await resolveUserRefArg(ctx.db, { ref: userRef, id: userId });
      try {
        await withAuthorizedTx(
          ctx,
          [
            { kind: 'app', id: resolvedAppId }, { kind: 'user', id: resolvedUserId },
            ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
            ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
          ],
          async (txCtx) => {
            const current = await txCtx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });
            if (current.organizationId !== app.organizationId || current.ownerUserId !== app.ownerUserId) {
              throw new Error('App ownership changed; retry member management');
            }
            if (!(await callerManagesAppMembers(txCtx, current, resolvedAppId))) {
              throw new Error('Forbidden: only org admins or App owners can manage members');
            }
          },
          (tx) => ensureAppMember(tx, resolvedAppId, resolvedUserId, role, {
            actorId: ctx.userId ?? null,
          }),
          { afterLock: async (tx) => {
            await tx.$queryRaw`SELECT id FROM apps WHERE id = ${resolvedAppId} FOR SHARE`;
            await tx.$queryRaw`
              SELECT user_id FROM app_members
              WHERE app_id = ${resolvedAppId} AND user_id = ${ctx.userId} FOR SHARE`;
          } },
        );
      } catch (e: unknown) {
        // Surface typed errors with their canonical messages so the portal
        // can render plain-language banners (Constitution Principle III).
        if (
          e instanceof InvalidRoleError ||
          e instanceof MaxMembersExceededError ||
          e instanceof OrphanAppError
        ) {
          throw new GraphQLError((e as Error).message, {
            extensions: { code: (e as Error).name },
          });
        }
        throw e;
      }

      return ctx.db.appMember.findUniqueOrThrow({
        where: { appId_userId: { appId: resolvedAppId, userId: resolvedUserId } },
      });
    },

    // 008-agent-installation: removeAppMember. Idempotent — a missing row
    // returns true (no-op). Personal-class Memory at (appId, userId) is
    // retained as an orphan per FR-015.
    removeAppMember: async (
      _: unknown,
      {
        appRef,
        appId,
        userRef,
        userId,
      }: {
        appRef?: string | null;
        appId?: string | null;
        userRef?: string | null;
        userId?: string | null;
      },
      ctx: Context,
    ) => {
      // #764 + #816 review: appRef/userRef accept id / URN / (user) handle /
      // email. Evaluate the ROLE gate BEFORE resolving the target user, so an
      // unauthorized caller can't turn user resolution into an existence
      // oracle. A role-authorized caller may remove anyone; everyone else may
      // remove ONLY themselves — and a self-only caller's target resolution
      // maps any miss to the same Forbidden, with the resolved id required to
      // be the caller, so an unknown handle/email is indistinguishable from a
      // real user they can't remove.
      const resolvedAppId = await resolveAppRefArg(ctx.db, { ref: appRef, id: appId });
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });
      const forbidRemove = () =>
        new Error('Forbidden: only org admins, App owners, or the user themselves can remove members');

      const authorizedByRole = await callerManagesAppMembers(ctx, app, resolvedAppId);
      let resolvedUserId: string;
      if (authorizedByRole) {
        resolvedUserId = await resolveUserRefArg(ctx.db, { ref: userRef, id: userId });
      } else {
        resolvedUserId = await resolveUserRefArg(ctx.db, { ref: userRef, id: userId }).catch(
          (e: unknown) => {
            if (e instanceof GraphQLError && e.extensions?.code === 'NOT_FOUND') throw forbidRemove();
            throw e;
          },
        );
        if (resolvedUserId !== ctx.userId) throw forbidRemove();
      }

      await withAuthorizedTx(
        ctx,
        [
          { kind: 'app', id: resolvedAppId }, { kind: 'user', id: resolvedUserId },
          ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
          ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
        ],
        async (txCtx) => {
          const current = await txCtx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });
          if (current.organizationId !== app.organizationId || current.ownerUserId !== app.ownerUserId) {
            throw new Error('App ownership changed; retry member management');
          }
          if (!(await callerManagesAppMembers(txCtx, current, resolvedAppId)) && resolvedUserId !== txCtx.userId) {
            throw forbidRemove();
          }
        },
        (tx) => tx.appMember.deleteMany({
          where: { appId: resolvedAppId, userId: resolvedUserId },
        }).then(() => undefined),
        { lockMode: 'exclusive', afterLock: async (tx) => {
          await tx.$queryRaw`SELECT id FROM apps WHERE id = ${resolvedAppId} FOR SHARE`;
          await tx.$queryRaw`
            SELECT user_id FROM app_members
            WHERE app_id = ${resolvedAppId} AND user_id = ${resolvedUserId} FOR UPDATE`;
        } },
      );
      return true;
    },

    // 023-app-shape US2: self-service user-level install. The
    // currently-logged-in user joins the App as an AppMember.
    //
    // **No OrgMember check** (FR-009) — this is the affordance that
    // unlocks B2C / therapy / consumer use cases. Maxmembers + role
    // validation are delegated to `joinApp` → `ensureAppMember`.
    joinApp: async (
      _: unknown,
      { appId }: { appId: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) {
        throw new GraphQLError('joinApp requires an authenticated user', {
          extensions: { code: 'UNAUTHENTICATED' },
        });
      }
      // resolveAppRef rejects soft-deleted Apps; the controller layer
      // additionally rejects via AppNotFoundError (race after
      // resolveAppRef) and AppUninstalledError. All lifecycle checks
      // live in the controller so direct callers get them too. The
      // try/catch covers both resolveAppRef + joinApp because
      // resolveAppRef can throw the typed errors we want to surface.
      let resolvedAppId: string;
      try {
        ({ id: resolvedAppId } = await resolveAppRef(ctx.db, appId));
        // #1573: self-service membership is an authority write. Hold the App
        // and its owner (org or user) shared, alongside the joining user the
        // helper adds, so removeAppMember / deleteApp / uninstall (exclusive on
        // the same anchors) cannot pass a join that is about to commit; the
        // owner tuple is re-checked on the locked row. ensureAppMember's
        // capacity lock (inside the same transaction) serializes joins at the cap.
        const owner = await ctx.db.app.findUniqueOrThrow({
          where: { id: resolvedAppId },
          select: { organizationId: true, ownerUserId: true, deletedAt: true, uninstalledAt: true },
        });
        // Keep the typed lifecycle errors for the ordinary case; only a
        // delete/uninstall racing this join meets the helper's generic denial.
        if (owner.deletedAt) throw new AppNotFoundError(resolvedAppId);
        if (owner.uninstalledAt) throw new AppUninstalledError(resolvedAppId);
        const joiningUserId = ctx.userId;
        await withAuthorizedTx(
          ctx,
          [
            { kind: 'app', id: resolvedAppId },
            ...(owner.organizationId ? [{ kind: 'org' as const, id: owner.organizationId }] : []),
            ...(owner.ownerUserId ? [{ kind: 'user' as const, id: owner.ownerUserId }] : []),
          ],
          async (txCtx) => {
            const current = await txCtx.db.app.findUniqueOrThrow({
              where: { id: resolvedAppId },
              select: { organizationId: true, ownerUserId: true },
            });
            if (current.organizationId !== owner.organizationId || current.ownerUserId !== owner.ownerUserId) {
              throw new Error('App ownership changed; retry the operation');
            }
          },
          (tx) => joinApp(tx, { appId: resolvedAppId, userId: joiningUserId }),
        );
      } catch (e: unknown) {
        // Surface typed errors with their canonical messages (Constitution
        // Principle III — plain-language banner-friendly).
        if (
          e instanceof InvalidRoleError ||
          e instanceof MaxMembersExceededError ||
          e instanceof OrphanAppError ||
          e instanceof SelfJoinNotAllowedError ||
          e instanceof AppNotFoundError ||
          e instanceof AppUninstalledError
        ) {
          throw new GraphQLError((e as Error).message, {
            extensions: { code: (e as Error).name },
          });
        }
        throw e;
      }
      const appMember = await ctx.db.appMember.findUniqueOrThrow({
        where: { appId_userId: { appId: resolvedAppId, userId: ctx.userId } },
      });
      return { appMember };
    },

    // 023-app-shape US2: self-service user-level uninstall. The
    // currently-logged-in user leaves an App. Idempotent.
    leaveApp: async (
      _: unknown,
      { appId }: { appId: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) {
        throw new GraphQLError('leaveApp requires an authenticated user', {
          extensions: { code: 'UNAUTHENTICATED' },
        });
      }
      const { id: resolvedAppId } = await resolveAppRef(ctx.db, appId);
      await leaveApp(ctx.db, { appId: resolvedAppId, userId: ctx.userId });
      return { appId: resolvedAppId, userId: ctx.userId };
    },

    // 023-app-shape US3 — create / upsert a MemoryShare on a
    // personal-class Memory. The caller MUST be the principal
    // (memory.userId) in v1; the Agent-mediated path is deferred.
    createAppKey: async (
      _: unknown,
      { appRef, label }: { appRef: string; label?: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: appRef may be ID, bare URN, or prefixed URN.
      const { id: resolvedAppId } = await resolveAppRef(ctx.db, appRef);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });
      await requireAppKeyManager(ctx, app);
      // Raw key format: hdr_app_<64 hex chars> (256 bits of entropy)
      const rawKey = APP_KEY_PREFIX + randomBytes(32).toString('hex');
      const keyHash = hashAppKey(rawKey);
      const keyPreview = rawKey.slice(0, 12) + '...' + rawKey.slice(-4);
      const appKey = await withAuthorizedTx(
        ctx,
        [{ kind: 'app', id: resolvedAppId }, ...(app.organizationId
          ? [{ kind: 'org' as const, id: app.organizationId }]
          : [{ kind: 'user' as const, id: app.ownerUserId! }])],
        async (txCtx) => {
          const current = await txCtx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });
          if (current.organizationId !== app.organizationId || current.ownerUserId !== app.ownerUserId) {
            throw new Error('App ownership changed; retry key creation');
          }
          await requireAppKeyManager(txCtx, current);
        },
        (tx) => tx.appKey.create({
          data: {
            appId: resolvedAppId,
            keyHash,
            keyPreview,
            label: label ?? null,
            createdBy: ctx.userId ?? null,
          },
        }),
        { afterLock: async (tx) => {
          await lockAppKeyManagerMemberships(tx, ctx, app);
        } },
      );
      return { key: appKey, rawKey };
    },

    revokeAppKey: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const key = await ctx.db.appKey.findUniqueOrThrow({
        where: { id },
        include: { app: true },
      });
      await requireAppKeyManager(ctx, key.app);
      await withAuthorizedTx(
        ctx,
        [
          { kind: 'app', id: key.app.id },
          ...(key.app.organizationId ? [{ kind: 'org' as const, id: key.app.organizationId }] : []),
          ...(key.app.ownerUserId ? [{ kind: 'user' as const, id: key.app.ownerUserId }] : []),
        ],
        async (txCtx) => {
          const current = await txCtx.db.app.findUniqueOrThrow({ where: { id: key.app.id } });
          if (current.organizationId !== key.app.organizationId || current.ownerUserId !== key.app.ownerUserId) {
            throw new Error('App ownership changed; retry key revocation');
          }
          await requireAppKeyManager(txCtx, current);
        },
        (tx) => tx.appKey.update({ where: { id }, data: { revokedAt: new Date() } }),
        { lockMode: 'exclusive', afterLock: (tx) => lockAppKeyManagerMemberships(tx, ctx, key.app) },
      );
      return true;
    },

    // 025-oauth-for-mcp FR-004: mint a user-scoped API key. Self-service
    // only — AppKey-resolved callers (no user in context) MUST be
    // rejected. The raw key is returned exactly once; only the hash is
    // persisted. `createdBy` is the actor's User.id (REV-2 reversal —
    // matches the schema-wide audit-actor convention); `issuedVia` is
    // the issuance identity (portal under sign-in, or inherited from the
    // authenticated minting credential, including oauth:<client_id>).
    createUserApiKey: async (
      _: unknown,
      { label }: { label?: string | null },
      ctx: Context,
    ) => {
      if (!ctx.userId) {
        throw new GraphQLError(
          'createUserApiKey requires a user-scoped credential; AppKey callers cannot mint user keys.',
          { extensions: { code: 'UNAUTHENTICATED' } },
        );
      }
      const surfaceRefusal = oauthSurfaceRefusal(ctx, 'account');
      if (surfaceRefusal) {
        throw new GraphQLError(
          oauthSurfaceRefusalMessage(surfaceRefusal, 'This OAuth credential is limited to the MCP surface and cannot create API keys.'),
          { extensions: { code: 'FORBIDDEN', ...surfaceRefusal } },
        );
      }
      // Cap label length to prevent unbounded TEXT writes. The Prisma
      // column is uncapped; 200 chars is plenty for a human-readable
      // display name (e.g., "MacBook Air — Claude Desktop").
      if (label != null && label.length > USER_API_KEY_LABEL_MAX_LEN) {
        throw new GraphQLError(
          `Label exceeds ${USER_API_KEY_LABEL_MAX_LEN}-character limit.`,
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }
      // Single insert path shared with the OAuth /token endpoint
      // (FR-015) — both call mintUserApiKey so the prefix, entropy,
      // hashing primitive, and persisted-field shape never drift.
      const { rawKey, userApiKey } = await withAuthorizedTx(
        ctx,
        [{ kind: 'user', id: ctx.userId }],
        async (txCtx) => {
          if (txCtx.userId !== ctx.userId || txCtx.impersonation) {
            throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
          }
        },
        async (tx, txCtx) => {
          // Use the live credential under the user authority anchor, never
          // clientId (the user's identity) or a caller-supplied parent ref.
          const parent = txCtx.apiKeyId ? await tx.userApiKey.findFirst({
            where: { id: txCtx.apiKeyId, userId: txCtx.userId, revokedAt: null },
          }) : null;
          if (txCtx.apiKeyId && !parent) {
            throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
          }
          // Recheck the persisted immutable scope rather than trusting an
          // earlier request/transport projection at this mint boundary.
          const persistedRefusal = parent ? oauthSurfaceRefusal(parent, 'account') : null;
          if (persistedRefusal) {
            throw new GraphQLError('This credential cannot create API keys.', {
              extensions: { code: 'FORBIDDEN', ...persistedRefusal },
            });
          }
          return mintUserApiKeyInTx(tx, {
            userId: txCtx.userId!,
            label: label ?? null,
            createdBy: txCtx.userId!,
            issuedVia: parent ? parent.issuedVia : 'portal',
            mintedByKeyId: parent?.id,
            originSignInId: parent ? undefined : txCtx.signInId ?? null,
          });
        },
      );
      return { userApiKey, rawKey };
    },

    // 025-oauth-for-mcp FR-004: revoke a user-scoped API key. Returns
    // the updated row (D3 — was Boolean! in PR 137). Idempotent on
    // already-revoked keys.
    //
    // **Atomic + no-info-leak design** (PR #145 review):
    // - The exclusive user anchor serializes mints and revocations; the
    //   conditional subtree UPDATE preserves each existing revokedAt.
    // - Scoping the subsequent read to `{ id, userId }` collapses the
    //   cross-user case to NOT_FOUND, closing the id-enumeration
    //   channel that a separate FORBIDDEN branch would have opened
    //   (an attacker with a guess at someone else's key id would
    //   otherwise learn that the id exists).
    revokeUserApiKey: async (
      _: unknown,
      { id }: { id: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) {
        throw new GraphQLError(
          'revokeUserApiKey requires a user-scoped credential; AppKey callers cannot revoke user keys.',
          { extensions: { code: 'UNAUTHENTICATED' } },
        );
      }
      // Revoke the owned key and every recorded descendant atomically.
      // Unknown legacy ancestry remains unknown; no prefix/provenance guess.
      const row = await withAuthorizedTx(
        ctx,
        [{ kind: 'user', id: ctx.userId }],
        async (txCtx) => {
          if (txCtx.userId !== ctx.userId || txCtx.impersonation) {
            throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
          }
        },
        async (tx) => {
          // The exclusive user anchor serializes the complete traversal
          // with every mint. A mint that wins is in this subtree; one that
          // waits rechecks its now-revoked credential before inserting.
          // UNION (rather than UNION ALL) also terminates on corrupt cycles.
          await tx.$executeRaw`
            WITH RECURSIVE subtree AS (
              SELECT id FROM user_api_keys WHERE id = ${id} AND user_id = ${ctx.userId}
              UNION
              SELECT child.id FROM user_api_keys child
              JOIN subtree parent ON child.minted_by_key_id = parent.id
              WHERE child.user_id = ${ctx.userId}
            )
            UPDATE user_api_keys SET revoked_at = CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
            WHERE id IN (SELECT id FROM subtree) AND revoked_at IS NULL`;
          return tx.userApiKey.findFirst({ where: { id, userId: ctx.userId } });
        },
        { lockMode: 'exclusive' },
      );
      // Read back via findFirst scoped to `{ id, userId }`. If the row
      // is missing, the id is either unknown OR belongs to a different
      // user — collapse both to NOT_FOUND. If present, return it
      // unchanged when already revoked; descendants are still traversed.
      if (!row) {
        throw new GraphQLError(`UserApiKey ${id} not found.`, {
          extensions: { code: 'NOT_FOUND' },
        });
      }
      return row;
    },

    // 005-agent-subscription FR-023 + FR-028 + FR-029: revoke a user's
    // AgentSubscription. ADMIN/OWNER of the Agent's owning org only.
    // Side effect: if the user's personal Memory of the Agent has zero
    // nodes, hard-delete it alongside the revocation (FR-029); otherwise
    // retain it (FR-028).
};
