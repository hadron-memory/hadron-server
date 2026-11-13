-- #4111 — agent_team_events.tx_id becomes NOT NULL (contract section A, "NULL prevention"). A NULL key on a cursor row
-- makes the changed-since read's `(tx_id, created_at, id) > cursor` comparison NULL, so every later page is empty.
--
-- Expand/contract inside ONE transaction:
--   1. backfill NULL -> '0' (a legacy key: '0' sorts first by created_at then id, exactly as the #4084 rows do);
--   2. CHECK (tx_id IS NOT NULL) NOT VALID, then VALIDATE (proves the backfill left no NULL);
--   3. SET NOT NULL (Postgres uses the validated check, so no second scan), then drop the check.
-- The DEFAULT pg_current_xact_id() is kept: a producer that omits tx_id (every one does, including the image before
-- this one) still gets a key, so this is compatible with the previous server image.
--
-- The append-only trigger refuses any change outside the acknowledgement columns, tx_id included. The backfill runs
-- under #4111 contract A2's named-trigger exception (CHECKED amendment 6846467521, T5 = T1-T3 for this backfill):
--   T2  one explicit transaction that takes ACCESS EXCLUSIVE on the table FIRST, so no other session reads or writes
--       while the trigger is off (it may run on a serving database); the DO block refuses to disable without that lock;
--   T3  only "agent_team_event_append_only", by exact name (never ALL/USER, never session_replication_role); every
--       other trigger (the #1162 fence and the internal FK triggers included) must be in its starting state while it is
--       off and after, and it must be back to 'O';
--   T1  only NULL becomes '0': every other column of every row is compared, as text, with the image taken before.
-- Any discrepancy raises, and the whole transaction (keys, columns, trigger state) rolls back. With no NULL row the
-- block returns before touching the trigger. A refusal here is a code defect, not a data preflight, so it raises a plain
-- exception (the #3770 refusal SQLSTATE is for data preflights only).
BEGIN;

LOCK TABLE "agent_team_events" IN ACCESS EXCLUSIVE MODE;

DO $backfill$
DECLARE
  cols text;
  img_before text[];
  img_after text[];
  trig_before text;
  trig_off text;
  trig_after text;
  trig_sql CONSTANT text := $q$
    SELECT string_agg(tgname::text || '=' || tgenabled::text, ',' ORDER BY tgname) FROM pg_trigger
     WHERE tgrelid = 'agent_team_events'::regclass$q$;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "agent_team_events" WHERE "tx_id" IS NULL) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_locks
                  WHERE pid = pg_backend_pid() AND locktype = 'relation' AND granted
                    AND relation = 'agent_team_events'::regclass
                    AND mode IN ('ExclusiveLock', 'AccessExclusiveLock')) THEN
    RAISE EXCEPTION '#4111 T2: the tx_id backfill needs a writer-excluding lock held in this transaction';
  END IF;
  IF current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION '#4111 T3: session_replication_role is %, not origin', current_setting('session_replication_role');
  END IF;
  IF (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'agent_team_events'::regclass
         AND tgname = 'agent_team_event_append_only') IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION '#4111 T3: agent_team_event_append_only is not enabled before the backfill';
  END IF;

  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO cols FROM pg_attribute
   WHERE attrelid = 'agent_team_events'::regclass AND attnum > 0 AND NOT attisdropped AND attname <> 'tx_id';
  EXECUTE format('SELECT array_agg(ROW(%s)::text ORDER BY id) FROM "agent_team_events"', cols) INTO img_before;
  EXECUTE trig_sql INTO trig_before;

  ALTER TABLE "agent_team_events" DISABLE TRIGGER "agent_team_event_append_only";
  EXECUTE trig_sql INTO trig_off;
  IF trig_off IS DISTINCT FROM replace(trig_before, 'agent_team_event_append_only=O', 'agent_team_event_append_only=D') THEN
    RAISE EXCEPTION '#4111 T3: a trigger other than agent_team_event_append_only changed state';
  END IF;

  UPDATE "agent_team_events" SET "tx_id" = '0'::xid8 WHERE "tx_id" IS NULL;

  ALTER TABLE "agent_team_events" ENABLE TRIGGER "agent_team_event_append_only";
  EXECUTE trig_sql INTO trig_after;
  IF trig_after IS DISTINCT FROM trig_before THEN
    RAISE EXCEPTION '#4111 T3: trigger state after the backfill differs from its start';
  END IF;
  IF current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION '#4111 T3: session_replication_role changed during the backfill';
  END IF;
  EXECUTE format('SELECT array_agg(ROW(%s)::text ORDER BY id) FROM "agent_team_events"', cols) INTO img_after;
  IF img_after IS DISTINCT FROM img_before THEN
    RAISE EXCEPTION '#4111 T1: a column other than tx_id changed during the backfill';
  END IF;
END
$backfill$;

ALTER TABLE "agent_team_events" ADD CONSTRAINT "agent_team_events_tx_id_not_null" CHECK ("tx_id" IS NOT NULL) NOT VALID;
ALTER TABLE "agent_team_events" VALIDATE CONSTRAINT "agent_team_events_tx_id_not_null";
ALTER TABLE "agent_team_events" ALTER COLUMN "tx_id" SET NOT NULL;
ALTER TABLE "agent_team_events" DROP CONSTRAINT "agent_team_events_tx_id_not_null";

COMMIT;
