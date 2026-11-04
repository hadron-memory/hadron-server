-- #3449: widen event types for App-defined codes; existing event/acknowledgement/payload rules remain.
ALTER TABLE agent_team_events DROP CONSTRAINT IF EXISTS chk_agent_team_events_shape;
ALTER TABLE agent_team_events ADD CONSTRAINT chk_agent_team_events_shape CHECK (
  -- #3449: additive union; preserve ALL old-admitted types, not just the three legacy App producers.
  (type ~ '^[a-z]+(\.[a-z]+(-[a-z]+)*)+$' OR
    (length(type) <= 64 AND type ~ '^app\.[a-z0-9-]+(\.[a-z0-9][a-z0-9-]*)+$' AND type ~ '[a-z0-9]$')) AND
  (severity IS NULL OR severity = 'alarm') AND
  -- IS NOT NULL, not = 'alarm': a NULL severity would make that comparison
  -- NULL, and a CHECK that evaluates to NULL passes.
  (severity IS NOT NULL OR num_nonnulls(chain, acknowledged_by_user_id, acknowledged_by_worker_id, acknowledged_at) = 0) AND
  (CASE WHEN acknowledged_at IS NULL
        THEN num_nonnulls(acknowledged_by_user_id, acknowledged_by_worker_id) = 0
        ELSE num_nonnulls(acknowledged_by_user_id, acknowledged_by_worker_id) >= 1 END) AND
  jsonb_typeof(payload) = 'object'
);
