/**
 * cor:dmo:050:07 — only an Agent's own org may receive a grant on install.
 * Cross-org installs must already hold an active grant, including PUBLIC
 * marketplace Agents (subscribed through createAgentOrgGrant). Shared by
 * createApp and installAgentIntoApp so their license gates cannot drift.
 */
import { isLifecycleActive } from '@hadron-memory/access-control';
import { GraphQLError } from 'graphql';
import type { PrismaClient } from '../../generated/prisma/index.js';
import { AgentNotFoundError } from '../entityRef/errors.js';

/** The closed reading of an org's licence to an Agent (#2245 amendment 3); never throws for a licence state. */
export type OrgAgentLicense =
  | 'LICENSED'
  | 'SAME_ORG_PROVISIONABLE'
  | 'SAME_ORG_INACTIVE'
  | 'SUBSCRIBABLE'
  | 'FOREIGN_INACTIVE'
  | 'CONCEALED'
  | 'GONE';

/**
 * Classify `orgId`'s licence to `agentId` without throwing. The one place the licence rules live:
 * {@link planOrgAgentInstallGrant} is a wrapper over it, so install, base and clone cannot drift.
 */
export async function classifyOrgAgentLicense(
  db: Pick<PrismaClient, 'agent' | 'agentOrgGrant'>,
  orgId: string,
  agentId: string,
): Promise<OrgAgentLicense> {
  const agent = await db.agent.findUnique({
    where: { id: agentId },
    select: { organizationId: true, visibility: true, deletedAt: true },
  });
  if (!agent || agent.deletedAt) return 'GONE';

  const grant = await db.agentOrgGrant.findUnique({
    where: { orgId_agentId: { orgId, agentId } },
  });
  if (agent.organizationId === orgId) {
    if (grant && !isLifecycleActive(grant)) return 'SAME_ORG_INACTIVE';
    return grant ? 'LICENSED' : 'SAME_ORG_PROVISIONABLE';
  }
  if (grant && isLifecycleActive(grant)) return 'LICENSED';
  if (agent.visibility === 'PUBLIC') return grant ? 'FOREIGN_INACTIVE' : 'SUBSCRIBABLE';
  return 'CONCEALED';
}

/** Return true when the caller may auto-provision a missing same-org grant. */
export async function planOrgAgentInstallGrant(
  db: Pick<PrismaClient, 'agent' | 'agentOrgGrant'>,
  orgId: string,
  agentId: string,
  ref: string,
  dependency = false,
): Promise<boolean> {
  const license = await classifyOrgAgentLicense(db, orgId, agentId);
  const unavailable = () => new GraphQLError('An Agent dependency is unavailable for installation.', { extensions: { code: 'AGENT_DEPENDENCY_UNAVAILABLE' } });
  switch (license) {
    case 'LICENSED':
      return false;
    case 'SAME_ORG_PROVISIONABLE':
      return true;
    case 'SAME_ORG_INACTIVE':
      throw new GraphQLError('This organization’s Agent grant is inactive.', { extensions: { code: 'AGENT_ORG_GRANT_INACTIVE' } });
    case 'FOREIGN_INACTIVE':
      throw new GraphQLError('This organization’s Agent grant is inactive.', { extensions: { code: 'AGENT_ORG_GRANT_INACTIVE' } });
    case 'SUBSCRIBABLE':
      throw new GraphQLError('Subscribe this organization to the PUBLIC Agent before installing it.', {
        extensions: { code: 'AGENT_ORG_GRANT_REQUIRED' },
      });
    case 'GONE':
      if (dependency) throw unavailable();
      throw new AgentNotFoundError(ref);
    case 'CONCEALED':
      // A non-public foreign Agent is concealed from an org with no active
      // license. Do not expose its id or the dependency's identity in the error.
      if (dependency) throw unavailable();
      throw new AgentNotFoundError(ref);
  }
}
