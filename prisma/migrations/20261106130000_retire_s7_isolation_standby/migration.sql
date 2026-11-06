-- #3606 phase 1: retain every other setting and all rows; compatibility SDL remains.
ALTER TABLE "apps" DROP COLUMN "delivery_standby_enabled";
ALTER TABLE "worker_wake_settings"
  DROP COLUMN "isolated_until",
  DROP COLUMN "isolated_at",
  DROP COLUMN "isolated_by_user_id";
