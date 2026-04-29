/**
 * beginAssetUpload — mint a presigned PUT URL for a direct-to-R2
 * upload and stash the upload metadata in the registry so
 * completeAssetUpload can validate the bytes that landed.
 *
 * Spec: spec-kits/specs/004-asset-upload/contracts/controller-api.md
 * Per FR-008: validates caller's access to the target agent + memory
 * before minting the presigned URL.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../../lib/id.js';
import { buildStorageKey } from '../../lib/asset/storageKey.js';
import { getEffectiveLimits } from '../../lib/asset/limits.js';
import { recordUpload } from '../../lib/asset/uploadRegistry.js';
import { logAssetEvent } from '../../lib/asset/audit.js';
import { assertAssetToolEnabled } from '../../lib/asset/gate.js';
import { mintPutUrl } from '../../integrations/r2/client.js';

const PRESIGN_TTL_SECONDS = 5 * 60;

export type UploadIntent = 'USER' | 'AGENT_REQUEST';

export interface BeginAssetUploadInput {
  agentUrn: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  description?: string;
  uploadIntent: UploadIntent;
  uploadRequestId?: string;
}

/**
 * Caller identity. `appId` is the App that authenticated (if any —
 * portal JWT users have no appId). The user is always present.
 */
export interface AssetCallerContext {
  appId?: string;
  userId: string;
}

export interface AssetUploadTicket {
  uploadId: string;
  putUrl: string;
  putHeaders: Array<{ name: string; value: string }>;
  expiresAt: Date;
  storageKey: string;
  maxSizeBytes: number;
  allowedMimeType: string;
}

export class AssetUploadError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'AssetUploadError';
  }
}

export async function beginAssetUpload(
  db: PrismaClient,
  caller: AssetCallerContext,
  input: BeginAssetUploadInput,
  resolveTargetMemoryId: (
    db: PrismaClient,
    agentId: string,
    userId: string,
  ) => Promise<{ memoryId: string }>,
): Promise<AssetUploadTicket> {
  if (input.uploadIntent === 'AGENT_REQUEST' && !input.uploadRequestId) {
    throw new AssetUploadError(
      'INVALID_INPUT',
      'uploadRequestId required when uploadIntent=AGENT_REQUEST',
    );
  }

  const agent = await db.agent.findUnique({
    where: { urn: input.agentUrn },
    select: {
      id: true,
      organizationId: true,
      urn: true,
      organization: { select: { urn: true } },
    },
  });
  if (!agent) throw new AssetUploadError('NOT_FOUND', 'agent not found');

  // Resolve the App that backs this agent. The asset-upload tool gate
  // lives on this App's `agentTools`. Convention: same URN as the agent.
  const agentApp = await db.app.findFirst({
    where: {
      urn: agent.urn,
      organizationId: agent.organizationId,
      deletedAt: null,
    },
    select: { id: true, agentTools: true, organizationId: true },
  });
  if (!agentApp) {
    throw new AssetUploadError(
      'NOT_FOUND',
      'app for agent not found — cannot resolve tool gate',
    );
  }

  // FR-021 — TOOL_NOT_ENABLED unless the agent's App has the
  // asset-upload tool in its allowlist.
  try {
    assertAssetToolEnabled(agentApp);
  } catch {
    throw new AssetUploadError(
      'TOOL_NOT_ENABLED',
      'asset-upload tool is not enabled for this agent',
    );
  }

  // If the caller authenticated as an App, validate org match.
  // Portal JWT users (no appId) are gated by the agent's App's
  // tool allowlist plus their access to the target memory.
  if (caller.appId) {
    const callerApp = await db.app.findUnique({
      where: { id: caller.appId },
      select: { id: true, organizationId: true },
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

  // FR-006 — size + MIME pinned by the presigned policy. Validated
  // here before minting; verified again on completion via HeadObject.
  const limits = getEffectiveLimits(null);
  if (input.sizeBytes > limits.maxBytes) {
    throw new AssetUploadError(
      'SIZE_EXCEEDED',
      `sizeBytes ${input.sizeBytes} exceeds cap ${limits.maxBytes}`,
    );
  }
  if (!limits.allowedMimeTypes.includes(input.mimeType)) {
    throw new AssetUploadError(
      'MIME_NOT_ALLOWED',
      `mimeType "${input.mimeType}" not in agent allowlist`,
    );
  }

  const { memoryId } = await resolveTargetMemoryId(db, agent.id, caller.userId);
  const memory = await db.memory.findUniqueOrThrow({
    where: { id: memoryId },
    select: { urn: true },
  });

  const assetId = generateId();
  const storageKey = buildStorageKey({
    orgUrn: agent.organization.urn,
    memoryUrn: memory.urn,
    assetId,
    filename: input.filename,
  });

  const putUrl = await mintPutUrl({
    key: storageKey,
    contentType: input.mimeType,
    contentLength: input.sizeBytes,
    ttlSeconds: PRESIGN_TTL_SECONDS,
  });

  const uploadId = generateId();
  const expiresAt = new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000);

  recordUpload({
    uploadId,
    assetId,
    storageKey,
    filename: input.filename,
    mimeType: input.mimeType,
    expectedSizeBytes: input.sizeBytes,
    description: input.description,
    agentId: agent.id,
    memoryId,
    appId: caller.appId ?? null,
    userId: caller.userId,
    uploadIntent: input.uploadIntent,
    uploadRequestId: input.uploadRequestId,
    expiresAt: expiresAt.getTime(),
  });

  logAssetEvent({
    operation: 'upload-requested',
    assetId,
    agentId: agent.id,
    memoryId,
    userId: caller.userId,
    appId: caller.appId ?? null,
    bytes: input.sizeBytes,
  });

  return {
    uploadId,
    putUrl,
    putHeaders: [
      { name: 'Content-Type', value: input.mimeType },
      { name: 'Content-Length', value: String(input.sizeBytes) },
    ],
    expiresAt,
    storageKey,
    maxSizeBytes: limits.maxBytes,
    allowedMimeType: input.mimeType,
  };
}
