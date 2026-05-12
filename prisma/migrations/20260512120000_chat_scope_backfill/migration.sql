-- Spec 017 (chat-visibility-and-personal-memory) — FR-017/FR-018.
--
-- Classifies every pre-feature chat-root node as `data.scope = 'private'`.
-- All pre-feature chats live in personal-class memory (today's behavior
-- before this feature shipped); reclassifying them as private preserves
-- their existing visibility semantics — they remain visible only to
-- their author.
--
-- Chat-root nodes are addressed by:
--   loc LIKE 'chats:%'  AND  loc not containing a second colon  (depth 2)
--
-- The migration is **idempotent**: a second run touches no rows because
-- the WHERE filter excludes nodes that already have `data.scope`. No
-- chat content moves between memories (FR-018) — only the JSON `scope`
-- field on the chat-root node is set.

UPDATE "nodes"
SET "data" = jsonb_set(
  COALESCE("data", '{}'::jsonb),
  '{scope}',
  '"private"',
  true
)
WHERE "loc" LIKE 'chats:%'
  AND POSITION(':' IN SUBSTRING("loc" FROM 7)) = 0
  AND ("data" IS NULL OR "data" ->> 'scope' IS NULL);
