// principalGrant resolvers — individual action grants, the additive half of
// the grant model (design:grant-model, P2b). Management is org-ADMIN,
// interactive-only; the enforcement gate lives in requireOrgAction
// (src/lib/auth/orgAction.ts).
import { GraphQLError } from 'graphql';
import { type Context, clampListTake, toISO, requireOrgRole } from './resolvers.helpers.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { resolveUserRef } from '../../../lib/entityRef/userRef.js';
import { generateId } from '../../../lib/id.js';
import { LIVE_ORG_MEMBERSHIP } from '../../../lib/auth/liveOrgMembership.js';

const badInput = (message: string) =>
  new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

// The grantee and org are projected to SCALARS (id/handle/urn), never as
// nested User/Organization objects, so their field resolvers are unreachable
// through a grant row — the #552 nested-field-leak invariant.
const GRANT_SELECT = {
  id: true,
  principalType: true,
  principalId: true,
  organizationId: true,
  actions: true,
  expiresAt: true,
  createdAt: true,
  principal: { select: { handle: true } },
  organization: { select: { urn: true } },
} as const;

type GrantRow = {
  id: string;
  principalType: string;
  principalId: string;
  organizationId: string;
  actions: string[];
  expiresAt: Date | null;
  createdAt: Date;
  principal: { handle: string | null } | null;
  organization: { urn: string } | null;
};

/** Flatten a selected grant row into the GraphQL PrincipalGrant shape. */
function projectGrant(g: GrantRow) {
  return {
    id: g.id,
    principalType: g.principalType,
    principalId: g.principalId,
    principalHandle: g.principal?.handle ?? null,
    organizationId: g.organizationId,
    organizationUrn: g.organization?.urn ?? null,
    actions: g.actions,
    expiresAt: toISO(g.expiresAt),
    createdAt: toISO(g.createdAt),
  };
}

/**
 * True for an interactive user principal — the only context allowed to
 * MANAGE grants. The App-key / on-behalf-of exclusion is load-bearing: a
 * run on-behalf-of an org admin (which carries both userId AND appId) must
 * not be able to mint a grant that widens what its own later calls may do
 * (the ConnectionGrant self-bootstrap lesson, PR-599 review).
 */
function isInteractiveUser(ctx: Context): boolean {
  // #876 class sweep: the list defaults `principalId` to ctx.userId and
  // applies NO org filter when orgRef is omitted, so under impersonation it
  // returned the target's action grants in every org. Identity-scoped.
  return !!ctx.userId && !ctx.appId && !ctx.impersonation;
}

/** Caller is a live ADMIN/OWNER of the org, or a platform admin. */
async function isOrgAdmin(ctx: Context, orgId: string): Promise<boolean> {
  try {
    await requireOrgRole(ctx, orgId, 'ADMIN');
    return true;
  } catch {
    return false;
  }
}

/**
 * Grant-action entries use the access-control matcher grammar: exact
 * ('memory.clone'), prefix ('memory.*'), or '*'. Validation is
 * shape-level (the vocabulary grows without a server release); unknown
 * exact verbs simply never match a gate's action.
 */
const ACTION_ENTRY = /^(\*|[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*(\.\*)?)$/;

export const principalGrantQueries = {
  // cor:api:120 find-one — visible to the grantee themselves or an
  // ADMIN/OWNER of the grant's org; anyone else gets null (no oracle).
  principalGrant: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    if (!ctx.userId) return null;
    const grant = (await ctx.db.principalGrant.findFirst({
      where: { id: ref, deletedAt: null },
      select: GRANT_SELECT,
    })) as GrantRow | null;
    if (!grant) return null;
    if (grant.principalId !== ctx.userId && !(await isOrgAdmin(ctx, grant.organizationId))) {
      return null;
    }
    return projectGrant(grant);
  },

  // cor:api:120 find-many. Default scope: the caller's OWN grants (self-audit
  // is never gated, cor:acl:060:01). An ADMIN/OWNER of orgRef's org sees the
  // whole org's grants there, optionally narrowed by userRef. A non-admin
  // passing orgRef gets their own grants in that org; an unresolvable orgRef
  // yields an empty page, never an error (no existence oracle, #609).
  principalGrants: async (
    _: unknown,
    {
      orgRef,
      userRef,
      limit,
      offset,
    }: { orgRef?: string | null; userRef?: string | null; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    if (!ctx.userId) return { items: [], total: 0 };

    let orgId: string | null = null;
    if (orgRef) {
      try {
        ({ id: orgId } = await resolveOrgRef(ctx.db, orgRef));
      } catch {
        return { items: [], total: 0 };
      }
    }
    const admin = orgId ? await isOrgAdmin(ctx, orgId) : false;

    let principalId = ctx.userId;
    if (admin && userRef) {
      try {
        ({ id: principalId } = await resolveUserRef(ctx.db, userRef));
      } catch {
        return { items: [], total: 0 };
      }
    }

    const where = {
      deletedAt: null,
      ...(orgId ? { organizationId: orgId } : {}),
      // Org admins see the whole org unless narrowed; everyone else is
      // pinned to their own grants.
      ...(admin && !userRef ? {} : { principalId }),
    };
    const take = clampListTake(limit);
    const skip = Math.max(0, offset ?? 0);
    const [rows, total] = await Promise.all([
      ctx.db.principalGrant.findMany({
        where,
        select: GRANT_SELECT,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      ctx.db.principalGrant.count({ where }),
    ]);
    return { items: (rows as GrantRow[]).map(projectGrant), total };
  },
};

export const principalGrantMutations = {
  // Org-ADMIN create, interactive-only. The grantee must be a live member of
  // the org — a grant is an exception ON TOP of membership, never a way to
  // reach into an org from outside.
  createPrincipalGrant: async (
    _: unknown,
    {
      orgRef,
      userRef,
      actions,
      expiresAt,
    }: { orgRef: string; userRef: string; actions: string[]; expiresAt?: string | null },
    ctx: Context,
  ) => {
    if (!isInteractiveUser(ctx)) {
      throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
    }
    const { id: orgId } = await resolveOrgRef(ctx.db, orgRef);
    await requireOrgRole(ctx, orgId, 'ADMIN');

    if (!Array.isArray(actions) || actions.length === 0) {
      throw badInput('At least one action is required.');
    }
    const invalid = actions.filter((a) => !ACTION_ENTRY.test(a));
    if (invalid.length > 0) {
      throw badInput(
        `Invalid action entry: ${invalid.join(', ')}. Use exact ('memory.clone'), prefix ('memory.*'), or '*'.`,
      );
    }
    const actionSet = [...new Set(actions)];

    const { id: principalId } = await resolveUserRef(ctx.db, userRef);
    const membership = await ctx.db.orgMember.findFirst({
      where: { organizationId: orgId, userId: principalId, ...LIVE_ORG_MEMBERSHIP },
      select: { userId: true },
    });
    if (!membership) {
      throw badInput('The grantee must be a member of the organization.');
    }

    let expiry: Date | null = null;
    if (expiresAt != null) {
      // Require an explicit timezone — a naive string parses in the server's
      // local zone and drifts from the caller's intent (PR-599 review).
      const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
      if (!ISO_8601.test(expiresAt)) {
        throw badInput('expiresAt must be an ISO-8601 timestamp with a timezone (e.g. 2026-01-01T00:00:00Z).');
      }
      const d = new Date(expiresAt);
      if (Number.isNaN(d.getTime())) throw badInput('expiresAt is not a valid date.');
      if (d.getTime() <= Date.now()) throw badInput('expiresAt must be in the future.');
      expiry = d;
    }

    const grant = (await ctx.db.principalGrant.create({
      data: {
        id: generateId(),
        principalType: 'USER',
        principalId,
        organizationId: orgId,
        actions: actionSet,
        expiresAt: expiry,
        createdBy: ctx.userId ?? null,
      },
      select: GRANT_SELECT,
    })) as GrantRow;
    return projectGrant(grant);
  },

  // Org-ADMIN revoke → soft delete. findFirst + deletedAt:null (never
  // findUnique). Absence and lack of authority are indistinguishable.
  revokePrincipalGrant: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    if (!isInteractiveUser(ctx)) {
      throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
    }
    const grant = await ctx.db.principalGrant.findFirst({
      where: { id: ref, deletedAt: null },
      select: { id: true, organizationId: true },
    });
    if (!grant || !(await isOrgAdmin(ctx, grant.organizationId))) {
      throw new GraphQLError('Grant not found', { extensions: { code: 'NOT_FOUND' } });
    }
    await ctx.db.principalGrant.update({
      where: { id: grant.id },
      data: { deletedAt: new Date(), deletedBy: ctx.userId ?? null },
    });
    return true;
  },
};
