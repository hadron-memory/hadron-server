-- #5183 (cor:dmo:060:20, A1 of #5182): the marker of the one-personal-and-one-private-memory-per-App limit.
-- expand-safe: an additive column with a constant default (the previous image never reads it) and a plain index.
-- No backfill: memories that exist when the rule is built stay unmarked and do not count (R4). No unique index and no
-- CHECK: an account merge may leave one user two holders and is never refused (S9).
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "app_user_memory" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "memories_app_id_user_id_class_idx" ON "memories"("app_id", "user_id", "class");
