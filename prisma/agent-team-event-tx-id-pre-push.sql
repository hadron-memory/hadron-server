-- #4539 (follow-up to #4524): the pre-`prisma db push` counterpart of 20261113180000_agent_team_event_tx_id_not_null.
--
-- A push-synced database from between #4084 and #4111 can hold `agent_team_events` rows whose `tx_id` is NULL. The schema
-- declares the column required, and `prisma db push` aborts on it ("Made the column `tx_id` on table `agent_team_events`
-- required, but there are 2 existing NULL values"), which breaks the documented non-wiping `pnpm db:dev-setup`. This block
-- backfills NULL to '0' first, as the migration does; making the column required is then the push's own step.
--
-- The backfill is not a plain UPDATE: the append-only trigger refuses it. It runs under #4111 contract A2's named-trigger
-- exception exactly as the migration does: ACCESS EXCLUSIVE taken FIRST (here inside this one statement, so it is held
-- for the whole block), only "agent_team_event_append_only" disabled, by exact name, every other trigger compared before
-- and after, every other column of every row compared as text. Any discrepancy raises and rolls the block back.
--
-- From the writer-lock check to the closing delimiter the block is DUPLICATED VERBATIM from the migration (pinned by
-- src/test/integration/4539-tx-id-pre-push.test.ts). Change one, change the other. It acts only on a table whose `tx_id`
-- is still nullable AND holds a NULL row, so it is a no-op on a fresh database, on a migrated one, and on a second run.
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
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'agent_team_events'
      AND column_name = 'tx_id' AND is_nullable = 'YES'
  ) THEN
    RETURN;
  END IF;
  LOCK TABLE "agent_team_events" IN ACCESS EXCLUSIVE MODE;
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
