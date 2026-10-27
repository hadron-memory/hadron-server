-- #2553 (Task Management T12): the hierarchical task handle AT<n>(.<n>)*.
-- Order: (a) counter table + nullable columns, (b) AT0 per App, every parentless task becomes a child of it,
-- then number and compose handles top-down per parent in created_at, id order and set each counter to its
-- count, (c) the unique, then the invariants block below (triggers, CHECK, NOT NULL). A re-run is a no-op:
-- only rows without a number are touched and a counter only moves up. The invariants block is a
-- byte-identical copy of prisma/agent-task-number-invariants.sql (pinned by
-- src/lib/agentTasks/taskNumber2553.test.ts).

CREATE TABLE IF NOT EXISTS "agent_task_counters" (
  "id" TEXT NOT NULL,
  "app_id" TEXT NOT NULL,
  "parent_task_id" TEXT,
  "last_number" BIGINT NOT NULL,
  CONSTRAINT "agent_task_counters_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "agent_task_counters_app_id_parent_task_id_key" ON "agent_task_counters"("app_id", "parent_task_id");
CREATE UNIQUE INDEX IF NOT EXISTS agent_task_counters_project_uniq ON agent_task_counters (app_id) WHERE parent_task_id IS NULL;
ALTER TABLE "agent_task_counters" DROP CONSTRAINT IF EXISTS "agent_task_counters_app_id_fkey";
ALTER TABLE "agent_task_counters" ADD CONSTRAINT "agent_task_counters_app_id_fkey"
  FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_task_counters" DROP CONSTRAINT IF EXISTS "agent_task_counters_parent_task_id_fkey";
ALTER TABLE "agent_task_counters" ADD CONSTRAINT "agent_task_counters_parent_task_id_fkey"
  FOREIGN KEY ("parent_task_id") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_tasks" ADD COLUMN IF NOT EXISTS "task_number" BIGINT;
ALTER TABLE "agent_tasks" ADD COLUMN IF NOT EXISTS "handle" TEXT;

-- AT0, "No project": one backlog row per App (backlog is never matched and never stall-evaluated). Owner: the
-- App's owner, else the user who created it, else the owner of the App's oldest task; an App with none of
-- those and no tasks gets its AT0 when its first task is created (ensureProjectZero).
INSERT INTO agent_tasks (id, app_id, title, status, owner_user_id, owner_worker_id, task_number, handle, close_session_when_done, created_at)
  SELECT replace(gen_random_uuid()::text, '-', ''), a.id, 'No project', 'backlog',
         COALESCE(u_own.id, u_cr.id, first_task.owner_user_id),
         CASE WHEN COALESCE(u_own.id, u_cr.id, first_task.owner_user_id) IS NULL THEN first_task.owner_worker_id END,
         0, 'AT0', false, now()
    FROM apps a
    LEFT JOIN users u_own ON u_own.id = a.owner_user_id
    LEFT JOIN users u_cr ON u_cr.id = a.created_by
    LEFT JOIN LATERAL (
      SELECT t.owner_user_id, t.owner_worker_id FROM agent_tasks t WHERE t.app_id = a.id ORDER BY t.created_at, t.id LIMIT 1
    ) first_task ON true
   WHERE COALESCE(u_own.id, u_cr.id, first_task.owner_user_id, first_task.owner_worker_id) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM agent_tasks z WHERE z.app_id = a.id AND z.handle = 'AT0');

-- Projects count from 1: the project counter starts at 0 for every App that has an AT0.
INSERT INTO agent_task_counters (id, app_id, parent_task_id, last_number)
  SELECT replace(gen_random_uuid()::text, '-', ''), t.app_id, NULL, 0 FROM agent_tasks t WHERE t.handle = 'AT0'
  ON CONFLICT (app_id) WHERE parent_task_id IS NULL DO NOTHING;

-- Every existing parentless task (none was a project) becomes a child of its App's AT0.
UPDATE agent_tasks t SET parent_task_id = z.id
  FROM agent_tasks z
 WHERE z.app_id = t.app_id AND z.handle = 'AT0' AND t.parent_task_id IS NULL AND t.handle IS NULL;

DROP TABLE IF EXISTS _agent_task_walk;
CREATE TEMP TABLE _agent_task_walk AS
WITH RECURSIVE todo AS (
  SELECT t.id, t.app_id, t.parent_task_id,
         COALESCE(c.last_number, 0) + ROW_NUMBER() OVER (PARTITION BY t.app_id, t.parent_task_id ORDER BY t.created_at, t.id) AS n
    FROM agent_tasks t
    LEFT JOIN agent_task_counters c ON c.app_id = t.app_id AND c.parent_task_id IS NOT DISTINCT FROM t.parent_task_id
   WHERE t.task_number IS NULL
), walk AS (
  SELECT todo.id, todo.n, p.handle || '.' || todo.n AS handle
    FROM todo JOIN agent_tasks p ON p.id = todo.parent_task_id AND p.handle IS NOT NULL
  UNION ALL
  SELECT todo.id, todo.n, walk.handle || '.' || todo.n
    FROM todo JOIN walk ON todo.parent_task_id = walk.id
)
SELECT id, n, handle FROM walk;

-- A handle is a URN leaf of at most 64 characters and at most 16 segments (cor:urn:010:01), and nothing lets a task be
-- reparented, so a legacy chain whose backfilled handle would break either bound has no addressable handle. Refuse
-- the whole migration naming the first offender rather than mint an alias the parser rejects; nothing is truncated
-- or renumbered. scripts/db/check-agent-task-handle-bounds.sql counts such rows read-only before a deploy.
DO $$
DECLARE
  bad record;
BEGIN
  SELECT w.id, w.handle INTO bad FROM _agent_task_walk w
   WHERE length(w.handle) > 64 OR length(w.handle) - length(replace(w.handle, '.', '')) + 1 > 16
   ORDER BY length(w.handle) DESC, w.id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'agent task % would get handle % (over 64 characters or 16 levels): no addressable handle exists for it, see #2553', bad.id, bad.handle;
  END IF;
END $$;

UPDATE agent_tasks t SET task_number = w.n, handle = w.handle FROM _agent_task_walk w WHERE t.id = w.id;
DROP TABLE _agent_task_walk;

INSERT INTO agent_task_counters (id, app_id, parent_task_id, last_number)
  SELECT replace(gen_random_uuid()::text, '-', ''), app_id, parent_task_id, MAX(task_number)
    FROM agent_tasks WHERE parent_task_id IS NOT NULL GROUP BY app_id, parent_task_id
  ON CONFLICT (app_id, parent_task_id) DO UPDATE SET last_number = GREATEST(agent_task_counters.last_number, EXCLUDED.last_number);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_tasks_app_id_handle_key" ON "agent_tasks"("app_id", "handle");

-- #2553 (Task Management T12): the hierarchical task handle AT<n>(.<n>)* — counters, number-filling,
-- permanence and the reserved project AT0. Source of truth for these objects; the migration carries a
-- byte-identical copy (pinned by src/lib/agentTasks/taskNumber2553.test.ts) and post-push.sql includes this file.

-- One counter row per parent; parent_task_id NULL is the App's project counter. Prisma models the
-- (app_id, parent_task_id) unique (NULLs distinct, which is right for children); the project counter's
-- one-row-per-App rule is this partial index, which Prisma cannot express.
CREATE UNIQUE INDEX IF NOT EXISTS agent_task_counters_project_uniq
  ON agent_task_counters (app_id) WHERE parent_task_id IS NULL;

-- The number is part of identity, so a row never lacks one. insertTask states number and handle explicitly;
-- this trigger covers any writer that leaves them out. The counter row is its own row (not the App row, not
-- the parent task row), so it serializes creates under one parent and nothing else. Projects count from 1:
-- 0 is only ever the explicit AT0 row ensureProjectZero writes.
CREATE OR REPLACE FUNCTION agent_tasks_assign_number() RETURNS trigger AS $$
DECLARE
  parent_handle text;
  expected text;
BEGIN
  IF NEW.task_number IS NULL THEN
    IF NEW.parent_task_id IS NULL THEN
      INSERT INTO agent_task_counters (id, app_id, parent_task_id, last_number)
        VALUES (replace(gen_random_uuid()::text, '-', ''), NEW.app_id, NULL, 1)
        ON CONFLICT (app_id) WHERE parent_task_id IS NULL
        DO UPDATE SET last_number = agent_task_counters.last_number + 1
        RETURNING last_number INTO NEW.task_number;
    ELSE
      INSERT INTO agent_task_counters (id, app_id, parent_task_id, last_number)
        VALUES (replace(gen_random_uuid()::text, '-', ''), NEW.app_id, NEW.parent_task_id, 1)
        ON CONFLICT (app_id, parent_task_id)
        DO UPDATE SET last_number = agent_task_counters.last_number + 1
        RETURNING last_number INTO NEW.task_number;
    END IF;
  ELSE
    -- An explicit number is spent too: the counter moves up to it, so the next allocation never repeats it.
    IF NEW.parent_task_id IS NULL THEN
      INSERT INTO agent_task_counters (id, app_id, parent_task_id, last_number)
        VALUES (replace(gen_random_uuid()::text, '-', ''), NEW.app_id, NULL, NEW.task_number)
        ON CONFLICT (app_id) WHERE parent_task_id IS NULL
        DO UPDATE SET last_number = GREATEST(agent_task_counters.last_number, EXCLUDED.last_number);
    ELSE
      INSERT INTO agent_task_counters (id, app_id, parent_task_id, last_number)
        VALUES (replace(gen_random_uuid()::text, '-', ''), NEW.app_id, NEW.parent_task_id, NEW.task_number)
        ON CONFLICT (app_id, parent_task_id)
        DO UPDATE SET last_number = GREATEST(agent_task_counters.last_number, EXCLUDED.last_number);
    END IF;
  END IF;
  IF NEW.parent_task_id IS NULL THEN
    expected := 'AT' || NEW.task_number;
  ELSE
    SELECT handle INTO parent_handle FROM agent_tasks WHERE id = NEW.parent_task_id;
    expected := parent_handle || '.' || NEW.task_number;
  END IF;
  IF NEW.handle IS NULL THEN
    NEW.handle := expected;
  ELSIF expected IS NOT NULL AND NEW.handle <> expected THEN
    -- An explicit handle is the dotted path of its real parent, never another tree's.
    RAISE EXCEPTION 'agent_tasks.handle % does not match its parent and number (%)', NEW.handle, expected USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_tasks_assign_number ON agent_tasks;
CREATE TRIGGER trg_agent_tasks_assign_number BEFORE INSERT ON agent_tasks
  FOR EACH ROW EXECUTE FUNCTION agent_tasks_assign_number();

-- A committed number, handle and parentage are never changed: parentage is fixed at creation, so the handle
-- always matches the tree (cor:agt:050:01, Proposed handle paragraph). AT0 never leaves `backlog`, so the
-- matcher (pending only) and the stall evaluator (backlog is terminal there) never see it.
CREATE OR REPLACE FUNCTION agent_tasks_number_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.task_number IS DISTINCT FROM OLD.task_number
     OR NEW.handle IS DISTINCT FROM OLD.handle
     OR NEW.parent_task_id IS DISTINCT FROM OLD.parent_task_id THEN
    RAISE EXCEPTION 'agent_tasks.task_number, handle and parent_task_id are permanent' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.handle = 'AT0' AND NEW.status <> 'backlog' THEN
    RAISE EXCEPTION 'the project AT0 stays in backlog' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_tasks_number_immutable ON agent_tasks;
CREATE TRIGGER trg_agent_tasks_number_immutable BEFORE UPDATE OF task_number, handle, parent_task_id, status ON agent_tasks
  FOR EACH ROW EXECUTE FUNCTION agent_tasks_number_immutable();

-- 0 is reserved: only the project AT0 (top level, handle AT0) may carry it. The handle is the dotted path, at most 16 levels and 64 characters
-- (the parser's bounds, src/lib/agentTasks/handle.ts): the database refuses what the API could never resolve.
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS chk_agent_tasks_handle;
ALTER TABLE agent_tasks ADD CONSTRAINT chk_agent_tasks_handle CHECK (
  task_number >= 0 AND
  handle ~ '^AT(0|[1-9][0-9]*)(\.[1-9][0-9]*)*$' AND
  length(handle) <= 64 AND
  array_length(string_to_array(handle, '.'), 1) <= 16 AND
  (task_number > 0 OR (task_number = 0 AND parent_task_id IS NULL AND handle = 'AT0')) AND
  (parent_task_id IS NOT NULL OR handle = 'AT' || task_number) AND
  (parent_task_id IS NULL OR right(handle, length(task_number::text) + 1) = '.' || task_number)
);

ALTER TABLE agent_tasks ALTER COLUMN task_number SET NOT NULL;
ALTER TABLE agent_tasks ALTER COLUMN handle SET NOT NULL;
