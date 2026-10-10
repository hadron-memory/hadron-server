-- #1715 (decisions S2): merge-aware identity. One row per account merge, so
-- ids stored inside authenticated decision payloads follow a merge at read
-- time instead of being rewritten. Additive only.

-- CreateTable
CREATE TABLE "user_merges" (
    "source_user_id" TEXT NOT NULL,
    "target_user_id" TEXT NOT NULL,
    "merged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "merged_by" TEXT,

    CONSTRAINT "user_merges_pkey" PRIMARY KEY ("source_user_id")
);

-- CreateIndex
CREATE INDEX "user_merges_target_user_id_idx" ON "user_merges"("target_user_id");

-- AddForeignKey
ALTER TABLE "user_merges" ADD CONSTRAINT "user_merges_source_user_id_fkey" FOREIGN KEY ("source_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_merges" ADD CONSTRAINT "user_merges_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
