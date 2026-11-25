/**
 * expireCreditGrants — the hourly sweep that settles expired grants (#5011, Billing A4;
 * hrn:node:hadronmemory.com:specs:cor:dmo:170:10) for every owner no read has reached. A read of creditBalance settles
 * the owner at hand itself; this job catches everyone else.
 *
 * One run: owners holding a live grant that expired at least 60 s ago (ruling 10.1) and has no settlement, found in one
 * statement, `BATCH_SIZE` at a time, keyset by owner id within the run (so an owner whose settlement fails is
 * not selected again in the same run), at most `MAX_PASSES` batches. An owner is an organization or a person (#5014, A6):
 * the organizations are searched first, then the persons, each leg keyset-paged by its own column, with its own
 * `MAX_PASSES` budget (so a long organization leg never starves the persons). Each owner is settled through
 * settleExpiredGrants in its own try/catch: a failure logs one line (the owner's kind and id, error code; no message, no
 * amount) and the run goes on. A second run, instance or reader is a no-op: the settlement pair is unique.
 *
 * Env: DISABLE_CREDIT_EXPIRY_SWEEP=true disables the loop (only the exact value `true`); skipped under NODE_ENV=test.
 * Reads still settle the owner at hand whatever the switch says. Run one sweep by hand:
 *   pnpm tsx src/jobs/expireCreditGrants.ts
 */
import { Prisma, type PrismaClient } from '../generated/prisma/index.js';
import { GRANT_EXPIRY_SOURCE_TYPE } from '../lib/metering/expiry.js';
import type { OwnerRef } from '../lib/owner.js';
import { repointMergedLedgerOwners } from '../lib/metering/repointMergedOwners.js';
import {
  SETTLE_DELAY_MS,
  databaseNow,
  settleExpiredGrants,
  toNaiveUtc,
} from '../lib/metering/settleExpiredGrants.js';
import { safeErrorCode } from '../lib/secrets/autoDelete.js';
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
  /** Owners settled without error. */
  owners: number;
  /** Settlement entries those owners asked to write. */
  settlements: number;
  /** Owners whose settlement threw (logged, retried next run). */
  failures: number;
}

/** The two kinds of owner a grant can belong to, searched one after the other. */
const OWNER_LEGS = ['organization', 'user'] as const;
type OwnerLeg = (typeof OWNER_LEGS)[number];

/** One batch of owners of one kind holding an expired, unsettled grant, after `after` in that kind's id order. */
async function ownersDue(db: PrismaClient, leg: OwnerLeg, cutoff: Date, after: string | null, limit: number): Promise<string[]> {
  // The column is chosen from a closed two-value set, never from input.
  const col = Prisma.raw(leg === 'organization' ? 'g.organization_id' : 'g.owner_user_id');
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT DISTINCT ${col} AS id
      FROM credit_ledger_entries g
     WHERE ${col} IS NOT NULL
       AND g.expires_at IS NOT NULL
       AND g.expires_at <= ${toNaiveUtc(cutoff)}::timestamp
       AND g.kind = 'grant'
       AND g.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM credit_ledger_entries s
          WHERE s.source_type = ${GRANT_EXPIRY_SOURCE_TYPE} AND s.source_id = g.id
       )
       ${after === null ? Prisma.empty : Prisma.sql`AND ${col} > ${after}`}
     ORDER BY 1
     LIMIT ${limit}`);
  return rows.map((r) => r.id);
}

const ownerOf = (leg: OwnerLeg, id: string): OwnerRef => (leg === 'organization' ? { organizationId: id } : { userId: id });

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
  // #5014 (local review P2): entries a merge raced past are re-pointed to the survivor BEFORE settling, so a settlement is
  // computed over the whole ledger. A failure logs and the run goes on (the next run, or the survivor's own read, retries).
  try {
    await repointMergedLedgerOwners(db);
  } catch (err) {
    console.error(`${TAG}.repoint_failed`, { code: safeErrorCode(err) });
  }
  for (const leg of OWNER_LEGS) {
    let passes = 0;
    let after: string | null = null;
    while (passes < maxPasses) {
      passes += 1;
      const owners = await ownersDue(db, leg, cutoff, after, batchSize);
      for (const id of owners) {
        try {
          const written = await settle(db, ownerOf(leg, id), { now });
          out.owners += 1;
          out.settlements += written.length;
        } catch (err) {
          out.failures += 1;
          console.error(`${TAG}.owner_failed`, { ...(leg === 'organization' ? { organizationId: id } : { ownerUserId: id }), code: safeErrorCode(err) });
        }
      }
      if (owners.length < batchSize) break;
      after = owners[owners.length - 1] ?? null;
    }
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
