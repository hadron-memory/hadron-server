-- #3825 follow-up (6773996134): the newest MATCHED decision per combination, so a write that arrives after a newer one
-- still reconciles the failing streak by decision time. Additive and nullable.
ALTER TABLE "agent_match_outcomes" ADD COLUMN "last_matched_at" TIMESTAMP(6);
-- A MATCHED row's own decision is its newest match.
UPDATE "agent_match_outcomes" SET "last_matched_at" = "decided_at" WHERE "outcome" = 'MATCHED';
-- A NO_WORKER row's start may already be over-stated by the old arrival-order guard, and latest-only storage cannot
-- tell it from a true one, so every live streak restarts at its latest failure, which becomes the floor no older late
-- failure joins (gate ruling Option A on #3883, Dorian's LOCAL P2). The streak is then under-stated, never over-stated,
-- for upgraded rows too; the cost is one conservative restart per live streak at deploy.
UPDATE "agent_match_outcomes" SET "failing_since" = "decided_at", "last_matched_at" = "decided_at" WHERE "outcome" = 'NO_WORKER';
