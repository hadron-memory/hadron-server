-- AlterTable: add data JSON column to Edge for routing metadata
ALTER TABLE "edges" ADD COLUMN "data" JSONB;
