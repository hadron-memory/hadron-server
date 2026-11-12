-- #4041 (V82) — the last host repair notice the platform posted for a worker (dedupe marker). Additive only (expand): one
-- nullable column, nothing existing changes.
ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "repair_notice_key" TEXT;
