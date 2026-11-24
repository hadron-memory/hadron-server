-- hadron-server#4997 (PR #5053): read-only production preflight for migration 20261124150000_agent_task_is_project.
-- Counts per App only. s1_projects = rows the backfill marks (its predicate, verbatim). at0_conflicts, unnumbered_roots
-- and zero_not_at0 must be 0; at0_roots is 1 per App with tasks.
SELECT app_id,
       count(*) FILTER (WHERE parent_task_id IS NULL AND task_number > 0)                       AS s1_projects,
       count(*) FILTER (WHERE parent_task_id IS NULL AND task_number > 0 AND handle = 'AT0')    AS at0_conflicts,
       count(*) FILTER (WHERE parent_task_id IS NULL AND task_number = 0)                       AS at0_roots,
       count(*) FILTER (WHERE parent_task_id IS NULL AND task_number IS NULL)                   AS unnumbered_roots,
       count(*) FILTER (WHERE parent_task_id IS NULL AND task_number = 0 AND handle <> 'AT0')   AS zero_not_at0
FROM agent_tasks
GROUP BY app_id
HAVING count(*) FILTER (WHERE parent_task_id IS NULL) > 0
ORDER BY app_id;
