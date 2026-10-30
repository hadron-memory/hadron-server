-- #2733: existing push-managed databases need the backfill before Prisma adds NOT NULL.
-- Keep the derivation identical to 20261030021000_ticker_tick_code/migration.sql.
DO $$
BEGIN
  IF to_regclass('tickers') IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'tickers'::regclass AND attname = 'tick_code' AND NOT attisdropped) THEN
    ALTER TABLE tickers ADD COLUMN tick_code text;
  END IF;
  UPDATE tickers SET tick_code = 'tick.' || slug WHERE source_template_id IS NULL AND tick_code IS NULL;
  IF to_regclass('agent_ticker_templates') IS NOT NULL THEN
    WITH names AS (
      SELECT id, regexp_replace(
        regexp_replace(translate(replace(name, U&'\0130', U&'i\0307'),
          'ABCDEFGHIJKLMNOPQRSTUVWXYZK', 'abcdefghijklmnopqrstuvwxyzk') COLLATE "C",
          '[^a-z0-9._-]+', '-', 'g'), '^[._-]+|[._-]+$', '', 'g') AS atom
      FROM agent_ticker_templates
    ), codes AS (
      SELECT id, coalesce(nullif(regexp_replace(left(atom, 64), '[._-]+$', '', 'g'), ''), 'ticker') AS slug
      FROM names
    )
    UPDATE tickers t SET tick_code = 'tick.' || c.slug FROM codes c
    WHERE t.source_template_id = c.id AND t.tick_code IS NULL;
  END IF;
  UPDATE tickers SET tick_code = 'tick.' || slug WHERE tick_code IS NULL;
  ALTER TABLE tickers ALTER COLUMN tick_code SET NOT NULL;
END $$;
