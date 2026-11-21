-- #4335 (part of #434 Slice C) — two indexes that migration 20260519180903_baseline_init builds PARTIAL, and that
-- `db push` (which cannot model an index predicate) builds full under the same name. The uniqueness rule is the same
-- either way (no NULLS NOT DISTINCT, so a full unique never collides on a NULL external_id); this brings the dev and
-- test catalog to the migration's exact definition. The migration is the authority (ops:alpha:prisma-deploy-flow).
--
-- Each block, for the same-name index (#4672 BLIND F1, F2):
--   - none: create the partial one;
--   - on another table: refuse;
--   - the migration's definition (uniqueness and pg_get_indexdef from ` ON `), valid, ready and live: leave it untouched
--     (a re-run changes nothing);
--   - the migration's definition but not valid, ready or live (a failed concurrent build): drop and recreate it;
--   - exactly push's full definition (no predicate): replace it with the partial one;
--   - anything else: refuse with the definition found, never drop an index this file does not recognise.
-- A drop that something depends on also refuses. psql sends separate statements: one transaction, so a refusal part way
-- changes nothing.
-- Pinned by src/test/migrations/partialIndexes4335.test.ts and the migration replay check.
BEGIN;

DO $$
DECLARE
  rel regclass := to_regclass(quote_ident(current_schema()) || '.memories');
  idx regclass := to_regclass(quote_ident(current_schema()) || '.memories_user_id_idx');
  idx_table regclass;
  idx_unique boolean;
  idx_usable boolean;
  idx_tail text;
  partial_tail text := ' ON ' || quote_ident(current_schema()) || '.memories USING btree (user_id) WHERE (user_id IS NOT NULL)';
  full_tail text := ' ON ' || quote_ident(current_schema()) || '.memories USING btree (user_id)';
BEGIN
  IF idx IS NOT NULL THEN
    SELECT i.indrelid, i.indisunique, i.indisvalid AND i.indisready AND i.indislive,
           substr(pg_get_indexdef(i.indexrelid), strpos(pg_get_indexdef(i.indexrelid), ' ON '))
      INTO idx_table, idx_unique, idx_usable, idx_tail FROM pg_index i WHERE i.indexrelid = idx;
    IF idx_table IS DISTINCT FROM rel THEN
      RAISE EXCEPTION 'index memories_user_id_idx is on %, not memories; refusing to replace it (hadron-server#4335)', idx_table;
    ELSIF idx_unique = false AND idx_tail = partial_tail AND idx_usable THEN
      RETURN;
    ELSIF NOT (idx_unique = false AND (idx_tail = partial_tail OR idx_tail = full_tail)) THEN
      RAISE EXCEPTION 'index memories_user_id_idx is neither the migration''s partial form nor push''s full form (unique: %, definition:%); refusing to replace it (hadron-server#4335)', idx_unique, idx_tail;
    END IF;
    EXECUTE $ddl$DROP INDEX memories_user_id_idx$ddl$;
  END IF;
  EXECUTE $ddl$CREATE INDEX memories_user_id_idx ON memories USING btree (user_id) WHERE (user_id IS NOT NULL)$ddl$;
END $$;

DO $$
DECLARE
  rel regclass := to_regclass(quote_ident(current_schema()) || '.users');
  idx regclass := to_regclass(quote_ident(current_schema()) || '.users_external_app_id_external_id_key');
  idx_table regclass;
  idx_unique boolean;
  idx_usable boolean;
  idx_tail text;
  partial_tail text := ' ON ' || quote_ident(current_schema()) || '.users USING btree (external_app_id, external_id) WHERE (external_id IS NOT NULL)';
  full_tail text := ' ON ' || quote_ident(current_schema()) || '.users USING btree (external_app_id, external_id)';
BEGIN
  IF idx IS NOT NULL THEN
    SELECT i.indrelid, i.indisunique, i.indisvalid AND i.indisready AND i.indislive,
           substr(pg_get_indexdef(i.indexrelid), strpos(pg_get_indexdef(i.indexrelid), ' ON '))
      INTO idx_table, idx_unique, idx_usable, idx_tail FROM pg_index i WHERE i.indexrelid = idx;
    IF idx_table IS DISTINCT FROM rel THEN
      RAISE EXCEPTION 'index users_external_app_id_external_id_key is on %, not users; refusing to replace it (hadron-server#4335)', idx_table;
    ELSIF idx_unique = true AND idx_tail = partial_tail AND idx_usable THEN
      RETURN;
    ELSIF NOT (idx_unique = true AND (idx_tail = partial_tail OR idx_tail = full_tail)) THEN
      RAISE EXCEPTION 'index users_external_app_id_external_id_key is neither the migration''s partial form nor push''s full form (unique: %, definition:%); refusing to replace it (hadron-server#4335)', idx_unique, idx_tail;
    END IF;
    EXECUTE $ddl$DROP INDEX users_external_app_id_external_id_key$ddl$;
  END IF;
  EXECUTE $ddl$CREATE UNIQUE INDEX users_external_app_id_external_id_key ON users USING btree (external_app_id, external_id) WHERE (external_id IS NOT NULL)$ddl$;
END $$;
COMMIT;
