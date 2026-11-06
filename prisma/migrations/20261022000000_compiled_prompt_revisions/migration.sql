-- #2046 (S9, R38) — the immutable per-revision provenance of a compiled boot
-- prompt. Additive: one new table, no backfill, no reader or writer yet (the
-- compile lands in a later S9 PR; nothing serves from it until S10, #2047).
-- CreateTable
CREATE TABLE "compiled_prompt_revisions" (
    "compiled_node_id" TEXT NOT NULL,
    "compiled_rev_no" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "target_kind" TEXT NOT NULL,
    "target_agent_id" TEXT NOT NULL,
    "target_app_id" TEXT,
    "target_worker_id" TEXT,
    "provenance" JSONB NOT NULL,
    "occurrence_count" INTEGER NOT NULL,
    "compiled_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compiled_prompt_revisions_pkey" PRIMARY KEY ("compiled_node_id","compiled_rev_no")
);

-- AddForeignKey
ALTER TABLE "compiled_prompt_revisions" ADD CONSTRAINT "compiled_prompt_revisions_compiled_node_id_fkey" FOREIGN KEY ("compiled_node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Verbatim copy of prisma/compiled-prompt-revision-invariants.sql (pinned by
-- src/lib/bootCompile/compiledRevision2046.test.ts).
-- #2046 (S9, R38) — compiled_prompt_revisions: one immutable provenance row per
-- compiled boot-prompt revision. The ONE source of this SQL: included verbatim by
-- prisma/post-push.sql (dev DB, test template, CI) and copied into
-- 20261022000000_compiled_prompt_revisions (prod, which does not run
-- post-push.sql). Change it only together with a new migration that carries the
-- new text. Idempotent.
ALTER TABLE "compiled_prompt_revisions" DROP CONSTRAINT IF EXISTS "chk_compiled_prompt_revisions_shape";
ALTER TABLE "compiled_prompt_revisions" ADD CONSTRAINT "chk_compiled_prompt_revisions_shape" CHECK (
  "compiled_rev_no" >= 1
  AND "occurrence_count" >= 0
  AND "content_hash" ~ '^[0-9a-f]{64}$'
  AND jsonb_typeof("provenance") = 'object'
  AND (
    ("target_kind" = 'AGENT' AND "target_app_id" IS NULL AND "target_worker_id" IS NULL)
    OR ("target_kind" = 'APP_AGENT' AND "target_app_id" IS NOT NULL AND "target_worker_id" IS NULL)
    OR ("target_kind" = 'WORKER' AND "target_app_id" IS NOT NULL AND "target_worker_id" IS NOT NULL)
  ));

-- A revision's provenance is written once, with the revision. A hard delete of
-- the compiled node cascades its rows away; nothing ever rewrites one.
CREATE OR REPLACE FUNCTION hadron_compiled_prompt_revision_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'compiled_prompt_revisions rows are immutable' USING ERRCODE = 'check_violation';
END;
$$;
DROP TRIGGER IF EXISTS compiled_prompt_revisions_immutable ON "compiled_prompt_revisions";
CREATE TRIGGER compiled_prompt_revisions_immutable
  BEFORE UPDATE ON "compiled_prompt_revisions"
  FOR EACH ROW EXECUTE FUNCTION hadron_compiled_prompt_revision_immutable();
