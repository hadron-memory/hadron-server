import { describe, it, expect } from 'vitest';
import { currentTick, nextTickAfter, tickTime, type TickerSchedule } from './ticks.js';
import { inQuietHours } from './quietHours.js';

const at = (s: string) => new Date(s);
const base = (over: Partial<TickerSchedule> = {}): TickerSchedule => ({
  anchorAt: at('2026-10-05T09:00:00Z'),
  cadenceSeconds: 600,
  quietHours: null,
  enabled: true,
  ...over,
});

describe('ticks — cor:agt:080:06', () => {
  it('the anchor is not a tick: tick 1 is one cadence later', () => {
    expect(currentTick(base(), at('2026-10-05T09:00:00Z'))).toBeNull();
    expect(currentTick(base(), at('2026-10-05T09:09:59Z'))).toBeNull();
    expect(currentTick(base(), at('2026-10-05T09:10:00Z'))).toBe(1);
    expect(tickTime(base(), 1).toISOString()).toBe('2026-10-05T09:10:00.000Z');
  });

  it('a late poll sees the current tick only, not a backlog of missed ones', () => {
    expect(currentTick(base(), at('2026-10-05T10:05:00Z'))).toBe(6);
    expect(currentTick(base(), at('2026-10-05T09:29:59Z'))).toBe(2);
  });

  it('a disabled or deleted ticker has no tick', () => {
    expect(currentTick(base({ enabled: false }), at('2026-10-06T09:00:00Z'))).toBeNull();
    expect(currentTick(base({ deletedAt: at('2026-10-05T12:00:00Z') }), at('2026-10-06T09:00:00Z'))).toBeNull();
    expect(nextTickAfter(base({ enabled: false }), at('2026-10-05T09:00:00Z'))).toBeNull();
  });

  const night = { timezone: 'UTC', windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '22:00', to: '07:00' }] };

  it('a window includes its start and excludes its end, across midnight', () => {
    expect(inQuietHours(night, at('2026-10-05T22:00:00Z'))).toBe(true);
    expect(inQuietHours(night, at('2026-10-05T21:59:00Z'))).toBe(false);
    expect(inQuietHours(night, at('2026-10-06T06:59:00Z'))).toBe(true);
    expect(inQuietHours(night, at('2026-10-06T07:00:00Z'))).toBe(false);
  });

  it('the spec example: with 22:00–07:00 the next current tick after 21:50 is 07:00', () => {
    const t = base({ quietHours: night });
    expect(currentTick(t, at('2026-10-05T21:50:00Z'))).toBe(77); // 09:00 + 77 × 10 min = 21:50
    expect(tickTime(t, 77).toISOString()).toBe('2026-10-05T21:50:00.000Z');
    // 22:00 through 06:50 do not fire: the current tick stays 21:50's until 07:00.
    expect(currentTick(t, at('2026-10-06T06:55:00Z'))).toBe(77);
    expect(currentTick(t, at('2026-10-06T07:00:00Z'))).toBe(132); // 09:00 + 132 × 10 min = 07:00 next day
    expect(nextTickAfter(t, at('2026-10-05T21:55:00Z'))?.toISOString()).toBe('2026-10-06T07:00:00.000Z');
  });

  it('a day-limited window only silences those days', () => {
    const sat = { timezone: 'UTC', windows: [{ days: [6], from: '00:00', to: '23:59' }] };
    expect(inQuietHours(sat, at('2026-10-10T12:00:00Z'))).toBe(true); // a Saturday
    expect(inQuietHours(sat, at('2026-10-09T12:00:00Z'))).toBe(false);
  });

  it('quiet hours follow the ticker\'s zone through a DST change', () => {
    const la = { timezone: 'America/Los_Angeles', windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '22:00', to: '07:00' }] };
    // US spring-forward 2026-03-08 (02:00 PST -> 03:00 PDT). The zone's own wall clock decides, not a fixed offset.
    expect(inQuietHours(la, at('2026-03-08T05:59:00Z'))).toBe(false); // 21:59 PST, Mar 7
    expect(inQuietHours(la, at('2026-03-08T06:00:00Z'))).toBe(true); // 22:00 PST
    expect(inQuietHours(la, at('2026-03-08T13:59:00Z'))).toBe(true); // 06:59 PDT
    expect(inQuietHours(la, at('2026-03-08T14:00:00Z'))).toBe(false); // 07:00 PDT, end excluded
    // The night before (no DST): 07:00 PST = 15:00Z.
    expect(inQuietHours(la, at('2026-03-07T14:59:00Z'))).toBe(true);
    expect(inQuietHours(la, at('2026-03-07T15:00:00Z'))).toBe(false);
  });

  it('a ticker whose whole week is quiet never ticks', () => {
    const all = { timezone: 'UTC', windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '23:59' }, ] };
    // 23:59–24:00 is the only firing minute; ticks on the hour are all inside.
    expect(currentTick(base({ quietHours: all, cadenceSeconds: 3600 }), at('2026-10-06T12:00:00Z'))).toBeNull();
  });
});
