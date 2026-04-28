// setAgentAssetUploadEnabled — toggle "asset:upload" in App.agent_tools.
// Org admin only.
//
// Spec: hadron-portal/specs/001-asset-upload/contracts/graphql.md

import type { PrismaClient, App } from '../../generated/prisma/index.js';
import type { AppContext } from './beginAssetUpload.js';
import { AssetUploadError } from './beginAssetUpload.js';

const TOOL_KEY = 'asset:upload';

export interface SetAgentAssetUploadEnabledInput {
  agentUrn: string;
  enable: boolean;
}

export async function setAgentAssetUploadEnabled(
  db: PrismaClient,
  caller: AppContext,
  input: SetAgentAssetUploadEnabledInput,
  isAdminFor: (
    db: PrismaClient,
    userId: string,
    organizationId: string,
  ) => Promise<boolean>,
): Promise<App> {
  const agent = await db.agent.findUnique({
    where: { urn: input.agentUrn },
    select: { id: true, organizationId: true, urn: true },
  });
  if (!agent) throw new AssetUploadError('NOT_FOUND', 'agent not found');

  const isAdmin = await isAdminFor(db, caller.userId, agent.organizationId);
  if (!isAdmin) {
    throw new AssetUploadError('PERMISSION_DENIED', 'admin role required');
  }

  // Find the App that backs this agent's caller-identity. Convention: same
  // urn as the agent. If multiple apps reference the same agent via
  // AppAgent links, this toggle applies to the agent's own App row.
  const app = await db.app.findFirst({
    where: { urn: agent.urn, organizationId: agent.organizationId, deletedAt: null },
  });
  if (!app) throw new AssetUploadError('NOT_FOUND', 'app for agent not found');

  const has = app.agentTools.includes(TOOL_KEY);
  if (input.enable === has) return app;

  const next = input.enable
    ? [...app.agentTools, TOOL_KEY]
    : app.agentTools.filter((t) => t !== TOOL_KEY);

  return db.app.update({
    where: { id: app.id },
    data: { agentTools: next },
  });
}
