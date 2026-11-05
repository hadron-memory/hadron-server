-- #3483 / cor:agt:010:01 r40, cor:agt:080:24 r13: a worker needs a person's one-time permission or the named
-- standing grant `automations.schedule` to create a headless trigger.
ALTER TABLE app_grants DROP CONSTRAINT IF EXISTS chk_app_grants_shape;
ALTER TABLE app_grants ADD CONSTRAINT chk_app_grants_shape CHECK (
  name IN ('ticker.subscribe-workers', 'workers.staff', 'app.members', 'automations.schedule')
);

CREATE TABLE "schedule_permissions" (
  "id" TEXT NOT NULL,
  "app_id" TEXT NOT NULL,
  "worker_id" TEXT NOT NULL,
  "entry_node_urn" TEXT NOT NULL,
  "given_by" TEXT NOT NULL,
  "given_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "consumed_kind" TEXT,
  "consumed_id" TEXT,
  CONSTRAINT "schedule_permissions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "schedule_permissions_app_id_given_at_idx" ON "schedule_permissions"("app_id", "given_at");
CREATE INDEX "schedule_permissions_worker_id_idx" ON "schedule_permissions"("worker_id");
ALTER TABLE "schedule_permissions" ADD CONSTRAINT "schedule_permissions_app_id_fkey"
  FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "schedule_permissions" ADD CONSTRAINT "schedule_permissions_worker_id_fkey"
  FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_schedules" ADD COLUMN "created_by_worker_id" TEXT, ADD COLUMN "admitted_permission_id" TEXT, ADD COLUMN "admitted_grant_id" TEXT;
ALTER TABLE "agent_webhooks" ADD COLUMN "created_by_worker_id" TEXT, ADD COLUMN "admitted_permission_id" TEXT, ADD COLUMN "admitted_grant_id" TEXT;

-- #3483 / cor:agt:010:01 r40: one source for the schedule-permission CHECKs, shared verbatim with migration
-- 20261105090000_schedule_permissions.
ALTER TABLE "schedule_permissions" DROP CONSTRAINT IF EXISTS "chk_schedule_permissions_consumed";
ALTER TABLE "schedule_permissions" ADD CONSTRAINT "chk_schedule_permissions_consumed" CHECK (
  ("consumed_at" IS NULL AND "consumed_kind" IS NULL AND "consumed_id" IS NULL)
  OR ("consumed_at" IS NOT NULL AND "consumed_kind" IS NOT NULL AND "consumed_kind" IN ('SCHEDULE', 'WEBHOOK') AND "consumed_id" IS NOT NULL)
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
