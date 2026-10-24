-- #2072 (Holger R53, cor:agt:080:04/:13/:15): the receipt of an acknowledged wake, per (worker, wake key). Additive.
CREATE TABLE "worker_wake_acks" (
    "worker_id" TEXT NOT NULL,
    "wake_key" TEXT NOT NULL,
    "acked_at" TIMESTAMP(3) NOT NULL,
    "acked_by_user_id" TEXT,
    "acked_by_worker_id" TEXT,
    "acked_by_app_key_id" TEXT,

    CONSTRAINT "worker_wake_acks_pkey" PRIMARY KEY ("worker_id","wake_key")
);

CREATE INDEX "worker_wake_acks_worker_id_acked_at_idx" ON "worker_wake_acks"("worker_id", "acked_at");

ALTER TABLE "worker_wake_acks" ADD CONSTRAINT "worker_wake_acks_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
