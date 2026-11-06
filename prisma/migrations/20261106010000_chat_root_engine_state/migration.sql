-- #3501 / rulings0202,0209: encrypted operational state; no plaintext exception.
CREATE TABLE IF NOT EXISTS chat_root_engine_states (
  chat_root_node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE ON UPDATE CASCADE,
  state JSONB NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL
);
-- Total validator: tenant JSON is untrusted. Invalid values stay in legacy data.
CREATE OR REPLACE FUNCTION hadron_3501_time(v jsonb) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR (v #>> '{}') !~ '^\d{4}-\d\d-\d\dT' THEN RETURN false; END IF;
  BEGIN RETURN isfinite((v #>> '{}')::timestamptz); EXCEPTION WHEN data_exception THEN RETURN false; END;
END $$;
CREATE OR REPLACE FUNCTION hadron_3501_valid(k text,v jsonb) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  IF k IN ('conversationName','stageName') THEN RETURN jsonb_typeof(v)='string' AND length(btrim(v #>> '{}'))>0; END IF;
  IF k='lastOffTrackReason' THEN RETURN jsonb_typeof(v)='string'; END IF;
  IF k='lastOffTrackAt' THEN
    IF jsonb_typeof(v)<>'string' OR (v #>> '{}') !~ '^\d{4}-\d\d-\d\dT' THEN RETURN false; END IF;
    BEGIN RETURN isfinite((v #>> '{}')::timestamptz); EXCEPTION WHEN data_exception THEN RETURN false; END;
  END IF;
  IF k IN ('routeHistory','goalStack') THEN
    IF jsonb_typeof(v)<>'array' THEN RETURN false; END IF;
    RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v) e WHERE NOT COALESCE(
      jsonb_typeof(e)='object' AND
      CASE WHEN k='routeHistory' THEN
        (e->>'action')=ANY(ARRAY['ENTER','EXIT','COMPLETED','FOLLOWED']) AND hadron_3501_time(e->'timestamp')
        AND (NOT(e ? 'trigger') OR (jsonb_typeof(e->'trigger')='object' AND jsonb_typeof(e->'trigger'->'type')='string' AND (NOT(e->'trigger' ? 'content') OR jsonb_typeof(e->'trigger'->'content')='string')))
      ELSE jsonb_typeof(e->'description')='string' AND (e->>'createdBy')=ANY(ARRAY['ASSISTANT','USER'])
        AND (e->>'status')=ANY(ARRAY['ACTIVE','COMPLETED','ABANDONED']) AND hadron_3501_time(e->'createdAt')
        AND (NOT(e ? 'completedAt') OR hadron_3501_time(e->'completedAt')) END
      AND NOT EXISTS(SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(e)='object' THEN e ELSE '{}'::jsonb END) field
        WHERE field.key=ANY(ARRAY['nodeUrn','topicUrn','conversationUrn','edgeUrn','language']) AND jsonb_typeof(field.value)<>'string'),false));
  END IF;
  RETURN false;
END $$;
DO $$
DECLARE malformed bigint;
BEGIN
  SELECT count(*) INTO malformed FROM nodes n JOIN memories m ON m.id=n.memory_id
    CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(n.data)='object' THEN n.data ELSE '{}'::jsonb END) e
    WHERE n.node_type='record' AND n.loc ~ '^chats:[^:]+$' AND NOT m.is_encrypted
    AND NOT (n.data ? '__enc') AND e.key=ANY(ARRAY['conversationName','stageName','routeHistory','goalStack','lastOffTrackReason','lastOffTrackAt'])
    AND NOT hadron_3501_valid(e.key,e.value);
  RAISE NOTICE 'chat_root_engine_states: % malformed legacy values retained',malformed;
END $$;
INSERT INTO chat_root_engine_states(chat_root_node_id,state,updated_at)
SELECT n.id,COALESCE((SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(n.data) e
  WHERE e.key=ANY(ARRAY['conversationName','stageName','routeHistory','goalStack','lastOffTrackReason','lastOffTrackAt'])
    AND hadron_3501_valid(e.key,e.value)),'{}'::jsonb),CURRENT_TIMESTAMP
FROM nodes n JOIN memories m ON m.id=n.memory_id
WHERE NOT m.is_encrypted AND n.node_type='record' AND n.loc ~ '^chats:[^:]+$'
  AND jsonb_typeof(n.data)='object' AND NOT(n.data ? '__enc')
  AND n.data ?| ARRAY['conversationName','stageName','routeHistory','goalStack','lastOffTrackReason','lastOffTrackAt']
ON CONFLICT DO NOTHING;
UPDATE nodes n SET data=n.data - ARRAY(SELECT key FROM jsonb_each(n.data) WHERE key=ANY(ARRAY['routeHistory','goalStack','lastOffTrackReason','lastOffTrackAt']) AND hadron_3501_valid(key,value)),
  revision_content_hash=CASE WHEN n.revision_content_hash=hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n.revision_content_hash END
FROM memories m WHERE m.id=n.memory_id AND NOT m.is_encrypted AND n.node_type='record' AND n.loc ~ '^chats:[^:]+$'
  AND jsonb_typeof(n.data)='object' AND NOT(n.data ? '__enc')
  AND EXISTS(SELECT 1 FROM jsonb_each(n.data) WHERE key=ANY(ARRAY['routeHistory','goalStack','lastOffTrackReason','lastOffTrackAt']) AND hadron_3501_valid(key,value));
DROP FUNCTION hadron_3501_valid(text,jsonb);

DROP FUNCTION hadron_3501_time(jsonb);
