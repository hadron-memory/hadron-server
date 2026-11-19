-- CreateEnum
CREATE TYPE "IncludeReferenceKind" AS ENUM ('loc', 'urn');

-- CreateEnum
CREATE TYPE "IncludeSourceCoverageState" AS ENUM ('COMPLETE_EMPTY', 'COMPLETE_TAGS', 'NEEDS_AUTHORIZED_REWRITE');

-- CreateEnum
CREATE TYPE "IncludeRetentionState" AS ENUM ('PREPARING', 'BACKFILLING', 'VERIFYING', 'ACTIVE', 'BLOCKED');

-- CreateTable
CREATE TABLE "include_references" (
    "id" TEXT NOT NULL,
    "includer_id" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "kind" "IncludeReferenceKind" NOT NULL,
    "reference" TEXT NOT NULL,
    "target_memory_id" TEXT,
    "target_loc" TEXT,
    "pinned_rev_no" INTEGER,
    "requires_approved" BOOLEAN NOT NULL DEFAULT false,
    "requires_signed" BOOLEAN NOT NULL DEFAULT false,
    "metadata_generation" INTEGER NOT NULL,

    CONSTRAINT "include_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "include_source_coverage" (
    "id" TEXT NOT NULL,
    "includer_id" TEXT NOT NULL,
    "source_revision" INTEGER NOT NULL,
    "source_memory_id" TEXT NOT NULL,
    "source_loc" TEXT NOT NULL,
    "source_content_fingerprint" TEXT NOT NULL,
    "source_encrypted" BOOLEAN NOT NULL,
    "parser_version" INTEGER NOT NULL,
    "metadata_generation" INTEGER NOT NULL,
    "reference_count" INTEGER NOT NULL,
    "state" "IncludeSourceCoverageState" NOT NULL,

    CONSTRAINT "include_source_coverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "include_retention_generation" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "parser_version" INTEGER NOT NULL DEFAULT 1,
    "metadata_generation" INTEGER NOT NULL DEFAULT 1,
    "state" "IncludeRetentionState" NOT NULL DEFAULT 'PREPARING',
    "source_high_water_id" TEXT,
    "replay_cursor" TEXT,
    "binding_generation" INTEGER NOT NULL DEFAULT 0,
    "verified_binding_generation" INTEGER,
    "source_count" INTEGER NOT NULL DEFAULT 0,
    "covered_count" INTEGER NOT NULL DEFAULT 0,
    "blocked_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "include_retention_generation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "include_references_target_memory_id_target_loc_idx" ON "include_references"("target_memory_id", "target_loc");

-- CreateIndex
CREATE INDEX "include_references_target_memory_id_reference_idx" ON "include_references"("target_memory_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "include_references_includer_id_ordinal_key" ON "include_references"("includer_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "include_source_coverage_includer_id_key" ON "include_source_coverage"("includer_id");

-- AddForeignKey
ALTER TABLE "include_references" ADD CONSTRAINT "include_references_includer_id_fkey" FOREIGN KEY ("includer_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "include_source_coverage" ADD CONSTRAINT "include_source_coverage_includer_id_fkey" FOREIGN KEY ("includer_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

