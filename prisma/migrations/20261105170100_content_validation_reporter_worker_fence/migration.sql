-- #1332: a content-validation report's WORKER reporter joins the closed #1162 fence inventory (reporter_worker_id, no FK).
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "node_content_validation_reports";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "node_content_validation_reports"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.reporter_worker_id');
