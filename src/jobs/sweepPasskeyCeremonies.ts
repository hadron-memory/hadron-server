/** #3122: housekeeping for transient authentication ceremonies, never credentials.
 * Keep retired rows for 30 days after the later of expiry and consumption.
 * Explicit expiry protection also preserves unusual longer-TTL rows.
 */
import type { PrismaClient } from '../generated/prisma/index.js';

const MIN_RETENTION_SECONDS = 86400; // Above every current ceremony TTL (largest: SIGN, 600s); pinned against callers.
const DEFAULT_RETENTION_SECONDS = 30 * 86400;
const BATCH_SIZE = 500;
const MAX_PASSES = 20;

export function passkeyCeremonyRetentionSeconds(): number {
  const raw = process.env.PASSKEY_CEREMONY_RETENTION_SECONDS;
  const seconds = raw === undefined ? DEFAULT_RETENTION_SECONDS : Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < MIN_RETENTION_SECONDS || seconds > 3650 * 86400) {
    throw new Error('PASSKEY_CEREMONY_RETENTION_SECONDS must be an integer from 86400 to 315360000');
  }
  return seconds;
}

/** One run, at most 10,000 deletes. Options may lower, never raise, the work caps. */
export async function sweepPasskeyCeremonies(
  db: PrismaClient,
  options: { batchSize?: number; maxPasses?: number } = {},
): Promise<number> {
  const retentionSeconds = passkeyCeremonyRetentionSeconds();
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const maxPasses = options.maxPasses ?? MAX_PASSES;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > BATCH_SIZE ||
      !Number.isInteger(maxPasses) || maxPasses < 1 || maxPasses > MAX_PASSES) {
    throw new Error('invalid passkey ceremony sweep bounds');
  }
  let total = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      WITH cutoff AS MATERIALIZED (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now),
      candidates AS (
        SELECT c.id FROM passkey_ceremonies c CROSS JOIN cutoff
        WHERE c.expires_at < cutoff.now
          AND GREATEST(c.expires_at, c.consumed_at) < cutoff.now - make_interval(secs => ${retentionSeconds})
        ORDER BY c.expires_at, c.id LIMIT ${batchSize} FOR UPDATE OF c SKIP LOCKED
      )
      DELETE FROM passkey_ceremonies c USING candidates, cutoff
      WHERE c.id = candidates.id AND c.expires_at < cutoff.now
        AND GREATEST(c.expires_at, c.consumed_at) < cutoff.now - make_interval(secs => ${retentionSeconds})
      RETURNING c.id`;
    total += rows.length;
    if (rows.length < batchSize) break;
  }
  return total;
}

/** Serial, restart-safe schedule. Stop cancels the timer and drains the active run. */
export function startPasskeyCeremonySweepLoop(
  db: PrismaClient,
  options: { intervalMs?: number; initialDelayMs?: number } = {},
): { stop: () => Promise<void> } | null {
  if (process.env.NODE_ENV === 'test' || process.env.DISABLE_PASSKEY_CEREMONY_SWEEP === 'true') return null;
  passkeyCeremonyRetentionSeconds(); // Invalid configuration refuses startup, before any timer/deletion.
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000;
  const delay = options.initialDelayMs ?? 60 * 1000;
  let stopped = false;
  let running: Promise<void> | null = null;
  let timer: NodeJS.Timeout;
  const tick = () => {
    if (stopped) return;
    running = (async () => {
      try {
        const count = await sweepPasskeyCeremonies(db);
        if (count) console.log(`[passkey-ceremony-sweep] deleted ${count} retired ceremonies`);
      } catch (error) {
        // Bounded diagnostics only: never serialize error messages, queries or parameters.
        const record = error && typeof error === 'object' ? error as { code?: unknown; meta?: unknown } : undefined;
        const code = typeof record?.code === 'string' && /^P[0-9]{4}$/.test(record.code) ? record.code : 'UNKNOWN';
        const meta = record?.meta && typeof record.meta === 'object' ? record.meta as { code?: unknown } : undefined;
        const state = typeof meta?.code === 'string' ? meta.code : record?.code;
        const sqlState = typeof state === 'string' &&
          ['42501', '23503', '42703', '42P01', '42804', '22P02', '42883', '42601', '57014', '40P01', '40001'].includes(state) ? state : 'UNKNOWN';
        console.error('[passkey-ceremony-sweep] failed', { code, sqlState });
      }
    })().finally(() => {
      running = null;
      if (!stopped) timer = setTimeout(tick, intervalMs);
    });
  };
  timer = setTimeout(tick, delay);
  return { stop: async () => { stopped = true; clearTimeout(timer); await running; } };
}
