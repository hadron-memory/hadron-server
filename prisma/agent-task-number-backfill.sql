-- #2666: db-push databases need the original numbering backfill before NOT NULL.
-- Numbering body copied verbatim from 20261027100000; parity pinned in invariants.test.ts.
-- psql sends separate statements: make refusal atomic here too.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS agent_task_counters_project_uniq
  ON agent_task_counters (app_id) WHERE parent_task_id IS NULL;

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

-- #2666: a db-push counter table may be empty while projects are already numbered.
-- Preserve every existing high-water mark, including gaps from removed projects.
INSERT INTO agent_task_counters (id, app_id, parent_task_id, last_number)
  SELECT replace(gen_random_uuid()::text, '-', ''), app_id, NULL, MAX(task_number)
    FROM agent_tasks WHERE parent_task_id IS NULL GROUP BY app_id
  ON CONFLICT (app_id) WHERE parent_task_id IS NULL
  DO UPDATE SET last_number = GREATEST(agent_task_counters.last_number, EXCLUDED.last_number);

COMMIT;
