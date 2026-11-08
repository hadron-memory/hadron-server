-- #2944 (cor:acl:090:01, ruling 0244 item 3): record the App key that authenticated the request that made a
-- usage event, so usageEvents(appKey:) can answer "what did this key do". Nullable; existing rows stay null
-- (no backfill is possible). ON DELETE SET NULL like app_id: a key row is only hard-deleted with its App.
--
-- usage_events is the append-only, high-volume firehose, so nothing here scans it (#3714 blind P2): the column
-- is nullable with no default (a catalog-only change) and the foreign key is added NOT VALID, which only takes a
-- brief lock on both tables and checks new writes from then on. The existing rows are checked by
-- 20261107220100 (VALIDATE, which does not block writes) and the index is built CONCURRENTLY by 20261107220200.
ALTER TABLE "usage_events" ADD COLUMN "app_key_id" TEXT;

ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_app_key_id_fkey" FOREIGN KEY ("app_key_id") REFERENCES "app_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
