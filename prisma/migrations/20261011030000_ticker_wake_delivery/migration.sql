-- #1748 (Tickers S2): who acknowledged a wake, and the per-App daily wake counter.

ALTER TABLE "worker_delivery_channels"
    ADD COLUMN "acked_by_user_id" TEXT,
    ADD COLUMN "acked_by_worker_id" TEXT,
    ADD COLUMN "acked_by_app_key_id" TEXT;

ALTER TABLE "worker_delivery_ticks"
    ADD COLUMN "acked_by_user_id" TEXT,
    ADD COLUMN "acked_by_worker_id" TEXT,
    ADD COLUMN "acked_by_app_key_id" TEXT;

CREATE TABLE "app_wake_days" (
    "app_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "wakes" INTEGER NOT NULL DEFAULT 0,
    "notice_posted_at" TIMESTAMP(3),

    CONSTRAINT "app_wake_days_pkey" PRIMARY KEY ("app_id","day")
);

ALTER TABLE "app_wake_days" ADD CONSTRAINT "app_wake_days_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
