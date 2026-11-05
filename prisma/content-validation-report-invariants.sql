-- #1332 (cor:dmo:160:01): a content-validation report's author check and its
-- server-derived reporter. One source, shared verbatim with migration
-- 20261105170000_content_validation_reporter (pinned by
-- src/api/graphql/schema/resolvers.contentValidationReport1332.test.ts).
--
-- Shape: a report written before #1332 has neither an author check nor a
-- reporter; every report since has both. Each reporter kind carries exactly the
-- ids that identify it (a WORKER's agent may be absent), and nothing else.
ALTER TABLE "node_content_validation_reports" DROP CONSTRAINT IF EXISTS "chk_node_content_validation_reporter_shape";
ALTER TABLE "node_content_validation_reports" ADD CONSTRAINT "chk_node_content_validation_reporter_shape" CHECK (
  ("author_check" IS NULL) = ("reporter_kind" IS NULL) AND CASE
  WHEN "reporter_kind" IS NULL THEN
    "reporter_run_id" IS NULL AND "reporter_worker_id" IS NULL AND "reporter_agent_id" IS NULL
      AND "reporter_user_id" IS NULL AND "reporter_app_key_id" IS NULL
  WHEN "reporter_kind" = 'RUN' THEN
    "reporter_run_id" IS NOT NULL AND "reporter_worker_id" IS NULL AND "reporter_agent_id" IS NULL
      AND "reporter_user_id" IS NULL AND "reporter_app_key_id" IS NULL
  WHEN "reporter_kind" = 'WORKER' THEN
    "reporter_run_id" IS NULL AND "reporter_worker_id" IS NOT NULL
      AND "reporter_user_id" IS NULL AND "reporter_app_key_id" IS NULL
  WHEN "reporter_kind" = 'PERSON' THEN
    "reporter_run_id" IS NULL AND "reporter_worker_id" IS NULL AND "reporter_agent_id" IS NULL
      AND "reporter_user_id" IS NOT NULL AND "reporter_app_key_id" IS NULL
  WHEN "reporter_kind" = 'APP_KEY' THEN
    "reporter_run_id" IS NULL AND "reporter_worker_id" IS NULL AND "reporter_agent_id" IS NULL
      AND "reporter_user_id" IS NULL AND "reporter_app_key_id" IS NOT NULL
  ELSE false END);

-- Reports are append-only history. The one permitted change is a user merge
-- moving a PERSON reporter's user id to the survivor (mergeUsers), and only
-- along a merge already recorded in user_merges (mergeUsers writes that row
-- before it reassigns); a row may still be deleted with its node (the node FK
-- cascades).
CREATE OR REPLACE FUNCTION hadron_node_content_validation_report_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'reporter_user_id') IS DISTINCT FROM (to_jsonb(OLD) - 'reporter_user_id') THEN
    RAISE EXCEPTION 'node_content_validation_reports is append-only';
  END IF;
  IF NEW."reporter_user_id" IS DISTINCT FROM OLD."reporter_user_id" AND NOT (
    OLD."reporter_kind" = 'PERSON' AND OLD."reporter_user_id" IS NOT NULL AND NEW."reporter_user_id" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "user_merges" m
      WHERE m."source_user_id" = OLD."reporter_user_id" AND m."target_user_id" = NEW."reporter_user_id"
    )
  ) THEN
    RAISE EXCEPTION 'node_content_validation_reports is append-only';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS node_content_validation_reports_immutable ON "node_content_validation_reports";
CREATE TRIGGER node_content_validation_reports_immutable
  BEFORE UPDATE ON "node_content_validation_reports"
  FOR EACH ROW EXECUTE FUNCTION hadron_node_content_validation_report_immutable();
