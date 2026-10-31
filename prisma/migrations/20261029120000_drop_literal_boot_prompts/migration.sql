-- #2712 (Holger, 2026-10-28, D3): delete the literal boot prompts. Every boot prompt is served from a compiled,
-- approved node (cor:agt:040:07 "no literal fallback"); #2676 converted these values, and nothing reads them.
-- apps.system_prompt was deprecated by 008 R-4 and never served.
ALTER TABLE "agents" DROP COLUMN "system_prompt";
ALTER TABLE "apps" DROP COLUMN "system_prompt";
ALTER TABLE "workers" DROP COLUMN "prompt_override";
