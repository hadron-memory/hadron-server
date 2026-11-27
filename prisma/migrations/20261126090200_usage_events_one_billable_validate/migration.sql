-- #5020: validate the NOT VALID CHECK added by 20261126090000. Same lock and same reason as the foreign key's validation:
-- every existing row has a NULL billable_user_id, so no row can have both columns set. Alone in its file.
ALTER TABLE "usage_events" VALIDATE CONSTRAINT "chk_usage_event_one_billable";
