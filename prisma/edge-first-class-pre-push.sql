-- #4540: the migrationless counterpart of 20260620120000_edge_first_class.
-- A populated legacy edges table cannot receive required memory_id/loc through db push alone.
-- Copy the migration's source-memory backfill and deterministic loc/collision derivation; their
-- statements are pinned verbatim, and SQL output is checked against src/lib/edgeLoc.ts.
-- Each missing column is transitioned independently. Existing columns/edited locs are untouched;
-- a fresh database is left for db push. Historical label values become name before deriving loc.
-- Prisma's push then installs the modeled indexes, FK, description and is_runnable fields.
DO $edge_first_class$
DECLARE collision_ids text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'edges'
  ) THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'edges' AND column_name = 'memory_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'edges' AND column_name = 'loc'
  ) THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'edges' AND column_name = 'label'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'edges' AND column_name = 'name'
  ) THEN
    ALTER TABLE "edges" RENAME COLUMN "label" TO "name";
    ALTER TABLE "edges" ALTER COLUMN "name" DROP NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'edges' AND column_name = 'memory_id'
  ) THEN
ALTER TABLE "edges" ADD COLUMN "memory_id" TEXT;
UPDATE "edges" e
   SET "memory_id" = n."memory_id"
  FROM "nodes" n
 WHERE n."id" = e."source_id";
ALTER TABLE "edges" ALTER COLUMN "memory_id" SET NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'edges' AND column_name = 'loc'
  ) THEN
CREATE OR REPLACE FUNCTION pg_temp.edge_sanitize_loc_atom(input text)
RETURNS text AS $$
DECLARE s text;
BEGIN
  -- JS's non-Unicode regex replaces both UTF-16 units of each non-BMP character (#4540, Ada123928).
  -- Keep the historical migration unchanged; the remaining backfill statements below are verbatim.
  s := regexp_replace(COALESCE(input, ''), U&'[\+010000-\+10FFFF]', '--', 'g');
  s := regexp_replace(s, '[^A-Za-z0-9._-]', '-', 'g');
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
  END IF;

  -- A numeric suffix can itself equal another edge's natural base (target locs
  -- may contain colons). Refuse inside this DO so rename/backfills roll back;
  -- do not commit required columns and strand the next push on its UNIQUE index.
  SELECT string_agg(id, ', ' ORDER BY id) INTO collision_ids
    FROM (
      SELECT e.id
        FROM edges e
        JOIN (
          SELECT memory_id, loc FROM edges
          GROUP BY memory_id, loc HAVING count(*) > 1
        ) duplicates USING (memory_id, loc)
       ORDER BY e.id LIMIT 20
    ) offenders;
  IF collision_ids IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'edge loc collision; conflicting edge ids (up to 20): ' || collision_ids,
      HINT = 'No edge transition was committed. Resolve the ambiguous legacy labels or endpoint locs, then rerun db:dev-setup.';
  END IF;
END
$edge_first_class$;
