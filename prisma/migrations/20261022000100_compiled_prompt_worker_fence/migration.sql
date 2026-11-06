-- #2046: a compiled boot-prompt revision's target worker joins the closed #1162 fence inventory.
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "compiled_prompt_revisions";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "compiled_prompt_revisions"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.target_worker_id');
