-- Fixture for src/test/postPushManifest.test.ts: pins the post-push parser's
-- per-kind extraction (the mutant control — a parser that skips a kind fails
-- here) and its decoy handling: nothing inside dollar-quoted bodies, line
-- comments, or strings may reach the inventory, and guard drops are not
-- objects.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS fixture_books (id text PRIMARY KEY);
CREATE SEQUENCE IF NOT EXISTS fixture_seq AS bigint;
CREATE INDEX fixture_plain_idx ON fixture_books (id);
CREATE UNIQUE INDEX IF NOT EXISTS fixture_uniq_idx ON fixture_books ((lower(id)));
ALTER TABLE fixture_books ADD CONSTRAINT fixture_chk CHECK (id <> '');
ALTER TABLE fixture_books ADD CONSTRAINT fixture_fk FOREIGN KEY (id) REFERENCES fixture_books (id);
ALTER TABLE fixture_books ADD CONSTRAINT fixture_uq UNIQUE (id);
ALTER TABLE fixture_books ADD COLUMN lower_id text GENERATED ALWAYS AS (lower(id)) STORED;

-- #434 slice B BLIND fold (Brooks P2-1): the ALTER TABLE shapes the old
-- vacuous fallback silently nulled — a schema-qualified table, the idempotent
-- drop-and-re-add idiom, and one statement creating TWO objects.
ALTER TABLE public.fixture_qualified ADD CONSTRAINT fixture_qualified_chk CHECK (id <> '');
ALTER TABLE fixture_books DROP CONSTRAINT IF EXISTS fixture_readd_chk, ADD CONSTRAINT fixture_readd_chk CHECK (id <> '');
ALTER TABLE fixture_books ADD CONSTRAINT fixture_multi_a CHECK (id <> ''), ADD CONSTRAINT fixture_multi_b UNIQUE (lower(id));
-- A GUARDED plain ADD COLUMN is schema-owned skew repair (prisma-modelled,
-- re-runnable): a recognized non-object, never inventory, never refused.
ALTER TABLE fixture_books ADD COLUMN IF NOT EXISTS skew_repair_col text;

CREATE OR REPLACE FUNCTION public.fixture_fn(a text, b integer) RETURNS int LANGUAGE plpgsql AS $body$
BEGIN
  -- decoy: payload text inside a tagged dollar-quote, not statements
  CREATE TRIGGER decoy_inside_fn AFTER INSERT ON fixture_books EXECUTE FUNCTION public.fixture_fn();
  CREATE INDEX decoy_inside_fn ON fixture_books (id);
  PERFORM 1;
  RETURN 0;
END $body$;

CREATE TRIGGER fixture_trig AFTER INSERT ON fixture_books FOR EACH ROW EXECUTE FUNCTION fixture_fn(a, b);
CREATE CONSTRAINT TRIGGER fixture_ctrig AFTER UPDATE OF id, lower_id ON fixture_books DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (lower(NEW.id) = 'x; y') EXECUTE FUNCTION fixture_fn();

-- #434 slice B BLIND fold (Brooks P2-2): the chat-seq-invariants.sql idiom —
-- an idempotent ensure-exists gated on a catalog check (cheaper than taking
-- the table lock a redundant IF NOT EXISTS pays), DDL EXECUTE'd from a
-- dollar-quoted string. The object is REAL and must be inventoried. Payload
-- comments and RAISE prose that merely mention DDL must NOT trip the refusal
-- scan.
DO $do$
DECLARE already boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'fixture_do_idx') INTO already;
  IF NOT already THEN
    EXECUTE $ddl$CREATE UNIQUE INDEX fixture_do_idx ON fixture_books (id)$ddl$;
  END IF;
  -- payload comment: CREATE INDEX decoy_do_comment is prose, not DDL
  RAISE NOTICE 'refusing to create the index twice';
END $do$;

-- The same idiom with a plain single-quoted EXECUTE string (with '' escapes).
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fixture_do_chk') THEN
    EXECUTE 'ALTER TABLE fixture_books ADD CONSTRAINT fixture_do_chk CHECK (id <> '''')';
  END IF;
END $do$;

-- decoy comment: CREATE INDEX decoy_comment ON fixture_books (id);
INSERT INTO fixture_books VALUES ('a; b');
SELECT 'string with ; semicolon' WHERE false;
/* block comment with a ; semicolon (Brooks P3-3): must not split statements */
SELECT 'plain' /* mid-statement ; comment */ WHERE false;
SELECT E'escaped \' quote ; semicolon' WHERE false;
DROP TRIGGER IF EXISTS old_trig ON fixture_books;
DROP INDEX IF EXISTS old_idx;

\ir include.sql
\include_relative include2.sql -- trailing comment: a followed meta must survive it

UPDATE fixture_books SET id = 'done' WHERE id = 'a; b';
