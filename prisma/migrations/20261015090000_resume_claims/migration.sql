-- #1956 (cor:agt:020:03): resume claims — a single-use, 60-second claim a worker
-- session's driver writes before a deliberate context reset, redeemed by the
-- fresh context with one no-argument call. Holder-only, judged by the token.

CREATE TABLE "resume_claims" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "worker_id" TEXT NOT NULL,
    "holder_user_id" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "resumed_session_id" TEXT,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "resume_claims_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "resume_claims_holder_user_id_expires_at_idx" ON "resume_claims"("holder_user_id", "expires_at");

CREATE INDEX "resume_claims_session_id_idx" ON "resume_claims"("session_id");

ALTER TABLE "resume_claims" ADD CONSTRAINT "resume_claims_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
