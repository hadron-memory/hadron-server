/**
 * The per-process price lookup cache (#5021), kept in its own module with no runtime imports so that test setup
 * (src/test/helpers.ts cleanDb) can reset it without loading the metering module, which several tests mock.
 */
import type { AiModelPrice } from '../../generated/prisma/index.js';

export interface CachedPrice {
  row: AiModelPrice | null;
  fetchedAt: number;
  /** #5021: when the next row for this key takes effect (ms), or null when none is known. The entry is not served
   * from that instant on, so a process that cached the old row switches at the new row's effective instant. */
  nextEffectiveAt: number | null;
}

/**
 * How long a process may serve a cached price lookup, in milliseconds. It is also the minimum lead of a new price row
 * (#5021, hrn:node:hadronmemory.com:specs:cor:dmo:170:06): `setAiModelPrice` refuses an `effectiveAt` earlier than now
 * plus this lifetime and defaults an omitted one to it, so every process's cache has expired, or knows the new row's
 * effective instant, before the row takes effect. One number for both, on purpose.
 */
export const PRICE_CACHE_TTL_MS = 60_000;
export const priceCache = new Map<string, CachedPrice>();

/** Test hook: drop the price cache (e.g. after seeding AiModelPrice rows). */
export function clearPriceCache(): void {
  priceCache.clear();
}
