-- Existing rows have no recorded history. Do not invent a clean old sync.
-- The column and backfill are one statement; a second execution leaves later
-- clean NULLs alone rather than converting them back into unknown history.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'memories'
      AND column_name = 'last_sync_report'
  ) THEN
    ALTER TABLE memories ADD COLUMN last_sync_report TEXT;
    UPDATE memories SET last_sync_report = json_build_object(
      'version', 1, 'outcome', 'unknown',
      'recordedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'entries', json_build_array()
    )::text;
  END IF;
END $$;
