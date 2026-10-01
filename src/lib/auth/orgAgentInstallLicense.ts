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

/** Return true when the caller may auto-provision a missing same-org grant. */
export async function planOrgAgentInstallGrant(
  db: Pick<PrismaClient, 'agent' | 'agentOrgGrant'>,
  orgId: string,
  agentId: string,
  ref: string,
  dependency = false,
): Promise<boolean> {
  const agent = await db.agent.findUnique({
    where: { id: agentId },
    select: { organizationId: true, visibility: true, deletedAt: true },
  });
  if (!agent || agent.deletedAt) {
    if (dependency) throw new GraphQLError('An Agent dependency is unavailable for installation.', { extensions: { code: 'AGENT_DEPENDENCY_UNAVAILABLE' } });
    throw new AgentNotFoundError(ref);
  }

  const grant = await db.agentOrgGrant.findUnique({
    where: { orgId_agentId: { orgId, agentId } },
  });
  if (agent.organizationId === orgId) {
    if (grant && !isLifecycleActive(grant)) {
      throw new GraphQLError('This organization’s Agent grant is inactive.', { extensions: { code: 'AGENT_ORG_GRANT_INACTIVE' } });
    }
    return !grant;
  }
  if (grant && isLifecycleActive(grant)) return false;

  if (agent.visibility === 'PUBLIC') {
    if (grant) {
      throw new GraphQLError('This organization’s Agent grant is inactive.', {
        extensions: { code: 'AGENT_ORG_GRANT_INACTIVE' },
      });
    }
    throw new GraphQLError('Subscribe this organization to the PUBLIC Agent before installing it.', {
      extensions: { code: 'AGENT_ORG_GRANT_REQUIRED' },
    });
  }
  // A non-public foreign Agent is concealed from an org with no active
  // license. Do not expose its id or the dependency's identity in the error.
  if (dependency) throw new GraphQLError('An Agent dependency is unavailable for installation.', { extensions: { code: 'AGENT_DEPENDENCY_UNAVAILABLE' } });
  throw new AgentNotFoundError(ref);
}
