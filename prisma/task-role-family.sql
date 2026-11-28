-- #5485 (Holger, 2026-11-28) — the task role family, stage 1 of the retype of tasks and processes to node type
-- `system` (the instruction class), and the database rule for the task roles. The ONE source of this SQL: included
-- verbatim by prisma/post-push.sql (dev DB, test template, CI), after boot-prompt-invariants.sql, and copied into
-- 20261128020000_task_role_family (prod, which does not run post-push.sql). Change it only together with a new
-- migration that carries the new text. Idempotent: a second run finds no row to change.
--
-- It NEVER refuses: there is no RAISE EXCEPTION in it, and every row class the CHECK at its end would refuse is
-- moved first (step 1).
--
--   1. a task-family role (`task`, `task.*`) on a row that is NOT runnable   -> role NULL (the CHECK allows no such row)
--   2. a runnable row with role `role-task`                                   -> `task.role`
--   3. a runnable row with no role                                            -> `task`
--      (steps 2 and 3 run in EVERY memory and change the ROLE only, never the node type)
--   4. a runnable node that carries another role keeps it; only its count is logged. These are what a later removal
--      of `isRunnable` has to resolve.
--   5. in an Agent's system memory or an install memory only, rows typed `task` or `info` become `system` when they
--      are runnable, carry a process-family role (`process`, `process.*`), or are the `tasks` or `processes` parent.
--      A `comment`, `chat-message`, `record` or any other typed row is never retyped, and no statement that names
--      `node_type` can select a comment (the comment trigger fires on `UPDATE OF node_type`).
--   6. the CHECK `chk_nodes_task_role_runnable`: a task-family role only on a runnable row. The reverse (a runnable
--      row has a task role) is NOT enforced: `isRunnable` stays the thing that makes a node a task.
--
-- What it does not touch:
--   * `node_revisions` is history and stays as captured. A restore maps an old capture forward in code
--     (`modernTaskKind`, src/lib/instructionRoles.ts), so no restore brings the `task` type or `role-task` back.
--   * Approval, signatures, edges, content. Approval and signature hashes cover the title, abstract and content,
--     never the type or the role, so an approved task reads approved afterwards.
--   * `revision_content_hash` covers `node_type` and `role`. A row whose stored hash matched its state is given the
--     refresh marker, so the read-time reconcile does not see this as a change made outside a revisioned writer
--     (which would cut a new revision past the approved one). A row that had already drifted is left drifted.
--
-- Soft-deleted rows are included, so an undelete brings back today's kind. Encrypted memories are included: type,
-- role and loc are plaintext columns, and no content is read or written here.
--
-- One DO block, so it is atomic wherever it runs. It takes ACCESS EXCLUSIVE on `nodes` FIRST: the CHECK needs that
-- lock anyway, and taking it after the row locks of the updates would be a lock upgrade that can deadlock.
DO $task_role_family$
DECLARE
  cleared bigint;
  renamed bigint;
  given bigint;
  retyped bigint;
  kept bigint;
BEGIN
  LOCK TABLE "nodes" IN ACCESS EXCLUSIVE MODE;

  -- 1. The CHECK below allows no task role on a row that is not runnable.
  UPDATE "nodes" n SET
    "role" = NULL,
    "revision_content_hash" = CASE WHEN n."revision_content_hash" = hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n."revision_content_hash" END
  WHERE n."is_runnable" IS NOT TRUE AND n."node_type" <> 'comment' AND (n."role" = 'task' OR n."role" LIKE 'task.%');
  GET DIAGNOSTICS cleared = ROW_COUNT;

  -- 2. A role task: the role the clients wrote becomes the family member.
  UPDATE "nodes" n SET
    "role" = 'task.role',
    "revision_content_hash" = CASE WHEN n."revision_content_hash" = hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n."revision_content_hash" END
  WHERE n."is_runnable" IS TRUE AND n."node_type" <> 'comment' AND n."role" = 'role-task';
  GET DIAGNOSTICS renamed = ROW_COUNT;

  -- 3. Every other runnable node with no role is a task.
  UPDATE "nodes" n SET
    "role" = 'task',
    "revision_content_hash" = CASE WHEN n."revision_content_hash" = hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n."revision_content_hash" END
  WHERE n."is_runnable" IS TRUE AND n."node_type" <> 'comment' AND n."role" IS NULL;
  GET DIAGNOSTICS given = ROW_COUNT;

  -- 4. Counted, not changed.
  SELECT count(*) INTO kept FROM "nodes" n
   WHERE n."is_runnable" IS TRUE AND n."role" IS NOT NULL AND n."role" <> 'task' AND n."role" NOT LIKE 'task.%';

  -- 5. Stage 1 of the retype: Agent system memories and install memories (the placement of boot-prompt-approval-invariants.sql).
  UPDATE "nodes" n SET
    "node_type" = 'system',
    "revision_content_hash" = CASE WHEN n."revision_content_hash" = hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n."revision_content_hash" END
  FROM "memories" m
  WHERE m."id" = n."memory_id" AND m."class" = 'system'
    AND (m."is_install_memory" OR EXISTS (SELECT 1 FROM "agents" a WHERE a."system_memory_id" = m."id"))
    AND n."node_type" IN ('task', 'info')
    AND (n."is_runnable" IS TRUE OR n."role" = 'process' OR n."role" LIKE 'process.%' OR n."loc" IN ('tasks', 'processes'));
  GET DIAGNOSTICS retyped = ROW_COUNT;

  RAISE NOTICE '#5485 task role family: % task role(s) set, % role-task renamed, % task role(s) cleared on a node that is not runnable, % retyped; % runnable node(s) with another role kept',
    given, renamed, cleared, retyped, kept;
END
$task_role_family$;

-- 6. The database rule, one way: a task-family role implies a runnable row.
ALTER TABLE "nodes" DROP CONSTRAINT IF EXISTS "chk_nodes_task_role_runnable";
ALTER TABLE "nodes" ADD CONSTRAINT "chk_nodes_task_role_runnable" CHECK (
  NOT COALESCE("role" = 'task' OR "role" LIKE 'task.%', false) OR "is_runnable" IS TRUE);
