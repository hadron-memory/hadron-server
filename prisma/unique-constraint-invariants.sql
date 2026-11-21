-- #4333 (part of #434 Slice C) — six UNIQUE constraints the migrations create (inline `event_id ... UNIQUE` on the
-- episode tables, and `UNIQUE(field_class,dimension,subject,window_start)` in 20261031220000_shared_rate_limiter).
-- `db push` creates only a same-name unique index. Uniqueness and foreign-key targets work the same on either form (a
-- FK may reference the columns of an eligible non-partial unique index), but `ON CONFLICT ON CONSTRAINT <name>` needs a
-- named constraint, and the catalog differs from production's. The migrations are the authority
-- (ops:alpha:prisma-deploy-flow).
--
-- Each block, in order (#4638 BLIND F1: never rebuild what is already right):
--   1. the constraint already exists with the migration's definition: leave it (and its index, and anything that
--      depends on it) untouched;
--   2. it exists with another definition: refuse, naming it;
--   3. push's same-name index exists: promote it in place with ADD CONSTRAINT ... USING INDEX, only after checking it is
--      a valid, non-partial, expression-free unique index on exactly the migration's columns; otherwise refuse;
--   4. neither exists: add the constraint.
-- psql sends separate statements: one transaction, so a refusal part way changes nothing.
-- Pinned by src/test/migrations/uniqueConstraints4333.test.ts and the migration replay check.
BEGIN;

DO $$
DECLARE
  rel regclass := to_regclass(quote_ident(current_schema()) || '.coordinator_cadence_episodes');
  def text;
  idx regclass;
  ok boolean;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = rel AND conname = 'coordinator_cadence_episodes_event_id_key';
  IF def = 'UNIQUE (event_id)' THEN
    RETURN;
  ELSIF def IS NOT NULL THEN
    RAISE EXCEPTION 'coordinator_cadence_episodes.coordinator_cadence_episodes_event_id_key exists as %, not UNIQUE (event_id) (hadron-server#4333)', def;
  END IF;
  SELECT i.indexrelid INTO idx FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = rel AND c.relname = 'coordinator_cadence_episodes_event_id_key';
  IF idx IS NULL THEN
    EXECUTE $ddl$ALTER TABLE coordinator_cadence_episodes ADD CONSTRAINT coordinator_cadence_episodes_event_id_key UNIQUE (event_id)$ddl$;
    RETURN;
  END IF;
  SELECT i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL
         AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord) = ARRAY['event_id']
    INTO ok FROM pg_index i WHERE i.indexrelid = idx;
  IF NOT ok THEN
    RAISE EXCEPTION 'index coordinator_cadence_episodes_event_id_key on coordinator_cadence_episodes is not a plain unique index on (event_id), so it cannot back the constraint (hadron-server#4333)';
  END IF;
  EXECUTE $ddl$ALTER TABLE coordinator_cadence_episodes ADD CONSTRAINT coordinator_cadence_episodes_event_id_key UNIQUE USING INDEX coordinator_cadence_episodes_event_id_key$ddl$;
END $$;

DO $$
DECLARE
  rel regclass := to_regclass(quote_ident(current_schema()) || '.dark_worker_episodes');
  def text;
  idx regclass;
  ok boolean;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = rel AND conname = 'dark_worker_episodes_event_id_key';
  IF def = 'UNIQUE (event_id)' THEN
    RETURN;
  ELSIF def IS NOT NULL THEN
    RAISE EXCEPTION 'dark_worker_episodes.dark_worker_episodes_event_id_key exists as %, not UNIQUE (event_id) (hadron-server#4333)', def;
  END IF;
  SELECT i.indexrelid INTO idx FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = rel AND c.relname = 'dark_worker_episodes_event_id_key';
  IF idx IS NULL THEN
    EXECUTE $ddl$ALTER TABLE dark_worker_episodes ADD CONSTRAINT dark_worker_episodes_event_id_key UNIQUE (event_id)$ddl$;
    RETURN;
  END IF;
  SELECT i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL
         AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord) = ARRAY['event_id']
    INTO ok FROM pg_index i WHERE i.indexrelid = idx;
  IF NOT ok THEN
    RAISE EXCEPTION 'index dark_worker_episodes_event_id_key on dark_worker_episodes is not a plain unique index on (event_id), so it cannot back the constraint (hadron-server#4333)';
  END IF;
  EXECUTE $ddl$ALTER TABLE dark_worker_episodes ADD CONSTRAINT dark_worker_episodes_event_id_key UNIQUE USING INDEX dark_worker_episodes_event_id_key$ddl$;
END $$;

DO $$
DECLARE
  rel regclass := to_regclass(quote_ident(current_schema()) || '.host_sweep_episodes');
  def text;
  idx regclass;
  ok boolean;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = rel AND conname = 'host_sweep_episodes_event_id_key';
  IF def = 'UNIQUE (event_id)' THEN
    RETURN;
  ELSIF def IS NOT NULL THEN
    RAISE EXCEPTION 'host_sweep_episodes.host_sweep_episodes_event_id_key exists as %, not UNIQUE (event_id) (hadron-server#4333)', def;
  END IF;
  SELECT i.indexrelid INTO idx FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = rel AND c.relname = 'host_sweep_episodes_event_id_key';
  IF idx IS NULL THEN
    EXECUTE $ddl$ALTER TABLE host_sweep_episodes ADD CONSTRAINT host_sweep_episodes_event_id_key UNIQUE (event_id)$ddl$;
    RETURN;
  END IF;
  SELECT i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL
         AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord) = ARRAY['event_id']
    INTO ok FROM pg_index i WHERE i.indexrelid = idx;
  IF NOT ok THEN
    RAISE EXCEPTION 'index host_sweep_episodes_event_id_key on host_sweep_episodes is not a plain unique index on (event_id), so it cannot back the constraint (hadron-server#4333)';
  END IF;
  EXECUTE $ddl$ALTER TABLE host_sweep_episodes ADD CONSTRAINT host_sweep_episodes_event_id_key UNIQUE USING INDEX host_sweep_episodes_event_id_key$ddl$;
END $$;

DO $$
DECLARE
  rel regclass := to_regclass(quote_ident(current_schema()) || '.post_limit_episodes');
  def text;
  idx regclass;
  ok boolean;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = rel AND conname = 'post_limit_episodes_event_id_key';
  IF def = 'UNIQUE (event_id)' THEN
    RETURN;
  ELSIF def IS NOT NULL THEN
    RAISE EXCEPTION 'post_limit_episodes.post_limit_episodes_event_id_key exists as %, not UNIQUE (event_id) (hadron-server#4333)', def;
  END IF;
  SELECT i.indexrelid INTO idx FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = rel AND c.relname = 'post_limit_episodes_event_id_key';
  IF idx IS NULL THEN
    EXECUTE $ddl$ALTER TABLE post_limit_episodes ADD CONSTRAINT post_limit_episodes_event_id_key UNIQUE (event_id)$ddl$;
    RETURN;
  END IF;
  SELECT i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL
         AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord) = ARRAY['event_id']
    INTO ok FROM pg_index i WHERE i.indexrelid = idx;
  IF NOT ok THEN
    RAISE EXCEPTION 'index post_limit_episodes_event_id_key on post_limit_episodes is not a plain unique index on (event_id), so it cannot back the constraint (hadron-server#4333)';
  END IF;
  EXECUTE $ddl$ALTER TABLE post_limit_episodes ADD CONSTRAINT post_limit_episodes_event_id_key UNIQUE USING INDEX post_limit_episodes_event_id_key$ddl$;
END $$;

DO $$
DECLARE
  rel regclass := to_regclass(quote_ident(current_schema()) || '.start_failing_episodes');
  def text;
  idx regclass;
  ok boolean;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = rel AND conname = 'start_failing_episodes_event_id_key';
  IF def = 'UNIQUE (event_id)' THEN
    RETURN;
  ELSIF def IS NOT NULL THEN
    RAISE EXCEPTION 'start_failing_episodes.start_failing_episodes_event_id_key exists as %, not UNIQUE (event_id) (hadron-server#4333)', def;
  END IF;
  SELECT i.indexrelid INTO idx FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = rel AND c.relname = 'start_failing_episodes_event_id_key';
  IF idx IS NULL THEN
    EXECUTE $ddl$ALTER TABLE start_failing_episodes ADD CONSTRAINT start_failing_episodes_event_id_key UNIQUE (event_id)$ddl$;
    RETURN;
  END IF;
  SELECT i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL
         AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord) = ARRAY['event_id']
    INTO ok FROM pg_index i WHERE i.indexrelid = idx;
  IF NOT ok THEN
    RAISE EXCEPTION 'index start_failing_episodes_event_id_key on start_failing_episodes is not a plain unique index on (event_id), so it cannot back the constraint (hadron-server#4333)';
  END IF;
  EXECUTE $ddl$ALTER TABLE start_failing_episodes ADD CONSTRAINT start_failing_episodes_event_id_key UNIQUE USING INDEX start_failing_episodes_event_id_key$ddl$;
END $$;

DO $$
DECLARE
  rel regclass := to_regclass(quote_ident(current_schema()) || '.rate_limit_buckets');
  def text;
  idx regclass;
  ok boolean;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = rel AND conname = 'rate_limit_buckets_field_class_dimension_subject_window_sta_key';
  IF def = 'UNIQUE (field_class, dimension, subject, window_start)' THEN
    RETURN;
  ELSIF def IS NOT NULL THEN
    RAISE EXCEPTION 'rate_limit_buckets.rate_limit_buckets_field_class_dimension_subject_window_sta_key exists as %, not UNIQUE (field_class, dimension, subject, window_start) (hadron-server#4333)', def;
  END IF;
  SELECT i.indexrelid INTO idx FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = rel AND c.relname = 'rate_limit_buckets_field_class_dimension_subject_window_sta_key';
  IF idx IS NULL THEN
    EXECUTE $ddl$ALTER TABLE rate_limit_buckets ADD CONSTRAINT rate_limit_buckets_field_class_dimension_subject_window_sta_key UNIQUE (field_class, dimension, subject, window_start)$ddl$;
    RETURN;
  END IF;
  SELECT i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL
         AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord) = ARRAY['field_class','dimension','subject','window_start']
    INTO ok FROM pg_index i WHERE i.indexrelid = idx;
  IF NOT ok THEN
    RAISE EXCEPTION 'index rate_limit_buckets_field_class_dimension_subject_window_sta_key on rate_limit_buckets is not a plain unique index on (field_class, dimension, subject, window_start), so it cannot back the constraint (hadron-server#4333)';
  END IF;
  EXECUTE $ddl$ALTER TABLE rate_limit_buckets ADD CONSTRAINT rate_limit_buckets_field_class_dimension_subject_window_sta_key UNIQUE USING INDEX rate_limit_buckets_field_class_dimension_subject_window_sta_key$ddl$;
END $$;
COMMIT;
