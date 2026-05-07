-- 011-soft-delete-memory: finish the Memory soft-delete lifecycle.
-- Spec: spec-kits/specs/011-soft-delete-memory/spec.md
-- Plan: spec-kits/specs/011-soft-delete-memory/plan.md
-- Data model: spec-kits/specs/011-soft-delete-memory/data-model.md
--
-- This migration covers tasks T003 + T004 + T005 from the plan's tasks.md:
--   T003 — widen MemoryLogEventType enum to include LIFECYCLE
--   T004 — create memory_audit_log table (no FK to Memory; survives cascade)
--   T005 — persist the 011 release marker via a new system_config table
--
-- The deletedAt / deletedBy columns on Memory already exist (per
-- prisma/schema.prisma — they predate 011); this migration does NOT touch them.
-- The columns are used end-to-end by 011's behavioral changes in resolvers,
-- jobs, and the ops CLI, but no schema change is needed for them.
--
-- ALTER TYPE ADD VALUE in PG12+ runs inside an implicit transaction as long
-- as the new value is not used in the same transaction; we only ADD here, so
-- no use-of-new-value problem arises.

-- ──────────────────────────────────────────────────────────────────────
-- T003 — widen MemoryLogEventType
-- ──────────────────────────────────────────────────────────────────────

ALTER TYPE "MemoryLogEventType" ADD VALUE IF NOT EXISTS 'LIFECYCLE';

-- ──────────────────────────────────────────────────────────────────────
-- T004 — memory_audit_log
--
-- Append-only audit table for hard-delete events. Hard-delete cascade-removes
-- the parent Memory's MemoryLogEntry rows (FK is ON DELETE CASCADE), which
-- would erase the very audit row documenting the hard-delete. This sibling
-- table has no FK to Memory and survives the cascade. memory_id and
-- organization_id are stored as plain TEXT (denormalized URNs alongside, for
-- human-readable searches once the IDs are gone).
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE "memory_audit_log" (
  "id"               TEXT         NOT NULL,
  "memory_id"        TEXT         NOT NULL,
  "memory_urn"       TEXT         NOT NULL,
  "organization_id"  TEXT         NOT NULL,
  "organization_urn" TEXT         NOT NULL,
  "event_type"       TEXT         NOT NULL,
  "action"           TEXT         NOT NULL,
  "actor"            TEXT         NOT NULL,
  "detail"           JSONB,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "memory_audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "memory_audit_log_memory_id_idx"        ON "memory_audit_log" ("memory_id");
CREATE INDEX "memory_audit_log_memory_urn_idx"       ON "memory_audit_log" ("memory_urn");
CREATE INDEX "memory_audit_log_organization_id_idx"  ON "memory_audit_log" ("organization_id");
CREATE INDEX "memory_audit_log_action_idx"           ON "memory_audit_log" ("action");
CREATE INDEX "memory_audit_log_created_at_idx"       ON "memory_audit_log" ("created_at");

-- ──────────────────────────────────────────────────────────────────────
-- T005 — system_config + 011 release marker
--
-- A small key/value config table. Used by 011 to persist the release marker
-- read by the retention sweep (FR-023) so legacy deletedAt rows are not
-- surprise-purged on the first sweep tick. The marker is set once at deploy
-- time and never updated; subsequent migration retries / rollbacks must NOT
-- re-anchor it (ON CONFLICT DO NOTHING).
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE "system_config" (
  "key"        TEXT         NOT NULL,
  "value"      JSONB        NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3),

  CONSTRAINT "system_config_pkey" PRIMARY KEY ("key")
);

INSERT INTO "system_config" ("key", "value")
VALUES (
  'memory.011.release_marker',
  jsonb_build_object('deployedAt', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
)
ON CONFLICT ("key") DO NOTHING;
