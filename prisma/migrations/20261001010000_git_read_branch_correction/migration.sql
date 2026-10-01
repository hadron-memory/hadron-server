-- #1566: each Git memory needs one guarded sync before blank Read branch
-- cleanup can delete absent repo-owned nodes. Existing and new rows begin
-- pending; a successful sync sets the marker true.
ALTER TABLE "memories" ADD COLUMN "read_branch_corrected" BOOLEAN NOT NULL DEFAULT false;
