-- Migration: node_abstract
-- Spec: specs/031-node-abstract-field/spec.md
-- Plan: specs/031-node-abstract-field/plan.md
--
-- Adds an optional `abstract` text column to `nodes`. Nullable, no default,
-- no CHECK constraint. Validation (2000-char cap + trim-then-check
-- whitespace normalization) lives at the API boundary per the typed-error
-- pattern in src/lib/entityRef/errors.ts (constitution S2).
--
-- Online safety: adding a nullable column with no default is metadata-only
-- on Postgres >= 11 (zero table rewrite, zero row lock at the data level).
-- The ALTER TABLE still takes an ACCESS EXCLUSIVE lock on `nodes` for the
-- catalog update; the `SET LOCAL lock_timeout` below ensures the migration
-- aborts cleanly under lock contention rather than queueing the entire
-- request pool. This is the first migration in this repo to set
-- lock_timeout — see specs/031-node-abstract-field/data-model.md "Online-
-- safe with one operational caveat" for the operational guidance.
--
-- Runner-independence: the BEGIN/COMMIT wrapper is REQUIRED for `SET LOCAL`
-- to take effect. Per CLAUDE.md this repo uses `prisma db push` (not
-- `prisma migrate deploy`) on dev/test, and production migration runners
-- vary; psql -f does NOT auto-wrap files in a transaction, so without the
-- explicit BEGIN/COMMIT, `SET LOCAL` would emit `WARNING: SET LOCAL can
-- only be used in transaction blocks` and the lock_timeout would silently
-- have no effect — exactly the failure mode this migration is trying to
-- prevent. PR-199 review surfaced this. The convention for any future
-- migration that needs SET LOCAL is to wrap explicitly.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "nodes" ADD COLUMN "abstract" TEXT;

COMMIT;
