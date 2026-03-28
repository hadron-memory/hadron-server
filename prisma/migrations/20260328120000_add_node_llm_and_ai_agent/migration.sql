-- Add LLM model and AI agent tracking to nodes
ALTER TABLE "nodes" ADD COLUMN "llm_model" TEXT;
ALTER TABLE "nodes" ADD COLUMN "ai_agent" TEXT;
