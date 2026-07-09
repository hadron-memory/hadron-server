-- CreateTable
CREATE TABLE "slack_connections" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "default_app_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'slack',
    "tool_connection_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "team_name" TEXT NOT NULL,
    "bot_user_id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "slack_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_event_receipts" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "envelope_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slack_event_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "slack_connections_tool_connection_id_idx" ON "slack_connections"("tool_connection_id");

-- CreateIndex
CREATE INDEX "slack_connections_default_app_id_idx" ON "slack_connections"("default_app_id");

-- CreateIndex
CREATE INDEX "slack_connections_organization_id_team_id_idx" ON "slack_connections"("organization_id", "team_id");

-- One LIVE connection per (org, workspace): PARTIAL unique so a
-- soft-deleted row never blocks re-registration (the apps_urn_active_uniq
-- pattern). Mirrored in prisma/post-push.sql + src/test/globalSetup.ts.
CREATE UNIQUE INDEX "slack_connections_org_team_active_uniq" ON "slack_connections"("organization_id", "team_id") WHERE ("deleted_at" IS NULL);

-- CreateIndex
CREATE INDEX "slack_event_receipts_created_at_idx" ON "slack_event_receipts"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "slack_event_receipts_connection_id_envelope_id_key" ON "slack_event_receipts"("connection_id", "envelope_id");

-- AddForeignKey
ALTER TABLE "slack_connections" ADD CONSTRAINT "slack_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_connections" ADD CONSTRAINT "slack_connections_default_app_id_fkey" FOREIGN KEY ("default_app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

