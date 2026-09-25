-- #1325 (hadron-concept#74 L1.1, D-2026-09-24-002) — MemoryConfig, NodeRoleRule
-- and MemoryConfigTemplate: node kinds are PROCEDURE, held per memory; the
-- object store (Memory.schema) keeps SHAPE.
--
-- memory_configs is 1:1 with memories (memory_id UNIQUE, cascade). A memory
-- with no row has the EMPTY config: rows are materialized on the first rule
-- write, so this migration needs no backfill.
--
-- A rule's task references are node-id FKs with ON DELETE SET NULL, paired
-- with *_task_required markers that a delete cannot clear: a hard-deleted
-- task leaves the rule FAILING CLOSED rather than silently ungoverned
-- (#1325 H5). chk_*_task_markers keeps the marker set whenever a reference is.
--
-- Templates are owned by exactly one of HadronServer / Organization / User /
-- App — nullable FKs with a num_nonnulls CHECK, never an owner-kind string
-- (the Scope / AiServiceConfig mechanism) — with names unique per owner among
-- LIVE rows. The CHECKs and partial unique indexes are synced with
-- prisma/post-push.sql and src/test/globalSetup.ts (CHECKs use DROP + ADD).

-- CreateEnum
CREATE TYPE "NodeRoleWriters" AS ENUM ('ALL', 'OWNER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ContentValidator" AS ENUM ('AGENT', 'PLATFORM');

-- CreateTable
CREATE TABLE "memory_configs" (
    "id" TEXT NOT NULL,
    "memory_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,

    CONSTRAINT "memory_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_role_rules" (
    "id" TEXT NOT NULL,
    "config_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "author_task_id" TEXT,
    "author_task_required" BOOLEAN NOT NULL DEFAULT false,
    "validation_task_id" TEXT,
    "validation_task_required" BOOLEAN NOT NULL DEFAULT false,
    "description_node_id" TEXT,
    "strict_sub_roles" BOOLEAN NOT NULL DEFAULT false,
    "writers" "NodeRoleWriters" NOT NULL DEFAULT 'ALL',
    "validate_by" "ContentValidator",
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "source_template_id" TEXT,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,

    CONSTRAINT "node_role_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_config_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "hadron_server_id" TEXT,
    "organization_id" TEXT,
    "owner_user_id" TEXT,
    "app_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "memory_config_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_config_template_rules" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "author_task_id" TEXT,
    "author_task_required" BOOLEAN NOT NULL DEFAULT false,
    "validation_task_id" TEXT,
    "validation_task_required" BOOLEAN NOT NULL DEFAULT false,
    "description_node_id" TEXT,
    "strict_sub_roles" BOOLEAN NOT NULL DEFAULT false,
    "writers" "NodeRoleWriters" NOT NULL DEFAULT 'ALL',
    "validate_by" "ContentValidator",
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "memory_config_template_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "memory_configs_memory_id_key" ON "memory_configs"("memory_id");

-- CreateIndex
CREATE INDEX "node_role_rules_author_task_id_idx" ON "node_role_rules"("author_task_id");

-- CreateIndex
CREATE INDEX "node_role_rules_validation_task_id_idx" ON "node_role_rules"("validation_task_id");

-- CreateIndex
CREATE INDEX "node_role_rules_description_node_id_idx" ON "node_role_rules"("description_node_id");

-- CreateIndex
CREATE UNIQUE INDEX "node_role_rules_config_id_role_key" ON "node_role_rules"("config_id", "role");

-- CreateIndex
CREATE INDEX "memory_config_templates_hadron_server_id_idx" ON "memory_config_templates"("hadron_server_id");

-- CreateIndex
CREATE INDEX "memory_config_templates_organization_id_idx" ON "memory_config_templates"("organization_id");

-- CreateIndex
CREATE INDEX "memory_config_templates_owner_user_id_idx" ON "memory_config_templates"("owner_user_id");

-- CreateIndex
CREATE INDEX "memory_config_templates_app_id_idx" ON "memory_config_templates"("app_id");

-- CreateIndex
CREATE INDEX "memory_config_template_rules_author_task_id_idx" ON "memory_config_template_rules"("author_task_id");

-- CreateIndex
CREATE INDEX "memory_config_template_rules_validation_task_id_idx" ON "memory_config_template_rules"("validation_task_id");

-- CreateIndex
CREATE INDEX "memory_config_template_rules_description_node_id_idx" ON "memory_config_template_rules"("description_node_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_config_template_rules_template_id_role_key" ON "memory_config_template_rules"("template_id", "role");

-- AddForeignKey
ALTER TABLE "memory_configs" ADD CONSTRAINT "memory_configs_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_role_rules" ADD CONSTRAINT "node_role_rules_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "memory_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_role_rules" ADD CONSTRAINT "node_role_rules_author_task_id_fkey" FOREIGN KEY ("author_task_id") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_role_rules" ADD CONSTRAINT "node_role_rules_validation_task_id_fkey" FOREIGN KEY ("validation_task_id") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_role_rules" ADD CONSTRAINT "node_role_rules_description_node_id_fkey" FOREIGN KEY ("description_node_id") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_config_templates" ADD CONSTRAINT "memory_config_templates_hadron_server_id_fkey" FOREIGN KEY ("hadron_server_id") REFERENCES "hadron_server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_config_templates" ADD CONSTRAINT "memory_config_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_config_templates" ADD CONSTRAINT "memory_config_templates_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_config_templates" ADD CONSTRAINT "memory_config_templates_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_config_template_rules" ADD CONSTRAINT "memory_config_template_rules_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "memory_config_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_config_template_rules" ADD CONSTRAINT "memory_config_template_rules_author_task_id_fkey" FOREIGN KEY ("author_task_id") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_config_template_rules" ADD CONSTRAINT "memory_config_template_rules_validation_task_id_fkey" FOREIGN KEY ("validation_task_id") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_config_template_rules" ADD CONSTRAINT "memory_config_template_rules_description_node_id_fkey" FOREIGN KEY ("description_node_id") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Prisma cannot express these (synced with post-push.sql + globalSetup.ts).
ALTER TABLE memory_config_templates
  DROP CONSTRAINT IF EXISTS chk_memory_config_template_owner;
ALTER TABLE memory_config_templates
  ADD CONSTRAINT chk_memory_config_template_owner
  CHECK (num_nonnulls(hadron_server_id, organization_id, owner_user_id, app_id) = 1);
CREATE UNIQUE INDEX IF NOT EXISTS memory_config_templates_server_name_uniq
  ON memory_config_templates (hadron_server_id, name) WHERE hadron_server_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS memory_config_templates_org_name_uniq
  ON memory_config_templates (organization_id, name) WHERE organization_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS memory_config_templates_user_name_uniq
  ON memory_config_templates (owner_user_id, name) WHERE owner_user_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS memory_config_templates_app_name_uniq
  ON memory_config_templates (app_id, name) WHERE app_id IS NOT NULL AND deleted_at IS NULL;
ALTER TABLE node_role_rules
  DROP CONSTRAINT IF EXISTS chk_node_role_rule_task_markers;
ALTER TABLE node_role_rules
  ADD CONSTRAINT chk_node_role_rule_task_markers
  CHECK ((author_task_id IS NULL OR author_task_required)
     AND (validation_task_id IS NULL OR validation_task_required));
ALTER TABLE memory_config_template_rules
  DROP CONSTRAINT IF EXISTS chk_memory_config_template_rule_task_markers;
ALTER TABLE memory_config_template_rules
  ADD CONSTRAINT chk_memory_config_template_rule_task_markers
  CHECK ((author_task_id IS NULL OR author_task_required)
     AND (validation_task_id IS NULL OR validation_task_required));
