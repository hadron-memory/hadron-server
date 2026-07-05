-- Issue #477 — keep the session JWT out of browser-visible URLs.
-- Single-use, short-TTL handoff codes (login handoff + Exchange OAuth start).
-- DB-backed (survives multi-worker deploys) and SHA-256-hashed at rest,
-- mirroring the AuthCode store. Hand-written; no phantom-drift artifacts.

-- CreateTable
CREATE TABLE "auth_handoff_codes" (
    "id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "redirect" TEXT,
    "is_new" BOOLEAN NOT NULL DEFAULT false,
    "org_id" TEXT,
    "client_state_hash" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "redeemed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_handoff_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_handoff_codes_code_hash_key" ON "auth_handoff_codes"("code_hash");

-- CreateIndex
CREATE INDEX "auth_handoff_codes_user_id_idx" ON "auth_handoff_codes"("user_id");

-- AddForeignKey
ALTER TABLE "auth_handoff_codes" ADD CONSTRAINT "auth_handoff_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
