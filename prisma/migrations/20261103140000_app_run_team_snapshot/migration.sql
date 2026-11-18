-- Ruling0112: existing Apps, like new Apps, opt OUT until their managing person enables the read.
ALTER TABLE "apps" ADD COLUMN "run_team_snapshot_enabled" BOOLEAN NOT NULL DEFAULT false;
