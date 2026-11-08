-- #3668 (S1a): the grant tables' worker and session columns join the closed #1162 fence inventory. The holder worker_id is
-- fenced as well as the FK-free requested_by_* ids and the event ids. A byte-identical copy of this block ends prisma/worker-reference-invariants.sql.
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "grants";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "grants"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id', 'w:$.requested_by_worker_id', 's:$.requested_by_session_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "grant_events";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "grant_events"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id', 's:$.session_id');
