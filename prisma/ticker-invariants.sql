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
