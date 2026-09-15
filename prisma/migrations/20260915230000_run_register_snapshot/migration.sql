-- Spec 049 Phase 6 — the attendee's resolved register at mint (plan §3.3 /
-- §4.3): rows only, re-intersected on every use; never a grant.
ALTER TABLE "app_runs" ADD COLUMN "register_snapshot" JSONB;
