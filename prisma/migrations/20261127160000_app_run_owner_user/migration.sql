-- #5077 (Billing F3a-1): a run of an App a person owns states that person as its owner. Exactly one of
-- organization_id and owner_user_id is set, copied from the App when the run is minted. Every existing row has an
-- organization and gets a NULL owner, so the CHECK holds and this migration refuses nothing (no HDPRF preflight).
--
-- app_runs is written by every run launch and every hop, so nothing here scans it under a lock that blocks writes (#2944,
-- #5318 precedent): dropping NOT NULL and adding a nullable column are catalog-only, and the foreign key and the CHECK are
-- added NOT VALID (a brief lock, checked on new writes from then on). 20261127160100 and 20261127160200 validate them, each
-- alone, and 20261127160300 builds the index CONCURRENTLY.
ALTER TABLE "app_runs" ALTER COLUMN "organization_id" DROP NOT NULL;
ALTER TABLE "app_runs" ADD COLUMN "owner_user_id" TEXT;
ALTER TABLE "app_runs" ADD CONSTRAINT "app_runs_owner_user_id_fkey"
  FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "app_runs" ADD CONSTRAINT "chk_app_run_owner_xor"
  CHECK (("organization_id" IS NULL) <> ("owner_user_id" IS NULL)) NOT VALID;
