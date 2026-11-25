/**
 * expireCreditGrants — the hourly sweep that settles expired grants (#5011, Billing A4;
 * hrn:node:hadronmemory.com:specs:cor:dmo:170:10) for every owner no read has reached. A read of creditBalance settles
 * the owner at hand itself; this job catches everyone else.
 *
 * One run: owners holding a live grant that expired at least 60 s ago (ruling 10.1) and has no settlement, found in one
 * statement, `BATCH_SIZE` at a time, keyset by organization id within the run (so an owner whose settlement fails is
 * not selected again in the same run), at most `MAX_PASSES` batches. Each owner is settled through
 * settleExpiredGrants in its own try/catch: a failure logs one line (organization id, error code; no message, no
 * amount) and the run goes on. A second run, instance or reader is a no-op: the settlement pair is unique.
 *
 * No attempt cap and no alarm (#5100 item 7, a stated divergence from the chat-tool teardown and Git mirror sweeps): those
 * sweeps keep an attempt count per row so that a failing remote is eventually CAPPED and raised. Here a failing owner
 * keeps no state: nothing is retried against a remote, the settlement is idempotent, and every read of that owner's
 * balance settles it too (a failure there answers the computed figure, ruling 10.4), so a stuck owner costs one logged
 * line an hour (`credit_expiry_sweep.owner_failed`, owner id and error code) and no balance is ever wrong. A cap would
 * need a column to count in, for no figure it could protect.
 *
 * Env: DISABLE_CREDIT_EXPIRY_SWEEP=true disables the loop (only the exact value `true`); skipped under NODE_ENV=test.
 * Reads still settle the owner at hand whatever the switch says. Run one sweep by hand:
 *   pnpm tsx src/jobs/expireCreditGrants.ts
 */
import { Prisma, type PrismaClient } from '../generated/prisma/index.js';
import { GRANT_EXPIRY_SOURCE_TYPE } from '../lib/metering/expiry.js';
import {
  SETTLE_DELAY_MS,
  databaseNow,
  settleExpiredGrants,
  toNaiveUtc,
} from '../lib/metering/settleExpiredGrants.js';
import { safeErrorCode } from '../lib/safeErrorCode.js';
import { isProcessEntry } from './isProcessEntry.js';

const BATCH_SIZE = 500;
const MAX_PASSES = 20;
const TAG = 'credit_expiry_sweep';

export interface ExpireCreditGrantsOptions {
  /** The run's instant; defaults to the database clock, read once per run. */
  now?: Date;
  batchSize?: number;
  maxPasses?: number;
  /** The per-owner settlement; a test seam. */
  settle?: typeof settleExpiredGrants;
}

export interface ExpireCreditGrantsResult {
  /** Owners the run judged without error, including those it wrote nothing for (a grant inside its 60 s, or one another settler took first). */
  owners: number;
  /** Settlement entries those owners asked to write. */
  settlements: number;
  /** Owners whose settlement threw (logged, retried next run). */
  failures: number;
}

/** One batch of owners holding an expired, unsettled grant, after `after` in organization-id order. */
async function ownersDue(db: PrismaClient, cutoff: Date, after: string | null, limit: number): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT DISTINCT g.organization_id AS id
      FROM credit_ledger_entries g
     WHERE g.expires_at IS NOT NULL
       AND g.expires_at <= ${toNaiveUtc(cutoff)}::timestamp
       AND g.kind = 'grant'
       AND g.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM credit_ledger_entries s
          WHERE s.source_type = ${GRANT_EXPIRY_SOURCE_TYPE} AND s.source_id = g.id
       )
       ${after === null ? Prisma.empty : Prisma.sql`AND g.organization_id > ${after}`}
     ORDER BY 1
     LIMIT ${limit}`);
  return rows.map((r) => r.id);
}

/** One run. */
export async function expireCreditGrants(
  db: PrismaClient,
  options: ExpireCreditGrantsOptions = {},
): Promise<ExpireCreditGrantsResult> {
  const now = options.now ?? (await databaseNow(db));
  const cutoff = new Date(now.getTime() - SETTLE_DELAY_MS);
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const maxPasses = options.maxPasses ?? MAX_PASSES;
  const settle = options.settle ?? settleExpiredGrants;
  const out: ExpireCreditGrantsResult = { owners: 0, settlements: 0, failures: 0 };
  let after: string | null = null;
  for (let pass = 0; pass < maxPasses; pass++) {
    const owners = await ownersDue(db, cutoff, after, batchSize);
    for (const organizationId of owners) {
      try {
        const written = await settle(db, { organizationId }, { now });
        out.owners += 1;
        out.settlements += written.length;
      } catch (err) {
        out.failures += 1;
        console.error(`${TAG}.owner_failed`, { organizationId, code: safeErrorCode(err) });
      }
    }
    if (owners.length < batchSize) break;
    after = owners[owners.length - 1];
  }
  return out;
}

/** Why the loop does not start in this environment, or null when it does (the secretSweep.ts form). */
export function creditExpirySweepDisabledReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV === 'test') return 'NODE_ENV=test';
  if (env.DISABLE_CREDIT_EXPIRY_SWEEP === 'true') return 'DISABLE_CREDIT_EXPIRY_SWEEP';
  return null;
}

/** Start the hourly loop (first run after 60 s; runs never overlap). Returns a stop function. */
export function startCreditExpirySweepLoop(
  db: PrismaClient,
  options: { intervalMs?: number; initialDelayMs?: number } = {},
): { stop: () => void } {
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000;
  const initialDelayMs = options.initialDelayMs ?? 60 * 1000;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await expireCreditGrants(db);
      if (r.owners + r.failures > 0) {
        console.log(`${TAG}.settled owners=${r.owners} settlements=${r.settlements} failures=${r.failures}`);
      }
    } catch (err) {
      console.error(`${TAG}.failed`, { code: safeErrorCode(err) });
    } finally {
      running = false;
    }
  };
  let interval: NodeJS.Timeout | undefined;
  const initial = setTimeout(() => {
    void run();
    interval = setInterval(() => void run(), intervalMs);
    interval.unref();
  }, initialDelayMs);
  initial.unref();
  return {
    stop: () => {
      clearTimeout(initial);
      clearInterval(interval);
    },
  };
}

if (isProcessEntry(import.meta.url)) {
  const { db } = await import('../integrations/db/client.js');
  console.log(JSON.stringify(await expireCreditGrants(db)));
  await db.$disconnect();
}
