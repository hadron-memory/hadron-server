/**
 * #4850 (blind F9 on #4848): `resolveMetricsWindow` alone, the report-4 window rule (hrn:node:hadronmemory.com:specs:cor:agt:150, R1, R2):
 * an omitted until is now, an omitted since is until minus 7 days, since included and until excluded, at most 31 days.
 */
import { describe, expect, it } from 'vitest';
import { METRICS_DEFAULT_WINDOW_MS, METRICS_MAX_WINDOW_MS, MetricsWindowError, resolveMetricsWindow } from './teamMetrics.js';

const NOW = new Date('2026-11-22T12:00:00.000Z');
const DAY = 24 * 3_600_000;

describe('#4850 resolveMetricsWindow', () => {
  it('both omitted: until is now, since is 7 days earlier', () => {
    const w = resolveMetricsWindow(undefined, null, NOW);
    expect(w.until.toISOString()).toBe(NOW.toISOString());
    expect(w.until.getTime() - w.since.getTime()).toBe(METRICS_DEFAULT_WINDOW_MS);
    expect(METRICS_DEFAULT_WINDOW_MS).toBe(7 * DAY);
  });
  it('only until given: since is until minus 7 days, whatever now is', () => {
    const w = resolveMetricsWindow(undefined, '2026-01-10T00:00:00Z', NOW);
    expect(w).toEqual({ since: new Date('2026-01-03T00:00:00Z'), until: new Date('2026-01-10T00:00:00Z') });
  });
  it('only since given: until is now', () => {
    const w = resolveMetricsWindow('2026-11-20T00:00:00Z', undefined, NOW);
    expect(w).toEqual({ since: new Date('2026-11-20T00:00:00Z'), until: NOW });
  });
  it('accepts a Date as well as a string', () => {
    const since = new Date('2026-11-21T00:00:00Z');
    expect(resolveMetricsWindow(since, NOW, new Date(0))).toEqual({ since, until: NOW });
  });
  it('since equal to until is an empty window, not a refusal', () => {
    expect(resolveMetricsWindow(NOW, NOW, NOW)).toEqual({ since: NOW, until: NOW });
  });
  it('exactly 31 days is allowed; one millisecond more is refused', () => {
    expect(resolveMetricsWindow(new Date(NOW.getTime() - METRICS_MAX_WINDOW_MS), NOW, NOW).since.getTime()).toBe(NOW.getTime() - 31 * DAY);
    expect(() => resolveMetricsWindow(new Date(NOW.getTime() - METRICS_MAX_WINDOW_MS - 1), NOW, NOW)).toThrow(MetricsWindowError);
    expect(() => resolveMetricsWindow(new Date(NOW.getTime() - METRICS_MAX_WINDOW_MS - 1), NOW, NOW)).toThrow('The window must not be longer than 31 days.');
  });
  it('since after until is refused', () => {
    expect(() => resolveMetricsWindow(new Date(NOW.getTime() + 1), NOW, NOW)).toThrow('since must not be after until.');
  });
  it('an unparseable bound is refused, naming the bound and never echoing it', () => {
    for (const [since, until, name] of [['not-a-date', undefined, 'since'], [undefined, 'garbage<script>', 'until']] as const) {
      let caught: unknown;
      try { resolveMetricsWindow(since, until, NOW); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(MetricsWindowError);
      expect((caught as Error).message).toBe(`${name} is not a valid timestamp.`);
    }
  });
});
