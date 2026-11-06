-- #2024 (S8, cor:agt:080:33): the database facts Prisma's schema language cannot model for Agent ticker
-- templates and the tickers generated from them. Source of truth; the migration carries a byte-identical
-- copy at its end (pinned by src/lib/tickers/agentTickerTemplate.invariants.test.ts) and post-push.sql includes this file.

-- A template is a ticker's declaration: its cadence, relevance and name follow the ticker's bounds, its reasons
-- are a non-empty subset of the closed set (a ticker with none would never fire, R49d), and only shape 1 exists.
ALTER TABLE agent_ticker_templates DROP CONSTRAINT IF EXISTS chk_agent_ticker_templates_shape;
ALTER TABLE agent_ticker_templates ADD CONSTRAINT chk_agent_ticker_templates_shape CHECK (
  shape_version = 1
  AND revision >= 1
  AND cadence_seconds BETWEEN 1 AND 86400
  AND relevance IN ('ALL', 'MENTIONS')
  AND char_length(name) BETWEEN 1 AND 100
  AND cardinality(reasons) >= 1
  AND reasons <@ ARRAY['read-team-channel', 'every-tick', 'live-check']::text[]
);

-- A live template's name is unique within its Agent, ignoring case; a removed template's name may be reused.
CREATE UNIQUE INDEX IF NOT EXISTS agent_ticker_templates_name_live_uniq
  ON agent_ticker_templates (agent_id, lower(name)) WHERE deleted_at IS NULL;

-- A generated ticker records its whole provenance or none of it, and belongs to the worker it was made for.
ALTER TABLE tickers DROP CONSTRAINT IF EXISTS chk_tickers_generated;
ALTER TABLE tickers ADD CONSTRAINT chk_tickers_generated CHECK (
  (source_template_id IS NULL AND source_template_revision IS NULL AND generated_for_worker_id IS NULL)
  OR (source_template_id IS NOT NULL AND source_template_revision IS NOT NULL AND generated_for_worker_id IS NOT NULL
      AND owner_worker_id IS NOT NULL AND owner_worker_id = generated_for_worker_id)
);
