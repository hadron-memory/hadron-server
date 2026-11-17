-- #3557 / ruling 0209 (contract step): strip the rollback mirror of conversationName/stageName from plaintext chat roots.
-- Data-only and restartable. A name is removed only where the state row holds that name and the root's own copy is a valid
-- name (a malformed copy, or a root with no row or no such key in its row, keeps its value). Tombstones are included.
-- Encrypted roots are never touched here: they are scrubbed lazily inside an authorized keyed write.
-- The refresh marker is set only where the stored hash equals the hash of the pre-write state (the #3523 rule).
CREATE OR REPLACE FUNCTION hadron_3557_name_valid(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(v)='string' AND length(btrim(v #>> '{}', E' \t\n\r\f' || chr(11) || U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))>0
$$;
UPDATE nodes n SET data=n.data - ARRAY(
    SELECT e.key FROM jsonb_each(n.data) e
    WHERE e.key=ANY(ARRAY['conversationName','stageName']) AND hadron_3557_name_valid(e.value)
      AND EXISTS(SELECT 1 FROM chat_root_engine_states es WHERE es.chat_root_node_id=n.id AND es.state ? e.key AND hadron_3557_name_valid(es.state->e.key))),
  revision_content_hash=CASE WHEN n.revision_content_hash=hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n.revision_content_hash END
FROM memories m
WHERE m.id=n.memory_id AND NOT m.is_encrypted AND n.node_type='record' AND n.loc ~ '^chats:[^:]+$'
  AND jsonb_typeof(n.data)='object' AND NOT(n.data ? '__enc')
  AND EXISTS(SELECT 1 FROM jsonb_each(n.data) e
    WHERE e.key=ANY(ARRAY['conversationName','stageName']) AND hadron_3557_name_valid(e.value)
      AND EXISTS(SELECT 1 FROM chat_root_engine_states es WHERE es.chat_root_node_id=n.id AND es.state ? e.key AND hadron_3557_name_valid(es.state->e.key)));
DROP FUNCTION hadron_3557_name_valid(jsonb);
