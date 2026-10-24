-- #2043 (S6, cor:agt:040:05) — the compiled boot prompt keeps its role. The ONE
-- source of this SQL: included verbatim by prisma/post-push.sql (dev DB, test
-- template, CI) and copied into 20261019030000_boot_prompt_compiled_check (prod,
-- which does not run post-push.sql). Change it only together with a new
-- migration that carries the new text. Idempotent.
--
-- The application guard (src/lib/bootPrompt.ts) refuses every generic write to a
-- compiled node first; this is the backstop that stops a role-strip at any layer.
-- No trigger decides "only a compile wrote this": the database cannot see the caller.
ALTER TABLE "nodes" DROP CONSTRAINT IF EXISTS "chk_nodes_compiled_boot_prompt_role";
ALTER TABLE "nodes" ADD CONSTRAINT "chk_nodes_compiled_boot_prompt_role" CHECK (
  "node_type" IS DISTINCT FROM 'compiled-boot-prompt'
  OR ("role" IS NOT NULL AND ("role" = 'boot-prompt' OR "role" LIKE 'boot-prompt.%')));
