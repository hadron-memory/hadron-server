/**
 * #4111 contract section A (Proposed cor:agt:120, "The changed-since read never skips a change"): after a logical
 * restore, `rebaseEventKeys` re-keys `agent_team_events.tx_id` so the changed-since read serves every restored row, in
 * exactly the source's order, before every new row; cursors resume at exactly their tails.
 *
 * A restore is simulated on the test database by a MONOTONE shift of the keys (every key at or above a threshold moves
 * up by more than this cluster's xmax), which is exactly what a dump from a cluster with a higher xid counter looks
 * like: the serving order is unchanged, and the shifted rows are "H" (at or above xmax), the rest "L". The source's view
 * is captured through the resolver BEFORE the shift, while every row is still local and served.
 *
 * The headroom refusal (R6, `K > C`) needs a cluster whose xid counter is small; it lives with the pipeline suite on a
 * private cluster (scripts/ops/restore-with-rebase.test.ts).
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import {
  assertEventKeysLocal,
  ForeignEventKeyError,
  rebaseEventKeys,
  RebaseVerificationError,
  withAppendOnlyTriggerOff,
} from './eventKeyRebase.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const R = resolvers as any;
const M = R.Mutation;
const Q = R.Query;
let owner: any;
let apps: any[];
const ctx = (): Context => ({ db, userId: owner.id, roles: ['READER'] }) as Context;

/** Wait until every transaction that began before this call has ended (xmin is cluster-wide; see #4084's tests). */
async function settle(): Promise<void> {
  const [{ x }] = await db.$queryRaw<{ x: string }[]>`SELECT pg_current_xact_id()::text AS x`;
  for (let i = 0; i < 200; i++) {
    const [{ done }] = await db.$queryRaw<{ done: boolean }[]>`
      SELECT pg_snapshot_xmin(pg_current_snapshot()) > ${x}::xid8 AS done`;
    if (done) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('settle: an older transaction stayed open for 10s');
}

type Served = { cursor: string; kind: string; externalId: string };
/** Every change the read serves for an App, paging with `limit`, from `after`. */
async function readAll(appId: string, limit = 3, after: string | null = null): Promise<Served[]> {
  await settle();
  const out: Served[] = [];
  let cursor = after;
  for (let i = 0; i < 100; i++) {
    const page = await Q.agentTaskExternalIdChanges(null, { appRef: appId, after: cursor, limit }, ctx());
    out.push(...page.changes.map((c: any) => ({ cursor: c.cursor, kind: c.kind, externalId: c.externalId })));
    if (!page.hasMore) return out;
    cursor = page.nextCursor;
  }
  throw new Error('readAll: more than 100 pages');
}

async function withPg<T>(fn: (pg: Client) => Promise<T>): Promise<T> {
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  try {
    return await fn(pg);
  } finally {
    await pg.end();
  }
}

const xmax = async () =>
  BigInt((await db.$queryRaw<{ x: string }[]>`SELECT pg_snapshot_xmax(pg_current_snapshot())::text AS x`)[0].x);

/**
 * The simulated restore: every nonzero key at or above `threshold` moves up by `shift` (monotone, so the serving order
 * is unchanged). The append-only trigger refuses a key change, so it is disabled around the UPDATE, in one transaction.
 */
async function shiftKeys(threshold: bigint, shift: bigint): Promise<void> {
  await withPg(async (pg) => {
    await pg.query('BEGIN');
    await pg.query('ALTER TABLE agent_team_events DISABLE TRIGGER agent_team_event_append_only');
    await pg.query(
      `UPDATE agent_team_events SET tx_id = ((tx_id::text)::numeric + $2::numeric)::text::xid8
        WHERE tx_id <> '0'::xid8 AND tx_id >= $1::xid8`,
      [threshold.toString(), shift.toString()],
    );
    await pg.query('ALTER TABLE agent_team_events ENABLE TRIGGER agent_team_event_append_only');
    await pg.query('COMMIT');
  });
}

const servingOrder = async () =>
  (await db.$queryRaw<{ id: string }[]>`SELECT id FROM agent_team_events ORDER BY tx_id, created_at, id`).map((r) => r.id);

const X = (n: number) => `https://github.com/hadron-memory/hadron-server/issues/${7000 + n}`;
const createTask = (app: any, n: number) =>
  M.createAgentTask({}, { input: { appRef: app.id, title: `T${n}`, externalId: X(n) } }, ctx());
const release = (taskId: string) => M.releaseAgentTaskExternalId({}, { taskId }, ctx());
/** An ASSIGNED change on the task stamped `offset` from the database clock; `txId` forces a key (a legacy '0'). */
const assignment = (app: any, taskId: string, offset: string, txId?: string) =>
  txId === undefined
    ? db.$executeRaw`
        INSERT INTO agent_team_events (id, app_id, type, task_id, payload, created_at)
        VALUES (${generateId()}, ${app.id}, 'task.assigned', ${taskId}, '{"type":"task.assigned"}'::jsonb,
                (clock_timestamp() AT TIME ZONE 'UTC') + ${offset}::interval)`
    : db.$executeRaw`
        INSERT INTO agent_team_events (id, app_id, type, task_id, payload, created_at, tx_id)
        VALUES (${generateId()}, ${app.id}, 'task.assigned', ${taskId}, '{"type":"task.assigned"}'::jsonb,
                (clock_timestamp() AT TIME ZONE 'UTC') + ${offset}::interval, ${txId}::xid8)`;

/**
 * A mixed history in two Apps: legacy '0' rows, several transactions per App, backdated stamps (so `(created_at, id)`
 * does not ascend with the key: several runs), changes written before and after a release with stamps on the other
 * side of it (#4107's pairs), and a multi-row transaction. Returns the key threshold that splits it into L and H.
 */
async function buildHistory(): Promise<bigint> {
  for (const app of apps) {
    const legacy = await createTask(app, 0 + apps.indexOf(app) * 10);
    await assignment(app, legacy.id, '-3 days', '0');
    await assignment(app, legacy.id, '-2 days', '0');
    const t1 = await createTask(app, 1 + apps.indexOf(app) * 10);
    await assignment(app, t1.id, '-1 hour');
    await assignment(app, t1.id, '+1 hour');
    await assignment(app, t1.id, '-2 hours');
  }
  // Everything written so far stays "L"; everything after the threshold becomes "H".
  const [{ x }] = await db.$queryRaw<{ x: string }[]>`SELECT pg_current_xact_id()::text AS x`;
  const threshold = BigInt(x) + 1n;
  for (const app of apps) {
    const t2 = await createTask(app, 2 + apps.indexOf(app) * 10);
    await assignment(app, t2.id, '+1 hour'); // before the release, stamped after it: still carries the id
    await release(t2.id);
    await assignment(app, t2.id, '-1 hour'); // after the release, stamped before it: carries nothing
    const t3 = await createTask(app, 3 + apps.indexOf(app) * 10);
    await db.$transaction([
      assignment(app, t3.id, '+5 minutes'),
      assignment(app, t3.id, '-5 minutes'),
      assignment(app, t3.id, '+0 minutes'),
    ]);
    await assignment(app, t3.id, '-1 day');
  }
  return threshold;
}

beforeEach(async () => {
  await cleanDb(db);
  owner = await db.user.create({ data: { handle: `rebase4111-${generateId().slice(-8)}` } });
  apps = [];
  for (const name of ['A', 'B']) {
    const org = await db.organization.create({ data: { name, urn: `rebase4111-${generateId()}.test` } });
    const app = await db.app.create({ data: { organizationId: org.id, name, urn: `${org.urn}:team` } });
    await db.appMember.create({ data: { appId: app.id, userId: owner.id, role: 'member' } });
    apps.push(app);
  }
});

describe('#4111: the event-key rebase preserves the served order across a logical restore', { timeout: 60_000 }, () => {
  it('R1/R3/R7: a mixed L/H restored set is served in exact source order (kinds and ids), per App', async () => {
    const threshold = await buildHistory();
    const source = await Promise.all(apps.map((a) => readAll(a.id)));
    const order = await servingOrder();
    expect(source[0].length).toBeGreaterThan(5);
    expect(source[0].some((c) => c.kind === 'RELEASED')).toBe(true);

    await shiftKeys(threshold, (await xmax()) + 1_000_000_000n);
    expect(await servingOrder()).toEqual(order);
    // The defect: the H rows are hidden.
    const hidden = await Promise.all(apps.map((a) => readAll(a.id)));
    expect(hidden[0].length).toBeLessThan(source[0].length);

    const report = await withPg((pg) => rebaseEventKeys(pg));
    expect(report.state).toBe('rebased');
    expect(report.runs).toBeGreaterThan(1);
    expect(report.runs).toBeLessThan(report.nonzeroRows); // runs, not rows
    expect(report.maxKey).toBe(String(report.runs + 2));
    expect(await servingOrder()).toEqual(order);
    expect(await Promise.all(apps.map((a) => readAll(a.id)))).toEqual(source);
    // Legacy keys untouched.
    const [{ zeros }] = await db.$queryRaw<{ zeros: number }[]>`
      SELECT count(*)::int AS zeros FROM agent_team_events WHERE tx_id = '0'::xid8`;
    expect(zeros).toBe(4);
  });

  it('R2: every cursor the source handed out resumes at exactly its tail (L rows, H rows, the last row)', async () => {
    const threshold = await buildHistory();
    const source = await Promise.all(apps.map((a) => readAll(a.id)));
    await shiftKeys(threshold, (await xmax()) + 1_000_000_000n);
    await withPg((pg) => rebaseEventKeys(pg));
    for (const [i, app] of apps.entries()) {
      for (let at = 0; at < source[i].length; at++) {
        expect(await readAll(app.id, 2, source[i][at].cursor)).toEqual(source[i].slice(at + 1));
      }
    }
  });

  it('R4: a change written after the rebase is served once, after every restored change', async () => {
    const threshold = await buildHistory();
    const source = await readAll(apps[0].id);
    await shiftKeys(threshold, (await xmax()) + 1_000_000_000n);
    const report = await withPg((pg) => rebaseEventKeys(pg));
    const t = await createTask(apps[0], 99);
    await release(t.id);
    const after = await readAll(apps[0].id);
    expect(after.slice(0, source.length)).toEqual(source);
    expect(after.slice(source.length).map((c) => [c.kind, c.externalId])).toEqual([['RELEASED', X(99)]]);
    const [{ k }] = await db.$queryRaw<{ k: string }[]>`
      SELECT tx_id::text AS k FROM agent_team_events WHERE id = ${after[after.length - 1].cursor}`;
    expect(BigInt(k)).toBeGreaterThan(BigInt(report.maxKey));
    // The last restored cursor resumes at exactly the new change.
    expect(await readAll(apps[0].id, 1, source[source.length - 1].cursor)).toEqual(after.slice(source.length));
  });

  it('R5: a second run writes nothing, and every page size serves the same sequence', async () => {
    const threshold = await buildHistory();
    await shiftKeys(threshold, (await xmax()) + 1_000_000_000n);
    await withPg((pg) => rebaseEventKeys(pg));
    const once = await readAll(apps[0].id);
    const keys = await db.$queryRaw<{ id: string; k: string }[]>`SELECT id, tx_id::text AS k FROM agent_team_events ORDER BY id`;
    const again = await withPg((pg) => rebaseEventKeys(pg));
    expect(again).toMatchObject({ state: 'local-only', updated: 0, runs: 0 });
    expect(await db.$queryRaw`SELECT id, tx_id::text AS k FROM agent_team_events ORDER BY id`).toEqual(keys);
    for (const limit of [1, 2, 5, 100]) expect(await readAll(apps[0].id, limit)).toEqual(once);
  });

  it('R11 and L-only: empty, zero-only and all-local tables are left untouched', async () => {
    await db.$executeRawUnsafe('TRUNCATE agent_team_events CASCADE');
    expect(await withPg((pg) => rebaseEventKeys(pg))).toMatchObject({ state: 'empty', rows: 0, updated: 0 });

    const t = await createTask(apps[0], 1);
    await db.$executeRawUnsafe('TRUNCATE agent_team_events CASCADE');
    await assignment(apps[0], t.id, '-1 hour', '0');
    await assignment(apps[0], t.id, '-2 hours', '0');
    expect(await withPg((pg) => rebaseEventKeys(pg))).toMatchObject({ state: 'zero-only', rows: 2, updated: 0, maxKey: '0' });

    await assignment(apps[0], t.id, '+0 hours');
    const before = await db.$queryRaw`SELECT id, tx_id::text AS k FROM agent_team_events ORDER BY id`;
    expect(await withPg((pg) => rebaseEventKeys(pg))).toMatchObject({ state: 'local-only', updated: 0 });
    expect(await db.$queryRaw`SELECT id, tx_id::text AS k FROM agent_team_events ORDER BY id`).toEqual(before);
  });

  it('the append-only trigger is enabled again and still refuses a key change after the rebase', async () => {
    const threshold = await buildHistory();
    await shiftKeys(threshold, (await xmax()) + 1_000_000_000n);
    await withPg((pg) => rebaseEventKeys(pg));
    const [{ en }] = await db.$queryRaw<{ en: string }[]>`
      SELECT tgenabled::text AS en FROM pg_trigger WHERE tgname = 'agent_team_event_append_only'`;
    expect(en).toBe('O');
    await expect(db.$executeRaw`UPDATE agent_team_events SET tx_id = '5'::xid8 WHERE tx_id <> '5'::xid8`).rejects.toThrow(
      /append-only/,
    );
  });

  it('R9: tx_id refuses NULL, and an insert that omits it (every producer, the previous image too) gets a key', async () => {
    const t = await createTask(apps[0], 1);
    await expect(db.$executeRaw`
      INSERT INTO agent_team_events (id, app_id, type, task_id, payload, tx_id)
      VALUES (${generateId()}, ${apps[0].id}, 'task.assigned', ${t.id}, '{"type":"task.assigned"}'::jsonb, NULL)`).rejects.toThrow(
      /null value|23502/i,
    );
    await assignment(apps[0], t.id, '+0 hours');
    const [{ nulls }] = await db.$queryRaw<{ nulls: number }[]>`
      SELECT count(*)::int AS nulls FROM agent_team_events WHERE tx_id IS NULL`;
    expect(nulls).toBe(0);
  });

  it('R9: the migration backfills NULL to 0 through the append-only trigger and leaves the column NOT NULL', async () => {
    const t = await createTask(apps[0], 1);
    const sql = readFileSync(
      new URL('../../../prisma/migrations/20261113180000_agent_team_event_tx_id_not_null/migration.sql', import.meta.url),
      'utf8',
    );
    // Put the column back the way #4084 left it, with one NULL row, then apply the migration.
    await db.$executeRawUnsafe('ALTER TABLE agent_team_events ALTER COLUMN tx_id DROP NOT NULL');
    const id = generateId();
    await db.$executeRaw`
      INSERT INTO agent_team_events (id, app_id, type, task_id, payload, tx_id)
      VALUES (${id}, ${apps[0].id}, 'task.assigned', ${t.id}, '{"type":"task.assigned"}'::jsonb, NULL)`;
    await withPg((pg) => pg.query(sql));
    const [row] = await db.$queryRaw<{ k: string }[]>`SELECT tx_id::text AS k FROM agent_team_events WHERE id = ${id}`;
    expect(row.k).toBe('0');
    const [{ notnull, checks, en }] = await db.$queryRaw<{ notnull: boolean; checks: number; en: string }[]>`
      SELECT a.attnotnull AS notnull,
             (SELECT count(*)::int FROM pg_constraint WHERE conname = 'agent_team_events_tx_id_not_null') AS checks,
             (SELECT tgenabled::text FROM pg_trigger WHERE tgname = 'agent_team_event_append_only') AS en
        FROM pg_attribute a WHERE a.attrelid = 'agent_team_events'::regclass AND a.attname = 'tx_id'`;
    expect({ notnull, checks, en }).toEqual({ notnull: true, checks: 0, en: 'O' });
    const [{ def }] = await db.$queryRaw<{ def: string }[]>`
      SELECT pg_get_expr(d.adbin, d.adrelid) AS def FROM pg_attrdef d
        JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
       WHERE d.adrelid = 'agent_team_events'::regclass AND a.attname = 'tx_id'`;
    expect(def).toBe('pg_current_xact_id()');
  });
});

describe('#4111: the boot check refuses foreign event keys and writes nothing', { timeout: 30_000 }, () => {
  it('passes on local keys, refuses a key at or above xmax, and leaves the table as it was', async () => {
    const threshold = await buildHistory();
    await expect(assertEventKeysLocal(db)).resolves.toBeUndefined();
    await shiftKeys(threshold, (await xmax()) + 1_000_000_000n);
    const before = await db.$queryRaw`SELECT id, tx_id::text AS k FROM agent_team_events ORDER BY id`;
    const err = await assertEventKeysLocal(db).catch((e) => e);
    expect(err).toBeInstanceOf(ForeignEventKeyError);
    expect(err.count).toBeGreaterThan(0);
    expect(await db.$queryRaw`SELECT id, tx_id::text AS k FROM agent_team_events ORDER BY id`).toEqual(before);
    await withPg((pg) => rebaseEventKeys(pg));
    await expect(assertEventKeysLocal(db)).resolves.toBeUndefined();
  });
});

/** Every row, every column (tx_id included), as text: "byte-identical to its start" compares these. */
const tableImage = async () =>
  (await db.$queryRaw<{ r: string }[]>`SELECT e::text AS r FROM agent_team_events e ORDER BY id`).map((x) => x.r);
/** Every trigger on the table and its tgenabled state. */
const triggerImage = async () =>
  (
    await db.$queryRaw<{ t: string }[]>`
      SELECT tgname::text || '=' || tgenabled::text AS t FROM pg_trigger
       WHERE tgrelid = 'agent_team_events'::regclass ORDER BY tgname`
  ).map((x) => x.t);
const NOT_NULL_SQL = readFileSync(
  new URL('../../../prisma/migrations/20261113180000_agent_team_event_tx_id_not_null/migration.sql', import.meta.url),
  'utf8',
);

/** Wait until `pids` are all blocked on a lock. */
async function waitingOnLock(pids: number[]): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [{ n }] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ANY(${pids}::int[]) AND wait_event_type = 'Lock'`;
    if (n === pids.length) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the second connection never waited on the lock');
}

/** One event with NULL tx_id, the way #4084 left the column, plus a fixed history; returns the NULL row's id. */
async function legacyNullColumn(): Promise<string> {
  await buildHistory();
  const t = await createTask(apps[0], 50);
  await db.$executeRawUnsafe('ALTER TABLE agent_team_events ALTER COLUMN tx_id DROP NOT NULL');
  const id = generateId();
  await db.$executeRaw`
    INSERT INTO agent_team_events (id, app_id, type, task_id, payload, tx_id)
    VALUES (${id}, ${apps[0].id}, 'task.assigned', ${t.id}, '{"type":"task.assigned"}'::jsonb, NULL)`;
  return id;
}

describe('#4111 R12: the named-trigger exception (A2, T1-T5, L1)', { timeout: 60_000 }, () => {
  it.each([
    ['payload', `UPDATE agent_team_events SET payload = payload || '{"injected":1}'::jsonb WHERE id = (SELECT min(id) FROM agent_team_events)`, /other than tx_id/],
    [
      'acknowledgement',
      `UPDATE agent_team_events SET acknowledged_at = now(), acknowledged_by_user_id = (SELECT min(id) FROM users)
        WHERE severity = 'alarm'`,
      /other than tx_id/,
    ],
    ['actor', `UPDATE agent_team_events SET actor_app_key_id = 'injected' WHERE id = (SELECT min(id) FROM agent_team_events)`, /other than tx_id/],
    ['deleted-row', `DELETE FROM agent_team_events WHERE id = (SELECT min(id) FROM agent_team_events)`, /while the trigger was off/],
    [
      'inserted-row',
      `INSERT INTO agent_team_events (id, app_id, type, task_id, payload)
       SELECT 'injected4111', app_id, type, task_id, payload FROM agent_team_events WHERE id = (SELECT min(id) FROM agent_team_events)`,
      /while the trigger was off/,
    ],
  ])('T1: a %s change while the trigger is off aborts; keys, columns and trigger state roll back', async (_what, inject, msg) => {
    const threshold = await buildHistory();
    // An unacknowledged alarm: acknowledging it is the one change the trigger admits, and still not one the rebase may make.
    const [task] = await db.$queryRaw<{ id: string }[]>`SELECT id FROM agent_tasks WHERE app_id = ${apps[0].id} LIMIT 1`;
    await db.$executeRaw`
      INSERT INTO agent_team_events (id, app_id, type, task_id, payload, severity)
      VALUES (${generateId()}, ${apps[0].id}, 'task.stalled', ${task.id}, '{}'::jsonb, 'alarm')`;
    await shiftKeys(threshold, (await xmax()) + 1_000_000_000n);
    const table = await tableImage();
    const triggers = await triggerImage();
    const err = await withPg((pg) =>
      rebaseEventKeys(pg, { whileTriggerOff: async (c) => void expect((await c.query(inject)).rowCount).toBe(1) }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(RebaseVerificationError);
    expect(err.message).toMatch(msg);
    expect(await tableImage()).toEqual(table);
    expect(await triggerImage()).toEqual(triggers);
    expect(triggers).toContain('agent_team_event_append_only=O');
  });

  it('T2: a second connection\'s INSERT and UPDATE wait for the transaction, then meet the enabled trigger', async () => {
    const threshold = await buildHistory();
    await shiftKeys(threshold, (await xmax()) + 1_000_000_000n);
    const [target] = await db.$queryRaw<{ id: string; task: string; p: unknown }[]>`
      SELECT id, task_id AS task, payload AS p FROM agent_team_events ORDER BY id LIMIT 1`;
    const w1 = new Client({ connectionString: process.env.DATABASE_URL });
    const w2 = new Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([w1.connect(), w2.connect()]);
    try {
      const pids = [(await w1.query('SELECT pg_backend_pid() AS p')).rows[0].p, (await w2.query('SELECT pg_backend_pid() AS p')).rows[0].p];
      let update: Promise<unknown> = Promise.resolve();
      let insert: Promise<unknown> = Promise.resolve();
      const report = await withPg((pg) =>
        rebaseEventKeys(pg, {
          whileTriggerOff: async () => {
            update = w1.query(`UPDATE agent_team_events SET payload = '{"while":"off"}'::jsonb WHERE id = $1`, [target.id]).catch((e) => e);
            insert = w2
              .query(
                `INSERT INTO agent_team_events (id, app_id, type, task_id, payload, acknowledged_at)
                 VALUES ($1, $2, 'task.assigned', $3, '{}'::jsonb, now())`,
                [generateId(), apps[0].id, target.task],
              )
              .catch((e) => e);
            await waitingOnLock(pids);
          },
        }),
      );
      expect(report.state).toBe('rebased');
      expect(String(await update)).toMatch(/append-only/);
      expect(String(await insert)).toMatch(/already acknowledged/);
      const [row] = await db.$queryRaw<{ p: unknown }[]>`SELECT payload AS p FROM agent_team_events WHERE id = ${target.id}`;
      expect(row.p).toEqual(target.p);
    } finally {
      await Promise.all([w1.end(), w2.end()]);
    }
  });

  it('T2: the split and autocommit forms are refused before the trigger is touched', async () => {
    await buildHistory();
    const triggers = await triggerImage();
    let ran = false;
    const fn = async () => void (ran = true);
    await withPg(async (pg) => {
      // Autocommit: no transaction, so no lock survives the statement.
      await expect(withAppendOnlyTriggerOff(pg, fn)).rejects.toThrow(/split or autocommit form refused/);
      // A transaction whose lock does not exclude writers.
      await pg.query('BEGIN');
      await pg.query('LOCK TABLE agent_team_events IN ROW EXCLUSIVE MODE');
      await expect(withAppendOnlyTriggerOff(pg, fn)).rejects.toThrow(/split or autocommit form refused/);
      await pg.query('ROLLBACK');
    });
    expect(ran).toBe(false);
    expect(await triggerImage()).toEqual(triggers);
  });

  it.each([
    ['another trigger disabled', 'ALTER TABLE agent_team_events DISABLE TRIGGER worker_reference_fence_1162', /trigger state/],
    ['session_replication_role = replica', 'SET LOCAL session_replication_role = replica', /session_replication_role/],
  ])('T3: %s inside the window fails the trigger-state check and rolls back', async (_what, inject, msg) => {
    const threshold = await buildHistory();
    await shiftKeys(threshold, (await xmax()) + 1_000_000_000n);
    const table = await tableImage();
    const triggers = await triggerImage();
    const err = await withPg((pg) => rebaseEventKeys(pg, { whileTriggerOff: async (c) => void (await c.query(inject)) })).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(RebaseVerificationError);
    expect(err.message).toMatch(msg);
    expect(await tableImage()).toEqual(table);
    expect(await triggerImage()).toEqual(triggers);
  });

  it('L1: a transaction that already holds an xid at X0 is refused before any write', async () => {
    const threshold = await buildHistory();
    await shiftKeys(threshold, (await xmax()) + 1_000_000_000n);
    const table = await tableImage();
    const err = await withPg(async (pg) => {
      await pg.query('BEGIN');
      await pg.query('SELECT pg_current_xact_id()');
      return rebaseEventKeys(pg).catch((e) => e);
    });
    expect(err).toBeInstanceOf(RebaseVerificationError);
    expect(err.message).toMatch(/after this transaction took xid/);
    expect(await tableImage()).toEqual(table);
  });

  it('T5: the migration backfill changes only NULL to 0; every other column and every trigger state is unchanged', async () => {
    const id = await legacyNullColumn();
    const before = await tableImage();
    const triggers = await triggerImage();
    await withPg((pg) => pg.query(NOT_NULL_SQL));
    const after = await tableImage();
    expect(after.length).toBe(before.length);
    const nullRow = before.findIndex((r) => r.startsWith(`(${id},`));
    // Only the NULL row's image changes, and only by its key.
    expect(after.filter((r, i) => r !== before[i])).toEqual([after[nullRow]]);
    expect(await triggerImage()).toEqual(triggers);
  });

  it.each([
    ['a payload change in the backfill (T1)', (s: string) => s.replace(`SET "tx_id" = '0'::xid8`, `SET "tx_id" = '0'::xid8, "payload" = '{}'::jsonb`), /T1/],
    ['DISABLE TRIGGER ALL (T3)', (s: string) => s.replaceAll('TRIGGER "agent_team_event_append_only"', 'TRIGGER ALL'), /T3/],
    [
      'session_replication_role instead of the named disable (T3)',
      (s: string) =>
        s
          .replace('ALTER TABLE "agent_team_events" DISABLE TRIGGER "agent_team_event_append_only";', `SET LOCAL session_replication_role = replica;`)
          .replace('ALTER TABLE "agent_team_events" ENABLE TRIGGER "agent_team_event_append_only";', ''),
      /T3/,
    ],
    ['no writer-excluding lock (T2)', (s: string) => s.replace('LOCK TABLE "agent_team_events" IN ACCESS EXCLUSIVE MODE;', ''), /T2/],
  ])('T5 mutant: %s aborts the migration with a complete rollback', async (_what, mutate, msg) => {
    await legacyNullColumn();
    const mutated = mutate(NOT_NULL_SQL);
    expect(mutated).not.toBe(NOT_NULL_SQL);
    const table = await tableImage();
    const triggers = await triggerImage();
    const err = await withPg(async (pg) => {
      const e = await pg.query(mutated).catch((x) => x);
      await pg.query('ROLLBACK').catch(() => undefined);
      return e;
    });
    expect(String(err)).toMatch(msg);
    expect(await tableImage()).toEqual(table);
    expect(await triggerImage()).toEqual(triggers);
    const [{ notnull }] = await db.$queryRaw<{ notnull: boolean }[]>`
      SELECT attnotnull AS notnull FROM pg_attribute WHERE attrelid = 'agent_team_events'::regclass AND attname = 'tx_id'`;
    expect(notnull).toBe(false);
  });

  it('T5/T2: a writer that arrives during the migration waits, then meets the enabled trigger and NOT NULL', async () => {
    const id = await legacyNullColumn();
    const [{ task }] = await db.$queryRaw<{ task: string }[]>`SELECT task_id AS task FROM agent_team_events WHERE id = ${id}`;
    const body = NOT_NULL_SQL.replace(/COMMIT;\s*$/, '');
    expect(body).not.toBe(NOT_NULL_SQL);
    await withPg(async (mig) => {
      await mig.query(body);
      const w = new Client({ connectionString: process.env.DATABASE_URL });
      await w.connect();
      try {
        const pid = (await w.query('SELECT pg_backend_pid() AS p')).rows[0].p;
        const acked = w
          .query(
            `INSERT INTO agent_team_events (id, app_id, type, task_id, payload, acknowledged_at, tx_id)
             VALUES ($1, $2, 'task.assigned', $3, '{}'::jsonb, now(), NULL)`,
            [generateId(), apps[0].id, task],
          )
          .catch((e) => e);
        await waitingOnLock([pid]);
        await mig.query('COMMIT');
        expect(String(await acked)).toMatch(/already acknowledged|null value/);
        await expect(
          w.query(`INSERT INTO agent_team_events (id, app_id, type, task_id, payload, tx_id) VALUES ($1, $2, 'task.assigned', $3, '{}'::jsonb, NULL)`, [
            generateId(),
            apps[0].id,
            task,
          ]),
        ).rejects.toThrow(/null value/);
      } finally {
        await w.end();
      }
    });
  });
});
