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
  validateProviderAndParams,
} from '../../../lib/aiConfig.js';
import {
  APP_KEY_PREFIX,
  USER_API_KEY_LABEL_MAX_LEN,
  hashAppKey,
  mintUserApiKey,
} from '../../../middleware/auth.js';
import { ensureAgentOrgGrant } from '../../../controller/operations/ensureAgentOrgGrant.js';
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
  rethrowAiConfigTyped,
  APP_INCLUDE,
  installAgentIntoAppCore,
  uninstallAgentFromAppCore,
} from './resolvers.helpers.js';

export const appMutations = {
    regenerateAppKey: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      // 007-entity-id-or-urn: id may be ID, bare URN, or prefixed URN.
      const { id: resolvedId } = await resolveAppRef(ctx.db, id);
      const existing = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedId } });
      const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
      if (!isPlatformAdmin) await requireOrgRole(ctx, existing.organizationId, 'ADMIN');

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
        orgId,
        agentId,
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
        orgId: string;
        agentId: string;
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
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      // URN format matches memories and agents: "{org.urn}:{slug}".
      // If the caller provides an explicit slug use it; otherwise derive from
      // the name (lowercase, non-alphanum → hyphens, trimmed).
      const org = await ctx.db.organization.findUniqueOrThrow({
        where: { id: resolvedOrgId }, select: { urn: true },
      });
      // #574: shared slugify (was an inline copy of this same transform).
      const appUrn = `${org.urn}:${deriveSlugFromName(urn ?? name)}`;

      // 009-install-agent-flow: agentId is required (typeDef gate). Resolve
      // the Agent (resolveAgentRef rejects soft-deleted Agents with
      // AgentNotFoundError). Per 009 spec FR-009, the cross-org install
      // restriction is enforced at the *portal* layer (the Install affordance
      // is hidden for non-owned Agents), not at the server. Server-side
      // auto-provisioning of AgentOrgGrant is retained from 008 to preserve
      // the existing 008 test surface and the future marketplace path —
      // tightening to a hard server gate is reserved for the marketplace spec.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      await ensureAgentOrgGrant(ctx.db, resolvedOrgId, resolvedAgentId);

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

      // 036-ai-service-config: the legacy aiProvider/aiModel/aiApiKey args
      // become the App's 'default' registry config (deploy-time override
      // that wins over the Agent's default in the resolution walk).
      if (aiProvider && aiModel) {
        try {
          validateProviderAndParams(aiProvider, null);
        } catch (e) {
          rethrowAiConfigTyped(e);
        }
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
      {
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
              await ctx.db.app.delete({ where: { id: depCollision.id } });
            } else {
              depUrn = `${depUrn}:${imp.importedAgentId.slice(-8)}`;
            }
          }

          await ctx.db.app.create({
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
        id,
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
        id: string; name?: string; urn?: string;
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
      // 007-entity-id-or-urn: id may be ID, bare URN, or prefixed URN.
      const { id: resolvedId } = await resolveAppRef(ctx.db, id);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedId } });
      await requireOrgRole(ctx, app.organizationId, 'ADMIN');
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
        const org = await ctx.db.organization.findUniqueOrThrow({
          where: { id: app.organizationId }, select: { urn: true },
        });
        newUrn = `${org.urn}:${deriveSlugFromName(urn)}`; // #574: shared slugify
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
            const keyFields = apiKeyWriteFields(aiApiKey);
            if (existing) {
              await ctx.db.aiServiceConfig.update({
                where: { id: existing.id },
                data: { provider, model, ...keyFields, updatedBy: ctx.userId ?? null },
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
      return ctx.db.app.update({
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
    },

    deleteApp: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      // 007-entity-id-or-urn: id may be ID, bare URN, or prefixed URN.
      const { id: resolvedId } = await resolveAppRef(ctx.db, id);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedId } });
      await requireOrgRole(ctx, app.organizationId, 'ADMIN');
      await ctx.db.app.update({ where: { id: resolvedId }, data: { deletedAt: new Date() } });
      return true;
    },

    installAgentIntoApp: async (
      _: unknown,
      {
        appId,
        agentId,
        trainingMode,
      }: { appId: string; agentId: string; trainingMode?: boolean },
      ctx: Context,
    ) => {
      const { appAgent } = await installAgentIntoAppCore(ctx, {
        appId,
        agentId,
        trainingMode,
      });
      return { appAgent };
    },

    uninstallAgentFromApp: async (
      _: unknown,
      { appId, agentId }: { appId: string; agentId: string },
      ctx: Context,
    ) => {
      const result = await uninstallAgentFromAppCore(ctx, { appId, agentId });
      return { appId: result.appId, agentId: result.agentId };
    },

    // DEPRECATED — pre-023 callers. Delegates to installAgentIntoAppCore
    // and returns the App for source-compat.
    addAgentToApp: async (
      _: unknown,
      {
        appId,
        agentId,
        trainingMode,
      }: { appId: string; agentId: string; trainingMode?: boolean },
      ctx: Context,
    ) => {
      const { appId: resolvedAppId } = await installAgentIntoAppCore(ctx, {
        appId,
        agentId,
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
      { appId, agentId }: { appId: string; agentId: string },
      ctx: Context,
    ) => {
      const { appId: resolvedAppId } = await uninstallAgentFromAppCore(ctx, { appId, agentId });
      return ctx.db.app.findUniqueOrThrow({
        where: { id: resolvedAppId },
        include: APP_INCLUDE,
      });
    },

    // 008-agent-installation: AppMember management. Per spec FR-004 / FR-016
    // and contracts/agent-app-graphql.md "ensureAppMember".
    ensureAppMember: async (
      _: unknown,
      { appId, userId, role }: { appId: string; userId: string; role: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: appId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAppId } = await resolveAppRef(ctx.db, appId);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });

      // Authorization: ADMIN/OWNER of the App's owning org, OR an existing
      // owner-role AppMember. Self-service joins are not allowed in v1.
      const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
      if (!isPlatformAdmin) {
        const orgMember = await ctx.db.orgMember.findFirst({
          where: {
            organizationId: app.organizationId,
            userId: ctx.userId ?? '',
            deletedAt: null,
            role: { in: ['ADMIN', 'OWNER'] },
          },
        });
        if (!orgMember) {
          const ownerMember = ctx.userId
            ? await ctx.db.appMember.findUnique({
                where: { appId_userId: { appId: resolvedAppId, userId: ctx.userId } },
              })
            : null;
          if (!ownerMember || ownerMember.role !== 'owner') {
            throw new Error('Forbidden: only org admins or App owners can manage members');
          }
        }
      }

      try {
        await ensureAppMember(ctx.db, resolvedAppId, userId, role, {
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
        where: { appId_userId: { appId: resolvedAppId, userId } },
      });
    },

    // 008-agent-installation: removeAppMember. Idempotent — a missing row
    // returns true (no-op). Personal-class Memory at (appId, userId) is
    // retained as an orphan per FR-015.
    removeAppMember: async (
      _: unknown,
      { appId, userId }: { appId: string; userId: string },
      ctx: Context,
    ) => {
      const { id: resolvedAppId } = await resolveAppRef(ctx.db, appId);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });

      // Authorization: same gate as ensureAppMember, plus self-removal —
      // a member can remove themselves at any time without org/owner role.
      const isSelfRemoval = ctx.userId === userId;
      if (!isSelfRemoval) {
        const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
        if (!isPlatformAdmin) {
          const orgMember = await ctx.db.orgMember.findFirst({
            where: {
              organizationId: app.organizationId,
              userId: ctx.userId ?? '',
              deletedAt: null,
              role: { in: ['ADMIN', 'OWNER'] },
            },
          });
          if (!orgMember) {
            const ownerMember = ctx.userId
              ? await ctx.db.appMember.findUnique({
                  where: { appId_userId: { appId: resolvedAppId, userId: ctx.userId } },
                })
              : null;
            if (!ownerMember || ownerMember.role !== 'owner') {
              throw new Error('Forbidden: only org admins, App owners, or the user themselves can remove members');
            }
          }
        }
      }

      await ctx.db.appMember
        .delete({ where: { appId_userId: { appId: resolvedAppId, userId } } })
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
      { appId, label }: { appId: string; label?: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: appId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAppId } = await resolveAppRef(ctx.db, appId);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });
      await requireOrgRole(ctx, app.organizationId, 'ADMIN');
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
      await requireOrgRole(ctx, key.app.organizationId, 'ADMIN');
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

