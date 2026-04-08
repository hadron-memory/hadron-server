-- CreateEnum
CREATE TYPE "PongDraftStatus" AS ENUM ('PENDING', 'APPROVED', 'AUTO_SENT', 'EDITED', 'REJECTED');

-- CreateTable
CREATE TABLE "pong_settings" (
    "id" TEXT NOT NULL,
    "exchange_connection_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "auto_send_enabled" BOOLEAN NOT NULL DEFAULT false,
    "confidence_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.95,
    "reply_tone" TEXT,
    "signature_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pong_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_documents" (
    "id" TEXT NOT NULL,
    "exchange_connection_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "doc_type" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pong_drafts" (
    "id" TEXT NOT NULL,
    "exchange_connection_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "message_subject" TEXT,
    "message_from" TEXT,
    "message_received_at" TIMESTAMP(3),
    "draft_body" TEXT NOT NULL,
    "edited_body" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" "PongDraftStatus" NOT NULL DEFAULT 'PENDING',
    "source_docs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reasoning" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pong_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pong_settings_exchange_connection_id_key" ON "pong_settings"("exchange_connection_id");

-- CreateIndex
CREATE INDEX "pong_settings_user_id_idx" ON "pong_settings"("user_id");

-- CreateIndex
CREATE INDEX "knowledge_documents_exchange_connection_id_idx" ON "knowledge_documents"("exchange_connection_id");

-- CreateIndex
CREATE INDEX "knowledge_documents_user_id_idx" ON "knowledge_documents"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "pong_drafts_exchange_connection_id_message_id_key" ON "pong_drafts"("exchange_connection_id", "message_id");

-- CreateIndex
CREATE INDEX "pong_drafts_user_id_idx" ON "pong_drafts"("user_id");

-- CreateIndex
CREATE INDEX "pong_drafts_status_idx" ON "pong_drafts"("status");

-- CreateIndex
CREATE INDEX "pong_drafts_created_at_idx" ON "pong_drafts"("created_at");

-- AddForeignKey
ALTER TABLE "pong_settings" ADD CONSTRAINT "pong_settings_exchange_connection_id_fkey" FOREIGN KEY ("exchange_connection_id") REFERENCES "exchange_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pong_settings" ADD CONSTRAINT "pong_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_exchange_connection_id_fkey" FOREIGN KEY ("exchange_connection_id") REFERENCES "exchange_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pong_drafts" ADD CONSTRAINT "pong_drafts_exchange_connection_id_fkey" FOREIGN KEY ("exchange_connection_id") REFERENCES "exchange_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pong_drafts" ADD CONSTRAINT "pong_drafts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
