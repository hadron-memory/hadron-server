-- #3825 follow-up (6773996134): the newest MATCHED decision per combination, so a write that arrives after a newer one
-- still reconciles the failing streak by decision time. Additive and nullable; existing rows read as "no match known"
-- except a MATCHED row, whose own decision is its newest match.
ALTER TABLE "agent_match_outcomes" ADD COLUMN "last_matched_at" TIMESTAMP(6);
UPDATE "agent_match_outcomes" SET "last_matched_at" = "decided_at" WHERE "outcome" = 'MATCHED';
