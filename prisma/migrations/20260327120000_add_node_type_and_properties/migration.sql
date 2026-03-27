-- Add nodeType and properties to Node
ALTER TABLE "nodes" ADD COLUMN "node_type" TEXT NOT NULL DEFAULT 'knowledge';
ALTER TABLE "nodes" ADD COLUMN "properties" JSONB;

-- Add properties to Agent
ALTER TABLE "agents" ADD COLUMN "properties" JSONB;

-- Index for filtering by nodeType
CREATE INDEX "nodes_node_type_idx" ON "nodes"("node_type");
