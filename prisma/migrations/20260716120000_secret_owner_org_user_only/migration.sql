-- #696 (decision D-2026-07-15-006): secrets are ORG/USER-owned ONLY. The flat
-- grammar-v2 secret URN `hrn:secret:<root>:<name>` carries a single root
-- principal and can't express the #679 app-/memory-owned marker shape, which is
-- hereby superseded. The #702 prod audit confirmed 0 app/memory-owned rows, so
-- this is a constraint addition, NOT a data migration (no rows to reassign).
--
-- Prisma's schema language can't model a CHECK, so this is hand-written SQL and
-- the same constraint is mirrored in prisma/post-push.sql and
-- src/test/globalSetup.ts (keep all three in sync — see the inline-constraint
-- synchronization convention).
ALTER TABLE "secrets" DROP CONSTRAINT IF EXISTS "chk_secret_owner_type";
ALTER TABLE "secrets"
  ADD CONSTRAINT "chk_secret_owner_type"
  CHECK ("owner_type" IN ('user', 'org'));
