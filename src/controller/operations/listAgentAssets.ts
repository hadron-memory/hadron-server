/**
 * listAgentAssets — list assets belonging to the calling user under
 * the given agent, paginated, optionally filtered by MIME.
 *
 * Spec: spec-kits/specs/004-asset-upload/contracts/controller-api.md
 *
 * Per FR-022: validates caller's access to the agent + memory before
 * any read. Per the spec layout: per-user scoped (the user only sees
 * assets they uploaded). Soft-deleted assets are excluded by default.
 */

import type { Asset, PrismaClient } from '../../generated/prisma/index.js';
import { logAssetEvent } from '../../lib/asset/audit.js';
import { assertAssetToolEnabled } from '../../lib/asset/gate.js';
import { AssetUploadError } from './beginAssetUpload.js';
import type { AssetCallerContext } from './beginAssetUpload.js';

const DEFAULT_COUNT = 20;
const MAX_COUNT = 100;

export interface ListAgentAssetsInput {
  agentUrn: string;
  mimeType?: string;
  skip?: number;
  count?: number;
  includeDeleted?: boolean;
}

export interface ListAgentAssetsResult {
  assets: Asset[];
  total: number;
  hasMore: boolean;
}

export async function listAgentAssets(
  db: PrismaClient,
  caller: AssetCallerContext,
  input: ListAgentAssetsInput,
  resolveTargetMemoryId: (
    db: PrismaClient,
    agentId: string,
    userId: string,
  ) => Promise<{ memoryId: string }>,
): Promise<ListAgentAssetsResult> {
  const skip = Math.max(0, input.skip ?? 0);
  const count = Math.min(MAX_COUNT, Math.max(1, input.count ?? DEFAULT_COUNT));

  const agent = await db.agent.findUnique({
    where: { urn: input.agentUrn },
    select: { id: true, organizationId: true, urn: true },
  });
  if (!agent) throw new AssetUploadError('NOT_FOUND', 'agent not found');

  // Tool gate (same App-by-URN convention as begin / complete).
  const agentApp = await db.app.findFirst({
    where: {
      urn: agent.urn,
      organizationId: agent.organizationId,
      deletedAt: null,
    },
    select: { agentTools: true },
  });
  if (!agentApp) {
    throw new AssetUploadError('NOT_FOUND', 'app for agent not found');
  }
  try {
    assertAssetToolEnabled(agentApp);
  } catch {
    throw new AssetUploadError(
      'TOOL_NOT_ENABLED',
      'asset-upload tool is not enabled for this agent',
    );
  }

  if (caller.appId) {
    const callerApp = await db.app.findUnique({
      where: { id: caller.appId },
      select: { organizationId: true },
    });
    if (!callerApp) {
      throw new AssetUploadError('UNAUTHENTICATED', 'caller app not found');
    }
    if (callerApp.organizationId !== agent.organizationId) {
      throw new AssetUploadError(
        'PERMISSION_DENIED',
        'caller app not in agent organization',
      );
    }
  }

  const { memoryId } = await resolveTargetMemoryId(db, agent.id, caller.userId);

  const where = {
    memoryId,
    uploadedBy: caller.userId,
    ...(input.includeDeleted ? {} : { deletedAt: null }),
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
  };

  const [total, assets] = await Promise.all([
    db.asset.count({ where }),
    db.asset.findMany({
      where,
      orderBy: { uploadedAt: 'desc' },
      skip,
      take: count,
    }),
  ]);

  logAssetEvent({
    operation: 'listed',
    agentId: agent.id,
    memoryId,
    userId: caller.userId,
    appId: caller.appId ?? null,
    count: assets.length,
  });

  return {
    assets,
    total,
    hasMore: skip + assets.length < total,
  };
}
