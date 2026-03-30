-- AlterTable
ALTER TABLE "stations" ADD COLUMN "ai_provider" TEXT,
ADD COLUMN "ai_model" TEXT,
ADD COLUMN "ai_api_key_encrypted" TEXT;
