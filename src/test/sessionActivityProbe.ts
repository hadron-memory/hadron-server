/**
 * Shared fixtures of the roster liveness probe's plan pins (#1903 / #1952 / #4397; follow-up #4399).
 * Used by src/test/integration/1903-session-activity-index.test.ts and 4397-session-activity-probe.test.ts.
 */
import { Prisma, type PrismaClient } from '../generated/prisma/index.js';
import { setWorkerActivityPlanSettings } from '../api/graphql/schema/resolvers.worker.js';

export type Tx = Prisma.TransactionClient;

class RolledBack extends Error {}

export interface RolledBackOptions {
  /** Seed `usage_events`/`sessions`/`workers` rows without their parents (#4399 item 1). Opt-in: it takes DDL locks. */
  seedWithoutParents?: boolean;
  /** Run the planner settings the shipped read applies first (default true). The real-path pins turn it off. */
  planSettings?: boolean;
  timeout?: number;
}

/**
 * Runs `fn` in a transaction that ALWAYS rolls back, so seeds, ANALYZE, dropped indexes and (with `seedWithoutParents`)
 * dropped constraints never escape. The helper owns the rollback, so no caller can commit what the opt-in strips from
 * the shared test database (#4399 BLIND P2-1). Sequential and bitmap scans are off so a tiny test table cannot make the
 * planner's choice moot.
 */
export async function rolledBack<T>(db: PrismaClient, fn: (tx: Tx) => Promise<T>, o: RolledBackOptions = {}): Promise<T> {
  let out: { value: T } | undefined;
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off');
        if (o.seedWithoutParents) await skipSeedForeignKeys(tx);
        if (o.planSettings !== false) await setWorkerActivityPlanSettings(tx);
        out = { value: await fn(tx) };
        throw new RolledBack();
      },
      { timeout: o.timeout ?? 60_000 },
    );
  } catch (e) {
    if (!(e instanceof RolledBack)) throw e;
  }
  if (!out) throw new Error('unreachable');
  return out.value;
}

/**
 * Lets a pin seed `usage_events`, `sessions` and `workers` rows without their parents (#4399 item 1). The pins used
 * `SET LOCAL session_replication_role = replica`, which needs a superuser and so fails on a plain test role. Dropping
 * the foreign keys and disabling the user triggers (all of them) of these three tables needs only their owner. Only
 * `rolledBack` calls it, so the change is undone with the transaction.
 */
async function skipSeedForeignKeys(tx: Tx): Promise<void> {
  const fks = await tx.$queryRaw<{ tbl: string; name: string }[]>`
    SELECT conrelid::regclass::text AS tbl, conname AS name FROM pg_constraint
    WHERE contype = 'f' AND conrelid IN ('usage_events'::regclass, 'sessions'::regclass, 'workers'::regclass)
    ORDER BY conrelid::regclass::text, conname`;
  for (const fk of fks) await tx.$executeRawUnsafe(`ALTER TABLE ${fk.tbl} DROP CONSTRAINT "${fk.name}"`);
  // The reference-guard triggers on these tables refuse a row whose session or worker is missing; DISABLE TRIGGER USER
  // (the owner's right, unlike ALL) switches off the user triggers, as replica mode did.
  for (const t of ['usage_events', 'sessions', 'workers']) await tx.$executeRawUnsafe(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
}

/**
 * Rewrites the shipped roster SQL into an older probe shape (#4399 item 2). Each `from` fragment must occur exactly
 * once; runs of whitespace in it match any whitespace in the SQL, so reformatting the SQL cannot break the pin with a
 * "fragment not found" error that says nothing about the probe.
 */
export function swapProbeFragments(sql: Prisma.Sql, swaps: [from: string, to: string][]): Prisma.Sql {
  let strings = sql.strings.slice();
  for (const [from, to] of swaps) {
    const src = from.trim().split(/\s+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const hits = strings.reduce((n, str) => n + (str.match(new RegExp(src, 'g'))?.length ?? 0), 0);
    if (hits !== 1) throw new Error(`expected the probe fragment exactly once, found ${hits}: ${from}`);
    strings = strings.map((str) => str.replace(new RegExp(src), () => to));
  }
  return Prisma.sql(Object.assign(strings, { raw: strings }) as TemplateStringsArray, ...sql.values);
}

/** The probe shape before #4397: `aggregate` is the max expression, read for every activity row of the session. */
export function everyRowProbe(sql: Prisma.Sql, aggregate: string): Prisma.Sql {
  return swapProbeFragments(sql, [
    ['SELECT e.created_at AS max_created', `SELECT ${aggregate} AS max_created`],
    ['e.session_id >= s.id AND e.session_id <= s.id', 'e.session_id = s.id'],
    ['ORDER BY e.session_id DESC, e.created_at DESC LIMIT 1', ''],
  ]);
}
