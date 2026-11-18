-- #2162: a context reset's worker and session join the closed #1162 fence inventory.
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "context_resets";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "context_resets"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id', 's:$.session_id');
