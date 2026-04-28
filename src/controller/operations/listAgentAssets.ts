// listAgentAssets — list assets uploaded by the calling user under the
// given agent. Per-user-scoped (FR-014); soft-deleted assets are excluded.
//
// Spec: hadron-portal/specs/001-asset-upload/contracts/graphql.md

import type { PrismaClient, Node } from '../../generated/prisma/index.js';
import { decryptNodeFields, getMemoryEncryptionInfo } from '../../lib/nodeCrypto.js';
import { deserializeJson } from '../../integrations/db/provider.js';
import { logAssetEvent } from '../../lib/asset/audit.js';
import type { AppContext } from './beginAssetUpload.js';
import { AssetUploadError } from './beginAssetUpload.js';

export interface ListAgentAssetsInput {
  agentUrn: string;
  mimeType?: string;
  skip?: number;
  count?: number;
}

export interface ListAgentAssetsResult {
  assets: Node[];
  total: number;
  hasMore: boolean;
}

export async function listAgentAssets(
  db: PrismaClient,
  caller: AppContext,
  input: ListAgentAssetsInput,
  resolveTargetMemoryId: (
    db: PrismaClient,
    agentId: string,
    userId: string,
  ) => Promise<{ memoryId: string }>,
): Promise<ListAgentAssetsResult> {
  const skip = Math.max(0, input.skip ?? 0);
  const count = Math.min(100, Math.max(1, input.count ?? 20));

  const agent = await db.agent.findUnique({
    where: { urn: input.agentUrn },
    select: { id: true, organizationId: true },
  });
  if (!agent) throw new AssetUploadError('NOT_FOUND', 'agent not found');

  const app = await db.app.findUnique({
    where: { id: caller.appId },
    select: { organizationId: true, agentTools: true },
  });
  if (!app) throw new AssetUploadError('UNAUTHENTICATED', 'app not found');
  if (app.organizationId !== agent.organizationId) {
    throw new AssetUploadError('PERMISSION_DENIED', 'app not in agent organization');
  }
  if (!app.agentTools.includes('asset:upload')) {
    throw new AssetUploadError('PERMISSION_DENIED', 'asset:upload not enabled');
  }

  const { memoryId } = await resolveTargetMemoryId(db, agent.id, caller.userId);
  const memoryEnc = await getMemoryEncryptionInfo(db, memoryId);

  const where = {
    memoryId,
    nodeType: 'asset',
    deletedAt: null,
    createdBy: caller.userId,
  };

  const [total, rows] = await Promise.all([
    db.node.count({ where }),
    db.node.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: count,
    }),
  ]);

  // Decrypt + filter soft-deleted by data.deletedAt + apply mime filter.
  const visible: Node[] = [];
  for (const row of rows) {
    decryptNodeFields(row, memoryEnc);
    const data = deserializeData(row.data);
    if (data?.deletedAt) continue;
    if (input.mimeType && data?.mimeType !== input.mimeType) continue;
    visible.push({ ...row, data: data as never });
  }

  logAssetEvent({
    operation: 'listed',
    agentId: agent.id,
    memoryId,
    userId: caller.userId,
    appId: caller.appId,
    count: visible.length,
  });

  return {
    assets: visible,
    total,
    hasMore: skip + rows.length < total,
  };
}

function deserializeData(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = deserializeJson(raw);
      return (parsed as Record<string, unknown>) ?? null;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  return null;
}
