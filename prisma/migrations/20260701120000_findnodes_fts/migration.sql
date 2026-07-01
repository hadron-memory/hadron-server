-- cor:api:090 (Node search / findNodes) + cor:rag:010:02 (lexical relevance ranking).
--
-- Lexical-search substrate: a STORED generated `tsvector` column on `nodes`,
-- weighted A/B/C/D to encode the default field-weight order (name/alias >
-- loc/tags > description/abstract > content/data), plus a GIN index. This
-- powers findNodes keyword/hybrid ranking (ts_rank_cd, field-weighted +
-- length-normalized) and the boolean operators (tsquery).
--
-- Prisma's schema language can model neither a generated column nor a GIN
-- index, so this is raw SQL — mirrored in prisma/post-push.sql and
-- src/test/globalSetup.ts (db-push-managed DBs don't replay migrations).
-- All three sites MUST stay in sync. Like the pgvector HNSW index, this uses
-- `IF NOT EXISTS` (structural, not a CHECK). Changing the tsvector expression
-- or weights requires a dedicated migration that DROPs + re-adds the column and
-- CREATE OR REPLACEs the function — IF NOT EXISTS won't update a stale column.
--
-- The weight expression lives in an IMMUTABLE wrapper function: `to_tsvector`
-- with a named config coerces 'english'→regconfig via a catalog lookup, which
-- Postgres treats as non-immutable and rejects in a generated column. Wrapping
-- it in an IMMUTABLE function is the standard workaround (the config is fixed).
-- `left(…, 1000000)` caps the content/JSON group so a pathologically large node
-- can't overflow the tsvector limit and block writes.

CREATE OR REPLACE FUNCTION hadron_nodes_tsv(
  p_name text, p_alias text, p_loc text, p_tags text[],
  p_description text, p_abstract text, p_content text, p_properties text, p_data text
) RETURNS tsvector LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT
    setweight(to_tsvector('english', coalesce(p_name, '') || ' ' || coalesce(p_alias, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(p_loc, '') || ' ' || array_to_string(coalesce(p_tags, ARRAY[]::text[]), ' ')), 'B') ||
    setweight(to_tsvector('english', coalesce(p_description, '') || ' ' || coalesce(p_abstract, '')), 'C') ||
    setweight(to_tsvector('english', left(coalesce(p_content, '') || ' ' || coalesce(p_properties, '') || ' ' || coalesce(p_data, ''), 1000000)), 'D')
$$;

ALTER TABLE nodes ADD COLUMN IF NOT EXISTS tsv tsvector GENERATED ALWAYS AS (
  hadron_nodes_tsv(name, alias, loc, tags, description, abstract, content, properties::text, data::text)
) STORED;

CREATE INDEX IF NOT EXISTS nodes_tsv_gin ON nodes USING gin (tsv);
