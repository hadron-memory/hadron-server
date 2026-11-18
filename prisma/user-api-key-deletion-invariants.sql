-- #2659 (cor:dmo:070:03, ruling 0007 A): the trace of a deleted user API key.
-- One source, shared verbatim with migration 20261103120000_user_api_key_deletions
-- (pinned by src/api/graphql/schema/resolvers.userApiKeyDelete2659.test.ts) and applied by post-push.sql
-- and the test globalSetup.
--
-- A deletion record is never edited. A DELETE is refused unless its user row is already gone (the ON DELETE
-- CASCADE of a hard user delete). TRUNCATE fires no row trigger; it is the TEST-ONLY cleanup path
-- (src/test/helpers.ts cleanDb).
ALTER TABLE user_api_key_deletions DROP CONSTRAINT IF EXISTS chk_user_api_key_deletion_shape;
ALTER TABLE user_api_key_deletions ADD CONSTRAINT chk_user_api_key_deletion_shape CHECK (
  key_id <> '' AND key_preview <> '' AND revoked_key_ids IS NOT NULL AND minted_key_ids IS NOT NULL AND
  array_position(revoked_key_ids, NULL) IS NULL AND array_position(minted_key_ids, NULL) IS NULL
);
CREATE OR REPLACE FUNCTION hadron_append_only_user_api_key_deletion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id) THEN
      RAISE EXCEPTION 'User API key deletion records are append-only' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'User API key deletion records are append-only' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS user_api_key_deletion_append_only ON user_api_key_deletions;
CREATE TRIGGER user_api_key_deletion_append_only BEFORE UPDATE OR DELETE ON user_api_key_deletions
FOR EACH ROW EXECUTE FUNCTION hadron_append_only_user_api_key_deletion();
