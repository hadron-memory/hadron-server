// orgQueries — extracted from resolvers.ts Query (split step 3). No behavior change.
import { parseUrnInput } from '../../../lib/urn.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveNodeRef } from '../../../lib/entityRef/nodeRef.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { resolveUserRef } from '../../../lib/entityRef/userRef.js';
import { UserNotFoundError } from '../../../lib/entityRef/errors.js';
import {
  resolveResource as resolveAccessResource,
  callerCanAudit,
  computeEffectiveAccess,
} from '../../../lib/auth/effectiveAccess.js';
import {
  globalSearch as runGlobalSearch,
  type SearchEntityType,
  type SearchField,
  type SearchPrincipal,
} from '../../../lib/global-search/index.js';
import { getMemberOrgIds } from '../../../lib/auth/memberOrgIds.js';
import { GraphQLError } from 'graphql';
import { searchContains } from '../../../integrations/db/provider.js';
import {
  type Context,
  clampListTake,
  getAccessibleMemoryIds,
  resolveOrgScope,
  ORG_INCLUDE,
} from './resolvers.helpers.js';

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

      // Who may CALL this — the same visibility bar as the underlying grant
      // tables. A non-privileged caller gets FORBIDDEN, never a silent empty
      // result, so the audit command can't probe access it isn't allowed to.
      //
      // Self-audit is always allowed (issue #364): a user auditing their OWN
      // effective access learns nothing they couldn't already infer by trying
      // the operation, so there's no info-leak. Every other (cross-subject)
      // case stays gated by callerCanAudit exactly as before.
      const isSelfAudit = !!ctx.userId && subjectUser.id === ctx.userId;
      if (
        !isSelfAudit &&
        !(await callerCanAudit(ctx.db, { userId: ctx.userId, roles: ctx.roles }, resolved))
      ) {
        throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
      }

      const result = await computeEffectiveAccess(
        ctx.db,
        { id: subjectUser.id, roles: subjectUser.roles },
        resolved,
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
            organization: { members: { some: { userId: id, deletedAt: null } } },
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

      const viewerOrgIds = isPlatformAdmin ? [] : await getMemberOrgIds(ctx.db, ctx.userId!);
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
        orgId,
        limit,
        offset,
      }: {
        query: string;
        entityTypes?: SearchEntityType[] | null;
        fields?: SearchField[] | null;
        orgId?: string | null;
        limit?: number | null;
        offset?: number | null;
      },
      ctx: Context,
    ) => {
      // Build the access principal from ctx using the SAME gates as the
      // per-kind queries, so a global hit can never reach something the caller
      // couldn't open directly. getAccessibleMemoryIds already carves out other
      // users' personal/private (even for admin); getMemberOrgIds scopes the
      // org-rooted slices. App-Key callers (no userId) get no org-read → [].
      const isPlatformAdmin = !!ctx.roles?.includes('ADMIN') || !!ctx.roles?.includes('OWNER');
      const accessibleMemoryIds = await getAccessibleMemoryIds(ctx);
      // The caller's member orgs (admin included) — both the default org scope
      // for non-admins and the membership gate for orgId. Computed once.
      const callerOrgIds = ctx.userId ? await getMemberOrgIds(ctx.db, ctx.userId) : [];
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
        if (!callerOrgIds.includes(resolvedOrgId)) {
          return { hits: [], total: 0, degraded: [] };
        }
        orgIds = [resolvedOrgId];
        orgScopeId = resolvedOrgId;
      }

      const principal: SearchPrincipal = {
        viewerUserId: ctx.userId ?? null,
        isPlatformAdmin,
        accessibleMemoryIds,
        orgIds,
        orgScopeId,
      };
      return runGlobalSearch(ctx.db, { query, entityTypes, fields, limit, offset }, principal);
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
        // #609: `isVisible` is a listing-visibility flag — a hidden org
        // (`isVisible === false`, e.g. an un-activated personal org) must not
        // surface in ANY user's org listing, platform admins included. Admin
        // reach is every listable org (`isVisible` true or null — Prisma
        // `not: false` includes nulls) PLUS the admin's own memberships (so a
        // converted/hidden org they belong to still resolves for them). This is
        // a listing filter, NOT an access gate: members still read hidden orgs
        // directly via `organization(ref:)`.
        const memberOrgIds = ctx.userId ? await getMemberOrgIds(ctx.db, ctx.userId) : [];
        where = {
          deletedAt: null,
          OR: [{ isVisible: { not: false } }, { id: { in: memberOrgIds } }],
        };
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
      if (!ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) {
        if (!ctx.userId) throw new Error('Forbidden');
        const member = await ctx.db.orgMember.findFirst({
          where: { organizationId: resolvedId, userId: ctx.userId, deletedAt: null },
        });
        if (!member) throw new Error('Forbidden');
      }
      return ctx.db.organization.findUnique({ where: { id: resolvedId }, include: ORG_INCLUDE });
    },

    invitation: async (_: unknown, { slug }: { slug: string }, ctx: Context) => {
      const invite = await ctx.db.userInvitation.findUnique({
        where: { slug },
        include: {
          sender: true,
          organization: true,
          activations: true,
        },
      });
      if (!invite || invite.deletedAt) return null;
      return {
        ...invite,
        activationCount: invite.activations.length,
      };
    },

};

