-- AlterTable: add revision and editor lock fields to Agent
ALTER TABLE "agents" ADD COLUMN "published_revision_loc" TEXT;
ALTER TABLE "agents" ADD COLUMN "editor_lock_user_id" TEXT;
ALTER TABLE "agents" ADD COLUMN "editor_lock_expires_at" TIMESTAMP(3);
