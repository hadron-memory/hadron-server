/**
 * #5100 item 4: `startCreditExpirySweepLoop`: the initial delay, the interval, the stop and the guard against overlapping
 * runs, on fake timers and a stub database (one run reads the clock and finds no owner).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PrismaClient } from '../generated/prisma/index.js';
import { startCreditExpirySweepLoop } from './expireCreditGrants.js';

function stubDb(gate?: { release: Promise<void> }) {
  const state = { runs: 0 };
  const $queryRaw = vi.fn(async (q: unknown) => {
    const text = Array.isArray(q) ? (q as string[]).join('') : String((q as { sql?: string }).sql ?? '');
    if (/now\(\)/i.test(text)) {
      state.runs += 1;
      if (gate) await gate.release;
      return [{ now: new Date('2027-03-01T00:00:00Z') }];
    }
    return [];
  });
  return { state, db: { $queryRaw } as unknown as PrismaClient };
}

afterEach(() => vi.useRealTimers());

describe('startCreditExpirySweepLoop', () => {
  it('first runs after the initial delay, then every interval, and stop ends it', async () => {
    vi.useFakeTimers();
    const { db, state } = stubDb();
    const loop = startCreditExpirySweepLoop(db, { initialDelayMs: 1000, intervalMs: 5000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(state.runs).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.runs).toBe(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(state.runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.runs).toBe(2);
    loop.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.runs).toBe(2);
  });

  it('stop before the initial delay means no run at all', async () => {
    vi.useFakeTimers();
    const { db, state } = stubDb();
    startCreditExpirySweepLoop(db, { initialDelayMs: 1000, intervalMs: 5000 }).stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.runs).toBe(0);
  });

  it('a tick that fires while a run is still going starts no second run', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const { db, state } = stubDb({ release: new Promise<void>((r) => (release = r)) });
    const loop = startCreditExpirySweepLoop(db, { initialDelayMs: 100, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(100);
    expect(state.runs).toBe(1);
    await vi.advanceTimersByTimeAsync(3000); // three interval ticks while the first run is blocked
    expect(state.runs).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.runs).toBe(2);
    loop.stop();
  });
});
