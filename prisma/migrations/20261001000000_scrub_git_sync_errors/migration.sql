-- #1578: older git errors may contain an installation token in the command
-- argv or stderr. Their exact spelling is unknowable, so replace every stored
-- diagnostic with fixed copy while preserving ERROR status for the UI.
UPDATE "memories"
SET "sync_error" = 'A previous sync failed. Retry to see the current error.'
WHERE "sync_error" IS NOT NULL;
