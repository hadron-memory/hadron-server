-- Spec 049 Phase 7 — the attendee's cursor per Channel (D-2026-09-13-009,
-- plan §3.6): outside the register, keyed on the ATTENDEE (a Worker, or an
-- Agent in an App), advanced monotonically.

CREATE TABLE "channel_read_states" (
  "id"            TEXT NOT NULL,
  "worker_id"     TEXT,
  "agent_id"      TEXT,
  "app_id"        TEXT,
  "channel_id"    TEXT NOT NULL,
  "last_seen_seq" INTEGER NOT NULL DEFAULT 0,
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "channel_read_states_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "channel_read_states_channel_id_idx" ON "channel_read_states"("channel_id");
CREATE INDEX "channel_read_states_worker_id_idx" ON "channel_read_states"("worker_id");
CREATE INDEX "channel_read_states_agent_id_app_id_idx" ON "channel_read_states"("agent_id", "app_id");

ALTER TABLE "channel_read_states" ADD CONSTRAINT "channel_read_states_worker_id_fkey"
  FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_read_states" ADD CONSTRAINT "channel_read_states_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_read_states" ADD CONSTRAINT "channel_read_states_app_id_fkey"
  FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_read_states" ADD CONSTRAINT "channel_read_states_channel_id_fkey"
  FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one attendee; an Agent attendee carries its App. Synced with post-push.sql.
ALTER TABLE "channel_read_states" ADD CONSTRAINT "chk_read_state_attendee"
  CHECK (num_nonnulls(worker_id, agent_id) = 1);
ALTER TABLE "channel_read_states" ADD CONSTRAINT "chk_read_state_agent_app"
  CHECK (agent_id IS NULL OR app_id IS NOT NULL);

-- The natural keys (the monotonic upsert's ON CONFLICT targets).
CREATE UNIQUE INDEX "channel_read_states_worker_channel_uniq"
  ON "channel_read_states" ("worker_id", "channel_id") WHERE worker_id IS NOT NULL;
CREATE UNIQUE INDEX "channel_read_states_agent_app_channel_uniq"
  ON "channel_read_states" ("agent_id", "app_id", "channel_id") WHERE agent_id IS NOT NULL;
