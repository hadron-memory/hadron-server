-- #2973 PR1 (cor:agt:040:09) — the organisation's boot-prompt signing switch. Plain additive column with a default, so
-- no refusing preflight (no SQLSTATE HDPRF class): it applies over any populated prior schema and every existing row
-- reads false. DEFAULT false and no control API in this PR, so no organisation can be switched on whatever the
-- deployment flag says — the serve check is inert through the stored switch until PR2 lands.
ALTER TABLE "organizations" ADD COLUMN "boot_prompt_signing_required" BOOLEAN NOT NULL DEFAULT false;
