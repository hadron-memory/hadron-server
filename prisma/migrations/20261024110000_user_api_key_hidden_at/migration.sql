-- #2298: owner-hidden revoked user API keys (display state only).
ALTER TABLE "user_api_keys" ADD COLUMN "hidden_at" TIMESTAMP(3);
