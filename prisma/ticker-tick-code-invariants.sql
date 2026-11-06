-- #2733: separate from the byte-pinned historical #1747 invariants.
ALTER TABLE tickers DROP CONSTRAINT IF EXISTS tickers_tick_code_shape;
ALTER TABLE tickers ADD CONSTRAINT tickers_tick_code_shape
  CHECK (tick_code LIKE 'tick.%' AND length(tick_code) > 5);
