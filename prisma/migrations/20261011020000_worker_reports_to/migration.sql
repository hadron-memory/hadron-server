-- #1726 (Task Management): the one Worker a worker reports to. Additive only;
-- every existing worker reports to nobody until someone sets it.

-- AlterTable
ALTER TABLE "workers" ADD COLUMN     "reports_to_worker_id" TEXT;

-- CreateIndex
CREATE INDEX "workers_reports_to_worker_id_idx" ON "workers"("reports_to_worker_id");

-- AddForeignKey
ALTER TABLE "workers" ADD CONSTRAINT "workers_reports_to_worker_id_fkey" FOREIGN KEY ("reports_to_worker_id") REFERENCES "workers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
