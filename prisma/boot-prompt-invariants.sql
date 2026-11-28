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
