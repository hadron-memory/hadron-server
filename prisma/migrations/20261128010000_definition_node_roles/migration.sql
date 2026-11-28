-- #5453 PR A (Holger, 2026-11-27): Agent definition nodes are type `system`, their kind is a role.
--
-- One migration, no expand and contract (accepted by Holger: "I want the optimal solution, accepting risk of
-- migration"). It never refuses on data: no statement raises, so there is no HDPRF path either.
--
-- Two parts, each a verbatim copy of its ONE source (pinned by src/lib/definitionNodeRolesMigration5453.test.ts):
--   1. prisma/definition-node-roles-backfill.sql   the data step (takes ACCESS EXCLUSIVE on "nodes" first)
--   2. prisma/boot-prompt-invariants.sql           the constraint swap
-- Prisma sends this file as one batch, so both run in ONE transaction: the lock taken by part 1 is held until the
-- new CHECK is in place, and a failure of either part rolls both back.
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
--   0. role `boot-prompt.compiled` on a node that is NOT a compiled prompt  -> role `boot-prompt.source`
--   1. node type `compiled-boot-prompt`                                      -> `system` / `boot-prompt.compiled`
--   2. role `boot-prompt` (a source)                                         -> `boot-prompt.source`; `info` -> `system`
--   3. role `boot-prompt-rule`                                               -> `boot-prompt.rule`;   `info` -> `system`
--   4. in an Agent's system memory or an install memory, by loc, `info` and `system` rows only:
--        conversations:<c>                      role NULL -> `chatbot.conversation`, type `system`
--        conversations:<c>:<s>                  role NULL -> `chatbot.stage`,        type `system`
--        prompts:<c>:<s> and below              role NULL -> `chatbot.prompt`,       type `system`
--        boot, boot:rules, conversations, prompts, prompts:<c>   `info` -> `system`, no role set
--
-- What it does not touch, and why:
--   * A role is only ever SET where it is NULL, the bare `boot-prompt`, or `boot-prompt-rule`. Two exceptions,
--     both forced by the compiled mark moving to the role: step 0 (before this change any writer could put
--     `boot-prompt.compiled` on an ordinary node, where it meant a source; left alone, that node would become a
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
    "role" = 'boot-prompt.source',
    "revision_content_hash" = CASE WHEN n."revision_content_hash" = hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n."revision_content_hash" END
  WHERE n."role" = 'boot-prompt.compiled' AND n."node_type" NOT IN ('compiled-boot-prompt', 'system');
  GET DIAGNOSTICS moved = ROW_COUNT; total := total + moved;
  -- The same role on a `system` node. On a database that has NOT been migrated yet the compile still writes the
  -- retired type, so a `system` row that carries the compiled role was written by a generic door: a source too.
  -- "Not migrated yet" is read off the old CHECK, which the constraint swap that follows this block removes; once it
  -- is gone, `system` / `boot-prompt.compiled` is exactly what a compile writes and this statement must not run
  -- again (post-push.sql runs this block on every dev setup).
  IF EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = '"nodes"'::regclass AND c.conname = 'chk_nodes_compiled_boot_prompt_role') THEN
    UPDATE "nodes" n SET
      "role" = 'boot-prompt.source',
      "revision_content_hash" = CASE WHEN n."revision_content_hash" = hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n."revision_content_hash" END
    WHERE n."role" = 'boot-prompt.compiled' AND n."node_type" = 'system';
    GET DIAGNOSTICS moved = ROW_COUNT; total := total + moved;
  END IF;

  -- 1. The compiled prompt: the retired type becomes `system`, and the role carries the mark.
  UPDATE "nodes" n SET
    "node_type" = 'system',
    "role" = 'boot-prompt.compiled',
    "revision_content_hash" = CASE WHEN n."revision_content_hash" = hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n."revision_content_hash" END
  WHERE n."node_type" = 'compiled-boot-prompt';
  GET DIAGNOSTICS moved = ROW_COUNT; total := total + moved;

  -- 2. The source: the bare role becomes the source leaf (step 1 left no compiled row under the bare role).
  UPDATE "nodes" n SET
    "role" = 'boot-prompt.source',
    "revision_content_hash" = CASE WHEN n."revision_content_hash" = hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n."revision_content_hash" END
  WHERE n."role" = 'boot-prompt';
  GET DIAGNOSTICS moved = ROW_COUNT; total := total + moved;
  UPDATE "nodes" n SET
    "node_type" = 'system',
    "revision_content_hash" = CASE WHEN n."revision_content_hash" = hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n."revision_content_hash" END
  WHERE n."role" = 'boot-prompt.source' AND n."node_type" = 'info';
  GET DIAGNOSTICS moved = ROW_COUNT; total := total + moved;

  -- 3. The rule joins the family. In a placed memory the approval-entry triggers clear the approval hash of the
  --    node and of its revisions as it enters; both are remembered first and put back after. The second write
  --    cannot clear again: the node is already in the family, so it is no longer an entry.
  SELECT coalesce(jsonb_object_agg(n."id", n."approval_hash"), '{}'::jsonb) INTO rule_approvals
    FROM "nodes" n WHERE n."role" = 'boot-prompt-rule' AND n."approval_hash" IS NOT NULL;
  SELECT coalesce(jsonb_object_agg(r."id", r."approval_hash"), '{}'::jsonb) INTO rule_revision_approvals
    FROM "node_revisions" r JOIN "nodes" n ON n."id" = r."node_id"
   WHERE n."role" = 'boot-prompt-rule' AND r."approval_hash" IS NOT NULL;
  UPDATE "nodes" n SET
    "role" = 'boot-prompt.rule',
    "revision_content_hash" = CASE WHEN n."revision_content_hash" = hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n."revision_content_hash" END
  WHERE n."role" = 'boot-prompt-rule';
  GET DIAGNOSTICS moved = ROW_COUNT; total := total + moved;
  UPDATE "nodes" n SET "approval_hash" = rule_approvals ->> n."id"
   WHERE rule_approvals ? n."id" AND n."approval_hash" IS NULL;
  UPDATE "node_revisions" r SET "approval_hash" = rule_revision_approvals ->> r."id"
   WHERE rule_revision_approvals ? r."id" AND r."approval_hash" IS NULL;
  UPDATE "nodes" n SET
    "node_type" = 'system',
    "revision_content_hash" = CASE WHEN n."revision_content_hash" = hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n."revision_content_hash" END
  WHERE n."role" = 'boot-prompt.rule' AND n."node_type" = 'info';
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
-- (chk_nodes_compiled_boot_prompt_role). The mark is the role `boot-prompt.compiled` now, so the CHECK says two
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
  AND ("role" IS DISTINCT FROM 'boot-prompt.compiled' OR "node_type" = 'system'));
