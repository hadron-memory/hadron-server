-- #4375 (rulings 0270, 0271) — the cadence alarm watches every LEAD, so its two tables stop naming the coordinator role.
--
-- A rename in place, not a rebuild: open episodes and every lead's first-seen clock survive (a rebuild would reset every
-- clock and make each lead late again). Every object of the two tables is renamed to the name Prisma and the invariants
-- files now expect (primary keys, foreign keys, the event_id unique constraint and its index, the two indexes, the CHECK).
-- The triggers keep their name: `worker_reference_fence_1162` is the function's name on every table that has it.
-- Stored `agent_team_events` rows keep their old type string `alarm.coordinator-cadence`; they are history and are not
-- rewritten (the server reads both spellings).
--
-- Guarded, so it is a no-op on a database that never had the old tables and does nothing twice.
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
  END IF;
  IF to_regclass('coordinator_cadence_clocks') IS NOT NULL AND to_regclass('lead_cadence_clocks') IS NULL THEN
    ALTER TABLE coordinator_cadence_clocks RENAME TO lead_cadence_clocks;
    ALTER INDEX IF EXISTS coordinator_cadence_clocks_pkey RENAME TO lead_cadence_clocks_pkey;
    ALTER TABLE lead_cadence_clocks RENAME CONSTRAINT coordinator_cadence_clocks_worker_id_fkey TO lead_cadence_clocks_worker_id_fkey;
    ALTER TABLE lead_cadence_clocks RENAME CONSTRAINT coordinator_cadence_clocks_app_id_fkey TO lead_cadence_clocks_app_id_fkey;
  END IF;
END $$;
