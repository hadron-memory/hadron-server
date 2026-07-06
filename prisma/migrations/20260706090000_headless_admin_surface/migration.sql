-- #510: headless admin surface.
-- 1. Chain-layer policy links (cor:acl:040:02): org / user / app allow-lists.
-- 2. One-shot schedules: run_at as XOR-alternative to cron.

ALTER TABLE "organizations" ADD COLUMN "policy" JSONB;
ALTER TABLE "users" ADD COLUMN "policy" JSONB;
ALTER TABLE "apps" ADD COLUMN "policy" JSONB;

ALTER TABLE "agent_schedules" ALTER COLUMN "cron" DROP NOT NULL;
ALTER TABLE "agent_schedules" ADD COLUMN "run_at" TIMESTAMP(3);

-- Exactly one of cron / run_at (also in prisma/post-push.sql and
-- src/test/globalSetup.ts — keep all three in sync; never IF-NOT-EXISTS).
ALTER TABLE "agent_schedules"
  ADD CONSTRAINT "chk_agent_schedule_cron_xor_run_at"
  CHECK (("cron" IS NULL) <> ("run_at" IS NULL));
