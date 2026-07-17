-- #692: the unified per-server PRINCIPAL POOL. Org names and user handles share
-- ONE cross-kind uniqueness namespace, so a URN <root> atom resolves to exactly
-- one principal without an @ sigil. Breaking (touches core identity).
--
-- Steps: create `principals`; add nullable principal_id FKs to users +
-- organizations; FAIL-LOUD if any cross-kind root-name collision exists (the
-- #702 audit found 0); backfill one principal per user + per org (soft-deleted →
-- tombstoned); add the cross-kind case-insensitive unique; seed the reserved
-- platform root words. The lower(name) unique is mirrored in prisma/post-push.sql
-- + src/test/globalSetup.ts (Prisma can't model a functional index).

CREATE TABLE "principals" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "kind"        TEXT NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'active',
  "released_at" TIMESTAMP(3),
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "principals_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "users" ADD COLUMN "principal_id" TEXT;
ALTER TABLE "organizations" ADD COLUMN "principal_id" TEXT;
CREATE UNIQUE INDEX "users_principal_id_key" ON "users"("principal_id");
CREATE UNIQUE INDEX "organizations_principal_id_key" ON "organizations"("principal_id");
ALTER TABLE "users" ADD CONSTRAINT "users_principal_id_fkey"
  FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_principal_id_fkey"
  FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Fail-loud guard: the pool requires every root name to be unique across BOTH
-- user handles and org names, case-insensitively (handle↔org, plus org↔org
-- case-dupes the case-sensitive Organization.urn @unique would have allowed).
-- The #702 audit found 0; abort the breaking migration rather than silently
-- merge two principals into one row if any collision exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT n FROM (
      SELECT lower("handle") AS n FROM "users" WHERE "handle" IS NOT NULL
      UNION ALL
      SELECT lower("urn") FROM "organizations"
    ) roots
    GROUP BY n HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '#692 principal-pool backfill aborted: cross-kind root-name collisions exist (user handle vs org name, case-insensitive). Resolve the colliding rows before migrating.';
  END IF;
END $$;

-- Backfill one principal per user; a soft-deleted user's name is TOMBSTONED
-- (kept reserved, no recycling).
INSERT INTO "principals" ("id", "name", "kind", "status", "released_at", "created_at", "updated_at")
SELECT replace(gen_random_uuid()::text, '-', ''), lower("handle"), 'user',
       CASE WHEN "deleted_at" IS NULL THEN 'active' ELSE 'released' END,
       "deleted_at", now(), now()
FROM "users" WHERE "handle" IS NOT NULL;
UPDATE "users" u SET "principal_id" = p."id"
FROM "principals" p WHERE p."kind" = 'user' AND p."name" = lower(u."handle");

-- Backfill one principal per org (same tombstone rule).
INSERT INTO "principals" ("id", "name", "kind", "status", "released_at", "created_at", "updated_at")
SELECT replace(gen_random_uuid()::text, '-', ''), lower("urn"), 'org',
       CASE WHEN "deleted_at" IS NULL THEN 'active' ELSE 'released' END,
       "deleted_at", now(), now()
FROM "organizations";
UPDATE "organizations" o SET "principal_id" = p."id"
FROM "principals" p WHERE p."kind" = 'org' AND p."name" = lower(o."urn");

-- Cross-kind case-insensitive uniqueness spanning ALL statuses (a 'released'
-- tombstone keeps its name reserved forever — indefinite, no recycling; the
-- INVERSE of the deleted_at-filtered Slack partial-unique).
CREATE UNIQUE INDEX "principals_name_lower_uniq" ON "principals" (lower("name"));

-- Reserve the platform root words (#692) as pre-seeded rows, so the unique index
-- rejects any user/org claim for free. Skipped if a name is already claimed (a
-- prod dry-run surfaces that — see the plan's verification).
INSERT INTO "principals" ("id", "name", "kind", "status", "created_at", "updated_at")
SELECT replace(gen_random_uuid()::text, '-', ''), r.w, 'platform', 'reserved', now(), now()
FROM (VALUES ('hadron'), ('hadronmemory'), ('hadron-memory'), ('platform'), ('host'), ('server')) AS r(w)
WHERE NOT EXISTS (SELECT 1 FROM "principals" p WHERE lower(p."name") = r.w);
