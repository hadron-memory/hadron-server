-- #2947 (rulings 0153, 0154, 0161, 0162; cor:api:190:01, :02): an edge records whether its loc was authored or derived,
-- and an EDGE value joins the URN alias entity types so a move can keep an old edge URN resolving.

-- The new value is not used in this migration, so it may share the transaction.
ALTER TYPE "UrnAliasEntityType" ADD VALUE IF NOT EXISTS 'EDGE';

-- true = authored. The default is the safe direction: a writer that does not say is treated as authored, which a move
-- never rewrites.
ALTER TABLE "edges" ADD COLUMN "loc_authored" BOOLEAN NOT NULL DEFAULT true;

-- BACKFILL-BEGIN (the parity test runs exactly this block against the TypeScript classifier)
-- Session-local helper mirroring sanitizeLocAtom and its code-point twin (edgeLoc.ts; #4583): the runtime spelling replaces
-- each UTF-16 unit of an astral character with a dash, the historical migration one dash per code point. Both are accepted.
CREATE OR REPLACE FUNCTION pg_temp.edge_sanitize_loc_atom_2947(input text)
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

-- Needs PostgreSQL 15 or later for the `\U00010000-\U0010FFFF` regex escape below (CI and production run 17). The 64 cap
-- cannot differ between SQL and TS for an astral name: the out-of-charset replacement runs first, so the capped string is
-- already ASCII in both (each astral character became one or two `-`, never a longer run).
-- An edge is DERIVED iff its loc decodes as `<source loc>:<name atom>:<target loc>` with the edge's own name, from any
-- endpoint generation: the sanitized name is one INTERIOR atom of the loc. A loc that does not decode is authored. This
-- is the shape, never a comparison against the current endpoints, so a derived loc made stale by an earlier move is
-- still derived and self-heals on its next move.
CREATE OR REPLACE FUNCTION pg_temp.edge_loc_decodes_as_derived_2947(loc text, name text)
RETURNS boolean AS $$
DECLARE
  atoms text[]; n int; i int;
  plain text; units text;
BEGIN
  atoms := string_to_array(loc, ':');
  n := COALESCE(array_length(atoms, 1), 0);
  IF n < 3 THEN RETURN false; END IF;
  plain := pg_temp.edge_sanitize_loc_atom_2947(name);
  units := pg_temp.edge_sanitize_loc_atom_2947(regexp_replace(COALESCE(name, ''), '[\U00010000-\U0010FFFF]', '--', 'g'));
  FOR i IN 2..(n - 1) LOOP
    IF atoms[i] = plain OR atoms[i] = units THEN RETURN true; END IF;
  END LOOP;
  RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

UPDATE "edges" SET "loc_authored" = NOT pg_temp.edge_loc_decodes_as_derived_2947("loc", "name")
 WHERE "governed_kind" IS NULL;
-- BACKFILL-END
