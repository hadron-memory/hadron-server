ALTER TABLE workers ADD COLUMN explicit_no_team boolean NOT NULL DEFAULT false;
ALTER TABLE workers ADD CONSTRAINT chk_worker_team_choice
  CHECK (NOT (explicit_no_team AND reports_to_worker_id IS NOT NULL));
