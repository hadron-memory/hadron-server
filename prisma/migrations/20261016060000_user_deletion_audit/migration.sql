-- #1647: audit of admin-initiated erasures + the notice outbox.
CREATE TYPE "UserDeletionNoticeStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'UNAVAILABLE');

CREATE TABLE "user_deletion_audits" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "target_user_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "completed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_deletion_audits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_deletion_notices" (
    "audit_id" TEXT NOT NULL,
    "status" "UserDeletionNoticeStatus" NOT NULL DEFAULT 'PENDING',
    "recipient_ciphertext" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_deletion_notices_pkey" PRIMARY KEY ("audit_id")
);

CREATE UNIQUE INDEX "user_deletion_audits_target_user_id_key" ON "user_deletion_audits"("target_user_id");
CREATE INDEX "user_deletion_notices_status_idx" ON "user_deletion_notices"("status");

ALTER TABLE "user_deletion_notices" ADD CONSTRAINT "user_deletion_notices_audit_id_fkey" FOREIGN KEY ("audit_id") REFERENCES "user_deletion_audits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The audit is append-only; the reason reads 1-500 code points, trimmed.
ALTER TABLE user_deletion_audits ADD CONSTRAINT chk_user_deletion_reason
  CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 500);
CREATE OR REPLACE FUNCTION hadron_user_deletion_audit_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'user_deletion_audits is append-only';
END $$;
CREATE TRIGGER user_deletion_audits_immutable
  BEFORE UPDATE OR DELETE ON user_deletion_audits
  FOR EACH ROW EXECUTE FUNCTION hadron_user_deletion_audit_immutable();
