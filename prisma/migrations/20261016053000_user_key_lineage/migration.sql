-- #1253: unknown historical ancestry stays NULL. No guessed backfill.
ALTER TABLE "user_api_keys" ADD COLUMN "minted_by_key_id" TEXT;
CREATE INDEX "user_api_keys_minted_by_key_id_idx" ON "user_api_keys"("minted_by_key_id");
ALTER TABLE "user_api_keys" ADD CONSTRAINT "user_api_keys_minted_by_key_id_fkey"
  FOREIGN KEY ("minted_by_key_id") REFERENCES "user_api_keys"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
