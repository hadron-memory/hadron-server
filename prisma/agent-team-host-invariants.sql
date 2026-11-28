-- #5259 (V1 of #5209): the hosts of a team App and their settings (hrn:node:hadronmemory.com:specs:cor:agt:070:01).
-- Source of truth for these objects; the migration carries a byte-identical copy
-- (pinned by src/api/graphql/schema/resolvers.agentTeamHost5259.test.ts) and post-push.sql includes this file.

-- The host id is a host token, as on a registration, a scope and an assignment; the label is 1 to 128 characters;
-- a null setting is the product default, and a set check-in interval is 1 to 86400 seconds (the registration's range).
-- A removed row names who removed it, and only a removed row does.
ALTER TABLE agent_team_hosts DROP CONSTRAINT IF EXISTS chk_agent_team_hosts_shape;
ALTER TABLE agent_team_hosts ADD CONSTRAINT chk_agent_team_hosts_shape CHECK (
  host_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
  char_length(label) BETWEEN 1 AND 128 AND
  (poll_interval_seconds IS NULL OR poll_interval_seconds BETWEEN 1 AND 86400) AND
  ((removed_at IS NULL) = (removed_by_user_id IS NULL))
);
