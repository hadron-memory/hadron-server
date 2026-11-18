-- AlterTable
ALTER TABLE "tickers" ADD COLUMN     "generated_for_worker_id" TEXT,
ADD COLUMN     "source_template_id" TEXT,
ADD COLUMN     "source_template_revision" INTEGER;

-- CreateTable
CREATE TABLE "agent_ticker_templates" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "shape_version" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "cadence_seconds" INTEGER NOT NULL,
    "quiet_hours" JSONB,
    "relevance" TEXT NOT NULL DEFAULT 'ALL',
    "reasons" TEXT[] DEFAULT ARRAY['read-team-channel']::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "agent_ticker_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_ticker_templates_agent_id_deleted_at_idx" ON "agent_ticker_templates"("agent_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "tickers_generated_uniq" ON "tickers"("generated_for_worker_id", "source_template_id");

-- AddForeignKey
ALTER TABLE "agent_ticker_templates" ADD CONSTRAINT "agent_ticker_templates_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;


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
