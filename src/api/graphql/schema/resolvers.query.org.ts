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
  requireRole,
  getAccessibleMemoryIds,
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

    users: async (_: unknown, __: unknown, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      return ctx.db.user.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } });
    },

    searchUsers: async (_: unknown, { query }: { query: string }, ctx: Context) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      const q = query.trim();
      // A blank query would make `contains: ''` match every row, re-opening the
      // enumeration path #384 closes — return nothing instead.
      if (q === '') return [];

      // #384: name/email are PII gated to co-members (enforced on output by the
      // User.name/email field resolvers). To stop searchUsers from also being a
      // name/email enumeration oracle for non-co-members, MATCHING is scoped
      // (Spec: cor:acl:070:02): public identifiers (handle, githubUsername)
      // match by substring, email by EXACT equality, and a `name` match counts
      // only for a viewer allowed to see that name (self/admin via platform
      // role, or a co-member). The co-member restriction is pushed INTO the
      // query — not a post-filter — so the `take` cap can't drop a legitimately
      // visible co-member behind a wall of name-only stranger matches.
      const isPlatformAdmin = !!ctx.roles?.some((r) => r === 'ADMIN' || r === 'OWNER');
      const viewerOrgIds = isPlatformAdmin ? [] : await getMemberOrgIds(ctx.db, ctx.userId);
      const nameMatch = isPlatformAdmin
        ? searchContains('name', q)
        : {
            AND: [
              searchContains('name', q),
              // target shares an org with the viewer (so the viewer may see the name)
              { memberships: { some: { organizationId: { in: viewerOrgIds }, deletedAt: null } } },
            ],
          };

      return ctx.db.user.findMany({
        where: {
          deletedAt: null,
          OR: [
            searchContains('handle', q),
            searchContains('githubUsername', q),
            { email: { equals: q, mode: 'insensitive' } },
            nameMatch,
          ],
        },
        take: 20,
        orderBy: { name: 'asc' },
      });
    },

    globalSearch: async (
      _: unknown,
      {
        query,
        entityTypes,
        fields,
        limit,
      }: {
        query: string;
        entityTypes?: SearchEntityType[] | null;
        fields?: SearchField[] | null;
        limit?: number | null;
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
      const orgIds = isPlatformAdmin
        ? null
        : ctx.userId
          ? await getMemberOrgIds(ctx.db, ctx.userId)
          : [];
      const principal: SearchPrincipal = {
        viewerUserId: ctx.userId ?? null,
        isPlatformAdmin,
        accessibleMemoryIds,
        orgIds,
      };
      return runGlobalSearch(ctx.db, { query, entityTypes, fields, limit }, principal);
    },

    me: async (_: unknown, __: unknown, ctx: Context) => {
      if (!ctx.userId) return null;
      return ctx.db.user.findUnique({ where: { id: ctx.userId } });
    },

    organizations: async (_: unknown, __: unknown, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      return ctx.db.organization.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' }, include: ORG_INCLUDE });
    },

    myOrganizations: async (_: unknown, __: unknown, ctx: Context) => {
      if (!ctx.userId) return [];
      const memberships = await ctx.db.orgMember.findMany({
        where: { userId: ctx.userId, deletedAt: null },
        include: { organization: { include: ORG_INCLUDE } },
      });
      return memberships.map((m: any) => m.organization);
    },

    organization: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      // 007-entity-id-or-urn: id may be ID, bare URN, or prefixed URN.
      const { id: resolvedId } = await resolveOrgRef(ctx.db, id);
      if (!ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) {
        if (!ctx.userId) throw new Error('Forbidden');
        const member = await ctx.db.orgMember.findUnique({
          where: { organizationId_userId: { organizationId: resolvedId, userId: ctx.userId } },
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

