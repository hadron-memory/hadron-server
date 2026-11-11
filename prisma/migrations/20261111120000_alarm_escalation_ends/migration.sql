-- #3934 (V77) — the recorded end of an alarm's escalation. Additive only (expand): a new table, nothing existing changes.
CREATE TABLE IF NOT EXISTS alarm_escalation_ends (
  event_id    TEXT PRIMARY KEY REFERENCES agent_team_events(id) ON DELETE CASCADE ON UPDATE CASCADE,
  ended_at    TIMESTAMP(3) NOT NULL,
  recorded_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- #3934 (V77) — the recorded end of an alarm's escalation is written once: an UPDATE is refused. (A DELETE is the App
-- cascade through the event; no application code deletes a row.)
CREATE OR REPLACE FUNCTION hadron_alarm_escalation_end_write_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'An alarm escalation end is recorded once' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS alarm_escalation_end_write_once ON alarm_escalation_ends;
CREATE TRIGGER alarm_escalation_end_write_once BEFORE UPDATE ON alarm_escalation_ends
FOR EACH ROW EXECUTE FUNCTION hadron_alarm_escalation_end_write_once();
