import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETENTION_WINDOW_MS,
  isHardDeleteEligible,
} from './retentionEligibility.js';

const day = 24 * 60 * 60 * 1000;
const window = DEFAULT_RETENTION_WINDOW_MS; // 30 days

const at = (iso: string): Date => new Date(iso);

describe('isHardDeleteEligible', () => {
  it('returns false when deletedAt is null (active memory)', () => {
    expect(
      isHardDeleteEligible({
        deletedAt: null,
        releaseMarker: at('2026-05-07T00:00:00Z'),
        retentionWindowMs: window,
        now: at('2027-01-01T00:00:00Z'),
      }),
    ).toBe(false);
  });

  it('returns false when releaseMarker is missing (defensive)', () => {
    expect(
      isHardDeleteEligible({
        deletedAt: at('2025-01-01T00:00:00Z'),
        releaseMarker: null,
        retentionWindowMs: window,
        now: at('2027-01-01T00:00:00Z'),
      }),
    ).toBe(false);
  });

  it('returns true when a normal soft-delete is past the retention window', () => {
    expect(
      isHardDeleteEligible({
        deletedAt: at('2026-05-10T00:00:00Z'), // after release
        releaseMarker: at('2026-05-07T00:00:00Z'),
        retentionWindowMs: window,
        now: at('2026-06-15T00:00:00Z'), // 36 days after delete
      }),
    ).toBe(true);
  });

  it('returns false when a normal soft-delete is still within the window', () => {
    expect(
      isHardDeleteEligible({
        deletedAt: at('2026-05-10T00:00:00Z'),
        releaseMarker: at('2026-05-07T00:00:00Z'),
        retentionWindowMs: window,
        now: at('2026-05-25T00:00:00Z'), // 15 days after delete
      }),
    ).toBe(false);
  });

  it('anchors legacy rows (deletedAt before releaseMarker) to the release marker', () => {
    // Memory was soft-deleted 6 months before 011 shipped — but the sweep
    // should not hard-delete it until 30 days AFTER the release, not 30
    // days after the original deletedAt.
    const releaseMarker = at('2026-05-07T00:00:00Z');
    const deletedAt = at('2025-11-01T00:00:00Z'); // legacy

    // 1 day after release: NOT eligible (review window still open)
    expect(
      isHardDeleteEligible({
        deletedAt,
        releaseMarker,
        retentionWindowMs: window,
        now: at('2026-05-08T00:00:00Z'),
      }),
    ).toBe(false);

    // 31 days after release: eligible (review window passed)
    expect(
      isHardDeleteEligible({
        deletedAt,
        releaseMarker,
        retentionWindowMs: window,
        now: at('2026-06-07T00:00:00Z'),
      }),
    ).toBe(true);
  });

  it('boundary: exactly at threshold is eligible (<= comparison)', () => {
    const releaseMarker = at('2026-05-07T00:00:00Z');
    const deletedAt = at('2026-05-10T00:00:00Z');
    const exactly30Days = new Date(deletedAt.getTime() + 30 * day);
    expect(
      isHardDeleteEligible({
        deletedAt,
        releaseMarker,
        retentionWindowMs: window,
        now: exactly30Days,
      }),
    ).toBe(true);
  });

  it('boundary: one millisecond before threshold is NOT eligible', () => {
    const releaseMarker = at('2026-05-07T00:00:00Z');
    const deletedAt = at('2026-05-10T00:00:00Z');
    const justBefore = new Date(deletedAt.getTime() + 30 * day - 1);
    expect(
      isHardDeleteEligible({
        deletedAt,
        releaseMarker,
        retentionWindowMs: window,
        now: justBefore,
      }),
    ).toBe(false);
  });

  it('honors a custom retentionWindowMs (e.g., 7-day retention in tests)', () => {
    const sevenDays = 7 * day;
    expect(
      isHardDeleteEligible({
        deletedAt: at('2026-05-10T00:00:00Z'),
        releaseMarker: at('2026-05-07T00:00:00Z'),
        retentionWindowMs: sevenDays,
        now: at('2026-05-18T00:00:00Z'), // 8 days after delete
      }),
    ).toBe(true);
  });
});
