-- #1050 — a worker NAME is held by a person until released.
--
-- Availability used to be derived from session liveness, which conflated two
-- unrelated questions behind one word: "is this name someone's?" and "is a
-- session live right now?". The second is a timer, so expiry, a reap, or a
-- closed chat session silently freed a name — and an agent following the
-- documented procedure ended a mid-PR driver's session and bound as them
-- (hadron-cli#492). Holding replaces a judgement that cannot be made correctly
-- with a fact.
ALTER TABLE "workers" ADD COLUMN "held_by_user_id" TEXT;
ALTER TABLE "workers" ADD COLUMN "held_at" TIMESTAMP(3);

-- SetNull, never Cascade: deleting a user must RELEASE their held names, not
-- delete the castings — a worker carries worklog records and handoff history
-- that a merged PR still traces back through.
ALTER TABLE "workers"
  ADD CONSTRAINT "workers_held_by_user_id_fkey"
  FOREIGN KEY ("held_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "workers_held_by_user_id_idx" ON "workers"("held_by_user_id");

-- Backfill: from who has actually been DRIVING each worker — the most recent
-- session's user — not from `created_by`.
--
-- The first draft of this migration used `created_by`, on the reasoning that
-- the caster holds what they cast. That reasoning was removed from the code
-- during this same change (casting does NOT hold: a coordinator staffs a roster
-- other people claim) and the migration was left behind, which both reviewers
-- caught. Deploying it would have stranded every existing roster as held by the
-- admin who created it, and handed the actual drivers WORKER_HELD until someone
-- released names they had been using for weeks.
--
-- The most recent session's user is the retroactive form of the rule the code
-- now implements — the person who BOUND it holds it — so the de-facto holders
-- on deploy are exactly the people already working as those names. A worker
-- nobody has ever bound stays unheld, which is correct: nobody has claimed it.
UPDATE "workers" w
SET "held_by_user_id" = s."user_id",
    "held_at"         = s."started_at"
FROM (
  SELECT DISTINCT ON (worker_id) worker_id, user_id, started_at
  FROM "sessions"
  WHERE worker_id IS NOT NULL
    AND user_id IS NOT NULL
    AND deleted_at IS NULL
  ORDER BY worker_id, started_at DESC
) s
WHERE w."id" = s."worker_id"
  AND w."held_by_user_id" IS NULL
  AND EXISTS (SELECT 1 FROM "users" u WHERE u."id" = s."user_id");
