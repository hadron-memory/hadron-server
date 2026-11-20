-- #3775 A (cor:agt:050:32): the stall evaluator's pass bookkeeping, one platform-wide row. A new, empty table: no data
-- to move and nothing for an existing row to fail.
CREATE TABLE "stall_evaluator_state" (
    "id" TEXT NOT NULL,
    "last_pass_at" TIMESTAMP(3) NOT NULL,
    "last_gap_ended_at" TIMESTAMP(3),

    CONSTRAINT "stall_evaluator_state_pkey" PRIMARY KEY ("id")
);
