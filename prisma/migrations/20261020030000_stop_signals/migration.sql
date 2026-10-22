-- #2022 (S6) — stop signals (cor:agt:090): the signals, their coverage history, and the stop holds of queued tasks.
-- New tables only; no existing row is touched.
-- CreateTable
CREATE TABLE "team_stop_signals" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "target_worker_id" TEXT,
    "target_host_registration_id" TEXT,
    "set_at" TIMESTAMP(3) NOT NULL,
    "until" TIMESTAMP(3),
    "set_by_user_id" TEXT,
    "set_by_app_key_id" TEXT,
    "ended_at" TIMESTAMP(3),
    "end_kind" TEXT,
    "ended_by_user_id" TEXT,
    "ended_by_app_key_id" TEXT,
    CONSTRAINT "team_stop_signals_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "team_stop_coverage" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "signal_id" TEXT NOT NULL,
    "worker_id" TEXT NOT NULL,
    "entered_at" TIMESTAMP(3) NOT NULL,
    "left_at" TIMESTAMP(3),
    CONSTRAINT "team_stop_coverage_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "agent_task_stop_holds" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    CONSTRAINT "agent_task_stop_holds_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "team_stop_signals_app_id_set_at_id_idx" ON "team_stop_signals"("app_id", "set_at", "id");
-- CreateIndex
CREATE INDEX "team_stop_signals_target_worker_id_idx" ON "team_stop_signals"("target_worker_id");
-- CreateIndex
CREATE INDEX "team_stop_signals_target_host_registration_id_idx" ON "team_stop_signals"("target_host_registration_id");
-- CreateIndex
CREATE INDEX "team_stop_coverage_worker_id_entered_at_idx" ON "team_stop_coverage"("worker_id", "entered_at");
-- CreateIndex
CREATE INDEX "team_stop_coverage_signal_id_idx" ON "team_stop_coverage"("signal_id");
-- CreateIndex
CREATE INDEX "team_stop_coverage_app_id_idx" ON "team_stop_coverage"("app_id");
-- CreateIndex
CREATE INDEX "agent_task_stop_holds_task_id_started_at_idx" ON "agent_task_stop_holds"("task_id", "started_at");
-- AddForeignKey
ALTER TABLE "team_stop_signals" ADD CONSTRAINT "team_stop_signals_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "team_stop_signals" ADD CONSTRAINT "team_stop_signals_target_worker_id_fkey" FOREIGN KEY ("target_worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "team_stop_signals" ADD CONSTRAINT "team_stop_signals_target_host_registration_id_fkey" FOREIGN KEY ("target_host_registration_id") REFERENCES "host_registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "team_stop_coverage" ADD CONSTRAINT "team_stop_coverage_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "team_stop_signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "agent_task_stop_holds" ADD CONSTRAINT "agent_task_stop_holds_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- #2022 (S6 stop signals, cor:agt:090): the database facts Prisma's schema language cannot model.
-- Source of truth for these objects; the migration carries a byte-identical copy
-- (pinned by src/lib/stopSignals/invariants.test.ts) and post-push.sql includes this file.

-- cor:agt:090:01 — a level and a scope from the closed lists; a worker or team signal names a target worker and no host,
-- a host signal a host registration and no worker; exactly one setter (a person or a host key); an until later than the
-- set time; an end that is either absent or complete: when, how, and (for a lift) who.
ALTER TABLE team_stop_signals DROP CONSTRAINT IF EXISTS chk_team_stop_signals_shape;
ALTER TABLE team_stop_signals ADD CONSTRAINT chk_team_stop_signals_shape CHECK (
  level IN ('pause-dispatch', 'pause', 'halt')
  AND scope IN ('worker', 'team', 'host')
  AND (CASE WHEN scope = 'host'
            THEN target_host_registration_id IS NOT NULL AND target_worker_id IS NULL
            ELSE target_worker_id IS NOT NULL AND target_host_registration_id IS NULL END)
  AND num_nonnulls(set_by_user_id, set_by_app_key_id) = 1
  AND (until IS NULL OR until > set_at)
  AND (CASE WHEN ended_at IS NULL
            THEN end_kind IS NULL AND num_nonnulls(ended_by_user_id, ended_by_app_key_id) = 0
            WHEN end_kind = 'lifted'
            THEN num_nonnulls(ended_by_user_id, ended_by_app_key_id) = 1 AND ended_at >= set_at
            WHEN end_kind = 'expired'
            THEN num_nonnulls(ended_by_user_id, ended_by_app_key_id) = 0 AND until IS NOT NULL AND ended_at = until
            ELSE false END)
);

-- cor:agt:090:01 — the target belongs to the signal's App. The writer resolves the target inside the App; the trigger
-- makes it a database fact.
CREATE OR REPLACE FUNCTION team_stop_signal_target_same_app() RETURNS trigger AS $$
BEGIN
  IF NEW.target_worker_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM workers w WHERE w.id = NEW.target_worker_id AND w.app_id = NEW.app_id) THEN
    RAISE EXCEPTION 'team_stop_signals: worker % is not in the signal''s App', NEW.target_worker_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_team_stop_signals_same_app';
  END IF;
  IF NEW.target_host_registration_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM host_registrations h WHERE h.id = NEW.target_host_registration_id AND h.app_id = NEW.app_id) THEN
    RAISE EXCEPTION 'team_stop_signals: host registration % is not in the signal''s App', NEW.target_host_registration_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_team_stop_signals_same_app';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_team_stop_signals_same_app ON team_stop_signals;
CREATE TRIGGER trg_team_stop_signals_same_app
  BEFORE INSERT ON team_stop_signals
  FOR EACH ROW EXECUTE FUNCTION team_stop_signal_target_same_app();

-- cor:agt:090:01 — the level, scope, target, setter and set time never change, and the end is recorded once: an UPDATE
-- may only fill the end of a live signal. A DELETE comes only from the App's (or target's) cascade, which the trigger
-- does not see as an UPDATE.
CREATE OR REPLACE FUNCTION team_stop_signal_end_once() RETURNS trigger AS $$
BEGIN
  IF NEW.app_id IS DISTINCT FROM OLD.app_id OR NEW.level IS DISTINCT FROM OLD.level OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.target_worker_id IS DISTINCT FROM OLD.target_worker_id
     OR NEW.target_host_registration_id IS DISTINCT FROM OLD.target_host_registration_id
     OR NEW.set_at IS DISTINCT FROM OLD.set_at OR NEW.until IS DISTINCT FROM OLD.until
     OR NEW.set_by_user_id IS DISTINCT FROM OLD.set_by_user_id OR NEW.set_by_app_key_id IS DISTINCT FROM OLD.set_by_app_key_id
     OR OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'team_stop_signals: only a live signal''s end may be recorded, once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_team_stop_signals_end_once';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_team_stop_signals_end_once ON team_stop_signals;
CREATE TRIGGER trg_team_stop_signals_end_once
  BEFORE UPDATE ON team_stop_signals
  FOR EACH ROW EXECUTE FUNCTION team_stop_signal_end_once();

-- The live-signal lookups (enforcement reads these on every assignment, tick and stall pass).
CREATE INDEX IF NOT EXISTS team_stop_signals_live_idx ON team_stop_signals (app_id) WHERE ended_at IS NULL;

-- R95 — at most one open coverage interval per (signal, worker); an interval never ends before it starts.
CREATE UNIQUE INDEX IF NOT EXISTS team_stop_coverage_open_uniq
  ON team_stop_coverage (signal_id, worker_id) WHERE left_at IS NULL;
ALTER TABLE team_stop_coverage DROP CONSTRAINT IF EXISTS chk_team_stop_coverage_shape;
ALTER TABLE team_stop_coverage ADD CONSTRAINT chk_team_stop_coverage_shape CHECK (left_at IS NULL OR left_at >= entered_at);

-- R68 — at most one open stop hold per task; a hold never ends before it starts.
CREATE UNIQUE INDEX IF NOT EXISTS agent_task_stop_holds_open_uniq
  ON agent_task_stop_holds (task_id) WHERE ended_at IS NULL;
ALTER TABLE agent_task_stop_holds DROP CONSTRAINT IF EXISTS chk_agent_task_stop_holds_shape;
ALTER TABLE agent_task_stop_holds ADD CONSTRAINT chk_agent_task_stop_holds_shape CHECK (ended_at IS NULL OR ended_at >= started_at);
