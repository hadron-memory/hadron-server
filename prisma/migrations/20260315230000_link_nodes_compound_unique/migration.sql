-- AlterTable: add isLink column
ALTER TABLE "nodes" ADD COLUMN "isLink" BOOLEAN NOT NULL DEFAULT false;

-- DropIndex: remove old unique constraint on loc
DROP INDEX "nodes_loc_key";

-- CreateIndex: add index on loc (non-unique, for lookups)
CREATE INDEX "nodes_loc_idx" ON "nodes"("loc");

-- CreateIndex: add compound unique constraint on (loc, graphId)
CREATE UNIQUE INDEX "nodes_loc_graphId_key" ON "nodes"("loc", "graphId");
