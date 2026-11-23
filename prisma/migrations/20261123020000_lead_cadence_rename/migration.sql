-- #4375 (rulings 0270, 0271) — the cadence alarm watches every LEAD, so its two tables stop naming the coordinator role.
--
-- A rename in place, not a rebuild: open episodes and every lead's first-seen clock survive (a rebuild would reset every
-- clock and make each lead late again). Every object of the two tables is renamed to the name Prisma and the invariants
-- files now expect (primary keys, foreign keys, the event_id unique constraint and its index, the two indexes, the CHECK).
-- The triggers keep their name: `worker_reference_fence_1162` is the function's name on every table that has it.
-- Stored `agent_team_events` rows keep their old type string `alarm.coordinator-cadence`; they are history and are not
-- rewritten (the server reads both spellings).
--
-- Guarded: with no old tables nothing is renamed, and a second run changes nothing.
--
-- If BOTH names exist (a database where the invariants file created the new tables before this migration ran, as a dev
-- database can), the rows of the old tables are MOVED into the new ones (`ON CONFLICT DO NOTHING`: a row the new table
-- already holds wins) and the old tables are dropped, so no clock or open episode is orphaned and the old names go away.
--
-- Last, the first-seen clocks of workers that are not leads are deleted. A clock row belongs to a lead's CURRENT stint: it
-- starts a worker's 60 minutes at the first pass that sees it as a lead. A row left from the old role-based watch (a worker
-- in the coordinator role that nobody reports to) would otherwise make that worker late at once the day somebody starts
-- reporting to it. The pass keeps the same rule from here on (src/lib/agentTasks/leadCadence.ts). A lead keeps its row.
DO $$
BEGIN
  IF to_regclass('coordinator_cadence_episodes') IS NOT NULL AND to_regclass('lead_cadence_episodes') IS NULL THEN
    ALTER TABLE coordinator_cadence_episodes RENAME TO lead_cadence_episodes;
    ALTER INDEX IF EXISTS coordinator_cadence_episodes_pkey RENAME TO lead_cadence_episodes_pkey;
    ALTER TABLE lead_cadence_episodes RENAME CONSTRAINT coordinator_cadence_episodes_app_id_fkey TO lead_cadence_episodes_app_id_fkey;
    ALTER TABLE lead_cadence_episodes RENAME CONSTRAINT coordinator_cadence_episodes_worker_id_fkey TO lead_cadence_episodes_worker_id_fkey;
    ALTER TABLE lead_cadence_episodes RENAME CONSTRAINT coordinator_cadence_episodes_event_id_fkey TO lead_cadence_episodes_event_id_fkey;
    ALTER TABLE lead_cadence_episodes RENAME CONSTRAINT coordinator_cadence_episodes_event_id_key TO lead_cadence_episodes_event_id_key;
    ALTER TABLE lead_cadence_episodes RENAME CONSTRAINT chk_coordinator_cadence_episodes_shape TO chk_lead_cadence_episodes_shape;
    ALTER INDEX coordinator_cadence_episodes_app_id_ended_at_idx RENAME TO lead_cadence_episodes_app_id_ended_at_idx;
    ALTER INDEX coordinator_cadence_episodes_one_open_uniq RENAME TO lead_cadence_episodes_one_open_uniq;
  ELSIF to_regclass('coordinator_cadence_episodes') IS NOT NULL THEN
    INSERT INTO lead_cadence_episodes (id, app_id, worker_id, event_id, opened_at, ended_at)
      SELECT id, app_id, worker_id, event_id, opened_at, ended_at FROM coordinator_cadence_episodes ORDER BY opened_at
      ON CONFLICT DO NOTHING;
    DROP TABLE coordinator_cadence_episodes;
  END IF;
  IF to_regclass('coordinator_cadence_clocks') IS NOT NULL AND to_regclass('lead_cadence_clocks') IS NULL THEN
    ALTER TABLE coordinator_cadence_clocks RENAME TO lead_cadence_clocks;
    ALTER INDEX IF EXISTS coordinator_cadence_clocks_pkey RENAME TO lead_cadence_clocks_pkey;
    ALTER TABLE lead_cadence_clocks RENAME CONSTRAINT coordinator_cadence_clocks_worker_id_fkey TO lead_cadence_clocks_worker_id_fkey;
    ALTER TABLE lead_cadence_clocks RENAME CONSTRAINT coordinator_cadence_clocks_app_id_fkey TO lead_cadence_clocks_app_id_fkey;
  ELSIF to_regclass('coordinator_cadence_clocks') IS NOT NULL THEN
    INSERT INTO lead_cadence_clocks (worker_id, app_id, observed_at)
      SELECT worker_id, app_id, observed_at FROM coordinator_cadence_clocks
      ON CONFLICT (worker_id) DO NOTHING;
    DROP TABLE coordinator_cadence_clocks;
  END IF;
  IF to_regclass('lead_cadence_clocks') IS NOT NULL THEN
    DELETE FROM lead_cadence_clocks c
     WHERE NOT EXISTS (SELECT 1 FROM workers r WHERE r.reports_to_worker_id = c.worker_id AND r.id <> c.worker_id AND r.retired_at IS NULL)
        OR EXISTS (SELECT 1 FROM workers w WHERE w.id = c.worker_id AND w.retired_at IS NOT NULL);
  END IF;
END $$;
