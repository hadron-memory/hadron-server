-- #2553: READ-ONLY pre-deploy count of legacy agent tasks whose backfilled handle (AT0.<n>(.<n>)*, numbered per parent
-- in created_at, id order exactly as the migration does) would pass 64 characters or 16 levels. Run on the
-- pre-migration table. A non-zero count means the migration refuses (see its guard) and needs a ruling.
WITH RECURSIVE todo AS (
  SELECT t.id, t.parent_task_id,
         ROW_NUMBER() OVER (PARTITION BY t.app_id, t.parent_task_id ORDER BY t.created_at, t.id) AS n
    FROM agent_tasks t
), walk AS (
  SELECT id, 'AT0.' || n AS handle FROM todo WHERE parent_task_id IS NULL
  UNION ALL
  SELECT todo.id, walk.handle || '.' || todo.n FROM todo JOIN walk ON todo.parent_task_id = walk.id
)
SELECT count(*) AS over_bound, min(handle) FILTER (WHERE length(handle) > 64 OR length(handle) - length(replace(handle, '.', '')) + 1 > 16) AS example
  FROM walk
 WHERE length(handle) > 64 OR length(handle) - length(replace(handle, '.', '')) + 1 > 16;
