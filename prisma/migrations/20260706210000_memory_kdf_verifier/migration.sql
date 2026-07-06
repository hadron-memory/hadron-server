-- Spec 041 (D-2026-07-06-B): passphrase-KDF material + key verifier for
-- caller-held-key encrypted memories. Parameters and a verifier — no keys.
ALTER TABLE "memories" ADD COLUMN "kdf_salt" TEXT;
ALTER TABLE "memories" ADD COLUMN "kdf_params" JSONB;
ALTER TABLE "memories" ADD COLUMN "key_verifier" TEXT;
