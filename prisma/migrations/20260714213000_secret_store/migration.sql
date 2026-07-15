-- General secret store (#677): named, owner-scoped secrets, AES-256-GCM
-- encrypted at rest under the platform key. Polymorphic owner (user | org |
-- app | memory) — deliberately no FK; entitlement is checked at resolution
-- time under the caller/run principal. The unique (owner_type, owner_id,
-- name) index doubles as the per-owner lookup index.
CREATE TABLE "secrets" (
    "id" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "value_encrypted" TEXT NOT NULL,
    "key_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "secrets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "secrets_owner_name_uniq" ON "secrets"("owner_type", "owner_id", "name");

-- Webfetch polling repoint (#677 supersedes the #628 node-data credential
-- scheme; no shipped write surface ever populated the old column): the
-- binding now records the resolved Secret row id, not a node URN.
ALTER TABLE "webfetch_poll_bindings" RENAME COLUMN "credentials_node_urn" TO "credential_secret_id";
