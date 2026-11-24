-- #4344: the reads of one task's events of one type (the progress / queued / edited maxima in loadStallInputs) were served by
-- the leading (task_id, type) of agent_team_events_episode_uniq. The contract migration after this one drops that index, so
-- they get an index of their own first; it also serves every task_id-only lookup, so it replaces agent_team_events_task_id_idx
-- (dropped in the contract migration). CONCURRENTLY cannot run inside a transaction block, and `prisma migrate deploy` sends a
-- file as ONE simple query, so this file must stay a single statement (precedent: 20261023130100_alarm_schedule_open_due_idx).
-- A failed CONCURRENTLY build leaves an INVALID index under this name that IF NOT EXISTS would skip: drop it and re-run by hand.
CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_team_events_task_id_type_idx ON agent_team_events (task_id, type);
