-- #3496: operational state, explicitly classified plaintext (cor:sec:040:03).
-- A hard-deleted message's former high-water count/time survive; deleting the root cascades.
CREATE TABLE IF NOT EXISTS chat_root_counters (
  chat_root_node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Tenant JSON is untrusted. These helpers exist only during this total, restartable data step.
CREATE OR REPLACE FUNCTION hadron_3496_count(d jsonb) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n numeric;
BEGIN
  IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR jsonb_typeof(d->'messageCount') IS DISTINCT FROM 'number' THEN RETURN 0; END IF;
  n := (d->>'messageCount')::numeric;
  IF n < 0 OR n > 2147483647 OR trunc(n) <> n THEN RETURN 0; END IF;
  RETURN n::integer;
END $$;
CREATE OR REPLACE FUNCTION hadron_3496_time(d jsonb) RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE t timestamptz;
BEGIN
  IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR jsonb_typeof(d->'lastMessageAt') IS DISTINCT FROM 'string' THEN RETURN NULL; END IF;
  BEGIN t := (d->>'lastMessageAt')::timestamptz;
  EXCEPTION WHEN data_exception THEN RETURN NULL; END;
  IF NOT isfinite(t) THEN RETURN NULL; END IF;
  RETURN t;
END $$;
DO $$
DECLARE bad_count bigint; bad_time bigint;
BEGIN
  SELECT count(*) FILTER (WHERE jsonb_typeof(n.data)='object' AND n.data ? 'messageCount'
      AND (jsonb_typeof(n.data->'messageCount') <> 'number' OR n.data->'messageCount' <> to_jsonb(hadron_3496_count(n.data)))),
    count(*) FILTER (WHERE jsonb_typeof(n.data)='object' AND n.data ? 'lastMessageAt' AND hadron_3496_time(n.data) IS NULL)
    INTO bad_count,bad_time
  FROM nodes n JOIN memories m ON m.id=n.memory_id
  WHERE NOT m.is_encrypted AND (n.node_type='chat' OR (n.node_type='record' AND n.loc ~ '^chats:[^:]+$'));
  RAISE NOTICE 'chat_root_counters: invalid count %, invalid time % (using 0/null)',bad_count,bad_time;
END $$;
INSERT INTO chat_root_counters(chat_root_node_id,message_count,last_message_at,updated_at)
SELECT n.id,hadron_3496_count(n.data),hadron_3496_time(n.data) AT TIME ZONE 'UTC',CURRENT_TIMESTAMP
FROM nodes n JOIN memories m ON m.id=n.memory_id
WHERE NOT m.is_encrypted AND (n.node_type='chat' OR (n.node_type='record' AND n.loc ~ '^chats:[^:]+$'))
ON CONFLICT DO NOTHING;
-- Never bless pending content drift. Only an in-sync root may refresh its fingerprint.
UPDATE nodes n SET data = n.data - 'messageCount' - 'lastMessageAt',
  revision_content_hash = CASE WHEN n.revision_content_hash = hadron_node_revision_state_hash(n)
    THEN 'refresh' ELSE n.revision_content_hash END
FROM memories m WHERE m.id=n.memory_id AND NOT m.is_encrypted
  AND (n.node_type='chat' OR (n.node_type='record' AND n.loc ~ '^chats:[^:]+$'))
  AND jsonb_typeof(n.data)='object' AND (n.data ? 'messageCount' OR n.data ? 'lastMessageAt');
DROP FUNCTION hadron_3496_count(jsonb);
DROP FUNCTION hadron_3496_time(jsonb);
