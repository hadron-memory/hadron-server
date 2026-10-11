-- #1748 cycle 1: budget reservations, so concurrent readers cannot hand out more wakes than the daily budget.

CREATE TABLE "app_wake_reservations" (
    "worker_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "reserved_at" TIMESTAMP(3) NOT NULL,
    "wake_key" TEXT NOT NULL,

    CONSTRAINT "app_wake_reservations_pkey" PRIMARY KEY ("worker_id")
);

CREATE INDEX "app_wake_reservations_app_id_reserved_at_idx" ON "app_wake_reservations"("app_id", "reserved_at");

ALTER TABLE "app_wake_reservations" ADD CONSTRAINT "app_wake_reservations_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "app_wake_reservations" ADD CONSTRAINT "app_wake_reservations_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
