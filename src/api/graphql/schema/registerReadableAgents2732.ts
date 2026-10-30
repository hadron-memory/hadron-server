import type { Agent } from '../../../generated/prisma/index.js';
import { LIVE_ORG_MEMBERSHIP } from '../../../lib/auth/liveOrgMembership.js';
import { orgRoleAtLeast } from '../../../lib/auth/orgRole.js';
import { isPlatformAdmin, type Context } from './resolvers.helpers.js';

export type RosterGateAgent = Pick<Agent, 'id' | 'visibility' | 'deletedAt' | 'organizationId' | 'ownerUserId'>;

/**
 * #2732: register's set-wise variant of requireReadableAgent's READER gate.
 * Keep the shared helper and its other callers unchanged. This folds only the
 * live org-membership read; PUBLIC, deletion, platform, strict owner and
 * impersonation arms retain the singular gate's precedence (parity-pinned).
 * The returned predicate is evaluated per Agent BEFORE its root memory gate.
 * A database failure propagates; it never becomes an absent candidate.
 */
export async function registerReadableAgents(
  c: Context,
  agents: Iterable<RosterGateAgent>,
): Promise<(agentId: string) => boolean> {
  const rows = new Map([...agents].map(a => [a.id, a]));
  const platform = isPlatformAdmin(c);
  const orgIds = [...new Set([...rows.values()].flatMap(a =>
    !a.deletedAt && a.visibility !== 'PUBLIC' && a.ownerUserId === null && a.organizationId !== null
      && (!c.impersonation || a.organizationId === c.impersonation.orgId) ? [a.organizationId] : []))];
  const memberships = c.userId && !platform && orgIds.length
    ? await c.db.orgMember.findMany({
        where: { userId: c.userId, organizationId: { in: orgIds }, ...LIVE_ORG_MEMBERSHIP },
        select: { organizationId: true, role: true },
      })
    : [];
  const readableOrgs = new Set(memberships.filter(m => orgRoleAtLeast(m.role, 'READER')).map(m => m.organizationId));
  return (agentId: string): boolean => {
    const a = rows.get(agentId);
    if (!a || a.deletedAt) return false;
    if (a.visibility === 'PUBLIC') return true;
    if (a.ownerUserId !== null) return !c.impersonation && (platform || (!!c.userId && c.userId === a.ownerUserId));
    // The singular owner-or-org helper applies the platform arm before requireOrgRole.
    if (platform) return true;
    return a.organizationId !== null && readableOrgs.has(a.organizationId);
  };
}
