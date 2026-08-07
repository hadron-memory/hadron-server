/**
 * completeAssetUpload — verify the bytes landed in R2, persist the
 * Asset row (with `storage_key` encrypted in encrypted memories),
 * and return the new row.
 *
 * Spec: spec-kits/specs/004-asset-upload/contracts/controller-api.md
 *
 * Per FR-009: HeadObject's the uploaded key, verifies size + MIME
 * against the begin-upload promise, deletes the orphaned R2 object
 * on mismatch.
 *
 * Per FR-014: encrypts `storage_key` at rest for encrypted memories.
 */

import type { Asset, PrismaClient } from '../../generated/prisma/index.js';
import { consumeUpload } from '../../lib/asset/uploadRegistry.js';
import { logAssetEvent } from '../../lib/asset/audit.js';
import { encryptStorageKeyForMemory } from '../../lib/asset/encryption.js';
import {
  headObject,
  deleteObject,
  readObjectPrefix,
  copyObject,
} from '../../integrations/r2/client.js';
import {
  verifyDeclaredContentType,
  MAGIC_BYTES_WINDOW,
} from '../../lib/asset/contentType.js';
import { sessionKeyCache } from '../../lib/sessionKeyCache.js';
import { AssetUploadError } from './beginAssetUpload.js';
import type { AssetCallerContext } from './beginAssetUpload.js';

export interface CompleteAssetUploadInput {
  uploadId: string;
}

export async function completeAssetUpload(
  db: PrismaClient,
  caller: AssetCallerContext,
  input: CompleteAssetUploadInput,
): Promise<Asset> {
  const entry = consumeUpload(input.uploadId);
  if (!entry) {
    throw new AssetUploadError(
      'NOT_FOUND',
      'upload ticket expired or unknown',
    );
  }
  // The caller must be the same identity that requested the begin —
  // both userId and (when present) appId must match.
  if (entry.userId !== caller.userId) {
    throw new AssetUploadError(
      'PERMISSION_DENIED',
      'upload ticket does not belong to caller',
    );
  }
  const callerAppId = caller.appId ?? null;
  if (entry.appId !== callerAppId) {
    throw new AssetUploadError(
      'PERMISSION_DENIED',
      'upload ticket does not belong to caller app',
    );
  }

  // FR-009 — verify what landed against what was promised.
  const head = await headObject(entry.stagingKey);
  if (!head.exists) {
    throw new AssetUploadError(
      'NOT_FOUND',
      'no object found at storage key — did the PUT succeed?',
    );
  }
  if (
    head.contentLength != null &&
    head.contentLength !== entry.expectedSizeBytes
  ) {
    await deleteObject(entry.stagingKey).catch(() => {});
    throw new AssetUploadError(
      'INVALID_INPUT',
      `uploaded size ${head.contentLength} does not match ticket size ${entry.expectedSizeBytes}`,
    );
  }
  if (head.contentType && head.contentType !== entry.mimeType) {
    await deleteObject(entry.stagingKey).catch(() => {});
    throw new AssetUploadError(
      'INVALID_INPUT',
      `uploaded mime "${head.contentType}" does not match ticket mime "${entry.mimeType}"`,
    );
  }

  // Both values compared above are CLIENT-supplied: the browser PUTs the
  // bytes to a presigned URL and declares their Content-Type, and the
  // ticket records what it asked for. Nothing had looked at the file, so
  // an executable uploaded as image/png satisfied every check and the
  // allowlist was advisory.
  //
  // Check the magic bytes. This matters more while there is no malware
  // scanner (#896) — the allowlist is currently the only control between
  // an arbitrary upload and a permanent unauthenticated hotlink.
  //
  // Only a MISMATCH rejects. Types with no signature (text, csv, json)
  // and files too short to judge come back `unverifiable` and pass: a
  // false reject breaks a legitimate upload, while a false accept only
  // leaves us where we already were.
  const magic = await readObjectPrefix(entry.stagingKey, MAGIC_BYTES_WINDOW);
  if (verifyDeclaredContentType(magic, entry.mimeType) === 'mismatch') {
    await deleteObject(entry.stagingKey).catch(() => {});
    logAssetEvent({
      operation: 'upload-declined',
      assetId: entry.assetId,
      memoryId: entry.memoryId,
      userId: caller.userId,
      appId: caller.appId ?? null,
      reason: `content does not match declared mime "${entry.mimeType}"`,
    });
    throw new AssetUploadError(
      'INVALID_INPUT',
      `file content does not match its declared type "${entry.mimeType}"`,
    );
  }

  // FR-014 — encrypt storage_key at rest for encrypted memories.
  // 006-asset-upload-redesign: entry.memoryId is nullable for the
  // staging path (US4), but on the v1 and v2-attached paths it's
  // always set. completeAssetUpload runs the same encryption logic
  // for both v1 and v2-attached. Staging path is rejected here for
  // now; US4 will add a staging-aware completion that skips the
  // encryption step (staged assets carry no memory, so no tier).
  if (!entry.memoryId) {
    await deleteObject(entry.stagingKey).catch(() => {});
    throw new AssetUploadError(
      'INVALID_INPUT',
      'staging-path completion not yet supported (US4)',
    );
  }
  const memory = await db.memory.findUniqueOrThrow({
    where: { id: entry.memoryId },
    select: { id: true, isEncrypted: true },
  });
  let storedStorageKey = entry.storageKey;
  if (memory.isEncrypted) {
    const key = sessionKeyCache.getByMemoryId(memory.id);
    if (!key) {
      // The PUT already succeeded; clean up the orphan and surface the
      // typed error matching the edge-conditions pattern.
      await deleteObject(entry.stagingKey).catch(() => {});
      throw new AssetUploadError(
        'MEMORY_ENCRYPTED_NO_KEY',
        'encrypted memory has no active session key; cannot persist asset',
      );
    }
    storedStorageKey = encryptStorageKeyForMemory(
      entry.storageKey,
      memory,
      key,
    );
  }

  // Born CLEAN instead of PENDING when scanning is not in play.
  //
  // **This is a PRODUCTION setting now, not just a test hatch** (Holger,
  // 2026-08-06). There is no malware scanner anywhere in the platform —
  // nothing transitions PENDING → CLEAN — so with this unset every user
  // upload is permanently undownloadable: `mintAssetDownloadUrl` gates on
  // CLEAN and the row never gets there. That is what shipped, and it made
  // the whole upload feature dead on arrival in prod.
  //
  // The tradeoff being accepted: uploaded bytes are served WITHOUT any
  // malware check, including through the unauthenticated `GET /assets/:id`
  // hotlink — so an uploaded file becomes a public URL on this deployment's
  // domain serving unscanned content. Defensible while uploads are limited
  // to trusted operators and a pilot; NOT once uploads are open to end
  // users. Tracked for a real scanner in #896.
  //
  // Do not "clean this up" as dev-only config. Turning it off without a
  // scanner in place silently breaks every download again.
  const autoClean = process.env.HADRON_ASSET_SCAN_AUTO_CLEAN === 'true';

  // Promote the VERIFIED bytes to the key the Asset will reference.
  //
  // Everything above inspected the staging key, which is the only key the
  // presigned PUT can reach. A presigned URL cannot be revoked and stays
  // valid for its whole TTL, so without this the uploader could re-PUT
  // after verification — matching the signed ContentLength and
  // ContentType by padding — and silently swap the bytes behind an Asset
  // already marked CLEAN (PR #897 review, Codex P1). Copying to a key
  // that was never presigned closes that window: a later PUT to staging
  // writes an object no row references.
  //
  // Server-side copy — the bytes never transit this process.
  await copyObject(entry.stagingKey, entry.storageKey);

  let asset: Asset;
  try {
    asset = await db.asset.create({
      data: {
        id: entry.assetId,
        memoryId: entry.memoryId,
        filename: entry.filename,
        mimeType: entry.mimeType,
        sizeBytes: entry.expectedSizeBytes,
        storageKey: storedStorageKey,
        scanStatus: autoClean ? 'CLEAN' : 'PENDING',
        description: entry.description,
        uploadedBy: entry.userId,
      },
    });
  } catch (err) {
    // The copy already landed; without this the promoted object outlives
    // the failed row as an orphan nothing references.
    await deleteObject(entry.storageKey).catch(() => {});
    await deleteObject(entry.stagingKey).catch(() => {});
    throw err;
  }

  // Best-effort: the row is durable and points at the promoted key, so a
  // surviving staging object is wasted bytes, not a correctness problem —
  // and the janitor's orphan sweep (#889) is its backstop.
  await deleteObject(entry.stagingKey).catch(() => {});

  logAssetEvent({
    operation: 'upload-completed',
    assetId: asset.id,
    agentId: entry.agentId,
    memoryId: entry.memoryId,
    userId: caller.userId,
    appId: callerAppId,
    bytes: entry.expectedSizeBytes,
  });

  return asset;
}
