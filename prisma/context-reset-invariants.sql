-- #2162 (cor:agt:050:27): a worker's context reset. Source of truth for these objects; the migration carries a
-- byte-identical copy (pinned by src/lib/contextReset/invariants.test.ts) and post-push.sql includes this file.

-- The closed phases and reasons, and the stamps each phase has. A refused or failed reset names its reason; nothing
-- else carries one. Every stamp a phase implies is set: a reset stopped the agent only after a stop grant, a grant only
-- after a registered recovery, a registration only after a claim. `epoch` never goes negative.
ALTER TABLE context_resets DROP CONSTRAINT IF EXISTS chk_context_resets_shape;
ALTER TABLE context_resets ADD CONSTRAINT chk_context_resets_shape CHECK (
  phase IN ('requested', 'claimed', 'checkpointed', 'stop-granted', 'agent-stopped', 'relaunched', 'done', 'refused', 'failed') AND
  ((phase IN ('refused', 'failed')) = (reason IS NOT NULL)) AND
  (reason IS NULL OR reason IN (
    'DIRTY_TREE', 'UNPUSHED_HEAD', 'BUSY', 'DRAFT_OR_MENU', 'TWO_AGENTS', 'SESSION_CHANGED', 'OTHER_WORK', 'UNAVAILABLE',
    'PAUSED', 'SETTING_OFF', 'NOT_IDLE', 'PROCESS_CHANGED', 'NO_RECOVERY_REF',
    'CHECKPOINT_FAILED', 'STAGING_FAILED', 'CLAIM_LAPSED', 'RELAUNCH_UNVERIFIED', 'RELAUNCH_BLOCKED', 'HOST_UNSUPPORTED',
    'HOST_LOST', 'REPORT_TIMEOUT', 'SESSION_ENDED', 'WORKER_GONE', 'CANCELLED_BY_CLEAR')) AND
  ((phase IN ('done', 'refused', 'failed')) = (ended_at IS NOT NULL)) AND
  epoch >= 0 AND
  (stop_lease_ms IS NULL OR stop_lease_ms > 0) AND
  ((stop_granted_at IS NULL) = (stop_lease_ms IS NULL)) AND
  (phase NOT IN ('claimed', 'checkpointed', 'stop-granted', 'agent-stopped', 'relaunched', 'done') OR claimed_at IS NOT NULL) AND
  (phase NOT IN ('checkpointed', 'stop-granted', 'agent-stopped', 'relaunched', 'done') OR recovery_registered_at IS NOT NULL) AND
  (phase NOT IN ('stop-granted', 'agent-stopped', 'relaunched', 'done') OR stop_granted_at IS NOT NULL) AND
  (phase NOT IN ('agent-stopped', 'relaunched', 'done') OR agent_stopped_at IS NOT NULL) AND
  (phase NOT IN ('relaunched', 'done') OR relaunched_at IS NOT NULL) AND
  ((recovery_ref IS NULL) = (recovery_registered_at IS NULL)) AND
  (agent_stopped_at IS NULL OR stop_granted_at IS NOT NULL) AND
  (stop_granted_at IS NULL OR recovery_registered_at IS NOT NULL) AND
  (recovery_registered_at IS NULL OR claimed_at IS NOT NULL) AND
  -- A reset no host could take was never issued, and one issued names its operation.
  ((host_operation_id IS NULL) = (host_id IS NULL)) AND
  (host_id IS NOT NULL OR (phase = 'failed' AND reason = 'HOST_UNSUPPORTED'))
);

-- A reset is for a worker of its own App.
CREATE OR REPLACE FUNCTION context_reset_same_app() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers w WHERE w.id = NEW.worker_id AND w.app_id = NEW.app_id) THEN
    RAISE EXCEPTION 'context_resets: worker % is not in the reset''s App', NEW.worker_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_context_resets_same_app';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_context_resets_same_app ON context_resets;
CREATE TRIGGER trg_context_resets_same_app
  BEFORE INSERT ON context_resets
  FOR EACH ROW EXECUTE FUNCTION context_reset_same_app();

-- What was requested never changes, a phase only moves forward, and an ended reset stays ended. The epoch never moves
-- back. Rows are removed only with their App or worker (the cascades).
CREATE OR REPLACE FUNCTION context_reset_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rank_old int;
  rank_new int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM apps WHERE id = OLD.app_id) AND EXISTS (SELECT 1 FROM workers WHERE id = OLD.worker_id) THEN
      RAISE EXCEPTION 'A context reset is kept as the record of what was requested' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.app_id, NEW.worker_id, NEW.session_id, NEW.task_id, NEW.host_id, NEW.host_operation_id, NEW.requested_at)
     IS DISTINCT FROM
     (OLD.id, OLD.app_id, OLD.worker_id, OLD.session_id, OLD.task_id, OLD.host_id, OLD.host_operation_id, OLD.requested_at) THEN
    RAISE EXCEPTION 'A context reset''s worker, session, task, host and operation never change' USING ERRCODE = '23514';
  END IF;
  IF OLD.ended_at IS NOT NULL AND (NEW.phase, NEW.reason, NEW.ended_at) IS DISTINCT FROM (OLD.phase, OLD.reason, OLD.ended_at) THEN
    RAISE EXCEPTION 'An ended context reset never moves again' USING ERRCODE = '23514';
  END IF;
  IF NEW.epoch < OLD.epoch THEN
    RAISE EXCEPTION 'A context reset''s epoch never moves back' USING ERRCODE = '23514';
  END IF;
  rank_old := array_position(ARRAY['requested', 'claimed', 'checkpointed', 'stop-granted', 'agent-stopped', 'relaunched', 'done'], OLD.phase);
  rank_new := array_position(ARRAY['requested', 'claimed', 'checkpointed', 'stop-granted', 'agent-stopped', 'relaunched', 'done'], NEW.phase);
  IF rank_old IS NOT NULL AND rank_new IS NOT NULL AND rank_new < rank_old THEN
    RAISE EXCEPTION 'A context reset''s phase only moves forward (was %, now %)', OLD.phase, NEW.phase USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_context_resets_forward_only ON context_resets;
CREATE TRIGGER trg_context_resets_forward_only
  BEFORE UPDATE OR DELETE ON context_resets
  FOR EACH ROW EXECUTE FUNCTION context_reset_forward_only();

-- cor:agt:070:01 (Proposed) — a host declares only capability-gated operation types it performs.
ALTER TABLE host_registrations DROP CONSTRAINT IF EXISTS chk_host_registrations_capabilities;
ALTER TABLE host_registrations ADD CONSTRAINT chk_host_registrations_capabilities CHECK (
  capabilities <@ ARRAY['worker.reset-context']::text[]
);
