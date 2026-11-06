-- #2517 (cor:dmo:010:04, Proposed): a hard delete leaves an audit entry on each source node whose edge it cascaded.
CREATE TABLE "node_edge_removals" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "memory_id" TEXT NOT NULL,
    "edge_id" TEXT NOT NULL,
    "edge_loc" TEXT NOT NULL,
    "edge_name" TEXT,
    "target_id" TEXT NOT NULL,
    "target_memory_id" TEXT NOT NULL,
    "target_loc" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "removed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_edge_removals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "node_edge_removals_source_id_created_at_idx" ON "node_edge_removals"("source_id", "created_at");

ALTER TABLE "node_edge_removals" ADD CONSTRAINT "node_edge_removals_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
