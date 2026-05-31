-- Migration: abstract_origin_hash
-- Spec: specs/032-abstract-staleness/spec.md
-- Plan: specs/032-abstract-staleness/plan.md
--
-- Adds an optional `abstract_origin_hash` text column to BOTH `nodes`
-- AND `node_versions`. Stores SHA-256(content)[0:8] at the time the
-- abstract was authored, so consumers can detect staleness via
-- `abstract_origin_hash != computeContentHash(content)` (computed at
-- read time, NOT compared against the stored `content_hash` column
-- which has its own external-producer domain). Per spec 032 FR-001 +
-- FR-002.
--
-- Online safety + BEGIN/COMMIT runner-independence per the convention
-- established in spec 031's migrations. Two ALTERs in one transaction
-- so either both succeed or both abort under lock contention.
--
-- No backfill: existing rows get NULL in both tables. Pre-spec
-- abstracts naturally won't trigger the staleness signal (the check
-- short-circuits on null hash). See spec 032 Assumptions.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "nodes" ADD COLUMN "abstract_origin_hash" TEXT;
ALTER TABLE "node_versions" ADD COLUMN "abstract_origin_hash" TEXT;

COMMIT;
