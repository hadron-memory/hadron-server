-- #1707 (Task Management T3): a worker's model family, host registrations.
-- Source of truth for these objects; the migration carries a byte-identical copy
-- (pinned by src/lib/agentTasks/invariants.test.ts) and post-push.sql includes this file.

-- cor:agt:060:04 — a model family is a lowercase token, the same shape
-- chk_model_family_availability_shape pins. NULL: the session's family could
-- not be classified, so its worker is not matchable until one is supplied.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS chk_sessions_family;
ALTER TABLE sessions ADD CONSTRAINT chk_sessions_family CHECK (
  family IS NULL OR family ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
);

-- cor:agt:070:01 — a host is identified within its App by a token; the label
-- is for display; the poll interval the host reports sets when it lapses.
ALTER TABLE host_registrations DROP CONSTRAINT IF EXISTS chk_host_registrations_shape;
ALTER TABLE host_registrations ADD CONSTRAINT chk_host_registrations_shape CHECK (
  host_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  AND char_length(label) BETWEEN 1 AND 128
  AND poll_interval_seconds BETWEEN 1 AND 86400
);

ALTER TABLE host_registration_workers DROP CONSTRAINT IF EXISTS chk_host_registration_workers_family;
ALTER TABLE host_registration_workers ADD CONSTRAINT chk_host_registration_workers_family CHECK (
  family ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
);

-- cor:agt:070:01 — a registration names only workers of its own App. The
-- writer checks this too; the trigger makes it a database fact, so no later
-- writer can make a host launchable for another tenant's worker.
CREATE OR REPLACE FUNCTION host_registration_worker_same_app() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM host_registrations r JOIN workers w ON w.app_id = r.app_id
    WHERE r.id = NEW.registration_id AND w.id = NEW.worker_id
  ) THEN
    RAISE EXCEPTION 'host_registration_workers: worker % is not in the registration''s App', NEW.worker_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_host_registration_workers_same_app';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_host_registration_workers_same_app ON host_registration_workers;
CREATE TRIGGER trg_host_registration_workers_same_app
  BEFORE INSERT OR UPDATE ON host_registration_workers
  FOR EACH ROW EXECUTE FUNCTION host_registration_worker_same_app();
