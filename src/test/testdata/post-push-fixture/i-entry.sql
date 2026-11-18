-- Entry pinned directly by the parser test: \i resolves against the WORKING
-- DIRECTORY (psql semantics), unlike \ir/\include_relative which resolve
-- against the including file. The path below is repo-root-relative because
-- vitest runs from the repo root.
\i src/test/testdata/post-push-fixture/i-included.sql
