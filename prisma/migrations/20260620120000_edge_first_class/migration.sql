-- Migration: edge_first_class
-- Spec: cor:dmo:060:03 (Edge) + cor:urn:010:01 (URN grammar) — spec 037.
--
-- Upgrades `edges` to a first-class, addressable entity:
--   * rename  label -> name   (and relax NOT NULL: `loc` is now the identity)
--   * add     memory_id       (denormalized from the SOURCE node's memory so
--                              `loc` can be unique within a memory — a unique
--                              index can't span the source-node table)
--   * add     loc             (the edge's identity + URN suffix
--                              hrn:edge:<org>::<memory>::<loc>; backfilled
--                              deterministically from the endpoints + name)
--   * add     description, is_runnable   (parity with nodes)
--   * swap    UNIQUE(source_id, target_id, label) -> UNIQUE(loc, memory_id)
-- and mirrors the rename/add on `pending_edges`.
--
-- The loc backfill mirrors src/lib/edgeLoc.ts (deriveEdgeLoc / sanitizeLocAtom)
-- EXACTLY via the temp function below, so a prod-backfilled loc equals what the
-- runtime would derive for the same edge (kept honest by an edgeLoc parity
-- test). Keep the two in lockstep when either changes.
--
-- Dev/test DBs are `prisma db push`-managed (created fresh, no rows) so they
-- never run this backfill; production applies it via `prisma migrate deploy`.
-- The new UNIQUE/index/FK are Prisma `@@unique`/`@@index`/relation — nothing to
-- sync into post-push.sql or globalSetup.ts (those carry only what a bare push
-- would drop: CHECK constraints + the pgvector HNSW index).
--
-- Wrapped in BEGIN/COMMIT: atomic, and required for SET LOCAL to take effect
-- (see 20260530181604_node_abstract for the convention).

BEGIN;

SET LOCAL lock_timeout = '10s';

-- ── edges: rename label -> name, relax NOT NULL ──────────────────────────────
ALTER TABLE "edges" RENAME COLUMN "label" TO "name";
ALTER TABLE "edges" ALTER COLUMN "name" DROP NOT NULL;

-- ── edges: memory_id (denormalized from the source node), backfill, NOT NULL ─
ALTER TABLE "edges" ADD COLUMN "memory_id" TEXT;
UPDATE "edges" e
   SET "memory_id" = n."memory_id"
  FROM "nodes" n
 WHERE n."id" = e."source_id";
ALTER TABLE "edges" ALTER COLUMN "memory_id" SET NOT NULL;

-- ── edges: loc — derive <sourceLoc>:<sanitize(name|'rel')>:<targetLoc> ────────
-- Session-local helper mirroring sanitizeLocAtom (pure ASCII so plain Postgres
-- regexp_replace reproduces the TS result); auto-dropped at session end.
CREATE OR REPLACE FUNCTION pg_temp.edge_sanitize_loc_atom(input text)
RETURNS text AS $$
DECLARE s text;
BEGIN
  s := regexp_replace(COALESCE(input, ''), '[^A-Za-z0-9._-]', '-', 'g');
  s := regexp_replace(s, '^[^A-Za-z0-9]+', '');
  s := regexp_replace(s, '[^A-Za-z0-9]+$', '');
  IF length(s) > 64 THEN
    s := regexp_replace(left(s, 64), '[^A-Za-z0-9]+$', '');
  END IF;
  IF length(s) = 0 THEN
    RETURN 'rel';
  END IF;
  RETURN s;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

ALTER TABLE "edges" ADD COLUMN "loc" TEXT;

-- Derive the base loc, then disambiguate the (rare) case where two pre-existing
-- edges between the same endpoints had labels that sanitize to the same atom
-- (the old UNIQUE allowed exact-label duplicates; the new UNIQUE(loc,memory_id)
-- does not). Deterministic by id order; appends a numeric atom to dups.
WITH derived AS (
  SELECT e."id",
         e."memory_id",
         src."loc" || ':' || pg_temp.edge_sanitize_loc_atom(e."name") || ':' || tgt."loc" AS base
    FROM "edges" e
    JOIN "nodes" src ON src."id" = e."source_id"
    JOIN "nodes" tgt ON tgt."id" = e."target_id"
),
ranked AS (
  SELECT "id", base,
         ROW_NUMBER() OVER (PARTITION BY "memory_id", base ORDER BY "id") AS rn
    FROM derived
)
UPDATE "edges" e
   SET "loc" = CASE WHEN r.rn = 1 THEN r.base ELSE r.base || ':' || r.rn END
  FROM ranked r
 WHERE r."id" = e."id";

ALTER TABLE "edges" ALTER COLUMN "loc" SET NOT NULL;

-- ── edges: description, is_runnable ──────────────────────────────────────────
ALTER TABLE "edges" ADD COLUMN "description" TEXT;
ALTER TABLE "edges" ADD COLUMN "is_runnable" BOOLEAN;

-- ── edges: swap identity UNIQUE, add memory index + FK ───────────────────────
DROP INDEX "edges_source_id_target_id_label_key";
CREATE UNIQUE INDEX "edges_loc_memory_id_key" ON "edges"("loc", "memory_id");
CREATE INDEX "edges_memory_id_idx" ON "edges"("memory_id");
ALTER TABLE "edges" ADD CONSTRAINT "edges_memory_id_fkey"
  FOREIGN KEY ("memory_id") REFERENCES "memories"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── pending_edges: rename label -> name, add nullable loc ────────────────────
ALTER TABLE "pending_edges" RENAME COLUMN "label" TO "name";
ALTER TABLE "pending_edges" ADD COLUMN "loc" TEXT;

COMMIT;
