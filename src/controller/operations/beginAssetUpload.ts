// beginAssetUpload — mint a presigned PUT URL for a direct-to-R2 upload and
// stash the upload metadata in the registry so completeAssetUpload can
// validate the bytes that landed.
//
// Spec: hadron-portal/specs/001-asset-upload/contracts/graphql.md
//       hadron-portal/specs/001-asset-upload/research.md §R-002

import type { PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../../lib/id.js';
import { buildStorageKey } from '../../lib/asset/storageKey.js';
import { getEffectiveLimits } from '../../lib/asset/limits.js';
import { recordUpload } from '../../lib/asset/uploadRegistry.js';
import { logAssetEvent } from '../../lib/asset/audit.js';
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

export interface AppContext {
  appId: string;
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
  caller: AppContext,
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
      organization: { select: { urn: true } },
    },
  });
  if (!agent) throw new AssetUploadError('NOT_FOUND', 'agent not found');

  const app = await db.app.findUnique({
    where: { id: caller.appId },
    select: { id: true, organizationId: true, agentTools: true, properties: true },
  });
  if (!app) throw new AssetUploadError('UNAUTHENTICATED', 'app not found');
  if (app.organizationId !== agent.organizationId) {
    throw new AssetUploadError('PERMISSION_DENIED', 'app not in agent organization');
  }
  // Spec FR-009: agent-initiated requests need the explicit asset:upload
  // opt-in. User-initiated uploads (paperclip composer) are always allowed
  // for the calling user — they're attaching to their own per-user memory.
  if (
    input.uploadIntent === 'AGENT_REQUEST' &&
    !app.agentTools.includes('asset:upload')
  ) {
    throw new AssetUploadError(
      'PERMISSION_DENIED',
      'asset:upload not enabled for this agent',
    );
  }

  const limits = getEffectiveLimits(app.properties);
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
    appId: app.id,
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
    appId: app.id,
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
