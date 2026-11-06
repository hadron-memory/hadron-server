-- #3501 / rulings0202,0209: encrypted operational state; no plaintext exception.
CREATE TABLE IF NOT EXISTS chat_root_engine_states (
  chat_root_node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE ON UPDATE CASCADE,
  state JSONB NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL
);
-- Total validator: tenant JSON is untrusted. Invalid values stay in legacy data.
CREATE OR REPLACE FUNCTION hadron_3501_time(v jsonb) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE parts text[]; y int; mon int; d int; h int; mi int; sec int; maxday int; zone text;
BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  parts := regexp_match(v #>> '{}', '^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(:([0-9]{2})([.][0-9]+)?)?([Zz]|[+-][0-9]{2}:?[0-9]{2})?$');
  IF parts IS NULL THEN RETURN false; END IF;
  y:=parts[1]::int; mon:=parts[2]::int; d:=parts[3]::int; h:=parts[4]::int; mi:=parts[5]::int; sec:=COALESCE(parts[7],'0')::int;
  IF mon<1 OR mon>12 OR d<1 OR h>24 OR mi>59 OR sec>59 THEN RETURN false; END IF;
  maxday := (ARRAY[31,CASE WHEN y%4=0 AND (y%100<>0 OR y%400=0) THEN 29 ELSE 28 END,31,30,31,30,31,31,30,31,30,31])[mon];
  IF d>maxday OR (h=24 AND (mi<>0 OR sec<>0 OR COALESCE(parts[8],'') ~ '[1-9]')) THEN RETURN false; END IF;
  zone:=parts[9];
  IF zone IS NOT NULL AND zone NOT IN ('Z','z') THEN
    zone:=replace(substr(zone,2),':','');
    IF substr(zone,1,2)::int>23 OR substr(zone,3,2)::int>59 THEN RETURN false; END IF;
  END IF;
  RETURN true;
END $$;
CREATE OR REPLACE FUNCTION hadron_3501_valid(k text,v jsonb) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  IF k IN ('conversationName','stageName') THEN RETURN jsonb_typeof(v)='string' AND length(btrim(v #>> '{}', E' \t\n\r\f' || chr(11) || U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))>0; END IF;
  IF k='lastOffTrackReason' THEN RETURN jsonb_typeof(v)='string'; END IF;
  IF k='lastOffTrackAt' THEN RETURN hadron_3501_time(v); END IF;
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
        WHERE (field.key=ANY(ARRAY['nodeUrn','topicUrn','conversationUrn','edgeUrn']) OR (k='goalStack' AND field.key='language')) AND jsonb_typeof(field.value)<>'string'),false));
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
    AND hadron_3501_valid(e.key,e.value)),'{}'::jsonb),CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
FROM nodes n JOIN memories m ON m.id=n.memory_id
WHERE NOT m.is_encrypted AND n.node_type='record' AND n.loc ~ '^chats:[^:]+$'
  AND jsonb_typeof(n.data)='object' AND NOT(n.data ? '__enc')
  AND n.data ?| ARRAY['conversationName','stageName','routeHistory','goalStack','lastOffTrackReason','lastOffTrackAt']
ON CONFLICT DO NOTHING;
UPDATE nodes n SET data=n.data - ARRAY(SELECT key FROM jsonb_each(n.data) WHERE key=ANY(ARRAY['routeHistory','goalStack','lastOffTrackReason','lastOffTrackAt']) AND hadron_3501_valid(key,value) AND EXISTS(SELECT 1 FROM chat_root_engine_states es WHERE es.chat_root_node_id=n.id AND es.state ? key)),
  revision_content_hash=CASE WHEN n.revision_content_hash=hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n.revision_content_hash END
FROM memories m WHERE m.id=n.memory_id AND NOT m.is_encrypted AND n.node_type='record' AND n.loc ~ '^chats:[^:]+$'
  AND jsonb_typeof(n.data)='object' AND NOT(n.data ? '__enc')
  AND EXISTS(SELECT 1 FROM jsonb_each(n.data) WHERE key=ANY(ARRAY['routeHistory','goalStack','lastOffTrackReason','lastOffTrackAt']) AND hadron_3501_valid(key,value) AND EXISTS(SELECT 1 FROM chat_root_engine_states es WHERE es.chat_root_node_id=n.id AND es.state ? key));
DROP FUNCTION hadron_3501_valid(text,jsonb);

DROP FUNCTION hadron_3501_time(jsonb);
