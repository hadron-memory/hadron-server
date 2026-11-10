-- #3818: the typed successor reference joins the existing closed #1162 inventory.
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "sessions";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id', 's:$.parent_session_id', 's:$.prev_session_id', 's:$.superseded_by_session_id');
