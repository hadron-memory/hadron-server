-- Multi-node runs (plan-multi-node §6): the run envelope — mutable bag of
-- extracted fields the edge-walker accumulates and conditions branch on
-- (evaluator scope message.data.*). event_data stays the immutable trigger
-- payload.

ALTER TABLE "app_runs" ADD COLUMN "data" JSONB;
