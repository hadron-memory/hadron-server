-- #1373 — AiServiceConfig.endpoint: the one editable base URL for a config's
-- requests. Nullable; null = the provider's default (src/lib/aiEndpoint.ts).
-- Additive only. The copy of legacy params.baseUrl into this column is an
-- open decision on #1373 (D2) and is deliberately NOT done here: until then,
-- the LLM client keeps reading params.baseUrl as a fallback for openai/glm.
ALTER TABLE "ai_service_configs" ADD COLUMN "endpoint" TEXT;
