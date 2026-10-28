-- Internal MVCC fence only; no public entity or authored reference.
CREATE TABLE IF NOT EXISTS worker_reference_fences (
  subject_id text PRIMARY KEY,
  version bigint NOT NULL DEFAULT 0
);

-- #1162 / cor:dmo:050:11. New references only; no scan, rewrite or backfill
-- of existing dangling attribution. Static typed-path inventory below is shared
-- with post-push and migration; arbitrary JSON/text is not interpreted.
CREATE OR REPLACE FUNCTION worker_reference_targets_1162(row_data jsonb, paths text[])
RETURNS TABLE(kind text, ref text) LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE spec text; value jsonb; identity text;
BEGIN
  FOREACH spec IN ARRAY paths LOOP
    FOR value IN SELECT jsonb_path_query(row_data, substring(spec FROM 3)::jsonpath) LOOP
      IF jsonb_typeof(value) <> 'string' THEN CONTINUE; END IF;
      identity := value #>> '{}';
      IF left(spec, 1) = 'k' THEN
        IF left(identity, 2) <> 'w:' THEN CONTINUE; END IF;
        identity := substring(identity FROM 3);
      END IF;
      IF identity <> '' THEN
        kind := CASE WHEN left(spec,1) = 'k' THEN 'w' ELSE left(spec,1) END;
        ref := identity;
        RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- AFTER row triggers deliberately run only on the winning upsert arm: an
-- INSERT ... ON CONFLICT update retaining a legacy dangling stamp stays legal.
-- Exceptions still roll back the entire statement and its surrounding writes.
CREATE OR REPLACE FUNCTION worker_reference_fence_1162()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous jsonb := '{}'::jsonb; target record; worker_ref text; worker_refs text[] := ARRAY[]::text[];
BEGIN
  IF TG_OP = 'UPDATE' THEN previous := to_jsonb(OLD); END IF;
  -- Compare identity sets, not whole rows. Retaining an old dangling stamp is
  -- legal, including while importing/updating other fields on a legacy row.
  FOR target IN
    SELECT DISTINCT n.kind, n.ref FROM worker_reference_targets_1162(to_jsonb(NEW), TG_ARGV) n
    EXCEPT SELECT o.kind, o.ref FROM worker_reference_targets_1162(previous, TG_ARGV) o
    ORDER BY 1, 2
  LOOP
    worker_ref := target.ref;
    IF target.kind = 'm' THEN
      SELECT id INTO worker_ref FROM workers WHERE memory_id = target.ref;
      -- A regular memory has no Worker. Its own FK still fences memory deletion.
      IF NOT FOUND THEN CONTINUE; END IF;
    ELSIF target.kind = 's' THEN
      SELECT worker_id INTO worker_ref FROM sessions WHERE id = target.ref FOR KEY SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'WORKER_REFERENCE_NOT_FOUND ref=% kind=session writer=%',
          encode(convert_to(target.ref, 'UTF8'), 'hex'), TG_TABLE_NAME USING ERRCODE = 'P1162';
      END IF;
      IF worker_ref IS NULL THEN CONTINUE; END IF;
    END IF;
    worker_refs := array_append(worker_refs, worker_ref);
  END LOOP;
  -- Direct, session-derived and working-memory references share one sorted
  -- order even when a row names several Workers in different forms.
  FOR worker_ref IN SELECT DISTINCT unnest(worker_refs) ORDER BY 1 LOOP
    -- A dedicated tuple avoids introducing Worker-row locks into graph,
    -- session and host write protocols. An UPSERT changes MVCC state even for
    -- the first reference. Deletion takes the same tuple after its Worker lock.
    INSERT INTO worker_reference_fences(subject_id) VALUES (worker_ref)
      ON CONFLICT (subject_id) DO UPDATE SET version = worker_reference_fences.version + 1;
    IF NOT EXISTS (SELECT 1 FROM workers WHERE id = worker_ref) THEN
      RAISE EXCEPTION 'WORKER_REFERENCE_NOT_FOUND ref=% kind=worker writer=%',
        encode(convert_to(worker_ref, 'UTF8'), 'hex'), TG_TABLE_NAME USING ERRCODE = 'P1162';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "agent_tasks";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "agent_tasks"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.owner_worker_id', 'w:$.assignee_worker_id', 'w:$.assigned_by_worker_id', 'w:$.created_by_worker_id', 'w:$.updated_by_worker_id', 'w:$.requirements.excludeWorkerIds[*]');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "agent_team_events";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "agent_team_events"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.actor_worker_id', 'w:$.subject_worker_id', 'w:$.acknowledged_by_worker_id', 'w:$.chain[*].workerId', 'w:$.payload.owner.workerId', 'w:$.payload.assignee.workerId', 'w:$.payload.from.workerId', 'w:$.payload.to.workerId');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "app_grants";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "app_grants"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.grantee_worker_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "app_log";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "app_log"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('s:$.session_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "app_wake_reservations";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "app_wake_reservations"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "assets";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "assets"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('m:$.memory_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "channel_read_states";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "channel_read_states"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "comment_meta";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "comment_meta"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('k:$.author_key', 'k:$.retracted_by', 'k:$.resolved_by', 'k:$.thread_deleted_by');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "edges";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "edges"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('m:$.memory_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "host_operations";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "host_operations"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id', 'w:$.issued_by_worker_id', 'w:$.args.workerId', 's:$.args.sessionId');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "host_registration_workers";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "host_registration_workers"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "launch_grants";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "launch_grants"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id', 's:$.session_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "model_family_availability";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "model_family_availability"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.set_by_worker_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "node_revisions";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "node_revisions"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.edited_by_worker_id', 'w:$.data.authorWorkerId', 's:$.data.sessionId', 'w:$.properties.workerId', 's:$.properties.sessionId', 'w:$.data.askedBy.workerId', 'w:$.data.parts[*].recommendation.by.workerId', 'w:$.data.withdrawn.by.workerId', 'w:$.data.lastAction.by.workerId');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "nodes";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "nodes"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.created_by_worker_id', 'w:$.updated_by_worker_id', 'w:$.data.authorWorkerId', 's:$.data.sessionId', 'w:$.properties.workerId', 's:$.properties.sessionId', 'm:$.memory_id', 'w:$.data.askedBy.workerId', 'w:$.data.parts[*].recommendation.by.workerId', 'w:$.data.withdrawn.by.workerId', 'w:$.data.lastAction.by.workerId');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "register_entries";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "register_entries"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.attendee_worker_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "resume_claims";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "resume_claims"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('s:$.session_id', 'w:$.worker_id', 's:$.resumed_session_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "sessions";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id', 's:$.parent_session_id', 's:$.prev_session_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "signing_requests";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "signing_requests"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.requester_worker_id', 's:$.requester_session_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "task_session_end_requests";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "task_session_end_requests"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id', 's:$.session_id', 'w:$.requested_by_worker_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "ticker_subscriptions";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "ticker_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id', 'w:$.created_by_worker_id', 'w:$.ended_by_worker_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "tickers";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "tickers"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.owner_worker_id', 'w:$.created_by_worker_id', 'w:$.updated_by_worker_id', 'w:$.deleted_by_worker_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "usage_events";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "usage_events"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('s:$.session_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "worker_availability";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "worker_availability"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id', 'w:$.set_by_worker_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "worker_delivery_channels";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "worker_delivery_channels"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id', 'w:$.acked_by_worker_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "worker_delivery_task_events";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "worker_delivery_task_events"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id', 'w:$.acked_by_worker_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "worker_delivery_ticks";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "worker_delivery_ticks"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id', 'w:$.acked_by_worker_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "worker_wake_settings";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "worker_wake_settings"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id', 'w:$.updated_by_worker_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "workers";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "workers"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.reports_to_worker_id');

-- Retain the coordination tuple after Worker deletion. A REPEATABLE READ
-- writer may still see the old Worker snapshot: it must collide with this
-- newer tuple and abort, rather than recreate a removed fence and commit a
-- dangling reference. These tiny tombstones are internal, never attribution.
-- Drop an older installation's cleanup trigger when post-push re-applies.
DROP TRIGGER IF EXISTS worker_reference_fence_cleanup_1162 ON workers;
DROP FUNCTION IF EXISTS worker_reference_fence_cleanup_1162();

-- #2072: the wake receipt joins the closed #1162 fence inventory (worker_id and its no-FK attribution).
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "worker_wake_acks";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "worker_wake_acks"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id', 'w:$.acked_by_worker_id');

-- #2022: the stop signals' target worker and the coverage ledger's worker join the closed #1162 fence inventory.
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "team_stop_signals";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "team_stop_signals"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.target_worker_id');
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "team_stop_coverage";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "team_stop_coverage"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id');
-- #2046: a compiled boot-prompt revision's target worker joins the closed #1162 fence inventory.
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "compiled_prompt_revisions";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "compiled_prompt_revisions"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.target_worker_id');
-- #2162: a context reset's worker and session join the closed #1162 fence inventory.
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "context_resets";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "context_resets"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id', 's:$.session_id');
-- #2024 (S8): a generated ticker's worker joins the closed #1162 fence inventory (generated_for_worker_id, no FK).
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "tickers";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "tickers"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.owner_worker_id', 'w:$.generated_for_worker_id', 'w:$.created_by_worker_id', 'w:$.updated_by_worker_id', 'w:$.deleted_by_worker_id');
