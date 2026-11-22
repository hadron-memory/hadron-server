/** #1162 / cor:dmo:050:11: private, immutable-id census, including tombstones. */
import { decryptJson } from './crypto.js';
import { sessionKeyCache } from './sessionKeyCache.js';
import { Prisma } from '../generated/prisma/index.js';
import { SELF_BOOKKEEPING_EVENT_TYPES, STAFFING_EVENT_TYPES } from './agentTasks/events.js';

type Reader = Pick<Prisma.TransactionClient, '$queryRaw' | 'session' | 'node' | 'asset'>;
const quoted = (name: string) => Prisma.raw(`"${name.replaceAll('"', '""')}"`);

/** Include no-FK audit fields: ORM relations alone lose attribution. */
export const workerReferenceInventory = Prisma.dmmf.datamodel.models.flatMap((model) =>
  model.fields.filter((field) => field.kind === 'scalar' && /workerId$/i.test(field.name))
    .map((field) => ({ model: model.name, table: model.dbName ?? model.name, column: field.dbName ?? field.name })));

const JSON_REFERENCES = [
  ['nodes', 'data'], ['nodes', 'properties'],
  ['node_revisions', 'data'], ['node_revisions', 'properties'],
  ['agent_team_events', 'chain'], ['agent_team_events', 'payload'], ['host_operations', 'args'], ['agent_tasks', 'requirements'],
] as const;

/**
 * #2766: the member and staffing events are the acts' own bookkeeping, not use of the worker, so recording them must
 * not change what `deleteWorker` admits (gate: admission unchanged). Two shapes are exempt: the cast / retirement
 * events about THIS worker (it is their subject), and any staffing event THIS worker performed (it is the actor).
 * Written null-safe: a NULL subject must not turn the exclusion into NULL and drop the row from the census.
 * Everything else still counts, including a worker named inside another event's payload.
 */
const selfBookkeeping = (workerId: string) => Prisma.sql`(
  (type IN (${Prisma.join([...SELF_BOOKKEEPING_EVENT_TYPES])}) AND subject_worker_id IS NOT DISTINCT FROM ${workerId})
  OR (type IN (${Prisma.join([...STAFFING_EVENT_TYPES])}) AND actor_worker_id IS NOT DISTINCT FROM ${workerId}))`;

/**
 * #4809: ONE pass over the column for every identity. The path walks each row's document once and tests every string
 * against the whole identity list (`@ == $identity[*]` is true when any listed identity equals the value), where the
 * earlier one-predicate-per-identity OR walked each row once per session. The counted set is identical.
 */
async function jsonReferences(db: Reader, table: string, column: string, ids: string[], workerId: string): Promise<boolean> {
  const exempt = table === 'agent_team_events' ? Prisma.sql` AND NOT (${selfBookkeeping(workerId)})` : Prisma.empty;
  const rows = await db.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
    SELECT EXISTS (SELECT 1 FROM ${quoted(table)}
      WHERE jsonb_path_exists(${quoted(column)}, '$.** ? (@ == $identity[*])', jsonb_build_object('identity', to_jsonb(${ids}::text[])))${exempt}) AS present`);
  return rows[0].present;
}

/**
 * #4809 (cor:dmo:050:11): the census is bounded by ONE wall-clock budget across all its statements, applied as a
 * transaction-local `statement_timeout` before each statement (so Postgres cancels a stuck scan, not just the
 * transaction wrapper). An unfinished census has NOT found none, so the delete is refused, never admitted
 * (`WorkerCensusIncompleteError`; its own code, never `WORKER_IN_USE`, which means a reference was found).
 * 20 s is the build's choice: the measured census on a quiet 1M-node App is 7.9 s before the one-pass change, so the bound
 * leaves a wide margin for a legitimate run while holding a pooled connection for a bounded time. `WORKER_CENSUS_TIMEOUT_MS`
 * overrides it, read per call; only a positive integer counts (0 means "no timeout" to Postgres, so 0, negatives and junk
 * fall back to the default instead of widening the bound).
 */
export const WORKER_CENSUS_TIMEOUT_DEFAULT_MS = 20_000;
export function workerCensusTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WORKER_CENSUS_TIMEOUT_MS?.trim();
  return raw && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : WORKER_CENSUS_TIMEOUT_DEFAULT_MS;
}
/** The transaction timeout a door must give the census: its budget plus room for the rest of the act. */
export const workerCensusTransactionTimeoutMs = () => workerCensusTimeoutMs() + 20_000;

export class WorkerCensusIncompleteError extends Error {
  constructor() { super('The reference census did not finish within its bound.'); this.name = 'WorkerCensusIncompleteError'; }
}
const isStatementTimeout = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError
  && ((e.code === 'P2010' && String(e.meta?.code) === '57014') || /statement timeout/i.test(e.message));

/** Ciphertext is not an empty JSON envelope. Legacy data may lack the
 * explicit author stamp, so verify with an already resident key or fail closed.
 * Nothing decrypts for the caller and no new key is acquired. */
async function encryptedHistoryMayReference(db: Reader, worker: { id: string }, sessionIds: string[]): Promise<boolean> {
  const [identity] = await db.$queryRaw<Array<{ createdAt: Date }>>`SELECT created_at AS "createdAt" FROM workers WHERE id = ${worker.id}`;
  if (!identity) return true;
  const since = identity.createdAt.toISOString();
  const rows = await db.$queryRaw<Array<{ memoryId: string; data: unknown }>>(Prisma.sql`
    SELECT memory_id AS "memoryId", data FROM nodes
    WHERE data ? '__enc' AND (created_at >= ${since}::timestamp OR updated_at >= ${since}::timestamp)
    UNION ALL
    SELECT COALESCE(r.memory_id, n.memory_id) AS "memoryId", r.data FROM node_revisions r
      JOIN nodes n ON n.id = r.node_id
    WHERE r.data ? '__enc' AND r.created_at >= ${since}::timestamp`);
  const identities = new Set([worker.id, ...sessionIds]);
  const contains = (value: unknown): boolean => {
    if (typeof value === 'string') return identities.has(value);
    if (Array.isArray(value)) return value.some(contains);
    return !!value && typeof value === 'object' && Object.values(value).some(contains);
  };
  for (const row of rows) {
    const ciphertext = (row.data as { __enc?: unknown } | null)?.__enc;
    const key = sessionKeyCache.getByMemoryId(row.memoryId);
    if (!key || typeof ciphertext !== 'string' || ciphertext.length === 0) return true;
    try { const decoded = decryptJson(ciphertext, key); if (decoded === null || contains(decoded)) return true; }
    catch { return true; } // cannot establish never-used from unreadable history
  }
  return false;
}

/**
 * #2024 (S8): the tickers casting generated for this worker that nothing has used since: owned by the worker,
 * never acknowledged by it, never edited since the cast (`edited_at`, #2429), and subscribed to by no one else. They are the cast's own bookkeeping, not history, so
 * they neither count as references nor stand in the way of removing a miscast worker (they are removed with it).
 * #4312 (cor:dmo:050:11): a ticker soft-deleted BY RETIREMENT still counts as pristine. Retirement stamps both with one
 * value (`retireWorker` passes `retiredAt` to `endGeneratedTickersForWorker`); the window is `[retired_at, retired_at + 1
 * minute)` because rows retired before that change carry two nearby JS stamps from one transaction (the upper bound keeps a
 * delete made long after retirement out; the lower bound a delete made before it). So retirement's own
 * INVARIANT the window rests on (it is an inference, not a recorded fact): nothing but retirement can stamp
 * `tickers.deleted_at` on a generated ticker of a RETIRED worker inside `[retired_at, retired_at + 1 minute)`. Writers of
 * `tickers.deleted_at` today: `endGeneratedTickersForWorker` (retirement, with `retired_at` as the stamp; casting replacement,
 * on a worker that is not retired) and `deleteTicker` (`resolvers.ticker.ts`, which refuses an already-deleted ticker, and
 * retirement has deleted every generated one, so it cannot re-stamp one after retirement; before retirement it lands
 * below the lower bound). There is no restore, re-cast or janitor path. A new writer of `deleted_at`, or a path that
 * un-retires a worker, MUST revisit this predicate (an explicit discriminator column is the durable form, #4312 follow-up).
 * So retirement's own
 * bookkeeping cannot make a retired, never-used casting undeletable, while a ticker deleted before the retirement stays
 * history (#2024), and an edit (`edited_at`), a delivered tick or another worker's subscription still refuse.
 */
export async function removableGeneratedTickerIds(db: Reader, workerId: string): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT t.id FROM tickers t
    WHERE t.generated_for_worker_id = ${workerId} AND t.owner_worker_id = ${workerId} AND t.edited_at IS NULL
      AND (t.deleted_at IS NULL OR EXISTS (SELECT 1 FROM workers w WHERE w.id = ${workerId} AND w.retired_at IS NOT NULL AND t.deleted_at >= w.retired_at AND t.deleted_at < w.retired_at + INTERVAL '1 minute'))
      AND NOT EXISTS (SELECT 1 FROM worker_delivery_ticks d WHERE d.ticker_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM ticker_subscriptions s WHERE s.ticker_id = t.id AND s.worker_id <> ${workerId})`;
  return rows.map((r) => r.id);
}

/** Remove the pristine generated tickers (their subscriptions go with them). Call inside the verified-empty repair. */
export async function deletePristineGeneratedTickers(tx: Prisma.TransactionClient, workerId: string): Promise<void> {
  const ids = await removableGeneratedTickerIds(tx, workerId);
  if (ids.length) await tx.ticker.deleteMany({ where: { id: { in: ids } } });
}

/**
 * Call only after staffing authorization; never return this census to callers. Call INSIDE the door's transaction (the
 * SERIALIZABLE one for the delete, whose census is the authoritative one, cor:dmo:050:11): the bound is a transaction-local
 * setting. Throws `WorkerCensusIncompleteError` when the budget runs out; never answers `false` for an unfinished census.
 */
export async function miscastHasReferences(db: Reader, worker: { id: string; memoryId: string | null; heldByUserId: string | null }): Promise<boolean> {
  const budget = workerCensusTimeoutMs();
  const deadline = Date.now() + budget;
  const [{ previous }] = await db.$queryRaw<Array<{ previous: string }>>`SELECT current_setting('statement_timeout') AS previous`;
  try {
    const found = await census(db, worker, async () => {
      const left = deadline - Date.now();
      if (left <= 0) throw new WorkerCensusIncompleteError();
      await db.$queryRaw`SELECT set_config('statement_timeout', ${`${left}ms`}, true)`;
    });
    await db.$queryRaw`SELECT set_config('statement_timeout', ${previous}, true)`;
    return found;
  } catch (e) {
    if (isStatementTimeout(e)) throw new WorkerCensusIncompleteError();
    throw e;
  }
}

async function census(db: Reader, worker: { id: string; memoryId: string | null; heldByUserId: string | null }, arm: () => Promise<void>): Promise<boolean> {
  await arm();
  const sessions = await db.session.findMany({ where: { workerId: worker.id } });
  const sessionIds = sessions.map((s) => s.id);
  if (sessions.some((s) => s.endedAt === null) || (sessions.length > 0 && worker.heldByUserId !== null)) return true;
  // Tool/transcript location alone is binding metadata; recorded work is use.
  if (sessions.some((s) => s.prNumber !== null || s.summary !== null || s.plan !== null || s.outcome !== null || s.outcomeRef !== null || s.outcomeMeta !== null
    || [s.inputTokens, s.outputTokens, s.turnCount, s.errorCount].some((n) => n !== null && n !== 0) || s.launchOperationId !== null)) return true;
  await arm();
  const pristine = await removableGeneratedTickerIds(db, worker.id);
  for (const ref of workerReferenceInventory) {
    if (ref.model === 'Session') continue; // empty ended bindings are disposable
    // #3690 (cor:acl:140:03, ruling 0255 item 3): HOLDING a grant is not use of the worker; a holder that goes ends its grant, so the
    // delete is not refused for it (the AFTER DELETE trigger stamps the departure). ONLY the holder column: the requester
    // (`requested_by_worker_id`) and the events' worker still count, and a worker that asked for or used a grant is retired instead.
    if (ref.model === 'Grant' && ref.column === 'worker_id') continue;
    // #2736 (Holger R2, cor:agt:040:03): a bind's served-prompt record of one of THESE disposable sessions is the stint's
    // own audit record, not use of the worker; it goes with the session. Any row that is not exactly that still counts.
    const ownBind = ref.model === 'ServedPrompt' && sessionIds.length
      ? Prisma.sql` AND NOT (kind = 'BIND' AND session_id IN (${Prisma.join(sessionIds)}))` : Prisma.empty;
    // A pristine generated ticker, and the worker's own subscription to it, is the cast's bookkeeping (S8).
    const skip = pristine.length === 0 ? Prisma.empty
      : ref.table === 'tickers' ? Prisma.sql` AND id NOT IN (${Prisma.join(pristine)})`
      : ref.table === 'ticker_subscriptions' ? Prisma.sql` AND ticker_id NOT IN (${Prisma.join(pristine)})`
      : Prisma.empty;
    // #2766: the staffing acts' own events are bookkeeping, not use (see `selfBookkeeping`).
    const skipEvents = ref.table === 'agent_team_events'
      ? Prisma.sql` AND NOT (${selfBookkeeping(worker.id)})` : Prisma.empty;
    await arm();
    const rows = await db.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
      SELECT EXISTS (SELECT 1 FROM ${quoted(ref.table)} WHERE ${quoted(ref.column)} = ${worker.id}${skip}${skipEvents}${ownBind}) AS present`);
    if (rows[0].present) return true;
  }
  if (sessionIds.length) {
    for (const model of Prisma.dmmf.datamodel.models) {
      for (const field of model.fields.filter((f) => f.kind === 'scalar' && /sessionId$/i.test(f.name))) {
        // #2736: the bind record of a disposable session is removed with it (the FK cascades; see `ownBind` above).
        const bindRecord = model.name === 'ServedPrompt' ? Prisma.sql` AND kind <> 'BIND'` : Prisma.empty;
        await arm();
        const rows = await db.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
          SELECT EXISTS (SELECT 1 FROM ${quoted(model.dbName ?? model.name)}
          WHERE ${quoted(field.dbName ?? field.name)} IN (${Prisma.join(sessionIds)})${bindRecord}) AS present`);
        if (rows[0].present) return true;
      }
    }
  }
  for (const [table, column] of JSON_REFERENCES) {
    await arm();
    if (await jsonReferences(db, table, column, [worker.id, ...sessionIds], worker.id)) return true;
  }
  await arm();
  if (await encryptedHistoryMayReference(db, worker, sessionIds)) return true;
  await arm();
  const commentRows = await db.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
    SELECT EXISTS (SELECT 1 FROM comment_meta WHERE author_key = ${`w:${worker.id}`} OR retracted_by = ${`w:${worker.id}`}
      OR resolved_by = ${`w:${worker.id}`} OR thread_deleted_by = ${`w:${worker.id}`}) AS present`);
  if (commentRows[0].present) return true;
  await arm();
  return !!(worker.memoryId && (await db.node.count({ where: { memoryId: worker.memoryId } })
    || await db.asset.count({ where: { memoryId: worker.memoryId } })));
}
