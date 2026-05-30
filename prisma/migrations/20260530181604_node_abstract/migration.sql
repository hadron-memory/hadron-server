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

SET LOCAL lock_timeout = '5s';

ALTER TABLE "nodes" ADD COLUMN "abstract" TEXT;
