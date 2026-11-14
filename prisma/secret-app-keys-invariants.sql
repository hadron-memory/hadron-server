-- #3996 (S1 of #3991) — per-App data keys: exactly one ACTIVE key per App, and a row is never empty or a version below 1.
-- Prisma cannot model a partial unique index, so it lives here and in the migration (one source, shared verbatim with
-- migration 20261112150000_secret_app_keys).
CREATE UNIQUE INDEX IF NOT EXISTS secret_app_keys_one_active_idx ON secret_app_keys (app_id) WHERE retired_at IS NULL;
ALTER TABLE secret_app_keys DROP CONSTRAINT IF EXISTS chk_secret_app_key_shape;
ALTER TABLE secret_app_keys ADD CONSTRAINT chk_secret_app_key_shape CHECK (key_version >= 1 AND wrapped_key <> '');
