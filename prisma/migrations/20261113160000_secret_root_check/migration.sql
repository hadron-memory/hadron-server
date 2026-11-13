-- #4003 (S8 of #3991) — the key-check value of the active secrets root. Additive only (expand): a new table.
CREATE TABLE IF NOT EXISTS secret_root_check (
  id          INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
  check_value TEXT NOT NULL,
  updated_at  TIMESTAMP(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC')
);

-- #4003 (S8 of #3991; FIT delta 2) — the secrets root's key-check value is exactly one row with a non-empty value.
-- One source, shared verbatim with migration 20261113160000_secret_root_check.
ALTER TABLE secret_root_check DROP CONSTRAINT IF EXISTS chk_secret_root_check_shape;
ALTER TABLE secret_root_check ADD CONSTRAINT chk_secret_root_check_shape CHECK (id = 1 AND check_value ~ '^[0-9a-f]{64}$');
