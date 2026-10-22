-- #2043 (S6 PR 2, §10 Rook P2-1; cor:agt:040:18) — an approval granted OUTSIDE
-- the boot-prompt approval gate ends when its node ENTERS the gated state: a
-- node in the boot-prompt role family, in an Agent's system memory or an App's
-- install memory. The approval hash covers neither role nor memory, so without
-- this a role flip, a move, or a memory becoming placed would carry an ordinary
-- writer's (or a worker session's) approval into a state only the manager, as
-- themselves, may approve. Ending clears the hash and keeps who/when/revision,
-- on the node and on every copied revision record (as #1838's
-- endApprovalsOnEncryptedEntry does), so no byte-identical revision qualifies.
--
-- The ONE source of this SQL: included verbatim by prisma/post-push.sql (dev DB,
-- test template, CI) and copied into 20261022010100_boot_prompt_approval_entry
-- (prod, which does not run post-push.sql). Change it only together with a new
-- migration that carries the new text. Idempotent.

CREATE OR REPLACE FUNCTION hadron_is_boot_prompt_role(r text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT coalesce(r = 'boot-prompt' OR r LIKE 'boot-prompt.%', false) $$;

-- Placed: an Agent's system memory, or an install memory (isInstallMemoryRow).
CREATE OR REPLACE FUNCTION hadron_boot_prompt_placed(memory text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM agents WHERE system_memory_id = memory)
      OR EXISTS (SELECT 1 FROM memories WHERE id = memory AND class = 'system' AND is_install_memory)
$$;

-- An entry: the row is a placed boot prompt now and was not one (by role or memory) before.
CREATE OR REPLACE FUNCTION hadron_boot_prompt_entered(op text, old_role text, old_memory text, new_role text, new_memory text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT hadron_is_boot_prompt_role(new_role)
     AND (op = 'INSERT' OR NOT hadron_is_boot_prompt_role(old_role) OR old_memory IS DISTINCT FROM new_memory)
     AND hadron_boot_prompt_placed(new_memory)
$$;

CREATE OR REPLACE FUNCTION hadron_end_boot_prompt_node_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.approval_hash IS NOT NULL AND hadron_boot_prompt_entered(
       TG_OP,
       CASE WHEN TG_OP = 'UPDATE' THEN OLD.role END,
       CASE WHEN TG_OP = 'UPDATE' THEN OLD.memory_id END,
       NEW.role, NEW.memory_id) THEN
    NEW.approval_hash := NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION hadron_end_boot_prompt_revision_approvals() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF hadron_boot_prompt_entered(
       TG_OP,
       CASE WHEN TG_OP = 'UPDATE' THEN OLD.role END,
       CASE WHEN TG_OP = 'UPDATE' THEN OLD.memory_id END,
       NEW.role, NEW.memory_id) THEN
    UPDATE node_revisions SET approval_hash = NULL WHERE node_id = NEW.id AND approval_hash IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS boot_prompt_approval_entry_node ON "nodes";
CREATE TRIGGER boot_prompt_approval_entry_node
  BEFORE INSERT OR UPDATE OF role, memory_id, approval_hash ON "nodes"
  FOR EACH ROW WHEN (NEW.role = 'boot-prompt' OR NEW.role LIKE 'boot-prompt.%')
  EXECUTE FUNCTION hadron_end_boot_prompt_node_approval();

DROP TRIGGER IF EXISTS boot_prompt_approval_entry_revisions ON "nodes";
CREATE TRIGGER boot_prompt_approval_entry_revisions
  AFTER INSERT OR UPDATE OF role, memory_id ON "nodes"
  FOR EACH ROW WHEN (NEW.role = 'boot-prompt' OR NEW.role LIKE 'boot-prompt.%')
  EXECUTE FUNCTION hadron_end_boot_prompt_revision_approvals();

-- A memory becoming placed with boot prompts already in it: an Agent attaching it
-- as its system memory (createAgent / updateAgent first-attach), or a memory
-- becoming an install memory.
CREATE OR REPLACE FUNCTION hadron_end_boot_prompt_approvals_in(memory text) RETURNS void
LANGUAGE sql AS $$
  UPDATE node_revisions SET approval_hash = NULL
   WHERE approval_hash IS NOT NULL
     AND node_id IN (SELECT id FROM nodes WHERE memory_id = memory AND hadron_is_boot_prompt_role(role));
  UPDATE nodes SET approval_hash = NULL
   WHERE memory_id = memory AND approval_hash IS NOT NULL AND hadron_is_boot_prompt_role(role);
$$;

CREATE OR REPLACE FUNCTION hadron_end_boot_prompt_approvals_on_agent_attach() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.system_memory_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.system_memory_id IS DISTINCT FROM NEW.system_memory_id) THEN
    PERFORM hadron_end_boot_prompt_approvals_in(NEW.system_memory_id);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS boot_prompt_approval_entry_agent ON "agents";
CREATE TRIGGER boot_prompt_approval_entry_agent
  AFTER INSERT OR UPDATE OF system_memory_id ON "agents"
  FOR EACH ROW EXECUTE FUNCTION hadron_end_boot_prompt_approvals_on_agent_attach();

CREATE OR REPLACE FUNCTION hadron_end_boot_prompt_approvals_on_install() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.class = 'system' AND NEW.is_install_memory
     AND NOT (OLD.class = 'system' AND OLD.is_install_memory) THEN
    PERFORM hadron_end_boot_prompt_approvals_in(NEW.id);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS boot_prompt_approval_entry_install ON "memories";
CREATE TRIGGER boot_prompt_approval_entry_install
  AFTER UPDATE OF class, is_install_memory ON "memories"
  FOR EACH ROW EXECUTE FUNCTION hadron_end_boot_prompt_approvals_on_install();
