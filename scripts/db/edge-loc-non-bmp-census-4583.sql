-- #4583 census: how many edges are affected by the non-BMP spelling divergence between the historical
-- `20260620120000_edge_first_class` backfill and the runtime derivation (src/lib/edgeLoc.ts). READ ONLY: one
-- session-local function and one SELECT; nothing is written and no loc is rewritten.
--
-- The backfill replaced an out-of-charset character with ONE `-` per Unicode code point (Postgres regexp_replace);
-- the runtime replaces TWO per non-BMP code point (one per UTF-16 unit). They differ only when a non-BMP code point
-- sits between alphanumerics, so only such names are counted ("divergent" names).
--
-- The buckets are SPELLING MATCHES on the current loc, not write provenance (an authored loc can equal either string),
-- and they include soft-deleted edges, which still occupy their loc (the (loc, memory) unique is unfiltered).
--   migrated_spelling  edge loc equals the BACKFILL's spelling of its name and endpoints:
--                      the runtime derivation does not find it, a re-sync would have created a twin. #4583 makes the
--                      lookups accept it.
--   runtime_spelling   edge loc equals the RUNTIME's spelling (what runtime creation derives): found by the runtime, as before.
--   migrated_suffixed  edge loc is the backfill's spelling plus the `:N` (N a canonical decimal >= 2, the same rule as
--                      `migratedLocSuffix` in src/lib/edgeLoc.ts) the backfill appended when two names between the
--                      same endpoints sanitized to one atom (a literal `a-b` beside `a😀b`): found by the lookup too.
--   neither            everything else: authored locs, moved edges, a `:1` / `:02` continuation (not a backfill suffix).
--   twin_pairs         a migrated-spelling edge (plain or `:N`-suffixed) and a runtime-spelling edge with the same source, target and name:
--                      the twins the divergence has already produced. #4583 does not merge them.
--   runtime_loc_taken_by_another / migrated_loc_taken_by_another
--                      a divergent edge whose OTHER spelling is the loc of a DIFFERENT edge (other name or endpoints, so not its twin) in the same memory (an edge
--                      literally named `a-b` beside one named `a😀b`): why the lookup also requires the same name,
--                      source and target before it takes an edge for the one it is looking for.
-- Run: psql "$DATABASE_URL" -f scripts/db/edge-loc-non-bmp-census-4583.sql
CREATE OR REPLACE FUNCTION pg_temp.edge_atom_4583(input text, per_utf16_unit boolean)
RETURNS text AS $$
DECLARE s text;
BEGIN
  s := COALESCE(input, '');
  IF per_utf16_unit THEN
    s := regexp_replace(s, '[\U00010000-\U0010FFFF]', '--', 'g');
  END IF;
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

WITH divergent AS (
  SELECT e.id, e.memory_id, e.source_id, e.target_id, e.name, e.loc, e.deleted_at,
         src.loc || ':' || pg_temp.edge_atom_4583(e.name, false) || ':' || tgt.loc AS migrated_loc,
         src.loc || ':' || pg_temp.edge_atom_4583(e.name, true)  || ':' || tgt.loc AS runtime_loc
    FROM edges e
    JOIN nodes src ON src.id = e.source_id
    JOIN nodes tgt ON tgt.id = e.target_id
   WHERE e.name ~ '[\U00010000-\U0010FFFF]'
     AND pg_temp.edge_atom_4583(e.name, false) <> pg_temp.edge_atom_4583(e.name, true)
)
SELECT count(*)                                                   AS divergent_edges,
       count(*) FILTER (WHERE d.loc = d.migrated_loc)             AS migrated_spelling,
       count(*) FILTER (WHERE d.loc = d.runtime_loc)              AS runtime_spelling,
       count(*) FILTER (WHERE left(d.loc, length(d.migrated_loc) + 1) = d.migrated_loc || ':'
                          AND substr(d.loc, length(d.migrated_loc) + 2) ~ '^([2-9]|[1-9][0-9]+)$') AS migrated_suffixed,
       count(*) FILTER (WHERE d.loc NOT IN (d.migrated_loc, d.runtime_loc)
                          AND NOT (left(d.loc, length(d.migrated_loc) + 1) = d.migrated_loc || ':'
                                   AND substr(d.loc, length(d.migrated_loc) + 2) ~ '^([2-9]|[1-9][0-9]+)$')) AS neither,
       count(*) FILTER (WHERE (d.loc = d.migrated_loc
                               OR (left(d.loc, length(d.migrated_loc) + 1) = d.migrated_loc || ':'
                                   AND substr(d.loc, length(d.migrated_loc) + 2) ~ '^([2-9]|[1-9][0-9]+)$')) AND EXISTS (
         SELECT 1 FROM divergent r
          WHERE r.id <> d.id AND r.memory_id = d.memory_id AND r.source_id = d.source_id
            AND r.target_id = d.target_id AND r.name = d.name AND r.loc = r.runtime_loc)) AS twin_pairs,
       count(*) FILTER (WHERE d.loc = d.migrated_loc AND EXISTS (
         SELECT 1 FROM edges o
          WHERE o.memory_id = d.memory_id AND o.loc = d.runtime_loc
            AND (o.name IS DISTINCT FROM d.name OR o.source_id <> d.source_id OR o.target_id <> d.target_id))) AS runtime_loc_taken_by_another,
       count(*) FILTER (WHERE d.loc = d.runtime_loc AND EXISTS (
         SELECT 1 FROM edges o
          WHERE o.memory_id = d.memory_id AND o.loc = d.migrated_loc
            AND (o.name IS DISTINCT FROM d.name OR o.source_id <> d.source_id OR o.target_id <> d.target_id))) AS migrated_loc_taken_by_another
  FROM divergent d;
