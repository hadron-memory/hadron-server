-- Migration: node_versions_abstract
-- Spec: specs/031-node-abstract-field/spec.md
-- Plan: specs/031-node-abstract-field/plan.md
--
-- Follow-up to 20260530181604_node_abstract. Adds the matching `abstract`
-- column to `node_versions` so the NodeVersion snapshot machinery (in the
-- `upsertNode` resolver) captures abstract changes alongside description,
-- content, and the other audited columns. Without this, abstract edits
-- would silently drop out of version history.
--
-- This migration was not in the original spec 031 plan — the plan
-- assumed NodeVersion auto-projected all columns, which it does not
-- (the snapshot is a curated subset built by hand in the resolver).
-- Surfaced during US1 implementation.
--
-- Online safety + BEGIN/COMMIT runner-independence per the convention
-- established in 20260530181604_node_abstract/migration.sql.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "node_versions" ADD COLUMN "abstract" TEXT;

COMMIT;
