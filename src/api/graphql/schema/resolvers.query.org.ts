// orgQueries — extracted from resolvers.ts Query (split step 3). No behavior change.
import { parseUrnInput } from '../../../lib/urn.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
// Spec 049 Phase 3 — the search ladder's GraphQL entry + disclosure envelope.
import { resolveNamedScopeForQuery, scopeInfoOf, SCOPE_NARROWED, type SearchScopeResolution } from '../../../lib/scopes.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveNodeRef } from '../../../lib/entityRef/nodeRef.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { resolveUserRef } from '../../../lib/entityRef/userRef.js';
import { UserNotFoundError } from '../../../lib/entityRef/errors.js';
import {
  resolveResource as resolveAccessResource,
  callerCanAudit,
  computeEffectiveAccess,
  type ResolvedResource,
} from '../../../lib/auth/effectiveAccess.js';
import { agentQueries } from './resolvers.query.agent.js';
import {
  globalSearch as runGlobalSearch,
  type SearchEntityType,
  type SearchField,
  type SearchPrincipal,
} from '../../../lib/global-search/index.js';
import { getMemberOrgIds } from '../../../lib/auth/memberOrgIds.js';
import { discoverableOrgWhere, publicReadableMemoryWhere } from '../../../lib/orgDiscoverability.js';
import { orgRowToRef, agentRowToRef, memoryRowToRef } from './publicRefs.js';
import { GraphQLError } from 'graphql';
import { searchContains } from '../../../integrations/db/provider.js';
import {
  type Context,
  clampListTake,
  getAccessibleMemoryIds,
  resolveOrgScope,
  ORG_INCLUDE,
  canOpenMemoryRecordById,
  isMemoryReadableCached,
  isAuthorizationDenial,
  requireAppRead,
} from './resolvers.helpers.js';
import { LIVE_ORG_MEMBERSHIP } from '../../../lib/auth/liveOrgMembership.js';

/**
 * May this caller OPEN the resolved resource? (`cor:acl:060:01`, amended
 * 2026-09-26; #1381.) A resource the caller cannot open answers the audit's
 * `NOT_FOUND` exactly as an unresolvable reference does.
 *
 * Answered by each kind's OWN read gate, never a copy of it:
 *  - memory → the record gate (`cor:api:140:03`: a caller who can open the
 *    record already knows the memory exists);
 *  - node → the node-content gate of its memory, the line `Query.node` draws;
 *  - every other kind → that kind's find-one query (`agent(ref:)`, …), or for
 *    an App the gate `app(ref:)` applies once resolved. `null`, or an ordinary
 *    authorization denial, means "cannot open"; any other error propagates.
 *
 * Deliberately NOT the audit's own `canRead`: that reports grants, and a
 * resource can be openable without one (a PUBLIC agent, for instance).
 */
async function callerCanOpenResource(ctx: Context, resolved: ResolvedResource): Promise<boolean> {
  if (resolved.kind === 'memory') return canOpenMemoryRecordById(ctx, resolved.memory.id);
  if (resolved.kind === 'node') return isMemoryReadableCached(ctx, resolved.memory.id);
  const findOne = async (): Promise<unknown> => {
    switch (resolved.kind) {
      case 'app':
        // The App query's OWN gate, applied to the already-resolved (live) App
        // — not the query itself, whose resolution step swallows EVERY error
        // into null and would turn an outage into "not found" (@codex /
        // @copilot, PR #1383).
        await requireAppRead(ctx, resolved.app);
        return resolved.app;
      case 'agent':
        return agentQueries.agent(null as never, { ref: resolved.agent.id }, ctx);
      case 'aiServiceConfig':
        return agentQueries.aiServiceConfig(null as never, { ref: resolved.config.id }, ctx);
      case 'organization':
        return orgQueries.organization(null as never, { ref: resolved.org.id }, ctx);
      case 'user':
        return orgQueries.user(null as never, { ref: resolved.user.id }, ctx);
    }
  };
  try {
    return (await findOne()) != null;
  } catch (error) {
    if (isAuthorizationDenial(error)) return false;
    throw error;
  }
}

export const orgQueries = {
    effectiveAccess: async (
      _: unknown,
      { user, resource }: { user: string; resource: string },
      ctx: Context,
    ) => {
      // Subject — the user whose access we are auditing. Accepts a User id OR a
      // `hrn:user:<handle>` URN (spec cor:urn:010:01), resolved via the same
      // resolveUserRef the `resource` side uses. Unknown / soft-deleted subject
      // → NOT_FOUND.
      let subjectUser: Awaited<ReturnType<typeof ctx.db.user.findUnique>> = null;
      try {
        const { id: subjectId } = await resolveUserRef(ctx.db, user);
        subjectUser = await ctx.db.user.findUnique({ where: { id: subjectId } });
      } catch (e) {
        // Only a genuine miss collapses to NOT_FOUND. A malformed URN
        // (UrnNotQualifiedError → URN_NOT_QUALIFIED) and unexpected DB/runtime
        // errors must propagate, not be masked as a misleading NOT_FOUND.
        if (!(e instanceof UserNotFoundError)) throw e;
        subjectUser = null;
      }
      if (!subjectUser) {
        throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
      }

      // Resolve the resource ref (id or fully-qualified URN). Dispatches on
      // URN type exactly like resolveUrn; a bare id falls through to
      // AiServiceConfig (the only URN-less kind). Unresolvable → NOT_FOUND.
      const resolved = await resolveAccessResource(ctx.db, resource, {
        parseType: (ref) => parseUrnInput(ref).type,
        resolveMemoryRef,
        resolveNodeRef,
        resolveAppRef,
        resolveAgentRef,
        resolveOrgRef,
        resolveUserRef,
      });
      if (!resolved) {
        throw new GraphQLError('Resource not found', { extensions: { code: 'NOT_FOUND' } });
      }

      // Admin impersonation: the read-only session may audit ONLY resources
      // owned by its shared org — never identity-scoped resources (user-owned,
      // personal/private — even the target's own) and never other orgs'. This
      // runs before the self-audit shortcut below, which would otherwise let
      // the impersonated context (userId = target) self-audit out of scope.
      if (ctx.impersonation) {
        const impOrgId = ctx.impersonation.orgId;
        const resourceOrgId =
          resolved.kind === 'memory' || resolved.kind === 'node'
            ? resolved.memory.ownerUserId === null &&
              resolved.memory.class !== 'personal' &&
              resolved.memory.class !== 'private'
              ? resolved.memory.organizationId
              : null
            : resolved.kind === 'app'
              ? resolved.app.ownerUserId === null
                ? resolved.app.organizationId
                : null
              : resolved.kind === 'agent'
                ? resolved.agent.ownerUserId === null
                  ? resolved.agent.organizationId
                  : null
                : resolved.kind === 'organization'
                  ? resolved.org.id
                  : resolved.kind === 'aiServiceConfig'
                    ? resolved.config.organizationId
                    : null;
        if (resourceOrgId !== impOrgId) {
          throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
        }
      }

      // cor:acl:060:01 (amended 2026-09-26, #1381): a resource the caller cannot
      // open answers exactly as the unresolvable one above — for a memory or a
      // node in one, whoever the caller is (cor:api:140:03); for any other kind,
      // on a self-audit. Checked BEFORE the caller gate, so "NOT_FOUND before
      // FORBIDDEN" covers the unopenable case too. The cost, accepted by the
      // ruling: a user who knows a URN can't use the audit to learn why they
      // can't reach it — attempting the operation now says "not found" too.
      //
      // AFTER the impersonation gate above, deliberately: that gate is #875's
      // own scoped refusal for a platform admin's support session, which the
      // amendment does not address and which no outsider can reach.
      const auditsSelf = !!ctx.userId && subjectUser.id === ctx.userId;
      const memoryShaped = resolved.kind === 'memory' || resolved.kind === 'node';
      // #1946: an Agent too, whoever is audited: a cross-subject audit of an
      // Agent the caller can't open used to answer FORBIDDEN (callerCanAudit)
      // where an absent one answers NOT_FOUND, an existence oracle.
      const concealed = memoryShaped || resolved.kind === 'agent';
      if ((concealed || auditsSelf) && !(await callerCanOpenResource(ctx, resolved))) {
        throw new GraphQLError('Resource not found', { extensions: { code: 'NOT_FOUND' } });
      }
      // Who may CALL this — the same visibility bar as the underlying grant
      // tables. A non-privileged caller gets FORBIDDEN, never a silent empty
      // result, so the audit command can't probe access it isn't allowed to.
      //
      // Self-audit is always allowed (issue #364): a user auditing their OWN
      // effective access learns nothing they couldn't already infer by trying
      // the operation, so there's no info-leak. Every other (cross-subject)
      // case stays gated by callerCanAudit exactly as before.
      if (
        !auditsSelf &&
        !(await callerCanAudit(ctx.db, { userId: ctx.userId, roles: ctx.roles }, resolved))
      ) {
        throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
      }

      const result = await computeEffectiveAccess(
        ctx.db,
        { id: subjectUser.id, roles: subjectUser.roles },
        resolved,
        ctx.impersonation ? { restrictOrgId: ctx.impersonation.orgId } : undefined,
      );
      // Attach the loaded User row so the User field resolvers work off it.
      return { ...result, user: subjectUser };
    },

    // #473 — the uniform single-user read. ref = PK or hrn:user:<handle>.
    // Gate mirrors resolveUrn's user branch: self, platform ADMIN/OWNER, or a
    // caller sharing ≥1 org with the target; everyone else gets null — denied
    // and missing indistinguishable, preserving #384's anti-enumeration
    // posture. PII fields stay gated by the User field resolvers.
    user: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
      let id: string;
      try {
        ({ id } = await resolveUserRef(ctx.db, ref));
      } catch (e) {
        // Genuine miss → null; malformed URN / unexpected errors propagate.
        if (!(e instanceof UserNotFoundError)) throw e;
        return null;
      }
      const isGlobalAdmin =
        !!ctx.roles?.includes('ADMIN') || !!ctx.roles?.includes('OWNER');
      if (!isGlobalAdmin && ctx.userId !== id) {
        if (!ctx.userId) return null;
        // Caller shares ≥1 org with the target — single query via the
        // org-membership relation (mirrors resolveUrn's user branch).
        const shared = await ctx.db.orgMember.findFirst({
          where: {
            userId: ctx.userId,
            deletedAt: null,
            // Impersonation: co-membership counts only in the shared org.
            ...(ctx.impersonation ? { organizationId: ctx.impersonation.orgId } : {}),
            organization: { deletedAt: null, members: { some: { userId: id, deletedAt: null } } },
          },
          select: { organizationId: true },
        });
        if (!shared) return null;
      }
      return ctx.db.user.findUnique({ where: { id } });
    },

    // #473 — the uniform paginated user list; replaces the admin-only users
    // list and searchUsers. Platform ADMIN/OWNER: every live user, query
    // optional. Everyone else: query REQUIRED (blank/omitted → empty page),
    // with the enumeration-safe matching #384 / cor:acl:070:02 established:
    // public identifiers (handle, githubUsername) match by substring, email
    // by EXACT equality, and a `name` match counts only for a viewer allowed
    // to see that name (self/admin, or a co-member). The co-member
    // restriction is pushed INTO the query — not a post-filter — so the page
    // cap can't drop a legitimately visible co-member behind a wall of
    // name-only stranger matches.
    users: async (
      _: unknown,
      {
        filter,
        limit,
        offset,
      }: {
        filter?: { query?: string | null } | null;
        limit?: number | null;
        offset?: number | null;
      },
      ctx: Context,
    ) => {
      const take = clampListTake(limit);
      const skip = Math.max(0, offset ?? 0);
      const page = async (where: Record<string, unknown>) => {
        const [total, items] = await Promise.all([
          ctx.db.user.count({ where }),
          take === 0
            ? Promise.resolve([])
            : ctx.db.user.findMany({
                where,
                orderBy: [{ name: 'asc' }, { id: 'asc' }],
                skip,
                take,
              }),
        ]);
        return { items, total };
      };

      const q = filter?.query?.trim() ?? '';
      const isPlatformAdmin = !!ctx.roles?.some((r) => r === 'ADMIN' || r === 'OWNER');
      if (isPlatformAdmin && q === '') {
        return page({ deletedAt: null });
      }
      if (!ctx.userId && !isPlatformAdmin) throw new Error('Unauthenticated');
      // A blank query would make `contains: ''` match every row, re-opening
      // the enumeration path #384 closes — return an empty page instead.
      if (q === '') return { items: [], total: 0 };

      const viewerOrgIds = isPlatformAdmin
        ? []
        : await getMemberOrgIds(ctx.db, ctx.userId!, ctx.impersonation?.orgId);
      const nameMatch = isPlatformAdmin
        ? searchContains('name', q)
        : {
            AND: [
              searchContains('name', q),
              // target shares an org with the viewer (so the viewer may see the name)
              { memberships: { some: { organizationId: { in: viewerOrgIds }, deletedAt: null } } },
            ],
          };
      return page({
        deletedAt: null,
        OR: [
          searchContains('handle', q),
          searchContains('githubUsername', q),
          { email: { equals: q, mode: 'insensitive' } },
          nameMatch,
        ],
      });
    },

    globalSearch: async (
      _: unknown,
      {
        query,
        entityTypes,
        fields,
        orgId: orgIdArg,
        limit,
        offset,
        scope,
        appRef,
      }: {
        query: string;
        entityTypes?: SearchEntityType[] | null;
        fields?: SearchField[] | null;
        orgId?: string | null;
        limit?: number | null;
        offset?: number | null;
        /** Spec 049 Phase 3 — a scope named in the call (see findNodes). */
        scope?: string | null;
        appRef?: string | null;
      },
      ctx: Context,
    ) => {
      // Spec 049 Phase 3 — a named scope narrows the Memory + Node slices to
      // the scope's memories (already ∩ access, S2); `global` becomes the
      // organization narrowing below. Nothing else changes; omitted ⇒ pre-049.
      let orgId = orgIdArg;
      let scopeRes: SearchScopeResolution | null = null;
      if (scope != null && scope.trim() !== '') {
        scopeRes = await resolveNamedScopeForQuery(ctx, scope, appRef ?? null, orgId ?? null);
        if (scopeRes.kind === 'global') orgId = scopeRes.orgScopeId;
      }
      // Build the access principal from ctx using the SAME gates as the
      // per-kind queries, so a global hit can never reach something the caller
      // couldn't open directly. getAccessibleMemoryIds already carves out other
      // users' personal/private (even for admin); getMemberOrgIds scopes the
      // org-rooted slices. App-Key callers (no userId) get no org-read → [].
      const isPlatformAdmin = !!ctx.roles?.includes('ADMIN') || !!ctx.roles?.includes('OWNER');
      const accessibleMemoryIds = await getAccessibleMemoryIds(ctx);
      // The caller's member orgs (admin included) — both the default org scope
      // for non-admins and the membership gate for orgId. Computed once.
      const callerOrgIds = ctx.userId
        ? await getMemberOrgIds(ctx.db, ctx.userId, ctx.impersonation?.orgId)
        : [];
      let orgIds: string[] | null = isPlatformAdmin ? null : callerOrgIds;

      // #463: optional single-org narrowing. orgScopeId AND-constrains the
      // Memory + Node slices to that org's memories (never widening access);
      // orgIds: [orgId] confines the org-rooted slices. Uniform member-only —
      // the active org must be one the caller is a member of (NO platform-admin
      // bypass); a non-member orgId gets an empty page (no org-existence
      // disclosure).
      let orgScopeId: string | null = null;
      if (orgId != null) {
        let resolvedOrgId: string;
        try {
          ({ id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId));
        } catch {
          return { hits: [], total: 0, degraded: [] };
        }
        // An App key's organization is its credential (cor:api:100): it may
        // narrow to its OWN App's org, as findNodes already allows — the two
        // scoped surfaces must agree (Codex on PR #1161).
        let appKeyOrgId: string | null = null;
        if (!ctx.userId && ctx.appId) {
          appKeyOrgId = (await ctx.db.app.findUnique({ where: { id: ctx.appId }, select: { organizationId: true } }))?.organizationId ?? null;
        }
        if (!callerOrgIds.includes(resolvedOrgId) && appKeyOrgId !== resolvedOrgId) {
          return { hits: [], total: 0, degraded: [] };
        }
        orgIds = [resolvedOrgId];
        orgScopeId = resolvedOrgId;
      }

      const principal: SearchPrincipal = {
        viewerUserId: ctx.userId ?? null,
        isPlatformAdmin,
        // A scope's list is already the caller's readable subset of it (S2), so
        // handing it over as the accessible set narrows and never widens.
        accessibleMemoryIds: scopeRes?.memoryIds ?? accessibleMemoryIds,
        orgIds,
        // #609: the caller's OWN member orgs — the Organization slice uses this
        // so an admin still finds a hidden org they belong to.
        viewerOrgIds: callerOrgIds,
        orgScopeId,
        impersonationOrgId: ctx.impersonation?.orgId ?? null,
      };
      const res = await runGlobalSearch(ctx.db, { query, entityTypes, fields, limit, offset }, principal);
      if (!scopeRes) return res;
      return {
        ...res,
        scope: await scopeInfoOf(ctx, scopeRes),
        degraded: scopeRes.droppedCount > 0 ? [...res.degraded, SCOPE_NARROWED] : res.degraded,
      };
    },

    me: async (_: unknown, __: unknown, ctx: Context) => {
      if (!ctx.userId) return null;
      return ctx.db.user.findUnique({ where: { id: ctx.userId } });
    },

    // #562: expose the request's already-resolved AuthContext (cor:aut:020:02)
    // read-only. Current-request only — there is no token argument, so this is
    // never an oracle. A credential that didn't resolve leaves both appId and
    // userId unset; we return null identically for revoked / never-existed /
    // malformed (no reason-leak). The `user` and `apiKey` fields resolve lazily
    // on the AuthContext type (resolvers.types.ts) from the ids threaded here.
    authContext: async (_: unknown, __: unknown, ctx: Context) => {
      const principalType = ctx.appId ? 'APP' : ctx.userId ? 'USER' : null;
      if (!principalType) return null;
      return {
        principalType,
        userId: ctx.userId ?? null,
        appId: ctx.appId ?? null,
        agentId: null, // reserved — no agent-credential principal today
        apiKeyId: ctx.apiKeyId ?? null,
        // Admin impersonation: the acting-as facts of this credential (the
        // ImpersonationInfo field resolvers hydrate actorUser lazily).
        impersonation: ctx.impersonation
          ? {
              sessionId: ctx.impersonation.sessionId,
              actorUserId: ctx.impersonation.actorUserId,
              organizationId: ctx.impersonation.orgId,
              expiresAt: ctx.impersonation.expiresAt,
              readOnly: true,
            }
          : null,
      };
    },

    // #473 — the uniform paginated organization list; replaces organizations
    // (admin, all) + myOrganizations (memberships). Members get their member
    // orgs (App-key callers their own App's org); platform ADMIN/OWNER keep
    // the established unscoped reach over every live org. filter.memberOnly
    // restricts the list to the caller's own memberships even for a platform
    // admin (the old myOrganizations semantics, as a slice-as-filter —
    // cor:api:120:03) so clients resolving "my orgs" (nav, active-org) don't
    // receive every live org when the caller happens to be an admin.
    organizations: async (
      _: unknown,
      {
        filter,
        limit,
        offset,
      }: {
        filter?: { memberOnly?: boolean | null } | null;
        limit?: number | null;
        offset?: number | null;
      },
      ctx: Context,
    ) => {
      const take = clampListTake(limit);
      const skip = Math.max(0, offset ?? 0);
      const isPlatformAdmin =
        !!ctx.roles?.includes('ADMIN') || !!ctx.roles?.includes('OWNER');
      let where: Record<string, unknown>;
      if (isPlatformAdmin && !filter?.memberOnly) {
        // Spec 048: `isVisible` was dropped with the auto-personal org — every
        // org is now a real (listable) org, so a platform admin's default org
        // listing is simply every non-deleted org.
        where = { deletedAt: null };
      } else {
        // Membership scope — for non-admins (unchanged default) and for any
        // caller with filter.memberOnly (a no-op for non-admins, whose default
        // scope IS their memberships). resolveOrgScope excludes revoked
        // (soft-deleted) memberships. Without an orgId argument it never
        // returns null today, but handle it like the sibling list resolvers
        // (empty page) instead of asserting — a future orgId addition or
        // helper refactor must degrade, not crash (PR #479 review).
        const scope = await resolveOrgScope(ctx);
        if (!scope) return { items: [], total: 0 };
        where = { deletedAt: null, id: { in: scope.memberOrgIds } };
      }
      const [total, items] = await Promise.all([
        ctx.db.organization.count({ where }),
        take === 0
          ? Promise.resolve([])
          : ctx.db.organization.findMany({
              where,
              orderBy: [{ name: 'asc' }, { id: 'asc' }],
              skip,
              take,
              include: ORG_INCLUDE,
            }),
      ]);
      return { items, total };
    },

    organization: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
      // 007-entity-id-or-urn: ref may be ID, bare URN, or prefixed URN.
      const { id: resolvedId } = await resolveOrgRef(ctx.db, ref);
      const isAdmin = !!ctx.roles?.includes('ADMIN') || !!ctx.roles?.includes('OWNER');
      const isMember =
        ctx.userId && (!ctx.impersonation || ctx.impersonation.orgId === resolvedId)
          ? !!(await ctx.db.orgMember.findFirst({
              where: { organizationId: resolvedId, userId: ctx.userId, ...LIVE_ORG_MEMBERSHIP },
            }))
          : false;
      if (!isMember) {
        // Spec 048: `isVisible` was dropped with the auto-personal org. Every org
        // is now listable, so a platform admin may resolve any org by ref; a
        // non-admin non-member is still Forbidden (membership is the read gate).
        //
        // TYPED, matching the two sibling refusals in this file. A bare
        // `Error` reaches the wire as INTERNAL_SERVER_ERROR, so every client
        // has to decide between "you may not read this org" and "the API is
        // broken" by reading prose — and the portal could not, which is why it
        // mapped INTERNAL_SERVER_ERROR to 404 and told users their org did not
        // exist whenever the backend was down (hadron-portal#843).
        // conventions:the-error-code-is-the-contract-the-prose-is-not.
        if (!isAdmin) {
          throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
        }
      }
      return ctx.db.organization.findUnique({ where: { id: resolvedId }, include: ORG_INCLUDE });
    },

    // cor:acl:080:02 — the sanitized PUBLIC view for the non-member discovery
    // path. Returns non-null ONLY for a discoverable org (activated + public
    // footprint); everything else — non-discoverable, unresolvable, malformed —
    // collapses to null (denied ≡ not-found, anti-enumeration). Selects only the
    // safe scalar fields; the PublicOrganization field resolvers expose just the
    // org's public memories/agents, never the leaky full-Organization surface.
    publicOrganization: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
      let resolvedId: string;
      try {
        ({ id: resolvedId } = await resolveOrgRef(ctx.db, ref));
      } catch {
        return null;
      }
      return ctx.db.organization.findFirst({
        where: { AND: [{ id: resolvedId }, discoverableOrgWhere()] },
        select: { id: true, name: true, urn: true, listedOnMarketplace: true },
      });
    },

    // cor:acl:080:04 — the marketplace catalogue. Public (no membership). Each is
    // a paginated { items, total } of sanitized flat refs, ordered (name, id) for
    // stable paging. Only listedOnMarketplace + publicly-accessible resources; a
    // resource's own listing controls its presence — an org card links out to
    // publicOrganization(ref:) for the full (public) footprint.
    marketplaceOrganizations: async (
      _: unknown,
      { limit, offset }: { limit?: number | null; offset?: number | null },
      ctx: Context,
    ) => {
      const take = clampListTake(limit);
      const skip = Math.max(0, offset ?? 0);
      const where = { deletedAt: null, listedOnMarketplace: true } as const;
      const [total, rows] = await Promise.all([
        ctx.db.organization.count({ where }),
        take === 0
          ? Promise.resolve([])
          : ctx.db.organization.findMany({
              where,
              select: { id: true, name: true, urn: true },
              orderBy: [{ name: 'asc' }, { id: 'asc' }],
              skip,
              take,
            }),
      ]);
      return { items: rows.map(orgRowToRef), total };
    },
    marketplaceAgents: async (
      _: unknown,
      { limit, offset }: { limit?: number | null; offset?: number | null },
      ctx: Context,
    ) => {
      const take = clampListTake(limit);
      const skip = Math.max(0, offset ?? 0);
      const where = { deletedAt: null, listedOnMarketplace: true, visibility: 'PUBLIC' } as const;
      const [total, rows] = await Promise.all([
        ctx.db.agent.count({ where }),
        take === 0
          ? Promise.resolve([])
          : ctx.db.agent.findMany({
              where,
              select: { id: true, name: true, urn: true, description: true },
              orderBy: [{ name: 'asc' }, { id: 'asc' }],
              skip,
              take,
            }),
      ]);
      return { items: rows.map(agentRowToRef), total };
    },
    marketplaceMemories: async (
      _: unknown,
      { limit, offset }: { limit?: number | null; offset?: number | null },
      ctx: Context,
    ) => {
      const take = clampListTake(limit);
      const skip = Math.max(0, offset ?? 0);
      const where = { listedOnMarketplace: true, ...publicReadableMemoryWhere() };
      const [total, rows] = await Promise.all([
        ctx.db.memory.count({ where }),
        take === 0
          ? Promise.resolve([])
          : ctx.db.memory.findMany({
              where,
              select: { id: true, name: true, urn: true, shortDescription: true },
              orderBy: [{ name: 'asc' }, { id: 'asc' }],
              skip,
              take,
            }),
      ]);
      return { items: rows.map(memoryRowToRef), total };
    },

    invitation: async (_: unknown, { slug }: { slug: string }, ctx: Context) => {
      const invite = await ctx.db.userInvitation.findUnique({
        where: { slug },
        select: {
          deletedAt: true,
          memberRole: true,
          maxActivations: true,
          expiresAt: true,
          sender: { select: { name: true, githubUsername: true } },
          organization: { select: { name: true } },
          _count: { select: { activations: true } },
        },
      });
      if (!invite || invite.deletedAt) return null;
      return {
        memberRole: invite.memberRole,
        maxActivations: invite.maxActivations,
        expiresAt: invite.expiresAt,
        sender: invite.sender,
        organization: invite.organization,
        activationCount: invite._count.activations,
      };
    },

};
