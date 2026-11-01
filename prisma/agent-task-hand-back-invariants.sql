-- #2651 (cor:agt:050:29, :01): a task's latest hand-back. The code is one of the closed set, the optional text is
-- at most 2,000 characters and never empty, and the three columns are set together or not at all. A later
-- hand-back replaces all three; the earlier codes stay in the task.handed-back events.
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS chk_agent_tasks_hand_back;
ALTER TABLE agent_tasks ADD CONSTRAINT chk_agent_tasks_hand_back CHECK (
  (hand_back_reason_code IS NULL AND hand_back_reason_text IS NULL AND handed_back_at IS NULL) OR
  -- IS NOT NULL first: a NULL code would make the IN NULL, and a CHECK that evaluates to NULL passes.
  (hand_back_reason_code IS NOT NULL AND hand_back_reason_code IN ('missing_input', 'cannot_do', 'refused', 'out_of_scope', 'duplicate') AND
   handed_back_at IS NOT NULL AND
   (hand_back_reason_text IS NULL OR char_length(hand_back_reason_text) BETWEEN 1 AND 2000))
);
