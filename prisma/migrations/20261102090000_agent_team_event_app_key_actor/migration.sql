-- #3132 (cor:agt:050:11, :23): an App key's claim records the key as who acted, and the assignee it named as whom the
-- event concerns. Additive only; no FK, sealed like the other actor ids (the append-only trigger covers new columns).
ALTER TABLE "agent_team_events" ADD COLUMN "actor_app_key_id" TEXT;
ALTER TABLE "agent_team_events" ADD COLUMN "subject_user_id" TEXT;
