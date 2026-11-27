-- #5077 (Billing F3a-1): a run of an App a person owns states that person as its owner. Exactly one of
-- organization_id and owner_user_id is set, copied from the App when the run is minted. Every existing row has an
-- organization and gets a NULL owner, so the CHECK holds and this migration refuses nothing (no HDPRF preflight).
ALTER TABLE "app_runs" ALTER COLUMN "organization_id" DROP NOT NULL;
ALTER TABLE "app_runs" ADD COLUMN "owner_user_id" TEXT;
ALTER TABLE "app_runs" ADD CONSTRAINT "app_runs_owner_user_id_fkey"
  FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app_runs" ADD CONSTRAINT "chk_app_run_owner_xor"
  CHECK (("organization_id" IS NULL) <> ("owner_user_id" IS NULL));
CREATE INDEX "app_runs_owner_user_id_created_at_idx" ON "app_runs"("owner_user_id", "created_at");
