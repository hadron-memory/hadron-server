-- #5183 (cor:dmo:060:20, A1 of #5182): the marker of the one-personal-and-one-private-memory-per-App limit.
-- expand-safe: an additive column with a constant default (the previous image never reads it). The index is the next
-- migration, built CONCURRENTLY.
-- No backfill: memories that exist when the rule is built stay unmarked and do not count (R4). No unique index and no
-- CHECK: an account merge may leave one user two holders and is never refused (S9).
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "app_user_memory" BOOLEAN NOT NULL DEFAULT false;
