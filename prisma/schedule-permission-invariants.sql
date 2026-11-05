-- #3483 / cor:agt:010:01 r40: one source for the schedule-permission CHECKs, shared verbatim with migration
-- 20261105090000_schedule_permissions.
ALTER TABLE "schedule_permissions" DROP CONSTRAINT IF EXISTS "chk_schedule_permissions_consumed";
ALTER TABLE "schedule_permissions" ADD CONSTRAINT "chk_schedule_permissions_consumed" CHECK (
  ("consumed_at" IS NULL AND "consumed_kind" IS NULL AND "consumed_id" IS NULL)
  OR ("consumed_at" IS NOT NULL AND "consumed_kind" IN ('SCHEDULE', 'WEBHOOK') AND "consumed_id" IS NOT NULL)
);
ALTER TABLE "schedule_permissions" DROP CONSTRAINT IF EXISTS "chk_schedule_permissions_expiry";
ALTER TABLE "schedule_permissions" ADD CONSTRAINT "chk_schedule_permissions_expiry" CHECK ("expires_at" > "given_at");
