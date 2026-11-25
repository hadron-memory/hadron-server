-- #5137: node writes are quadratic in an unclosed `<!--` (tsv generated column). Expand-safe and no data migration: only the
-- bodies of two functions are replaced; the generated column and its GIN index are untouched, existing rows keep their tsv (the
-- new body yields the same tsvector for every input, so nothing is stale), and the previous image runs against this schema.
-- hadron_nodes_tsv is re-created with its pinned search path (#5096): CREATE OR REPLACE without a SET clause resets it.

-- #5137: an unclosed `<!--` makes the default parser quadratic (every opener rescans to the end of the text for a `-->`
-- that is not there: 16 KB of `<!--` is about 200 ms, 49 KB over a second, and it keeps burning after the client gives up).
-- An opener with no `-->` after it is not a comment to the parser: it indexes exactly like `<! -` (verified over 400000
-- random strings drawn from `<!--`, `-->`, `<!-`, `<!---`, `-5`, `<a `, `&amp;` and words: identical tsvectors). The
-- replacement keeps the length and cannot re-form an opener with a following `-` (`<!-` would: `<!---` -> `<!--`, still quadratic, #5140
-- local P1). So every `<!--` after the LAST `-->` is rewritten to `<! -` before parsing; a `<!--` before the last `-->` finds its closer at once and stays.
-- Same tokens, weights and positions, so the search signal does not change; no refusal; no row is rewritten.
CREATE OR REPLACE FUNCTION hadron_tsv_unclosed_comment(t text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN position('<!--' in t) = 0 THEN t
    WHEN position('-->' in t) = 0 THEN replace(t, '<!--', '<! -')
    ELSE left(t, length(t) - position('>--' in reverse(t)) - 1)
      || replace(right(t, position('>--' in reverse(t)) + 1), '<!--', '<! -')
  END
$$;

CREATE OR REPLACE FUNCTION hadron_nodes_tsv(
  p_name text, p_alias text, p_loc text, p_tags text[],
  p_description text, p_abstract text, p_content text, p_properties text, p_data text
) RETURNS tsvector LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public, pg_temp AS $$
  SELECT
    setweight(to_tsvector('english', hadron_tsv_unclosed_comment(coalesce(p_name, '') || ' ' || coalesce(p_alias, ''))), 'A') ||
    setweight(to_tsvector('english', hadron_tsv_unclosed_comment(coalesce(p_loc, '') || ' ' || array_to_string(coalesce(p_tags, ARRAY[]::text[]), ' '))), 'B') ||
    setweight(to_tsvector('english', hadron_tsv_unclosed_comment(coalesce(p_description, '') || ' ' || coalesce(p_abstract, ''))), 'C') ||
    setweight(to_tsvector('english', hadron_tsv_unclosed_comment(left(coalesce(p_content, '') || ' ' || coalesce(p_properties, '') || ' ' || coalesce(p_data, ''), 1000000))), 'D')
$$;
