
-- #2022: the stop signals' target worker and the coverage ledger's worker join the closed #1162 fence inventory.
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "team_stop_signals";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "team_stop_signals"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.target_worker_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "team_stop_coverage";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "team_stop_coverage"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id');
