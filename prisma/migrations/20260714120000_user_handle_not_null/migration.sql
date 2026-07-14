-- spec 047 Phase 1: `User.handle` becomes NOT NULL.
--
-- Every real signup path now assigns a handle (generateUniqueHandle — OAuth
-- login/name/email seed → random fallback; #654/#657), and all existing
-- production users were backfilled (2026-07-14) before this migration.
--
-- A DB-generated random default backstops any handle-omitting INSERT (chiefly
-- test fixtures) so they still produce a unique, URN-atom-legal handle without
-- being rewritten — and it keeps `handle` optional in the Prisma create input.
-- Real paths override it with a readable, seeded handle. Collisions are caught
-- by the `users_handle_lower_uniq` functional index.
ALTER TABLE "users" ALTER COLUMN "handle" SET DEFAULT left(md5(random()::text), 12);
-- Backfill any remaining NULL handles before enforcing NOT NULL, so the
-- migration is self-contained on a DB that wasn't manually backfilled (a
-- dev/staging DB, or a row created between the prod backfill and this deploy) —
-- SET DEFAULT only affects future inserts, not existing NULLs. `id` is unique,
-- so `user-<id>` is collision-free.
UPDATE "users" SET handle = 'user-' || id WHERE handle IS NULL;
ALTER TABLE "users" ALTER COLUMN "handle" SET NOT NULL;
