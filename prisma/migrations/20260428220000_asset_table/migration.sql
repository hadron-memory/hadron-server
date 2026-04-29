-- Add the AssetScanStatus enum and the assets table.
-- Spec: spec-kits/specs/004-asset-upload/data-model.md

-- CreateEnum
CREATE TYPE "AssetScanStatus" AS ENUM ('PENDING', 'CLEAN', 'BLOCKED');

-- CreateTable
CREATE TABLE "assets" (
    "id"           TEXT NOT NULL,
    "memory_id"    TEXT NOT NULL,
    "filename"     TEXT NOT NULL,
    "mime_type"    TEXT NOT NULL,
    "size_bytes"   INTEGER NOT NULL,
    "storage_key"  TEXT NOT NULL,
    "scan_status"  "AssetScanStatus" NOT NULL DEFAULT 'PENDING',
    "description"  TEXT,
    "uploaded_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by"  TEXT NOT NULL,
    "deleted_at"   TIMESTAMP(3),

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "assets_storage_key_key" ON "assets"("storage_key");

-- CreateIndex
CREATE INDEX "assets_memory_id_scan_status_uploaded_at_idx" ON "assets"("memory_id", "scan_status", "uploaded_at" DESC);

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_memory_id_fkey"
    FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
