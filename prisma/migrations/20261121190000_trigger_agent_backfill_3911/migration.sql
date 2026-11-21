-- #3911 (V71, cor:agt:040:10, Proposed): a schedule, webhook or web-poll binding stored with a NULL agent_id is
-- filled from its App's only installed Agent; where the App has several or none, the trigger is DISABLED and KEPT
-- (schedules and webhooks: enabled = false; poll bindings have no enabled flag, so cancelled_at is stamped,
-- cancel-and-keep). Nothing is deleted. Re-enabling is refused by the application until an Agent is named.
--
-- "Installed" counts the App's live physical installs (app_agents, agent not deleted) plus the Agents those install
-- as imports (agent_imports, imported agent not deleted) in a live, org-owned App. The derived-licence check is
-- left out on purpose: counting an Agent the licence rules would later drop can only turn "fill" into "disable"
-- (safe, recoverable by naming an Agent), never fill the wrong Agent.
--
-- Only live rows are touched (deleted_at IS NULL; poll bindings not yet cancelled). This migration refuses on no
-- data (so no HDPRF), and reports per kind through one NOTICE.
DO $$
DECLARE
  sched_filled integer; sched_disabled integer;
  hook_filled integer; hook_disabled integer;
  poll_filled integer; poll_cancelled integer;
BEGIN
  CREATE TEMP TABLE _app_installed_3911 ON COMMIT DROP AS
  SELECT app_id, array_agg(DISTINCT agent_id) AS agent_ids FROM (
    SELECT aa.app_id, aa.agent_id
      FROM app_agents aa JOIN agents a ON a.id = aa.agent_id AND a.deleted_at IS NULL
    UNION
    SELECT aa.app_id, ai.imported_agent_id
      FROM app_agents aa
      JOIN agents p ON p.id = aa.agent_id AND p.deleted_at IS NULL
      JOIN agent_imports ai ON ai.parent_agent_id = aa.agent_id
      JOIN agents ia ON ia.id = ai.imported_agent_id AND ia.deleted_at IS NULL
      JOIN apps ap ON ap.id = aa.app_id AND ap.organization_id IS NOT NULL
        AND ap.deleted_at IS NULL AND ap.uninstalled_at IS NULL
      JOIN organizations o ON o.id = ap.organization_id AND o.deleted_at IS NULL
  ) installed GROUP BY app_id;

  WITH f AS (
    UPDATE agent_schedules t SET agent_id = i.agent_ids[1]
      FROM _app_installed_3911 i
     WHERE t.agent_id IS NULL AND t.deleted_at IS NULL AND i.app_id = t.app_id
       AND cardinality(i.agent_ids) = 1
    RETURNING 1) SELECT count(*) INTO sched_filled FROM f;
  WITH d AS (
    UPDATE agent_schedules t SET enabled = false
     WHERE t.agent_id IS NULL AND t.deleted_at IS NULL AND t.enabled
    RETURNING 1) SELECT count(*) INTO sched_disabled FROM d;

  WITH f AS (
    UPDATE agent_webhooks t SET agent_id = i.agent_ids[1]
      FROM _app_installed_3911 i
     WHERE t.agent_id IS NULL AND t.deleted_at IS NULL AND i.app_id = t.app_id
       AND cardinality(i.agent_ids) = 1
    RETURNING 1) SELECT count(*) INTO hook_filled FROM f;
  WITH d AS (
    UPDATE agent_webhooks t SET enabled = false
     WHERE t.agent_id IS NULL AND t.deleted_at IS NULL AND t.enabled
    RETURNING 1) SELECT count(*) INTO hook_disabled FROM d;

  WITH f AS (
    UPDATE webfetch_poll_bindings t SET agent_id = i.agent_ids[1]
      FROM _app_installed_3911 i
     WHERE t.agent_id IS NULL AND t.cancelled_at IS NULL AND i.app_id = t.app_id
       AND cardinality(i.agent_ids) = 1
    RETURNING 1) SELECT count(*) INTO poll_filled FROM f;
  WITH c AS (
    UPDATE webfetch_poll_bindings t SET cancelled_at = now()
     WHERE t.agent_id IS NULL AND t.cancelled_at IS NULL
    RETURNING 1) SELECT count(*) INTO poll_cancelled FROM c;

  RAISE NOTICE 'trigger_agent_backfill_3911 schedules filled=% disabled=%; webhooks filled=% disabled=%; web_poll_bindings filled=% cancelled=%',
    sched_filled, sched_disabled, hook_filled, hook_disabled, poll_filled, poll_cancelled;
END $$;
