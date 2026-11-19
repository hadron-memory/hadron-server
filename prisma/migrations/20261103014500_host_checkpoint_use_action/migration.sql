-- #3276: admit the host key checkpoint use, without granting any generic node write.
ALTER TABLE host_key_uses DROP CONSTRAINT IF EXISTS chk_host_key_uses_shape;
ALTER TABLE host_key_uses ADD CONSTRAINT chk_host_key_uses_shape CHECK (
  action IN ('register', 'collect', 'report', 'availability', 'read', 'session', 'issue', 'deliver', 'stop', 'reset', 'terminal', 'checkpoint') AND
  host_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
  (count IS NULL OR count >= 0) AND
  -- A refused report may name no operation it could see; an accepted one always names its own. #2162: so does a
  -- context-reset protocol step (`reset`).
  (CASE WHEN refused_code IS NULL THEN (action IN ('report', 'reset', 'checkpoint')) = (operation_id IS NOT NULL)
        ELSE (operation_id IS NULL OR action IN ('report', 'reset', 'checkpoint')) AND refused_code ~ '^[A-Z][A-Z0-9_]{0,63}$' END)
);
