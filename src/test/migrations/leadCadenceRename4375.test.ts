/**
 * #4375: migration 20261123020000_lead_cadence_rename renames the cadence alarm's two tables IN PLACE
 * (coordinator_cadence_* to lead_cadence_*), so open episodes and every lead's first-seen clock survive, and every object
 * ends up under the name Prisma and the invariants files expect. Run on a throwaway database holding the old tables as the
 * 2026-11-03 migration created them, with rows in them, so the pin is the real data path and not a push.
 *
 * The final object names are compared with the worker database (db push + post-push.sql), which is the catalog the code is
 * written against: a name the migration leaves behind or spells differently fails here, not on the production deploy.
 */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { generateId } from '../../lib/id.js';
import { maintenanceUrl, withDbName } from '../dbWorkers.js';

const OLD = readFileSync(new URL('../../../prisma/migrations/20261103170000_coordinator_cadence_alarm/migration.sql', import.meta.url), 'utf8');
const NEW = readFileSync(new URL('../../../prisma/migrations/20261123020000_lead_cadence_rename/migration.sql', import.meta.url), 'utf8');
const TABLES = ['lead_cadence_episodes', 'lead_cadence_clocks'];

/** The function the old migration's triggers call exists in the real schema; here only its name matters. */
const PREREQ = `
  CREATE TABLE apps (id text PRIMARY KEY);
  CREATE TABLE workers (id text PRIMARY KEY, reports_to_worker_id text, retired_at timestamp);
  CREATE TABLE agent_team_events (id text PRIMARY KEY);
  CREATE FUNCTION worker_reference_fence_1162() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`;

async function inThrowawayDb(body: (pg: Client) => Promise<void>): Promise<void> {
  const name = `lc4375_${generateId().toLowerCase()}`;
  const admin = new Client({ connectionString: maintenanceUrl() });
  await admin.connect();
  let pg: Client | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    pg = new Client({ connectionString: withDbName(maintenanceUrl(), name) });
    await pg.connect();
    await pg.query(PREREQ);
    await body(pg);
  } finally {
    await pg?.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}

/** Every named object of the two tables: constraints and indexes, as sorted text. */
async function objectNames(q: (sql: string, p?: unknown[]) => Promise<{ rows: Array<{ n: string }> }>): Promise<string[]> {
  const rows = await q(
    `SELECT c.conname AS n FROM pg_constraint c WHERE c.conrelid = ANY (SELECT to_regclass(t)::oid FROM unnest($1::text[]) AS t WHERE to_regclass(t) IS NOT NULL)
     UNION ALL
     SELECT i.indexname AS n FROM pg_indexes i WHERE i.schemaname = current_schema() AND i.tablename = ANY($1::text[])`, [TABLES]);
  return rows.rows.map((r) => r.n).sort();
}

describe('#4375 migration 20261123020000_lead_cadence_rename', () => {
  it('renames both tables in place: an episode and a lead clock survive, the old names are gone, and the names equal a fresh push', async () => {
    await inThrowawayDb(async (pg) => {
      await pg.query(OLD);
      // w1 is a lead (w3 reports to it); w2 reports to nobody and nobody reports to it.
      await pg.query(`INSERT INTO apps VALUES ('a1'); INSERT INTO workers VALUES ('w1'), ('w2'), ('w3'); INSERT INTO agent_team_events VALUES ('e1');
        UPDATE workers SET reports_to_worker_id = 'w1' WHERE id = 'w3';
        INSERT INTO coordinator_cadence_episodes (id, app_id, worker_id, event_id, opened_at) VALUES ('ep1', 'a1', 'w1', 'e1', '2026-11-20 10:00:00');
        INSERT INTO coordinator_cadence_clocks (worker_id, app_id, observed_at) VALUES ('w1', 'a1', '2026-11-01 09:00:00'), ('w2', 'a1', '2026-11-02 09:00:00');`);

      await pg.query(NEW);

      expect(await pg.query(`SELECT to_regclass('coordinator_cadence_episodes') AS a, to_regclass('coordinator_cadence_clocks') AS b`)).toMatchObject({ rows: [{ a: null, b: null }] });
      expect((await pg.query(`SELECT id, worker_id, ended_at FROM lead_cadence_episodes`)).rows).toEqual([{ id: 'ep1', worker_id: 'w1', ended_at: null }]);
      // The lead's clock survives with its value; the non-lead's row is pruned (a worker that is not a lead has none).
      expect((await pg.query(`SELECT worker_id, to_char(observed_at, 'YYYY-MM-DD HH24:MI') AS at FROM lead_cadence_clocks ORDER BY worker_id`)).rows)
        .toEqual([{ worker_id: 'w1', at: '2026-11-01 09:00' }]);

      const migrated = await objectNames((sql, p) => pg.query(sql, p));
      expect(migrated.filter((n) => n.includes('coordinator'))).toEqual([]);
      const fresh = await objectNames(async (sql, p) => ({ rows: await db.$queryRawUnsafe<Array<{ n: string }>>(sql.replace(/\$1/g, `ARRAY['${TABLES.join("','")}']::text[]`), ) }));
      expect(migrated).toEqual(fresh);
    });
  });

  it('keeps the invariants: one open episode per lead, an episode never ends before it opens, and the triggers stay', async () => {
    await inThrowawayDb(async (pg) => {
      await pg.query(OLD);
      await pg.query(NEW);
      await pg.query(`INSERT INTO apps VALUES ('a1'); INSERT INTO workers VALUES ('w1'); INSERT INTO agent_team_events VALUES ('e1'), ('e2'), ('e3');`);
      await pg.query(`INSERT INTO lead_cadence_episodes (id, app_id, worker_id, event_id, opened_at) VALUES ('ep1', 'a1', 'w1', 'e1', '2026-11-20 10:00:00')`);
      await expect(pg.query(`INSERT INTO lead_cadence_episodes (id, app_id, worker_id, event_id, opened_at) VALUES ('ep2', 'a1', 'w1', 'e2', '2026-11-20 11:00:00')`)).rejects.toThrow(/one_open_uniq/);
      await expect(pg.query(`UPDATE lead_cadence_episodes SET ended_at = '2026-11-20 09:00:00'`)).rejects.toThrow(/chk_lead_cadence_episodes_shape/);
      const triggers = (await pg.query(`SELECT event_object_table AS t FROM information_schema.triggers WHERE trigger_name = 'worker_reference_fence_1162' GROUP BY 1 ORDER BY 1`)).rows.map((r) => r.t);
      expect(triggers).toEqual(['lead_cadence_clocks', 'lead_cadence_episodes']);
    });
  });

  it('MOVES the rows when both names exist (new tables created first), drops the old tables and orphans nothing (Riana P2-1)', async () => {
    await inThrowawayDb(async (pg) => {
      await pg.query(OLD);
      // The new tables already exist (an invariants file ran first): the same objects under the new names, holding one row.
      await pg.query(`CREATE TABLE lead_cadence_episodes (id text PRIMARY KEY, app_id text NOT NULL, worker_id text NOT NULL, event_id text NOT NULL UNIQUE, opened_at timestamp(3) NOT NULL, ended_at timestamp(3));
        CREATE TABLE lead_cadence_clocks (worker_id text PRIMARY KEY, app_id text NOT NULL, observed_at timestamp(3) NOT NULL);`);
      await pg.query(`INSERT INTO apps VALUES ('a1'); INSERT INTO workers VALUES ('w1'), ('w2'), ('w3'); INSERT INTO agent_team_events VALUES ('e1'), ('e2');
        UPDATE workers SET reports_to_worker_id = 'w1' WHERE id = 'w3'; UPDATE workers SET reports_to_worker_id = 'w2' WHERE id = 'w1';
        INSERT INTO coordinator_cadence_episodes (id, app_id, worker_id, event_id, opened_at) VALUES ('old-ep', 'a1', 'w1', 'e1', '2026-11-20 10:00:00');
        INSERT INTO coordinator_cadence_clocks (worker_id, app_id, observed_at) VALUES ('w1', 'a1', '2026-11-01 09:00:00'), ('w2', 'a1', '2026-11-02 09:00:00');
        INSERT INTO lead_cadence_clocks (worker_id, app_id, observed_at) VALUES ('w2', 'a1', '2026-11-22 09:00:00');`);
      await pg.query(NEW);
      expect((await pg.query(`SELECT to_regclass('coordinator_cadence_episodes') AS a, to_regclass('coordinator_cadence_clocks') AS b`)).rows[0]).toEqual({ a: null, b: null });
      expect((await pg.query(`SELECT id FROM lead_cadence_episodes`)).rows).toEqual([{ id: 'old-ep' }]);
      // w1 and w2 lead (w3 reports to w1, w1 reports to w2); w2's row already in the new table wins over the old one.
      expect((await pg.query(`SELECT worker_id, to_char(observed_at, 'YYYY-MM-DD') AS d FROM lead_cadence_clocks ORDER BY worker_id`)).rows)
        .toEqual([{ worker_id: 'w1', d: '2026-11-01' }, { worker_id: 'w2', d: '2026-11-22' }]);
    });
  });

  it('deletes the clocks of workers that are not leads (and of retired ones), and keeps a lead\'s (Riana P2-3)', async () => {
    await inThrowawayDb(async (pg) => {
      await pg.query(OLD);
      await pg.query(`INSERT INTO apps VALUES ('a1'); INSERT INTO workers VALUES ('lead'), ('rep'), ('loner'), ('gone-lead'), ('rep2'), ('self'), ('lead2'), ('retired-rep');
        UPDATE workers SET reports_to_worker_id = 'lead' WHERE id = 'rep';
        UPDATE workers SET reports_to_worker_id = 'gone-lead' WHERE id = 'rep2'; UPDATE workers SET retired_at = '2026-11-10 00:00:00' WHERE id = 'gone-lead';
        UPDATE workers SET reports_to_worker_id = 'self' WHERE id = 'self';
        UPDATE workers SET reports_to_worker_id = 'lead2' WHERE id = 'retired-rep'; UPDATE workers SET retired_at = '2026-11-10 00:00:00' WHERE id = 'retired-rep';
        INSERT INTO coordinator_cadence_clocks (worker_id, app_id, observed_at) SELECT id, 'a1', '2026-11-01 09:00:00' FROM workers WHERE id IN ('lead', 'loner', 'gone-lead', 'self', 'lead2');`);
      await pg.query(NEW);
      // lead: kept. loner: nobody reports to it. gone-lead: retired. self: reports only to itself. lead2: its only reporter is retired.
      expect((await pg.query(`SELECT worker_id FROM lead_cadence_clocks ORDER BY worker_id`)).rows).toEqual([{ worker_id: 'lead' }]);
    });
  });

  it('is a no-op twice, and on a database that never had the old tables', async () => {
    await inThrowawayDb(async (pg) => {
      await pg.query(NEW); // no old tables at all
      expect((await pg.query(`SELECT to_regclass('lead_cadence_episodes') AS a`)).rows[0].a).toBeNull();
      await pg.query(OLD);
      await pg.query(NEW);
      await pg.query(NEW); // already renamed
      const once = await objectNames((sql, p) => pg.query(sql, p));
      expect(once.length).toBeGreaterThan(8);
      await pg.query(NEW);
      expect(await objectNames((sql, p) => pg.query(sql, p))).toEqual(once); // the third run changes nothing either
    });
  });
});
