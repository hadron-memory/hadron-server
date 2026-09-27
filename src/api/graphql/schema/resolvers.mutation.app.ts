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
  mintUserApiKey,
} from '../../../middleware/auth.js';
import { ensureAgentOrgGrant } from '../../../controller/operations/ensureAgentOrgGrant.js';
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
  NoMemberRolesError,
  AppUninstalledError,
} from '../../../controller/operations/joinApp.js';
import { AppNotFoundError } from '../../../lib/entityRef/errors.js';
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
} from './resolvers.helpers.js';
import { findOrCreateAppClassMemory } from './chat-scope.js';
// Spec 049 Phase 4 — the App's default Channel, created with the App.
import { ensureDefaultChannelForApp } from '../../../lib/channels.js';
import { recordUrnRename } from '../../../lib/urnAlias.js';
import { requireEndpointFor, requireKeyFor } from '../../../lib/aiEndpoint.js';

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
 * Can the caller manage this App's members by ROLE alone — independent of any
 * target user? Platform ADMIN/OWNER for an ORG-owned App, the user-owner of a
 * user-owned App, an org ADMIN/OWNER of the App's org, or an owner-role
 * AppMember. spec 047 (blocker 3): the platform-admin bypass applies ONLY to an
 * org-owned App (a user-owned App is strictly owner-only). Shared by
 * ensureAppMember + removeAppMember so the role gate is evaluated BEFORE the
 * target user is resolved — a non-authorized caller can't turn user-ref
 * resolution into an existence oracle (#816 review).
 */
async function callerManagesAppMembers(
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
        deletedAt: null,
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
      // spec 047 (blocker 3): route unconditionally through the shared gate. It
      // grants a platform admin on an ORG-owned App (its own admin branch) but
      // enforces OWNER-ONLY on a user-owned App — the old `if (!isPlatformAdmin)`
      // skip bypassed that owner-only rule.
      await requireOwnerOrOrgRole(ctx, existing, 'ADMIN');

      // Revoke all active keys, then create a fresh one.
      await ctx.db.appKey.updateMany({
        where: { appId: resolvedId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const rawKey = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
      const keyHash = createHash('sha256').update(rawKey).digest('hex');
      await ctx.db.appKey.create({
        data: {
          id: generateId(),
          appId: resolvedId,
          keyHash,
          keyPreview: rawKey.slice(-4),
          label: 'Regenerated key',
          createdBy: ctx.userId ?? ctx.appId ?? ctx.clientId ?? null,
        },
      });
      const fresh = await ctx.db.app.findUniqueOrThrow({
        where: { id: resolvedId },
        include: APP_INCLUDE,
      });
      return { app: fresh, rawKey };
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
      if (resolvedOrgId) {
        // Org path: auto-provision the AgentOrgGrant (008 behavior; portal hides
        // the cross-org Install affordance — a hard server gate is the
        // marketplace spec's job).
        await ensureAgentOrgGrant(ctx.db, resolvedOrgId, resolvedAgentId);
      } else {
        // spec 047 personal path: no org ⇒ no AgentOrgGrant. The install is
        // licensed by the OWNER's AgentSubscription instead. A user may install
        // ONLY a PUBLIC (marketplace) agent or their OWN user-owned agent into a
        // personal App — never another tenant's private agent (which would fold
        // that tenant's memories into this App). Mirror installAgentIntoAppCore's
        // accessibility gate for the org-less case.
        const installAgent = await ctx.db.agent.findUniqueOrThrow({
          where: { id: resolvedAgentId },
          select: { visibility: true, ownerUserId: true },
        });
        const isOwnAgent = installAgent.ownerUserId !== null && installAgent.ownerUserId === ctx.userId;
        if (installAgent.visibility !== 'PUBLIC' && !isOwnAgent) {
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
        if (!isOwnAgent) await ensureAgentSubscription(ctx.db, ctx.userId!, resolvedAgentId);
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
          await ctx.db.app.delete({ where: { id: existing.id } });
        } else {
          throw new Error(`An app with URN "${appUrn}" already exists`);
        }
      }
      // 023-app-shape Phase 2b: App↔Agent moved from `App.agentId` to the
      // N:M `AppAgent` join. Create the App, then immediately link the
      // requested Agent via an AppAgent row.
      const createdApp = await ctx.db.app.create({
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
        const imports = await ctx.db.agentImport.findMany({
          where: { parentAgentId: resolvedAgentId },
          orderBy: { position: 'asc' },
        });

        // Resolve `installOptional` URNs/ids to canonical ids so callers
        // can pass either form.
        const optionalIds = new Set<string>();
        if (installOptional && installOptional.length > 0) {
          for (const ref of installOptional) {
            const { id } = await resolveAgentRef(ctx.db, ref);
            optionalIds.add(id);
          }
        }

        for (const imp of imports) {
          const shouldInstall = imp.required || optionalIds.has(imp.importedAgentId);
          if (!shouldInstall) continue;

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

          // Auto-provision the AgentOrgGrant for the dep too — every App we
          // create is gated on having an active grant.
          await ensureAgentOrgGrant(ctx.db, resolvedOrgId, imp.importedAgentId);

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
              await ctx.db.app.delete({ where: { id: depCollision.id } });
            } else {
              depUrn = `${depUrn}:${imp.importedAgentId.slice(-8)}`;
            }
          }

          const depApp = await ctx.db.app.create({
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
          // #951: a cascaded dependency App is an App like any other — it gets
          // its shared memory at install time too, not on first chat.
          await provisionAppSharedMemory(ctx, depApp, imp.importedAgentId);
        }
      }

      // 009-install-agent-flow T015: the installer is auto-added as an
      // AppMember with role 'owner' when the Agent's installationPolicy
      // permits it. Routed through ensureAppMember so the memberRoles +
      // maxMembers invariants from 008 R-7 are honored (a raw upsert would
      // bypass them — see hadron-server#98 review).
      //
      // Some Agents customize `memberRoles` without 'owner' (e.g.,
      // ['principal', 'guide']); in that case the install still succeeds
      // but no auto-membership is granted — the installer can add
      // themselves explicitly via ensureAppMember with a role from the
      // policy. ctx.userId may be absent for a platform-admin caller —
      // requireOrgRole short-circuits on ADMIN/OWNER before its userId
      // check — and there's no user to grant owner membership to in that
      // case, so guard on it rather than asserting.
      const installerAgent = await ctx.db.agent.findUniqueOrThrow({
        where: { id: resolvedAgentId },
        select: { installationPolicy: true },
      });
      const allowedRoles = (installerAgent.installationPolicy as { memberRoles?: string[] })
        ?.memberRoles ?? ['owner'];
      if (allowedRoles.includes('owner') && ctx.userId) {
        await ensureAppMember(ctx.db, createdApp.id, ctx.userId, 'owner', {
          actorId: ctx.userId,
        });
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
      await ctx.db.app.updateMany({
        where: { id: resolvedId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
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
      // callerManagesAppMembers). Self-service joins are not allowed in v1.
      if (!(await callerManagesAppMembers(ctx, app, resolvedAppId))) {
        throw new Error('Forbidden: only org admins or App owners can manage members');
      }

      // Target user resolved AFTER the authorization gate above (which keys off
      // ctx.userId), so an unauthorized caller can't use NOT_FOUND to enumerate
      // users.
      const resolvedUserId = await resolveUserRefArg(ctx.db, { ref: userRef, id: userId });
      try {
        await ensureAppMember(ctx.db, resolvedAppId, resolvedUserId, role, {
          actorId: ctx.userId ?? null,
        });
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

      await ctx.db.appMember
        .delete({ where: { appId_userId: { appId: resolvedAppId, userId: resolvedUserId } } })
        .catch(() => {}); // idempotent: missing row → no-op
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
        await joinApp(ctx.db, { appId: resolvedAppId, userId: ctx.userId });
      } catch (e: unknown) {
        // Surface typed errors with their canonical messages (Constitution
        // Principle III — plain-language banner-friendly).
        if (
          e instanceof InvalidRoleError ||
          e instanceof MaxMembersExceededError ||
          e instanceof OrphanAppError ||
          e instanceof NoMemberRolesError ||
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
      await requireOwnerOrOrgRole(ctx, app, 'ADMIN');
      // Raw key format: hdr_app_<64 hex chars> (256 bits of entropy)
      const rawKey = APP_KEY_PREFIX + randomBytes(32).toString('hex');
      const keyHash = hashAppKey(rawKey);
      const keyPreview = rawKey.slice(0, 12) + '...' + rawKey.slice(-4);
      const appKey = await ctx.db.appKey.create({
        data: {
          appId: resolvedAppId,
          keyHash,
          keyPreview,
          label: label ?? null,
          createdBy: ctx.userId ?? null,
        },
      });
      return { key: appKey, rawKey };
    },

    revokeAppKey: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const key = await ctx.db.appKey.findUniqueOrThrow({
        where: { id },
        include: { app: true },
      });
      await requireOwnerOrOrgRole(ctx, key.app, 'ADMIN');
      await ctx.db.appKey.update({ where: { id }, data: { revokedAt: new Date() } });
      return true;
    },

    // 025-oauth-for-mcp FR-004: mint a user-scoped API key. Self-service
    // only — AppKey-resolved callers (no user in context) MUST be
    // rejected. The raw key is returned exactly once; only the hash is
    // persisted. `createdBy` is the actor's User.id (REV-2 reversal —
    // matches the schema-wide audit-actor convention); `issuedVia` is
    // the path discriminator (REV-2 — `'portal'` here, `'oauth:<id>'`
    // for /oauth/token-issued tokens in Phase 2).
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
      const { rawKey, userApiKey } = await mintUserApiKey(ctx.db, {
        userId: ctx.userId,
        label: label ?? null,
        createdBy: ctx.userId,
        issuedVia: 'portal',
      });
      return { userApiKey, rawKey };
    },

    // 025-oauth-for-mcp FR-004: revoke a user-scoped API key. Returns
    // the updated row (D3 — was Boolean! in PR 137). Idempotent on
    // already-revoked keys.
    //
    // **Atomic + no-info-leak design** (PR #145 review):
    // - The updateMany-with-conditional pattern (`where: { id, userId,
    //   revokedAt: null }`) makes the write race-safe: under concurrent
    //   calls, only one wins the revokedAt timestamp; the loser's
    //   updateMany returns count=0 and no overwrite happens.
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
      // Atomic conditional revoke: only flips revokedAt on rows that
      // (a) match the id, (b) are owned by the caller, AND
      // (c) are not already revoked. Returns count=0 for any
      // non-matching row, which we disambiguate below.
      await ctx.db.userApiKey.updateMany({
        where: { id, userId: ctx.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      // Read back via findFirst scoped to `{ id, userId }`. If the row
      // is missing, the id is either unknown OR belongs to a different
      // user — collapse both to NOT_FOUND. If present, return it
      // unchanged (idempotent path: revokedAt was already set, so
      // updateMany did nothing).
      const row = await ctx.db.userApiKey.findFirst({
        where: { id, userId: ctx.userId },
      });
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
