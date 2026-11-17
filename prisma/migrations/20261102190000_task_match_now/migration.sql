-- #2829: additive, existing tasks remain on the automatic matching path.
ALTER TABLE agent_tasks
  ADD COLUMN match_pending BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN match_failed_at TIMESTAMP(3),
  ADD COLUMN match_failed_reason TEXT;
