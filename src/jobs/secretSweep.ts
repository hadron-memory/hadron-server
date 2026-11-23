/**
 * #4003 (S8 of #3991) — the App secret sweep loop (plan #3991, "Version purge": "same loop, hourly").
 *
 * One tick runs the two retention purges in `src/lib/secrets/purge.ts`: superseded versions past
 * `SECRET_VERSION_RETENTION_DAYS` or beyond the kept-versions cap, then the events of owners whose App has been gone
 * for a year (tombstone last). Each is bounded per tick; a backlog drains over later ticks. S6 (#4001, window-end
 * sweep) runs its own 60-second leg in this loop rather than starting another (Bill, chat #104737).
 *
 * Off when `DISABLE_SECRET_SWEEP=true` or `NODE_ENV=test`; a disabled sweep is logged at boot (plan, "Settings").
 * The App key cache's sweep is NOT behind this flag: it has its own timer (`startAppKeyCacheSweepLoop`).
 * A failure logs a fixed tag and the database error code only, never ids, names or values, and the next tick retries.
 *
 * Run one tick by hand:
 *   pnpm tsx src/jobs/secretSweep.ts
 */
import { safeErrorCode, sweepSecretAutoDelete } from '../lib/secrets/autoDelete.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import { purgeExpiredSecretEvents, purgeSupersededVersions } from '../lib/secrets/purge.js';

const TAG = 'secret_sweep';

export interface SecretSweepLegs {
  autoDelete?: typeof sweepSecretAutoDelete;
  purgeVersions: typeof purgeSupersededVersions;
  purgeEvents: typeof purgeExpiredSecretEvents;
}

const defaultLegs: SecretSweepLegs = { autoDelete: sweepSecretAutoDelete, purgeVersions: purgeSupersededVersions, purgeEvents: purgeExpiredSecretEvents };

/** One tick. Each leg is isolated: a failed version purge does not stop the event purge. Returns the counts. */
export async function secretSweepTick(
  db: PrismaClient,
  legs: SecretSweepLegs = defaultLegs,
  runRetention = true,
): Promise<{ versions: number; events: number; tombstones: number; deleted: number }> {
  const out = { versions: 0, events: 0, tombstones: 0, deleted: 0 };
  try { out.deleted = await legs.autoDelete?.(db) ?? 0; }
  catch (err) { console.error(`${TAG}.auto_delete_failed`, { code: safeErrorCode(err) }); }
  if (!runRetention) return out;
  try {
    out.versions = (await legs.purgeVersions(db)).purged;
  } catch (err) {
    console.error(`${TAG}.version_purge_failed`, { code: safeErrorCode(err) });
  }
  try {
    const e = await legs.purgeEvents(db);
    out.events = e.events;
    out.tombstones = e.tombstones;
  } catch (err) {
    console.error(`${TAG}.event_purge_failed`, { code: safeErrorCode(err) });
  }
  return out;
}

/** Why the loop does not start in this environment, or null when it does. */
export function secretSweepDisabledReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV === 'test') return 'NODE_ENV=test';
  if (env.DISABLE_SECRET_SWEEP === 'true') return 'DISABLE_SECRET_SWEEP';
  return null;
}

/** Start the minute loop (hourly retention, first tick after 60 s; ticks never overlap). Returns the initial timer. */
export function startSecretSweepLoop(
  db: PrismaClient,
  options: { intervalMs?: number; initialDelayMs?: number; legs?: SecretSweepLegs } = {},
): NodeJS.Timeout {
  const intervalMs = options.intervalMs ?? 60 * 1000;
  const initialDelayMs = options.initialDelayMs ?? 60 * 1000;
  let running = false;
  let nextRetentionAt = 0;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const retention = Date.now() >= nextRetentionAt;
      const n = await secretSweepTick(db, options.legs ?? defaultLegs, retention);
      if (retention) nextRetentionAt = Date.now() + 60 * 60 * 1000;
      if (n.versions + n.events + n.tombstones + n.deleted > 0) {
        console.log(`${TAG}.purged versions=${n.versions} events=${n.events} tombstones=${n.tombstones} deleted=${n.deleted}`);
      }
    } finally {
      running = false;
    }
  };
  const timer = setTimeout(() => {
    void run();
    setInterval(() => void run(), intervalMs).unref();
  }, initialDelayMs);
  timer.unref();
  return timer;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { db } = await import('../integrations/db/client.js');
  console.log(JSON.stringify(await secretSweepTick(db)));
  await db.$disconnect();
}
