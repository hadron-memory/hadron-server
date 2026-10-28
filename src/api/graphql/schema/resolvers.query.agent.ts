// agentQueries — extracted from resolvers.ts Query (split step 3). No behavior change.
import { GraphQLError } from 'graphql';
import { decryptToken } from '../../../lib/tokenCrypto.js';
import { AI_PROVIDER_ENDPOINTS, effectiveApiStyle, effectiveEndpoint } from '../../../lib/aiEndpoint.js';
import {
  NoAiConfigAvailableError,
  DEFAULT_AI_CONFIG_NAME,
  resolveAiConfigWithFallback,
  resolveAiConfigs,
  type AiConfigOwnerType,
} from '../../../lib/aiConfig.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { AgentNotFoundError } from '../../../lib/entityRef/errors.js';
import { listAgentProcesses, listAgentTasks, reverifyServed, type ListedNode } from '../../../lib/agentDefinitionLists.js';
import { decryptNodesBatch } from '../../../lib/nodeCrypto.js';
import { isAgentInstalled } from '../../../lib/appAgent.js';
import {
  type Context,
  aiConfigOwnerOf,
  clampListTake,
  requireOrgRole,
  requireAgentAccess,
  resolveReadableAgentRef,
  requireReadableAgent,
  requireOwnerOrOrgRole,
  resolveOrgScope,
  isPlatformAdmin,
  toGqlAiServiceConfig,
  toGqlAiServiceConfigForPicker,
  requireAiConfigOwnerAdmin,
  requireAiConfigPickerAccess,
  rethrowAiConfigTyped,
  AGENT_INCLUDE,
} from './resolvers.helpers.js';
import { forbiddenError, unauthenticatedError } from '../../../lib/refusals.js';

/**
 * #1892 — the full Node rows behind a list's entries, in list order, each
 * stamped `inheritedFrom` where the list marked it, so the inherited-node
 * projection (resolvers.inheritedNode.ts) applies to every Node field. The
 * rows are re-read here, so what is served is re-authorized on the version
 * read (`reverifyServed`, Anne's P2-1 on #1896): an entry deleted, moved,
 * overridden, turned boot prompt or made unreadable since the list was built
 * is dropped rather than served.
 */
async function listedEntries<E extends { node: ListedNode }>(ctx: Context, agentId: string, entries: E[]) {
  if (entries.length === 0) return [];
  const { systemMemoryId } = await ctx.db.agent.findUniqueOrThrow({ where: { id: agentId }, select: { systemMemoryId: true } });
  const rows = await ctx.db.node.findMany({ where: { id: { in: entries.map((e) => e.node.id) } } });
  const ok = systemMemoryId ? await reverifyServed(ctx.db, ctx, systemMemoryId, entries.map((e) => e.node), rows) : new Set<string>();
  const served = rows.filter((r) => ok.has(r.id));
  await decryptNodesBatch(ctx.db, served);
  const byId = new Map(served.map((r) => [r.id, r]));
  return entries.flatMap((e) => {
    const row = byId.get(e.node.id);
    if (!row) return [];
    return [{ ...e, node: e.node.inheritedFrom ? Object.assign(row, { inheritedFrom: e.node.inheritedFrom }) : row }];
  });
}

export const agentQueries = {
    /**
     * #1892 (cor:dmo:050:15) — an Agent's tasks across its base chain: every
     * runnable node of its effective system memory and every task a chain
     * index lists, each once, with the listing edge's trigger where one exists.
     * hadron_agent_tasks returns the same list (src/lib/agentDefinitionLists.ts).
     */
    agentTaskList: async (_: unknown, { ref, symptom, limit }: { ref: string; symptom?: string | null; limit?: number | null }, ctx: Context) => {
      const { id } = await resolveAgentRef(ctx.db, ref);
      return listedEntries(ctx, id, await listAgentTasks(ctx.db, ctx, id, ref, { symptom, limit }));
    },

    /**
     * #1892 (cor:dmo:050:16) — an Agent's processes: those it starts or owns
     * (its processes index, with triggers), then those it's involved in
     * (derived from stage edges into its tasks). hadron_agent_processes
     * returns the same list.
     */
    agentProcessList: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
      const { id } = await resolveAgentRef(ctx.db, ref);
      return listedEntries(ctx, id, await listAgentProcesses(ctx.db, ctx, id, ref));
    },

    // #473 — the uniform single-agent read; the first top-level Agent query
    // (previously reachable only via Organization.agents / App.agents
    // nesting). Gate mirrors resolveUrn's agent branch: a PUBLIC agent
    // resolves for any caller (#551 — marketplace discovery / share links),
    // otherwise member of the Agent's org or platform ADMIN/OWNER. A PUBLIC
    // agent publishes its OWN definition (systemPrompt / memoryItems /
    // imports); the fields that surface OTHER tenants (apps / appAgents /
    // appCount / orgGrants / importedBy) are scoped to the caller's own access
    // and come back empty for an outsider (#552, #757).
    agent: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
      try {
        const { id } = await resolveAgentRef(ctx.db, ref);
        // ONE read, with the includes it serves, and the gate runs on THAT row
        // (Atilla's P2 on #1950: gating an earlier read and serving a later one
        // let a PUBLIC→ORGANIZATION flip between them reach a foreign reader).
        const agent = await ctx.db.agent.findUnique({ where: { id }, include: AGENT_INCLUDE });
        // #551: PUBLIC visibility widens the READ gate to everyone (mirrors the
        // memories PUBLIC carve-out, #362); non-public needs READER. #1944: the
        // shared read gate answers a denied Agent exactly like an absent one,
        // so both come back null here, never FORBIDDEN.
        await requireReadableAgent(ctx, agent, ref);
        return agent;
      } catch (e) {
        // Genuine miss (AgentNotFoundError) → null. A malformed /
        // under-qualified URN throws UrnNotQualifiedError from
        // resolveAgentRef's assertFullyQualifiedUrn and propagates — input
        // errors surface, only not-found is masked to null.
        if (!(e instanceof AgentNotFoundError)) throw e;
        return null;
      }
    },

    // #551 — the public-agent marketplace slice: ALL live PUBLIC agents,
    // readable by ANY caller (member or not, authenticated or not), so an org
    // can discover foreign public agents to subscribe to (008/009
    // AgentOrgGrant; hadron-portal#486). Deliberately a SEPARATE query from the
    // member-scoped agents() list so the cross-org widening is an explicit,
    // bounded surface — never a side effect of a filter value on the default
    // list (contrast memories(filter: { visibility: PUBLIC })). Field-level
    // exposure is slim for non-members (Agent.systemPrompt / systemMemoryId /
    // memoryItems / imports gates). filter.type narrows; filter.visibility is
    // ignored (the slice is PUBLIC by definition).
    publicAgents: async (
      _: unknown,
      {
        filter,
        limit,
        offset,
      }: {
        filter?: { type?: string | null } | null;
        limit?: number | null;
        offset?: number | null;
      },
      ctx: Context,
    ) => {
      const take = clampListTake(limit);
      const skip = Math.max(0, offset ?? 0);
      const f = filter ?? {};
      const where = {
        visibility: 'PUBLIC' as never,
        deletedAt: null,
        ...(f.type ? { type: f.type as never } : {}),
      };
      const [total, items] = await Promise.all([
        ctx.db.agent.count({ where }),
        take === 0
          ? Promise.resolve([])
          : ctx.db.agent.findMany({
              where,
              include: AGENT_INCLUDE,
              orderBy: [{ name: 'asc' }, { id: 'asc' }],
              skip,
              take,
            }),
      ]);
      return { items, total };
    },

    // #473 — the uniform paginated agent list. Scope: Agents owned by the
    // caller's member orgs; platform ADMIN/OWNER unscoped get every live
    // Agent. orgId follows cor:api:100:01 (member -> scope, non-member ->
    // empty page, no disclosure, no admin bypass).
    agents: async (
      _: unknown,
      {
        filter,
        orgId,
        limit,
        offset,
      }: {
        filter?: {
          type?: string | null;
          visibility?: string | null;
          ownedByMe?: boolean | null;
        } | null;
        orgId?: string | null;
        limit?: number | null;
        offset?: number | null;
      },
      ctx: Context,
    ) => {
      const take = clampListTake(limit);
      const skip = Math.max(0, offset ?? 0);
      const f = filter ?? {};
      const filters = {
        deletedAt: null,
        ...(f.type ? { type: f.type as never } : {}),
        ...(f.visibility ? { visibility: f.visibility as never } : {}),
      };
      let where: Record<string, unknown>;
      if (f.ownedByMe) {
        // #782 — the caller's OWN user-owned (org-less) agents only, for ALL
        // callers INCLUDING platform ADMIN/OWNER: owner scope is never an
        // admin-bypass surface (mirrors the owner-only personal/private
        // memories slice). Org-less by definition, so orgId is not consulted;
        // App-key callers (no ctx.userId) get an empty page.
        // #876: user-owned agents are identity-scoped, so an impersonated
        // session sees none — matching callerReadableAgentFilter, which drops
        // its ownerUserId clause the same way. Without this the list returned
        // the target's private agents (definitions AND systemPrompt) while
        // Query.agent(ref:) correctly refused them via requireOwnerOrOrgRole.
        if (!ctx.userId || ctx.impersonation) return { items: [], total: 0 };
        where = { ...filters, organizationId: null, ownerUserId: ctx.userId };
      } else {
        const scope = await resolveOrgScope(ctx, orgId);
        if (!scope) return { items: [], total: 0 };
        const scopedToOrg = scope.scopedOrgId != null;
        // Admin unscoped reach applies only WITHOUT an orgId — the active-org
        // selection is a membership concept (cor:api:100:01).
        if (isPlatformAdmin(ctx) && !scopedToOrg) {
          // Every live agent EXCEPT another user's user-owned agent — spec 047
          // strict ownership: a user-owned (org NULL, ownerUserId set) agent is
          // owner-only, so even a platform admin doesn't see someone else's in
          // the list (their OWN still show). "org-owned OR mine" as a flat OR is
          // clearer + more index-friendly than a nested NOT/AND (gemini review,
          // #682).
          where = {
            ...filters,
            OR: [{ ownerUserId: null }, { ownerUserId: ctx.userId ?? '__none__' }],
          };
        } else {
          // Org-scoped view. In the DEFAULT (no orgId) view, also surface the
          // caller's OWN user-owned agents (org NULL) — otherwise a personal
          // agent the caller just created is invisible in their agent list. A
          // specific-org selection excludes them (they belong to no org).
          const ownerClauses: Record<string, unknown>[] = [
            { organizationId: { in: scope.memberOrgIds } },
          ];
          // #876: the DEFAULT view (no orgId) folded the caller's user-owned
          // agents in too, so the leak did not require filter.ownedByMe —
          // an unfiltered `agents { items }`, which is what the portal issues,
          // exposed them. Identity-scoped ⇒ dropped under impersonation.
          if (!scopedToOrg && ctx.userId && !ctx.impersonation) {
            ownerClauses.push({ ownerUserId: ctx.userId });
          }
          where = { ...filters, OR: ownerClauses };
        }
      }
      const [total, items] = await Promise.all([
        ctx.db.agent.count({ where }),
        take === 0
          ? Promise.resolve([])
          : ctx.db.agent.findMany({
              where,
              include: AGENT_INCLUDE,
              orderBy: [{ name: 'asc' }, { id: 'asc' }],
              skip,
              take,
            }),
      ]);
      return { items, total };
    },

    agentAIConfig: async (_: unknown, { agentRef }: { agentRef: string }, ctx: Context) => {
      if (!ctx.userId) throw unauthenticatedError();
      // 007-entity-id-or-urn: agentRef may be ID, bare URN, or prefixed URN.
      // #1944: through the read gate first, so an unreadable Agent answers as
      // absent; the key read itself stays owner/org-ADMIN only, below.
      const agent = await resolveReadableAgentRef(ctx, agentRef);
      const resolvedAgentId = agent.id;
      // Org ADMIN on the agent's org can read the decrypted key.
      await requireOwnerOrOrgRole(ctx, agent, 'ADMIN');
      // 036-ai-service-config: registry-backed — the Agent's 'default'
      // config (single-entity contract preserved; no resolution walk).
      const config = await ctx.db.aiServiceConfig.findFirst({
        where: { agentId: resolvedAgentId, name: DEFAULT_AI_CONFIG_NAME },
      });
      if (!config?.apiKeyEncrypted) return null;
      return {
        provider: config.provider,
        apiKey: decryptToken(config.apiKeyEncrypted),
        model: config.model,
      };
    },

    // ── 036-ai-service-config ─────────────────────────────────────────

    // #473 — the uniform single-config read. AiServiceConfig is the one
    // URN-less entity (ref = ID only, matching resolveUrn / effectiveAccess
    // dispatch). Masked (no key material); auth mirrors the list gate:
    // platform ADMIN/OWNER for HADRON_SERVER-owned rows, org ADMIN of the
    // owning org otherwise.
    aiServiceConfig: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
      if (!ctx.userId && !isPlatformAdmin(ctx)) throw unauthenticatedError();
      const config = await ctx.db.aiServiceConfig.findUnique({ where: { id: ref } });
      if (!config) return null;
      try {
        const owner = aiConfigOwnerOf(config);
        await requireAiConfigOwnerAdmin(ctx, owner.ownerType, owner.ownerId);
        return toGqlAiServiceConfig(config);
      } catch (e) {
        rethrowAiConfigTyped(e);
      }
    },

    // #473 — paginated; filter carries the owner. Omitted filter = the
    // platform ADMIN/OWNER cross-owner view of every config.
    aiServiceConfigs: async (
      _: unknown,
      {
        filter,
        limit,
        offset,
      }: {
        filter?: { ownerType: AiConfigOwnerType; ownerId: string } | null;
        limit?: number | null;
        offset?: number | null;
      },
      ctx: Context,
    ) => {
      if (!ctx.userId && !isPlatformAdmin(ctx)) throw unauthenticatedError();
      try {
        let ownerWhere: Record<string, string> = {};
        if (filter) {
          ({ ownerWhere } = await requireAiConfigOwnerAdmin(ctx, filter.ownerType, filter.ownerId));
        } else if (!isPlatformAdmin(ctx)) {
          // No owner filter = the cross-owner ops view — platform staff only.
          throw forbiddenError();
        }
        const take = clampListTake(limit);
        const skip = Math.max(0, offset ?? 0);
        const [total, configs] = await Promise.all([
          ctx.db.aiServiceConfig.count({ where: ownerWhere }),
          take === 0
            ? Promise.resolve([])
            : ctx.db.aiServiceConfig.findMany({
                where: ownerWhere,
                orderBy: [{ name: 'asc' }, { id: 'asc' }],
                skip,
                take,
              }),
        ]);
        return { items: configs.map(toGqlAiServiceConfig), total };
      } catch (e) {
        rethrowAiConfigTyped(e);
      }
    },

    resolveAIConfig: async (
      _: unknown,
      { name, appRef, agentRef }: { name?: string | null; appRef?: string | null; agentRef?: string | null },
      ctx: Context,
    ) => {
      try {
        // Resolve refs (007 ID-or-URN). The named App has its own auth gate;
        // an unrelated Agent's org cannot authorize its decrypted key.
        let resolvedAppId: string | null = null;
        let resolvedAgentId: string | null = null;
        let effectiveOrgId: string | null = null;
        let userOwnedAgent = false;
        let personalAgentOwnerId: string | null = null;
        let appOwnerUserId: string | null = null;
        let agentOwner: { organizationId: string | null; ownerUserId: string | null } | null = null;
        if (appRef) {
          const { id } = await resolveAppRef(ctx.db, appRef);
          resolvedAppId = id;
          const app = await ctx.db.app.findUniqueOrThrow({ where: { id } });
          effectiveOrgId = app.organizationId;
          appOwnerUserId = app.ownerUserId;
          // The same owner-aware gate protects appAIConfig's decrypted key.
          await requireOwnerOrOrgRole(ctx, app, 'ADMIN');
        }
        if (agentRef) {
          // #1944: with no App named, the Agent goes through the read gate, so
          // one the caller can't read answers as absent; the owner/org gates
          // below still apply. With an App named, the App ADMIN gate above and
          // the installation check below are the authority: an App's admin
          // legitimately resolves an Agent installed from another org that
          // they can't read directly, so the read gate must not run there.
          // (Whether an App admin may tell absent from not-installed is
          // #1946's open question.)
          const agent = resolvedAppId
            ? await ctx.db.agent.findUniqueOrThrow({ where: { id: (await resolveAgentRef(ctx.db, agentRef)).id } })
            : await resolveReadableAgentRef(ctx, agentRef);
          const { id } = agent;
          resolvedAgentId = id;
          // #1946 (Atilla's P2 on #1955): with an App named, "not installed
          // here" is decided BEFORE any Agent-specific denial below (the
          // personal-Agent owner gate), so a foreign Agent answers exactly as
          // an absent one (ruling A).
          if (resolvedAppId && !(await isAgentInstalled(ctx.db, resolvedAppId, id))) {
            throw new AgentNotFoundError(agentRef);
          }
          agentOwner = agent;
          userOwnedAgent = agent.ownerUserId !== null;
          personalAgentOwnerId = agent.ownerUserId;
          if (userOwnedAgent) {
            // A personal Agent is strictly owner-only, even for platform
            // admins and impersonated sessions (spec 047).
            await requireOwnerOrOrgRole(ctx, agent, 'ADMIN');
          }
          if (!effectiveOrgId) {
            effectiveOrgId = agent.organizationId;
          }
        }
        // #1946 (ruling A): with an App named, an Agent not installed in it
        // answers exactly as an absent one — one answer, no id.
        if (resolvedAppId && resolvedAgentId && !(await isAgentInstalled(ctx.db, resolvedAppId, resolvedAgentId))) {
          throw new AgentNotFoundError(agentRef!);
        }
        // A user-owned App's config is eligible only when it belongs to the
        // same owner as the named personal Agent. Otherwise naming another
        // user's App would turn the Agent-owner gate into a cross-user decrypt.
        if (userOwnedAgent && resolvedAppId && !effectiveOrgId && appOwnerUserId !== personalAgentOwnerId) {
          throw forbiddenError();
        }
        // Privileged surface (decrypted key): org ADMIN of the effective
        // org — same gate as the legacy agentAIConfig/appAIConfig queries
        // this supersedes. Without app/agent context, platform admin only.
        if (!resolvedAppId) {
          if (effectiveOrgId) {
            await requireOrgRole(ctx, effectiveOrgId, 'ADMIN');
          } else if (!userOwnedAgent && !isPlatformAdmin(ctx)) {
            throw forbiddenError();
          }
        }
        const resolved = await resolveAiConfigWithFallback(ctx.db, name ?? null, {
          appId: resolvedAppId,
          agentId: resolvedAgentId,
          organizationId: effectiveOrgId,
        });
        const { config, ownerType } = resolved;
        if (appOwnerUserId !== null) {
          // The shared walk can derive an installed Agent's org even when the
          // App is user-owned. The App's owner may decrypt their own App row,
          // but an outer org or Agent row still needs its own owner gate.
          if (ownerType === 'ORGANIZATION') {
            await requireOrgRole(ctx, config.organizationId!, 'ADMIN');
          } else if (ownerType === 'AGENT' && agentOwner) {
            await requireOwnerOrOrgRole(ctx, agentOwner, 'ADMIN');
          } else if (ownerType === 'HADRON_SERVER') {
            throw new NoAiConfigAvailableError(name ?? DEFAULT_AI_CONFIG_NAME, 'this App');
          }
        }
        if (userOwnedAgent && !effectiveOrgId && ownerType === 'HADRON_SERVER') {
          // A personal Agent may use its own config or one on the user-owned
          // App it runs through. Neither context may reach the platform key.
          throw new NoAiConfigAvailableError(name ?? DEFAULT_AI_CONFIG_NAME, 'this Agent');
        }
        if (ownerType === 'HADRON_SERVER' && config.apiKeyEncrypted && !isPlatformAdmin(ctx)) {
          // Tenant admins may use the platform fallback for server-side calls,
          // but the platform's provider credential must not leave the server.
          throw new GraphQLError(
            `AI configuration '${config.name}' resolved at the HADRON_SERVER level; only a platform administrator may decrypt its API key.`,
            { extensions: { code: 'FORBIDDEN' } },
          );
        }
        if (!config.apiKeyEncrypted) {
          // Resolvable but unusable: a config without a key cannot back an
          // LLM call (spec 036 edge case — name the config + level, never
          // key material).
          throw new NoAiConfigAvailableError(
            config.name,
            `this context — config '${config.name}' at the ${ownerType} level has no API key stored`,
          );
        }
        return {
          configId: config.id,
          name: config.name,
          ownerType,
          provider: config.provider,
          model: config.model,
          apiKey: decryptToken(config.apiKeyEncrypted),
          params: config.params ?? null,
          effectiveEndpoint: effectiveEndpoint(config),
          effectiveApiStyle: effectiveApiStyle(config),
        };
      } catch (e) {
        rethrowAiConfigTyped(e);
      }
    },

    aiProviderEndpoints: async (_: unknown, { provider }: { provider: string }) =>
      (Object.hasOwn(AI_PROVIDER_ENDPOINTS, provider)
        ? AI_PROVIDER_ENDPOINTS[provider as keyof typeof AI_PROVIDER_ENDPOINTS]
        : []
      ).map((e) => ({ ...e })),

    resolveAiServiceConfigs: async (
      _: unknown,
      { appRef, agentRef }: { appRef?: string | null; agentRef?: string | null },
      ctx: Context,
    ) => {
      try {
        // 007-entity-id-or-urn: appRef/agentRef may be ID or URN. A ref that
        // doesn't resolve to a row simply contributes nothing to the walk.
        const resolvedAppId = appRef ? (await resolveAppRef(ctx.db, appRef)).id : null;
        // Masked picker: ALL App members may list the configs their chat
        // context can resolve (not just org admins — no key material leaves).
        // #1946: the App gate runs BEFORE the Agent is resolved, and for an App
        // member "not installed in this App" answers exactly as "no such Agent"
        // (Holger's ruling A, team chat #11863): one answer, no id.
        await requireAiConfigPickerAccess(ctx, resolvedAppId, null);
        let resolvedAgentId: string | null = null;
        if (agentRef) {
          resolvedAgentId = (await resolveAgentRef(ctx.db, agentRef)).id;
          if (!isPlatformAdmin(ctx) && !(await isAgentInstalled(ctx.db, resolvedAppId!, resolvedAgentId))) {
            throw new AgentNotFoundError(agentRef);
          }
        }
        const resolved = await resolveAiConfigs(ctx.db, {
          appId: resolvedAppId,
          agentId: resolvedAgentId,
        });
        return resolved.map((r) => toGqlAiServiceConfigForPicker(r.config));
      } catch (e) {
        rethrowAiConfigTyped(e);
      }
    },

    myAgentSubscriptions: async (_: unknown, __: unknown, ctx: Context) => {
      // #876 class sweep: identity-scoped and org-unconstrained — this listed
      // the target's subscriptions across every org.
      if (!ctx.userId || ctx.impersonation) return [];
      return ctx.db.agentSubscription.findMany({
        where: { userId: ctx.userId },
        orderBy: { createdAt: 'desc' },
      });
    },

    // 005-agent-subscription FR-022: list all AgentSubscriptions to an Agent.
    // Authorized for ADMIN/OWNER of the Agent's owning org.
    agentSubscriptions: async (
      _: unknown,
      { agentRef }: { agentRef: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentRef may be ID, bare URN, or prefixed URN.
      // #1944: an Agent the caller can't read answers as absent.
      const agent = await resolveReadableAgentRef(ctx, agentRef);
      const resolvedAgentId = agent.id;
      await requireAgentAccess(ctx, agent, 'ADMIN');
      return ctx.db.agentSubscription.findMany({
        where: { agentId: resolvedAgentId },
        orderBy: { createdAt: 'desc' },
      });
    },

};
