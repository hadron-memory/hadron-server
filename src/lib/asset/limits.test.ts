import { describe, it, expect } from 'vitest';
import {
  getEffectiveLimits,
  PLATFORM_DEFAULT_MAX_BYTES,
  PLATFORM_CEILING_MAX_BYTES,
  PLATFORM_DEFAULT_TIMEOUT_SECONDS,
  PLATFORM_DEFAULT_ALLOWED_MIMES,
} from './limits.js';

describe('getEffectiveLimits', () => {
  it('returns platform defaults when no overrides present', () => {
    const limits = getEffectiveLimits(null);
    expect(limits.maxBytes).toBe(PLATFORM_DEFAULT_MAX_BYTES);
    expect(limits.allowedMimeTypes).toEqual(PLATFORM_DEFAULT_ALLOWED_MIMES);
    expect(limits.uploadRequestTimeoutSeconds).toBe(PLATFORM_DEFAULT_TIMEOUT_SECONDS);
  });

  it('returns defaults when properties is not an object', () => {
    expect(getEffectiveLimits('nope').maxBytes).toBe(PLATFORM_DEFAULT_MAX_BYTES);
  });

  it('honors a maxSizeBytes override below the ceiling', () => {
    const limits = getEffectiveLimits({ assets: { maxSizeBytes: 1024 * 1024 } });
    expect(limits.maxBytes).toBe(1024 * 1024);
  });

  it('clamps a maxSizeBytes override that exceeds the ceiling', () => {
    const limits = getEffectiveLimits({
      assets: { maxSizeBytes: 999_999_999 },
    });
    expect(limits.maxBytes).toBe(PLATFORM_CEILING_MAX_BYTES);
  });

  it('falls back to default for invalid maxSizeBytes', () => {
    expect(getEffectiveLimits({ assets: { maxSizeBytes: -1 } }).maxBytes).toBe(
      PLATFORM_DEFAULT_MAX_BYTES,
    );
    expect(
      getEffectiveLimits({ assets: { maxSizeBytes: 'huge' } }).maxBytes,
    ).toBe(PLATFORM_DEFAULT_MAX_BYTES);
  });

  it('intersects mime override with platform allowlist', () => {
    const limits = getEffectiveLimits({
      assets: {
        allowedMimeTypes: [
          'application/pdf',
          'image/png',
          'application/zip', // not in platform allowlist
        ],
      },
    });
    expect(limits.allowedMimeTypes).toEqual(['application/pdf', 'image/png']);
  });

  it('reverts to platform defaults when override list is empty after intersection', () => {
    const limits = getEffectiveLimits({
      assets: { allowedMimeTypes: ['application/zip'] },
    });
    expect(limits.allowedMimeTypes).toEqual([]);
  });

  it('honors a request timeout override', () => {
    expect(
      getEffectiveLimits({
        assets: { uploadRequestTimeoutSeconds: 60 },
      }).uploadRequestTimeoutSeconds,
    ).toBe(60);
  });

  it('clamps timeout override to one hour', () => {
    expect(
      getEffectiveLimits({
        assets: { uploadRequestTimeoutSeconds: 99999 },
      }).uploadRequestTimeoutSeconds,
    ).toBe(3600);
  });
});
