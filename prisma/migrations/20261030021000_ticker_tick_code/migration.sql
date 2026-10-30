-- #2733: a ticker's action-register code is permanent, including generated copies.
ALTER TABLE tickers ADD COLUMN tick_code text;
UPDATE tickers SET tick_code = 'tick.' || slug WHERE source_template_id IS NULL;

-- Project JS toLowerCase onto the slug's ASCII alphabet without database-locale case folding.
-- U+0130 expands to i + combining dot (which becomes a separator); U+212A lowers to k.
-- Every other non-ASCII character stays outside the slug alphabet after JS lowercasing.
WITH names AS (
  SELECT id, regexp_replace(
    regexp_replace(translate(replace(name, U&'\0130', U&'i\0307'),
      'ABCDEFGHIJKLMNOPQRSTUVWXYZK', 'abcdefghijklmnopqrstuvwxyzk'),
      '[^a-z0-9._-]+', '-', 'g'), '^[._-]+|[._-]+$', '', 'g') AS atom
  FROM agent_ticker_templates
), codes AS (
  SELECT id, coalesce(nullif(regexp_replace(left(atom, 64), '[._-]+$', '', 'g'), ''), 'ticker') AS slug
  FROM names
)
UPDATE tickers t SET tick_code = 'tick.' || c.slug FROM codes c
WHERE t.source_template_id = c.id;
UPDATE tickers SET tick_code = 'tick.' || slug WHERE tick_code IS NULL;
ALTER TABLE tickers ALTER COLUMN tick_code SET NOT NULL;
ALTER TABLE tickers ADD CONSTRAINT tickers_tick_code_shape
  CHECK (tick_code LIKE 'tick.%' AND length(tick_code) > 5);
