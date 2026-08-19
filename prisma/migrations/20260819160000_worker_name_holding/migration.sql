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

-- Backfill: the caster holds what they cast. `created_by` already records who
-- that was, so the model is live on deploy and nobody has to claim their own
-- workers. Guarded by a join to `users` because `created_by` is an audit
-- string that may hold a non-user client id — those rows stay unheld and are
-- held by the next person to bind them.
UPDATE "workers" w
SET "held_by_user_id" = w."created_by",
    "held_at"         = w."created_at"
WHERE w."created_by" IS NOT NULL
  AND w."held_by_user_id" IS NULL
  AND EXISTS (SELECT 1 FROM "users" u WHERE u."id" = w."created_by");
