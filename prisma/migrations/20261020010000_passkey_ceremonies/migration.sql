-- CreateTable
CREATE TABLE "passkey_ceremonies" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "browser_nonce_hash" TEXT NOT NULL,
    "challenge_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "passkey_ceremonies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "passkey_ceremonies_expires_at_idx" ON "passkey_ceremonies"("expires_at");
