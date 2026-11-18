-- #3426 — organization default MemoryConfig templates: a boolean on an org-owned
-- template, applied at the creation of an org knowledge/group memory, and the
-- concealed durable record of a default rule skipped there (C6).
-- The CHECK is synced with prisma/post-push.sql (DROP + ADD).

ALTER TABLE "memory_config_templates" ADD COLUMN "org_default" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "memory_config_templates"
  ADD CONSTRAINT "chk_memory_config_template_org_default_org_only"
  CHECK (NOT "org_default" OR "organization_id" IS NOT NULL);

CREATE INDEX "memory_config_templates_organization_id_org_default_idx"
  ON "memory_config_templates"("organization_id", "org_default");

CREATE TABLE "memory_config_default_skips" (
    "id" TEXT NOT NULL,
    "memory_id" TEXT NOT NULL,
    "template_id" TEXT,
    "template_rule_id" TEXT,
    "role" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'REFERENCE_UNAVAILABLE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_config_default_skips_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "memory_config_default_skips_memory_id_idx" ON "memory_config_default_skips"("memory_id");
CREATE INDEX "memory_config_default_skips_template_id_idx" ON "memory_config_default_skips"("template_id");
CREATE INDEX "memory_config_default_skips_template_rule_id_idx" ON "memory_config_default_skips"("template_rule_id");

ALTER TABLE "memory_config_default_skips" ADD CONSTRAINT "memory_config_default_skips_memory_id_fkey"
  FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_config_default_skips" ADD CONSTRAINT "memory_config_default_skips_template_id_fkey"
  FOREIGN KEY ("template_id") REFERENCES "memory_config_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "memory_config_default_skips" ADD CONSTRAINT "memory_config_default_skips_template_rule_id_fkey"
  FOREIGN KEY ("template_rule_id") REFERENCES "memory_config_template_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
