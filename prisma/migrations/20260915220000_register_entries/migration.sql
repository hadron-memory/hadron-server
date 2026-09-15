-- Spec 049 Phase 5 — the chat register (D-2026-09-13-007, plan §3.5 / §7.3).
--
-- A RegisterEntry says "this attendee takes part in this Channel": owned by
-- exactly ONE of an organization or an App (S1), naming a Worker OR an Agent
-- (or neither = every attendee in the owner's context). Intent, never
-- permission — the register grants nothing (D-008). Not exportable.

CREATE TYPE "RegisterRole" AS ENUM ('WATCH', 'POST', 'BOTH');

CREATE TABLE "register_entries" (
  "id"                  TEXT NOT NULL,
  "organization_id"     TEXT,
  "app_id"              TEXT,
  "channel_id"          TEXT NOT NULL,
  "attendee_worker_id"  TEXT,
  "attendee_agent_id"   TEXT,
  "role"                "RegisterRole" NOT NULL DEFAULT 'BOTH',
  "mention_only"        BOOLEAN NOT NULL DEFAULT false,
  "description"         TEXT,
  "install_default"     BOOLEAN NOT NULL DEFAULT false,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by"          TEXT,
  "updated_at"          TIMESTAMP(3),
  "updated_by"          TEXT,
  "deleted_at"          TIMESTAMP(3),
  "deleted_by"          TEXT,
  CONSTRAINT "register_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "register_entries_channel_id_idx" ON "register_entries"("channel_id");
CREATE INDEX "register_entries_organization_id_idx" ON "register_entries"("organization_id");
CREATE INDEX "register_entries_app_id_idx" ON "register_entries"("app_id");
CREATE INDEX "register_entries_attendee_worker_id_idx" ON "register_entries"("attendee_worker_id");
CREATE INDEX "register_entries_attendee_agent_id_idx" ON "register_entries"("attendee_agent_id");

ALTER TABLE "register_entries" ADD CONSTRAINT "register_entries_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "register_entries" ADD CONSTRAINT "register_entries_app_id_fkey"
  FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "register_entries" ADD CONSTRAINT "register_entries_channel_id_fkey"
  FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "register_entries" ADD CONSTRAINT "register_entries_attendee_worker_id_fkey"
  FOREIGN KEY ("attendee_worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "register_entries" ADD CONSTRAINT "register_entries_attendee_agent_id_fkey"
  FOREIGN KEY ("attendee_agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- S1: exactly one owner; at most one attendee. Synced with post-push.sql.
ALTER TABLE "register_entries" ADD CONSTRAINT "chk_register_owner"
  CHECK (num_nonnulls(organization_id, app_id) = 1);
ALTER TABLE "register_entries" ADD CONSTRAINT "chk_register_attendee"
  CHECK (num_nonnulls(attendee_worker_id, attendee_agent_id) <= 1);

-- The (owner, channel, attendee) natural keys, live rows only — a deleted
-- row frees its key (Prisma cannot express a partial unique).
CREATE UNIQUE INDEX "register_entries_app_channel_worker_uniq"
  ON "register_entries" ("app_id", "channel_id", "attendee_worker_id")
  WHERE app_id IS NOT NULL AND attendee_worker_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX "register_entries_app_channel_agent_uniq"
  ON "register_entries" ("app_id", "channel_id", "attendee_agent_id")
  WHERE app_id IS NOT NULL AND attendee_agent_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX "register_entries_app_channel_all_uniq"
  ON "register_entries" ("app_id", "channel_id")
  WHERE app_id IS NOT NULL AND attendee_worker_id IS NULL AND attendee_agent_id IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX "register_entries_org_channel_worker_uniq"
  ON "register_entries" ("organization_id", "channel_id", "attendee_worker_id")
  WHERE organization_id IS NOT NULL AND attendee_worker_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX "register_entries_org_channel_agent_uniq"
  ON "register_entries" ("organization_id", "channel_id", "attendee_agent_id")
  WHERE organization_id IS NOT NULL AND attendee_agent_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX "register_entries_org_channel_all_uniq"
  ON "register_entries" ("organization_id", "channel_id")
  WHERE organization_id IS NOT NULL AND attendee_worker_id IS NULL AND attendee_agent_id IS NULL AND deleted_at IS NULL;

-- Plan §3.5 recommendation: the defaults an Agent's install row is made with.
ALTER TABLE "agents" ADD COLUMN "register_defaults" JSONB;

-- §7.3 — install-created default rows for existing installs: one App-owned
-- row per live AppAgent whose App already has a default Channel. Apps whose
-- default Channel the backfill job creates later get theirs from the job.
INSERT INTO "register_entries" ("id", "app_id", "channel_id", "attendee_agent_id", "role", "mention_only", "description", "install_default", "created_by")
SELECT
  md5(random()::text || clock_timestamp()::text || aa.app_id || aa.agent_id),
  aa.app_id,
  a.default_channel_id,
  aa.agent_id,
  'BOTH',
  COALESCE((ag.register_defaults->>'mentionOnly')::boolean, false),
  'Default channel (installed)',
  true,
  'migration:20260915220000_register_entries'
FROM app_agents aa
JOIN apps a ON a.id = aa.app_id AND a.deleted_at IS NULL AND a.default_channel_id IS NOT NULL
JOIN agents ag ON ag.id = aa.agent_id AND ag.deleted_at IS NULL
ON CONFLICT ("app_id", "channel_id", "attendee_agent_id")
  WHERE app_id IS NOT NULL AND attendee_agent_id IS NOT NULL AND deleted_at IS NULL
  DO NOTHING;
