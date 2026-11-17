-- #3246 — the sweep's claim on an interrupted match-at-create reservation (cor:agt:060:10, ruling 0085 A).
ALTER TABLE "agent_tasks" ADD COLUMN IF NOT EXISTS "match_claimed_at" TIMESTAMP(3);
