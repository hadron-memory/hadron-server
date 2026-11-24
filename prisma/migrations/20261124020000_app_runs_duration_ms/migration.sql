-- #855: appRuns(sortBy: duration). The elapsed time of a run is a STORED GENERATED column so the list orders the
-- whole set through the same findMany/count pair, and an index can serve it (ascending order; descending, the slowest-first sort, is served by the (organization_id)
-- prefix plus a sort, not in index order).
--
--   duration_ms = round((finished_at - started_at) in milliseconds), NULL when either timestamp is NULL.
--
-- BIGINT, not INTEGER: milliseconds overflow an INTEGER at about 24.8 days. A negative value (clock skew) is kept as
-- stored. Prisma models the column as a plain nullable BigInt (it cannot express GENERATED), so prisma/post-push.sql
-- converts the plain column a `db push` makes into the generated one (keep the two expressions in lockstep), and
-- src/api/graphql/schema/resolvers.appRunDurationSort855.test.ts reads the catalog of a database built that way.
--
-- Cost: ADD COLUMN ... GENERATED ... STORED rewrites app_runs under an ACCESS EXCLUSIVE lock for the length of the
-- rewrite, and the index build then takes a SHARE lock (writes wait; reads do not). Both run once, in this migration.
-- No backfill step: the column computes itself for every existing row during the rewrite.
ALTER TABLE "app_runs"
  ADD COLUMN IF NOT EXISTS "duration_ms" BIGINT
  GENERATED ALWAYS AS ((round(EXTRACT(EPOCH FROM ("finished_at" - "started_at")) * 1000))::bigint) STORED;

CREATE INDEX IF NOT EXISTS "app_runs_organization_id_duration_ms_idx" ON "app_runs"("organization_id", "duration_ms");
