/**
 * #3917 — the set of AI service configs a caller may read, as a database filter.
 *
 * The id read (`aiServiceConfig(ref:)`) judges one config through
 * `requireAiConfigOwnerAdmin`: platform ADMIN/OWNER for a HadronServer-owned
 * config; org ADMIN/OWNER of the owning org for an org-owned one; for an App- or
 * Agent-owned one, `requireOwnerOrOrgRole(owner, 'ADMIN')` (a user-owned App or
 * Agent is its owner's alone, with no platform-admin bypass, and an impersonated
 * session is never admitted to it), after the Agent read gate (a retired Agent
 * answers as absent).
 *
 * Search must show exactly what that read allows (cor:api:050:02: "any
 * divergence between a global-search hit's visibility and the per-kind read gate"
 * is the invalidator). A gate applied after ranking would leak through `total`
 * and the cap, so this is the same rule written as a filter the adapter puts in
 * the candidate query. Two spellings of one rule can drift, so
 * `globalSearch.aiconf3917.test.ts` runs every owner shape against every caller
 * shape and compares the result with the id read itself.
 */
import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { LIVE_ORG_MEMBERSHIP } from './auth/liveOrgMembership.js';

export interface AiConfigReadScopeInput {
  viewerUserId: string | null;
  isPlatformAdmin: boolean;
  /** The surface's org allow-list: null = unrestricted, a list narrows (member orgs, or the one scoped org). */
  orgIds: string[] | null;
  /** Set when the caller confined the search to one organization. */
  orgScopeId?: string | null;
  /** Set on an impersonated (read-only, one shared org) session. */
  impersonationOrgId?: string | null;
}

/** The orgs where the caller is ADMIN or OWNER (live membership, live org). */
async function adminOrgIdsOf(db: Pick<PrismaClient, 'orgMember'>, userId: string): Promise<string[]> {
  const rows = await db.orgMember.findMany({
    where: { userId, role: { in: ['ADMIN', 'OWNER'] }, ...LIVE_ORG_MEMBERSHIP },
    select: { organizationId: true },
  });
  return rows.map((r) => r.organizationId);
}

/**
 * The filter, or null when the caller can read no config at all (the adapter
 * then returns nothing without a query).
 */
export async function aiConfigReadScope(
  db: Pick<PrismaClient, 'orgMember'>,
  p: AiConfigReadScopeInput,
): Promise<Prisma.AiServiceConfigWhereInput | null> {
  const impersonated = !!p.impersonationOrgId;
  // Impersonation: roles are empty, so the platform short-circuit is inert.
  const platform = p.isPlatformAdmin && !impersonated;
  const confined = p.orgScopeId != null || impersonated;

  // The org allow-list the search may reach: the surface's list intersected with the one scoped org.
  let allowed: string[] | null = p.orgIds;
  if (p.orgScopeId != null) allowed = allowed === null ? [p.orgScopeId] : allowed.filter((id) => id === p.orgScopeId);

  let orgFilter: Prisma.StringFilter | null;
  if (platform) {
    orgFilter = allowed === null ? { not: null as never } : { in: allowed };
  } else {
    if (!p.viewerUserId) return null;
    let admin = await adminOrgIdsOf(db, p.viewerUserId);
    if (allowed !== null) admin = admin.filter((id) => allowed!.includes(id));
    if (impersonated) admin = admin.filter((id) => id === p.impersonationOrgId);
    orgFilter = admin.length > 0 ? { in: admin } : null;
  }

  const arms: Prisma.AiServiceConfigWhereInput[] = [];
  if (orgFilter) {
    // A deleted organization is absent to the id read (resolveOrgRef), so its configs are absent here too.
    const live = { organization: { deletedAt: null } };
    arms.push({ organizationId: orgFilter, ...live });
    arms.push({ app: { ownerUserId: null, deletedAt: null, organizationId: orgFilter, ...live } });
    arms.push({ agent: { ownerUserId: null, deletedAt: null, organizationId: orgFilter, ...live } });
  }
  // A HadronServer-owned config: platform ADMIN/OWNER, and never inside an org-confined search.
  if (platform && p.orgIds === null && !confined) arms.push({ hadronServerId: { not: null } });
  // A user-owned App or Agent is its owner's alone: no platform bypass, no impersonation, no org confinement.
  if (p.viewerUserId && !confined) {
    arms.push({ app: { ownerUserId: p.viewerUserId, deletedAt: null } });
    arms.push({ agent: { ownerUserId: p.viewerUserId, deletedAt: null } });
  }
  return arms.length > 0 ? { OR: arms } : null;
}
