import { describe, it, expect } from 'vitest';
import { validateAssetData } from './validator.js';

const ctx = {
  allowedMimeTypes: ['application/pdf', 'image/png'],
  maxBytes: 1024 * 1024,
};

const validBase = () => ({
  filename: 'business-plan.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 12345,
  storageKey: 'baragaun.com/secureid/01900000-0000-7000-8000-000000000001.pdf',
  uploadedAt: '2026-04-28T10:00:00.000Z',
  uploadedBy: 'user-1',
  scanStatus: 'pending',
});

describe('validateAssetData', () => {
  it('passes for a fully-formed asset payload', () => {
    const res = validateAssetData(validBase(), ctx);
    expect(res.ok).toBe(true);
  });

  it('rejects non-object input', () => {
    expect(validateAssetData('nope', ctx).ok).toBe(false);
    expect(validateAssetData(null, ctx).ok).toBe(false);
  });

  it.each([
    ['filename', { ...validBase(), filename: '' }, 'ASSET_DATA_INVALID'],
    ['filename too long', { ...validBase(), filename: 'a'.repeat(256) }, 'ASSET_DATA_INVALID'],
    ['mimeType missing', { ...validBase(), mimeType: '' }, 'ASSET_DATA_INVALID'],
    ['mimeType blocked', { ...validBase(), mimeType: 'application/zip' }, 'MIME_NOT_ALLOWED'],
    ['sizeBytes negative', { ...validBase(), sizeBytes: -1 }, 'ASSET_DATA_INVALID'],
    ['sizeBytes too large', { ...validBase(), sizeBytes: ctx.maxBytes + 1 }, 'SIZE_EXCEEDED'],
    ['storageKey malformed', { ...validBase(), storageKey: '../escape' }, 'ASSET_DATA_INVALID'],
    ['uploadedAt not iso', { ...validBase(), uploadedAt: 'yesterday' }, 'ASSET_DATA_INVALID'],
    ['uploadedBy empty', { ...validBase(), uploadedBy: '' }, 'ASSET_DATA_INVALID'],
    ['description too long', { ...validBase(), description: 'x'.repeat(1001) }, 'ASSET_DATA_INVALID'],
    ['scanStatus invalid', { ...validBase(), scanStatus: 'unknown' }, 'ASSET_DATA_INVALID'],
  ])('rejects %s', (_, payload, expectedCode) => {
    const res = validateAssetData(payload, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(expectedCode);
  });

  it('accepts deletedAt with matching purgeAt (24h offset)', () => {
    const deletedAt = '2026-04-28T10:00:00.000Z';
    const purgeAt = '2026-04-29T10:00:00.000Z';
    const res = validateAssetData(
      { ...validBase(), deletedAt, purgeAt },
      ctx,
    );
    expect(res.ok).toBe(true);
  });

  it('rejects mismatched deletedAt/purgeAt offset', () => {
    const res = validateAssetData(
      {
        ...validBase(),
        deletedAt: '2026-04-28T10:00:00.000Z',
        purgeAt: '2026-04-30T10:00:00.000Z',
      },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe('purgeAt');
  });

  it('rejects deletedAt without purgeAt', () => {
    const res = validateAssetData(
      { ...validBase(), deletedAt: '2026-04-28T10:00:00.000Z' },
      ctx,
    );
    expect(res.ok).toBe(false);
  });
});
