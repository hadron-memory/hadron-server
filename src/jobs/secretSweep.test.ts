/**
 * #4003 (S8 of #3991) — the secret sweep loop: one tick runs both retention purges; the boot gate honours
 * DISABLE_SECRET_SWEEP and NODE_ENV=test, and says so when disabled; a failed purge logs a code, never ids or values.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { secretSweepDisabledReason, secretSweepTick } from './secretSweep.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('secretSweepTick', () => {
  it('runs the version purge, then the event purge, and reports both counts', async () => {
    const calls: string[] = [];
    const out = await secretSweepTick({} as never, {
      purgeVersions: async () => { calls.push('versions'); return { purged: 3, more: false }; },
      purgeEvents: async () => { calls.push('events'); return { events: 2, tombstones: 1 }; },
    });
    expect(calls).toEqual(['versions', 'events']);
    expect(out).toEqual({ versions: 3, events: 2, tombstones: 1 });
  });

  it('a failing version purge still lets the event purge run, and logs only a code', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = await secretSweepTick({} as never, {
      purgeVersions: async () => { throw Object.assign(new Error('secret-id-abc value=CANARY'), { code: 'P2010' }); },
      purgeEvents: async () => ({ events: 1, tombstones: 0 }),
    });
    expect(out).toEqual({ versions: 0, events: 1, tombstones: 0 });
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).toContain('P2010');
    expect(logged).not.toContain('CANARY');
    expect(logged).not.toContain('secret-id-abc');
  });
});

describe('secretSweepDisabledReason', () => {
  it('is null when enabled, and names the reason otherwise', () => {
    expect(secretSweepDisabledReason({ NODE_ENV: 'production' })).toBeNull();
    expect(secretSweepDisabledReason({ NODE_ENV: 'production', DISABLE_SECRET_SWEEP: 'false' })).toBeNull();
    expect(secretSweepDisabledReason({ NODE_ENV: 'production', DISABLE_SECRET_SWEEP: 'true' })).toBe('DISABLE_SECRET_SWEEP');
    expect(secretSweepDisabledReason({ NODE_ENV: 'test' })).toBe('NODE_ENV=test');
  });
});
