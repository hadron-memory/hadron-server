-- #5185 (A3 of #5182, cor:dmo:060:20 "An attached memory"): the App-to-memory link table. `attachMemoryToApp` writes a row here
-- and changes nothing on the memory.
--
-- expand-safe: a new table nothing in the previous image reads or writes (additive, no data step).
-- CreateTable
CREATE TABLE "app_memory_links" (
    "app_id" TEXT NOT NULL,
    "memory_id" TEXT NOT NULL,
    "attached_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_memory_links_pkey" PRIMARY KEY ("app_id","memory_id","attached_by")
);

-- CreateIndex
CREATE INDEX "app_memory_links_memory_id_idx" ON "app_memory_links"("memory_id");

-- CreateIndex
CREATE INDEX "app_memory_links_attached_by_idx" ON "app_memory_links"("attached_by");

-- AddForeignKey
ALTER TABLE "app_memory_links" ADD CONSTRAINT "app_memory_links_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_memory_links" ADD CONSTRAINT "app_memory_links_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_memory_links" ADD CONSTRAINT "app_memory_links_attached_by_fkey" FOREIGN KEY ("attached_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
