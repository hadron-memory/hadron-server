-- Migration: memory_schema
-- Spec: #725 — structured storage (PR B). Adds Memory.schema: the opt-in,
-- per-memory PROPERTY SCHEMA (declared collections + typed fields). A dedicated
-- JSONB column (not nested in Memory.data) so a schema'd memory is visible at a
-- glance. Nullable, additive — NULL means an unstructured memory (the default).
-- Plain Prisma-modeled column: db push handles dev/test; nothing in post-push.sql.

BEGIN;

ALTER TABLE "memories" ADD COLUMN "schema" JSONB;

COMMIT;
