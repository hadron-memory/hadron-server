-- #4847 (cor:int:030:03): the durable request to drop a chat tool's side of a deleted connection (Telegram, Slack).
-- No foreign key on purpose: a URN reclaim hard-deletes an App and its connection rows cascade away, the intent must outlive them.
-- No backfill: connections deleted before this table existed have no intent and are not swept (out of scope, per the node's Edge Cases).

-- CreateTable
CREATE TABLE "chat_tool_teardown_intents" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "tool_connection_id" TEXT NOT NULL,
    "connection_id" TEXT,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "capped_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_tool_teardown_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: one intent per tool registration, so the doors, the org/App paths and the reconciliation share ONE path.
CREATE UNIQUE INDEX "chat_tool_teardown_intents_kind_tool_connection_id_key" ON "chat_tool_teardown_intents"("kind", "tool_connection_id");

-- CreateIndex: the sweep's scan (unconfirmed, oldest attempt first).
CREATE INDEX "chat_tool_teardown_intents_state_last_attempt_at_idx" ON "chat_tool_teardown_intents"("state", "last_attempt_at");
