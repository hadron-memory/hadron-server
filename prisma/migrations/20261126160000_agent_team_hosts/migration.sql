-- #5259 (V1 of #5209): the platform's own record of each host of a team App and its settings
-- (hrn:node:hadronmemory.com:specs:cor:agt:070:01, Proposed). Additive: one new table, its backfill, then the
-- agent-team-host invariants file, verbatim. expand-safe: the previous image never reads the table.
CREATE TABLE "agent_team_hosts" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "host_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "poll_interval_seconds" INTEGER,
    "delivery_enabled" BOOLEAN,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),
    "removed_by_user_id" TEXT,

    CONSTRAINT "agent_team_hosts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_team_hosts_app_host_uniq" ON "agent_team_hosts"("app_id", "host_id");

ALTER TABLE "agent_team_hosts" ADD CONSTRAINT "agent_team_hosts_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The backfill (gate decisions Q2 and Q6 on #5259): one live row per distinct (App, host) found in a live
-- `host:operate` scope on a live key, in a registration, or in an assignment. A pair seen only in revoked scopes or on
-- revoked keys gets no row. The label is the registration's, else the host id; the check-in interval is the
-- registration's; the creator is the earliest live scope's granter, else the earliest assignment's creator, else
-- null (never another person). No data refusal: every source's host id and the registration's label and interval are
-- already shape-checked to this table's ranges. Re-runnable: a pair that has a row is left alone.
WITH sources AS (
    SELECT k.app_id, s.host_id, s.granted_at AS at, s.granted_by_user_id AS scope_creator, NULL::text AS assign_creator
    FROM app_key_scopes s JOIN app_keys k ON k.id = s.app_key_id
    WHERE s.scope = 'host:operate' AND s.revoked_at IS NULL AND k.revoked_at IS NULL AND s.host_id IS NOT NULL
  UNION ALL
    SELECT r.app_id, r.host_id, r.registered_at, NULL, NULL FROM host_registrations r
  UNION ALL
    SELECT a.app_id, a.host_id, a.created_at, NULL, a.created_by_user_id FROM host_worker_assignments a
), pairs AS (
    SELECT app_id, host_id, min(at) AS created_at,
           (array_agg(scope_creator ORDER BY at, scope_creator) FILTER (WHERE scope_creator IS NOT NULL))[1] AS scope_creator,
           (array_agg(assign_creator ORDER BY at, assign_creator) FILTER (WHERE assign_creator IS NOT NULL))[1] AS assign_creator
    FROM sources GROUP BY app_id, host_id
)
INSERT INTO agent_team_hosts (id, app_id, host_id, label, poll_interval_seconds, created_by_user_id, created_at, updated_at)
SELECT gen_random_uuid()::text, p.app_id, p.host_id, COALESCE(r.label, p.host_id), r.poll_interval_seconds,
       COALESCE(p.scope_creator, p.assign_creator), p.created_at, p.created_at
FROM pairs p
LEFT JOIN host_registrations r ON r.app_id = p.app_id AND r.host_id = p.host_id
ON CONFLICT (app_id, host_id) DO NOTHING;

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
