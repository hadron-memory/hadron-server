import type { PrismaClient } from '../../generated/prisma/index.js';

/**
 * Field-level user-visibility rules — hadron-server#384.
 *
 * What fields of a *target* user a *viewer* may see depends on their
 * relationship:
 *
 *   | Field           | any auth user | co-member | co-member + viewer ADMIN/OWNER of shared org |
 *   |-----------------|:-------------:|:---------:|:--------------------------------------------:|
 *   | id/handle/urn   |       ✓       |     ✓     |                      ✓                       |
 *   | name / email    |       –       |     ✓     |                      ✓                       |
 *   | role (in org)   |       –       |     –     |                      ✓                       |
 *
 * `id`, `handle`, and the derived `urn` (and thus the client-derived
 * profile link) are always visible. The viewer always sees their own
 * full record; a platform ADMIN/OWNER sees everyone's. Suppressed
 * fields are returned as `null`, never an error.
 *
 * This module is the single source of truth applied by every `User`
 * projection — the `User.name` / `User.email` field resolvers,
 * `OrgMember.role`, and the global-search user adapter — so the rule
 * is enforced server-side for every consumer (portal, MCP, future
 * clients) instead of per-endpoint.
 */

/**
 * The viewer side of a visibility check. Both the GraphQL resolver
 * `Context` and small ad-hoc objects (e.g. the global-search adapter)
 * satisfy this. The object identity also keys a per-request memo, so
 * pass the *same* object across a request to share cached lookups.
 */
export interface UserVisibilityCtx {
  db: PrismaClient;
  userId?: string;
  roles?: readonly string[];
}

const ELEVATED = new Set(['ADMIN', 'OWNER']);

function isPlatformAdmin(ctx: UserVisibilityCtx): boolean {
  return !!ctx.roles?.some((r) => ELEVATED.has(r));
}

// Per-request memo keyed by the viewer object (Apollo passes one
// `contextValue` per request, so a `searchUsers` page sharing 40
// name/email resolver calls collapses to a single membership query
// per distinct target). GC'd with the ctx object.
interface Memo {
  viewerOrgIds?: Promise<string[]>;
  shares: Map<string, Promise<boolean>>;
  roleInOrg: Map<string, Promise<string | null>>;
}
const memos = new WeakMap<object, Memo>();
function memoFor(ctx: UserVisibilityCtx): Memo {
  let m = memos.get(ctx);
  if (!m) {
    m = { shares: new Map(), roleInOrg: new Map() };
    memos.set(ctx, m);
  }
  return m;
}

function viewerOrgIds(ctx: UserVisibilityCtx, viewerId: string): Promise<string[]> {
  const memo = memoFor(ctx);
  if (!memo.viewerOrgIds) {
    memo.viewerOrgIds = ctx.db.orgMember
      .findMany({ where: { userId: viewerId, deletedAt: null }, select: { organizationId: true } })
      .then((rows) => rows.map((r) => r.organizationId));
  }
  return memo.viewerOrgIds;
}

function sharesOrgWith(ctx: UserVisibilityCtx, viewerId: string, targetUserId: string): Promise<boolean> {
  const memo = memoFor(ctx);
  let p = memo.shares.get(targetUserId);
  if (!p) {
    p = (async () => {
      const orgIds = await viewerOrgIds(ctx, viewerId);
      if (orgIds.length === 0) return false;
      const row = await ctx.db.orgMember.findFirst({
        where: { userId: targetUserId, organizationId: { in: orgIds }, deletedAt: null },
        select: { userId: true },
      });
      return row !== null;
    })();
    memo.shares.set(targetUserId, p);
  }
  return p;
}

function viewerRoleInOrg(ctx: UserVisibilityCtx, viewerId: string, orgId: string): Promise<string | null> {
  const memo = memoFor(ctx);
  let p = memo.roleInOrg.get(orgId);
  if (!p) {
    p = ctx.db.orgMember
      .findFirst({
        where: { userId: viewerId, organizationId: orgId, deletedAt: null },
        select: { role: true },
      })
      .then((r) => r?.role ?? null);
    memo.roleInOrg.set(orgId, p);
  }
  return p;
}

/**
 * Whether `ctx`'s viewer may see the target user's `name` and `email`.
 * Visible to: the user themselves, platform admins, and any viewer who
 * shares an organization with the target. Otherwise `false`.
 */
export async function canSeeUserPersonalFields(
  ctx: UserVisibilityCtx,
  targetUserId: string | null | undefined,
): Promise<boolean> {
  if (!targetUserId) return false;
  if (ctx.userId && ctx.userId === targetUserId) return true; // self
  if (isPlatformAdmin(ctx)) return true;
  if (!ctx.userId) return false; // unauthenticated / App-Key caller
  return sharesOrgWith(ctx, ctx.userId, targetUserId);
}

/**
 * Whether `ctx`'s viewer may see the target member's role *within the
 * given org*. Visible to: the member themselves, platform admins, and
 * co-members whose own role in that org is ADMIN or OWNER.
 */
export async function canSeeOrgMemberRole(
  ctx: UserVisibilityCtx,
  member: { userId: string; organizationId: string },
): Promise<boolean> {
  if (ctx.userId && ctx.userId === member.userId) return true; // own role
  if (isPlatformAdmin(ctx)) return true;
  if (!ctx.userId) return false;
  const role = await viewerRoleInOrg(ctx, ctx.userId, member.organizationId);
  return role != null && ELEVATED.has(role);
}
