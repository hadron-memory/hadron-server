-- #5183: the lookup index of the per-App memory limit (app_id, user_id, class), built CONCURRENTLY so writes to
-- memories are not blocked while it builds. CONCURRENTLY cannot run inside a transaction block, and `prisma migrate
-- deploy` sends a migration file as ONE simple query, so this file must stay a single statement (the 20261014040000
-- pattern). A failed CONCURRENTLY build leaves an INVALID index under this name that IF NOT EXISTS would then skip: if
-- `\d memories` shows it INVALID, drop it and re-run this statement by hand.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "memories_app_id_user_id_class_idx" ON "memories"("app_id", "user_id", "class");
