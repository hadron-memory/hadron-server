-- 325-user-urn: the handle is the slug of the hrn:user:<handle> URN
-- (spec cor:urn:010:01), stored lowercase-canonical. Enforce case-insensitive
-- uniqueness with a functional unique index — Prisma's plain @unique on
-- `handle` is case-sensitive and cannot express a functional index.
--
-- Safe to create: existing handles were normalized to lowercase ahead of this
-- migration, so no case-only collisions remain. Synced with prisma/post-push.sql
-- and src/test/globalSetup.ts.
CREATE UNIQUE INDEX IF NOT EXISTS "users_handle_lower_uniq"
  ON "users" (lower(handle));
