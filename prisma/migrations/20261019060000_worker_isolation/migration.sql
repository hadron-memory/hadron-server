-- S7 (#2023, R85): isolation is its own state on worker_wake_settings, separate from paused_until. Additive, all NULL.
ALTER TABLE "worker_wake_settings"
    ADD COLUMN "isolated_until" TIMESTAMP(3),
    ADD COLUMN "isolated_at" TIMESTAMP(3),
    ADD COLUMN "isolated_by_user_id" TEXT;
