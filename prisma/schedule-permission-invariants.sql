-- #3483 / cor:agt:010:01 r40: one source for the schedule-permission CHECKs, shared verbatim with migration
-- 20261105090000_schedule_permissions.
ALTER TABLE "schedule_permissions" DROP CONSTRAINT IF EXISTS "chk_schedule_permissions_consumed";
ALTER TABLE "schedule_permissions" ADD CONSTRAINT "chk_schedule_permissions_consumed" CHECK (
  ("consumed_at" IS NULL AND "consumed_kind" IS NULL AND "consumed_id" IS NULL)
  OR ("consumed_at" IS NOT NULL AND "consumed_kind" IN ('SCHEDULE', 'WEBHOOK') AND "consumed_id" IS NOT NULL)
);
ALTER TABLE "schedule_permissions" DROP CONSTRAINT IF EXISTS "chk_schedule_permissions_expiry";
ALTER TABLE "schedule_permissions" ADD CONSTRAINT "chk_schedule_permissions_expiry" CHECK ("expires_at" > "given_at");

-- #1162: each worker reference below is a typed Worker reference, under the same writer fence as every other one.
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "schedule_permissions";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "schedule_permissions"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "agent_schedules";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "agent_schedules"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.created_by_worker_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "agent_webhooks";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "agent_webhooks"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.created_by_worker_id');
