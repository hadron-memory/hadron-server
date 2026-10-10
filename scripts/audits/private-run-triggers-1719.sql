-- #1719 R5a pre-shipping inventory. READ ONLY; Holger runs this on prod.
-- Candidate inventory, not proof of absence: inspect every returned trigger.
-- Includes schedules, webhooks and live poll bindings. Traverses ALL live
-- graph edges across memory/tenant boundaries, including org-less private
-- memories (the former dependency-assembly leak crossed those boundaries),
-- and scans node bodies/data/properties plus trigger eventData for literal
-- canonical and legacy private-memory addresses. Dynamic/computed references,
-- external MCP tools and LLM-selected targets require owner review as well.
BEGIN TRANSACTION READ ONLY;
WITH RECURSIVE triggers AS (
  SELECT 'schedule' AS kind, id, name, organization_id, app_id, user_id,
         entry_node_urn, enabled, event_data::text AS payload
  FROM agent_schedules WHERE deleted_at IS NULL
  UNION ALL
  SELECT 'webhook', id, name, organization_id, app_id, user_id,
         entry_node_urn, enabled, event_data::text
  FROM agent_webhooks WHERE deleted_at IS NULL
  UNION ALL
  SELECT 'webfetch', job_id, 'poll binding', organization_id, app_id, user_id,
         entry_node_urn, true, NULL::text
  FROM webfetch_poll_bindings WHERE cancelled_at IS NULL
), addresses AS (
  SELECT id, organization_id, class, urn,
         regexp_replace(replace(urn, '::', ':'), '^hrn:mem:', '') AS bare,
         replace(regexp_replace(replace(urn, '::', ':'), '^hrn:mem:', ''), ':', '::') AS legacy
  FROM memories WHERE deleted_at IS NULL
), roots AS (
  SELECT t.*, n.id AS node_id
  FROM triggers t
  LEFT JOIN addresses m ON true
  LEFT JOIN nodes n ON n.memory_id = m.id AND n.deleted_at IS NULL
    AND t.entry_node_urn IN (
      'hrn:node:' || m.bare || ':' || n.loc,
      m.bare || ':' || n.loc,
      m.legacy || '::' || n.loc
    )
), walk(kind, trigger_id, node_id) AS (
  SELECT kind, id, node_id FROM roots WHERE node_id IS NOT NULL
  UNION
  SELECT w.kind, w.trigger_id, e.target_id
  FROM walk w JOIN edges e ON e.source_id = w.node_id AND e.deleted_at IS NULL
  JOIN nodes n ON n.id = e.target_id AND n.deleted_at IS NULL
  JOIN memories m ON m.id = n.memory_id AND m.deleted_at IS NULL
  JOIN triggers t ON t.kind = w.kind AND t.id = w.trigger_id
), evidence AS (
  SELECT w.kind, w.trigger_id, n.id AS node_id, m.id AS private_memory_id,
         CASE WHEN n.memory_id = m.id THEN 'node lives in private memory'
              ELSE 'literal private-memory reference' END AS reason
  FROM walk w JOIN nodes n ON n.id = w.node_id
  JOIN triggers t ON t.kind = w.kind AND t.id = w.trigger_id
  JOIN addresses m ON m.class = 'private'
  WHERE n.memory_id = m.id OR
    position(m.bare IN concat_ws(' ', n.content, n.data::text, n.properties::text, t.payload)) > 0 OR
    position(m.legacy IN concat_ws(' ', n.content, n.data::text, n.properties::text, t.payload)) > 0
)
SELECT t.kind, t.id, t.name, t.app_id, t.user_id AS run_as_user_id,
       t.enabled, t.entry_node_urn, e.private_memory_id,
       m.urn AS private_memory_urn, e.node_id, e.reason,
       CASE WHEN e.trigger_id IS NOT NULL THEN 'PRIVATE_CANDIDATE'
            ELSE 'REQUIRES_OWNER_REVIEW' END AS inventory_status
FROM triggers t LEFT JOIN evidence e ON e.kind = t.kind AND e.trigger_id = t.id
LEFT JOIN memories m ON m.id = e.private_memory_id
-- Includes all triggers: no static match must never be called safe.
ORDER BY t.kind, t.id, e.private_memory_id, e.node_id;
ROLLBACK;
