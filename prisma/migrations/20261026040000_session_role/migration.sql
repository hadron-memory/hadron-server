-- #2458 (cor:dmo:050:11): the role a worker session was bound under. Stamped at bind from the locked worker row
-- beside agent_id, so changing a worker's agent (and with it the role) never rewrites a past session.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "role" TEXT;

-- Sessions bound before this column existed take their worker's role. Exact, not an estimate: before #2458 nothing
-- wrote workers.role after the cast (the role was immutable), so it is the role each such session was bound under.
UPDATE "sessions" s SET "role" = w."role"
FROM "workers" w
WHERE s."worker_id" = w."id" AND s."role" IS NULL;
