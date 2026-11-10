-- S12: legacy/off-mode null+false remains UNSET; never infer explicit intent.
ALTER TABLE workers DROP CONSTRAINT IF EXISTS chk_worker_team_choice;
ALTER TABLE workers ADD CONSTRAINT chk_worker_team_choice
  CHECK (NOT (explicit_no_team AND reports_to_worker_id IS NOT NULL));
