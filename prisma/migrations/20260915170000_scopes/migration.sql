-- Spec 049 Phase 2 (D-2026-09-13-001) — named search scopes ("lenses").
--
-- A Scope is an ORDERED list of memories with a name, a description, and
-- exactly one owner — organization, Agent, or App — as three nullable FKs with
-- a CHECK, never an `owner_kind` string (the AiServiceConfig pattern, and the
-- one the spec-049 register table copies). It selects memories only and NEVER
-- grants: every consumer intersects it with the caller's accessible set
-- (D-2026-09-13-004).
--
-- `name` is unique PER OWNER among LIVE rows: partial unique indexes (Prisma
-- cannot express them — synced with prisma/post-push.sql and
-- src/test/globalSetup.ts), so a soft-deleted scope does not block its name
-- forever. Collisions across owners resolve App › Agent › organization,
-- namespaced, never unioned — application-side.
--
-- scope_memories is a join row rather than an id array on the scope so that
-- "which scopes include this memory" is a query and a deleted memory cascades
-- out of every scope (D-2026-09-13-001 rejected ids-in-JSON for exactly that).

CREATE TABLE IF NOT EXISTS "scopes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "organization_id" TEXT,
    "agent_id" TEXT,
    "app_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "scopes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "scopes_organization_id_idx" ON "scopes" ("organization_id");
CREATE INDEX IF NOT EXISTS "scopes_agent_id_idx" ON "scopes" ("agent_id");
CREATE INDEX IF NOT EXISTS "scopes_app_id_idx" ON "scopes" ("app_id");

ALTER TABLE "scopes"
    ADD CONSTRAINT "scopes_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scopes"
    ADD CONSTRAINT "scopes_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scopes"
    ADD CONSTRAINT "scopes_app_id_fkey"
    FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one owner (spec 049 §2 S1). Synced with post-push.sql + globalSetup.ts.
ALTER TABLE "scopes"
    ADD CONSTRAINT "chk_scope_owner"
    CHECK (num_nonnulls(organization_id, agent_id, app_id) = 1);

-- Per-owner name uniqueness among LIVE rows.
CREATE UNIQUE INDEX IF NOT EXISTS scopes_org_name_uniq
  ON scopes (organization_id, name) WHERE organization_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS scopes_agent_name_uniq
  ON scopes (agent_id, name) WHERE agent_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS scopes_app_name_uniq
  ON scopes (app_id, name) WHERE app_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS "scope_memories" (
    "scope_id" TEXT NOT NULL,
    "memory_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "scope_memories_pkey" PRIMARY KEY ("scope_id", "memory_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "scope_memories_scope_id_position_key" ON "scope_memories" ("scope_id", "position");
CREATE INDEX IF NOT EXISTS "scope_memories_memory_id_idx" ON "scope_memories" ("memory_id");

ALTER TABLE "scope_memories"
    ADD CONSTRAINT "scope_memories_scope_id_fkey"
    FOREIGN KEY ("scope_id") REFERENCES "scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scope_memories"
    ADD CONSTRAINT "scope_memories_memory_id_fkey"
    FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
