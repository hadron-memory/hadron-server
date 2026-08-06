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
import {
  assertAssetToolEnabled,
  assertMemoryAcceptsUploads,
  MemoryNotAcceptingUploadsError,
  MemoryNotFoundError,
} from '../../lib/asset/gate.js';
import { canWriteToMemory } from '../../mcp/access-control.js';
import type { AuthContext } from '../../middleware/auth.js';
import { resolveAgentRef } from '../../lib/entityRef/agentRef.js';
import { resolveMemoryRef } from '../../lib/entityRef/memoryRef.js';
import { UrnNotQualifiedError } from '../../lib/urn.js';
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

  // 007-entity-id-or-urn FR-012: input.agentUrn (named for v1 BC)
  // accepts ID or URN. Resolve before lookup.
  let resolvedAgentId: string;
  try {
    ({ id: resolvedAgentId } = await resolveAgentRef(db, input.agentUrn));
  } catch {
    throw new AssetUploadError('NOT_FOUND', 'agent not found');
  }
  const agent = await db.agent.findUnique({
    where: { id: resolvedAgentId },
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

  // 006-asset-upload-redesign FR-009: enforce per-Memory acceptance gate
  // on v1 paths too. Memories with acceptsUploads=false reject uploads
  // regardless of which agent the caller is invoking.
  try {
    await assertMemoryAcceptsUploads(db, memoryId);
  } catch (e) {
    if (e instanceof MemoryNotAcceptingUploadsError) {
      throw new AssetUploadError('MEMORY_NOT_ACCEPTING_UPLOADS', e.message);
    }
    if (e instanceof MemoryNotFoundError) {
      throw new AssetUploadError('NOT_FOUND', 'target memory not found');
    }
    throw e;
  }

  const memory = await db.memory.findUniqueOrThrow({
    where: { id: memoryId },
    select: { urn: true },
  });

  const assetId = generateId();
  const storageKey = buildStorageKey({
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

// ──────────────────────────────────────────────────────────────────────
// v2 — memory-addressed surface (spec 006).
// ──────────────────────────────────────────────────────────────────────

export interface BeginAssetUploadV2Input {
  memoryId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  description?: string;
  uploadIntent: UploadIntent;
  uploadRequestId?: string;
}

/**
 * v2 caller context — extended with the fields canWriteToMemory needs
 * (roles + organizationId) so the controller can check write access
 * against the memory directly, without traversing an agent's gate.
 */
export interface AssetCallerContextV2 extends AssetCallerContext {
  roles?: AuthContext['roles'];
  organizationId?: string;
}

/**
 * beginAssetUploadV2 — memory-addressed begin per spec 006.
 *
 * Caller specifies the destination memory directly. The controller:
 *   1. Validates the memory exists.
 *   2. Validates the caller has write access to it (zero-trust check
 *      per Constitution Principle V).
 *   3. Validates the memory accepts uploads (`Memory.acceptsUploads = true`).
 *   4. Validates size + MIME against effective limits.
 *   5. Builds the storage key, mints the presigned PUT, records the
 *      upload registry, returns the ticket.
 *
 * No agent traversal — v2's whole point is decoupling from agents.
 * `agentId` on the registry entry is null on this path.
 */
export async function beginAssetUploadV2(
  db: PrismaClient,
  caller: AssetCallerContextV2,
  input: BeginAssetUploadV2Input,
): Promise<AssetUploadTicket> {
  if (input.uploadIntent === 'AGENT_REQUEST' && !input.uploadRequestId) {
    throw new AssetUploadError(
      'INVALID_INPUT',
      'uploadRequestId required when uploadIntent=AGENT_REQUEST',
    );
  }

  // 007-entity-id-or-urn: input.memoryId may be a raw ID, a bare URN,
  // or a prefixed URN. Resolve to a definite ID before any subsequent
  // checks so all branches operate on a consistent shape.
  //
  // Spec 022: `resolveMemoryRef` throws `UrnNotQualifiedError` for non-ID
  // inputs that lack the `<org>:<memory>` shape — let it propagate so the
  // GraphQL formatError can surface it as `URN_NOT_QUALIFIED`. Genuine
  // not-found errors (and other shape failures) still become NOT_FOUND.
  let memoryId: string;
  try {
    ({ id: memoryId } = await resolveMemoryRef(db, input.memoryId));
  } catch (e) {
    if (e instanceof UrnNotQualifiedError) throw e;
    throw new AssetUploadError('NOT_FOUND', 'memory not found');
  }

  // 1. Memory existence (already verified by resolveMemoryRef) +
  //    2. write access + 3. acceptsUploads.
  const memory = await db.memory.findUnique({
    where: { id: memoryId },
    select: {
      id: true,
      urn: true,
      organizationId: true,
      acceptsUploads: true,
      deletedAt: true,
      organization: { select: { urn: true } },
    },
  });
  if (!memory || memory.deletedAt) {
    throw new AssetUploadError('NOT_FOUND', 'memory not found');
  }

  const writeOk = await canWriteToMemory(
    db,
    {
      userId: caller.userId,
      appId: caller.appId,
      roles: caller.roles,
      organizationId: caller.organizationId,
    },
    memoryId,
  );
  if (!writeOk) {
    throw new AssetUploadError(
      'PERMISSION_DENIED',
      'caller does not have write access to target memory',
    );
  }

  if (!memory.acceptsUploads) {
    throw new AssetUploadError(
      'MEMORY_NOT_ACCEPTING_UPLOADS',
      `memory ${memoryId} does not accept uploads`,
    );
  }

  // 4. Size + MIME limits — same as v1.
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
      `mimeType "${input.mimeType}" not in allowlist`,
    );
  }

  // 5. Build storage key + presign + record.
  const assetId = generateId();
  const storageKey = buildStorageKey({
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
    agentId: null,                   // v2 path has no agent
    memoryId: memoryId,
    appId: caller.appId ?? null,
    userId: caller.userId,
    uploadIntent: input.uploadIntent,
    uploadRequestId: input.uploadRequestId,
    expiresAt: expiresAt.getTime(),
  });

  logAssetEvent({
    operation: 'upload-requested',
    assetId,
    agentId: null,
    memoryId: memoryId,
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
