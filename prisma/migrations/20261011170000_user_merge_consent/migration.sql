CREATE TABLE "user_merge_consents" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "proof_hash" TEXT NOT NULL,
  "source_user_id" TEXT NOT NULL,
  "target_user_id" TEXT NOT NULL,
  "requested_by" TEXT NOT NULL,
  "scope" TEXT NOT NULL DEFAULT 'FULL_CONSOLIDATION',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "source_login_at" TIMESTAMP(3),
  "source_login_method" TEXT,
  "target_login_at" TIMESTAMP(3),
  "target_login_method" TEXT,
  "consumed_at" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "user_merge_consents_proof_hash_key" ON "user_merge_consents"("proof_hash");
ALTER TABLE "user_merges" ADD COLUMN "consent_hash" TEXT, ADD COLUMN "consent_receipt" JSONB;
CREATE UNIQUE INDEX "user_merges_consent_hash_key" ON "user_merges"("consent_hash");
ALTER TABLE "auth_handoff_codes" ADD COLUMN "login_evidence" JSONB;
