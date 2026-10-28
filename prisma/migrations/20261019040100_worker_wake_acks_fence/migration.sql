
-- #2072: the wake receipt joins the closed #1162 fence inventory (worker_id and its no-FK attribution).
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "worker_wake_acks";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "worker_wake_acks"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id', 'w:$.acked_by_worker_id');
