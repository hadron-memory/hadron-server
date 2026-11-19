-- Task history outlives a physically removed task. The sealed task id remains
-- in history, as actor ids already do; never cascade-delete append-only events.
ALTER TABLE agent_team_events DROP CONSTRAINT IF EXISTS agent_team_events_task_id_fkey;
-- #2644: SQL parity for db push and migration. Production task writers take
-- the App graph advisory lock BEFORE any task/worker row (blockers.ts).
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS chk_task_priority;
ALTER TABLE agent_tasks ADD CONSTRAINT chk_task_priority CHECK (priority BETWEEN 1 AND 5);
ALTER TABLE agent_task_blockers DROP CONSTRAINT IF EXISTS chk_task_blocker_self;
ALTER TABLE agent_task_blockers ADD CONSTRAINT chk_task_blocker_self CHECK (task_id <> blocker_task_id);

CREATE OR REPLACE FUNCTION hadron_task_blocker_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE aid text; bid text; state text;
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'A blocker link is immutable' USING ERRCODE = '23514'; END IF;
  SELECT app_id, status INTO aid, state FROM agent_tasks WHERE id = NEW.task_id;
  SELECT app_id INTO bid FROM agent_tasks WHERE id = NEW.blocker_task_id;
  IF aid IS NULL OR bid IS NULL OR aid <> bid THEN
    RAISE EXCEPTION 'Task blockers must belong to the same App' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('task-blockers:' || aid, 0));
  SELECT status INTO state FROM agent_tasks WHERE id = NEW.task_id;
  IF state NOT IN ('backlog','pending') THEN
    RAISE EXCEPTION 'Blockers change only on backlog or pending tasks' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    WITH RECURSIVE reach(id) AS (
      SELECT NEW.blocker_task_id
      UNION
      SELECT b.blocker_task_id FROM agent_task_blockers b JOIN reach r ON b.task_id = r.id
    ) SELECT 1 FROM reach WHERE id = NEW.task_id
  ) THEN RAISE EXCEPTION 'Task blocker cycle' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS task_blocker_guard ON agent_task_blockers;
CREATE TRIGGER task_blocker_guard BEFORE INSERT OR UPDATE ON agent_task_blockers
FOR EACH ROW EXECUTE FUNCTION hadron_task_blocker_guard();

-- Recompute only affected dependents, ordered by id. An actual true->false
-- transition owns the release timestamp and platform event, including FK cascades.
CREATE OR REPLACE FUNCTION hadron_refresh_task_blocked(tid text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE was boolean; active boolean; aid text; stamp timestamp;
BEGIN
  SELECT app_id, blocked INTO aid, was FROM agent_tasks WHERE id = tid FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT EXISTS(SELECT 1 FROM agent_task_blockers l JOIN agent_tasks b ON b.id = l.blocker_task_id
    WHERE l.task_id = tid AND b.status NOT IN ('finished','cancelled')) INTO active;
  IF active IS NOT DISTINCT FROM was THEN RETURN; END IF;
  stamp := clock_timestamp() AT TIME ZONE 'UTC';
  UPDATE agent_tasks SET blocked = active, released_at = CASE WHEN was AND NOT active THEN stamp ELSE released_at END WHERE id = tid;
  IF was AND NOT active AND EXISTS(SELECT 1 FROM apps WHERE id = aid) THEN
    INSERT INTO agent_team_events(id, app_id, task_id, type, payload, created_at)
      VALUES(replace(gen_random_uuid()::text,'-',''), aid, tid, 'task.released', '{}'::jsonb, stamp);
  END IF;
END $$;
CREATE OR REPLACE FUNCTION hadron_task_blocker_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM hadron_refresh_task_blocked(CASE WHEN TG_OP = 'DELETE' THEN OLD.task_id ELSE NEW.task_id END);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS task_blocker_refresh ON agent_task_blockers;
CREATE TRIGGER task_blocker_refresh AFTER INSERT OR DELETE ON agent_task_blockers
FOR EACH ROW EXECUTE FUNCTION hadron_task_blocker_refresh();
CREATE OR REPLACE FUNCTION hadron_task_end_releases() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tid text;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    FOR tid IN SELECT task_id FROM agent_task_blockers WHERE blocker_task_id = NEW.id ORDER BY task_id LOOP
      PERFORM hadron_refresh_task_blocked(tid);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS task_end_releases ON agent_tasks;
CREATE TRIGGER task_end_releases AFTER UPDATE OF status ON agent_tasks FOR EACH ROW EXECUTE FUNCTION hadron_task_end_releases();
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS chk_started_not_blocked;
ALTER TABLE agent_tasks ADD CONSTRAINT chk_started_not_blocked CHECK (NOT (status = 'started' AND blocked));

-- Updating either endpoint App must not invalidate an existing same-App link.
-- There is no task-transfer API; this also protects future internal writers.
CREATE OR REPLACE FUNCTION hadron_task_blocker_app_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.app_id IS DISTINCT FROM OLD.app_id AND EXISTS (
    SELECT 1 FROM agent_task_blockers WHERE task_id = OLD.id OR blocker_task_id = OLD.id
  ) THEN RAISE EXCEPTION 'A linked task cannot change App' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS task_blocker_app_fixed ON agent_tasks;
CREATE TRIGGER task_blocker_app_fixed BEFORE UPDATE OF app_id ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION hadron_task_blocker_app_fixed();
