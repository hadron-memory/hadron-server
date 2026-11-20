-- #4001 / cor:sec:060:03: the signed mark requires a finite expiry or budget on its ONE grant.
ALTER TABLE grants DROP CONSTRAINT IF EXISTS chk_secret_auto_delete_limit;
ALTER TABLE grants ADD CONSTRAINT chk_secret_auto_delete_limit CHECK (
  action NOT IN ('secret.reveal', 'secret.use')
  OR action_values->>'auto-delete' IS DISTINCT FROM 'delete'
  OR expires_at IS NOT NULL OR max_uses IS NOT NULL
) NOT VALID;
-- NOT VALID preserves historical pending rows from the pre-S6 generic door (#4594); new writes are checked.
-- Signing rechecks this rule, so such a pending row cannot activate an unbounded deletion promise.
