-- #3957 (cor:dmo:050:10): an App's chatbot AI config. Nullable; a deleted config clears it.
ALTER TABLE "apps" ADD COLUMN "chatbot_ai_config_id" TEXT;
ALTER TABLE "apps" ADD CONSTRAINT "apps_chatbot_ai_config_id_fkey"
  FOREIGN KEY ("chatbot_ai_config_id") REFERENCES "ai_service_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "apps_chatbot_ai_config_id_idx" ON "apps"("chatbot_ai_config_id");
