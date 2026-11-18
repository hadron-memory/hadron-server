-- #2024 (S8): a generated ticker's worker joins the closed #1162 fence inventory (generated_for_worker_id, no FK).
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "tickers";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "tickers"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.owner_worker_id', 'w:$.generated_for_worker_id', 'w:$.created_by_worker_id', 'w:$.updated_by_worker_id', 'w:$.deleted_by_worker_id');
