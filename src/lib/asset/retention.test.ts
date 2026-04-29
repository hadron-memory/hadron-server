import { describe, it, expect } from 'vitest';
import {
  ASSET_RETENTION_WINDOW_MS,
  isWithinRetentionWindow,
} from './retention.js';

describe('asset / retention', () => {
  it('exports a 24-hour window', () => {
    expect(ASSET_RETENTION_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('returns false for non-deleted assets', () => {
    expect(isWithinRetentionWindow(null)).toBe(false);
    expect(isWithinRetentionWindow(undefined)).toBe(false);
  });

  it('returns true within the window', () => {
    const now = new Date('2026-04-29T12:00:00Z');
    const recent = new Date(now.getTime() - 60_000); // 1 min ago
    expect(isWithinRetentionWindow(recent, now)).toBe(true);
  });

  it('returns true for the boundary (just under 24h)', () => {
    const now = new Date('2026-04-29T12:00:00Z');
    const justUnder = new Date(now.getTime() - (ASSET_RETENTION_WINDOW_MS - 1000));
    expect(isWithinRetentionWindow(justUnder, now)).toBe(true);
  });

  it('returns false beyond the window', () => {
    const now = new Date('2026-04-29T12:00:00Z');
    const old = new Date(now.getTime() - (ASSET_RETENTION_WINDOW_MS + 1));
    expect(isWithinRetentionWindow(old, now)).toBe(false);
  });
});
