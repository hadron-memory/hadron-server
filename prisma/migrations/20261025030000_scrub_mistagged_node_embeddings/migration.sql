-- #1997 (cor:api:190:02, cor:rag:010:01): a one-time scrub of node_embeddings
-- rows a pre-#409 merge left tagged with the memory their node no longer
-- belongs to. #1992 hides them from every vector read; this deletes them and
-- requeues each affected node under its CURRENT memory's policy, as a merge
-- does today (resetEmbeddingObligations).
--
-- Reads ids, memory identity, deleted_at, node_type/loc (the raw-chat rule)
-- and the destination's policy flags only: never content, abstract, data,
-- chunk_text or a vector. Needs no key. Idempotent: a second run finds no
-- mismatch. Deliberately NOT in post-push.sql.
--
-- Lock order: Nodes first, sorted, then their Memory rows FOR SHARE, sorted;
-- Node before vector rows, as the vector writers do. The Memory SHARE holds
-- the policy flags until COMMIT. No fixed order is cycle-free here: subtree
-- move takes Node then Memory, while the encryption flip, retryFailedEmbeddings
-- and most memory mutations take Memory FOR UPDATE then write Nodes. So the
-- scrub does not queue on those row locks: both row-lock steps are NOWAIT, and
-- lock_timeout (100ms, per lock wait) bounds any other lock wait in the
-- attempt. A busy lock (55P03), or a 40P01 caught as a fallback, rolls the
-- attempt back to its savepoint, releasing everything it took, and retries
-- after a 30-90ms jittered sleep. This removes the Node->Memory versus
-- Memory->Node cycle; it is not a global liveness or runtime guarantee.
-- Attempts are bounded (300 by default; the session setting
-- hadron.scrub_1997_attempts overrides it for tests): the count bounds
-- attempts, not total elapsed time. On exhaustion the migration RAISEs, the
-- outer transaction commits nothing, and deploy stops. Recovering is an
-- operator runbook step once the failed-migration state is confirmed
-- (`prisma migrate resolve --rolled-back
-- 20261025030000_scrub_mistagged_node_embeddings`, then a restart), never an
-- automatic retry.
--
-- `-- @step` lines split the attempt for the race pins
-- (src/test/migrations/scrubMistaggedVectors1997.test.ts), which run each
-- step as a plain statement (PERFORM read as SELECT) up to `-- @end`; keep
-- one statement per step.
BEGIN;

SET LOCAL lock_timeout = '100ms';

DO $scrub$
DECLARE
  attempts CONSTANT int := COALESCE(NULLIF(current_setting('hadron.scrub_1997_attempts', true), '')::int, 300);
  attempt int := 0;
BEGIN
  LOOP
    attempt := attempt + 1;
    BEGIN
      -- @step discover: candidates only; judged again under the locks.
      CREATE TEMP TABLE scrub_1997_candidates ON COMMIT DROP AS
        SELECT DISTINCT ne.node_id AS id
        FROM node_embeddings ne
        JOIN nodes n ON n.id = ne.node_id
        WHERE n.memory_id <> ne.memory_id;

      -- @step lock-nodes: the chunk writer's mode; it admits the vector FK's KEY SHARE.
      PERFORM n.id FROM nodes n
        WHERE n.id IN (SELECT id FROM scrub_1997_candidates)
        ORDER BY n.id
        FOR NO KEY UPDATE OF n NOWAIT;

      -- @step lock-memories: each locked node's memory, read under its node lock, so
      -- a relocation that committed after discovery is judged by where it now is.
      PERFORM m.id FROM memories m
        WHERE m.id IN (SELECT n.memory_id FROM nodes n WHERE n.id IN (SELECT id FROM scrub_1997_candidates))
        ORDER BY m.id
        FOR SHARE OF m NOWAIT;

      -- @step scrub: delete only rows that still mismatch; the nodes that lost a row
      -- (RETURNING) are the affected set. Markers, first match wins:
      --   soft-deleted node, or encrypted memory   -> unchanged
      --   memory not indexed (or deleted), raw chat -> cleared
      --   indexed                                   -> due now, new work token
      WITH deleted AS (
        DELETE FROM node_embeddings ne
        USING nodes n
        WHERE n.id = ne.node_id
          AND n.id IN (SELECT id FROM scrub_1997_candidates)
          AND n.memory_id <> ne.memory_id
        RETURNING ne.node_id
      ), affected AS (
        SELECT n.id,
               (m.class = 'system' OR m.vector_index_enabled)
                 AND m.deleted_at IS NULL
                 AND NOT (n.node_type = 'chat-message' OR (n.node_type = 'record' AND n.loc ~ ':messages:[^:]+$'))
                 AS requeue
        FROM (SELECT DISTINCT node_id FROM deleted) d
        JOIN nodes n ON n.id = d.node_id
        JOIN memories m ON m.id = n.memory_id
        WHERE n.deleted_at IS NULL AND NOT m.is_encrypted
      )
      UPDATE nodes n SET
        embedding_pending_at = CASE WHEN a.requeue THEN CURRENT_TIMESTAMP AT TIME ZONE 'UTC' ELSE NULL END,
        embedding_work_token = CASE WHEN a.requeue THEN gen_random_uuid() ELSE NULL END,
        embedding_failed_at = NULL,
        embedding_error = NULL,
        embedding_attempts = 0
      FROM affected a
      WHERE n.id = a.id;
      -- @end

      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF attempt >= attempts THEN
        RAISE EXCEPTION '#1997 scrub: rows stayed locked through % attempts; nothing was changed', attempts
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.03 + random() * 0.06);
    END;
  END LOOP;
END
$scrub$;

COMMIT;
