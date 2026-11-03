/**
 * setAgentAssetUploadEnabled — toggle the asset-upload tool key in
 * the App.agentTools allowlist for the App that backs an Agent.
 *
 * Per spec 004-asset-upload FR-020: opt-in per agent, default off.
 * Convention: an Agent's caller-identity App shares the same URN as
 * the Agent. If multiple Apps subscribe to one Agent via AppAgent,
 * this toggle applies to the Agent's own App row.
 *
 * Authorization: org admin only.
 */

import type { App, PrismaClient } from '../../generated/prisma/index.js';
import { ASSET_UPLOAD_TOOL_KEY } from '../../lib/asset/gate.js';
import { resolveAgentRef } from '../../lib/entityRef/agentRef.js';
import { AgentNotFoundError, AmbiguousLegacyUrnError } from '../../lib/entityRef/errors.js';
import { UrnNotQualifiedError } from '../../lib/urn.js';

export class SetAssetEnabledError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'SetAssetEnabledError';
  }
}

export interface SetAgentAssetUploadEnabledCaller {
  userId: string;
}

export interface SetAgentAssetUploadEnabledInput {
  agentUrn: string;
  enabled: boolean;
}

/** Caller-supplied admin check. Allows the route layer to plug in
    its own resolution (org-member admin role, platform admin, etc.). */
export type IsAdminFor = (
  db: PrismaClient,
  userId: string,
  organizationId: string,
) => Promise<boolean>;

export async function setAgentAssetUploadEnabled(
  db: PrismaClient,
  caller: SetAgentAssetUploadEnabledCaller,
  input: SetAgentAssetUploadEnabledInput,
  isAdminFor: IsAdminFor,
): Promise<App> {
  // 007-entity-id-or-urn FR-012: input.agentUrn (named for backward
  // compatibility) accepts ID or URN. Resolve to a definite ID first.
  //
  // Spec 022: `resolveAgentRef` throws `UrnNotQualifiedError` for non-ID
  // inputs that lack the `<org>:<agentSlug>` shape — let it propagate so
  // the GraphQL formatError can surface it as `URN_NOT_QUALIFIED`.
  let resolvedAgentId: string;
  try {
    ({ id: resolvedAgentId } = await resolveAgentRef(db, input.agentUrn));
  } catch (e) {
    if (e instanceof UrnNotQualifiedError) throw e;
    // #2979 (Atilla's P2): NARROW. This class is a trusted typed refusal on the wire, so only a ref that names nothing
    // (or an ambiguous legacy one) may become NOT_FOUND; an outage must stay a fault. Same set as the resolver's gate.
    if (e instanceof AgentNotFoundError || e instanceof AmbiguousLegacyUrnError) {
      throw new SetAssetEnabledError('NOT_FOUND', 'agent not found');
    }
    throw e;
  }
  const agent = await db.agent.findUnique({
    where: { id: resolvedAgentId },
    select: { id: true, organizationId: true, urn: true },
  });
  if (!agent) {
    throw new SetAssetEnabledError('NOT_FOUND', 'agent not found');
  }
  if (!agent.organizationId) {
    // isAdminFor is an org-admin check — not yet modeled for a user-owned agent.
    throw new SetAssetEnabledError('NOT_FOUND', 'asset-upload toggle is not supported for a user-owned agent yet');
  }

  const isAdmin = await isAdminFor(db, caller.userId, agent.organizationId);
  if (!isAdmin) {
    throw new SetAssetEnabledError('PERMISSION_DENIED', 'admin role required');
  }

  // The App that backs this agent's caller-identity. Convention: same
  // urn as the agent. Multi-App-per-Agent setups require a future
  // schema/UX change (which App's gate are we toggling?). For v1,
  // single-App-per-Agent is the supported model.
  const app = await db.app.findFirst({
    where: {
      urn: agent.urn,
      organizationId: agent.organizationId,
      deletedAt: null,
    },
  });
  if (!app) {
    throw new SetAssetEnabledError('NOT_FOUND', 'app for agent not found');
  }

  const has = app.agentTools.includes(ASSET_UPLOAD_TOOL_KEY);
  if (input.enabled === has) return app;

  const next = input.enabled
    ? [...app.agentTools, ASSET_UPLOAD_TOOL_KEY]
    : app.agentTools.filter((t) => t !== ASSET_UPLOAD_TOOL_KEY);

  return db.app.update({
    where: { id: app.id },
    data: { agentTools: next },
  });
}
