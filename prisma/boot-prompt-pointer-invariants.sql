-- #2045 (S8, cor:agt:040:07) — a boot-prompt pointer is a PAIR: the target
-- node's id and its canonical URN at write time, set together or cleared
-- together. The URN is what names a target whose row was hard-deleted (R27),
-- so a half-set pointer could neither serve nor be reported. The ONE source of
-- this SQL: included verbatim by prisma/post-push.sql (dev DB, test template,
-- CI) and copied into 20261021110000_boot_prompt_pointers (prod, which does not
-- run post-push.sql). Change it only together with a new migration that carries
-- the new text. Idempotent.
--
-- There is deliberately NO foreign key to "nodes" (see the schema comment):
-- the target's liveness is decided at read time by resolveBootPromptPointer.
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "chk_agents_boot_prompt_pointer_pair";
ALTER TABLE "agents" ADD CONSTRAINT "chk_agents_boot_prompt_pointer_pair" CHECK (
  ("boot_prompt_node_id" IS NULL) = ("boot_prompt_urn" IS NULL));
ALTER TABLE "app_agents" DROP CONSTRAINT IF EXISTS "chk_app_agents_boot_prompt_pointer_pair";
ALTER TABLE "app_agents" ADD CONSTRAINT "chk_app_agents_boot_prompt_pointer_pair" CHECK (
  ("boot_prompt_node_id" IS NULL) = ("boot_prompt_urn" IS NULL));
ALTER TABLE "workers" DROP CONSTRAINT IF EXISTS "chk_workers_boot_prompt_pointer_pair";
ALTER TABLE "workers" ADD CONSTRAINT "chk_workers_boot_prompt_pointer_pair" CHECK (
  ("boot_prompt_node_id" IS NULL) = ("boot_prompt_urn" IS NULL));
