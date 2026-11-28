-- #5453 PR A (Holger, 2026-11-27): Agent definition nodes are type `system`, their kind is a role.
--
-- One migration, no expand and contract (accepted by Holger: "I want the optimal solution, accepting risk of
-- migration"). It never refuses on data: no statement raises, so there is no HDPRF path either.
--
-- Renamed on 2026-11-28 by Holger's rulings (decision record sections 16 and 17): the boot-prompt family is `prompt.boot`
-- (`prompt.boot.compiled`, `prompt.boot.source`, `prompt.boot.rule`), and the node type `prompt` is retired into `system`.
--
-- Three parts, each a verbatim copy of its ONE source (pinned by src/lib/definitionNodeRolesMigration5453.test.ts):
--   1. prisma/definition-node-roles-backfill.sql        the data step (takes ACCESS EXCLUSIVE on "nodes" first)
--   2. prisma/boot-prompt-invariants.sql                the constraint swap
--   3. prisma/boot-prompt-approval-invariants.sql       the approval-entry functions and triggers, re-keyed to the
--                                                        boot-prompt kinds (the file's own text, as it is today)
-- Prisma sends this file as one batch, so all run in ONE transaction: the lock taken by part 1 is held until the
-- new CHECK is in place, and a failure of any part rolls all back.
--
-- Deploy: with or after #5452 (the opt-in read of system nodes), migration and image as one step. An image from
-- before this change does not recognise a migrated compiled prompt (it looks for the retired node type); that
-- window is accepted.

-- #5453 (Holger, 2026-11-27) — every node that defines an Agent is type `system`, and a role names its kind.
-- The data step. The ONE source of this SQL: included verbatim by prisma/post-push.sql (dev DB, test template,
-- CI), just before boot-prompt-invariants.sql, and copied into 20261128010000_definition_node_roles (prod, which
-- does not run post-push.sql), where the constraint swap follows it in the same transaction. Change it only
-- together with a new migration that carries the new text.
--
-- It NEVER refuses: there is no RAISE EXCEPTION in it, and every row class that would make the CHECK that follows
-- fail is moved first (steps 0 and 1). Idempotent: a second run finds no row to change.
--
--   0. role `prompt.boot.compiled` on a node that is NOT a compiled prompt  -> role `prompt.boot.source`
--   1. node type `compiled-boot-prompt`                                      -> `system` / `prompt.boot.compiled`
--   2. role `boot-prompt` or `boot-prompt.source`                                       -> `prompt.boot.source`; `info` -> `system`
--   3. role `boot-prompt-rule` or `boot-prompt.rule`                         -> `prompt.boot.rule`;   `info` -> `system`
--   3b. node type `prompt`                                                   -> `system`; role NULL -> `prompt`
--   4. in an Agent's system memory or an install memory, by loc, `info` and `system` rows only:
--        conversations:<c>                      role NULL -> `chatbot.conversation`, type `system`
--        conversations:<c>:<s>                  role NULL -> `chatbot.stage`,        type `system`
--        prompts:<c>:<s> and below              role NULL -> `chatbot.prompt`,       type `system`
--        boot, boot:rules, conversations, prompts, prompts:<c>   `info` -> `system`, no role set
--
-- What it does not touch, and why:
--   * A role is only ever SET where it is NULL, the bare `boot-prompt`, or `boot-prompt-rule`. Two exceptions,
--     both forced by the compiled mark moving to the role: step 0 (before this change any writer could put
--     `prompt.boot.compiled` on an ordinary node, where it meant nothing; left alone, that node would become a
--     compiled prompt no compile wrote), and step 1 (a compiled node keeps being one whatever family role it had).
--   * A node type other than `info` on a source, a rule or a script node is somebody's choice and is kept; only
--     the default `info` becomes `system`. `comment`, `chat-message` and `record` rows are never retyped, and no
--     statement that names `node_type` can select a comment (the comment trigger fires on `UPDATE OF node_type`).
--   * `node_revisions` is history and stays as captured. A restore maps an old capture forward in code
--     (`modernBootPromptKind`, src/lib/bootPrompt.ts), so no restore brings the retired type or the bare role back.
--   * Approval, signatures, the `compiled-from` edge and the three pointers. Approval and signature hashes cover
--     the title, abstract and content, never the type or the role. Step 3 moves a rule INTO the boot-prompt
--     family, which the approval-entry triggers (boot-prompt-approval-invariants.sql) answer by clearing the
--     approval hash of the node and of its revisions. Step 3 remembers those hashes and puts them back, so a rule
--     keeps the approval it had (a source that includes it with `approved` keeps compiling). From then on only
--     whoever manages its Agent or App approves a rule. No trigger is disabled and no DDL runs in this block.
--   * `revision_content_hash` covers `node_type` and `role`. A row whose stored hash matched its state is given
--     the refresh marker, so the read-time reconcile does not see this as a change made outside a revisioned
--     writer (which would cut a new revision past the approved one). A row that had already drifted is left
--     drifted (the #3523 rule).
--
-- Soft-deleted rows are included, so an undelete brings back today's kind. Encrypted memories are included:
-- `node_type`, `role` and `loc` are plaintext columns, and no content is read or written here.
--
-- One DO block, so it is atomic wherever it runs (psql runs post-push.sql statement by statement). It takes
-- ACCESS EXCLUSIVE on `nodes` FIRST: the constraint swap needs that lock anyway, and taking it after the row
-- locks of the updates would be a lock upgrade that can deadlock against a concurrent writer.
DO $definition_node_roles$
DECLARE
  moved bigint;
  total bigint := 0;
  rule_approvals jsonb;
  rule_revision_approvals jsonb;
BEGIN
  LOCK TABLE "nodes" IN ACCESS EXCLUSIVE MODE;

  -- 0. A compiled ROLE on a node that no compile wrote. Role only: `node_type` is not named, so the comment
  --    trigger cannot fire, whatever the row is.
  UPDATE "nodes" n SET
    "role" = 'prompt.boot.source',
    "revision_content_hash" = CASE WHEN n."revision_content_hash" = hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n."revision_content_hash" END
  WHERE n."role" = 'prompt.boot.compiled' AND n."node_type" NOT IN ('compiled-boot-prompt', 'system');
  GET DIAGNOSTICS moved = ROW_COUNT; total := total + moved;
  -- The same role on a `system` node. On a database that has NOT been migrated yet the compile still writes the
  -- retired type, so a `system` row that carries the compiled role was written by a generic door: a source too.
  -- "Not migrated yet" is read off the old CHECK, which the constraint swap that follows this block removes; once it
  -- is gone, `system` / `prompt.boot.compiled` is exactly what a compile writes and this statement must not run
  -- again (post-push.sql runs this block on every dev setup).
  IF EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = '"nodes"'::regclass AND c.conname = 'chk_nodes_compiled_boot_prompt_role') THEN
    UPDATE "nodes" n SET
      "role" = 'prompt.boot.source',
      "revision_content_hash" = CASE WHEN n."revision_content_hash" = hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n."revision_content_hash" END
    WHERE n."role" = 'prompt.boot.compiled' AND n."node_type" = 'system';
    GET DIAGNOSTICS moved = ROW_COUNT; total := total + moved;
  END IF;

  -- 1. The compiled prompt: the retired type becomes `system`, and the role carries the mark.
  UPDATE "nodes" n SET
    "node_type" = 'system',
    "role" = 'prompt.boot.compiled',
    "revision_content_hash" = CASE WHEN n."revision_content_hash" = hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n."revision_content_hash" END
  WHERE n."node_type" = 'compiled-boot-prompt';
  GET DIAGNOSTICS moved = ROW_COUNT; total := total + moved;

  -- 2. The source: the bare role becomes the source leaf (step 1 left no compiled row under the bare role).
  UPDATE "nodes" n SET
    "role" = 'prompt.boot.source',
    "revision_content_hash" = CASE WHEN n."revision_content_hash" = hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n."revision_content_hash" END
  WHERE n."role" IN ('boot-prompt', 'boot-prompt.source');
  GET DIAGNOSTICS moved = ROW_COUNT; total := total + moved;
  UPDATE "nodes" n SET
    "node_type" = 'system',
    "revision_content_hash" = CASE WHEN n."revision_content_hash" = hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n."revision_content_hash" END
  WHERE n."role" = 'prompt.boot.source' AND n."node_type" = 'info';
  GET DIAGNOSTICS moved = ROW_COUNT; total := total + moved;

  -- 3. The rule joins the family. In a placed memory the approval-entry triggers clear the approval hash of the
  --    node and of its revisions as it enters; both are remembered first and put back after. The second write
  --    cannot clear again: the node is already in the family, so it is no longer an entry.
  SELECT coalesce(jsonb_object_agg(n."id", n."approval_hash"), '{}'::jsonb) INTO rule_approvals
    FROM "nodes" n WHERE n."role" IN ('boot-prompt-rule', 'boot-prompt.rule') AND n."approval_hash" IS NOT NULL;
  SELECT coalesce(jsonb_object_agg(r."id", r."approval_hash"), '{}'::jsonb) INTO rule_revision_approvals
    FROM "node_revisions" r JOIN "nodes" n ON n."id" = r."node_id"
   WHERE n."role" IN ('boot-prompt-rule', 'boot-prompt.rule') AND r."approval_hash" IS NOT NULL;
  UPDATE "nodes" n SET
    "role" = 'prompt.boot.rule',
    "revision_content_hash" = CASE WHEN n."revision_content_hash" = hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n."revision_content_hash" END
  WHERE n."role" IN ('boot-prompt-rule', 'boot-prompt.rule');
  GET DIAGNOSTICS moved = ROW_COUNT; total := total + moved;
  UPDATE "nodes" n SET "approval_hash" = rule_approvals ->> n."id"
   WHERE rule_approvals ? n."id" AND n."approval_hash" IS NULL;
  UPDATE "node_revisions" r SET "approval_hash" = rule_revision_approvals ->> r."id"
   WHERE rule_revision_approvals ? r."id" AND r."approval_hash" IS NULL;
  UPDATE "nodes" n SET
    "node_type" = 'system',
    "revision_content_hash" = CASE WHEN n."revision_content_hash" = hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n."revision_content_hash" END
  WHERE n."role" = 'prompt.boot.rule' AND n."node_type" = 'info';
  GET DIAGNOSTICS moved = ROW_COUNT; total := total + moved;

  -- 3b. The retired node type `prompt`: such a node is type `system`; a node with no role gets the bare role `prompt`
  --     (an ordinary instruction node, outside `prompt.boot`), and a role it already carries is kept.
  UPDATE "nodes" n SET
    "node_type" = 'system',
    "role" = coalesce(n."role", 'prompt'),
    "revision_content_hash" = CASE WHEN n."revision_content_hash" = hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n."revision_content_hash" END
  WHERE n."node_type" = 'prompt';
  GET DIAGNOSTICS moved = ROW_COUNT; total := total + moved;

  -- 4. By loc, in an Agent's system memory or an install memory (the placement of boot-prompt-approval-invariants.sql).
  --    A script node gets its role where it has none; a node that already carries a chatbot role is only retyped;
  --    a node with any other role of its own is left entirely alone. A parent is retyped and gets no role.
  UPDATE "nodes" n SET
    "node_type" = 'system',
    "role" = CASE
      WHEN n."role" IS NOT NULL THEN n."role"
      WHEN n."loc" ~ '^conversations:[^:]+$' THEN 'chatbot.conversation'
      WHEN n."loc" ~ '^conversations:[^:]+:[^:]+$' THEN 'chatbot.stage'
      WHEN n."loc" ~ '^prompts:[^:]+:[^:]+(:.*)?$' THEN 'chatbot.prompt'
      ELSE NULL END,
    "revision_content_hash" = CASE WHEN n."revision_content_hash" = hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n."revision_content_hash" END
  FROM "memories" m
  WHERE m."id" = n."memory_id" AND m."class" = 'system'
    AND (m."is_install_memory" OR EXISTS (SELECT 1 FROM "agents" a WHERE a."system_memory_id" = m."id"))
    AND n."node_type" IN ('info', 'system')
    AND (
      ((n."loc" IN ('boot', 'boot:rules', 'conversations', 'prompts') OR n."loc" ~ '^prompts:[^:]+$')
        AND n."role" IS NULL AND n."node_type" = 'info')
      OR
      ((n."loc" ~ '^conversations:[^:]+(:[^:]+)?$' OR n."loc" ~ '^prompts:[^:]+:[^:]+(:.*)?$')
        AND (n."role" IS NULL OR (n."node_type" = 'info' AND (n."role" = 'chatbot' OR n."role" LIKE 'chatbot.%'))))
    );
  GET DIAGNOSTICS moved = ROW_COUNT; total := total + moved;

  RAISE NOTICE '#5453 definition node roles: % row update(s)', total;
END
$definition_node_roles$;

-- #2043 (S6, cor:agt:040:05), replaced by #5453 — the database backstop for the compiled boot prompt. The ONE
-- source of this SQL: included verbatim by prisma/post-push.sql (dev DB, test template, CI) and copied into
-- 20261128010000_definition_node_roles (prod, which does not run post-push.sql), after the data step
-- (prisma/definition-node-roles-backfill.sql) that leaves no row for it to refuse. Change it only together with a
-- new migration that carries the new text. Idempotent.
--
-- Until #5453 a compiled boot prompt had a node type of its own and the CHECK kept its role on it
-- (chk_nodes_compiled_boot_prompt_role). The mark is the role `prompt.boot.compiled` now, so the CHECK says two
-- things instead:
--   * the retired node type can never be written again, by any layer;
--   * a node with the compiled role is always type `system`.
--
-- The application guard (src/lib/bootPrompt.ts) refuses every generic write to a compiled node first; this is the
-- backstop. No trigger decides "only a compile wrote this": the database cannot see the caller.
ALTER TABLE "nodes" DROP CONSTRAINT IF EXISTS "chk_nodes_compiled_boot_prompt_role";
ALTER TABLE "nodes" DROP CONSTRAINT IF EXISTS "chk_nodes_compiled_boot_prompt_kind";
ALTER TABLE "nodes" ADD CONSTRAINT "chk_nodes_compiled_boot_prompt_kind" CHECK (
  "node_type" IS DISTINCT FROM 'compiled-boot-prompt'
  AND ("role" IS DISTINCT FROM 'prompt.boot.compiled' OR "node_type" = 'system'));

-- #2043 (S6 PR 2, §10 Rook P2-1; cor:agt:040:18) — an approval granted OUTSIDE
-- the boot-prompt approval gate ends when its node ENTERS the gated state: a
-- node in the boot-prompt role family (prompt.boot, prompt.boot.*; the legacy boot-prompt and boot-prompt.*), in an Agent's system memory or an App's
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
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$ SELECT coalesce((r = 'prompt.boot' OR r LIKE 'prompt.boot.%' OR r = 'boot-prompt' OR r LIKE 'boot-prompt.%'), false) $$;

-- Placed: an Agent's system memory, or an install memory (isInstallMemoryRow).
CREATE OR REPLACE FUNCTION hadron_boot_prompt_placed(memory text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM agents WHERE system_memory_id = memory)
      OR EXISTS (SELECT 1 FROM memories WHERE id = memory AND class = 'system' AND is_install_memory)
$$;

-- An entry: the row is a placed boot prompt now and was not one (by role or memory) before.
CREATE OR REPLACE FUNCTION hadron_boot_prompt_entered(op text, old_role text, old_memory text, new_role text, new_memory text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT hadron_is_boot_prompt_role(new_role)
     AND (op = 'INSERT' OR NOT hadron_is_boot_prompt_role(old_role) OR old_memory IS DISTINCT FROM new_memory)
     AND hadron_boot_prompt_placed(new_memory)
$$;

CREATE OR REPLACE FUNCTION hadron_end_boot_prompt_node_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
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
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
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
  FOR EACH ROW WHEN (NEW.role = 'prompt.boot' OR NEW.role LIKE 'prompt.boot.%' OR NEW.role = 'boot-prompt' OR NEW.role LIKE 'boot-prompt.%')
  EXECUTE FUNCTION hadron_end_boot_prompt_node_approval();

DROP TRIGGER IF EXISTS boot_prompt_approval_entry_revisions ON "nodes";
CREATE TRIGGER boot_prompt_approval_entry_revisions
  AFTER INSERT OR UPDATE OF role, memory_id ON "nodes"
  FOR EACH ROW WHEN (NEW.role = 'prompt.boot' OR NEW.role LIKE 'prompt.boot.%' OR NEW.role = 'boot-prompt' OR NEW.role LIKE 'boot-prompt.%')
  EXECUTE FUNCTION hadron_end_boot_prompt_revision_approvals();

-- A memory becoming placed with boot prompts already in it: an Agent attaching it
-- as its system memory (createAgent / updateAgent first-attach), or a memory
-- becoming an install memory.
CREATE OR REPLACE FUNCTION hadron_end_boot_prompt_approvals_in(memory text) RETURNS void
LANGUAGE sql SET search_path = public, pg_temp AS $$
  UPDATE node_revisions SET approval_hash = NULL
   WHERE approval_hash IS NOT NULL
     AND node_id IN (SELECT id FROM nodes WHERE memory_id = memory AND hadron_is_boot_prompt_role(role));
  UPDATE nodes SET approval_hash = NULL
   WHERE memory_id = memory AND approval_hash IS NOT NULL AND hadron_is_boot_prompt_role(role);
$$;

CREATE OR REPLACE FUNCTION hadron_end_boot_prompt_approvals_on_agent_attach() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
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
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
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
