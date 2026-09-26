-- #1326: nullable, server-owned authorship on live and historical Node states,
-- plus separate advisory validation reports. No legacy attribution is inferred.
CREATE TYPE "NodeAuthorshipKind" AS ENUM ('TASK', 'HUMAN');
CREATE TYPE "NodeContentValidationOutcome" AS ENUM ('PASS', 'FAIL', 'ERROR');

ALTER TABLE "nodes"
  ADD COLUMN "authorship_kind" "NodeAuthorshipKind",
  ADD COLUMN "authored_by_task" TEXT,
  ADD COLUMN "authored_by_revision" INTEGER,
  ADD COLUMN "authored_by_human" TEXT,
  ADD COLUMN "authored_at" TIMESTAMP(3);

ALTER TABLE "node_revisions"
  ADD COLUMN "authorship_kind" "NodeAuthorshipKind",
  ADD COLUMN "authored_by_task" TEXT,
  ADD COLUMN "authored_by_revision" INTEGER,
  ADD COLUMN "authored_by_human" TEXT,
  ADD COLUMN "authored_at" TIMESTAMP(3);

CREATE TABLE "node_content_validation_reports" (
  "id" TEXT NOT NULL,
  "node_id" TEXT NOT NULL,
  "memory_id" TEXT NOT NULL,
  "node_rev_seq" INTEGER NOT NULL,
  "validation_task_id" TEXT NOT NULL,
  "validation_task_rev_seq" INTEGER NOT NULL,
  "outcome" "NodeContentValidationOutcome" NOT NULL,
  "reported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "run_id" TEXT,
  CONSTRAINT "node_content_validation_reports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "node_content_validation_reports_run_id_key"
  ON "node_content_validation_reports"("run_id");
CREATE INDEX "node_validation_node_rev_reported_idx"
  ON "node_content_validation_reports"("node_id", "node_rev_seq", "reported_at");
CREATE INDEX "node_content_validation_reports_memory_id_idx"
  ON "node_content_validation_reports"("memory_id");
ALTER TABLE "node_content_validation_reports"
  ADD CONSTRAINT "node_content_validation_reports_node_id_fkey"
  FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The three shapes are mutually exclusive. A null kind is genuinely unknown,
-- not a human edit inferred from an editor string. A task stamp always pins the
-- exact task revision; a human stamp never impersonates a task.
ALTER TABLE "nodes" ADD CONSTRAINT "chk_nodes_authorship_shape" CHECK (CASE
  WHEN "authorship_kind" IS NULL THEN
    "authored_by_task" IS NULL AND "authored_by_revision" IS NULL AND "authored_by_human" IS NULL AND "authored_at" IS NULL
  WHEN "authorship_kind" = 'TASK' THEN
    "authored_by_task" IS NOT NULL AND "authored_by_revision" IS NOT NULL AND "authored_by_revision" > 0 AND "authored_by_human" IS NULL AND "authored_at" IS NOT NULL
  WHEN "authorship_kind" = 'HUMAN' THEN
    "authored_by_task" IS NULL AND "authored_by_revision" IS NULL AND "authored_by_human" IS NOT NULL AND "authored_at" IS NOT NULL
  ELSE false END);
ALTER TABLE "node_revisions" ADD CONSTRAINT "chk_node_revisions_authorship_shape" CHECK (CASE
  WHEN "authorship_kind" IS NULL THEN
    "authored_by_task" IS NULL AND "authored_by_revision" IS NULL AND "authored_by_human" IS NULL AND "authored_at" IS NULL
  WHEN "authorship_kind" = 'TASK' THEN
    "authored_by_task" IS NOT NULL AND "authored_by_revision" IS NOT NULL AND "authored_by_revision" > 0 AND "authored_by_human" IS NULL AND "authored_at" IS NOT NULL
  WHEN "authorship_kind" = 'HUMAN' THEN
    "authored_by_task" IS NULL AND "authored_by_revision" IS NULL AND "authored_by_human" IS NOT NULL AND "authored_at" IS NOT NULL
  ELSE false END);
ALTER TABLE "node_content_validation_reports" ADD CONSTRAINT "chk_node_content_validation_revisions_positive"
  CHECK ("node_rev_seq" > 0 AND "validation_task_rev_seq" > 0);

-- #1323's fingerprint covers every curated NodeRevision field. Preserve a
-- pre-existing drift mismatch instead of silently blessing it during this
-- expansion: only rows whose stored hash matched the OLD function advance to
-- the new encoding. A mismatched row still reconciles on its next exposed read.
CREATE TEMP TABLE node_revision_hash_before_1326 (id TEXT, stored_hash TEXT, old_actual_hash TEXT);
DO $$ BEGIN
  -- A db-push-only baseline (including migration-smoke CI) has the column but
  -- not #1323's raw-SQL function. There is no old canonical hash to translate.
  IF to_regprocedure('hadron_node_revision_state_hash(nodes)') IS NOT NULL THEN
    EXECUTE 'INSERT INTO node_revision_hash_before_1326
      SELECT n.id, n.revision_content_hash, hadron_node_revision_state_hash(n) FROM nodes n';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION hadron_node_revision_state_hash(node_row "nodes")
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT md5(jsonb_build_array(
    node_row."memory_id", node_row."loc", node_row."name", node_row."alias",
    node_row."description", node_row."abstract", node_row."abstract_origin_hash",
    node_row."content", to_jsonb(node_row."tags"), node_row."node_type",
    node_row."object_type", node_row."is_link", node_row."properties",
    node_row."data", node_row."seq", node_row."is_runnable", node_row."role",
    node_row."llm_model", node_row."ai_agent", node_row."authorship_kind",
    node_row."authored_by_task", node_row."authored_by_revision",
    node_row."authored_by_human", node_row."authored_at"
  )::text)
$$;

UPDATE "nodes" n SET "revision_content_hash" = hadron_node_revision_state_hash(n)
FROM node_revision_hash_before_1326 old
WHERE n.id = old.id AND old.stored_hash IS NOT NULL
  AND old.stored_hash = old.old_actual_hash;
DROP TABLE node_revision_hash_before_1326;
