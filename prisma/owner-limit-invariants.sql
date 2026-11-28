-- #5009 (Billing A7a): the owner-limit rows. One source, shared verbatim with migration 20261124190000_owner_limits.
-- Idempotent: drop-then-add.
ALTER TABLE owner_limits DROP CONSTRAINT IF EXISTS chk_owner_limits_one_owner;
ALTER TABLE owner_limits ADD CONSTRAINT chk_owner_limits_one_owner
  CHECK (num_nonnulls(organization_id, owner_user_id) = 1);
ALTER TABLE owner_limits DROP CONSTRAINT IF EXISTS chk_owner_limits_shape;
ALTER TABLE owner_limits ADD CONSTRAINT chk_owner_limits_shape CHECK (
  key <> '' AND (limit_value IS NULL OR limit_value >= 0)
  AND btrim(source_type) <> '' AND btrim(source_id) <> '' AND btrim(note) <> ''
);
