// Save-time validator for nodes with nodeType="asset". Mirrors the pattern
// from edge-conditions/validator.ts and the message.data.exception(s)
// reservation in 001-edge-condition-spec.
// Spec: hadron-portal/specs/001-asset-upload/data-model.md §E-002.

import { validateStorageKey } from './storageKey.js';

export type ScanStatus = 'pending' | 'clean' | 'blocked';

export interface AssetData {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  uploadedAt: string;
  uploadedBy: string;
  description?: string;
  scanStatus: ScanStatus;
  scanCheckedAt?: string;
  deletedAt?: string;
  purgeAt?: string;
}

export interface AssetValidationContext {
  allowedMimeTypes: string[];
  maxBytes: number;
}

export type AssetValidationResult =
  | { ok: true; data: AssetData }
  | { ok: false; code: string; field?: string; message: string };

const FILENAME_MAX = 255;
const DESCRIPTION_MAX = 1000;
const SCAN_STATUSES: ScanStatus[] = ['pending', 'clean', 'blocked'];
const ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function validateAssetData(
  raw: unknown,
  ctx: AssetValidationContext,
): AssetValidationResult {
  if (!raw || typeof raw !== 'object') {
    return fail('ASSET_DATA_INVALID', 'data', 'data must be an object');
  }
  const d = raw as Record<string, unknown>;

  if (typeof d.filename !== 'string' || d.filename.length === 0 || d.filename.length > FILENAME_MAX) {
    return fail('ASSET_DATA_INVALID', 'filename', `filename must be a string of 1..${FILENAME_MAX} chars`);
  }
  if (typeof d.mimeType !== 'string' || d.mimeType.length === 0) {
    return fail('ASSET_DATA_INVALID', 'mimeType', 'mimeType must be a non-empty string');
  }
  if (!ctx.allowedMimeTypes.includes(d.mimeType)) {
    return fail('MIME_NOT_ALLOWED', 'mimeType', `mimeType "${d.mimeType}" not in agent allowlist`);
  }
  if (typeof d.sizeBytes !== 'number' || !Number.isInteger(d.sizeBytes) || d.sizeBytes <= 0) {
    return fail('ASSET_DATA_INVALID', 'sizeBytes', 'sizeBytes must be a positive integer');
  }
  if (d.sizeBytes > ctx.maxBytes) {
    return fail('SIZE_EXCEEDED', 'sizeBytes', `sizeBytes ${d.sizeBytes} exceeds cap ${ctx.maxBytes}`);
  }
  if (typeof d.storageKey !== 'string' || !validateStorageKey(d.storageKey)) {
    return fail('ASSET_DATA_INVALID', 'storageKey', 'storageKey does not match the canonical pattern');
  }
  if (typeof d.uploadedAt !== 'string' || !ISO_REGEX.test(d.uploadedAt)) {
    return fail('ASSET_DATA_INVALID', 'uploadedAt', 'uploadedAt must be an ISO-8601 timestamp');
  }
  if (typeof d.uploadedBy !== 'string' || d.uploadedBy.length === 0) {
    return fail('ASSET_DATA_INVALID', 'uploadedBy', 'uploadedBy must be a non-empty string');
  }
  if (d.description !== undefined && (typeof d.description !== 'string' || d.description.length > DESCRIPTION_MAX)) {
    return fail('ASSET_DATA_INVALID', 'description', `description must be ≤${DESCRIPTION_MAX} chars`);
  }
  if (typeof d.scanStatus !== 'string' || !SCAN_STATUSES.includes(d.scanStatus as ScanStatus)) {
    return fail('ASSET_DATA_INVALID', 'scanStatus', `scanStatus must be one of ${SCAN_STATUSES.join('|')}`);
  }
  if (d.scanCheckedAt !== undefined && (typeof d.scanCheckedAt !== 'string' || !ISO_REGEX.test(d.scanCheckedAt))) {
    return fail('ASSET_DATA_INVALID', 'scanCheckedAt', 'scanCheckedAt must be ISO-8601');
  }

  if (d.deletedAt !== undefined || d.purgeAt !== undefined) {
    if (typeof d.deletedAt !== 'string' || !ISO_REGEX.test(d.deletedAt)) {
      return fail('ASSET_DATA_INVALID', 'deletedAt', 'deletedAt must be ISO-8601 if present');
    }
    if (typeof d.purgeAt !== 'string' || !ISO_REGEX.test(d.purgeAt)) {
      return fail('ASSET_DATA_INVALID', 'purgeAt', 'purgeAt must be ISO-8601 when deletedAt is set');
    }
    const dt = new Date(d.deletedAt).getTime();
    const pa = new Date(d.purgeAt).getTime();
    const expected = dt + 24 * 60 * 60 * 1000;
    if (Math.abs(pa - expected) > 60_000) {
      return fail(
        'ASSET_DATA_INVALID',
        'purgeAt',
        'purgeAt must equal deletedAt + 24h (±60s)',
      );
    }
  }

  return { ok: true, data: d as unknown as AssetData };
}

function fail(
  code: string,
  field: string | undefined,
  message: string,
): AssetValidationResult {
  return { ok: false, code, field, message };
}
