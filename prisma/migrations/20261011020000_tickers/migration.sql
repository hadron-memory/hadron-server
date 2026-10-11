-- #1747 (Tickers S1): tickers, subscriptions, wake settings, the delivery record,
-- the may-subscribe-workers grant and the App ticker settings. Additive only.

-- AlterTable
ALTER TABLE "apps" ADD COLUMN     "ticker_live_cap" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "ticker_min_cadence_seconds" INTEGER NOT NULL DEFAULT 120,
ADD COLUMN     "ticker_self_subscribe_cadence_seconds" INTEGER NOT NULL DEFAULT 600,
ADD COLUMN     "wake_daily_budget" INTEGER;

-- CreateTable
CREATE TABLE "tickers" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "cadence_seconds" INTEGER NOT NULL,
    "anchor_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quiet_hours" JSONB,
    "channel_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "relevance" TEXT NOT NULL DEFAULT 'ALL',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "owner_user_id" TEXT,
    "owner_worker_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "created_by_worker_id" TEXT,
    "created_by_agent_id" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "updated_by_worker_id" TEXT,
    "updated_by_agent_id" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,
    "deleted_by_worker_id" TEXT,
    "deleted_by_agent_id" TEXT,

    CONSTRAINT "tickers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticker_subscriptions" (
    "id" TEXT NOT NULL,
    "ticker_id" TEXT NOT NULL,
    "worker_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "created_by_worker_id" TEXT,
    "created_by_agent_id" TEXT,
    "via_grant_id" TEXT,
    "via_grant_person_id" TEXT,
    "ended_at" TIMESTAMP(3),
    "ended_by" TEXT,
    "ended_by_worker_id" TEXT,
    "ended_by_agent_id" TEXT,
    "ended_via_grant_id" TEXT,
    "ended_via_grant_person_id" TEXT,
    "ended_reason" TEXT,

    CONSTRAINT "ticker_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_wake_settings" (
    "worker_id" TEXT NOT NULL,
    "mentions" TEXT NOT NULL DEFAULT 'IMMEDIATE',
    "paused_until" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,
    "updated_by_worker_id" TEXT,
    "updated_by_agent_id" TEXT,

    CONSTRAINT "worker_wake_settings_pkey" PRIMARY KEY ("worker_id")
);

-- CreateTable
CREATE TABLE "worker_delivery_channels" (
    "worker_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "channel_incarnation" INTEGER NOT NULL DEFAULT 0,
    "delivered_through_seq" INTEGER NOT NULL,
    "delivered_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_delivery_channels_pkey" PRIMARY KEY ("worker_id","channel_id")
);

-- CreateTable
CREATE TABLE "worker_delivery_ticks" (
    "worker_id" TEXT NOT NULL,
    "ticker_id" TEXT NOT NULL,
    "last_acked_tick" INTEGER NOT NULL,
    "acked_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_delivery_ticks_pkey" PRIMARY KEY ("worker_id","ticker_id")
);

-- CreateTable
CREATE TABLE "app_grants" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "grantee_worker_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "granted_by" TEXT,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,

    CONSTRAINT "app_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tickers_app_id_deleted_at_idx" ON "tickers"("app_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "tickers_app_slug_uniq" ON "tickers"("app_id", "slug");

-- CreateIndex
CREATE INDEX "ticker_subscriptions_worker_id_idx" ON "ticker_subscriptions"("worker_id");

-- CreateIndex
CREATE INDEX "ticker_subscriptions_ticker_id_idx" ON "ticker_subscriptions"("ticker_id");

-- CreateIndex
CREATE INDEX "app_grants_app_id_idx" ON "app_grants"("app_id");

-- CreateIndex
CREATE INDEX "app_grants_grantee_worker_id_idx" ON "app_grants"("grantee_worker_id");

-- AddForeignKey
ALTER TABLE "tickers" ADD CONSTRAINT "tickers_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticker_subscriptions" ADD CONSTRAINT "ticker_subscriptions_ticker_id_fkey" FOREIGN KEY ("ticker_id") REFERENCES "tickers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticker_subscriptions" ADD CONSTRAINT "ticker_subscriptions_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_wake_settings" ADD CONSTRAINT "worker_wake_settings_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_delivery_channels" ADD CONSTRAINT "worker_delivery_channels_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_delivery_ticks" ADD CONSTRAINT "worker_delivery_ticks_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_delivery_ticks" ADD CONSTRAINT "worker_delivery_ticks_ticker_id_fkey" FOREIGN KEY ("ticker_id") REFERENCES "tickers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_grants" ADD CONSTRAINT "app_grants_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_grants" ADD CONSTRAINT "app_grants_grantee_worker_id_fkey" FOREIGN KEY ("grantee_worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- #1747 (Tickers S1): the database facts Prisma's schema language cannot model.
-- Source of truth for these objects; the migration carries a byte-identical copy
-- (pinned by src/lib/tickers/invariants.test.ts) and post-push.sql includes this file.

-- cor:agt:080:05 — an App's ticker settings are bounded. The writer refuses
-- with TICKER_SETTINGS_OUT_OF_RANGE first; this keeps the bound a database fact.
ALTER TABLE apps DROP CONSTRAINT IF EXISTS chk_apps_ticker_settings;
ALTER TABLE apps ADD CONSTRAINT chk_apps_ticker_settings CHECK (
  ticker_min_cadence_seconds >= 60
  AND ticker_self_subscribe_cadence_seconds BETWEEN ticker_min_cadence_seconds AND 86400
  AND ticker_live_cap BETWEEN 1 AND 100
  AND (wake_daily_budget IS NULL OR wake_daily_budget >= 0)
);

-- cor:agt:080:01 — exactly one owner (a person or a worker), a cadence of at
-- most a day, a relevance from the closed list.
ALTER TABLE tickers DROP CONSTRAINT IF EXISTS chk_tickers_shape;
ALTER TABLE tickers ADD CONSTRAINT chk_tickers_shape CHECK (
  ((owner_user_id IS NULL) <> (owner_worker_id IS NULL))
  AND cadence_seconds BETWEEN 1 AND 86400
  AND relevance IN ('ALL', 'MENTIONS')
  AND char_length(name) BETWEEN 1 AND 100
  AND slug ~ '^[a-z0-9][a-z0-9-]{0,99}$'
);

-- A live ticker's name is unique within its App, ignoring case; a deleted
-- ticker's name may be reused. The SLUG is permanent: tickers_app_slug_uniq
-- (declared in schema.prisma) covers deleted rows too.
CREATE UNIQUE INDEX IF NOT EXISTS tickers_app_name_live_uniq
  ON tickers (app_id, lower(name)) WHERE deleted_at IS NULL;

-- cor:agt:080:02 — one live subscription per ticker and worker, an ended one
-- carries a reason from the closed list (never dormancy, #8099), a live one none.
CREATE UNIQUE INDEX IF NOT EXISTS ticker_subscriptions_live_uniq
  ON ticker_subscriptions (ticker_id, worker_id) WHERE ended_at IS NULL;

ALTER TABLE ticker_subscriptions DROP CONSTRAINT IF EXISTS chk_ticker_subscriptions_shape;
ALTER TABLE ticker_subscriptions ADD CONSTRAINT chk_ticker_subscriptions_shape CHECK (
  (ended_at IS NULL AND ended_reason IS NULL)
  OR (ended_at IS NOT NULL AND ended_reason IS NOT NULL
      AND ended_reason IN ('UNSUBSCRIBED', 'WORKER_RETIRED', 'TICKER_DELETED'))
);

-- cor:agt:080:02 — the worker belongs to the ticker's App. The writer checks
-- this too; the trigger makes it a database fact.
CREATE OR REPLACE FUNCTION ticker_subscription_worker_same_app() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tickers t JOIN workers w ON w.app_id = t.app_id
    WHERE t.id = NEW.ticker_id AND w.id = NEW.worker_id
  ) THEN
    RAISE EXCEPTION 'ticker_subscriptions: worker % is not in the ticker''s App', NEW.worker_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_ticker_subscriptions_same_app';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ticker_subscriptions_same_app ON ticker_subscriptions;
CREATE TRIGGER trg_ticker_subscriptions_same_app
  BEFORE INSERT ON ticker_subscriptions
  FOR EACH ROW EXECUTE FUNCTION ticker_subscription_worker_same_app();

-- cor:agt:080:03 — wake settings come from the closed lists.
ALTER TABLE worker_wake_settings DROP CONSTRAINT IF EXISTS chk_worker_wake_settings_shape;
ALTER TABLE worker_wake_settings ADD CONSTRAINT chk_worker_wake_settings_shape CHECK (
  mentions IN ('IMMEDIATE', 'OFF')
);

-- cor:agt:080:24 — one live grant per App, grantee and name; the name is from
-- the closed list; the grantee is a worker of the same App.
CREATE UNIQUE INDEX IF NOT EXISTS app_grants_live_uniq
  ON app_grants (app_id, grantee_worker_id, name) WHERE revoked_at IS NULL;

ALTER TABLE app_grants DROP CONSTRAINT IF EXISTS chk_app_grants_shape;
ALTER TABLE app_grants ADD CONSTRAINT chk_app_grants_shape CHECK (
  name IN ('ticker.subscribe-workers')
);

CREATE OR REPLACE FUNCTION app_grant_grantee_same_app() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM workers w WHERE w.id = NEW.grantee_worker_id AND w.app_id = NEW.app_id
  ) THEN
    RAISE EXCEPTION 'app_grants: worker % is not in the App', NEW.grantee_worker_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_app_grants_same_app';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_app_grants_same_app ON app_grants;
CREATE TRIGGER trg_app_grants_same_app
  BEFORE INSERT ON app_grants
  FOR EACH ROW EXECUTE FUNCTION app_grant_grantee_same_app();
