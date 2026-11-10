-- #3825 (cor:agt:060:13): the latest decided match outcome per App and combination. Additive; no existing row is touched.
CREATE TABLE "agent_match_outcomes" (
    "app_id" TEXT NOT NULL,
    "family" TEXT NOT NULL DEFAULT '',
    "tier" TEXT NOT NULL DEFAULT '',
    "role" TEXT NOT NULL DEFAULT '',
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "decided_at" TIMESTAMP(3) NOT NULL,
    "failing_since" TIMESTAMP(3),

    CONSTRAINT "agent_match_outcomes_pkey" PRIMARY KEY ("app_id","family","tier","role")
);

CREATE INDEX "agent_match_outcomes_decided_at_idx" ON "agent_match_outcomes"("decided_at");

ALTER TABLE "agent_match_outcomes" ADD CONSTRAINT "agent_match_outcomes_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
