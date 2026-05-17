-- 023-app-shape — Migration 2 of 2: tables, role enums, CHECK constraints.
--
-- Additive only. `App.agentId` is NOT dropped in this migration; that
-- column drop and the consumer retrofit ship in a separate Phase 2b
-- PR per spec-kits/specs/023-app-shape/plan.md.

-- ─── Role enums for the new authorization primitives ────────────────────

CREATE TYPE "MemoryShareRole"  AS ENUM ('reader', 'writer');
CREATE TYPE "MemoryMemberRole" AS ENUM ('reader', 'writer', 'owner');

-- ─── AppAgent: N:M join, no `role` column, no `trainingMode` ───────────

CREATE TABLE "app_agents" (
  "app_id"     TEXT         NOT NULL,
  "agent_id"   TEXT         NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" TEXT,
  "updated_at" TIMESTAMP(3),
  "updated_by" TEXT,
  CONSTRAINT "app_agents_pkey"          PRIMARY KEY ("app_id", "agent_id"),
  CONSTRAINT "app_agents_app_id_fkey"   FOREIGN KEY ("app_id")   REFERENCES "apps"   ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "app_agents_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "app_agents_agent_id_idx" ON "app_agents" ("agent_id");

-- ─── MemoryShare: asymmetric cross-user grant (personal-class only) ────

CREATE TABLE "memory_shares" (
  "memory_id"  TEXT              NOT NULL,
  "grantee_id" TEXT              NOT NULL,
  "grantor_id" TEXT              NOT NULL,
  "role"       "MemoryShareRole" NOT NULL,
  "created_at" TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" TEXT,
  "updated_at" TIMESTAMP(3),
  "updated_by" TEXT,
  CONSTRAINT "memory_shares_pkey"            PRIMARY KEY ("memory_id", "grantee_id"),
  CONSTRAINT "memory_shares_memory_id_fkey"  FOREIGN KEY ("memory_id")  REFERENCES "memories" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "memory_shares_grantee_id_fkey" FOREIGN KEY ("grantee_id") REFERENCES "users"    ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "memory_shares_grantor_id_fkey" FOREIGN KEY ("grantor_id") REFERENCES "users"    ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "memory_shares_grantee_id_idx" ON "memory_shares" ("grantee_id");
CREATE INDEX "memory_shares_grantor_id_idx" ON "memory_shares" ("grantor_id");

-- ─── MemoryMember: symmetric membership (group-class only) ─────────────

CREATE TABLE "memory_members" (
  "memory_id"  TEXT               NOT NULL,
  "user_id"    TEXT               NOT NULL,
  "role"       "MemoryMemberRole" NOT NULL,
  "created_at" TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" TEXT,
  "updated_at" TIMESTAMP(3),
  "updated_by" TEXT,
  CONSTRAINT "memory_members_pkey"           PRIMARY KEY ("memory_id", "user_id"),
  CONSTRAINT "memory_members_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "memory_members_user_id_fkey"   FOREIGN KEY ("user_id")   REFERENCES "users"    ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "memory_members_user_id_idx" ON "memory_members" ("user_id");

-- ─── CHECK constraints on memories ─────────────────────────────────────

-- FR-024 bidirectional invariant: class = 'group' ⇔ visibility = 'GROUP'.
ALTER TABLE "memories"
  ADD CONSTRAINT "chk_memory_group_visibility" CHECK (
    (class = 'group' AND visibility = 'GROUP')
    OR
    (class <> 'group' AND visibility <> 'GROUP')
  );

-- FR-025: group memory has no single owner.
ALTER TABLE "memories"
  ADD CONSTRAINT "chk_memory_group_no_owner" CHECK (
    class <> 'group' OR user_id IS NULL
  );

-- FR-004 / FR-032: personal memory MUST carry the (App, Agent, User)
-- scope. The `user_memory_of_agent_id` column on `memories` (legacy
-- name; semantically `agent_id`) is required-non-null for personal class.
-- Existing personal-class rows from spec 005/008 already populate this.
ALTER TABLE "memories"
  ADD CONSTRAINT "chk_memory_personal_agent_id" CHECK (
    class <> 'personal' OR user_memory_of_agent_id IS NOT NULL
  );
