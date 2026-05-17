-- 023-app-shape Phase 2b — drop `App.agentId`.
--
-- Per spec 023 FR-006, the MVP cohort recreates Apps fresh and no
-- data migration is required. This migration adds a defensive
-- backfill step anyway: any existing `apps.agent_id` value is
-- materialized as an `app_agents(app_id, agent_id)` row before the
-- column is dropped. The backfill is a no-op on clean production
-- but preserves dev/CI Apps that were created in the 008 shape.
--
-- Forward-only — there is no rollback for the column drop. Consumer
-- retrofit (mcp/access-control.ts, resolvers.ts, ensureAppMember.ts)
-- ships in the same PR; the GraphQL `App.agentId` / `App.agent` fields
-- remain as soft-deprecated convenience reads resolved via the first
-- AppAgent row.

-- ─── Defensive backfill: app_agents from apps.agent_id ──────────────────
-- ON CONFLICT DO NOTHING because the new install flows (US1) may have
-- already populated `app_agents` for some Apps. The composite PK
-- (app_id, agent_id) catches the duplicate cleanly.

-- Use apps.created_at (NOT updated_at) for the AppAgent row's created_at.
-- The "primary agent" helper orders AppAgent by createdAt asc; using
-- apps.updated_at would let unrelated App updates flip which agent the
-- primary helper returns. The original-install time is the only stable
-- ordering source we have.
INSERT INTO "app_agents" ("app_id", "agent_id", "created_at", "created_by")
SELECT
  a."id",
  a."agent_id",
  COALESCE(a."created_at", CURRENT_TIMESTAMP),
  a."created_by"
FROM "apps" a
WHERE a."agent_id" IS NOT NULL
  AND a."deleted_at" IS NULL
ON CONFLICT ("app_id", "agent_id") DO NOTHING;

-- ─── Drop the column + FK + index ───────────────────────────────────────

ALTER TABLE "apps" DROP CONSTRAINT IF EXISTS "apps_agent_id_fkey";
DROP INDEX IF EXISTS "apps_agent_id_idx";
ALTER TABLE "apps" DROP COLUMN "agent_id";
