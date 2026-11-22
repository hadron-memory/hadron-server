-- #597 (Telegram phase 2): the App-owned Telegram bot connection and the events-ingress dedupe receipt.
-- The bot token is never stored here; the Telegram tool holds it encrypted.

-- CreateTable
CREATE TABLE "telegram_connections" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'telegram',
    "tool_connection_id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "bot_username" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "telegram_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_event_receipts" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_event_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: the events-ingress routing key must be 1:1.
CREATE UNIQUE INDEX "telegram_connections_tool_connection_id_key" ON "telegram_connections"("tool_connection_id");

-- CreateIndex
CREATE INDEX "telegram_connections_organization_id_idx" ON "telegram_connections"("organization_id");

-- CreateIndex
CREATE INDEX "telegram_connections_app_id_idx" ON "telegram_connections"("app_id");

-- One ACTIVE connection per App: a PARTIAL unique, so a soft-deleted row never blocks a new one (Prisma cannot model
-- the WHERE clause). Mirrored in prisma/post-push.sql.
CREATE UNIQUE INDEX "telegram_connections_app_active_uniq" ON "telegram_connections"("app_id") WHERE ("deleted_at" IS NULL);

-- One ACTIVE connection per bot: Telegram allows one update consumer per bot, so the same bot on two Apps would split or
-- steal its events. Mirrored in prisma/post-push.sql.
CREATE UNIQUE INDEX "telegram_connections_bot_active_uniq" ON "telegram_connections"("bot_id") WHERE ("deleted_at" IS NULL);

-- CreateIndex
CREATE INDEX "telegram_event_receipts_created_at_idx" ON "telegram_event_receipts"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_event_receipts_connection_id_event_id_key" ON "telegram_event_receipts"("connection_id", "event_id");

-- AddForeignKey
ALTER TABLE "telegram_connections" ADD CONSTRAINT "telegram_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_connections" ADD CONSTRAINT "telegram_connections_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
