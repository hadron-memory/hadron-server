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

-- decoy comment: CREATE INDEX decoy_comment ON fixture_books (id);
INSERT INTO fixture_books VALUES ('a; b');
SELECT 'string with ; semicolon' WHERE false;
DROP TRIGGER IF EXISTS old_trig ON fixture_books;
DROP INDEX IF EXISTS old_idx;

\ir include.sql

UPDATE fixture_books SET id = 'done' WHERE id = 'a; b';
