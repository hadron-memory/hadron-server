-- #2047 (S10, cor:agt:040:03): the database facts Prisma's schema language cannot model for served_prompts, the
-- immutable record of what a bind, a chatbot chat or a headless run was given. Source of truth for these objects; the
-- migration carries a byte-identical copy (pinned by src/lib/bootPrompt/servedPromptInvariants.test.ts) and
-- post-push.sql includes this file.

-- Exactly one owner, and its kind says which. A bind belongs to a worker session and names the worker; a chat to its chat
-- node; a run to its run. Only a chat records again (its ordinal counts up). A worker-level pointer can only have chosen
-- a bind. The served revision is a real revision, and the provenance's owning compile revision is not above it.
ALTER TABLE served_prompts DROP CONSTRAINT IF EXISTS chk_served_prompts_shape;
ALTER TABLE served_prompts ADD CONSTRAINT chk_served_prompts_shape CHECK (
  num_nonnulls(session_id, chat_id, run_id) = 1
  AND ((kind = 'BIND') = (session_id IS NOT NULL))
  AND ((kind = 'CHAT') = (chat_id IS NOT NULL))
  AND ((kind = 'RUN') = (run_id IS NOT NULL))
  AND ((kind = 'BIND') = (worker_id IS NOT NULL))
  AND ordinal >= 1
  AND (kind = 'CHAT' OR ordinal = 1)
  AND (pointer_level <> 'WORKER' OR kind = 'BIND')
  AND served_rev_seq > 0
  AND provenance_rev_seq > 0
  AND provenance_rev_seq <= served_rev_seq
  AND jsonb_typeof(provenance) = 'array'
  AND jsonb_typeof(variables) = 'object'
);

-- One record per bind and per run (a retry or resume finds the original), and one per chat ordinal.
CREATE UNIQUE INDEX IF NOT EXISTS served_prompts_session_uniq ON served_prompts (session_id) WHERE session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS served_prompts_run_uniq ON served_prompts (run_id) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS served_prompts_chat_ordinal_uniq ON served_prompts (chat_id, ordinal) WHERE chat_id IS NOT NULL;

-- Owner consistency. A record's App, Agent and worker must be its owner's own, so a record cannot be filed under a
-- session or run of another tenant. The composite targets are unique trivially (id is the primary key); they exist so
-- the foreign keys can name them. Owner deletion cascades; nothing else may delete a record (the trigger below).
CREATE UNIQUE INDEX IF NOT EXISTS sessions_served_prompt_owner_uniq ON sessions (id, app_id, agent_id, worker_id);
CREATE UNIQUE INDEX IF NOT EXISTS app_runs_served_prompt_owner_uniq ON app_runs (id, app_id, agent_id);

ALTER TABLE served_prompts DROP CONSTRAINT IF EXISTS served_prompts_session_owner_fkey;
ALTER TABLE served_prompts ADD CONSTRAINT served_prompts_session_owner_fkey
  FOREIGN KEY (session_id, app_id, agent_id, worker_id) REFERENCES sessions (id, app_id, agent_id, worker_id) ON DELETE CASCADE;
ALTER TABLE served_prompts DROP CONSTRAINT IF EXISTS served_prompts_run_owner_fkey;
ALTER TABLE served_prompts ADD CONSTRAINT served_prompts_run_owner_fkey
  FOREIGN KEY (run_id, app_id, agent_id) REFERENCES app_runs (id, app_id, agent_id) ON DELETE CASCADE;
ALTER TABLE served_prompts DROP CONSTRAINT IF EXISTS served_prompts_chat_fkey;
ALTER TABLE served_prompts ADD CONSTRAINT served_prompts_chat_fkey
  FOREIGN KEY (chat_id) REFERENCES nodes (id) ON DELETE CASCADE;

-- Immutable. No update, ever. A delete is allowed only once the record's OWNER row is gone, which is exactly what an
-- ON DELETE CASCADE looks like from here (the child delete runs after the parent row is deleted). A direct delete, or a
-- delete issued by any unrelated nested trigger while the owner still exists, is refused. TRUNCATE is refused too.
CREATE OR REPLACE FUNCTION hadron_served_prompt_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'served_prompts is immutable';
  END IF;
  IF (OLD.session_id IS NOT NULL AND EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id))
     OR (OLD.run_id IS NOT NULL AND EXISTS (SELECT 1 FROM app_runs WHERE id = OLD.run_id))
     OR (OLD.chat_id IS NOT NULL AND EXISTS (SELECT 1 FROM nodes WHERE id = OLD.chat_id)) THEN
    RAISE EXCEPTION 'served_prompts rows go only with their owner';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS served_prompts_guard ON served_prompts;
CREATE TRIGGER served_prompts_guard
  BEFORE UPDATE OR DELETE ON served_prompts
  FOR EACH ROW EXECUTE FUNCTION hadron_served_prompt_guard();

CREATE OR REPLACE FUNCTION hadron_served_prompt_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'served_prompts cannot be truncated';
END $$;
DROP TRIGGER IF EXISTS served_prompts_no_truncate ON served_prompts;
CREATE TRIGGER served_prompts_no_truncate
  BEFORE TRUNCATE ON served_prompts
  FOR EACH STATEMENT EXECUTE FUNCTION hadron_served_prompt_no_truncate();

-- #1162: the record's worker and session columns are typed Worker/session references, so they sit under the same
-- writer fence as every other one. The #1162 invariants file is closed (a shipped migration, byte-identical with its
-- source) and its migration predates this table, so the trigger is created here; the function is that file's. The
-- composite foreign keys above already guarantee the session and worker exist; this adds the typed
-- WORKER_REFERENCE_NOT_FOUND refusal and the coordination with Worker deletion.
DROP TRIGGER IF EXISTS worker_reference_fence_1162 ON "served_prompts";
CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "served_prompts"
  FOR EACH ROW EXECUTE FUNCTION worker_reference_fence_1162('w:$.worker_id', 's:$.session_id');
