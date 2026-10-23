import { describe, it, expect, beforeEach, vi } from 'vitest';

const captureMessage = vi.hoisted(() => vi.fn());
vi.mock('@sentry/node', () => ({ captureMessage }));

import {
  reportAssetBytesMissing,
  reportAssetBytesMissingSummary,
  resetAssetBytesMissingDedupe,
  ASSET_BYTES_MISSING_TAG,
  DEDUPE_MAX_ENTRIES,
} from './bytesMissingAlarm.js';

const DAY = 24 * 60 * 60 * 1000;
const noon = new Date('2026-10-23T12:00:00Z');

beforeEach(() => {
  captureMessage.mockReset();
  resetAssetBytesMissingDedupe();
});

describe('reportAssetBytesMissing (#1140)', () => {
  it('fires one error-level event tagged asset.bytes_missing, fingerprinted by asset', () => {
    expect(reportAssetBytesMissing({ assetId: 'a1', memoryId: 'm1', source: 'restore' }, noon)).toBe(true);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [, ctx] = captureMessage.mock.calls[0];
    expect(ctx.level).toBe('error');
    expect(ctx.tags[ASSET_BYTES_MISSING_TAG]).toBe('true');
    expect(ctx.tags.source).toBe('restore');
    expect(ctx.fingerprint).toEqual([ASSET_BYTES_MISSING_TAG, 'a1']);
  });

  it('never puts a storage key or filename in the event', () => {
    reportAssetBytesMissing({ assetId: 'a1', memoryId: 'm1', source: 'restore' }, noon);
    const [, ctx] = captureMessage.mock.calls[0];
    expect(ctx.extra).toEqual({ assetId: 'a1', memoryId: 'm1' });
  });

  it('reports an asset once per UTC day, again the next day, per asset independently', () => {
    expect(reportAssetBytesMissing({ assetId: 'a1', memoryId: 'm1', source: 'restore' }, noon)).toBe(true);
    expect(reportAssetBytesMissing({ assetId: 'a1', memoryId: 'm1', source: 'restore' }, new Date(noon.getTime() + 60_000))).toBe(false);
    expect(reportAssetBytesMissing({ assetId: 'a2', memoryId: 'm1', source: 'restore' }, noon)).toBe(true);
    expect(reportAssetBytesMissing({ assetId: 'a1', memoryId: 'm1', source: 'restore' }, new Date(noon.getTime() + DAY))).toBe(true);
    expect(captureMessage).toHaveBeenCalledTimes(3);
  });

  it('bounds its memory: past the cap the oldest entry is forgotten, never unbounded', () => {
    for (let i = 0; i < DEDUPE_MAX_ENTRIES + 1; i++) {
      reportAssetBytesMissing({ assetId: `x${i}`, memoryId: 'm', source: 'restore' }, noon);
    }
    captureMessage.mockClear();
    // x0 was evicted, so it reports again; the newest is still deduped.
    expect(reportAssetBytesMissing({ assetId: 'x0', memoryId: 'm', source: 'restore' }, noon)).toBe(true);
    expect(reportAssetBytesMissing({ assetId: `x${DEDUPE_MAX_ENTRIES}`, memoryId: 'm', source: 'restore' }, noon)).toBe(false);
  });
});

describe('reportAssetBytesMissingSummary (#1140)', () => {
  it('fires one error-level count event with its own fingerprint and no asset ids', () => {
    expect(reportAssetBytesMissingSummary({ suppressed: 7, source: 'sweep' })).toBe(true);
    const [, ctx] = captureMessage.mock.calls[0];
    expect(ctx.level).toBe('error');
    expect(ctx.tags[ASSET_BYTES_MISSING_TAG]).toBe('true');
    expect(ctx.fingerprint).toEqual(['asset.bytes_missing_summary']);
    expect(ctx.extra).toEqual({ suppressed: 7 });
  });
});
