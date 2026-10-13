-- #1708 (Task Management T5): the per-event delivery record for task wakes.

CREATE TABLE "worker_delivery_task_events" (
    "worker_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "chain_index" INTEGER NOT NULL DEFAULT 0,
    "delivered_at" TIMESTAMP(3),
    "acked_by_user_id" TEXT,
    "acked_by_worker_id" TEXT,
    "acked_by_app_key_id" TEXT,
    "undeliverable_at" TIMESTAMP(3),
    "undeliverable_reason" TEXT,

    CONSTRAINT "worker_delivery_task_events_pkey" PRIMARY KEY ("worker_id","event_id","chain_index")
);

CREATE INDEX "worker_delivery_task_events_worker_id_delivered_at_idx" ON "worker_delivery_task_events"("worker_id", "delivered_at");
CREATE INDEX "worker_delivery_task_events_event_id_idx" ON "worker_delivery_task_events"("event_id");

ALTER TABLE "worker_delivery_task_events" ADD CONSTRAINT "worker_delivery_task_events_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "worker_delivery_task_events" ADD CONSTRAINT "worker_delivery_task_events_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "agent_team_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
