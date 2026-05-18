-- D1b OAuth prototype (D-2026-05-17-001 / D-2026-05-17-002) — adds the
-- three tables needed for user-scoped API keys and the OAuth 2.1
-- authorization-server endpoints in src/auth/oauth.ts.
--
-- - `oauth_clients`  Public-client registry. Rows are populated either
--                    by RFC 7591 DCR (POST /oauth/register) or by seed
--                    migration for fixed clients (tests, etc.). No
--                    client_secret — token_endpoint_auth_method=none,
--                    PKCE S256 is the only authentication.
-- - `auth_codes`     Short-lived single-use authorization codes minted
--                    by /oauth/authorize and redeemed at /oauth/token.
-- - `user_api_keys`  User-owned hdr_user_<…> tokens. Shared shape with
--                    AppKey; resolves to a User instead of an App.
--                    Tokens minted at /oauth/token store rows here too.
--
-- Forward-only. Three additive tables, no destructive operations.

-- CreateTable
CREATE TABLE "oauth_clients" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_name" TEXT NOT NULL,
    "redirect_uris" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "auth_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "redeemed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auth_codes_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "user_api_keys" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_preview" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    CONSTRAINT "user_api_keys_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "oauth_clients_client_id_key" ON "oauth_clients"("client_id");
-- CreateIndex
CREATE UNIQUE INDEX "auth_codes_code_key" ON "auth_codes"("code");
-- CreateIndex
CREATE INDEX "auth_codes_user_id_idx" ON "auth_codes"("user_id");
-- CreateIndex
CREATE INDEX "auth_codes_client_id_idx" ON "auth_codes"("client_id");
-- CreateIndex
CREATE UNIQUE INDEX "user_api_keys_key_hash_key" ON "user_api_keys"("key_hash");
-- CreateIndex
CREATE INDEX "user_api_keys_user_id_idx" ON "user_api_keys"("user_id");
-- AddForeignKey
ALTER TABLE "auth_codes" ADD CONSTRAINT "auth_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "auth_codes" ADD CONSTRAINT "auth_codes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "user_api_keys" ADD CONSTRAINT "user_api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
