/**
 * #4635 (follow-up to #4001 S6): the one place the S6 auto-delete trigger tests turn a `grants` trigger off.
 *
 * A grant that predates the finite-end guard (`secret_auto_delete_limit`, prisma/secret-auto-delete-invariants.sql) can
 * only be written by switching that trigger off for the insert, and the update-branch pins must switch `grants_guard`
 * off so the S6 trigger alone decides. Before this helper each test file carried its own copy of that dance (a raw
 * `DISABLE`/`ENABLE` pair, or a `DROP TRIGGER` plus a hand-typed `CREATE TRIGGER`, which could quietly diverge from the
 * migration's definition). Here the trigger is only ever DISABLED and re-ENABLED inside one transaction: DDL is
 * transactional in Postgres, so the trigger is back on at commit and also after a rollback, and its definition is never
 * rewritten by a test.
 *
 * Tests only. Never import this from production code.
 */
import type { Prisma } from '../generated/prisma/index.js';
import { db } from '../integrations/db/client.js';
import { generateId } from '../lib/id.js';

/** The two `grants` triggers the S6 pins switch off. A closed list: the name is interpolated into DDL. */
export type GrantsTrigger = 'secret_auto_delete_limit' | 'grants_guard';
const GRANTS_TRIGGERS: ReadonlySet<string> = new Set<GrantsTrigger>(['secret_auto_delete_limit', 'grants_guard']);

/**
 * Run `fn` in one transaction with `trigger` disabled on `grants`. Anything `fn` throws rolls the transaction back,
 * which also puts the trigger back.
 */
export async function withGrantsTriggerOff<T>(
  trigger: GrantsTrigger,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  // The union is compile-time only and the name goes into DDL, so refuse anything else at run time too.
  if (!GRANTS_TRIGGERS.has(trigger)) throw new Error('withGrantsTriggerOff: not an allowed trigger name');
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`ALTER TABLE grants DISABLE TRIGGER ${trigger}`);
    const out = await fn(tx);
    await tx.$executeRawUnsafe(`ALTER TABLE grants ENABLE TRIGGER ${trigger}`);
    return out;
  });
}

export interface HistoricalMarkInput {
  appId: string;
  /** Exactly one holder, as the grants table requires. */
  holder: { userId: string } | { workerId: string };
  action: string;
  values: Record<string, unknown>;
  /** Seconds from the database clock; null or omitted leaves the mark without an expiry. The budget is always NULL. */
  expiresInSeconds?: number | null;
}

/**
 * A pending delete mark with no use budget, written the way the generic grant door wrote it before the guard existed
 * (the trigger is off for the insert only). Returns the grant id.
 */
export async function insertHistoricalMark(input: HistoricalMarkInput): Promise<string> {
  const id = generateId();
  const userId = 'userId' in input.holder ? input.holder.userId : null;
  const workerId = 'workerId' in input.holder ? input.holder.workerId : null;
  await withGrantsTriggerOff('secret_auto_delete_limit', (tx) => tx.$executeRawUnsafe(
    `INSERT INTO grants (id, app_id, user_id, worker_id, action, action_values, reason, max_uses, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'historical mark', NULL,
       CASE WHEN $7::int IS NULL THEN NULL ELSE (clock_timestamp() AT TIME ZONE 'UTC') + make_interval(secs => $7::int) END,
       (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'))`,
    id, input.appId, userId, workerId, input.action, JSON.stringify(input.values), input.expiresInSeconds ?? null,
  ));
  return id;
}
