-- #723 (URN v2, epic #691) — re-key the `shared` app-class memory off its URN.
--
-- `findOrCreateAppClassMemory` used to identify an App's shared memory by a
-- DETERMINISTIC urn string (`<app-urn>:<agent-slug>:shared`). That was the one
-- compound-memory creation site #722 could not flip to a flat single-atom v2
-- urn: an order-dependent collision alias can't be recomputed for the next
-- lookup. Consequences of the string key: the row kept a multi-atom memory
-- slug, so node URNs inside it did not round-trip through `splitNodeUrn` (the
-- portal link a node read emits 404'd — every team chat, by construction), and
-- renaming the App silently orphaned its shared memory.
--
-- The identity moves to a COLUMN. `shared_memory_of_agent_id` is set only on
-- that runtime memory; the NULL-permissive unique below is the find-or-create
-- key, which frees the urn to be minted flat like every other memory.

ALTER TABLE "memories" ADD COLUMN "shared_memory_of_agent_id" TEXT;

ALTER TABLE "memories"
  ADD CONSTRAINT "memories_shared_memory_of_agent_id_fkey"
  FOREIGN KEY ("shared_memory_of_agent_id") REFERENCES "agents"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The column is meaningful only on an App-scoped app-class memory. Mirrors
-- chk_memory_class_app_id's shape; also lives in prisma/post-push.sql and
-- src/test/globalSetup.ts (keep all three in sync).
ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_shared_agent_scope";
ALTER TABLE "memories"
  ADD CONSTRAINT "chk_memory_shared_agent_scope"
  CHECK (shared_memory_of_agent_id IS NULL OR (class = 'app' AND app_id IS NOT NULL));

-- Adopt the shared memories that already exist, BEFORE the unique index is
-- created, so a pre-existing duplicate pairing surfaces as a failed migration
-- rather than as a silently mis-keyed row. Their identity is still the urn
-- string (`…:<agent-slug>:shared` in `urn`, or in `legacy_urn` once the #697
-- Task-A sweep flattened `urn`), so match that shape ONCE and write the column;
-- from here on the column is the only key.
--
-- Guards, in order: a candidate needs at least three atoms (so a flat
-- `<root>:shared` can't be read as `<agent>:shared`); the penultimate atom must
-- equal the "everything after the first atom" agent slug that built the urn,
-- compared for EQUALITY (never LIKE — `_` in a slug is a LIKE wildcard) against
-- the agent's current AND legacy urn; the agent must be installed in that same
-- App; and a candidate matching more than one Agent is left alone rather than
-- guessed at. Whatever this leaves unclaimed is reported by
-- `scripts/backfill-shared-memory-agent.ts --dry-run` and, failing that, adopted
-- lazily by findOrCreateAppClassMemory on the next touch.
WITH candidate AS (
  SELECT m.id AS memory_id,
         m.app_id,
         m.created_at,
         COALESCE(
           CASE WHEN m.urn ~ '^[^:]+:[^:]+:[^:]+' THEN substring(m.urn from '([^:]+):shared$') END,
           CASE WHEN m.legacy_urn ~ '^[^:]+:[^:]+:[^:]+' THEN substring(m.legacy_urn from '([^:]+):shared$') END
         ) AS agent_slug
  FROM memories m
  WHERE m.class = 'app'
    AND m.app_id IS NOT NULL
    AND m.shared_memory_of_agent_id IS NULL
), matched AS (
  SELECT c.memory_id,
         c.app_id,
         c.created_at,
         a.id AS agent_id,
         COUNT(*) OVER (PARTITION BY c.memory_id) AS agent_matches
  FROM candidate c
  JOIN app_agents aa ON aa.app_id = c.app_id
  JOIN agents a
    ON a.id = aa.agent_id
   AND (
        regexp_replace(a.urn, '^[^:]+:', '') = c.agent_slug
     OR regexp_replace(COALESCE(a.legacy_urn, ''), '^[^:]+:', '') = c.agent_slug
   )
  WHERE c.agent_slug IS NOT NULL AND c.agent_slug <> ''
), picked AS (
  SELECT m.memory_id,
         m.agent_id,
         ROW_NUMBER() OVER (PARTITION BY m.app_id, m.agent_id ORDER BY m.created_at, m.memory_id) AS pick
  FROM matched m
  WHERE m.agent_matches = 1
    -- ONE row per pairing: never write a duplicate the unique index below would
    -- then refuse to build (a failed migration is a boot loop, and the second
    -- row of a pairing — an App rename could have produced one — is exactly the
    -- case a human has to look at). Covers both halves: a pairing already keyed
    -- on another row, and two candidates competing for the same one (pick).
    AND NOT EXISTS (
      SELECT 1 FROM memories held
      WHERE held.app_id = m.app_id AND held.shared_memory_of_agent_id = m.agent_id
    )
)
UPDATE memories m
SET shared_memory_of_agent_id = p.agent_id
FROM picked p
WHERE m.id = p.memory_id
  AND p.pick = 1;

-- ONE shared memory per (App, Agent). Postgres treats NULLs as distinct, so
-- every other memory row (shared_memory_of_agent_id NULL) is unconstrained.
-- Deliberately NOT filtered on deleted_at: the provisioner RESTORES a
-- soft-deleted shared memory rather than creating a second one, so the
-- tombstone must keep holding the slot.
CREATE UNIQUE INDEX "memories_app_id_shared_memory_of_agent_id_key"
  ON "memories" ("app_id", "shared_memory_of_agent_id");
