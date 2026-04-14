-- Add Memory.type to distinguish regular knowledge memories from agent
-- system memories (the ones that hold conversation designs, prompts, and
-- partials for a chatbot). Per-user memories are still identified
-- orthogonally via Memory.user_memory_of_agent_id.

DO $$ BEGIN
  CREATE TYPE "MemoryType" AS ENUM ('KNOWLEDGE', 'AGENT_SYSTEM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "memories"
  ADD COLUMN IF NOT EXISTS "type" "MemoryType" NOT NULL DEFAULT 'KNOWLEDGE';

-- NOTE: Existing agent system memories on production are handled manually by
-- Holger (per discussion on 2026-04-14). For reference, the backfill would be:
--
--   UPDATE "memories" m
--   SET "type" = 'AGENT_SYSTEM'
--   FROM "agents" a
--   WHERE a."system_memory_id" = m."id"
--     AND m."type" = 'KNOWLEDGE';
