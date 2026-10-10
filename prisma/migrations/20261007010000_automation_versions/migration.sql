-- CreateEnum
CREATE TYPE "AutomationTier" AS ENUM ('PERSON', 'APP');

-- CreateTable
CREATE TABLE "automation_versions" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "entry_source_node_id" TEXT NOT NULL,
    "compiled_json" TEXT NOT NULL,
    "version_hash" TEXT NOT NULL,
    "source_manifest" JSONB NOT NULL,
    "tier" "AutomationTier" NOT NULL,
    "run_as_user_id" TEXT,
    "published_by" TEXT NOT NULL,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approval_hash" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "automation_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automation_versions_app_id_idx" ON "automation_versions"("app_id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_versions_app_id_entry_source_node_id_number_key" ON "automation_versions"("app_id", "entry_source_node_id", "number");

-- AddForeignKey
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- #1655: code and metadata immutable; approval and revocation append once.
ALTER TABLE automation_versions DROP CONSTRAINT IF EXISTS chk_automation_shape;
ALTER TABLE automation_versions ADD CONSTRAINT chk_automation_shape CHECK (
  number > 0 AND version_hash ~ '^[0-9a-f]{64}$' AND
  ((tier = 'PERSON' AND run_as_user_id IS NOT NULL AND run_as_user_id <> '') OR
   (tier = 'APP' AND run_as_user_id IS NULL)) AND
  (num_nonnulls(approval_hash, approved_by, approved_at) = 0 OR
   (num_nonnulls(approval_hash, approved_by, approved_at) = 3 AND approval_hash = version_hash)) AND
  num_nonnulls(revoked_by, revoked_at) IN (0, 2)
);
CREATE OR REPLACE FUNCTION hadron_immutable_automation_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['approval_hash','approved_by','approved_at','revoked_by','revoked_at'])
       IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['approval_hash','approved_by','approved_at','revoked_by','revoked_at']) THEN
    RAISE EXCEPTION 'Automation version is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.approved_at IS NOT NULL AND
     ROW(NEW.approval_hash,NEW.approved_by,NEW.approved_at) IS DISTINCT FROM
     ROW(OLD.approval_hash,OLD.approved_by,OLD.approved_at) THEN
    RAISE EXCEPTION 'Automation approval is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND
     ROW(NEW.revoked_by,NEW.revoked_at) IS DISTINCT FROM ROW(OLD.revoked_by,OLD.revoked_at) THEN
    RAISE EXCEPTION 'Automation revocation is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND
     ROW(NEW.approval_hash,NEW.approved_by,NEW.approved_at) IS DISTINCT FROM
     ROW(OLD.approval_hash,OLD.approved_by,OLD.approved_at) THEN
    RAISE EXCEPTION 'Revoked automation cannot be approved' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS automation_version_immutable ON automation_versions;
CREATE TRIGGER automation_version_immutable BEFORE UPDATE ON automation_versions
FOR EACH ROW EXECUTE FUNCTION hadron_immutable_automation_version();
