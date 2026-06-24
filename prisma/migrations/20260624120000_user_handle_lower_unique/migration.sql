-- 325-user-urn: the handle is the slug of the hrn:user:<handle> URN
-- (spec cor:urn:010:01), stored lowercase-canonical. Enforce case-insensitive
-- uniqueness with a functional unique index — Prisma's plain @unique on
-- `handle` is case-sensitive and cannot express a functional index.
--
-- Safe to create: existing handles were normalized to lowercase ahead of this
-- migration, so no case-only collisions remain. Synced with prisma/post-push.sql
-- and src/test/globalSetup.ts.
--
-- Partial (WHERE handle IS NOT NULL): only real handles participate, so the
-- (potentially many) handle-less users don't bloat the index. Semantics are
-- unchanged — lower(NULL) is NULL and NULLs are distinct in a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS "users_handle_lower_uniq"
  ON "users" (lower(handle)) WHERE handle IS NOT NULL;
