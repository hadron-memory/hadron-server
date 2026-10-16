-- #992 / cor:agt:020:04. All installation is atomic; a collision refuses
-- BEFORE any persistent schema/key change. Never repair/renumber here.
BEGIN;
LOCK TABLE nodes, memories, apps, workers IN SHARE ROW EXCLUSIVE MODE;
CREATE OR REPLACE VIEW hadron_team_chat_seq_candidates AS
-- BEGIN CANONICAL CLASSIFIER
-- #992 canonical classifier: mirrors locateTeamChatRoot's team-space shape,
-- but retains all historical roots/messages (including soft-deleted owners).
-- No envelope test: encrypted envelopes and unstamped imports are eligible.
SELECT n.id AS node_id, r.id AS root_id, n.memory_id, n.loc, n.seq,
       n.deleted_at, m.urn AS memory_urn
FROM nodes n
JOIN nodes r ON r.memory_id = n.memory_id AND r.loc = 'chats:team' AND r.node_type = 'chat'
JOIN memories m ON m.id = n.memory_id
JOIN apps a ON a.id = m.app_id
WHERE m.class = 'app' AND m.user_memory_of_agent_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM workers w WHERE w.memory_id = m.id)
  AND (m.owner_user_id IS NULL OR m.owner_user_id = a.owner_user_id)
  AND starts_with(n.loc, r.loc || ':messages:')
  AND n.node_type = 'chat-message' AND n.seq IS NOT NULL;
-- END CANONICAL CLASSIFIER
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM hadron_team_chat_seq_candidates GROUP BY root_id, seq HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'TEAM_CHAT_SEQ_COLLISIONS: run the read-only team-chat-seq-preflight and obtain an authorized repair before retrying'
      USING ERRCODE = 'P0993';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS team_chat_sequence_scopes (
  memory_id text PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE ON UPDATE CASCADE,
  version bigint NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS team_chat_sequence_keys (
  node_id text PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE ON UPDATE CASCADE,
  root_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE ON UPDATE CASCADE,
  seq integer NOT NULL,
  CONSTRAINT team_chat_sequence_root_seq_key UNIQUE(root_id, seq)
);
-- No keys are imported from a caller-controlled projection.
INSERT INTO team_chat_sequence_scopes(memory_id) SELECT id FROM memories ON CONFLICT DO NOTHING;
INSERT INTO team_chat_sequence_keys(node_id, root_id, seq)
  SELECT node_id, root_id, seq FROM hadron_team_chat_seq_candidates
  ON CONFLICT (node_id) DO UPDATE SET root_id = excluded.root_id, seq = excluded.seq;

-- The fence is an actual row-version write, NOT just an advisory wait. That
-- preserves the invariant for REPEATABLE READ and SERIALIZABLE snapshots too.
CREATE OR REPLACE FUNCTION hadron_team_chat_seq_fence(mid text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF mid IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM memories WHERE id = mid) THEN
    RAISE EXCEPTION 'Team chat membership snapshot is stale' USING ERRCODE = '40001';
  END IF;
  INSERT INTO team_chat_sequence_scopes(memory_id) VALUES(mid) ON CONFLICT DO NOTHING;
  UPDATE team_chat_sequence_scopes SET version = version + 1 WHERE memory_id = mid;
END $$;

CREATE OR REPLACE FUNCTION hadron_team_chat_seq_refresh(mid text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM team_chat_sequence_keys k USING nodes n WHERE k.node_id = n.id AND n.memory_id = mid;
  INSERT INTO team_chat_sequence_keys(node_id, root_id, seq)
    SELECT node_id, root_id, seq FROM hadron_team_chat_seq_candidates WHERE memory_id = mid;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'TEAM_CHAT_SEQ_CONFLICT' USING ERRCODE = 'P0992';
END $$;

-- BEFORE locks the classification; AFTER reflects the final row state. The
-- common message path updates ONE key. Root/membership transitions rebuild
-- only their memory's keys and refuse an imported collision atomically.
CREATE OR REPLACE FUNCTION hadron_team_chat_seq_node() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mids text[]; mid text; root_change boolean;
BEGIN
  mids := ARRAY[]::text[]; root_change := false;
  IF TG_OP <> 'INSERT' AND (OLD.loc = 'chats:team' OR starts_with(OLD.loc, 'chats:team:messages:')) THEN
    mids := array_append(mids, OLD.memory_id);
    root_change := OLD.loc = 'chats:team';
  END IF;
  IF TG_OP <> 'DELETE' AND (NEW.loc = 'chats:team' OR starts_with(NEW.loc, 'chats:team:messages:')) THEN
    mids := array_append(mids, NEW.memory_id);
    root_change := root_change OR NEW.loc = 'chats:team';
  END IF;
  IF cardinality(mids) = 0 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_WHEN = 'BEFORE' THEN
    FOR mid IN SELECT DISTINCT x FROM unnest(mids) x ORDER BY x LOOP
      IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM memories WHERE id = mid) THEN CONTINUE; END IF;
      PERFORM hadron_team_chat_seq_fence(mid);
    END LOOP;
  ELSE
    IF root_change THEN
      FOR mid IN SELECT DISTINCT x FROM unnest(mids) x ORDER BY x LOOP
        PERFORM hadron_team_chat_seq_refresh(mid);
      END LOOP;
    ELSE
      IF TG_OP <> 'INSERT' THEN DELETE FROM team_chat_sequence_keys WHERE node_id = OLD.id; END IF;
      IF TG_OP <> 'DELETE' THEN
        INSERT INTO team_chat_sequence_keys(node_id, root_id, seq)
          SELECT node_id, root_id, seq FROM hadron_team_chat_seq_candidates WHERE node_id = NEW.id;
      END IF;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'TEAM_CHAT_SEQ_CONFLICT' USING ERRCODE = 'P0992';
END $$;
DROP TRIGGER IF EXISTS team_chat_seq_node_before ON nodes;
DROP TRIGGER IF EXISTS team_chat_seq_node_after ON nodes;
CREATE TRIGGER team_chat_seq_node_before BEFORE INSERT OR UPDATE OF memory_id, loc, node_type, seq OR DELETE ON nodes
  FOR EACH ROW EXECUTE FUNCTION hadron_team_chat_seq_node();
CREATE TRIGGER team_chat_seq_node_after AFTER INSERT OR UPDATE OF memory_id, loc, node_type, seq OR DELETE ON nodes
  FOR EACH ROW EXECUTE FUNCTION hadron_team_chat_seq_node();

CREATE OR REPLACE FUNCTION hadron_team_chat_seq_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mids text[]; mid text;
BEGIN
  IF TG_TABLE_NAME = 'memories' THEN
    mids := ARRAY[NEW.id];
  ELSIF TG_TABLE_NAME = 'workers' THEN
    mids := ARRAY[]::text[];
    IF TG_OP <> 'INSERT' THEN mids := array_append(mids, OLD.memory_id); END IF;
    IF TG_OP <> 'DELETE' THEN mids := array_append(mids, NEW.memory_id); END IF;
  ELSE
    SELECT array_agg(id ORDER BY id) INTO mids FROM memories WHERE app_id = NEW.id;
  END IF;
  FOR mid IN SELECT DISTINCT x FROM unnest(mids) x WHERE x IS NOT NULL ORDER BY x LOOP
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM memories WHERE id = mid) THEN CONTINUE; END IF;
    IF TG_WHEN = 'BEFORE' THEN PERFORM hadron_team_chat_seq_fence(mid);
    ELSE PERFORM hadron_team_chat_seq_refresh(mid); END IF;
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS team_chat_seq_memory_before ON memories;
DROP TRIGGER IF EXISTS team_chat_seq_memory_after ON memories;
CREATE TRIGGER team_chat_seq_memory_before BEFORE UPDATE OF class, app_id, user_memory_of_agent_id, owner_user_id ON memories
  FOR EACH ROW EXECUTE FUNCTION hadron_team_chat_seq_membership();
CREATE TRIGGER team_chat_seq_memory_after AFTER UPDATE OF class, app_id, user_memory_of_agent_id, owner_user_id ON memories
  FOR EACH ROW EXECUTE FUNCTION hadron_team_chat_seq_membership();
DROP TRIGGER IF EXISTS team_chat_seq_worker_before ON workers;
DROP TRIGGER IF EXISTS team_chat_seq_worker_after ON workers;
CREATE TRIGGER team_chat_seq_worker_before BEFORE INSERT OR UPDATE OF memory_id OR DELETE ON workers
  FOR EACH ROW EXECUTE FUNCTION hadron_team_chat_seq_membership();
CREATE TRIGGER team_chat_seq_worker_after AFTER INSERT OR UPDATE OF memory_id OR DELETE ON workers
  FOR EACH ROW EXECUTE FUNCTION hadron_team_chat_seq_membership();
DROP TRIGGER IF EXISTS team_chat_seq_app_before ON apps;
DROP TRIGGER IF EXISTS team_chat_seq_app_after ON apps;
CREATE TRIGGER team_chat_seq_app_before BEFORE UPDATE OF owner_user_id ON apps
  FOR EACH ROW EXECUTE FUNCTION hadron_team_chat_seq_membership();
CREATE TRIGGER team_chat_seq_app_after AFTER UPDATE OF owner_user_id ON apps
  FOR EACH ROW EXECUTE FUNCTION hadron_team_chat_seq_membership();
COMMIT;
