-- #4333 (part of #434 Slice C) — six UNIQUE constraints the migrations create (inline `event_id ... UNIQUE` on the
-- episode tables, and `UNIQUE(field_class,dimension,subject,window_start)` in 20261031220000_shared_rate_limiter).
-- `db push` creates only a same-name unique index, and ON CONFLICT ON CONSTRAINT and FK targets need the constraint.
-- Each is rebuilt as the constraint under the migration's name and columns: drop the constraint if a previous run made
-- it (which drops its index), drop push's same-name index, add the constraint. A re-run ends in the same state. The
-- migrations are the authority (ops:alpha:prisma-deploy-flow).
-- psql sends separate statements: one transaction, so a failure part way changes nothing.
-- Pinned by src/test/migrations/uniqueConstraints4333.test.ts and the migration replay check.
BEGIN;
ALTER TABLE coordinator_cadence_episodes DROP CONSTRAINT IF EXISTS coordinator_cadence_episodes_event_id_key;
DROP INDEX IF EXISTS coordinator_cadence_episodes_event_id_key;
ALTER TABLE coordinator_cadence_episodes ADD CONSTRAINT coordinator_cadence_episodes_event_id_key UNIQUE (event_id);
ALTER TABLE dark_worker_episodes DROP CONSTRAINT IF EXISTS dark_worker_episodes_event_id_key;
DROP INDEX IF EXISTS dark_worker_episodes_event_id_key;
ALTER TABLE dark_worker_episodes ADD CONSTRAINT dark_worker_episodes_event_id_key UNIQUE (event_id);
ALTER TABLE host_sweep_episodes DROP CONSTRAINT IF EXISTS host_sweep_episodes_event_id_key;
DROP INDEX IF EXISTS host_sweep_episodes_event_id_key;
ALTER TABLE host_sweep_episodes ADD CONSTRAINT host_sweep_episodes_event_id_key UNIQUE (event_id);
ALTER TABLE post_limit_episodes DROP CONSTRAINT IF EXISTS post_limit_episodes_event_id_key;
DROP INDEX IF EXISTS post_limit_episodes_event_id_key;
ALTER TABLE post_limit_episodes ADD CONSTRAINT post_limit_episodes_event_id_key UNIQUE (event_id);
ALTER TABLE start_failing_episodes DROP CONSTRAINT IF EXISTS start_failing_episodes_event_id_key;
DROP INDEX IF EXISTS start_failing_episodes_event_id_key;
ALTER TABLE start_failing_episodes ADD CONSTRAINT start_failing_episodes_event_id_key UNIQUE (event_id);
ALTER TABLE rate_limit_buckets DROP CONSTRAINT IF EXISTS rate_limit_buckets_field_class_dimension_subject_window_sta_key;
DROP INDEX IF EXISTS rate_limit_buckets_field_class_dimension_subject_window_sta_key;
ALTER TABLE rate_limit_buckets ADD CONSTRAINT rate_limit_buckets_field_class_dimension_subject_window_sta_key UNIQUE (field_class, dimension, subject, window_start);
COMMIT;
