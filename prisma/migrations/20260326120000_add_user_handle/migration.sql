-- Add User.handle, backfill from github_username
ALTER TABLE "users" ADD COLUMN "handle" TEXT;
UPDATE "users" SET "handle" = "github_username" WHERE "github_username" IS NOT NULL;
ALTER TABLE "users" ADD CONSTRAINT "users_handle_key" UNIQUE ("handle");
