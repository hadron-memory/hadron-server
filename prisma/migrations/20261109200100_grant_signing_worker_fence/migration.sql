-- #3649 slice B: the grant signing request's FK-free requester worker and session ids join the closed #1162 fence inventory.
-- A byte-identical copy of this block ends prisma/worker-reference-invariants.sql.
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "grant_signing_requests";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "grant_signing_requests"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.requester_worker_id', 's:$.requester_session_id');
