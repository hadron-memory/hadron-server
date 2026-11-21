-- #4335 (part of #434 Slice C) — two indexes that migration 20260519180903_baseline_init builds PARTIAL, and that
-- `db push` (which cannot model an index predicate) builds full under the same name. The uniqueness rule is the same
-- either way (no NULLS NOT DISTINCT, so a full unique never collides on a NULL external_id); this brings the dev and
-- test catalog to the migration's exact definition. The migration is the authority (ops:alpha:prisma-deploy-flow).
--
-- Each block leaves an index that already has the migration's definition untouched (a re-run changes nothing), and
-- otherwise replaces push's full index with the partial one. A drop that something depends on refuses. psql sends
-- separate statements: one transaction, so a failure part way changes nothing.
-- Pinned by src/test/migrations/partialIndexes4335.test.ts and the migration replay check.
BEGIN;

DO $$
DECLARE
  idx regclass := to_regclass(quote_ident(current_schema()) || '.memories_user_id_idx');
  idx_unique boolean;
  idx_def text;
BEGIN
  IF idx IS NOT NULL THEN
    SELECT i.indisunique, pg_get_indexdef(i.indexrelid) INTO idx_unique, idx_def FROM pg_index i WHERE i.indexrelid = idx;
    IF idx_unique = false AND substr(idx_def, strpos(idx_def, ' ON ')) =
       ' ON ' || quote_ident(current_schema()) || '.memories USING btree (user_id) WHERE (user_id IS NOT NULL)' THEN
      RETURN;
    END IF;
    EXECUTE $ddl$DROP INDEX memories_user_id_idx$ddl$;
  END IF;
  EXECUTE $ddl$CREATE INDEX memories_user_id_idx ON memories USING btree (user_id) WHERE (user_id IS NOT NULL)$ddl$;
END $$;

DO $$
DECLARE
  idx regclass := to_regclass(quote_ident(current_schema()) || '.users_external_app_id_external_id_key');
  idx_unique boolean;
  idx_def text;
BEGIN
  IF idx IS NOT NULL THEN
    SELECT i.indisunique, pg_get_indexdef(i.indexrelid) INTO idx_unique, idx_def FROM pg_index i WHERE i.indexrelid = idx;
    IF idx_unique = true AND substr(idx_def, strpos(idx_def, ' ON ')) =
       ' ON ' || quote_ident(current_schema()) || '.users USING btree (external_app_id, external_id) WHERE (external_id IS NOT NULL)' THEN
      RETURN;
    END IF;
    EXECUTE $ddl$DROP INDEX users_external_app_id_external_id_key$ddl$;
  END IF;
  EXECUTE $ddl$CREATE UNIQUE INDEX users_external_app_id_external_id_key ON users USING btree (external_app_id, external_id) WHERE (external_id IS NOT NULL)$ddl$;
END $$;
COMMIT;
