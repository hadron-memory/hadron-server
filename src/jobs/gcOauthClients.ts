/**
 * gcOauthClients — collects unused DCR OAuth clients (#155).
 *
 * `/oauth/register` is unauthenticated (RFC 7591), so a client that registers
 * and never redeems a code, or an abandoned one, used to stay forever. A
 * client whose `expiresAt` is more than OAUTH_CLIENT_GC_GRACE_MS in the past
 * is SOFT-deleted (`deletedBy = 'system:gc'`): /authorize then answers
 * `invalid_client` and /token the unknown-code answer, so the client must
 * register again. Nothing else changes: its auth codes stay (no cascade) and
 * keys it already issued stay valid. A NULL `expiresAt` (seeded clients)
 * never expires.
 *
 * DRY RUN until OAUTH_CLIENT_GC_ENABLED=true (R220, the ASSET_ORPHAN_REAP_ENABLED
 * precedent): the loop logs how many clients it would collect and changes
 * nothing. Production enablement waits on that count (#155, Q1).
 *
 * Run one pass by hand:
 *   tsx src/jobs/gcOauthClients.ts            # the env flag decides
 *   tsx src/jobs/gcOauthClients.ts --apply    # collect for real
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { OAUTH_CLIENT_GC_GRACE_MS } from '../lib/oauthClientLifetime.js';

export { OAUTH_CLIENT_GC_GRACE_MS };

const BATCH_SIZE = 500;
const MAX_PASSES = 20;
const GC_ACTOR = 'system:gc';

export interface OauthClientGcOutcome {
  dryRun: boolean;
  /** Clients past the grace when the run started (dry run), or collected (apply). */
  collectable: number;
  collected: number;
}

/**
 * One run. Collects in bounded batches until a short batch or `maxPasses`.
 * Each batch's UPDATE restates the expiry and live conditions, so a client a
 * redemption extended (or someone deleted) while the batch was chosen is
 * skipped: Postgres re-checks the WHERE on the row version it waited for.
 */
export async function gcOauthClients(
  db: PrismaClient,
  opts: { now?: Date; apply?: boolean; batchSize?: number; maxPasses?: number } = {},
): Promise<OauthClientGcOutcome> {
  const now = opts.now ?? new Date();
  const apply = opts.apply ?? process.env.OAUTH_CLIENT_GC_ENABLED === 'true';
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const maxPasses = opts.maxPasses ?? MAX_PASSES;
  const collectableWhere = {
    deletedAt: null,
    expiresAt: { not: null, lt: new Date(now.getTime() - OAUTH_CLIENT_GC_GRACE_MS) },
  };

  if (!apply) {
    const collectable = await db.oAuthClient.count({ where: collectableWhere });
    return { dryRun: true, collectable, collected: 0 };
  }

  let collected = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    const batch = await db.oAuthClient.findMany({
      where: collectableWhere,
      select: { clientId: true },
      orderBy: { expiresAt: 'asc' },
      take: batchSize,
    });
    if (batch.length === 0) break;
    const { count } = await db.oAuthClient.updateMany({
      where: { clientId: { in: batch.map((c) => c.clientId) }, ...collectableWhere },
      data: { deletedAt: now, deletedBy: GC_ACTOR, updatedBy: GC_ACTOR },
    });
    collected += count;
    if (batch.length < batchSize) break;
  }
  return { dryRun: false, collectable: collected, collected };
}

/** Start the recurring run (daily, first run after 5 minutes). Returns the initial timer. */
export function startOauthClientGcLoop(
  db: PrismaClient,
  options: { intervalMs?: number; initialDelayMs?: number } = {},
): NodeJS.Timeout {
  const intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1000;
  const initialDelayMs = options.initialDelayMs ?? 5 * 60 * 1000;
  const run = async () => {
    try {
      const out = await gcOauthClients(db);
      if (out.dryRun) {
        console.log(
          `[oauth-client-gc] would collect ${out.collectable} unused OAuth clients` +
            ' — dry run; set OAUTH_CLIENT_GC_ENABLED=true to collect',
        );
      } else if (out.collected > 0) {
        console.log(`[oauth-client-gc] collected ${out.collected} unused OAuth clients`);
      }
    } catch (err) {
      console.error('[oauth-client-gc] failed:', err);
    }
  };
  return setTimeout(() => {
    void run();
    setInterval(run, intervalMs);
  }, initialDelayMs);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { db } = await import('../integrations/db/client.js');
  const apply = process.argv.includes('--apply') ? true : undefined;
  console.log(JSON.stringify(await gcOauthClients(db, { apply })));
  await db.$disconnect();
}
