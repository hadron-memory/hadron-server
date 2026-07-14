-- One org-owned BYO Resend sender. The API key is AES-256-GCM encrypted by
-- hadron-server; the stateless capability tool never stores credentials.
CREATE TABLE "resend_senders" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "from_address" TEXT NOT NULL,
    "api_key_encrypted" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "resend_senders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "resend_senders_organization_id_uniq" ON "resend_senders"("organization_id");

ALTER TABLE "resend_senders" ADD CONSTRAINT "resend_senders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
