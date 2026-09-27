-- #1373 — AiServiceConfig.endpoint: the one editable base URL for a config's
-- requests, and apiStyle: the wire protocol of an OpenAI-compatible provider.
-- Both nullable; null = the provider's default (src/lib/aiEndpoint.ts).
-- Additive only. Legacy params.baseUrl is deliberately NOT copied: Holger's
-- D2 ruling is that an unset endpoint always means the default, and the few
-- existing rows that carried a baseUrl are fixed by hand.
ALTER TABLE "ai_service_configs" ADD COLUMN "endpoint" TEXT;
ALTER TABLE "ai_service_configs" ADD COLUMN "api_style" TEXT;
