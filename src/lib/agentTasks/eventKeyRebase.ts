/**
 * #4111 — re-keying `agent_team_events.tx_id` after a logical restore, and the boot check that refuses a database
 * still holding foreign keys.
 *
 * `tx_id` is the writing transaction's id (#4084). It is cluster-local: a logical dump restored into a cluster whose
 * xid counter is lower keeps the source's ids, and the changed-since read (`agentTaskExternalIdChanges`, which serves
 * only `tx_id < pg_snapshot_xmin`) hides those rows until the new cluster catches up. Rows whose key is at or above the
 * new cluster's `xmax` ("H" rows) can never have been written here; rows below it ("L") can.
 *
 * The rebase (contract section A of hadron-server#4111) maps every nonzero key onto `3..K+2` so that, in every App, the
 * serving key `S = (tx_id, created_at, id)` orders the rows exactly as before, and every key sorts below every xid the
 * cluster will ever hand out from now on. Cursors already given out (an event id) resume at exactly the rows after them:
 * none skipped, none replayed. The read path is not touched.
 *
 * It is ONLY run by `scripts/ops/restore-with-rebase` against a new, fenced database (contract section B). It is not a
 * repair for a serving database.
 */
import type { ClientBase } from 'pg';

/** The table states of contract section A, each with its write behaviour. */
export type RebaseState =
  /** No rows, or only legacy `'0'` keys: nothing to map, no UPDATE. */
  | 'empty'
  | 'zero-only'
  /** Every nonzero key is below `X0`: already local, zero writes. */
  | 'local-only'
  /** At least one key at or above `X0`: every nonzero row is re-keyed. */
  | 'rebased';

export interface RebaseReport {
  state: RebaseState;
  /** Total rows (unchanged by the rebase). */
  rows: number;
  /** Nonzero-key rows. */
  nonzeroRows: number;
  /** Ascending runs of the nonzero rows: the keyspace the rebase needs. 0 when nothing is mapped. */
  runs: number;
  /** `pg_snapshot_xmax` read after the lock and before this transaction had an xid. */
  x0: string;
  /** Headroom: `X0 - 3`. */
  capacity: string;
  /** Rows whose key the UPDATE changed. */
  updated: number;
  /** `max(tx_id)` after the transaction, as text (`'0'` for an empty table). */
  maxKey: string;
}

/** Refusal: the table needs more keys than the cluster's xid counter leaves below itself. Raised before any write. */
export class RebaseHeadroomError extends Error {
  readonly code = 'REBASE_HEADROOM';
  constructor(
    readonly runs: number,
    readonly capacity: bigint,
  ) {
    super(
      `agent_team_events rebase needs ${runs} xids of headroom, cluster has ${capacity}; ` +
        'restore into a cluster whose xid counter is higher, or consume xids first',
    );
  }
}

/** Refusal: a check inside the rebase transaction failed; the transaction was rolled back. */
export class RebaseVerificationError extends Error {
  readonly code = 'REBASE_VERIFY';
}

/** The table, lock and trigger names, kept in one place for the pipeline's catalog checks. */
export const EVENT_TABLE = 'agent_team_events';
export const APPEND_ONLY_TRIGGER = 'agent_team_event_append_only';

/**
 * The ascending-run assignment, in SQL so the comparison uses the column's own collation. Rows are walked in serving
 * order S; a new run starts at the first row and wherever `(created_at, id)` is NOT strictly greater than the previous
 * row's. Run k gets key `2 + k`. The map is monotone in S and constant only where `(created_at, id)` ascends, so the
 * new `(tx_id, created_at, id)` orders every pair of rows as S did.
 */
const RUNS_SQL = `
  WITH ordered AS (
    SELECT id, created_at, tx_id,
           lag(created_at) OVER w AS prev_created_at,
           lag(id) OVER w AS prev_id
      FROM ${EVENT_TABLE}
     WHERE tx_id <> '0'::xid8
    WINDOW w AS (ORDER BY tx_id, created_at, id)
  )
  SELECT id, tx_id,
         sum(CASE WHEN prev_id IS NULL OR NOT ((created_at, id) > (prev_created_at, prev_id)) THEN 1 ELSE 0 END)
           OVER (ORDER BY tx_id, created_at, id ROWS UNBOUNDED PRECEDING) AS run
    FROM ordered`;

/** The serving order as an id list. The verification compares the before and after lists element by element. */
async function servingOrder(client: ClientBase): Promise<string[]> {
  const res = await client.query<{ id: string }>(`SELECT id FROM ${EVENT_TABLE} ORDER BY tx_id, created_at, id`);
  return res.rows.map((r) => r.id);
}

/**
 * Re-key `agent_team_events.tx_id` in one transaction (contract section A). The caller's connection must be able to
 * lock the table and disable its trigger (the owner role) and must not be inside a transaction.
 *
 * Steps, in order:
 *  1. `LOCK TABLE ... IN EXCLUSIVE MODE` (no writer until COMMIT; takes no xid).
 *  2. In its own statement: `X0 = pg_snapshot_xmax(pg_current_snapshot())`, asserting this transaction has no xid yet.
 *     Every xid any session takes later is `>= X0`. Then `LOCK ... IN ACCESS EXCLUSIVE MODE` (no reader either).
 *  3. Classify (empty / zero-only / local-only / rebase), count the runs K, refuse `K > X0 - 3` with zero writes.
 *  4. Snapshot the serving order, disable the append-only trigger, `UPDATE ... WHERE tx_id IS DISTINCT FROM new`,
 *     re-enable it.
 *  5. Verify before COMMIT: row count unchanged, serving order identical to the snapshot, `max(tx_id) = K + 2`,
 *     no NULL, no key at or above X0, the trigger enabled again.
 *
 * Idempotent: a rebased table is local-only, so a second run writes nothing.
 */
export async function rebaseEventKeys(client: ClientBase): Promise<RebaseReport> {
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  try {
    // EXCLUSIVE first: it conflicts with every write lock, so no writer can touch the table from here on, and unlike
    // ACCESS EXCLUSIVE it is not WAL-logged for standbys, so it does not assign this transaction an xid (at
    // wal_level >= replica, LOCK ... IN ACCESS EXCLUSIVE MODE does: measured on PG 17.11, #4111).
    await client.query(`LOCK TABLE ${EVENT_TABLE} IN EXCLUSIVE MODE`);

    // Its own statement, after the writer-excluding lock and before anything that assigns this transaction an xid
    // (ACCESS EXCLUSIVE, a write, a temp table, DDL). The assertion proves no xid was taken yet.
    const head = await client.query<{ x0: string; own: string | null }>(
      'SELECT pg_snapshot_xmax(pg_current_snapshot())::text AS x0, pg_current_xact_id_if_assigned()::text AS own',
    );
    const { x0, own } = head.rows[0];
    if (own !== null) {
      throw new RebaseVerificationError(`headroom was read after this transaction took xid ${own}`);
    }

    // Now exclude readers too, until COMMIT (this is where the transaction takes its own xid, which is >= X0).
    await client.query(`LOCK TABLE ${EVENT_TABLE} IN ACCESS EXCLUSIVE MODE`);
    const capacity = BigInt(x0) - 3n;

    const shape = await client.query<{ rows: string; nonzero: string; high: string; nulls: string }>(
      `SELECT count(*)::text AS rows,
              count(*) FILTER (WHERE tx_id <> '0'::xid8)::text AS nonzero,
              count(*) FILTER (WHERE tx_id >= $1::xid8)::text AS high,
              count(*) FILTER (WHERE tx_id IS NULL)::text AS nulls
         FROM ${EVENT_TABLE}`,
      [x0],
    );
    const rows = Number(shape.rows[0].rows);
    const nonzeroRows = Number(shape.rows[0].nonzero);
    const high = Number(shape.rows[0].high);
    if (Number(shape.rows[0].nulls) !== 0) {
      throw new RebaseVerificationError('agent_team_events holds a NULL tx_id; the NOT NULL migration has not run');
    }

    const finish = async (state: RebaseState, runs: number, updated: number): Promise<RebaseReport> => {
      const max = await client.query<{ max: string }>(
        `SELECT coalesce(max(tx_id), '0'::xid8)::text AS max FROM ${EVENT_TABLE}`,
      );
      await client.query('COMMIT');
      return {
        state,
        rows,
        nonzeroRows,
        runs,
        x0,
        capacity: capacity.toString(),
        updated,
        maxKey: max.rows[0].max,
      };
    };

    if (rows === 0) return await finish('empty', 0, 0);
    if (nonzeroRows === 0) return await finish('zero-only', 0, 0);
    if (high === 0) return await finish('local-only', 0, 0);

    const k = await client.query<{ runs: string }>(`SELECT coalesce(max(run), 0)::text AS runs FROM (${RUNS_SQL}) r`);
    const runs = Number(k.rows[0].runs);
    if (BigInt(runs) > capacity) throw new RebaseHeadroomError(runs, capacity);

    const before = await servingOrder(client);

    await client.query(`ALTER TABLE ${EVENT_TABLE} DISABLE TRIGGER ${APPEND_ONLY_TRIGGER}`);
    const upd = await client.query(
      `UPDATE ${EVENT_TABLE} e
          SET tx_id = (2 + r.run)::text::xid8
         FROM (${RUNS_SQL}) r
        WHERE e.id = r.id
          AND e.tx_id IS DISTINCT FROM (2 + r.run)::text::xid8`,
    );
    await client.query(`ALTER TABLE ${EVENT_TABLE} ENABLE TRIGGER ${APPEND_ONLY_TRIGGER}`);

    const after = await servingOrder(client);
    if (after.length !== before.length || after.length !== rows) {
      throw new RebaseVerificationError(`row count changed: ${before.length} -> ${after.length}`);
    }
    for (let i = 0; i < before.length; i++) {
      if (before[i] !== after[i]) {
        throw new RebaseVerificationError(`serving order changed at position ${i + 1}`);
      }
    }
    const post = await client.query<{ max: string; nulls: string; high: string; trig: string | null }>(
      `SELECT (SELECT max(tx_id)::text FROM ${EVENT_TABLE}) AS max,
              (SELECT count(*)::text FROM ${EVENT_TABLE} WHERE tx_id IS NULL) AS nulls,
              (SELECT count(*)::text FROM ${EVENT_TABLE} WHERE tx_id >= $1::xid8) AS high,
              (SELECT tgenabled::text FROM pg_trigger
                WHERE tgrelid = '${EVENT_TABLE}'::regclass AND tgname = '${APPEND_ONLY_TRIGGER}') AS trig`,
      [x0],
    );
    const p = post.rows[0];
    if (p.max !== String(runs + 2)) throw new RebaseVerificationError(`max(tx_id) is ${p.max}, expected ${runs + 2}`);
    if (p.nulls !== '0') throw new RebaseVerificationError('a NULL tx_id after the rebase');
    if (p.high !== '0') throw new RebaseVerificationError('a key at or above X0 after the rebase');
    if (p.trig !== 'O') throw new RebaseVerificationError(`append-only trigger state ${p.trig ?? 'missing'}`);

    return await finish('rebased', runs, upd.rowCount ?? 0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

/** Boot refusal: the database holds event keys this cluster never issued. */
export class ForeignEventKeyError extends Error {
  readonly code = 'FOREIGN_EVENT_KEYS';
  constructor(readonly count: number) {
    super(
      `agent_team_events holds ${count} row(s) whose tx_id is at or above this cluster's xmax: the database was ` +
        'logically restored without the key rebase. The changed-since read would hide them. Restore with ' +
        'scripts/ops/restore-with-rebase into a new database; refusing to start.',
    );
  }
}

/** The minimal query surface the boot check needs (a PrismaClient satisfies it). */
export interface RawQueryable {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/**
 * Boot check (contract section B, defense in depth): refuse to start if any `agent_team_events` row has a key at or
 * above `pg_snapshot_xmax(pg_current_snapshot())`. A key this cluster wrote is always below it, so such a row came from
 * another cluster. Reads only; writes nothing. It does not prove a database's history: an L-only or same-cluster
 * restore boots normally, and is served correctly.
 */
export async function assertEventKeysLocal(db: RawQueryable): Promise<void> {
  const rows = await db.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM ${EVENT_TABLE} WHERE tx_id >= pg_snapshot_xmax(pg_current_snapshot())`,
  );
  const n = rows[0]?.n ?? 0;
  if (n > 0) throw new ForeignEventKeyError(n);
}
