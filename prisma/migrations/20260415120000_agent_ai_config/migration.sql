-- Move AI config onto Agent.
-- The new portal agent chat picks its LLM provider per-agent rather than
-- per-station. Existing stations.ai_* columns stay in place for the legacy
-- station chat.

ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "ai_provider" TEXT,
  ADD COLUMN IF NOT EXISTS "ai_model" TEXT,
  ADD COLUMN IF NOT EXISTS "ai_api_key_encrypted" TEXT;
