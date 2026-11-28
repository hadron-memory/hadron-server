/**
 * #3002 — the host-load helper the three fixed-budget cells use. Red first: the module does not exist on main.
 * The rules pinned here are what keeps a load-aware cell honest: idle means the budget is EXACTLY today's, load
 * relaxes it by a bounded factor, and only the pool-wait classes are ever forgiven (never another error).
 */
import { describe, expect, it } from 'vitest';
import { LOADED_PER_CORE, MAX_LOAD_SCALE, loadScaledBudget, poolWaitTolerance, readHostLoad } from './hostLoad.js';

const host = (load1: number, cpus: number) => readHostLoad({ loadavg: () => [load1, 0, 0], parallelism: () => cpus });
const poolErr = (code: string) => Object.assign(new Error(`pool ${code}`), { code });

describe('readHostLoad', () => {
  it('an idle host is not loaded and scales nothing', () => {
    const l = host(0.2, 8);
    expect(l.loaded).toBe(false);
    expect(l.scale).toBe(1);
    expect(loadScaledBudget(1000, l)).toBe(1000);
  });

  it('the declared threshold is the boundary: just under is idle, at it is loaded', () => {
    expect(host(LOADED_PER_CORE * 8 - 0.01, 8).loaded).toBe(false);
    expect(host(LOADED_PER_CORE * 8, 8).loaded).toBe(true);
  });

  it('a loaded host relaxes the budget by 1 + load per core, rounded up', () => {
    const l = host(16, 16); // one runnable per core
    expect(l.perCore).toBe(1);
    expect(l.scale).toBe(2);
    expect(loadScaledBudget(1000, l)).toBe(2000);
  });

  it('the factor is capped, so a runaway load average cannot switch a budget off', () => {
    const l = host(10_000, 4);
    expect(l.scale).toBe(MAX_LOAD_SCALE);
    expect(loadScaledBudget(1000, l)).toBe(1000 * MAX_LOAD_SCALE);
  });

  it('an unreadable or zero-core host reads as idle, never as loaded', () => {
    expect(host(5, 0).loaded).toBe(false);
    expect(host(Number.NaN, 8).loaded).toBe(false);
  });
});

describe('poolWaitTolerance', () => {
  it('on an idle host nothing is forgiven, not even a pool-wait error', () => {
    expect(poolWaitTolerance([poolErr('P2028')], host(0.1, 8))).toEqual({ forgiven: 0, unexpected: [expect.objectContaining({ code: 'P2028' })] });
  });

  it('on a loaded host the pool-wait classes (P2028, P2024) are forgiven and counted', () => {
    const r = poolWaitTolerance([poolErr('P2028'), poolErr('P2024')], host(16, 16));
    expect(r.forgiven).toBe(2);
    expect(r.unexpected).toEqual([]);
  });

  it('on a loaded host any other error stays unexpected', () => {
    const other = poolErr('P2002');
    const plain = new Error('boom');
    const r = poolWaitTolerance([poolErr('P2028'), other, plain, 'not an error'], host(16, 16));
    expect(r.forgiven).toBe(1);
    expect(r.unexpected).toEqual([other, plain, 'not an error']);
  });
});
