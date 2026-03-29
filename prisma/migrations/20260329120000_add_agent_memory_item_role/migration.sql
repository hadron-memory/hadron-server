-- Add role to AgentMemoryItem (per-memory access level within an agent)
ALTER TABLE "agent_memory_items" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'read';
