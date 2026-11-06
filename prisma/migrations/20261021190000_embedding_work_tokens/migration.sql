-- internal#4. Additive: retain this column/obligations on application rollback.
-- Deployment owner must drain timestamp-only workers and fence the producer transition.
ALTER TABLE nodes ADD COLUMN embedding_work_token uuid;

-- A non-null pending stamp is the work signal, including future-dated retries with a
-- failure diagnostic. Permanent failures have NULL pending and are NOT re-driven.
-- Preserve timestamps, attempts, diagnostics, content and cancelled/tombstoned rows.
UPDATE nodes AS n
SET embedding_work_token = gen_random_uuid()
FROM memories AS m
WHERE n.memory_id = m.id
  AND n.embedding_pending_at IS NOT NULL
  AND n.deleted_at IS NULL
  AND m.deleted_at IS NULL
  AND (m.vector_index_enabled = true OR m.class = 'system');
