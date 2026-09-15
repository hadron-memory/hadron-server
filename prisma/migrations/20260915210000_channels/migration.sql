-- Spec 049 Phase 4 (D-2026-09-13-006) — Channel as a platform ENTITY.
--
-- A Channel is a durable, ordered message stream hosted in ONE memory at ONE
-- reserved address; a table row created EAGERLY one-to-one with its chat root
-- node (chat_root_node_id UNIQUE), in the same transaction. Creating a row
-- RESERVES and PROTECTS the address: generic node writes under it are refused
-- (src/lib/protectedLoc.ts — spec 049 §2 S4, shape B: this table is the only
-- protection source until D-2026-08-25-004 adds Memory.protectedLocs). This is
-- hadron-server#1047's closure. The existing team chats are migrated to one
-- row each by the APPLICATION backfill (src/jobs/backfillChannels.ts), never
-- by SQL: the allocator's high-water mark lives in the root's encrypted
-- `data` on an encrypted memory, which a migration cannot read.
--
-- last_seq / last_message_at are the platform-maintained watermark
-- (D-2026-09-13-009), written by the allocator in the same transaction as
-- the seq. apps.default_channel_id is the App's default Channel (D-007 D2):
-- a nullable FK rather than a flag on the row, so two defaults per App is a
-- state the schema cannot hold.

CREATE TYPE "ChannelKind" AS ENUM ('CHAT');

CREATE TABLE IF NOT EXISTS "channels" (
    "id" TEXT NOT NULL,
    "memory_id" TEXT NOT NULL,
    "loc" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ChannelKind" NOT NULL DEFAULT 'CHAT',
    "description" TEXT,
    "chat_root_node_id" TEXT NOT NULL,
    "last_seq" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "channels_chat_root_node_id_key" ON "channels" ("chat_root_node_id");
CREATE UNIQUE INDEX IF NOT EXISTS "channels_memory_id_loc_key" ON "channels" ("memory_id", "loc");
CREATE INDEX IF NOT EXISTS "channels_memory_id_idx" ON "channels" ("memory_id");

ALTER TABLE "channels"
    ADD CONSTRAINT "channels_memory_id_fkey"
    FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channels"
    ADD CONSTRAINT "channels_chat_root_node_id_fkey"
    FOREIGN KEY ("chat_root_node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "default_channel_id" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "apps_default_channel_id_key" ON "apps" ("default_channel_id");
ALTER TABLE "apps"
    ADD CONSTRAINT "apps_default_channel_id_fkey"
    FOREIGN KEY ("default_channel_id") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
