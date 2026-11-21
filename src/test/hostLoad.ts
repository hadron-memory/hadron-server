import os from 'node:os';

/**
 * #3002 — the declared host load a fixed-budget test cell scales against.
 *
 * Three cells asserted a fixed budget (a zero-error pool, a throughput flag, a 1000 ms bound) that a saturated
 * host defeats: under a full suite on a shared host the same code takes longer and the pool's wait window runs out.
 * A cell now reads the host's 1-minute load average per core and relaxes ONLY by that measured amount:
 *  - idle (below {@link LOADED_PER_CORE}) the budget is exactly what it was, so a regression on a quiet host still fails;
 *  - loaded, a time bound grows by `1 + load per core`, capped at {@link MAX_LOAD_SCALE} so a runaway average cannot
 *    switch a budget off;
 *  - loaded, the pool-wait error classes alone (P2028 transaction start, P2024 connection wait) are forgiven and
 *    counted; every other error is still a failure.
 * An unreadable value (NaN, zero cores) reads as idle: the strict budget is the safe default.
 */
export const LOADED_PER_CORE = 0.5;
export const MAX_LOAD_SCALE = 6;
/** The Prisma pool-wait codes: the pool doing its job under a saturated host, not a logic fault. */
const POOL_WAIT_CODES = new Set(['P2028', 'P2024']);

export interface HostLoad {
  /** 1-minute load average divided by the core count; 0 when unreadable. */
  perCore: number;
  loaded: boolean;
  /** 1 when idle, else `1 + perCore` capped at {@link MAX_LOAD_SCALE}. */
  scale: number;
}

export interface HostLoadSource {
  loadavg: () => number[];
  parallelism: () => number;
}

const realSource: HostLoadSource = { loadavg: () => os.loadavg(), parallelism: () => os.availableParallelism() };

export function readHostLoad(src: HostLoadSource = realSource): HostLoad {
  const load1 = src.loadavg()[0];
  const cores = src.parallelism();
  const perCore = Number.isFinite(load1) && Number.isFinite(cores) && cores > 0 && load1 >= 0 ? load1 / cores : 0;
  const loaded = perCore >= LOADED_PER_CORE;
  return { perCore, loaded, scale: loaded ? Math.min(MAX_LOAD_SCALE, 1 + perCore) : 1 };
}

/** A time budget in ms, relaxed by the measured load factor (unchanged when idle). */
export function loadScaledBudget(baseMs: number, load: HostLoad): number {
  return Math.ceil(baseMs * load.scale);
}

const codeOf = (e: unknown): unknown => (typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined);

/**
 * Split errors into those a loaded host may excuse (pool-wait classes) and the rest. On an idle host nothing is
 * excused, so a pool-wait error on a quiet host is still a finding.
 */
export function poolWaitTolerance(errors: unknown[], load: HostLoad): { forgiven: number; unexpected: unknown[] } {
  if (!load.loaded) return { forgiven: 0, unexpected: errors };
  const unexpected = errors.filter((e) => !(typeof codeOf(e) === 'string' && POOL_WAIT_CODES.has(codeOf(e) as string)));
  return { forgiven: errors.length - unexpected.length, unexpected };
}
