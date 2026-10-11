-- #1749 (Tickers S3): App key scopes and the App-key wake-read audit. Additive only.

Already up to date
Already up to date
-- CreateTable
CREATE TABLE "app_key_scopes" (
    "id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "granted_by_user_id" TEXT NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_by_user_id" TEXT,
    "revoked_at" TIMESTAMP(3),
    CONSTRAINT "app_key_scopes_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "app_key_wake_reads" (
    "id" TEXT NOT NULL,
    "app_key_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "worker_count" INTEGER NOT NULL,
    "read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "app_key_wake_reads_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "app_key_scopes_app_key_id_idx" ON "app_key_scopes"("app_key_id");
-- CreateIndex
CREATE INDEX "app_key_wake_reads_app_key_id_read_at_idx" ON "app_key_wake_reads"("app_key_id", "read_at");
-- AddForeignKey
ALTER TABLE "app_key_scopes" ADD CONSTRAINT "app_key_scopes_app_key_id_fkey" FOREIGN KEY ("app_key_id") REFERENCES "app_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "app_key_wake_reads" ADD CONSTRAINT "app_key_wake_reads_app_key_id_fkey" FOREIGN KEY ("app_key_id") REFERENCES "app_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- #1749 (Tickers S3): the database facts Prisma's schema language cannot model for App key scopes.
-- Source of truth for these objects; the migration carries a byte-identical copy
-- (pinned by src/lib/appKeyScopes/invariants.test.ts) and post-push.sql includes this file.

-- cor:aut:010:03 — a key holds a scope at most once. A revoked row stays as the record of who gave it and who took it
-- back; only a live one counts.
CREATE UNIQUE INDEX IF NOT EXISTS app_key_scopes_live_uniq
  ON app_key_scopes (app_key_id, scope) WHERE revoked_at IS NULL;

-- A closed list (T6 adds host:operate); a revocation names who and when, or neither.
ALTER TABLE app_key_scopes DROP CONSTRAINT IF EXISTS chk_app_key_scopes_shape;
ALTER TABLE app_key_scopes ADD CONSTRAINT chk_app_key_scopes_shape CHECK (
  scope IN ('attention:deliver')
  AND ((revoked_at IS NULL) = (revoked_by_user_id IS NULL))
);
